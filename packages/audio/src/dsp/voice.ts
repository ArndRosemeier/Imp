import { designBiquad, filter } from './biquad.js';

/**
 * Effects that change a voice rather than clean it: distortion, pitch shift,
 * ring modulation (the classic robot) and bit crushing (lo-fi radio and toys).
 */

export interface DistortionSettings {
  /** How hard the sound is driven into the curve, in dB. */
  readonly driveDb: number;
  /** soft rounds the peaks (warm overdrive), hard clips them (harsh), fold folds them back (metallic). */
  readonly shape: 'soft' | 'hard' | 'fold';
  /** A low-pass after the curve, to tame the fizz, in Hz. */
  readonly toneHz: number;
  /** 0 is the dry sound, 1 only the distorted one. */
  readonly mix: number;
  /** Level after it all, in dB. */
  readonly outputDb: number;
}

function curve(shape: DistortionSettings['shape'], x: number): number {
  switch (shape) {
    case 'soft':
      return Math.tanh(x);
    case 'hard':
      return Math.max(-1, Math.min(1, x));
    case 'fold':
      return Math.sin((Math.PI / 2) * x);
  }
}

export function distort(
  channels: readonly Float32Array[],
  sampleRate: number,
  settings: DistortionSettings,
): Float32Array[] {
  const drive = 10 ** (settings.driveDb / 20);
  const output = 10 ** (settings.outputDb / 20);
  // A driven soft curve gets louder; dividing by the curve at full drive keeps peaks near where they were.
  const norm = settings.shape === 'soft' ? 1 / Math.tanh(drive) : 1;
  const tone = designBiquad(
    { type: 'lowpass', frequency: settings.toneHz, gainDb: 0, q: 0.707 },
    sampleRate,
  );
  return channels.map((channel) => {
    const wet = filter(
      Float32Array.from(channel, (x) => curve(settings.shape, x * drive) * norm),
      tone,
    );
    return Float32Array.from(
      channel,
      (x, i) => (x * (1 - settings.mix) + (wet[i] ?? 0) * settings.mix) * output,
    );
  });
}

/** WSOLA frame: about 43 ms, long enough to hold a low voice's period. */
const FRAME = 2048;
const HOP = FRAME / 2;
/** How far a frame may slide to line up with the one before. */
const TOLERANCE = 512;

/**
 * Changes length without changing pitch (WSOLA): frames are overlapped at a
 * new spacing, each slid a little to where its waveform lines up with the
 * last one, so no phases cancel.
 */
export function timeStretch(channel: Float32Array, factor: number): Float32Array {
  const outLength = Math.round(channel.length * factor);
  const out = new Float32Array(outLength + FRAME);
  const weight = new Float32Array(outLength + FRAME);
  const window = Float32Array.from(
    { length: FRAME },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME),
  );
  const analysisHop = HOP / factor;
  let previous = 0;
  for (let k = 0; k * HOP < outLength; k++) {
    const ideal = Math.round(k * analysisHop);
    let best = ideal;
    if (k > 0) {
      // What would naturally follow the previous frame; find the closest match to it.
      const natural = previous + HOP;
      let bestScore = -Infinity;
      for (let shift = -TOLERANCE; shift <= TOLERANCE; shift += 2) {
        const at = ideal + shift;
        if (at < 0 || at + HOP > channel.length) continue;
        let score = 0;
        for (let i = 0; i < HOP; i += 4)
          score += (channel[at + i] ?? 0) * (channel[natural + i] ?? 0);
        if (score > bestScore) {
          bestScore = score;
          best = at;
        }
      }
    }
    previous = best;
    const start = k * HOP;
    for (let i = 0; i < FRAME; i++) {
      const w = window[i] ?? 0;
      out[start + i] = (out[start + i] ?? 0) + (channel[best + i] ?? 0) * w;
      weight[start + i] = (weight[start + i] ?? 0) + w;
    }
  }
  return Float32Array.from({ length: outLength }, (_, i) => {
    const w = weight[i] ?? 0;
    return w > 1e-3 ? (out[i] ?? 0) / w : (out[i] ?? 0);
  });
}

/**
 * Shifts pitch without changing length: stretches the sound by the pitch
 * ratio, then plays it back faster by the same ratio. Lines stay in sync
 * with the picture.
 */
export function shiftPitch(channels: readonly Float32Array[], semitones: number): Float32Array[] {
  if (semitones === 0) return channels.map((channel) => channel.slice());
  const ratio = 2 ** (semitones / 12);
  return channels.map((channel) => {
    const stretched = timeStretch(channel, ratio);
    // Played back faster by the ratio, read between samples with a cubic curve.
    const out = new Float32Array(channel.length);
    for (let n = 0; n < out.length; n++) {
      const at = n * ratio;
      const i = Math.floor(at);
      const t = at - i;
      const y0 = stretched[i - 1] ?? 0;
      const y1 = stretched[i] ?? 0;
      const y2 = stretched[i + 1] ?? 0;
      const y3 = stretched[i + 2] ?? 0;
      const c1 = 0.5 * (y2 - y0);
      const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
      const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
      out[n] = ((c3 * t + c2) * t + c1) * t + y1;
    }
    return out;
  });
}

/** Multiplies the voice by a tone: metallic, and at 30 to 80 Hz the robot of old films. */
export function ringModulate(
  channels: readonly Float32Array[],
  sampleRate: number,
  frequency: number,
  mix: number,
): Float32Array[] {
  const w = (2 * Math.PI * frequency) / sampleRate;
  return channels.map((channel) =>
    Float32Array.from(channel, (x, i) => x * (1 - mix + mix * Math.sin(w * i))),
  );
}

/** Fewer bits and a lower rate: the grit of cheap radios, toys and old games. */
export function crush(
  channels: readonly Float32Array[],
  bits: number,
  downsample: number,
): Float32Array[] {
  const levels = 2 ** (bits - 1);
  const hold = Math.max(1, Math.round(downsample));
  return channels.map((channel) => {
    const out = new Float32Array(channel.length);
    let held = 0;
    for (let i = 0; i < channel.length; i++) {
      if (i % hold === 0) held = Math.round((channel[i] ?? 0) * levels) / levels;
      out[i] = held;
    }
    return out;
  });
}
