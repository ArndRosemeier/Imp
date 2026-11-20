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
import { castingDirector, createMovieMode, screenwriter } from '../src/index.js';

const user = { kind: 'user', id: 'arnd' } as const;
const writer = { kind: 'agent', id: 'w', role: 'screenwriter' } as const;

async function setup(providerOptions: Parameters<typeof createFakeProvider>[0] = {}) {
  const runtime = createTestRuntime();
  const provider = createFakeProvider(providerOptions);
  const registry = new CommandRegistry({ runtime }).register(
    ...projectCommands,
    ...settingsCommands,
    ...createMovieMode({ provider }).commands,
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
    expect(movieMode.stages.map((stage) => stage.id)).toEqual(['development', 'script', 'casting']);
    expect(() => new RoleCatalog(movieMode.roles)).not.toThrow();
    const outside = projectCommands.filter((command: Command) =>
      isInScope(command, screenwriter.scope),
    );
    expect(outside.map((command) => command.id)).toEqual(['project.list']);
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
        { id: mara.id, name: 'Mara', part: 'protagonist', portraitId: null },
        { id: tomas.id, name: 'Tomas', part: '', portraitId: null },
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
      characters: [{ id: mara.id, name: 'Mara', part: 'protagonist', portraitId: null }],
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
