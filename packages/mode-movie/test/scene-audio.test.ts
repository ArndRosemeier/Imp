import { createAudioCommands, createDefaultAudioCodec, encodeWav } from '@imp/audio';
import { CommandRegistry, projectCommands } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { createFakeProvider } from '@imp/providers/testing';
import { describe, expect, it } from 'vitest';
import { createMovieMode, createSceneAudioLink, SceneCut } from '../src/index.js';

const user = { kind: 'user', id: 'arnd' } as const;
const agent = { kind: 'agent', id: 'se', role: 'sound-editor' } as const;

const tone = (seconds: number, level: number) =>
  encodeWav(
    {
      sampleRate: 48000,
      channels: [
        Float32Array.from(
          { length: Math.round(48000 * seconds) },
          (_, i) => level * Math.sin(i / 9),
        ),
      ],
    },
    'float32',
  );

interface Region {
  id: string;
  label: string;
  startSeconds: number;
  endSeconds: number;
  volume: number;
}
interface Outline {
  id: string;
  name: string;
  link: { kind: string; target: string } | null;
  tracks: { id: string; name: string; regions: Region[] }[];
}

async function setup() {
  const runtime = createTestRuntime();
  const registry = new CommandRegistry({ runtime }).register(
    ...projectCommands,
    ...createMovieMode({ provider: createFakeProvider({}) }).commands,
    ...createAudioCommands({
      codec: createDefaultAudioCodec(),
      links: [createSceneAudioLink()],
    }),
  );
  const run = async (
    id: string,
    input: Record<string, unknown>,
    actor: typeof user | typeof agent = user,
  ): Promise<Record<string, unknown>> => {
    const result = await registry.executeById(id, input, { actor });
    if (result.status !== 'ok') throw new Error(`${id}: ${result.status}`);
    return result.output as Record<string, unknown>;
  };
  const project = (await run('project.create', { name: 'Lighthouse', mode: 'movie' })) as {
    id: string;
  };
  const projectId = project.id;
  const scene = (await run('movie.scene.create', {
    projectId,
    heading: 'INT. LAMP ROOM - NIGHT',
  })) as { id: string };
  const sceneId = scene.id;
  const base = `projects/${projectId}/movie/`;
  const now = new Date(0).toISOString();
  const wav = 'audio/wav';
  await runtime.blobs.put('take/wind', { bytes: tone(2, 0.2), mediaType: wav });
  await runtime.blobs.put('take/theme', { bytes: tone(6, 0.1), mediaType: wav });
  await runtime.blobs.put('take/line', { bytes: tone(3, 0.5), mediaType: wav });
  await runtime.blobs.put('elsewhere/hum', { bytes: tone(1, 0.1), mediaType: wav });
  await runtime.blobs.put('clip/two', { bytes: new Uint8Array([1, 2, 3]), mediaType: 'video/mp4' });
  const clip = (blobKey: string, silent: boolean) => ({
    status: 'ready',
    jobId: 'j',
    blobKey,
    mediaType: 'video/mp4',
    prompt: '',
    model: 'm',
    progress: null,
    error: null,
    durationSeconds: 4,
    silent,
    costUsd: null,
    createdAt: now,
  });
  const shot = (id: string, position: number, extra: Record<string, unknown>) => ({
    id,
    sceneId,
    position,
    description: 'The lamp turns.',
    characterIds: [],
    performance: '',
    speakerId: null,
    line: '',
    delivery: '',
    ...extra,
  });
  const sound = (id: string, kind: string, name: string, blobKey: string) => ({
    id,
    sceneId,
    kind,
    name,
    description: name,
    take: { blobKey, mediaType: wav, prompt: name, model: 'm', costUsd: null, createdAt: now },
    createdAt: now,
  });
  await runtime.store.batch(
    [
      {
        key: `${base}shots/${sceneId}/one`,
        value: shot('one', 1, {
          speakerId: 'mara',
          line: 'Keep the light burning.',
          clip: clip('clip/one', true),
          dialogue: {
            blobKey: 'take/line',
            mediaType: wav,
            line: 'Keep the light burning.',
            direction: '',
            model: 'm',
            durationSeconds: 3,
            costUsd: null,
            createdAt: now,
          },
        }),
      },
      {
        key: `${base}shots/${sceneId}/two`,
        value: shot('two', 2, { clip: clip('clip/two', false) }),
      },
      { key: `${base}sounds/${sceneId}/wind`, value: sound('wind', 'effect', 'Wind', 'take/wind') },
      { key: `${base}sounds/${sceneId}/theme`, value: sound('theme', 'music', '', 'take/theme') },
    ].map((entry) => ({ type: 'put' as const, key: entry.key, value: entry.value })),
  );
  await run('movie.edit.sound.place', { projectId, sceneId, soundId: 'wind', startSeconds: 1 });
  await run('movie.edit.sound.place', {
    projectId,
    sceneId,
    soundId: 'theme',
    startSeconds: 0,
    loop: true,
    volume: 0.4,
  });
  const cut = async () => SceneCut.parse(await runtime.store.get(`${base}edit/${sceneId}`));
  const open = async () =>
    (
      (await run('audio.doc.open', { projectId, kind: 'scene', target: sceneId })) as {
        document: Outline;
      }
    ).document;
  return { runtime, run, projectId, sceneId, cut, open };
}

const spans = (doc: Outline, trackId: string) =>
  doc.tracks
    .find((track) => track.id === trackId)
    ?.regions.map((region) => [region.startSeconds, region.endSeconds]);

describe("a scene's sound in the audio editor", () => {
  it('shows each kind of sound on its own track, at the times of the cut', async () => {
    const { open } = await setup();
    const doc = await open();
    expect(doc.name).toBe('Scene 1: INT. LAMP ROOM - NIGHT');
    expect(doc.link).toMatchObject({ kind: 'scene' });
    expect(doc.tracks.map((track) => track.name)).toEqual([
      'Dialogue',
      'Clip sound',
      'Effects',
      'Music',
    ]);
    // The line plays over the silent first clip; the second clip has its own sound.
    expect(spans(doc, 'dialogue')).toEqual([[0, 3]]);
    expect(spans(doc, 'clip')).toEqual([[4, 8]]);
    expect(spans(doc, 'effects')).toEqual([[1, 3]]);
    // Looping music lasts to the end of the scene.
    expect(spans(doc, 'music')).toEqual([[0, 8]]);
    expect(doc.tracks[0]?.regions[0]?.label).toBe('Shot 1: Keep the light burning.');
    expect(doc.tracks[3]?.regions[0]?.label).toBe('Music');
    expect((await open()).id).toBe(doc.id);
  });

  it('writes edits back into the cut, where the Edit stage undoes them too', async () => {
    const { run, projectId, sceneId, cut, open } = await setup();
    const doc = await open();
    const docId = doc.id;
    const wind = doc.tracks[2]?.regions[0]?.id ?? '';
    await run('audio.region.split', { projectId, docId, regionId: wind, atSeconds: 2 });
    expect((await cut()).sounds.filter((s) => s.soundId === 'wind')).toMatchObject([
      { startSeconds: 1, durationSeconds: 1 },
      { startSeconds: 2, trimStartSeconds: 1, durationSeconds: 1 },
    ]);
    // An untouched placement stays exactly as stored, still looping to the end.
    expect((await cut()).sounds.find((s) => s.soundId === 'theme')).toMatchObject({
      loop: true,
      durationSeconds: null,
    });
    expect(await run('audio.history.list', { projectId, docId })).toMatchObject({
      undo: [{ label: 'Change', actor: null }, {}, {}],
    });
    await run('movie.edit.undo', { projectId, sceneId });
    expect(spans(await open(), 'effects')).toEqual([[1, 3]]);
    await run('audio.history.redo', { projectId, docId });
    expect(spans(await open(), 'effects')).toEqual([
      [1, 2],
      [2, 3],
    ]);
    await run('audio.history.undo', { projectId, docId });
    expect(spans(await open(), 'effects')).toEqual([[1, 3]]);
  });

  it("changes the level of a shot's line in place, and takes it apart when it is moved", async () => {
    const { run, projectId, cut, open } = await setup();
    const doc = await open();
    const docId = doc.id;
    const line = doc.tracks[0]?.regions[0]?.id ?? '';
    await run('audio.region.update', { projectId, docId, regionId: line, volume: 0.5 });
    expect((await cut()).items?.[0]).toMatchObject({ dialogueVolume: 0.5 });
    expect((await open()).tracks[0]?.regions[0]).toMatchObject({ id: line, volume: 0.5 });

    // A J cut: the line starts before its picture would.
    await run('audio.region.update', { projectId, docId, regionId: line, startSeconds: 0.5 });
    const after = await cut();
    expect(after.items?.[0]).toMatchObject({ dialogueVolume: 0 });
    expect(after.sounds.find((s) => s.source === 'dialogue')).toMatchObject({
      shotId: 'one',
      startSeconds: 0.5,
      volume: 0.5,
      blobKey: '',
    });
    expect(spans(await open(), 'dialogue')).toEqual([[0.5, 3.5]]);

    // Removing the clip's own sound silences it on the picture.
    const clipSound = (await open()).tracks[1]?.regions[0]?.id ?? '';
    await run('audio.region.remove', { projectId, docId, regionId: clipSound });
    expect((await cut()).items?.[1]).toMatchObject({ clipAudioVolume: 0 });
  });

  it('takes in only sounds of the film, on tracks without levels of their own', async () => {
    const { run, projectId, cut, open } = await setup();
    const docId = (await open()).id;
    await run('audio.region.insert', {
      projectId,
      docId,
      trackId: 'effects',
      key: 'take/wind',
      startSeconds: 5,
    });
    expect((await cut()).sounds.find((s) => s.startSeconds === 5)).toMatchObject({
      source: 'sound',
      soundId: 'wind',
      startSeconds: 5,
    });
    await run('audio.region.insert', {
      projectId,
      docId,
      trackId: 'dialogue',
      key: 'take/line',
      startSeconds: 6,
    });
    expect((await cut()).sounds.find((s) => s.startSeconds === 6)).toMatchObject({
      source: 'dialogue',
      shotId: 'one',
    });
    await expect(
      run('audio.region.insert', {
        projectId,
        docId,
        trackId: 'music',
        key: 'elsewhere/hum',
        startSeconds: 0,
      }),
    ).rejects.toThrow(/plays only its own sounds/);
    await expect(
      run('audio.track.update', { projectId, docId, trackId: 'music', gainDb: -3 }),
    ).rejects.toThrow(/set gain, volume and pan on the regions/);
    await expect(run('audio.track.add', { projectId, docId, name: 'More' })).rejects.toThrow(
      /kinds of sound/,
    );
    // Listening only, so it stays with the document and is not a change to the cut.
    const muted = (await run('audio.track.update', {
      projectId,
      docId,
      trackId: 'music',
      mute: true,
    })) as { document: Outline & { tracks: { mute: boolean }[] } };
    expect(muted.document.tracks[3]?.mute).toBe(true);
  });

  it('gives a character with a lane of their own a track of their lines', async () => {
    const { runtime, run, projectId, sceneId, cut, open } = await setup();
    await runtime.blobs.put('take/narration', { bytes: tone(2, 0.3), mediaType: 'audio/wav' });
    const base = `projects/${projectId}/movie/`;
    const now = new Date(0).toISOString();
    const take = {
      blobKey: 'take/narration',
      mediaType: 'audio/wav',
      line: 'It was the last night.',
      direction: '',
      model: 'm',
      durationSeconds: 2,
      costUsd: null,
      createdAt: now,
    };
    const stored = await cut();
    await runtime.store.batch([
      {
        type: 'put',
        key: `${base}characters/narrator`,
        value: {
          id: 'narrator',
          name: 'Narrator',
          part: 'narrator',
          description: '',
          appearance: '',
          voice: 'Old and warm.',
          voiceOnly: true,
          ownLane: true,
        },
      },
      {
        type: 'put',
        key: `${base}edit/${sceneId}`,
        value: {
          ...stored,
          lines: [
            {
              id: 'l1',
              characterId: 'narrator',
              text: 'It was the last night.',
              take,
              startSeconds: 4,
            },
            { id: 'l2', characterId: 'narrator', text: 'Not yet recorded.' },
          ],
        },
      },
    ]);
    const doc = await open();
    const docId = doc.id;
    expect(doc.tracks.at(-1)).toMatchObject({ id: 'lane-narrator', name: 'Narrator' });
    expect(spans(doc, 'lane-narrator')).toEqual([[4, 6]]);
    await run('audio.region.update', {
      projectId,
      docId,
      regionId: 'line-l1',
      startSeconds: 5,
      trimStartSeconds: 0.5,
      durationSeconds: 1.5,
      fadeInSeconds: 0.2,
    });
    expect((await cut()).lines).toMatchObject([
      { id: 'l1', startSeconds: 5, trimStartSeconds: 0.5, fadeInSeconds: 0.2 },
      { id: 'l2' },
    ]);
    await expect(
      run('audio.region.split', { projectId, docId, regionId: 'line-l1', atSeconds: 6 }),
    ).rejects.toThrow(/plays to its end/);
    await run('audio.region.remove', { projectId, docId, regionId: 'line-l1' });
    expect((await cut()).lines.map((line) => line.id)).toEqual(['l2']);
  });

  it('mixes what it can decode and names what it cannot', async () => {
    const { run, projectId, open } = await setup();
    const docId = (await open()).id;
    const heard = await run('audio.listen', { projectId, docId, toSeconds: 5 }, agent);
    expect(heard).toMatchObject({ durationSeconds: 5, unheard: ['Shot 2 sound'] });
    await expect(
      run('audio.doc.open', { projectId, kind: 'podcast', target: 'x' }),
    ).rejects.toThrow(/cannot open "podcast"/);
    await expect(
      run('audio.doc.open', { projectId, kind: 'scene', target: 'nope' }),
    ).rejects.toThrow(/No scene/);
  });
});
