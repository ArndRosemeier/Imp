import { CommandRegistry, projectCommands, type Actor } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { describe, expect, it } from 'vitest';
import {
  copyRange,
  createAudioCommands,
  createDefaultAudioCodec,
  decodeWav,
  deleteRange,
  docDuration,
  encodeWav,
  insertSilence,
  pasteAt,
  regionEnd,
  silenceRange,
  SoundPlacement,
  splitRegion,
  withDuration,
  AudioDoc,
  SAMPLE_RATE,
} from '../src/index.js';

const region = (fields: Partial<SoundPlacement> = {}): SoundPlacement =>
  SoundPlacement.parse({
    id: 'r',
    source: 'file',
    blobKey: 'k',
    soundId: '',
    startSeconds: 1,
    durationSeconds: 4,
    volume: 1,
    fadeInSeconds: 0.5,
    fadeOutSeconds: 0.5,
    loop: false,
    ...fields,
  });

const ids = () => {
  let next = 0;
  return () => `n${String(++next)}`;
};

const spans = (regions: readonly SoundPlacement[]) =>
  regions.map((r) => [r.startSeconds, regionEnd(r), r.trimStartSeconds]);

describe('range edits', () => {
  it('splits a region into two that play the same sound', () => {
    const [left, right] = splitRegion(region({ trimStartSeconds: 2 }), 2.5, ids());
    expect(left).toMatchObject({
      id: 'r',
      startSeconds: 1,
      durationSeconds: 1.5,
      fadeInSeconds: 0.5,
      fadeOutSeconds: 0,
    });
    expect(right).toMatchObject({
      id: 'n1',
      startSeconds: 2.5,
      trimStartSeconds: 3.5,
      durationSeconds: 2.5,
      fadeInSeconds: 0,
    });
    expect(splitRegion(region(), 1, ids())).toHaveLength(1);
    expect(splitRegion(region(), 9, ids())).toHaveLength(1);
  });

  it('silences a range and leaves the rest in place', () => {
    expect(spans(silenceRange([region()], 2, 3, ids()))).toEqual([
      [1, 2, 0],
      [3, 5, 2],
    ]);
    expect(spans(silenceRange([region()], 0, 10, ids()))).toEqual([]);
    expect(spans(silenceRange([region()], 6, 7, ids()))).toEqual([[1, 5, 0]]);
  });

  it('deletes a range and closes the gap', () => {
    const later = region({ id: 'b', startSeconds: 6, durationSeconds: 1 });
    expect(spans(deleteRange([region(), later], 2, 3, ids()))).toEqual([
      [1, 2, 0],
      [2, 4, 2],
      [5, 6, 0],
    ]);
  });

  it('inserts silence, splitting what spans the point', () => {
    expect(spans(insertSilence([region()], 3, 2, ids()))).toEqual([
      [1, 3, 0],
      [5, 7, 2],
    ]);
  });

  it('copies a range from 0 and pastes it back as it was', () => {
    const newId = ids();
    const clip = copyRange([region()], 2, 3, newId);
    expect(spans(clip)).toEqual([[0, 1, 1]]);
    const cut = deleteRange([region()], 2, 3, newId);
    const back = pasteAt(cut, clip, 2, 1, newId);
    // Cut then paste at the same place plays the same stretches of source at the same times.
    expect(spans(back)).toEqual([
      [1, 2, 0],
      [2, 3, 1],
      [3, 5, 2],
    ]);
    expect(copyRange([region()], 7, 8, newId)).toEqual([]);
  });

  it('measures the document and fills in a missing duration', () => {
    const doc = AudioDoc.parse({
      id: 'd',
      name: 'D',
      tracks: [
        {
          id: 't',
          name: 'T',
          regions: [region(), region({ id: 'x', startSeconds: 9, durationSeconds: 0.5 })],
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(docDuration(doc)).toBe(9.5);
    const source = {
      sampleRate: SAMPLE_RATE,
      channels: [new Float32Array(96000), new Float32Array(96000)] as [Float32Array, Float32Array],
    };
    expect(
      withDuration(region({ durationSeconds: null, trimStartSeconds: 0.5 }), source)
        .durationSeconds,
    ).toBe(1.5);
    expect(withDuration(region(), source).durationSeconds).toBe(4);
    expect(
      withDuration(region({ durationSeconds: null, trimStartSeconds: 3 }), source).durationSeconds,
    ).toBeNull();
  });
});

/** A steady tone of a given level, as a stored WAV. */
const toneWav = (seconds: number, level: number) =>
  encodeWav(
    {
      sampleRate: 48000,
      channels: [
        Float32Array.from(
          { length: Math.round(48000 * seconds) },
          (_, i) => level * Math.sin(i / 8),
        ),
      ],
    },
    'float32',
  );

describe('audio document commands', () => {
  const setup = async () => {
    const runtime = createTestRuntime();
    await runtime.blobs.put('p/a', { bytes: toneWav(2, 0.5), mediaType: 'audio/wav' });
    await runtime.blobs.put('p/b', { bytes: toneWav(1, 0.1), mediaType: 'audio/wav' });
    const registry = new CommandRegistry({ runtime }).register(
      ...projectCommands,
      ...createAudioCommands({ codec: createDefaultAudioCodec() }),
    );
    const you: Actor = { kind: 'user', id: 'u' };
    const agent: Actor = { kind: 'agent', id: 'se', role: 'sound-editor' };
    const run = async (id: string, input: unknown, actor: Actor = you) =>
      (await registry.executeById(id, input, { actor })) as {
        output: Record<string, unknown>;
      } & Record<string, unknown>;
    const project = (await run('project.create', { name: 'P', mode: 'movie' })).output as {
      id: string;
    };
    const projectId = project.id;
    const created = await run('audio.doc.create', {
      projectId,
      name: 'Scene 4',
      sources: [{ key: 'p/a', label: 'Mara' }, { key: 'p/b' }],
    });
    const doc = (created.output as { document: Outline }).document;
    return { runtime, run, projectId, doc, agent };
  };

  interface Outline {
    id: string;
    durationSeconds: number;
    markers: { id: string; atSeconds: number }[];
    tracks: {
      id: string;
      name: string;
      gainDb: number;
      mute: boolean;
      regions: {
        id: string;
        startSeconds: number;
        endSeconds: number;
        gainDb: number;
        label: string;
      }[];
    }[];
  }
  const outlineOf = (result: { output: Record<string, unknown> }) =>
    (result.output as { document: Outline }).document;

  it('makes a document with one track per sound and lists it', async () => {
    const { run, projectId, doc } = await setup();
    expect(doc.tracks.map((t) => t.name)).toEqual(['Mara', 'Track 2']);
    expect(doc.durationSeconds).toBe(2);
    const listed = await run('audio.doc.list', { projectId });
    expect(listed.output).toMatchObject({
      documents: [{ id: doc.id, name: 'Scene 4', tracks: 2, durationSeconds: 2 }],
    });
    const empty = outlineOf(await run('audio.doc.create', { projectId, name: 'Empty' }));
    expect(empty.tracks).toHaveLength(1);
    expect(outlineOf(await run('audio.doc.get', { projectId, docId: doc.id })).id).toBe(doc.id);
    expect(
      outlineOf(await run('audio.doc.rename', { projectId, docId: doc.id, name: 'Lamp room' })),
    ).toMatchObject({ name: 'Lamp room' });
  });

  it('edits tracks and regions', async () => {
    const { run, projectId, doc } = await setup();
    const docId = doc.id;
    const [first, second] = doc.tracks;
    const regionId = first?.regions[0]?.id ?? '';
    let now = outlineOf(await run('audio.track.add', { projectId, docId, name: 'Music' }));
    expect(now.tracks).toHaveLength(3);
    now = outlineOf(
      await run('audio.track.update', {
        projectId,
        docId,
        trackId: second?.id,
        gainDb: -6,
        mute: true,
      }),
    );
    expect(now.tracks[1]).toMatchObject({ gainDb: -6, mute: true, name: 'Track 2' });
    now = outlineOf(
      await run('audio.region.insert', {
        projectId,
        docId,
        trackId: now.tracks[2]?.id,
        key: 'p/a',
        startSeconds: 3,
        trimStartSeconds: 0.5,
      }),
    );
    expect(now.tracks[2]?.regions[0]).toMatchObject({ startSeconds: 3, endSeconds: 4.5 });
    now = outlineOf(
      await run('audio.region.split', { projectId, docId, regionId, atSeconds: 0.75 }),
    );
    expect(now.tracks[0]?.regions.map((r) => [r.startSeconds, r.endSeconds])).toEqual([
      [0, 0.75],
      [0.75, 2],
    ]);
    now = outlineOf(
      await run('audio.region.update', {
        projectId,
        docId,
        regionId,
        startSeconds: 5,
        trackId: second?.id,
        label: 'Moved',
      }),
    );
    expect(now.tracks[1]?.regions.find((r) => r.id === regionId)).toMatchObject({
      startSeconds: 5,
      label: 'Moved',
    });
    now = outlineOf(await run('audio.region.duplicate', { projectId, docId, regionId }));
    expect(now.tracks[1]?.regions.map((r) => r.startSeconds)).toContain(5.75);
    now = outlineOf(await run('audio.region.remove', { projectId, docId, regionId }));
    expect(now.tracks[1]?.regions.some((r) => r.id === regionId)).toBe(false);
    now = outlineOf(await run('audio.track.remove', { projectId, docId, trackId: second?.id }));
    expect(now.tracks).toHaveLength(2);
  });

  it('refuses edits that make no sense, saying why', async () => {
    const { run, projectId, doc } = await setup();
    const docId = doc.id;
    const regionId = doc.tracks[0]?.regions[0]?.id ?? '';
    await expect(run('audio.doc.get', { projectId, docId: 'nope' })).rejects.toThrow(
      /No audio document/,
    );
    await expect(
      run('audio.track.update', { projectId, docId, trackId: 'nope', mute: true }),
    ).rejects.toThrow(/No track/);
    await expect(
      run('audio.region.split', { projectId, docId, regionId: 'nope', atSeconds: 1 }),
    ).rejects.toThrow(/No region/);
    await expect(
      run('audio.region.split', { projectId, docId, regionId, atSeconds: 9 }),
    ).rejects.toThrow(/split inside/);
    await expect(
      run('audio.region.update', {
        projectId,
        docId,
        regionId,
        trimStartSeconds: 1.5,
        durationSeconds: 1,
      }),
    ).rejects.toThrow(/cannot pass its end/);
    await expect(
      run('audio.region.insert', {
        projectId,
        docId,
        trackId: doc.tracks[0]?.id,
        key: 'p/a',
        startSeconds: 0,
        trimStartSeconds: 3,
      }),
    ).rejects.toThrow(/must be less/);
    await expect(
      run('audio.region.insert', {
        projectId,
        docId,
        trackId: doc.tracks[0]?.id,
        key: 'p/none',
        startSeconds: 0,
      }),
    ).rejects.toThrow(/Nothing is stored/);
    await expect(
      run('audio.edit.delete', { projectId, docId, fromSeconds: 1, toSeconds: 1 }),
    ).rejects.toThrow(/must end after/);
    await expect(
      run('audio.edit.paste', { projectId, docId, trackId: doc.tracks[0]?.id, atSeconds: 0 }),
    ).rejects.toThrow(/clipboard is empty/);
    await expect(run('audio.history.redo', { projectId, docId })).rejects.toThrow(
      /nothing to redo/,
    );
    await expect(run('audio.normalize', { projectId, docId })).rejects.toThrow(
      /regionIds or a trackId/,
    );
    await expect(run('audio.marker.remove', { projectId, docId, markerId: 'x' })).rejects.toThrow(
      /No marker/,
    );
  });

  it('cuts, copies, pastes, silences and inserts across tracks', async () => {
    const { run, projectId, doc } = await setup();
    const docId = doc.id;
    const [a, b] = doc.tracks;
    let now = outlineOf(
      await run('audio.edit.cut', { projectId, docId, fromSeconds: 0.25, toSeconds: 0.5 }),
    );
    expect(now.durationSeconds).toBe(1.75);
    now = outlineOf(
      await run('audio.edit.paste', { projectId, docId, trackId: a?.id, atSeconds: 1 }),
    );
    expect(now.durationSeconds).toBe(2);
    expect(now.tracks[1]?.regions.map((r) => [r.startSeconds, r.endSeconds])).toEqual([
      [0, 0.25],
      [0.25, 0.75],
      [1, 1.25],
    ]);
    await expect(
      run('audio.edit.paste', { projectId, docId, trackId: b?.id, atSeconds: 0 }),
    ).rejects.toThrow(/not enough tracks/);
    const copied = await run('audio.edit.copy', {
      projectId,
      docId,
      trackIds: [a?.id],
      fromSeconds: 0,
      toSeconds: 1,
    });
    expect(copied.output).toEqual({ copiedSeconds: 1, tracks: 1 });
    now = outlineOf(
      await run('audio.edit.silence', {
        projectId,
        docId,
        trackIds: [a?.id],
        fromSeconds: 0,
        toSeconds: 0.5,
      }),
    );
    expect(now.tracks[0]?.regions[0]?.startSeconds).toBe(0.5);
    now = outlineOf(
      await run('audio.edit.insertSilence', { projectId, docId, atSeconds: 0, seconds: 1 }),
    );
    expect(now.durationSeconds).toBe(3);
    now = outlineOf(
      await run('audio.edit.delete', {
        projectId,
        docId,
        trackIds: [b?.id],
        fromSeconds: 0,
        toSeconds: 3,
      }),
    );
    expect(now.tracks[1]?.regions).toEqual([]);
  });

  it('undoes step by step, or an agent pass at once, and redoes', async () => {
    const { run, projectId, doc, agent } = await setup();
    const docId = doc.id;
    await run('audio.marker.add', { projectId, docId, atSeconds: 1, label: 'Thunder' });
    await run('audio.track.add', { projectId, docId, name: 'A' }, agent);
    await run('audio.track.add', { projectId, docId, name: 'B' }, agent);
    const history = await run('audio.history.list', { projectId, docId });
    expect(
      (history.output as { undo: { label: string; actor: Actor }[] }).undo.map((e) => [
        e.label,
        e.actor.kind,
      ]),
    ).toEqual([
      ['Add marker', 'user'],
      ['Add track', 'agent'],
      ['Add track', 'agent'],
    ]);
    let back = await run('audio.history.undo', { projectId, docId, wholeRun: true });
    expect(back.output).toMatchObject({ steps: 2 });
    expect(outlineOf(back).tracks).toHaveLength(2);
    expect(outlineOf(back).markers).toHaveLength(1);
    back = await run('audio.history.undo', { projectId, docId });
    expect(outlineOf(back).markers).toHaveLength(0);
    await expect(run('audio.history.undo', { projectId, docId })).rejects.toThrow(
      /nothing to undo/,
    );
    back = await run('audio.history.redo', { projectId, docId, wholeRun: true });
    expect(back.output).toMatchObject({ steps: 1 });
    back = await run('audio.history.redo', { projectId, docId, wholeRun: true });
    expect(outlineOf(back).tracks).toHaveLength(4);
    const markerId = outlineOf(back).markers[0]?.id;
    expect(
      outlineOf(await run('audio.marker.remove', { projectId, docId, markerId })).markers,
    ).toEqual([]);
    // A new edit clears what could be redone.
    expect((await run('audio.history.list', { projectId, docId })).output).toMatchObject({
      redo: [],
    });
  });

  it('normalizes regions to the same peak', async () => {
    const { run, projectId, doc } = await setup();
    const docId = doc.id;
    const now = outlineOf(
      await run('audio.normalize', { projectId, docId, trackId: doc.tracks[1]?.id, peakDb: -6 }),
    );
    // A tone at 0.1 must rise by 20 dB minus 6 to peak at -6 dB.
    expect(now.tracks[1]?.regions[0]?.gainDb).toBeCloseTo(14, 1);
    const both = outlineOf(
      await run('audio.normalize', {
        projectId,
        docId,
        regionIds: [doc.tracks[0]?.regions[0]?.id],
      }),
    );
    expect(both.tracks[0]?.regions[0]?.gainDb).toBeCloseTo(5.02, 1);
  });

  it('mixes for listening and export exactly as the tracks say', async () => {
    const { runtime, run, projectId, doc, agent } = await setup();
    const docId = doc.id;
    await run('audio.track.update', { projectId, docId, trackId: doc.tracks[1]?.id, solo: true });
    const heard = await run(
      'audio.listen',
      { projectId, docId, fromSeconds: 0, toSeconds: 0.5 },
      agent,
    );
    expect(heard.output).toMatchObject({
      durationSeconds: 0.5,
      attachments: [{ mediaType: 'audio/wav' }],
    });
    const file = await runtime.blobs.get(heard.output['key'] as string);
    const pcm = decodeWav(file?.bytes ?? new Uint8Array());
    // Only the soloed quiet track plays.
    expect(Math.max(...(pcm.channels[0] ?? []))).toBeLessThan(0.11);
    expect(Math.max(...(pcm.channels[0] ?? []))).toBeGreaterThan(0.09);
    const exported = await run('audio.export', { projectId, docId });
    expect(exported.output).toMatchObject({ durationSeconds: 2 });
    expect(await runtime.blobs.get(exported.output['key'] as string)).toBeDefined();
    const long = await run('audio.listen', { projectId, docId, toSeconds: 100 }, agent);
    expect(long.output).toMatchObject({ durationSeconds: 30 });
    const deleted = await run('audio.doc.delete', { projectId, docId });
    expect(deleted.output).toEqual({ deleted: docId });
    expect(await runtime.blobs.list(`projects/${projectId}/audio/renders/`)).toEqual([]);
  });
});
