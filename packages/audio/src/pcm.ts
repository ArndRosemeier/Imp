import { SAMPLE_RATE } from './time.js';

/** Decoded sound: one array of samples per channel, from -1 to 1. */
export interface Pcm {
  readonly sampleRate: number;
  readonly channels: readonly Float32Array[];
}

/** Sound ready for the engine: stereo at the engine rate. */
export interface StereoPcm extends Pcm {
  readonly channels: readonly [Float32Array, Float32Array];
}

/** How many frames (samples per channel) the sound has. */
export function frameCount(pcm: Pcm): number {
  return pcm.channels[0]?.length ?? 0;
}

/** Zero crossings on each side of a resampled point. More is cleaner and slower. */
const HALF_TAPS = 16;

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/** A Blackman window over -1..1, zero outside. */
function blackman(x: number): number {
  if (x <= -1 || x >= 1) return 0;
  const t = (x + 1) / 2;
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t);
}

function resampleChannel(input: Float32Array, ratio: number, outLength: number): Float32Array {
  const output = new Float32Array(outLength);
  // Going down, the filter must also cut what the lower rate cannot hold.
  const cutoff = Math.min(1, ratio);
  const reach = HALF_TAPS / cutoff;
  for (let n = 0; n < outLength; n++) {
    const center = n / ratio;
    const first = Math.max(0, Math.ceil(center - reach));
    const last = Math.min(input.length - 1, Math.floor(center + reach));
    let sum = 0;
    let weights = 0;
    for (let k = first; k <= last; k++) {
      const distance = center - k;
      const weight = sinc(cutoff * distance) * blackman(distance / reach);
      sum += (input[k] ?? 0) * weight;
      weights += weight;
    }
    // Dividing by the sum of weights keeps a constant signal exactly constant.
    output[n] = weights === 0 ? 0 : sum / weights;
  }
  return output;
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

/** The most filter phases worth tabulating; stranger rate pairs are computed point by point. */
const MAX_PHASES = 4096;

/**
 * The same filter as `resampleChannel`, for rates with a small common
 * divisor (all the usual ones): the output points fall on only `up`
 * different positions between input samples, so their weights are worked out
 * once and reused, which makes it many times faster.
 */
function resampleChannelPolyphase(
  input: Float32Array,
  up: number,
  down: number,
  outLength: number,
): Float32Array {
  const output = new Float32Array(outLength);
  const cutoff = Math.min(1, up / down);
  const reach = HALF_TAPS / cutoff;
  const taps = Math.ceil(reach);
  const width = taps * 2;
  // weights[phase * width + j] is the weight of input sample base - taps + 1 + j.
  const weights = new Float64Array(up * width);
  for (let phase = 0; phase < up; phase++) {
    const fraction = phase / up;
    for (let j = 0; j < width; j++) {
      const distance = fraction - (j - taps + 1);
      weights[phase * width + j] = sinc(cutoff * distance) * blackman(distance / reach);
    }
  }
  for (let n = 0; n < outLength; n++) {
    const position = n * down;
    const base = Math.floor(position / up);
    const row = (position % up) * width;
    const start = base - taps + 1;
    const first = Math.max(0, -start);
    const last = Math.min(width, input.length - start);
    let sum = 0;
    let total = 0;
    for (let j = first; j < last; j++) {
      const weight = weights[row + j] ?? 0;
      sum += (input[start + j] ?? 0) * weight;
      total += weight;
    }
    // Dividing by the sum of weights keeps a constant signal exactly constant.
    output[n] = total === 0 ? 0 : sum / total;
  }
  return output;
}

/** Converts to another sample rate with a windowed-sinc filter. */
export function resample(pcm: Pcm, sampleRate: number): Pcm {
  if (pcm.sampleRate === sampleRate) return pcm;
  const ratio = sampleRate / pcm.sampleRate;
  const outLength = Math.round(frameCount(pcm) * ratio);
  const divisor = greatestCommonDivisor(sampleRate, pcm.sampleRate);
  const up = sampleRate / divisor;
  const down = pcm.sampleRate / divisor;
  return {
    sampleRate,
    channels: pcm.channels.map((channel) =>
      Number.isInteger(up) && up <= MAX_PHASES
        ? resampleChannelPolyphase(channel, up, down, outLength)
        : resampleChannel(channel, ratio, outLength),
    ),
  };
}

/**
 * Makes two channels: mono is played on both sides; with more than two, the
 * first two (front left and right in every common layout) are kept.
 */
export function toStereo(pcm: Pcm): StereoPcm {
  const [left, right] = pcm.channels;
  if (left === undefined) {
    return { sampleRate: pcm.sampleRate, channels: [new Float32Array(0), new Float32Array(0)] };
  }
  return { sampleRate: pcm.sampleRate, channels: [left, right ?? left.slice()] };
}

/** What every decoded source becomes before the engine touches it. */
export function forEngine(pcm: Pcm): StereoPcm {
  return toStereo(resample(pcm, SAMPLE_RATE));
}

/** Converts a level from 0..1 to decibels relative to full scale, with -Infinity for silence. */
export function toDecibels(level: number): number {
  return level <= 0 ? -Infinity : 20 * Math.log10(level);
}

/** The loudest sample and the root mean square level over all channels. */
export function levels(pcm: Pcm): { peak: number; rms: number } {
  let peak = 0;
  let squares = 0;
  let count = 0;
  for (const channel of pcm.channels) {
    for (const sample of channel) {
      const size = Math.abs(sample);
      if (size > peak) peak = size;
      squares += sample * sample;
    }
    count += channel.length;
  }
  return { peak, rms: count === 0 ? 0 : Math.sqrt(squares / count) };
}
