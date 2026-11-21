import { CommandRegistry, projectCommands, type Actor } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { describe, expect, it } from 'vitest';
import {
  createAudioCommands,
  createDefaultAudioCodec,
  encodeWav,
  type Effect,
} from '../src/index.js';

const RATE = 48_000;

/** A 1 kHz tone, with hiss under it when asked, as a stored float WAV. */
function wav(seconds: number, level: number, hiss = 0): Uint8Array {
  let state = 7;
  const samples = Float32Array.from({ length: Math.round(RATE * seconds) }, (_, i) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    const noise = hiss * ((state / 2 ** 32) * 2 - 1);
    // The first half second is hiss alone, to learn from.
    const tone = i < RATE / 2 ? 0 : level * Math.sin((2 * Math.PI * 1000 * i) / RATE);
    return tone + noise;
  });
  return encodeWav({ sampleRate: RATE, channels: [samples] }, 'float32');
}

interface Region {
  id: string;
  key: string;
  startSeconds: number;
  effects: Effect[];
}
interface Outline {
  id: string;
  tracks: { id: string; regions: Region[] }[];
}

async function setup() {
  const runtime = createTestRuntime();
  await runtime.blobs.put('p/voice', { bytes: wav(3, 0.05, 0.01), mediaType: 'audio/wav' });
  await runtime.blobs.put('p/loud', { bytes: wav(3, 0.5), mediaType: 'audio/wav' });
  const registry = new CommandRegistry({ runtime }).register(
    ...projectCommands,
    ...createAudioCommands({ codec: createDefaultAudioCodec() }),
  );
  const you: Actor = { kind: 'user', id: 'u' };
  const run = async (id: string, input: unknown) =>
    ((await registry.executeById(id, input, { actor: you })) as { output: Record<string, unknown> })
      .output;
  const projectId = ((await run('project.create', { name: 'P', mode: 'movie' })) as { id: string })
    .id;
  const created = (await run('audio.doc.create', {
    projectId,
    name: 'Mix',
    sources: [
      { key: 'p/voice', label: 'Line' },
      { key: 'p/loud', label: 'Music' },
    ],
  })) as { document: Outline };
  const doc = created.document;
  const [voice, music] = doc.tracks.map((track) => track.regions[0]);
  if (voice === undefined || music === undefined) throw new Error('The document has no regions.');
  return { runtime, run, projectId, docId: doc.id, voice, music };
}

const regionIn = (output: Record<string, unknown>, id: string): Region | undefined =>
  (output as { document: Outline }).document.tracks
    .flatMap((track) => track.regions)
    .find((region) => region.id === id);

describe('effect commands', () => {
  it('adds effects in order and adjusts one of a kind in place', async () => {
    const { run, projectId, docId, voice } = await setup();
    const base = { projectId, docId, regionIds: [voice.id] };
    await run('audio.fx.eq', { ...base, bands: [{ type: 'highpass', frequency: 90 }] });
    await run('audio.fx.compressor', { ...base, thresholdDb: -24, ratio: 4 });
    const after = await run('audio.fx.eq', {
      ...base,
      bands: [{ type: 'highpass', frequency: 120 }],
    });
    const effects = regionIn(after, voice.id)?.effects ?? [];
    expect(effects.map((effect) => effect.kind)).toEqual(['eq', 'compressor']);
    expect(effects[0]).toMatchObject({ bands: [{ type: 'highpass', frequency: 120, q: 0.707 }] });
    expect(effects[1]).toMatchObject({ thresholdDb: -24, ratio: 4, attackMs: 10 });
    const limited = await run('audio.fx.limiter', { ...base, ceilingDb: -2 });
    expect(regionIn(limited, voice.id)?.effects.map((effect) => effect.kind)).toEqual([
      'eq',
      'compressor',
      'limiter',
    ]);
  });

  it('works on every region of a track, replaces and removes chains', async () => {
    const { run, projectId, docId, voice, music } = await setup();
    const doc = (await run('audio.doc.get', { projectId, docId })) as { document: Outline };
    const trackId = doc.document.tracks[1]?.id;
    await run('audio.fx.limiter', { projectId, docId, trackId });
    const set = await run('audio.fx.set', {
      projectId,
      docId,
      regionIds: [voice.id, music.id],
      effects: [{ kind: 'loudness', targetLufs: -20 }, { kind: 'limiter' }],
    });
    expect(regionIn(set, music.id)?.effects).toHaveLength(2);
    const one = await run('audio.fx.remove', {
      projectId,
      docId,
      regionIds: [music.id],
      kind: 'limiter',
    });
    expect(regionIn(one, music.id)?.effects.map((effect) => effect.kind)).toEqual(['loudness']);
    const none = await run('audio.fx.remove', { projectId, docId, regionIds: [voice.id] });
    expect(regionIn(none, voice.id)?.effects).toEqual([]);
    await expect(run('audio.fx.limiter', { projectId, docId })).rejects.toThrow(/regionIds/);
  });

  it('sets loudness per region and measures it', async () => {
    const { run, projectId, docId, voice, music } = await setup();
    for (const region of [voice, music]) {
      await run('audio.fx.loudness', { projectId, docId, regionIds: [region.id], targetLufs: -23 });
    }
    for (const region of [voice, music]) {
      const report = (await run('audio.analyze', { projectId, docId, regionId: region.id })) as {
        integratedLufs: number;
        truePeakDb: number;
      };
      expect(report.integratedLufs).toBeCloseTo(-23, 0);
      expect(report.truePeakDb).toBeLessThan(-1);
    }
    const whole = (await run('audio.analyze', {
      projectId,
      docId,
      fromSeconds: 1,
      toSeconds: 3,
    })) as {
      integratedLufs: number;
      fromSeconds: number;
      unheard: string[];
    };
    expect(whole.fromSeconds).toBe(1);
    expect(whole.integratedLufs).toBeGreaterThan(-23);
    expect(whole.unheard).toEqual([]);
  });

  it('learns noise from a stretch of the timeline and keeps it through moves', async () => {
    const { run, projectId, docId, voice } = await setup();
    const before = (await run('audio.analyze', {
      projectId,
      docId,
      regionId: voice.id,
      fromSeconds: 0,
      toSeconds: 0.5,
    })) as { integratedLufs: number };
    const after = await run('audio.fx.denoise', {
      projectId,
      docId,
      regionId: voice.id,
      noiseFromSeconds: 0.05,
      noiseToSeconds: 0.45,
      reductionDb: 24,
    });
    expect(regionIn(after, voice.id)?.effects[0]).toMatchObject({
      kind: 'denoise',
      noiseFromSeconds: 0.05,
      noiseToSeconds: 0.45,
    });
    const quieter = (await run('audio.analyze', {
      projectId,
      docId,
      regionId: voice.id,
      fromSeconds: 0,
      toSeconds: 0.5,
    })) as { integratedLufs: number };
    expect(quieter.integratedLufs).toBeLessThan(before.integratedLufs - 12);
    // Moved later, the stretch is still where the hiss is in the source.
    await run('audio.region.update', { projectId, docId, regionId: voice.id, startSeconds: 2 });
    const moved = await run('audio.fx.denoise', {
      projectId,
      docId,
      regionId: voice.id,
      noiseFromSeconds: 2.1,
      noiseToSeconds: 2.4,
    });
    expect(regionIn(moved, voice.id)?.effects).toHaveLength(1);
    const [stretch] = regionIn(moved, voice.id)?.effects ?? [];
    expect(stretch?.kind === 'denoise' ? stretch.noiseFromSeconds : 0).toBeCloseTo(0.1, 6);
    await expect(
      run('audio.fx.denoise', {
        projectId,
        docId,
        regionId: voice.id,
        noiseFromSeconds: 0,
        noiseToSeconds: 1,
      }),
    ).rejects.toThrow(/inside the region/);
  });

  it('keeps one processed file per chain and refuses chains that cannot work', async () => {
    const { runtime, run, projectId, docId, voice } = await setup();
    const effects = [{ kind: 'limiter', ceilingDb: -6, releaseMs: 60 }];
    const first = (await run('audio.fx.processed', { key: 'p/voice', effects })) as { key: string };
    const again = (await run('audio.fx.processed', { key: 'p/voice', effects })) as { key: string };
    expect(again.key).toBe(first.key);
    expect(first.key).toMatch(/^p\/voice\.audio\/.+\/fx\/.+\.wav$/);
    expect((await runtime.blobs.get(first.key))?.mediaType).toBe('audio/wav');
    expect(
      ((await run('audio.fx.processed', { key: 'p/voice', effects: [] })) as { key: string }).key,
    ).toBe('p/voice');
    await expect(run('audio.fx.processed', { key: 'p/none', effects })).rejects.toThrow(
      /Nothing is stored/,
    );
    await expect(
      run('audio.fx.set', {
        projectId,
        docId,
        regionIds: [voice.id],
        effects: [{ kind: 'denoise', noiseFromSeconds: 9, noiseToSeconds: 10 }],
      }),
    ).rejects.toThrow(/Line: The noise stretch/);
  });

  it('plays processed sound in listening and lists what cannot be processed as unheard', async () => {
    const { runtime, run, projectId, docId, music } = await setup();
    await run('audio.fx.eq', {
      projectId,
      docId,
      regionIds: [music.id],
      bands: [{ type: 'bell', frequency: 1000, gainDb: -12, q: 1 }],
    });
    const cut = (await run('audio.analyze', { projectId, docId, regionId: music.id })) as {
      integratedLufs: number;
    };
    await run('audio.fx.remove', { projectId, docId, regionIds: [music.id] });
    const plain = (await run('audio.analyze', { projectId, docId, regionId: music.id })) as {
      integratedLufs: number;
    };
    expect(plain.integratedLufs - cut.integratedLufs).toBeCloseTo(12, 0);
    // A chain stored before its source changed in a way it cannot work with.
    await run('audio.fx.denoise', {
      projectId,
      docId,
      regionId: music.id,
      noiseFromSeconds: 0.1,
      noiseToSeconds: 0.4,
    });
    await runtime.blobs.put('p/loud', { bytes: wav(0.05, 0.5), mediaType: 'audio/wav' });
    const heard = (await run('audio.listen', {
      projectId,
      docId,
      fromSeconds: 0,
      toSeconds: 1,
    })) as {
      unheard: string[];
    };
    expect(heard.unheard).toEqual(['Music']);
  });
});
