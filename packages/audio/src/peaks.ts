import type { Pcm } from './pcm.js';
import { frameCount } from './pcm.js';

/** Frames per bucket of each overview level, finest first. */
export const PEAK_LEVELS = [256, 4096, 65536] as const;

/** The lowest and highest sample in each bucket, over all channels. */
export interface PeakLevel {
  readonly bucketFrames: number;
  readonly min: Float32Array;
  readonly max: Float32Array;
}

/**
 * A waveform overview, so a view of any zoom can be drawn without reading
 * samples again. One level holds 2 numbers per 256 frames, about 1.5 % of the
 * size of the sound.
 */
export interface Peaks {
  readonly frames: number;
  readonly levels: readonly PeakLevel[];
}

function finestLevel(pcm: Pcm, bucketFrames: number): PeakLevel {
  const frames = frameCount(pcm);
  const buckets = Math.ceil(frames / bucketFrames);
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = bucket * bucketFrames;
    const end = Math.min(frames, start + bucketFrames);
    let low = Infinity;
    let high = -Infinity;
    for (const channel of pcm.channels) {
      for (let frame = start; frame < end; frame++) {
        const sample = channel[frame] ?? 0;
        if (sample < low) low = sample;
        if (sample > high) high = sample;
      }
    }
    min[bucket] = low;
    max[bucket] = high;
  }
  return { bucketFrames, min, max };
}

function coarser(level: PeakLevel, factor: number): PeakLevel {
  const buckets = Math.ceil(level.min.length / factor);
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  for (let bucket = 0; bucket < buckets; bucket++) {
    let low = Infinity;
    let high = -Infinity;
    const end = Math.min(level.min.length, (bucket + 1) * factor);
    for (let i = bucket * factor; i < end; i++) {
      low = Math.min(low, level.min[i] ?? 0);
      high = Math.max(high, level.max[i] ?? 0);
    }
    min[bucket] = low;
    max[bucket] = high;
  }
  return { bucketFrames: level.bucketFrames * factor, min, max };
}

/** Builds the overview of a sound at every level. */
export function computePeaks(pcm: Pcm): Peaks {
  const [first, ...rest] = PEAK_LEVELS;
  let previous = finestLevel(pcm, first);
  const levels: PeakLevel[] = [previous];
  for (const bucketFrames of rest) {
    previous = coarser(previous, bucketFrames / previous.bucketFrames);
    levels.push(previous);
  }
  return { frames: frameCount(pcm), levels };
}

/** The lowest and highest sample per bucket of a requested view. */
export interface Waveform {
  readonly min: number[];
  readonly max: number[];
}

/**
 * The waveform between two frames in a given number of buckets, read from the
 * coarsest level that is still fine enough, so a whole-film view costs as
 * little as a close-up.
 */
export function waveform(peaks: Peaks, from: number, to: number, buckets: number): Waveform {
  const span = Math.max(0, Math.min(to, peaks.frames) - Math.max(0, from));
  const perBucket = span / buckets;
  let level = peaks.levels[0];
  for (const candidate of peaks.levels) {
    if (candidate.bucketFrames <= perBucket) level = candidate;
  }
  const min: number[] = [];
  const max: number[] = [];
  if (level === undefined || span === 0) return { min, max };
  const start = Math.max(0, from);
  for (let bucket = 0; bucket < buckets; bucket++) {
    const first = Math.floor((start + bucket * perBucket) / level.bucketFrames);
    const last = Math.max(
      first,
      Math.ceil((start + (bucket + 1) * perBucket) / level.bucketFrames) - 1,
    );
    let low = Infinity;
    let high = -Infinity;
    for (let i = first; i <= last && i < level.min.length; i++) {
      low = Math.min(low, level.min[i] ?? 0);
      high = Math.max(high, level.max[i] ?? 0);
    }
    min.push(low === Infinity ? 0 : low);
    max.push(high === -Infinity ? 0 : high);
  }
  return { min, max };
}

/** Packs an overview into bytes for the blob store: a small header of whole numbers, then the levels. */
export function encodePeaks(peaks: Peaks): Uint8Array {
  const header = new Float64Array(2 + peaks.levels.length * 2);
  header[0] = peaks.frames;
  header[1] = peaks.levels.length;
  peaks.levels.forEach((level, index) => {
    header[2 + index * 2] = level.bucketFrames;
    header[3 + index * 2] = level.min.length;
  });
  const floats = peaks.levels.reduce((sum, level) => sum + level.min.length * 2, 0);
  const body = new Float32Array(floats);
  let at = 0;
  for (const level of peaks.levels) {
    body.set(level.min, at);
    body.set(level.max, at + level.min.length);
    at += level.min.length * 2;
  }
  const out = new Uint8Array(header.byteLength + body.byteLength);
  out.set(new Uint8Array(header.buffer), 0);
  out.set(new Uint8Array(body.buffer), header.byteLength);
  return out;
}

/** Reads what `encodePeaks` wrote. */
export function decodePeaks(bytes: Uint8Array): Peaks {
  const copy = bytes.slice();
  const start = new Float64Array(copy.buffer, 0, 2);
  const frames = start[0] ?? 0;
  const count = start[1] ?? 0;
  const header = new Float64Array(copy.buffer, 0, 2 + count * 2);
  const body = new Float32Array(copy.buffer, header.byteLength);
  let at = 0;
  const levels: PeakLevel[] = [];
  for (let i = 0; i < count; i++) {
    const bucketFrames = header[2 + i * 2] ?? 0;
    const length = header[3 + i * 2] ?? 0;
    levels.push({
      bucketFrames,
      min: body.slice(at, at + length),
      max: body.slice(at + length, at + length * 2),
    });
    at += length * 2;
  }
  return { frames, levels };
}
