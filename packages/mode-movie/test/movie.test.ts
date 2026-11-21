import { RoleCatalog } from '@imp/agents';
import {
  CommandRegistry,
  isInScope,
  projectCommands,
  projectCreate,
  settingsCommands,
  type Command,
} from '@imp/core';
import { ProviderError } from '@imp/providers';
import { createTestRuntime } from '@imp/core/testing';
import { describe, expect, it } from 'vitest';
import { createFakeProvider } from '@imp/providers/testing';
import { createWorldCommands } from '@imp/world';
import {
  castingDirector,
  Character,
  clipPrompt,
  asStartFrame,
  createMovieMode,
  type FrameImageEncoder,
  MAX_CLIP_GUIDES,
  MAX_TAKES,
  readSetting,
  screenwriter,
  Shot,
  soundPrompt,
} from '../src/index.js';

const user = { kind: 'user', id: 'arnd' } as const;
const writer = { kind: 'agent', id: 'w', role: 'screenwriter' } as const;

async function setup(
  providerOptions: Parameters<typeof createFakeProvider>[0] = {},
  frameImage?: FrameImageEncoder,
) {
  const runtime = createTestRuntime();
  const provider = createFakeProvider(providerOptions);
  const registry = new CommandRegistry({ runtime }).register(
    ...projectCommands,
    ...settingsCommands,
    ...createMovieMode(frameImage === undefined ? { provider } : { provider, frameImage }).commands,
    ...createWorldCommands({ provider }),
  );
  const created = await registry.execute(
    projectCreate,
    { name: 'The Lighthouse Keeper', mode: 'movie' },
    { actor: user },
  );
  if (created.status !== 'ok') throw new Error('not ok');
  const projectId = created.output.id;
  const run = async (
    id: string,
    input: Record<string, unknown>,
    actor: typeof user | typeof writer = user,
  ) => {
    const result = await registry.executeById(id, { projectId, ...input }, { actor });
    if (result.status !== 'ok') throw new Error(`${id}: ${result.status}`);
    return result.output as { id: string } & Record<string, unknown>;
  };
  return { runtime, registry, provider, projectId, run };
}

interface Listed {
  scenes: { id: string; heading: string; position: number }[];
}
const headings = (listed: unknown): string[] =>
  (listed as Listed).scenes.map((scene) => `${String(scene.position)} ${scene.heading}`);

describe('the movie mode', () => {
  it('is a consistent mode with its roles limited to its own commands', () => {
    const movieMode = createMovieMode({ provider: createFakeProvider({}) });
    expect(movieMode.stages.map((stage) => stage.id)).toEqual([
      'development',
      'script',
      'casting',
      'design',
      'shots',
      'sound',
      'edit',
      'audio',
    ]);
    expect(() => new RoleCatalog(movieMode.roles)).not.toThrow();
    const outside = projectCommands.filter((command: Command) =>
      isInScope(command, screenwriter.scope),
    );
    expect(outside.map((command) => command.id).sort()).toEqual([
      'project.list',
      'project.resources.copy',
      'project.resources.list',
      'project.resources.request.get',
      'project.resources.request.list',
      'project.resources.request.resolve',
    ]);
    expect(movieMode.commands.every((command) => isInScope(command, castingDirector.scope))).toBe(
      true,
    );
  });

  it('refuses projects that do not exist or belong to another mode', async () => {
    const { registry } = await setup();
    const other = await registry.execute(
      projectCreate,
      { name: 'Song', mode: 'music' },
      { actor: user },
    );
    if (other.status !== 'ok') throw new Error('not ok');
    for (const projectId of ['missing', other.output.id]) {
      await expect(
        registry.executeById('movie.scene.list', { projectId }, { actor: user }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });
});

describe('development', () => {
  it('starts empty and changes only the fields given', async () => {
    const { run } = await setup();
    expect(await run('movie.development.get', {})).toEqual({
      logline: '',
      premise: '',
      tone: '',
      treatment: '',
    });
    await run('movie.development.update', { logline: 'A keeper finds a light that is alive.' });
    await run('movie.development.update', { tone: 'Quiet, wet, warm.' });
    expect(await run('movie.development.get', {})).toEqual({
      logline: 'A keeper finds a light that is alive.',
      premise: '',
      tone: 'Quiet, wet, warm.',
      treatment: '',
    });
  });
});

describe('scenes', () => {
  it('appends, inserts and keeps positions gapless', async () => {
    const { run } = await setup();
    await run('movie.scene.create', { heading: 'EXT. HARBOUR - DUSK' });
    await run('movie.scene.create', { heading: 'INT. LAMP ROOM - NIGHT' });
    const inserted = await run('movie.scene.create', {
      heading: 'INT. STAIRS - NIGHT',
      position: 2,
    });
    expect(inserted).toMatchObject({ position: 2, summary: '', body: '' });
    await run('movie.scene.create', { heading: 'EXT. SEA - DAWN', position: 99 });
    expect(headings(await run('movie.scene.list', {}))).toEqual([
      '1 EXT. HARBOUR - DUSK',
      '2 INT. STAIRS - NIGHT',
      '3 INT. LAMP ROOM - NIGHT',
      '4 EXT. SEA - DAWN',
    ]);
  });

  it('changes text in place and moves a scene', async () => {
    const { run } = await setup();
    const a = await run('movie.scene.create', { heading: 'A' });
    await run('movie.scene.create', { heading: 'B' });
    await run('movie.scene.create', { heading: 'C' });

    const edited = await run('movie.scene.update', { sceneId: a.id, body: 'Mara climbs.' });
    expect(edited).toMatchObject({ heading: 'A', body: 'Mara climbs.', position: 1 });
    // The outline leaves the text out and says how long it is; the text is fetched per scene.
    const outline = (await run('movie.scene.list', {})) as unknown as { scenes: object[] };
    expect(outline.scenes[0]).toEqual({
      id: a.id,
      position: 1,
      heading: 'A',
      summary: '',
      locationId: null,
      locationStateId: null,
      words: 2,
    });
    expect(await run('movie.scene.get', { sceneId: a.id })).toMatchObject({ body: 'Mara climbs.' });
    const full = (await run('movie.scene.list', { full: true })) as unknown as { scenes: object[] };
    expect(full.scenes[0]).toMatchObject({ body: 'Mara climbs.', words: 2 });

    const moved = await run('movie.scene.update', { sceneId: a.id, position: 3, heading: 'A2' });
    expect(moved).toMatchObject({ position: 3, body: 'Mara climbs.' });
    expect(headings(await run('movie.scene.list', {}))).toEqual(['1 B', '2 C', '3 A2']);

    await run('movie.scene.update', { sceneId: a.id, position: 1, summary: 'She climbs.' });
    expect(headings(await run('movie.scene.list', {}))).toEqual(['1 A2', '2 B', '3 C']);
  });

  it('deletes with renumbering, and an agent needs approval for it', async () => {
    const { run, registry, projectId } = await setup();
    const a = await run('movie.scene.create', { heading: 'A' });
    await run('movie.scene.create', { heading: 'B' });

    const asked = await registry.executeById(
      'movie.scene.delete',
      { projectId, sceneId: a.id },
      { actor: writer },
    );
    expect(asked.status).toBe('needs-approval');

    expect(await run('movie.scene.delete', { sceneId: a.id })).toEqual({
      sceneId: a.id,
      remaining: 1,
    });
    expect(headings(await run('movie.scene.list', {}))).toEqual(['1 B']);
  });

  it('refuses unknown scenes', async () => {
    const { registry, projectId } = await setup();
    for (const id of ['movie.scene.get', 'movie.scene.update', 'movie.scene.delete']) {
      await expect(
        registry.executeById(id, { projectId, sceneId: 'nope' }, { actor: user }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });
});

describe('characters', () => {
  it('creates, lists by name, changes and deletes', async () => {
    const { run, registry, projectId } = await setup();
    const tomas = await run('movie.character.create', { name: 'Tomas' });
    const mara = await run(
      'movie.character.create',
      { name: 'Mara', part: 'protagonist', appearance: 'Sixty, wiry, grey braid.' },
      writer,
    );
    expect(tomas).toMatchObject({ part: '', description: '', appearance: '', voice: '' });

    await run('movie.character.update', { characterId: mara.id, voice: 'Low and dry.' });
    expect(await run('movie.character.list', {})).toEqual({
      characters: [
        {
          id: mara.id,
          name: 'Mara',
          part: 'protagonist',
          portraitId: null,
          voiceOnly: false,
          ownLane: false,
        },
        {
          id: tomas.id,
          name: 'Tomas',
          part: '',
          portraitId: null,
          voiceOnly: false,
          ownLane: false,
        },
      ],
    });
    expect(await run('movie.character.get', { characterId: mara.id })).toMatchObject({
      voice: 'Low and dry.',
    });
    const listed = (await run('movie.character.list', { full: true })) as unknown as {
      characters: Record<string, string>[];
    };
    expect(listed.characters).toEqual([
      {
        id: mara.id,
        name: 'Mara',
        part: 'protagonist',
        description: '',
        appearance: 'Sixty, wiry, grey braid.',
        voice: 'Low and dry.',
        images: [],
        portraitId: null,
        voiceSample: null,
        voiceOnly: false,
        ownLane: false,
      },
      expect.objectContaining({ name: 'Tomas' }),
    ]);

    expect(await run('movie.character.delete', { characterId: tomas.id })).toEqual({
      characterId: tomas.id,
    });
    for (const id of ['movie.character.get', 'movie.character.update', 'movie.character.delete']) {
      await expect(
        registry.executeById(id, { projectId, characterId: tomas.id }, { actor: user }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });
});

describe('character images', () => {
  interface Made {
    image: { id: string; blobKey: string; prompt: string; model: string; mediaType: string };
    costUsd: number;
  }
  const withMara = async (options: Parameters<typeof setup>[0] = {}) => {
    const context = await setup(options);
    const mara = await context.run('movie.character.create', {
      name: 'Mara',
      part: 'protagonist',
      appearance: 'Seventy, wiry, grey braid.',
    });
    await context.registry.executeById(
      'settings.set',
      { key: 'images.model', value: 'vendor/painter' },
      { actor: user },
    );
    const make = async (input: Record<string, unknown> = {}) =>
      (await context.run('movie.character.image.generate', {
        characterId: mara.id,
        ...input,
      })) as unknown as Made;
    const read = async () =>
      (await context.run('movie.character.get', { characterId: mara.id })) as unknown as {
        images: { id: string }[];
        portraitId: string | null;
      };
    return { ...context, mara, make, read };
  };

  it('generates from the appearance and the tone, stores the file and sets the first portrait', async () => {
    const { run, runtime, provider, make, read } = await withMara();
    await run('movie.development.update', { tone: 'Quiet, wet, warm.' });
    const first = await make();
    expect(provider.imageRequests[0]).toEqual({
      model: 'vendor/painter',
      prompt:
        'Character portrait of Mara, protagonist. Seventy, wiry, grey braid. Visual style: Quiet, wet, warm.',
      aspectRatio: '3:4',
    });
    expect(first.costUsd).toBe(0.01);
    expect(first.image).toMatchObject({ model: 'vendor/painter', mediaType: 'image/webp' });
    expect((await runtime.blobs.get(first.image.blobKey))?.mediaType).toBe('image/webp');

    const second = await make({
      direction: 'In profile.',
      model: 'other/painter',
      aspectRatio: '1:1',
    });
    expect(provider.imageRequests[1]).toMatchObject({
      model: 'other/painter',
      aspectRatio: '1:1',
      prompt: expect.stringContaining('In profile.') as string,
    });
    const third = await make({ prompt: 'Just this.' });
    expect(third.image.prompt).toBe('Just this.');
    expect(await read()).toMatchObject({
      portraitId: first.image.id,
      images: [{ id: first.image.id }, { id: second.image.id }, { id: third.image.id }],
    });
    // The outline says which image stands for the character without carrying the list.
    expect(await run('movie.character.list', {})).toEqual({
      characters: [
        {
          id: expect.any(String) as string,
          name: 'Mara',
          part: 'protagonist',
          portraitId: first.image.id,
          voiceOnly: false,
          ownLane: false,
        },
      ],
    });
  });

  it('chooses a portrait and deletes images, moving the portrait on', async () => {
    const { run, runtime, mara, make, read } = await withMara();
    const first = await make();
    const second = await make();
    const third = await make();
    const at = { characterId: mara.id };
    expect(await run('movie.character.image.select', { ...at, imageId: second.image.id })).toEqual({
      characterId: mara.id,
      portraitId: second.image.id,
    });
    // Deleting another image leaves the portrait; deleting the portrait hands it to the newest.
    expect(
      await run('movie.character.image.delete', { ...at, imageId: first.image.id }),
    ).toMatchObject({
      portraitId: second.image.id,
    });
    expect(
      await run('movie.character.image.delete', { ...at, imageId: second.image.id }),
    ).toMatchObject({
      portraitId: third.image.id,
    });
    expect(await runtime.blobs.list('')).toEqual([third.image.blobKey]);
    expect(
      await run('movie.character.image.delete', { ...at, imageId: third.image.id }),
    ).toMatchObject({
      portraitId: null,
    });
    expect(await read()).toMatchObject({ images: [], portraitId: null });
  });

  it('removes the files with the character', async () => {
    const { run, runtime, mara, make } = await withMara();
    await make();
    await make();
    await run('movie.character.delete', { characterId: mara.id });
    expect(await runtime.blobs.list('')).toEqual([]);
  });

  it('falls back to the description, and needs a model from somewhere', async () => {
    const { run, registry, provider, projectId } = await setup();
    const bare = await run('movie.character.create', {
      name: 'Tomas',
      description: 'A quiet clerk.',
    });
    await expect(
      registry.executeById(
        'movie.character.image.generate',
        { projectId, characterId: bare.id },
        { actor: user },
      ),
    ).rejects.toThrow(/No image model is chosen/);
    await run('movie.character.image.generate', { characterId: bare.id, model: 'vendor/painter' });
    expect(provider.imageRequests[0]?.prompt).toBe('Character portrait of Tomas. A quiet clerk.');
  });

  it('asks before an agent spends, and reports failures in words', async () => {
    const { registry, projectId, mara } = await withMara({
      imageError: new ProviderError('insufficient_credit', 'fake', 'No credit left.'),
    });
    const input = { projectId, characterId: mara.id };
    const asked = await registry.executeById('movie.character.image.generate', input, {
      actor: { kind: 'agent', id: 'c', role: 'casting-director' },
    });
    expect(asked.status).toBe('needs-approval');
    await expect(
      registry.executeById('movie.character.image.generate', input, { actor: user }),
    ).rejects.toMatchObject({
      code: 'handler_failed',
      message: 'No image was made: No credit left.',
    });
  });

  it('refuses unknown characters and images', async () => {
    const { registry, projectId, mara } = await withMara();
    for (const id of ['generate', 'select', 'delete']) {
      await expect(
        registry.executeById(
          `movie.character.image.${id}`,
          { projectId, characterId: 'nobody', imageId: 'x' },
          { actor: user },
        ),
      ).rejects.toThrow(/No character/);
    }
    for (const id of ['select', 'delete']) {
      await expect(
        registry.executeById(
          `movie.character.image.${id}`,
          { projectId, characterId: mara.id, imageId: 'x' },
          { actor: user },
        ),
      ).rejects.toThrow(/No image "x"/);
    }
  });
});

describe('character voice samples', () => {
  interface Recorded {
    voiceSample: { blobKey: string; line: string; direction: string; model: string };
    costUsd: number | null;
  }
  const withMara = async (options: Parameters<typeof setup>[0] = {}) => {
    const context = await setup(options);
    const mara = await context.run('movie.character.create', {
      name: 'Mara',
      part: 'protagonist',
      description: 'Keeps the light.',
      voice: 'Low and dry.',
    });
    await context.registry.executeById(
      'settings.set',
      { key: 'speech.model', value: 'vendor/speaker' },
      { actor: user },
    );
    const record = async (input: Record<string, unknown> = {}) =>
      (await context.run('movie.character.voice.generate', {
        characterId: mara.id,
        ...input,
      })) as unknown as Recorded;
    return { ...context, mara, record };
  };

  it('records an introduction in the written voice and keeps it with the character', async () => {
    const { run, runtime, provider, mara, record } = await withMara();
    const first = await record();
    expect(await run('movie.sound.library', {})).toMatchObject({
      sounds: [
        { kind: 'voice', label: expect.stringContaining('voice sample') as string, sceneId: null },
      ],
    });
    expect(provider.speechRequests[0]).toEqual({
      model: 'vendor/speaker',
      text: 'Hello. My name is Mara.',
      instructions: 'Mara, protagonist. Low and dry.',
    });
    expect(first.voiceSample).toMatchObject({ model: 'vendor/speaker', mediaType: 'audio/mpeg' });
    expect((await runtime.blobs.get(first.voiceSample.blobKey))?.bytes).toEqual(
      new Uint8Array([1]),
    );
    expect(await run('movie.character.get', { characterId: mara.id })).toMatchObject({
      voiceSample: { blobKey: first.voiceSample.blobKey, line: 'Hello. My name is Mara.' },
    });
    // The outline of the cast does not carry it.
    expect(await run('movie.character.list', {})).toEqual({
      characters: [
        {
          id: mara.id,
          name: 'Mara',
          part: 'protagonist',
          portraitId: null,
          voiceOnly: false,
          ownLane: false,
        },
      ],
    });
  });

  it('takes a line, a delivery and a model, and replaces the earlier recording', async () => {
    const { runtime, provider, record } = await withMara();
    const first = await record();
    const second = await record({
      line: 'Get away from the rail!',
      delivery: 'Shouting over a storm.',
      model: 'other/speaker',
    });
    expect(provider.speechRequests[1]).toEqual({
      model: 'other/speaker',
      text: 'Get away from the rail!',
      instructions: 'Mara, protagonist. Low and dry. Delivery: Shouting over a storm.',
    });
    expect(second.voiceSample.direction).toContain('Delivery: Shouting over a storm.');
    expect(await runtime.blobs.list('')).toEqual([second.voiceSample.blobKey]);
    expect(second.voiceSample.blobKey).not.toBe(first.voiceSample.blobKey);
  });

  it('deletes the recording alone, and with the character', async () => {
    const { run, runtime, mara, record } = await withMara();
    const at = { characterId: mara.id };
    expect(await run('movie.character.voice.delete', at)).toEqual({ ...at, deleted: false });
    await record();
    expect(await run('movie.character.voice.delete', at)).toEqual({ ...at, deleted: true });
    expect(await runtime.blobs.list('')).toEqual([]);
    expect(await run('movie.character.get', at)).toMatchObject({
      voiceSample: null,
      voice: 'Low and dry.',
    });
    await record();
    await run('movie.character.delete', at);
    expect(await runtime.blobs.list('')).toEqual([]);
  });

  it('falls back to the description, needs a model, and reports failures in words', async () => {
    const { run, registry, provider, projectId } = await setup();
    const bare = await run('movie.character.create', {
      name: 'Tomas',
      description: 'A quiet clerk.',
    });
    const input = { projectId, characterId: bare.id };
    await expect(
      registry.executeById('movie.character.voice.generate', input, { actor: user }),
    ).rejects.toThrow(/No speech model is chosen/);
    await run('movie.character.voice.generate', { characterId: bare.id, model: 'vendor/speaker' });
    expect(provider.speechRequests[0]?.instructions).toBe('Tomas. A quiet clerk.');
    for (const id of ['generate', 'delete']) {
      await expect(
        registry.executeById(
          `movie.character.voice.${id}`,
          { projectId, characterId: 'nobody' },
          { actor: user },
        ),
      ).rejects.toThrow(/No character/);
    }

    const failing = await withMara({
      speechError: new ProviderError('rate_limit', 'fake', 'Slow down.'),
    });
    const failingInput = { projectId: failing.projectId, characterId: failing.mara.id };
    expect(
      (
        await failing.registry.executeById('movie.character.voice.generate', failingInput, {
          actor: { kind: 'agent', id: 'c', role: 'casting-director' },
        })
      ).status,
    ).toBe('needs-approval');
    await expect(
      failing.registry.executeById('movie.character.voice.generate', failingInput, { actor: user }),
    ).rejects.toMatchObject({ message: 'No voice was recorded: Slow down.' });
  });
});

describe('shots and clips', () => {
  interface WithClip {
    clip: {
      status: string;
      jobId: string;
      blobKey: string | null;
      prompt: string;
      costUsd: number | null;
      error: string | null;
    };
  }
  const withScene = async (options: Parameters<typeof setup>[0] = {}) => {
    const context = await setup(options);
    const { run } = context;
    const scene = await run('movie.scene.create', { heading: 'INT. LAMP ROOM - NIGHT' });
    const mara = await run('movie.character.create', {
      name: 'Mara',
      appearance: 'Seventy, grey braid.',
    });
    const tomas = await run('movie.character.create', { name: 'Tomas' });
    await context.registry.executeById(
      'settings.set',
      { key: 'video.model', value: 'vendor/clips' },
      { actor: user },
    );
    const at = (shotId: string) => ({ sceneId: scene.id, shotId });
    const add = (fields: Record<string, unknown> = {}) =>
      run('movie.shot.create', { sceneId: scene.id, ...fields });
    const storm = () =>
      add({
        description: 'Wide on the gallery door, rain blowing in.',
        characterIds: [mara.id, tomas.id],
        performance: 'Mara lunges and drags Tomas back by the collar.',
        speakerId: mara.id,
        line: 'Tomas! Get away from the rail!',
        delivery: 'Screaming over the wind.',
      });
    return { ...context, scene, mara, tomas, at, add, storm };
  };

  it('adds shots in order, lists an outline, changes and deletes them', async () => {
    const { run, scene, mara, at, add } = await withScene();
    const first = await add({ description: 'The lamp turns.' });
    const second = await add({ description: 'Mara at the stairs.', line: 'Who is there?' });
    expect(first).toEqual({
      id: first.id,
      sceneId: scene.id,
      position: 1,
      description: 'The lamp turns.',
      characterIds: [],
      performance: '',
      locationId: null,
      locationStateId: null,
      viewId: null,
      objects: [],
      speakerId: null,
      line: '',
      delivery: '',
      dialogue: null,
      frames: [],
      frameId: null,
      clip: null,
      takes: [],
    });
    expect(await run('movie.shot.list', { sceneId: scene.id })).toEqual({
      shots: [
        {
          id: first.id,
          position: 1,
          description: 'The lamp turns.',
          line: '',
          dialogue: false,
          clip: null,
        },
        {
          id: second.id,
          position: 2,
          description: 'Mara at the stairs.',
          line: 'Who is there?',
          dialogue: false,
          clip: null,
        },
      ],
    });
    expect(
      await run('movie.shot.update', { ...at(second.id), speakerId: mara.id, delivery: 'Sharp.' }),
    ).toMatchObject({ speakerId: mara.id, delivery: 'Sharp.', line: 'Who is there?' });
    expect(await run('movie.shot.update', { ...at(second.id), speakerId: null })).toMatchObject({
      speakerId: null,
      delivery: 'Sharp.',
    });
    expect(await run('movie.shot.get', at(second.id))).toMatchObject({ position: 2 });
    expect(await run('movie.shot.delete', at(first.id))).toEqual({
      shotId: first.id,
      remaining: 1,
    });
    expect(await run('movie.shot.list', { sceneId: scene.id, full: true })).toMatchObject({
      shots: [{ id: second.id, position: 1, delivery: 'Sharp.' }],
    });
  });

  it('builds the prompt from the shot, the cast and the tone', async () => {
    const { run, mara, tomas, storm, add } = await withScene();
    await run('movie.development.update', { tone: 'Cold sea light.' });
    const shot = Shot.parse(await storm());
    const cast = [mara, tomas].map((entry) => Character.parse(entry));
    expect(clipPrompt(shot, cast, 'Cold sea light.')).toBe(
      [
        'Wide on the gallery door, rain blowing in.',
        'Mara: Seventy, grey braid.',
        'Performance: Mara lunges and drags Tomas back by the collar.',
        'Mara says, Screaming over the wind, "Tomas! Get away from the rail!"',
        'Visual style: Cold sea light.',
      ].join('\n'),
    );
    const silent = Shot.parse(await add({ description: 'The lamp turns.' }));
    expect(clipPrompt(silent, [], '')).toBe('The lamp turns.\nNobody speaks.');
    const offscreen = Shot.parse(await add({ description: 'Dark stairs.', line: 'Hello?' }));
    expect(clipPrompt(offscreen, [], '')).toBe('Dark stairs.\nA voice says "Hello?"');
  });

  it('keeps a voice-only narrator out of the prompt and the picture', async () => {
    const { run, mara, add } = await withScene();
    const narrator = Character.parse(
      await run('movie.character.create', {
        name: 'Narrator',
        appearance: 'An old man in a chair.',
        voice: 'Warm, slow.',
        voiceOnly: true,
      }),
    );
    expect(narrator.voiceOnly).toBe(true);
    expect(
      Character.parse(await run('movie.character.get', { characterId: narrator.id })).voiceOnly,
    ).toBe(true);
    const shot = Shot.parse(
      await add({ description: 'The lamp turns.', line: 'It had burned for a century.' }),
    );
    const narrated = { ...shot, speakerId: narrator.id };
    expect(clipPrompt(narrated, [Character.parse(mara), narrator], '')).toBe(
      'The lamp turns.\nMara: Seventy, grey braid.\nNobody in the picture speaks; a voice-over is added later.',
    );
    const unset = Character.parse(
      await run('movie.character.update', {
        characterId: narrator.id,
        voiceOnly: false,
        ownLane: false,
      }),
    );
    expect(unset.voiceOnly).toBe(false);
  });

  it('starts a clip with the portraits as guides, then stores it when it is done', async () => {
    const { run, runtime, registry, provider, mara, at, storm } = await withScene();
    await registry.executeById(
      'settings.set',
      { key: 'images.model', value: 'vendor/painter' },
      { actor: user },
    );
    await run('movie.character.image.generate', { characterId: mara.id });
    const shot = await storm();
    const started = (await run('movie.shot.clip.generate', at(shot.id))) as unknown as WithClip;
    expect(started.clip).toMatchObject({
      status: 'pending',
      jobId: 'job-1',
      blobKey: null,
      portraits: 1,
    });
    expect(provider.videoRequests[0]).toMatchObject({
      model: 'vendor/clips',
      durationSeconds: 4,
      resolution: '720p',
      aspectRatio: '16:9',
      audio: true,
      references: [{ mediaType: 'image/webp' }],
      prompt: expect.stringContaining('"Tomas! Get away from the rail!"') as string,
    });
    expect(await run('movie.shot.list', { sceneId: shot['sceneId'] })).toMatchObject({
      shots: [{ clip: 'pending' }],
    });

    const waiting = (await run('movie.shot.clip.check', at(shot.id))) as unknown as WithClip;
    expect(waiting.clip.status).toBe('pending');
    const done = (await run('movie.shot.clip.check', at(shot.id))) as unknown as WithClip;
    expect(done.clip).toMatchObject({ status: 'ready', costUsd: 0.2 });
    expect((await runtime.blobs.get(done.clip.blobKey ?? ''))?.mediaType).toBe('video/mp4');
    // Checking a finished clip asks nobody and changes nothing.
    expect(await run('movie.shot.clip.check', at(shot.id))).toEqual(done);

    // A new clip keeps the old one as a take.
    await run('movie.shot.clip.generate', { ...at(shot.id), portraits: false, audio: false });
    expect(provider.videoRequests[1]).toMatchObject({ audio: false });
    expect(provider.videoRequests[1]).not.toHaveProperty('references');
    expect(await runtime.blobs.list('')).toContain(done.clip.blobKey);
    expect(await run('movie.shot.get', at(shot.id))).toMatchObject({
      takes: [{ blobKey: done.clip.blobKey }],
    });
  });

  it('makes the clip from the words alone when the model takes no portraits', async () => {
    const { run, registry, provider, mara, at, storm } = await withScene({
      videoRefusesReferences: true,
    });
    await registry.executeById(
      'settings.set',
      { key: 'images.model', value: 'vendor/painter' },
      { actor: user },
    );
    await run('movie.character.image.generate', { characterId: mara.id });
    const shot = await storm();
    expect(await run('movie.shot.clip.generate', at(shot.id))).toMatchObject({
      clip: { status: 'pending', portraits: 0 },
    });
    expect(provider.videoRequests).toHaveLength(2);
    expect(provider.videoRequests[1]).not.toHaveProperty('references');
  });

  it('records the line in the voice of the speaker and makes the clip silent and long enough', async () => {
    const video = {
      durationsSeconds: [4, 6, 8],
      resolutions: ['480p', '720p'],
      aspectRatios: ['16:9'],
      frameImages: [],
      nativeAudio: true,
    };
    const { run, runtime, registry, provider, at, storm } = await withScene({
      models: [
        {
          id: 'vendor/clips',
          name: 'Clips',
          inputModalities: ['text'],
          outputModalities: ['video'],
          video,
          contextLength: null,
          supportsTools: false,
          pricing: { promptUsdPerToken: null, completionUsdPerToken: null },
        },
      ],
    });
    await registry.executeById(
      'settings.set',
      { key: 'speech.model', value: 'vendor/speaker' },
      { actor: user },
    );
    const shot = await storm();
    const spoken = (await run('movie.shot.dialogue.generate', at(shot.id))) as unknown as {
      dialogue: { blobKey: string; durationSeconds: number; line: string };
    };
    expect(provider.speechRequests[0]).toMatchObject({
      model: 'vendor/speaker',
      text: 'Tomas! Get away from the rail!',
      instructions: expect.stringContaining('Delivery: Screaming over the wind.') as string,
    });
    expect(spoken.dialogue).toMatchObject({ line: 'Tomas! Get away from the rail!' });
    expect(await run('movie.sound.library', {})).toMatchObject({
      sounds: [
        {
          key: spoken.dialogue.blobKey,
          kind: 'dialogue',
          label: 'Shot 1: Tomas! Get away from the rail!',
        },
      ],
    });
    expect(await run('movie.shot.list', { sceneId: shot['sceneId'] })).toMatchObject({
      shots: [{ dialogue: true }],
    });

    const started = (await run('movie.shot.clip.generate', {
      ...at(shot.id),
      resolution: '1080p',
    })) as unknown as WithClip;
    expect(started.clip).toMatchObject({ silent: true, durationSeconds: 4 });
    expect(provider.videoRequests[0]).toMatchObject({
      durationSeconds: 4,
      resolution: '720p',
      audio: false,
      prompt: expect.stringContaining('no sound is heard') as string,
    });
    expect(provider.videoRequests[0]?.prompt).not.toContain('"Tomas! Get away');

    // A new recording replaces the file of the old one; deleting it leaves the line.
    await run('movie.shot.dialogue.generate', at(shot.id));
    expect((await runtime.blobs.list('')).filter((key) => key.includes('/dialogue/'))).toHaveLength(
      1,
    );
    expect(await run('movie.shot.dialogue.delete', at(shot.id))).toEqual({
      shotId: shot.id,
      deleted: true,
    });
    expect(await run('movie.shot.dialogue.delete', at(shot.id))).toEqual({
      shotId: shot.id,
      deleted: false,
    });
    expect(await runtime.blobs.list('')).not.toContainEqual(
      expect.stringContaining('/dialogue/') as string,
    );
    await run('movie.shot.dialogue.generate', at(shot.id));
    await run('movie.shot.delete', at(shot.id));
    expect((await runtime.blobs.list('')).filter((key) => key.includes('/dialogue/'))).toHaveLength(
      0,
    );
  });

  it('asks for a speaker, a line and a speech model before recording', async () => {
    const { run, at, add, mara } = await withScene();
    const mute = await add({ description: 'A door.' });
    await expect(run('movie.shot.dialogue.generate', at(mute.id))).rejects.toThrow(
      /speaker and the line/,
    );
    const talker = await add({ description: 'Mara.', speakerId: mara.id, line: 'Hello.' });
    await expect(run('movie.shot.dialogue.generate', at(talker.id))).rejects.toThrow(
      /No speech model/,
    );
  });

  it('keeps the lines of an own-lane character on a lane: add, record, change, undo, remove', async () => {
    const { run, registry, runtime, provider, scene, mara } = await withScene();
    const narrator = Character.parse(
      await run('movie.character.create', {
        name: 'Narrator',
        voice: 'Warm, slow.',
        voiceOnly: true,
        ownLane: true,
      }),
    );
    const base = { sceneId: scene.id };
    await expect(
      run('movie.edit.line.add', { ...base, characterId: mara.id, text: 'Hello.' }),
    ).rejects.toThrow(/own lane/);
    const line = (await run('movie.edit.line.add', {
      ...base,
      characterId: narrator.id,
      text: 'The lamp had burned for a century.',
      delivery: 'Hushed.',
      startSeconds: 1,
    })) as unknown as { id: string };
    await expect(run('movie.edit.line.record', { ...base, lineId: line.id })).rejects.toThrow(
      /No speech model/,
    );
    await registry.executeById(
      'settings.set',
      { key: 'speech.model', value: 'vendor/speaker' },
      { actor: user },
    );
    const recorded = await run('movie.edit.line.record', { ...base, lineId: line.id });
    expect(recorded).toMatchObject({ recorded: true, outdated: false });
    expect(provider.speechRequests.at(-1)).toMatchObject({
      text: 'The lamp had burned for a century.',
      instructions: expect.stringContaining('Narrator') as string,
    });

    let cut = (await run('movie.edit.get', base)) as unknown as {
      lanes: { characterId: string; name: string; voiceOnly: boolean }[];
      lines: { id: string; startSeconds: number; recorded: boolean; outdated: boolean }[];
    };
    expect(cut.lanes).toEqual([{ characterId: narrator.id, name: 'Narrator', voiceOnly: true }]);
    expect(cut.lines).toMatchObject([{ id: line.id, startSeconds: 1, recorded: true }]);

    await run('movie.edit.line.update', {
      ...base,
      lineId: line.id,
      text: 'A century.',
      volume: 0.8,
    });
    cut = (await run('movie.edit.get', base)) as unknown as typeof cut;
    expect(cut.lines[0]).toMatchObject({ outdated: true });
    await run('movie.edit.undo', base);
    cut = (await run('movie.edit.get', base)) as unknown as typeof cut;
    expect(cut.lines[0]).toMatchObject({ outdated: false });
    await expect(
      run('movie.edit.line.update', { ...base, lineId: 'nowhere', volume: 1 }),
    ).rejects.toThrow(/No line/);

    const overview = (await run('movie.edit.film', {})) as unknown as { totalCostUsd: number };
    expect(overview.totalCostUsd).toBeGreaterThanOrEqual(0);
    expect(await run('movie.edit.line.remove', { ...base, lineId: line.id })).toEqual({
      lineId: line.id,
      removed: true,
    });
    expect(await run('movie.edit.line.remove', { ...base, lineId: line.id })).toEqual({
      lineId: line.id,
      removed: false,
    });
    await run('movie.edit.undo', base);
    expect(((await run('movie.edit.get', base)) as unknown as typeof cut).lines).toHaveLength(1);
    await run('movie.scene.delete', base);
    expect((await runtime.blobs.list('')).filter((key) => key.includes('/lines/'))).toHaveLength(0);
  });

  it('refuses a video model that cannot make a film before spending anything', async () => {
    const { run, provider, at, add } = await withScene({
      models: [
        {
          id: 'vendor/clips',
          name: 'Clips',
          inputModalities: ['text', 'image'],
          outputModalities: ['video'],
          video: {
            durationsSeconds: [],
            resolutions: ['720p'],
            aspectRatios: ['16:9'],
            frameImages: ['first_frame'],
            nativeAudio: null,
          },
          contextLength: null,
          supportsTools: false,
          pricing: { promptUsdPerToken: null, completionUsdPerToken: null },
        },
      ],
    });
    const shot = await add({ description: 'The lamp turns.' });
    await expect(run('movie.shot.clip.generate', at(shot.id))).rejects.toThrow(
      /cannot be used for clips/,
    );
    expect(provider.videoRequests).toHaveLength(0);
  });

  const withCuts = async () => {
    const context = await withScene();
    const { run, at, add } = context;
    const ready = async (fields: Record<string, unknown>) => {
      const shot = await add(fields);
      await run('movie.shot.clip.generate', { ...at(shot.id), durationSeconds: 4 });
      await run('movie.shot.clip.check', at(shot.id));
      await run('movie.shot.clip.check', at(shot.id));
      return shot;
    };
    interface CutView {
      totalSeconds: number;
      canUndo: boolean;
      canRedo: boolean;
      items: {
        itemId: string;
        state: string;
        startsAtSeconds: number;
        durationSeconds: number;
        label: string;
        clipAudioVolume: number;
      }[];
      unplaced: { shotId: string }[];
      sounds: { id: string; name: string; kind: string; recorded: boolean; source: string }[];
    }
    const cutOf = async () =>
      (await run('movie.edit.get', { sceneId: context.scene.id })) as unknown as CutView;
    const edit = (command: string, fields: Record<string, unknown>) =>
      run(`movie.edit.${command}`, { sceneId: context.scene.id, ...fields });
    return { ...context, ready, cutOf, edit };
  };

  it('lays out a scene on a timeline and says what is missing', async () => {
    const { run, add, ready, cutOf, edit, scene, mara } = await withCuts();
    const a = await ready({ description: 'The lamp turns.' });
    const b = await ready({ description: 'Mara at the stairs.' });
    const c = await add({ description: 'Nothing yet.' });
    await add({ description: 'Mara speaks.', speakerId: mara.id, line: 'Hello.' });

    const first = await cutOf();
    expect(first.totalSeconds).toBe(8);
    expect(first.canUndo).toBe(false);
    expect(first.items.map((i) => [i.state, i.startsAtSeconds, i.durationSeconds])).toEqual([
      ['ready', 0, 4],
      ['ready', 4, 4],
      ['no_clip', 8, 0],
      ['no_clip', 8, 0],
    ]);

    await edit('item.set', { itemId: a.id, trimEndSeconds: 1.5 });
    await edit('item.set', { itemId: b.id, trimStartSeconds: 0.5 });
    const trimmed = await cutOf();
    expect(trimmed.totalSeconds).toBe(6);
    expect(trimmed.items[1]).toMatchObject({ startsAtSeconds: 2.5, durationSeconds: 3.5 });
    await expect(edit('item.set', { itemId: 'nope', trimEndSeconds: 1 })).rejects.toThrow(
      /No item/,
    );

    const overview = (await run('movie.edit.film', {})) as unknown as {
      totalSeconds: number;
      items: number;
      readyItems: number;
      scenes: { missing: { itemId: string; state: string }[] }[];
    };
    expect(overview).toMatchObject({ totalSeconds: 6, items: 4, readyItems: 2 });
    expect(overview.scenes[0]?.missing[0]).toMatchObject({ itemId: c.id, state: 'no_clip' });
    expect(scene.id).toBeDefined();
  });

  it('moves, splits, copies and removes pieces, and undoes and redoes them', async () => {
    const { ready, cutOf, edit } = await withCuts();
    const a = await ready({ description: 'A' });
    const b = await ready({ description: 'B' });
    const labels = async () => (await cutOf()).items.map((i) => i.label).join('');

    await edit('item.move', { itemId: b.id, toIndex: 0 });
    expect(await labels()).toBe('BA');

    const split = (await edit('item.split', { itemId: a.id, atSeconds: 1.5 })) as unknown as {
      first: { trimEndSeconds: number };
      second: { id: string; trimStartSeconds: number };
    };
    expect(split.first.trimEndSeconds).toBe(2.5);
    expect(split.second.trimStartSeconds).toBe(1.5);
    expect(await labels()).toBe('BAA');
    expect((await cutOf()).totalSeconds).toBe(8);
    await expect(edit('item.split', { itemId: a.id, atSeconds: 1.45 })).rejects.toThrow(
      /Split between/,
    );

    await edit('item.move', { itemId: split.second.id, toIndex: 0 });
    expect((await cutOf()).items.map((i) => i.durationSeconds)).toEqual([2.5, 4, 1.5]);

    const copy = (await edit('item.duplicate', { itemId: b.id })) as unknown as {
      item: { id: string };
    };
    expect(await labels()).toBe('ABBA');
    await edit('item.remove', { itemId: copy.item.id });
    await edit('item.remove', { itemId: b.id });
    const afterRemoval = await cutOf();
    expect(afterRemoval.items).toHaveLength(2);
    expect(afterRemoval.unplaced).toEqual([expect.objectContaining({ shotId: b.id })]);

    await edit('item.add', { shotId: b.id, toIndex: 1 });
    expect(await labels()).toBe('ABA');
    await edit('title.add', { text: 'The Keeper', seconds: 2, toIndex: 0 });
    const titled = await cutOf();
    expect(titled.items[0]).toMatchObject({
      label: 'The Keeper',
      durationSeconds: 2,
      state: 'ready',
    });
    await expect(
      edit('item.split', { itemId: titled.items[0]?.itemId, atSeconds: 1 }),
    ).rejects.toThrow(/title card/);

    // Undo walks back every change; redo walks forward again.
    const total = titled.totalSeconds;
    expect((await edit('undo', {}))['done']).toBe(true);
    expect(await labels()).toBe('ABA');
    expect((await edit('redo', {}))['done']).toBe(true);
    expect((await cutOf()).totalSeconds).toBe(total);
    let steps = 0;
    while (((await edit('undo', {}))['done'] as boolean) && steps < 60) steps++;
    expect(steps).toBe(8);
    expect(await labels()).toBe('AB');
    expect((await cutOf()).canUndo).toBe(false);
    // A new change drops what could have been redone.
    await edit('item.move', { itemId: a.id, toIndex: 1 });
    expect((await cutOf()).canRedo).toBe(false);
  });

  it('puts a copy into the cut of another scene', async () => {
    const { run, ready, edit, scene } = await withCuts();
    const a = await ready({ description: 'A' });
    const other = await run('movie.scene.create', { heading: 'INT. STAIRS - DAY' });
    await edit('item.duplicate', { itemId: a.id, toSceneId: other.id });
    const there = (await run('movie.edit.get', { sceneId: other.id })) as unknown as {
      items: { sceneId: string; shotId: string; state: string; durationSeconds: number }[];
    };
    expect(there.items).toEqual([
      expect.objectContaining({
        sceneId: scene.id,
        shotId: a.id,
        state: 'ready',
        durationSeconds: 4,
      }),
    ]);
  });

  it('makes J and L cuts, keeping picture and sound in sync and subtitles on their line', async () => {
    const { run, at, add, ready, cutOf, edit, mara } = await withCuts();
    const a = await ready({ description: 'Mara speaks.', speakerId: mara.id, line: 'Hold it.' });
    const b = await add({ description: 'The door.' });
    await run('movie.shot.clip.generate', { ...at(b.id), durationSeconds: 4, audio: true });
    await run('movie.shot.clip.check', at(b.id));
    await run('movie.shot.clip.check', at(b.id));
    await expect(edit('item.roll', { itemId: a.id, type: 'l', seconds: 0.5 })).rejects.toThrow(
      /only 0 s of it was trimmed off/,
    );
    await expect(edit('item.roll', { itemId: b.id, type: 'l', seconds: 0.5 })).rejects.toThrow(
      /last item/,
    );
    await edit('item.set', { itemId: a.id, trimEndSeconds: 1 });
    await edit('item.set', { itemId: b.id, trimStartSeconds: 1 });
    await run('movie.edit.subtitles.generate', {});

    // L: the sound of the first runs on under the start of the second picture.
    const l = (await edit('item.roll', { itemId: a.id, type: 'l', seconds: 0.5 })) as unknown as {
      first: { trimEndSeconds: number; clipAudioVolume: number };
      second: { trimStartSeconds: number; clipAudioVolume: number };
      sounds: {
        id: string;
        source: string;
        shotId: string;
        startSeconds: number;
        durationSeconds: number;
        trimStartSeconds: number;
      }[];
    };
    expect(l.first).toMatchObject({ trimEndSeconds: 1.5, clipAudioVolume: 0 });
    expect(l.second).toMatchObject({ trimStartSeconds: 0.5, clipAudioVolume: 0 });
    expect(l.sounds).toEqual([
      expect.objectContaining({
        source: 'clip',
        shotId: a.id,
        startSeconds: 0,
        durationSeconds: 3,
        trimStartSeconds: 0,
      }),
      expect.objectContaining({
        source: 'clip',
        shotId: b.id,
        startSeconds: 3,
        durationSeconds: 3,
        trimStartSeconds: 1,
      }),
    ]);
    const after = (await cutOf()) as unknown as {
      totalSeconds: number;
      items: { startsAtSeconds: number; durationSeconds: number }[];
      texts: {
        anchor: { on: string; id: string } | null;
        orphaned: boolean;
        startSeconds: number;
      }[];
    };
    expect(after.totalSeconds).toBe(6);
    expect(after.items.map((item) => [item.startsAtSeconds, item.durationSeconds])).toEqual([
      [0, 2.5],
      [2.5, 3.5],
    ]);
    // The subtitle follows the line where it now lies, at the same time.
    expect(after.texts).toEqual([
      expect.objectContaining({
        anchor: expect.objectContaining({ on: 'placement', id: l.sounds[0]?.id }) as unknown,
        orphaned: false,
        startSeconds: 0,
      }),
    ]);

    // J: the next sound comes in under the end of this picture; sound already apart stays.
    const j = (await edit('item.roll', { itemId: a.id, type: 'j', seconds: 1 })) as unknown as {
      first: { trimEndSeconds: number };
      second: { trimStartSeconds: number };
      sounds: unknown[];
    };
    expect(j).toMatchObject({
      first: { trimEndSeconds: 0.5 },
      second: { trimStartSeconds: 1.5 },
      sounds: [],
    });
    expect((await cutOf()).items.map((item) => item.durationSeconds)).toEqual([3.5, 2.5]);
    await expect(edit('item.roll', { itemId: a.id, type: 'j', seconds: 2 })).rejects.toThrow(
      /at most 0.5 s/,
    );
    await edit('item.set', { itemId: a.id, trimEndSeconds: 3 });
    await expect(edit('item.roll', { itemId: a.id, type: 'l', seconds: 0.9 })).rejects.toThrow(
      /shorter than/,
    );
    await edit('undo', {});
    await edit('undo', {});
    expect((await cutOf()).items.map((item) => item.durationSeconds)).toEqual([2.5, 3.5]);

    const card = (await edit('title.add', { text: 'Later', toIndex: 1 })) as unknown as {
      item: { id: string };
    };
    await expect(
      edit('item.roll', { itemId: card.item.id, type: 'l', seconds: 0.2 }),
    ).rejects.toThrow(/two shots/);
  });

  it('slows, reverses, freezes and zooms a piece, with its own sound silent off speed', async () => {
    const { run, at, add, ready, cutOf, edit, mara } = await withCuts();
    const a = await ready({ description: 'Mara speaks.', speakerId: mara.id, line: 'Hold it.' });
    const b = await add({ description: 'The door.' });
    await run('movie.shot.clip.generate', { ...at(b.id), durationSeconds: 4, audio: true });
    await run('movie.shot.clip.check', at(b.id));
    await run('movie.shot.clip.check', at(b.id));
    interface View {
      totalSeconds: number;
      items: {
        durationSeconds: number;
        movingSeconds: number;
        ownSound: boolean;
        startsAtSeconds: number;
      }[];
      spoken: { id: string }[];
    }
    const view = async () => (await cutOf()) as unknown as View;
    expect((await view()).spoken).toHaveLength(1);

    // Half speed: twice as long, and its line is no longer heard.
    await edit('item.set', { itemId: a.id, speed: 0.5 });
    let now = await view();
    expect(now.items[0]).toMatchObject({ durationSeconds: 8, movingSeconds: 8, ownSound: false });
    expect(now.totalSeconds).toBe(12);
    expect(now.spoken).toEqual([]);
    await expect(edit('audio.detach', { itemId: a.id })).rejects.toThrow(/off speed/);

    // A held last frame adds to the length; a split stays in the moving part.
    await edit('item.set', { itemId: a.id, speed: 1, holdSeconds: 1.5 });
    now = await view();
    expect(now.items[0]).toMatchObject({ durationSeconds: 5.5, movingSeconds: 4, ownSound: true });
    await expect(edit('item.split', { itemId: a.id, atSeconds: 5 })).rejects.toThrow(/moves for 4/);

    // A punch-in that pushes in is split into two halves that meet on one zoom.
    await edit('item.set', { itemId: b.id, reverse: true, zoom: 1, zoomTo: 2, focusX: 0.3 });
    const halves = (await edit('item.split', { itemId: b.id, atSeconds: 2 })) as unknown as {
      first: Record<string, unknown>;
      second: Record<string, unknown>;
    };
    expect(halves.first).toMatchObject({
      zoom: 1,
      zoomTo: 1.5,
      trimStartSeconds: 2,
      trimEndSeconds: 0,
    });
    expect(halves.second).toMatchObject({
      zoom: 1.5,
      zoomTo: 2,
      trimStartSeconds: 0,
      trimEndSeconds: 2,
    });

    // Freezing mid-shot splits it and holds the frame there, then plays on.
    const frozen = (await edit('item.freeze', {
      itemId: a.id,
      atSeconds: 1,
      holdSeconds: 2,
    })) as unknown as { frozen: Record<string, unknown>; after: Record<string, unknown> };
    expect(frozen.frozen).toMatchObject({ trimEndSeconds: 3, holdSeconds: 2 });
    expect(frozen.after).toMatchObject({ trimStartSeconds: 1, holdSeconds: 1.5 });
    now = await view();
    expect(now.items.map((item) => item.durationSeconds)).toEqual([3, 4.5, 2, 2]);
    await expect(edit('item.roll', { itemId: a.id, type: 'l', seconds: 0.2 })).rejects.toThrow(
      /own speed/,
    );

    const edl = (await edit('edl', {})) as unknown as { text: string };
    expect(edl.text).toContain('holds last frame 2.0');
    expect(edl.text).toContain('reversed');
    expect(edl.text).toContain('zoom 1.00 to 1.50 on 0.30,0.50');

    const card = (await edit('title.add', { text: 'Later' })) as unknown as {
      item: { id: string };
    };
    await expect(edit('item.set', { itemId: card.item.id, speed: 2 })).rejects.toThrow(
      /title card/,
    );
    await expect(
      edit('item.freeze', { itemId: card.item.id, atSeconds: 1, holdSeconds: 1 }),
    ).rejects.toThrow(/Only a shot/);
  });

  it('lays a dissolve or wipe over the piece before, and dips without overlap', async () => {
    const { run, at, add, ready, cutOf, edit, mara } = await withCuts();
    await ready({ description: 'Mara speaks.', speakerId: mara.id, line: 'Hold it.' });
    const b = await add({ description: 'The door.' });
    await run('movie.shot.clip.generate', { ...at(b.id), durationSeconds: 4, audio: true });
    await run('movie.shot.clip.check', at(b.id));
    await run('movie.shot.clip.check', at(b.id));
    interface View {
      totalSeconds: number;
      items: {
        startsAtSeconds: number;
        overlapSeconds: number;
        transition: string;
        dipIn: unknown;
        dipOut: unknown;
      }[];
    }
    const view = async () => (await cutOf()) as unknown as View;
    expect((await view()).items[1]).toMatchObject({ transition: 'cut', overlapSeconds: 0 });

    // A one-second dissolve starts the door a second early, so the scene is a second shorter.
    await edit('item.set', { itemId: b.id, transition: 'dissolve', transitionSeconds: 1 });
    let now = await view();
    expect(now.items[1]).toMatchObject({ startsAtSeconds: 3, overlapSeconds: 1 });
    expect(now.totalSeconds).toBe(7);
    const edl = (await edit('edl', {})) as unknown as { text: string };
    expect(edl.text).toContain('dissolve in 1.0 (overlaps 1.00)');

    // A long wipe overlaps at most half of either piece.
    await edit('item.set', { itemId: b.id, transition: 'wipe', transitionSeconds: 5 });
    now = await view();
    expect(now.items[1]).toMatchObject({ startsAtSeconds: 2, overlapSeconds: 2 });
    expect(now.totalSeconds).toBe(6);

    // A dip keeps the length and fades each side for half the transition.
    await edit('item.set', { itemId: b.id, transition: 'dip-black', transitionSeconds: 2 });
    now = await view();
    expect(now.totalSeconds).toBe(8);
    expect(now.items[0]).toMatchObject({ dipIn: null, dipOut: { color: 'black', seconds: 1 } });
    expect(now.items[1]).toMatchObject({
      startsAtSeconds: 4,
      overlapSeconds: 0,
      dipIn: { color: 'black', seconds: 1 },
    });

    // Splitting keeps the transition on the first half; the second follows with a cut.
    const halves = (await edit('item.split', { itemId: b.id, atSeconds: 2 })) as unknown as {
      first: Record<string, unknown>;
      second: Record<string, unknown>;
    };
    expect(halves.first).toMatchObject({ transition: 'dip-black' });
    expect(halves.second).toMatchObject({ transition: 'cut' });
    await expect(
      edit('item.set', { itemId: b.id, transition: 'dissolve', transitionSeconds: 9 }),
    ).rejects.toThrow();
  });

  it('leaves markers that follow their piece, and reads the whole film as text', async () => {
    const { run, ready, edit, scene } = await withCuts();
    const a = await ready({ description: 'The lamp turns.' });
    const b = await ready({ description: 'Mara at the stairs.' });
    interface Placed {
      id: string;
      atSeconds: number;
      filmSeconds: number;
      itemId: string | null;
      kind: string;
      done: boolean;
      by: string;
      text: string;
    }
    const list = async (fields: Record<string, unknown> = {}) =>
      ((await run('movie.edit.marker.list', fields)) as unknown as { markers: Placed[] }).markers;

    // On the second piece, a second into it.
    const { marker } = (await edit('marker.add', {
      atSeconds: 5,
      text: 'Jump cut: the cup moves',
      kind: 'problem',
    })) as unknown as { marker: Placed };
    expect(marker).toMatchObject({ atSeconds: 5, itemId: b.id, kind: 'problem', by: 'person' });
    // Past the end of the scene it lands at the end, on no piece.
    await edit('marker.add', { atSeconds: 99, text: 'End on a held beat' });

    // Trimming the first piece moves the second, and its marker with it.
    await edit('item.set', { itemId: a.id, trimEndSeconds: 1.5 });
    let markers = await list({ sceneId: scene.id });
    expect(markers.map((entry) => [entry.text, entry.atSeconds])).toEqual([
      ['Jump cut: the cup moves', 3.5],
      ['End on a held beat', 6.5],
    ]);

    // A second scene comes after the first in film time; an agent's marker says who left it.
    const second = await run('movie.scene.create', { heading: 'EXT. ROCKS - NIGHT' });
    await run('movie.edit.title.add', { sceneId: second.id, text: 'Later', seconds: 3 });
    await run(
      'movie.edit.marker.add',
      { sceneId: second.id, atSeconds: 1, text: 'Needs a wide', kind: 'todo' },
      writer,
    );
    markers = await list();
    expect(markers.map((entry) => entry.filmSeconds)).toEqual([3.5, 6.5, 7.5]);
    expect(markers[2]).toMatchObject({ by: 'screenwriter', kind: 'todo' });

    // Done, moved, removed.
    const changed = (await edit('marker.set', {
      markerId: marker.id,
      done: true,
      text: 'Fixed by trimming',
      atSeconds: 1,
    })) as unknown as { marker: Placed };
    expect(changed.marker).toMatchObject({ done: true, itemId: a.id, atSeconds: 1 });
    expect((await list({ open: true })).map((entry) => entry.text)).toEqual([
      'End on a held beat',
      'Needs a wide',
    ]);
    await expect(edit('marker.set', { markerId: 'nope', done: true })).rejects.toThrow(/No marker/);

    // The piece it was on goes: it stays where it was put.
    await edit('item.remove', { itemId: a.id });
    expect((await list({ sceneId: scene.id }))[0]).toMatchObject({ atSeconds: 1 });

    const film = (await run('movie.edit.film', {})) as unknown as {
      openMarkers: number;
      scenes: { startSeconds: number; openMarkers: number }[];
    };
    expect(film.openMarkers).toBe(2);
    expect(film.scenes.map((entry) => [entry.startSeconds, entry.openMarkers])).toEqual([
      [0, 1],
      [4, 1],
    ]);

    const edl = (await edit('edl', {})) as unknown as { text: string };
    expect(edl.text).toContain('MARKERS');
    expect(edl.text).toContain('problem (done) by person: Fixed by trimming');
    const whole = (await run('movie.edit.film.edl', {})) as unknown as {
      text: string;
      scenes: number;
      totalSeconds: number;
    };
    expect(whole).toMatchObject({ scenes: 2, totalSeconds: 7 });
    expect(whole.text).toContain('FILM · 2 scenes · 0:07.00');
    expect(whole.text).toContain('== Film 0:04.00 to 0:07.00 ==');
    expect(whole.text).toContain('(film 0:05.00) todo by screenwriter: Needs a wide');
    const part = (await run('movie.edit.film.edl', { fromScene: 2 })) as unknown as {
      text: string;
      scenes: number;
    };
    expect(part.scenes).toBe(1);
    expect(part.text).not.toContain('LAMP ROOM');

    const removed = (await edit('marker.remove', { markerId: marker.id })) as unknown as {
      remaining: number;
    };
    expect(removed.remaining).toBe(1);
    // Deleting a scene takes its markers with it.
    await run('movie.scene.delete', { sceneId: second.id });
    expect((await list()).map((entry) => entry.text)).toEqual(['End on a held beat']);
  });

  it('carries recorded dialogue over a silent clip into a split edit', async () => {
    const { run, registry, at, add, cutOf, edit, mara } = await withCuts();
    await registry.executeById(
      'settings.set',
      { key: 'speech.model', value: 'vendor/speaker' },
      { actor: user },
    );
    const talk = await add({ description: 'Mara speaks.', speakerId: mara.id, line: 'Hold it.' });
    await run('movie.shot.dialogue.generate', at(talk.id));
    await run('movie.shot.clip.generate', { ...at(talk.id), durationSeconds: 4 });
    await run('movie.shot.clip.check', at(talk.id));
    await run('movie.shot.clip.check', at(talk.id));
    const next = await add({ description: 'The door.' });
    await run('movie.shot.clip.generate', { ...at(next.id), durationSeconds: 4, audio: false });
    await run('movie.shot.clip.check', at(next.id));
    await run('movie.shot.clip.check', at(next.id));
    await edit('item.set', { itemId: talk.id, trimEndSeconds: 1 });
    const rolled = (await edit('item.roll', {
      itemId: talk.id,
      type: 'j',
      seconds: 0.5,
    })) as unknown as {
      first: { dialogueVolume: number };
      sounds: { source: string; durationSeconds: number }[];
    };
    expect(rolled.first.dialogueVolume).toBe(0);
    // Only the dialogue is taken apart: the next clip is silent.
    expect(rolled.sounds).toEqual([expect.objectContaining({ source: 'dialogue' })]);
    expect((await cutOf()).sounds).toEqual([
      expect.objectContaining({ kind: 'dialogue', recorded: true }),
    ]);
  });

  it('places sounds, takes the sound of a clip apart, and drops it all with the scene', async () => {
    const { run, runtime, scene, at, add, mara, cutOf, edit } = await withCuts();
    const wind = await run('movie.sound.create', {
      sceneId: scene.id,
      kind: 'effect',
      name: 'Wind',
      description: 'Wind.',
    });
    const placed = await edit('sound.place', { soundId: wind.id, volume: 0.4, loop: true });
    expect(placed).toMatchObject({ source: 'sound', soundId: wind.id, volume: 0.4, loop: true });
    expect(
      await edit('sound.update', { placementId: placed.id, startSeconds: 2, fadeInSeconds: 1 }),
    ).toMatchObject({ startSeconds: 2, fadeInSeconds: 1, volume: 0.4 });
    expect((await cutOf()).sounds).toEqual([
      expect.objectContaining({ id: placed.id, name: 'Wind', kind: 'effect', recorded: false }),
    ]);
    await expect(edit('sound.place', { soundId: 'nope' })).rejects.toThrow(/No sound/);

    // A clip made with its own voice has a sound that can be taken apart.
    const talker = await add({ description: 'Mara speaks.', speakerId: mara.id, line: 'Hello.' });
    await run('movie.shot.clip.generate', { ...at(talker.id), durationSeconds: 4 });
    await run('movie.shot.clip.check', at(talker.id));
    await run('movie.shot.clip.check', at(talker.id));
    const detached = await edit('audio.detach', { itemId: talker.id });
    expect(detached).toMatchObject({
      source: 'clip',
      shotId: talker.id,
      startSeconds: 0,
      trimStartSeconds: 0,
    });
    const view = await cutOf();
    expect(view.items[0]).toMatchObject({ clipAudioVolume: 0 });
    expect(view.sounds.find((s) => s.source === 'clip')).toMatchObject({
      name: 'Clip sound of shot 1',
      kind: 'clip',
      recorded: true,
    });
    await edit('undo', {});
    expect((await cutOf()).items[0]).toMatchObject({ clipAudioVolume: 1 });

    // Without a sound of its own, or without a clip, there is nothing to take apart.
    const quiet = await add({ description: 'Silent lamp.' });
    await run('movie.shot.clip.generate', { ...at(quiet.id), audio: false });
    await run('movie.shot.clip.check', at(quiet.id));
    await run('movie.shot.clip.check', at(quiet.id));
    await expect(edit('audio.detach', { itemId: quiet.id })).rejects.toThrow(/no sound of its own/);

    // Dialogue can be laid anywhere once it is recorded.
    await expect(edit('sound.place', { source: 'dialogue', shotId: talker.id })).rejects.toThrow(
      /no recorded dialogue/,
    );

    await run('movie.sound.delete', { sceneId: scene.id, soundId: wind.id });
    expect((await cutOf()).sounds.some((s) => s.source === 'sound')).toBe(false);
    const two = await edit('sound.place', { source: 'clip', shotId: talker.id });
    expect(await edit('sound.remove', { placementId: two.id })).toEqual({
      placementId: two.id,
      removed: true,
    });
    expect(await edit('sound.remove', { placementId: two.id })).toEqual({
      placementId: two.id,
      removed: false,
    });
    await run('movie.scene.delete', { sceneId: scene.id });
    expect(
      (await runtime.store.list('projects/')).filter((entry) => entry.key.includes('/edit')),
    ).toEqual([]);
  });

  it('keeps earlier clips as takes, puts one back, and deletes them with the shot', async () => {
    const { run, runtime, at, add } = await withScene();
    const shot = await add({ description: 'The lamp turns.' });
    const film = async () => {
      await run('movie.shot.clip.generate', at(shot.id));
      await run('movie.shot.clip.check', at(shot.id));
      return ((await run('movie.shot.clip.check', at(shot.id))) as unknown as WithClip).clip;
    };
    const clips = async () =>
      (await runtime.blobs.list('')).filter((key) => key.includes('/clip/')).length;
    const first = await film();
    expect(await run('movie.shot.take.list', at(shot.id))).toMatchObject({
      current: { number: 0, blobKey: first.blobKey },
      takes: [],
    });
    const second = await film();
    const listed = (await run('movie.shot.take.list', at(shot.id))) as unknown as {
      current: { blobKey: string };
      takes: { number: number; blobKey: string }[];
    };
    expect(listed.current.blobKey).toBe(second.blobKey);
    expect(listed.takes).toEqual([expect.objectContaining({ number: 1, blobKey: first.blobKey })]);
    expect(await clips()).toBe(2);

    // Putting the first back keeps the second as a take.
    expect(
      await run('movie.shot.take.use', { ...at(shot.id), blobKey: first.blobKey ?? '' }),
    ).toMatchObject({ clip: { blobKey: first.blobKey }, takes: 1 });
    expect(await run('movie.shot.get', at(shot.id))).toMatchObject({
      clip: { blobKey: first.blobKey },
      takes: [{ blobKey: second.blobKey }],
    });
    await expect(
      run('movie.shot.take.use', { ...at(shot.id), blobKey: 'nothing' }),
    ).rejects.toThrow(/no take/);

    // A clip being made cannot be swapped for a take; a clip that failed is not kept.
    await run('movie.shot.clip.generate', at(shot.id));
    await expect(
      run('movie.shot.take.use', { ...at(shot.id), blobKey: second.blobKey ?? '' }),
    ).rejects.toThrow(/still being made/);
    expect(
      ((await run('movie.shot.get', at(shot.id))) as unknown as { takes: unknown[] }).takes,
    ).toHaveLength(2);
    await run('movie.shot.clip.delete', at(shot.id));
    expect(
      await run('movie.shot.take.delete', { ...at(shot.id), blobKey: second.blobKey ?? '' }),
    ).toEqual({ shotId: shot.id, takes: 1 });
    expect(await clips()).toBe(1);
    await run('movie.shot.delete', at(shot.id));
    expect(await clips()).toBe(0);
  });

  it('keeps no more than so many takes', async () => {
    const { run, runtime, at, add } = await withScene();
    const shot = await add({ description: 'The lamp turns.' });
    for (let made = 0; made < MAX_TAKES + 2; made += 1) {
      await run('movie.shot.clip.generate', at(shot.id));
      await run('movie.shot.clip.check', at(shot.id));
      await run('movie.shot.clip.check', at(shot.id));
    }
    const { takes } = (await run('movie.shot.get', at(shot.id))) as unknown as {
      takes: unknown[];
    };
    expect(takes).toHaveLength(MAX_TAKES);
    expect((await runtime.blobs.list('')).filter((key) => key.includes('/clip/'))).toHaveLength(
      MAX_TAKES + 1,
    );
  });

  it('deletes clips with what they belong to', async () => {
    const { run, runtime, scene, at, add } = await withScene();
    const make = async () => {
      const shot = await add({ description: 'The lamp turns.' });
      await run('movie.shot.clip.generate', at(shot.id));
      await run('movie.shot.clip.check', at(shot.id));
      await run('movie.shot.clip.check', at(shot.id));
      return shot;
    };
    const clips = async () =>
      (await runtime.blobs.list('')).filter((key) => key.includes('/clip/')).length;
    const [a, b] = [await make(), await make(), await make()];
    expect(await clips()).toBe(3);
    expect(await run('movie.shot.clip.delete', at(a.id))).toEqual({ shotId: a.id, deleted: true });
    expect(await run('movie.shot.clip.delete', at(a.id))).toEqual({ shotId: a.id, deleted: false });
    expect(await run('movie.shot.get', at(a.id))).toMatchObject({ clip: null });
    await run('movie.shot.delete', at(b.id));
    expect(await clips()).toBe(1);
    await run('movie.scene.delete', { sceneId: scene.id });
    expect(await clips()).toBe(0);
    expect(await runtime.store.list('projects/')).not.toContainEqual(
      expect.objectContaining({ key: expect.stringContaining('/shots/') as string }),
    );
  });

  it('reports failed clips, and refuses what cannot work', async () => {
    const failing = await withScene({ videoFailure: 'Blocked by the content filter.' });
    const shot = await failing.add({ description: 'The lamp turns.' });
    await failing.run('movie.shot.clip.generate', failing.at(shot.id));
    await failing.run('movie.shot.clip.check', failing.at(shot.id));
    expect(await failing.run('movie.shot.clip.check', failing.at(shot.id))).toMatchObject({
      clip: { status: 'failed', error: 'Blocked by the content filter.', blobKey: null },
    });

    const refused = await withScene({
      videoError: new ProviderError('bad_request', 'fake', 'duration must be one of 4, 6, 8'),
    });
    const { registry, projectId, scene, at, add } = refused;
    const described = await add({ description: 'The lamp turns.' });
    const empty = await add();
    const input = (shotId: string) => ({ projectId, ...at(shotId) });
    const generate = (shotId: string, extra: Record<string, unknown> = {}, actor = user) =>
      registry.executeById('movie.shot.clip.generate', { ...input(shotId), ...extra }, { actor });
    await expect(generate(described.id)).rejects.toMatchObject({
      message: 'No clip was started: duration must be one of 4, 6, 8',
    });
    await expect(generate(empty.id)).rejects.toThrow(/Describe what the shot shows/);
    await expect(generate('nobody')).rejects.toThrow(/No shot "nobody"/);
    await registry.executeById('settings.set', { key: 'video.model', value: '' }, { actor: user });
    await expect(generate(described.id)).rejects.toThrow(/No video model is chosen/);
    await expect(
      registry.executeById('movie.shot.clip.check', input(described.id), { actor: user }),
    ).rejects.toThrow(/has no clip/);
    await expect(
      registry.executeById('movie.shot.create', { projectId, sceneId: 'nowhere' }, { actor: user }),
    ).rejects.toThrow(/No scene "nowhere"/);
    expect(
      (
        await registry.executeById(
          'movie.shot.clip.generate',
          { ...input(described.id), model: 'vendor/clips' },
          { actor: { kind: 'agent', id: 'c', role: 'clip-designer' } },
        )
      ).status,
    ).toBe('needs-approval');
    expect(scene.id).toBeTruthy();
  });
});

describe('sounds', () => {
  interface Made {
    sound: { take: { blobKey: string; prompt: string; model: string; mediaType: string } };
    costUsd: number | null;
  }
  const withScene = async (options: Parameters<typeof setup>[0] = {}) => {
    const context = await setup(options);
    const scene = await context.run('movie.scene.create', { heading: 'EXT. GALLERY - NIGHT' });
    for (const [key, value] of [
      ['sounds.model', 'vendor/noises'],
      ['music.model', 'vendor/composer'],
    ]) {
      await context.registry.executeById('settings.set', { key, value }, { actor: user });
    }
    const at = (soundId: string) => ({ sceneId: scene.id, soundId });
    const add = (fields: Record<string, unknown>) =>
      context.run('movie.sound.create', { sceneId: scene.id, ...fields });
    const takes = async () =>
      (await context.runtime.blobs.list('')).filter((key) => key.includes('/take/')).length;
    return { ...context, scene, at, add, takes };
  };

  it('keeps music instrumental unless a voice is asked for', () => {
    expect(soundPrompt({ kind: 'effect', description: ' A door slams. ' })).toBe('A door slams.');
    expect(soundPrompt({ kind: 'music', description: 'Low strings.' })).toBe(
      'Low strings.\nInstrumental, no vocals.',
    );
    expect(soundPrompt({ kind: 'music', description: 'A choir, far off.' })).toBe(
      'A choir, far off.',
    );
  });

  it('adds, lists in the order added, changes and deletes', async () => {
    const { run, scene, at, add } = await withScene();
    const wind = await add({ kind: 'effect', name: 'Wind', description: 'A gale at sea.' });
    const theme = await add({ kind: 'music', description: 'Low strings.' });
    expect(theme).toMatchObject({ kind: 'music', name: '', take: null });
    expect(await run('movie.sound.update', { ...at(theme.id), name: 'Storm theme' })).toMatchObject(
      { name: 'Storm theme', description: 'Low strings.' },
    );
    expect(
      await run('movie.sound.update', { ...at(wind.id), description: 'A howling gale.' }),
    ).toMatchObject({ name: 'Wind', description: 'A howling gale.' });
    const listed = (await run('movie.sound.list', {
      sceneId: scene.id,
    })) as unknown as {
      sounds: { name: string }[];
    };
    expect(listed.sounds.map((sound) => sound.name)).toEqual(['Wind', 'Storm theme']);
    expect(await run('movie.sound.delete', at(wind.id))).toEqual({ soundId: wind.id });
    await expect(run('movie.sound.delete', at(wind.id))).rejects.toThrow(/No sound/);
  });

  it('places a sound and changes its pan, gain and fade curve', async () => {
    const { run, scene, add } = await withScene();
    const wind = await add({ kind: 'effect', name: 'Wind', description: 'A gale at sea.' });
    const placed = (await run('movie.edit.sound.place', {
      sceneId: scene.id,
      soundId: wind.id,
    })) as unknown as { id: string };
    expect(
      await run('movie.edit.sound.update', {
        sceneId: scene.id,
        placementId: placed.id,
        pan: -0.5,
        gainDb: -6,
        fadeCurve: 'smooth',
      }),
    ).toMatchObject({ pan: -0.5, gainDb: -6, fadeCurve: 'smooth' });
    await expect(
      run('movie.edit.sound.update', { sceneId: scene.id, placementId: placed.id, pan: 2 }),
    ).rejects.toThrow();
  });

  it('makes effects and music with their own models, and replaces what was made', async () => {
    const { run, runtime, provider, at, add, takes } = await withScene();
    const wind = await add({ kind: 'effect', description: 'A gale at sea.' });
    const theme = await add({ kind: 'music', description: 'Low strings.' });
    const first = (await run('movie.sound.generate', at(wind.id))) as unknown as Made;
    expect(first).toMatchObject({
      costUsd: null,
      sound: {
        take: { prompt: 'A gale at sea.', model: 'vendor/noises', mediaType: 'audio/mpeg' },
      },
    });
    expect(await runtime.blobs.get(first.sound.take.blobKey)).toBeDefined();
    const second = (await run('movie.sound.generate', {
      ...at(wind.id),
      model: 'vendor/other',
    })) as unknown as Made;
    expect(second.sound.take.model).toBe('vendor/other');
    expect(await runtime.blobs.get(first.sound.take.blobKey)).toBeUndefined();
    expect(await run('movie.sound.generate', at(theme.id))).toMatchObject({ costUsd: 0.04 });
    expect(provider.soundRequests).toEqual([
      { model: 'vendor/noises', kind: 'effect', prompt: 'A gale at sea.' },
      { model: 'vendor/other', kind: 'effect', prompt: 'A gale at sea.' },
      { model: 'vendor/composer', kind: 'music', prompt: 'Low strings.\nInstrumental, no vocals.' },
    ]);
    expect(await takes()).toBe(2);
    const library = (await run('movie.sound.library', {})) as unknown as {
      sounds: { label: string; kind: string }[];
    };
    expect(library.sounds.map((sound) => [sound.kind, sound.label])).toEqual([
      ['effect', 'Sound effect'],
      ['music', 'Music'],
    ]);
  });

  it('removes the files with the sound and with the scene', async () => {
    const { run, runtime, scene, at, add, takes } = await withScene();
    const wind = await add({ kind: 'effect', description: 'A gale at sea.' });
    const door = await add({ kind: 'effect', description: 'A door slams.' });
    await run('movie.sound.generate', at(wind.id));
    await run('movie.sound.generate', at(door.id));
    await run('movie.sound.delete', at(wind.id));
    expect(await takes()).toBe(1);
    await run('movie.scene.delete', { sceneId: scene.id });
    expect(await takes()).toBe(0);
    expect(await runtime.store.list('projects/')).not.toContainEqual(
      expect.objectContaining({ key: expect.stringContaining('/sounds/') as string }),
    );
  });

  it('needs a model, asks before an agent spends, and reports failures in words', async () => {
    const { registry, projectId, at, add } = await withScene({
      soundError: new ProviderError('unavailable', 'fake', 'The model is busy.'),
    });
    const wind = await add({ kind: 'effect', description: 'A gale at sea.' });
    const theme = await add({ kind: 'music', description: 'Low strings.' });
    const generate = (soundId: string, actor: typeof user | typeof writer = user) =>
      registry.executeById('movie.sound.generate', { projectId, ...at(soundId) }, { actor });
    await expect(generate(wind.id)).rejects.toMatchObject({
      message: 'No sound was made: The model is busy.',
    });
    expect((await generate(wind.id, writer)).status).toBe('needs-approval');
    for (const key of ['sounds.model', 'music.model']) {
      await registry.executeById('settings.set', { key, value: '' }, { actor: user });
    }
    await expect(generate(wind.id)).rejects.toThrow(/No model for sound effects is chosen/);
    const blank = await add({ kind: 'effect' });
    await expect(generate(blank.id)).rejects.toThrow(/Describe what is heard first/);
    await expect(generate(theme.id)).rejects.toThrow(/No music model is chosen/);
    await expect(
      registry.executeById(
        'movie.sound.create',
        { projectId, sceneId: 'nowhere', kind: 'effect', description: 'x' },
        { actor: user },
      ),
    ).rejects.toThrow(/No scene "nowhere"/);
  });

  it('keeps nothing when the sound is deleted while it is made', async () => {
    const runtime = createTestRuntime();
    const fake = createFakeProvider({});
    const ids: { projectId: string; sceneId: string; soundId: string }[] = [];
    const registry: CommandRegistry = new CommandRegistry({ runtime }).register(
      ...projectCommands,
      ...createMovieMode({
        provider: {
          ...fake,
          generateSound: async (request) => {
            await registry.executeById('movie.sound.delete', ids[0], { actor: user });
            return fake.generateSound(request);
          },
        },
      }).commands,
    );
    const output = async (id: string, input: unknown) => {
      const result = await registry.executeById(id, input, { actor: user });
      if (result.status !== 'ok') throw new Error(result.status);
      return result.output as { id: string };
    };
    const project = await output('project.create', { name: 'Storm', mode: 'movie' });
    const scene = await output('movie.scene.create', { projectId: project.id, heading: 'X' });
    const sound = await output('movie.sound.create', {
      projectId: project.id,
      sceneId: scene.id,
      kind: 'effect',
      description: 'A gale.',
    });
    ids.push({ projectId: project.id, sceneId: scene.id, soundId: sound.id });
    await expect(
      registry.executeById(
        'movie.sound.generate',
        { ...ids[0], model: 'vendor/noises' },
        {
          actor: user,
        },
      ),
    ).rejects.toThrow(/deleted while it was made/);
    expect(await runtime.blobs.list('')).toEqual([]);
  });
});

describe('locations and objects in scenes and shots', () => {
  // The browser host re-encodes pictures as JPEG; here a stand-in relabels them.
  const toJpeg: FrameImageEncoder = (image) =>
    Promise.resolve({ ...image, mediaType: 'image/jpeg' });
  const withWorld = async (
    options: Parameters<typeof setup>[0] = {},
    frameImage: FrameImageEncoder | null = toJpeg,
  ) => {
    const context = await setup(options, frameImage ?? undefined);
    const { run, registry } = context;
    for (const [key, value] of [
      ['video.model', 'vendor/clips'],
      ['images.model', 'vendor/painter'],
    ]) {
      await registry.executeById('settings.set', { key, value }, { actor: user });
    }
    const lamp = await run('world.location.create', {
      name: 'Lamp room',
      look: 'Round iron room under a glass dome.',
    });
    const night = await run('world.location.state.add', {
      locationId: lamp.id,
      name: 'Night',
      description: 'Only the lamp lights the room.',
    });
    const stairs = await run('world.location.view.add', {
      locationId: lamp.id,
      name: 'From the stairs',
      description: 'Low, looking up at the lamp.',
    });
    const watch = await run('world.object.create', { name: 'Pocket watch', look: 'Brass.' });
    const cracked = await run('world.object.state.add', { objectId: watch.id, name: 'Cracked' });
    const scene = await run('movie.scene.create', {
      heading: 'INT. LAMP ROOM - NIGHT',
      locationId: lamp.id,
      locationStateId: night.id,
    });
    return { ...context, lamp, night, stairs, watch, cracked, scene };
  };

  it('links a scene to a location and a state, and refuses ones that do not exist', async () => {
    const { run, lamp, night, scene } = await withWorld();
    expect(scene).toMatchObject({ locationId: lamp.id, locationStateId: night.id });
    await expect(
      run('movie.scene.create', { heading: 'X', locationId: 'nowhere' }),
    ).rejects.toThrow(/No location "nowhere"/);
    await expect(
      run('movie.scene.update', { sceneId: scene.id, locationStateId: 'gone' }),
    ).rejects.toThrow(/no state "gone"/);
    await expect(
      run('movie.scene.create', { heading: 'X', locationStateId: night.id }),
    ).rejects.toThrow(/A state needs a location/);
    // A new location resets the state; keeping the location keeps it.
    const cove = await run('world.location.create', { name: 'Cove' });
    expect(await run('movie.scene.update', { sceneId: scene.id, summary: 'S' })).toMatchObject({
      locationStateId: night.id,
    });
    expect(
      await run('movie.scene.update', { sceneId: scene.id, locationId: cove.id }),
    ).toMatchObject({ locationId: cove.id, locationStateId: null });
    expect(await run('movie.scene.update', { sceneId: scene.id, locationId: null })).toMatchObject({
      locationId: null,
    });
  });

  it('films a shot from a view of the location with objects, and checks them', async () => {
    const { run, scene, stairs, watch, cracked, lamp } = await withWorld();
    const shot = await run('movie.shot.create', {
      sceneId: scene.id,
      description: 'Mara climbs into the light.',
      viewId: stairs.id,
      objects: [{ objectId: watch.id, stateId: cracked.id }],
    });
    expect(shot).toMatchObject({ viewId: stairs.id, objects: [{ objectId: watch.id }] });
    const at = { sceneId: scene.id, shotId: shot.id };
    await expect(run('movie.shot.update', { ...at, viewId: 'gone' })).rejects.toThrow(
      /no view "gone"/,
    );
    await expect(
      run('movie.shot.update', { ...at, objects: [{ objectId: 'gone' }] }),
    ).rejects.toThrow(/No object "gone"/);
    await expect(
      run('movie.shot.update', { ...at, objects: [{ objectId: watch.id, stateId: 'gone' }] }),
    ).rejects.toThrow(/no state "gone"/);
    const elsewhere = await run('movie.scene.create', { heading: 'EXT. SEA' });
    await expect(
      run('movie.shot.create', { sceneId: elsewhere.id, viewId: stairs.id }),
    ).rejects.toThrow(/A view needs a location/);
    const cove = await run('world.location.create', { name: 'Cove' });
    // The shot may name a place of its own; then the scene's state does not apply.
    const moved = Shot.parse(
      await run('movie.shot.update', { ...at, locationId: cove.id, viewId: null }),
    );
    expect(moved.locationId).toBe(cove.id);
    expect(
      await run('movie.shot.update', { ...at, locationId: lamp.id, viewId: stairs.id }),
    ).toMatchObject({ locationId: lamp.id });
  });

  it('describes the place, the view, the state and the objects to the video model', async () => {
    const { run, runtime, projectId, scene, stairs, watch, cracked } = await withWorld();
    const shot = Shot.parse(
      await run('movie.shot.create', {
        sceneId: scene.id,
        description: 'Mara climbs into the light.',
        viewId: stairs.id,
        objects: [{ objectId: watch.id, stateId: cracked.id }],
      }),
    );
    const setting = await readSetting(runtime.store, projectId, shot);
    expect(clipPrompt(shot, [], '', false, setting)).toBe(
      [
        'Mara climbs into the light.',
        'Location: Lamp room, seen from "From the stairs": Low, looking up at the lamp. Round iron room under a glass dome. Night: Only the lamp lights the room.',
        'Pocket watch: Brass (Cracked)',
        'Nobody speaks.',
      ].join('\n'),
    );
    // What was deleted from the world is left out.
    await run('world.object.delete', { objectId: watch.id });
    expect((await readSetting(runtime.store, projectId, shot)).objects).toEqual([]);
  });

  it('guides the clip with the portraits, the view of the place and the objects', async () => {
    const { run, provider, scene, stairs, watch, lamp } = await withWorld();
    const mara = await run('movie.character.create', { name: 'Mara' });
    await run('movie.character.image.generate', { characterId: mara.id });
    await run('world.location.image.generate', { locationId: lamp.id });
    await run('world.location.image.generate', { locationId: lamp.id, viewId: stairs.id });
    await run('world.object.image.generate', { objectId: watch.id });
    const shot = await run('movie.shot.create', {
      sceneId: scene.id,
      description: 'Mara climbs into the light.',
      characterIds: [mara.id],
      viewId: stairs.id,
      objects: [{ objectId: watch.id }],
    });
    const started = (await run('movie.shot.clip.generate', {
      sceneId: scene.id,
      shotId: shot.id,
    })) as unknown as { clip: { portraits: number; guides: string[] } };
    expect(started.clip).toMatchObject({
      portraits: 1,
      guides: ['Mara', 'Lamp room · From the stairs', 'Pocket watch'],
    });
    expect(provider.videoRequests[0]?.references).toHaveLength(3);
    expect(MAX_CLIP_GUIDES).toBe(4);
  });

  it('says no guides were used when the model refuses them', async () => {
    const { run, scene, lamp } = await withWorld({ videoRefusesReferences: true });
    await run('world.location.image.generate', { locationId: lamp.id });
    const shot = await run('movie.shot.create', { sceneId: scene.id, description: 'The lamp.' });
    const started = (await run('movie.shot.clip.generate', {
      sceneId: scene.id,
      shotId: shot.id,
    })) as unknown as { clip: { portraits: number; guides: string[] } };
    expect(started.clip).toMatchObject({ portraits: 0, guides: [] });
  });

  it('paints a key frame from the place, the portraits and the objects, and starts the clip on it', async () => {
    const { run, provider, runtime, scene, stairs, watch, lamp } = await withWorld();
    const mara = await run('movie.character.create', { name: 'Mara', appearance: 'Grey braid.' });
    await run('movie.character.image.generate', { characterId: mara.id });
    await run('world.location.image.generate', { locationId: lamp.id, viewId: stairs.id });
    await run('world.object.image.generate', { objectId: watch.id });
    const shot = await run('movie.shot.create', {
      sceneId: scene.id,
      description: 'Mara climbs into the light',
      performance: 'She pulls herself up the last step',
      characterIds: [mara.id],
      viewId: stairs.id,
      objects: [{ objectId: watch.id }],
      line: 'Who is there?',
    });
    const at = { sceneId: scene.id, shotId: shot.id };
    const before = provider.imageRequests.length;
    const painted = (await run('movie.shot.frame.generate', at)) as unknown as {
      frame: { id: string; guides: string[]; blobKey: string; prompt: string };
    };
    expect(painted.frame.guides).toEqual([
      'Lamp room · From the stairs (the place)',
      'Mara',
      'Pocket watch',
    ]);
    const request = provider.imageRequests[before];
    expect(request?.references).toHaveLength(3);
    expect(request?.aspectRatio).toBe('16:9');
    expect(request?.prompt).toContain('The first frame of a film shot');
    expect(request?.prompt).toContain('Mara: Grey braid.');
    expect(request?.prompt).toContain(
      'The moment it opens on: She pulls herself up the last step.',
    );
    expect(request?.prompt).not.toContain('Who is there');
    // Kept as JPEG, which video models take as a start frame where they refuse WebP.
    expect((await runtime.blobs.get(painted.frame.blobKey))?.mediaType).toBe('image/jpeg');
    const second = (await run('movie.shot.frame.generate', {
      ...at,
      direction: 'closer',
    })) as unknown as { frame: { id: string } };
    expect(provider.imageRequests[before + 1]?.prompt).toContain('closer.');
    // The first frame stays chosen until another is picked.
    expect(Shot.parse(await run('movie.shot.get', at)).frameId).toBe(painted.frame.id);

    const started = (await run('movie.shot.clip.generate', at)) as unknown as {
      clip: { startFrameId: string | null; portraits: number; guides: string[] };
    };
    expect(started.clip).toMatchObject({ startFrameId: painted.frame.id, portraits: 0 });
    expect(started.clip.guides).toHaveLength(3);
    const video = provider.videoRequests.at(-1);
    expect(video?.firstFrame?.mediaType).toBe('image/jpeg');
    expect(video?.references).toBeUndefined();

    await run('movie.shot.frame.select', { ...at, frameId: second.frame.id });
    await run('movie.shot.frame.delete', { ...at, frameId: second.frame.id });
    expect(Shot.parse(await run('movie.shot.get', at)).frameId).toBe(painted.frame.id);
    await run('movie.shot.frame.select', { ...at, frameId: null });
    const fromWords = (await run('movie.shot.clip.generate', at)) as unknown as {
      clip: { startFrameId: string | null; portraits: number };
    };
    expect(fromWords.clip).toMatchObject({ startFrameId: null, portraits: 1 });
    await expect(run('movie.shot.frame.select', { ...at, frameId: 'gone' })).rejects.toThrow(
      /No key frame/,
    );
    await expect(run('movie.shot.frame.delete', { ...at, frameId: 'gone' })).rejects.toThrow(
      /No key frame/,
    );
    await run('movie.shot.frame.delete', { ...at, frameId: painted.frame.id });
    expect(Shot.parse(await run('movie.shot.get', at))).toMatchObject({
      frames: [],
      frameId: null,
    });
  });

  it('falls back from the key frame to guides when the model takes no start picture', async () => {
    const { run, provider, scene, lamp } = await withWorld({
      videoRefusesFirstFrame: true,
      imageRefusesReferences: true,
    });
    await run('world.location.image.generate', { locationId: lamp.id });
    const shot = await run('movie.shot.create', { sceneId: scene.id, description: 'The lamp.' });
    const at = { sceneId: scene.id, shotId: shot.id };
    const painted = (await run('movie.shot.frame.generate', at)) as unknown as {
      frame: { guides: string[]; prompt: string };
    };
    // The image model took no references, so the frame was painted from the words.
    expect(painted.frame.guides).toEqual([]);
    expect(painted.frame.prompt).not.toContain('reference images');
    const started = (await run('movie.shot.clip.generate', at)) as unknown as {
      clip: { startFrameId: string | null; guides: string[] };
    };
    expect(started.clip).toMatchObject({
      startFrameId: null,
      guides: ['Lamp room · Establishing'],
    });
    expect(provider.videoRequests.at(-1)?.references).toHaveLength(1);
  });

  it('uses a frame the host cannot re-encode as a guide, not as the start', async () => {
    const { run, provider, runtime, scene } = await withWorld({}, null);
    const shot = await run('movie.shot.create', { sceneId: scene.id, description: 'The lamp.' });
    const at = { sceneId: scene.id, shotId: shot.id };
    const painted = (await run('movie.shot.frame.generate', at)) as unknown as {
      frame: { blobKey: string; mediaType: string };
    };
    expect(painted.frame.mediaType).toBe('image/webp');
    expect((await runtime.blobs.get(painted.frame.blobKey))?.mediaType).toBe('image/webp');
    const started = (await run('movie.shot.clip.generate', at)) as unknown as {
      clip: { startFrameId: string | null };
    };
    expect(started.clip.startFrameId).toBeNull();
    expect(provider.videoRequests.at(-1)?.firstFrame).toBeUndefined();
  });

  it('turns a picture into a start frame only as JPEG or PNG', async () => {
    const webp = { bytes: new Uint8Array([1]), mediaType: 'image/webp' };
    const png = { bytes: new Uint8Array([2]), mediaType: 'image/png' };
    expect(await asStartFrame(png, undefined)).toBe(png);
    expect(await asStartFrame(webp, undefined)).toBeUndefined();
    expect(await asStartFrame(webp, () => Promise.resolve(undefined))).toBeUndefined();
    expect(await asStartFrame(webp, () => Promise.resolve(webp))).toBeUndefined();
    expect(
      await asStartFrame(webp, () => Promise.reject(new Error('cannot decode'))),
    ).toBeUndefined();
    expect((await asStartFrame(webp, () => Promise.resolve(png)))?.mediaType).toBe('image/png');
  });

  it('refuses to paint a frame without a description or an image model', async () => {
    const { run, registry, scene } = await withWorld();
    const empty = await run('movie.shot.create', { sceneId: scene.id });
    await expect(
      run('movie.shot.frame.generate', { sceneId: scene.id, shotId: empty.id }),
    ).rejects.toThrow(/Describe what the shot shows/);
    const shot = await run('movie.shot.create', { sceneId: scene.id, description: 'X' });
    await registry.executeById('settings.set', { key: 'images.model', value: '' }, { actor: user });
    await expect(
      run('movie.shot.frame.generate', { sceneId: scene.id, shotId: shot.id }),
    ).rejects.toThrow(/No image model/);
  });

  it('reports a failed painting', async () => {
    const { run, scene } = await withWorld({
      imageError: new ProviderError('unavailable', 'fake', 'Down.'),
    });
    const shot = await run('movie.shot.create', { sceneId: scene.id, description: 'X' });
    await expect(
      run('movie.shot.frame.generate', { sceneId: scene.id, shotId: shot.id }),
    ).rejects.toThrow(/No frame was painted: Down/);
  });

  it('draws the world in the tone of the film', async () => {
    const { runtime, projectId } = await setup();
    const mode = createMovieMode({ provider: createFakeProvider({}) });
    expect(await mode.visualStyle?.(runtime.store, projectId)).toBe('');
    await runtime.store.batch([
      {
        type: 'put',
        key: `projects/${projectId}/movie/development`,
        value: { logline: '', premise: '', tone: 'Cold sea light.', treatment: '' },
      },
    ]);
    expect(await mode.visualStyle?.(runtime.store, projectId)).toBe('Cold sea light.');
  });
});
