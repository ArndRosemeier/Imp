import { createDefaultAudioCodec, encodeWav } from '@imp/audio';
import { CommandRegistry, MemoryBlobStore, projectCommands } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { createFakeProvider } from '@imp/providers/testing';
import { describe, expect, it } from 'vitest';
import {
  createMovieMode,
  filmPartKey,
  PartWriter,
  type FilmExport,
  type FilmRenderer,
  type FilmRenderJob,
} from '../src/index.js';

const user = { kind: 'user', id: 'arnd' } as const;
const editor = { kind: 'agent', id: 'fe', role: 'film-editor' } as const;
const RATE = 48000;

/** A steady level on both channels, so that what the mix makes of it can be read back. */
const level = (seconds: number, value: number) =>
  encodeWav(
    {
      sampleRate: RATE,
      channels: [new Float32Array(Math.round(RATE * seconds)).fill(value)],
    },
    'float32',
  );

/**
 * A renderer that draws nothing: it keeps the plan, pulls the whole mix the
 * way a real one does (in blocks), and writes a file that ends by going back
 * to fill in its header, as an MP4 muxer does.
 */
function fakeRenderer(behaviour: 'render' | 'wait' | 'fail' = 'render') {
  const seen: { job?: FilmRenderJob; left: Float32Array; right: Float32Array } = {
    left: new Float32Array(0),
    right: new Float32Array(0),
  };
  let release: (() => void) | undefined;
  const renderer: FilmRenderer = {
    unavailable: () => null,
    render: async (job) => {
      seen.job = job;
      const frames = Math.round(job.plan.durationSeconds * RATE);
      seen.left = new Float32Array(frames);
      seen.right = new Float32Array(frames);
      await job.write(new Uint8Array([0, 0, 0, 0]), 0);
      for (let at = 0; at < frames; at += RATE / 2) {
        const count = Math.min(RATE / 2, frames - at);
        const [left, right] = await job.mix(at, count);
        seen.left.set(left, at);
        seen.right.set(right, at);
        await job.write(new Uint8Array(count / 1000).fill(7), 4 + at / 1000);
        job.progress(at / RATE);
      }
      if (behaviour === 'wait') {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (job.cancelled()) throw new Error('stopped');
      }
      if (behaviour === 'fail') throw new Error('The encoder gave up.');
      await job.write(new Uint8Array([9, 9, 9, 9]), 0);
      return {
        mediaType: 'video/mp4',
        extension: 'mp4',
        videoCodec: 'avc',
        audioCodec: 'aac',
        width: 1280,
        height: 720,
        fps: 24,
      };
    },
  };
  return {
    renderer,
    seen,
    release: () => release?.(),
    started: () => release !== undefined,
  };
}

async function setup(renderer?: FilmRenderer) {
  const runtime = createTestRuntime();
  const registry = new CommandRegistry({ runtime }).register(
    ...projectCommands,
    ...createMovieMode({
      provider: createFakeProvider({}),
      film: {
        codec: createDefaultAudioCodec(),
        ...(renderer === undefined ? {} : { renderer }),
      },
    }).commands,
  );
  const run = async (
    id: string,
    input: Record<string, unknown>,
    actor: typeof user | typeof editor = user,
  ): Promise<Record<string, unknown>> => {
    const result = await registry.executeById(id, input, { actor });
    if (result.status !== 'ok') throw new Error(`${id}: ${result.status}`);
    return result.output as Record<string, unknown>;
  };
  const projectId = (
    (await run('project.create', { name: 'The Lighthouse Keeper', mode: 'movie' })) as {
      id: string;
    }
  ).id;
  const base = `projects/${projectId}/movie/`;
  const now = new Date(0).toISOString();
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
  const shot = (sceneId: string, id: string, position: number, extra: Record<string, unknown>) => ({
    id,
    sceneId,
    position,
    description: `Shot ${id}`,
    characterIds: [],
    performance: '',
    speakerId: null,
    line: '',
    delivery: '',
    ...extra,
  });
  const scenes: string[] = [];
  for (const heading of ['EXT. CLIFF - DUSK', 'INT. LAMP ROOM - NIGHT']) {
    scenes.push(((await run('movie.scene.create', { projectId, heading })) as { id: string }).id);
  }
  const [first = '', second = ''] = scenes;
  await runtime.blobs.put('clip/a', { bytes: new Uint8Array([1]), mediaType: 'video/mp4' });
  await runtime.blobs.put('clip/b', { bytes: new Uint8Array([2]), mediaType: 'video/mp4' });
  await runtime.blobs.put('take/wind', { bytes: level(1, 0.5), mediaType: 'audio/wav' });
  await runtime.store.batch(
    [
      // Scene 1: a silent clip; scene 2: a clip whose own sound cannot be decoded here.
      {
        key: `${base}shots/${first}/a`,
        value: shot(first, 'a', 1, { clip: clip('clip/a', true) }),
      },
      {
        key: `${base}shots/${second}/b`,
        value: shot(second, 'b', 1, { clip: clip('clip/b', false) }),
      },
      { key: `${base}shots/${second}/c`, value: shot(second, 'c', 2, { clip: null }) },
      {
        key: `${base}sounds/${second}/wind`,
        value: {
          id: 'wind',
          sceneId: second,
          kind: 'effect',
          name: 'Wind',
          description: 'Wind',
          take: {
            blobKey: 'take/wind',
            mediaType: 'audio/wav',
            prompt: 'wind',
            model: 'm',
            costUsd: null,
            createdAt: now,
          },
          createdAt: now,
        },
      },
    ].map((entry) => ({ type: 'put' as const, ...entry })),
  );
  return { runtime, run, projectId, first, second };
}

const sample = (channel: Float32Array, seconds: number) => channel[Math.round(seconds * RATE)];

describe('exporting a film', () => {
  it('lays the scenes one after the other and mixes their sound as the audio editor does', async () => {
    const fake = fakeRenderer();
    const { runtime, run, projectId, first, second } = await setup(fake.renderer);
    await run('movie.edit.item.set', {
      projectId,
      sceneId: first,
      itemId: 'a',
      trimStartSeconds: 1,
      fadeInSeconds: 0.5,
      zoom: 1.2,
      focusX: 0.25,
    });
    await run('movie.edit.title.add', { projectId, sceneId: first, text: 'The End', seconds: 2 });
    await run('movie.edit.sound.place', {
      projectId,
      sceneId: second,
      soundId: 'wind',
      startSeconds: 1,
      volume: 0.5,
    });

    const film = (await run('movie.edit.export', { projectId }, editor)) as FilmExport;

    expect(fake.seen.job?.plan).toMatchObject({
      durationSeconds: 9,
      height: null,
      fps: null,
      pictures: [
        {
          kind: 'clip',
          blobKey: 'clip/a',
          startSeconds: 0,
          durationSeconds: 3,
          sourceStartSeconds: 1,
          fadeInSeconds: 0.5,
          timing: { sourceSeconds: 4, trimStartSeconds: 1, speed: 1, reverse: false },
          punch: { zoom: 1.2, zoomTo: null, focusX: 0.25, focusY: 0.5 },
        },
        { kind: 'title', text: 'The End', startSeconds: 3, durationSeconds: 2 },
        { kind: 'clip', blobKey: 'clip/b', startSeconds: 5, durationSeconds: 4 },
      ],
    });
    // The wind starts one second into scene 2 (at 6 s of the film) at half its level.
    expect(sample(fake.seen.left, 5.5)).toBe(0);
    expect(sample(fake.seen.left, 6.5)).toBeCloseTo(0.25);
    expect(sample(fake.seen.right, 6.5)).toBeCloseTo(0.25);
    expect(sample(fake.seen.left, 7.5)).toBe(0);
    expect(film).toMatchObject({
      status: 'ready',
      label: 'film',
      fileName: 'The-Lighthouse-Keeper-film.mp4',
      sceneIds: [first, second],
      durationSeconds: 9,
      progressSeconds: 9,
      videoCodec: 'avc',
      audioCodec: 'aac',
      width: 1280,
      by: 'film-editor',
      parts: 1,
      // Shot c has no clip yet, and the sound of clip b cannot be decoded in this host.
      notReady: [{ sceneId: second, index: 2, state: 'no_clip' }],
      unheard: ['Shot 1 sound'],
    });
    const file = await runtime.blobs.get(filmPartKey(projectId, film.id, 0));
    expect(film.sizeBytes).toBe(file?.bytes.length);
    expect([...(file?.bytes.slice(0, 5) ?? [])]).toEqual([9, 9, 9, 9, 7]);

    const listed = (await run('movie.edit.export.list', { projectId })) as {
      canRender: boolean;
      exports: FilmExport[];
    };
    expect(listed.canRender).toBe(true);
    expect(listed.exports.map((entry) => entry.id)).toEqual([film.id]);
  });

  it('plans dissolves, wipes and dips between the pictures', async () => {
    const fake = fakeRenderer();
    const { run, projectId, first } = await setup(fake.renderer);
    const card = (await run('movie.edit.title.add', {
      projectId,
      sceneId: first,
      text: 'Years later',
      seconds: 2,
    })) as { item: { id: string } };
    const set = async (fields: Record<string, unknown>) =>
      run('movie.edit.item.set', { projectId, sceneId: first, itemId: card.item.id, ...fields });
    await set({ transition: 'dissolve', transitionSeconds: 1.5 });
    await run('movie.edit.export', { projectId, sceneIds: [first] }, editor);
    // At most half of the two-second card: it starts one second before the clip ends.
    expect(fake.seen.job?.plan).toMatchObject({
      durationSeconds: 5,
      pictures: [
        { kind: 'clip', startSeconds: 0, durationSeconds: 4, dipOut: null },
        {
          kind: 'title',
          startSeconds: 3,
          durationSeconds: 2,
          transitionIn: { kind: 'dissolve', seconds: 1 },
          dipIn: null,
        },
      ],
    });

    await set({ transition: 'dip-white', transitionSeconds: 1 });
    await run('movie.edit.export', { projectId, sceneIds: [first] }, editor);
    const pictures = fake.seen.job?.plan.pictures ?? [];
    expect(fake.seen.job?.plan.durationSeconds).toBe(6);
    expect(pictures[0]).toMatchObject({ dipOut: { color: 'white', seconds: 0.5 } });
    expect(pictures[1]).toMatchObject({ startSeconds: 4, dipIn: { color: 'white', seconds: 0.5 } });
    expect(pictures[1]).not.toHaveProperty('transitionIn');
    expect(pictures[0]).not.toHaveProperty('matrix');

    // Graded, the clip carries the matrix of its grade and the film's look; a card keeps its colours.
    await run('movie.edit.look.set', { projectId, preset: 'warm' });
    await run('movie.edit.export', { projectId, sceneIds: [first] }, editor);
    const graded = fake.seen.job?.plan.pictures ?? [];
    expect(graded[0]).toHaveProperty('matrix');
    expect((graded[0] as { matrix?: number[] }).matrix).toHaveLength(20);
    expect(graded[1]).not.toHaveProperty('matrix');
  });

  it("plays a sound's effects as the audio editor does", async () => {
    const fake = fakeRenderer();
    const { runtime, run, projectId, second } = await setup(fake.renderer);
    await run('movie.edit.sound.place', {
      projectId,
      sceneId: second,
      soundId: 'wind',
      startSeconds: 0,
    });
    const key = `projects/${projectId}/movie/edit/${second}`;
    const cut = (await runtime.store.get(key)) as { sounds: Record<string, unknown>[] };
    await runtime.store.batch([
      {
        type: 'put',
        key,
        value: {
          ...cut,
          sounds: cut.sounds.map((placement) => ({
            ...placement,
            effects: [{ kind: 'limiter', ceilingDb: -12, releaseMs: 60 }],
          })),
        },
      },
    ]);
    await run('movie.edit.export', { projectId, sceneIds: [second] });
    // A 0.5 level held under -12 dB (0.25) by the limiter.
    expect(sample(fake.seen.left, 0.8)).toBeLessThan(0.27);
    expect(sample(fake.seen.left, 0.8)).toBeGreaterThan(0.2);
  });

  it('exports chosen scenes, at a chosen size and rate', async () => {
    const fake = fakeRenderer();
    const { run, projectId, second } = await setup(fake.renderer);
    const film = (await run('movie.edit.export', {
      projectId,
      sceneIds: [second],
      resolution: '1080p',
      fps: 25,
    })) as FilmExport;
    expect(film).toMatchObject({ label: 'scene-2', by: 'you', durationSeconds: 4 });
    expect(fake.seen.job?.plan).toMatchObject({ height: 1080, fps: 25 });
    const named = (await run('movie.edit.export', {
      projectId,
      sceneIds: [second],
      label: 'rough cut 2',
    })) as FilmExport;
    expect(named.fileName).toBe('The-Lighthouse-Keeper-rough-cut-2.mp4');
  });

  it('says why it cannot export where the host has no renderer, or there is nothing to export', async () => {
    const { run, projectId } = await setup();
    expect(await run('movie.edit.export.list', { projectId })).toMatchObject({
      canRender: false,
      reason: expect.stringMatching(/cannot render/) as unknown,
    });
    await expect(run('movie.edit.export', { projectId })).rejects.toThrow(/cannot render/);

    const fake = fakeRenderer();
    const empty = await setup(fake.renderer);
    const scene = (await empty.run('movie.scene.create', {
      projectId: empty.projectId,
      heading: 'EXT. SEA',
    })) as { id: string };
    await expect(
      empty.run('movie.edit.export', { projectId: empty.projectId, sceneIds: [scene.id] }),
    ).rejects.toThrow(/nothing in the cut/);
    await expect(
      empty.run('movie.edit.export', { projectId: empty.projectId, sceneIds: ['nope'] }),
    ).rejects.toThrow(/No scene/);
    await expect(
      empty.run('movie.edit.export', { projectId: empty.projectId, sceneIds: [] }),
    ).rejects.toThrow(/no scenes/);
  });

  it('renders one film at a time, and a cancelled one leaves nothing behind', async () => {
    const fake = fakeRenderer('wait');
    const { runtime, run, projectId } = await setup(fake.renderer);
    const pending = run('movie.edit.export', { projectId });
    await expect.poll(() => fake.started()).toBe(true);
    const listed = (await run('movie.edit.export.list', { projectId })) as {
      exports: FilmExport[];
    };
    const id = listed.exports[0]?.id ?? '';
    expect(listed.exports[0]?.status).toBe('rendering');
    await expect(run('movie.edit.export', { projectId })).rejects.toThrow(/being rendered/);
    await expect(run('movie.edit.export.delete', { projectId, exportId: id })).rejects.toThrow(
      /still rendering/,
    );

    expect(await run('movie.edit.export.cancel', { projectId, exportId: id })).toEqual({
      cancelled: true,
    });
    fake.release();
    await expect(pending).rejects.toThrow(/cancelled/);
    const after = (await run('movie.edit.export.list', { projectId })) as {
      exports: FilmExport[];
    };
    expect(after.exports[0]).toMatchObject({ status: 'cancelled', error: '' });
    expect(await runtime.blobs.list(`projects/${projectId}/movie/exports/`)).toEqual([]);
    expect(await run('movie.edit.export.cancel', { projectId, exportId: id })).toEqual({
      cancelled: false,
    });
  });

  it('keeps why a render failed, and reports one a reload interrupted', async () => {
    const fake = fakeRenderer('fail');
    const { runtime, run, projectId } = await setup(fake.renderer);
    await expect(run('movie.edit.export', { projectId })).rejects.toThrow(/encoder gave up/);
    const listed = (await run('movie.edit.export.list', { projectId })) as {
      exports: FilmExport[];
    };
    expect(listed.exports[0]).toMatchObject({ status: 'failed', error: 'The encoder gave up.' });
    expect(await runtime.blobs.list(`projects/${projectId}/movie/exports/`)).toEqual([]);

    const stale = { ...listed.exports[0], id: 'stale', status: 'rendering', error: '' };
    await runtime.store.batch([
      { type: 'put', key: `projects/${projectId}/movie/exports/stale`, value: stale },
    ]);
    const seen = (await run('movie.edit.export.list', { projectId })) as {
      exports: FilmExport[];
    };
    expect(seen.exports.find((entry) => entry.id === 'stale')).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/interrupted/) as unknown,
    });
  });

  it('gives every film a file name of its own', async () => {
    const fake = fakeRenderer();
    const { run, projectId } = await setup(fake.renderer);
    const first = (await run('movie.edit.export', { projectId })) as FilmExport;
    const second = (await run('movie.edit.export', { projectId })) as FilmExport;
    const third = (await run('movie.edit.export', { projectId })) as FilmExport;
    expect(first.fileName).toMatch(/-film\.mp4$/);
    expect(second.fileName).toBe(first.fileName.replace(/\.mp4$/, '-2.mp4'));
    expect(third.fileName).toBe(first.fileName.replace(/\.mp4$/, '-3.mp4'));
  });

  it('fails rather than calling an empty file a film', async () => {
    const empty: FilmRenderer = {
      unavailable: () => null,
      render: () =>
        Promise.resolve({
          mediaType: 'video/mp4',
          extension: 'mp4',
          videoCodec: 'avc',
          audioCodec: 'aac',
          width: 640,
          height: 360,
          fps: 24,
        }),
    };
    const { run, projectId } = await setup(empty);
    await expect(run('movie.edit.export', { projectId })).rejects.toThrow(/no film file/);
    const listed = (await run('movie.edit.export.list', { projectId })) as {
      exports: FilmExport[];
    };
    expect(listed.exports[0]?.status).toBe('failed');
  });

  it("says which scenes' proposed changes a film leaves out", async () => {
    const fake = fakeRenderer();
    const { run, projectId, first } = await setup(fake.renderer);
    await run(
      'movie.edit.title.add',
      { projectId, sceneId: first, text: 'Proposed', toIndex: 0 },
      editor,
    );
    const film = (await run('movie.edit.export', { projectId }, editor)) as FilmExport;
    expect(film.draftsLeftOut).toEqual([first]);
    expect(film.by).toBe(editor.role);
  });

  it('deletes a rendered film with its file', async () => {
    const fake = fakeRenderer();
    const { runtime, run, projectId } = await setup(fake.renderer);
    const film = (await run('movie.edit.export', { projectId })) as FilmExport;
    expect(await run('movie.edit.export.delete', { projectId, exportId: film.id })).toEqual({
      deleted: true,
    });
    expect(await runtime.blobs.list(`projects/${projectId}/movie/exports/`)).toEqual([]);
    expect(
      ((await run('movie.edit.export.list', { projectId })) as { exports: unknown[] }).exports,
    ).toEqual([]);
    await expect(run('movie.edit.export.delete', { projectId, exportId: film.id })).rejects.toThrow(
      /No rendered film/,
    );
  });
});

describe('a file written in parts', () => {
  it('splits writes across parts and goes back to change a stored part', async () => {
    const blobs = new MemoryBlobStore();
    const writer = new PartWriter(blobs, (index) => `film/part-${String(index)}`, 'video/mp4', 4);
    await writer.write(new Uint8Array([1, 2, 3]), 0);
    await writer.write(new Uint8Array([4, 5, 6, 7, 8, 9]), 3);
    // Parts 0 and 1 are complete and stored; this changes bytes in both.
    expect([...(await blobs.list('film/'))].sort()).toEqual(['film/part-0', 'film/part-1']);
    await writer.write(new Uint8Array([20, 30]), 3);
    expect(writer.size).toBe(9);
    expect(await writer.finish()).toEqual({ parts: 3, sizeBytes: 9 });
    const parts = await Promise.all(
      [0, 1, 2].map(async (index) => [
        ...((await blobs.get(`film/part-${String(index)}`))?.bytes ?? []),
      ]),
    );
    expect(parts).toEqual([[1, 2, 3, 20], [30, 6, 7, 8], [9]]);
  });
});
