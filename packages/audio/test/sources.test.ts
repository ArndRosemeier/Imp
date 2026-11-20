import { readFileSync } from 'node:fs';
import { CommandRegistry, MemoryBlobStore } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  AudioSources,
  createAudioCommands,
  createDefaultAudioCodec,
  encodeWav,
  MissingSourceError,
  SAMPLE_RATE,
  type AudioCodec,
} from '../src/index.js';

const mp3 = new Uint8Array(
  readFileSync(new URL('./fixtures/sine-440-mono-24k.mp3', import.meta.url)),
);
const m4a = new Uint8Array(
  readFileSync(new URL('./fixtures/sine-440-stereo-48k.m4a', import.meta.url)),
);

/** Half a second of full-scale square wave at 8 kHz: loud, and clipped. */
const loudWav = encodeWav({
  sampleRate: 8000,
  channels: [Float32Array.from({ length: 4000 }, (_, i) => (i % 40 < 20 ? 1 : -1))],
});

/** Counts decodes, so tests can see what was cached. */
function countingCodec(): AudioCodec & { calls: number } {
  const inner = createDefaultAudioCodec();
  const codec = {
    calls: 0,
    decode: (bytes: Uint8Array, mediaType: string) => {
      codec.calls += 1;
      return inner.decode(bytes, mediaType);
    },
  };
  return codec;
}

describe('AudioSources', () => {
  it('decodes once and keeps the overview beside the file', async () => {
    const blobs = new MemoryBlobStore();
    await blobs.put('p/s/take', { bytes: mp3, mediaType: 'audio/mpeg' });
    const codec = countingCodec();
    const { info, peaks } = await new AudioSources(blobs, codec).describe('p/s/take');
    expect(info.sourceSampleRate).toBe(24000);
    expect(info.frames).toBe(peaks.frames);
    expect(info.durationSeconds).toBeCloseTo(1, 1);
    expect(await blobs.list('p/s/take.audio/')).toHaveLength(2);
    // A fresh cache, as after a reload, reads what was kept instead of decoding.
    const again = await new AudioSources(blobs, codec).describe('p/s/take');
    expect(again.info).toEqual(info);
    expect(codec.calls).toBe(1);
  });

  it('notices a replaced file and drops what it kept for the old one', async () => {
    const blobs = new MemoryBlobStore();
    const sources = new AudioSources(blobs, countingCodec());
    await blobs.put('k', { bytes: mp3, mediaType: 'audio/mpeg' });
    await sources.describe('k');
    await blobs.put('k', { bytes: loudWav, mediaType: 'audio/wav' });
    const { info } = await sources.describe('k');
    expect(info.sourceSampleRate).toBe(8000);
    expect(await blobs.list('k.audio/')).toHaveLength(2);
    const pcm = await sources.pcm('k');
    expect(pcm.sampleRate).toBe(SAMPLE_RATE);
    expect(pcm.channels[0].length).toBe(24000);
  });

  it('keeps samples in memory within its budget, newest first', async () => {
    const blobs = new MemoryBlobStore();
    await blobs.put('a', { bytes: loudWav, mediaType: 'audio/wav' });
    await blobs.put('b', { bytes: mp3, mediaType: 'audio/mpeg' });
    const codec = countingCodec();
    // Room for about one decoded file.
    const sources = new AudioSources(blobs, codec, 300_000);
    const a = await sources.pcm('a');
    expect(await sources.pcm('a')).toBe(a);
    expect(codec.calls).toBe(1);
    await sources.pcm('b');
    await sources.pcm('a');
    expect(codec.calls).toBe(3);
  });

  it('says what is missing or unreadable', async () => {
    const blobs = new MemoryBlobStore();
    const sources = new AudioSources(blobs, createDefaultAudioCodec());
    await expect(sources.describe('nothing')).rejects.toBeInstanceOf(MissingSourceError);
    const empty = { decode: vi.fn(() => Promise.resolve({ sampleRate: 48000, channels: [] })) };
    await blobs.put('e', { bytes: loudWav, mediaType: 'audio/wav' });
    await expect(new AudioSources(blobs, empty).pcm('e')).rejects.toThrow(/holds no sound/);
  });
});

describe('audio commands', () => {
  const setup = async () => {
    const runtime = createTestRuntime();
    await runtime.blobs.put('p/take', { bytes: mp3, mediaType: 'audio/mpeg' });
    await runtime.blobs.put('p/loud', { bytes: loudWav, mediaType: 'audio/wav' });
    await runtime.blobs.put('p/clip', { bytes: m4a, mediaType: 'video/mp4' });
    const registry = new CommandRegistry({ runtime }).register(
      ...createAudioCommands({ codec: createDefaultAudioCodec() }),
    );
    const run = (id: string, input: unknown) =>
      registry.executeById(id, input, { actor: { kind: 'user', id: 'u' } });
    return { run };
  };

  it('measures a sound in numbers', async () => {
    const { run } = await setup();
    const result = await run('audio.inspect', { key: 'p/take' });
    expect(result).toMatchObject({ status: 'ok', output: { sampleRate: 24000, clipped: false } });
    const output = (
      result as { output: { peakDb: number; rmsDb: number; durationSeconds: number } }
    ).output;
    // A sine at 1/8 of full scale peaks at -18 dB and averages 3 dB lower.
    expect(Math.abs(output.peakDb + 18)).toBeLessThan(1);
    expect(Math.abs(output.rmsDb + 21)).toBeLessThan(1);
    expect(output.durationSeconds).toBeCloseTo(1, 1);
    // Full scale square waves overshoot between samples, so the peak reads above 0 dB.
    const loud = (await run('audio.inspect', { key: 'p/loud' })) as {
      output: { clipped: boolean; peakDb: number };
    };
    expect(loud.output.clipped).toBe(true);
    expect(loud.output.peakDb).toBeGreaterThanOrEqual(0);
  });

  it('outlines a waveform in slices', async () => {
    const { run } = await setup();
    const result = await run('audio.waveform', { key: 'p/take', buckets: 10 });
    expect(result).toMatchObject({ status: 'ok', output: { fromSeconds: 0 } });
    const { min, max } = (result as { output: { min: number[]; max: number[] } }).output;
    expect(min).toHaveLength(10);
    expect(Math.max(...max)).toBeCloseTo(0.125, 1);
    const part = await run('audio.waveform', {
      key: 'p/take',
      fromSeconds: 0.5,
      toSeconds: 9,
      buckets: 4,
    });
    expect(part).toMatchObject({ output: { fromSeconds: 0.5 } });
    await expect(run('audio.waveform', { key: 'p/take', fromSeconds: 5 })).rejects.toThrow(
      /ask for a range inside it/,
    );
  });

  it('turns missing and unreadable files into clear refusals', async () => {
    const { run } = await setup();
    await expect(run('audio.inspect', { key: 'p/none' })).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'Nothing is stored under "p/none".',
    });
    await expect(run('audio.inspect', { key: 'p/clip' })).rejects.toThrow(/video clips/);
  });
});
