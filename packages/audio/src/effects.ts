import { z } from 'zod';
import { designBiquad, filter } from './dsp/biquad.js';
import { compress, limit } from './dsp/dynamics.js';
import { denoise, learnNoise } from './dsp/denoise.js';
import { measureLoudness, truePeak } from './dsp/loudness.js';
import type { StereoPcm } from './pcm.js';
import { SAMPLE_RATE, toFrames } from './time.js';

/** One band of the equalizer. */
export const EqBand = z.object({
  type: z
    .enum(['highpass', 'lowpass', 'lowshelf', 'highshelf', 'bell'])
    .describe(
      'highpass cuts below the frequency (rumble, wind), lowpass cuts above (hiss), shelves raise or lower everything below or above, bell raises or lowers around the frequency.',
    ),
  frequency: z.number().min(20).max(20_000).describe('Hz.'),
  gainDb: z
    .number()
    .min(-24)
    .max(24)
    .default(0)
    .describe('Boost or cut, for shelves and bells. Ignored by the passes.'),
  q: z
    .number()
    .min(0.1)
    .max(18)
    .default(0.707)
    .describe('Width: 0.707 is smooth; 2 to 8 is a narrow bell for one resonance.'),
});
export type EqBand = z.infer<typeof EqBand>;

/**
 * What can be done to a region's sound, in the order listed on the region.
 * Each works on the region's whole source, so trimming a region later never
 * changes how it was processed.
 */
export const Effect = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('eq'),
    bands: z.array(EqBand).min(1).max(8),
  }),
  z.object({
    kind: z.literal('compressor'),
    thresholdDb: z.number().min(-60).max(0).default(-18),
    ratio: z.number().min(1).max(20).default(3),
    attackMs: z.number().min(0.1).max(200).default(10),
    releaseMs: z.number().min(10).max(2000).default(150),
    kneeDb: z.number().min(0).max(24).default(6),
    makeupDb: z.number().min(0).max(24).default(0),
  }),
  z.object({
    kind: z.literal('limiter'),
    ceilingDb: z.number().min(-24).max(0).default(-1),
    releaseMs: z.number().min(1).max(1000).default(60),
  }),
  z.object({
    kind: z.literal('denoise'),
    /** Where in the source the noise alone can be heard, in seconds of the source. */
    noiseFromSeconds: z.number().min(0),
    noiseToSeconds: z.number().positive(),
    reductionDb: z.number().min(0).max(48).default(18),
    sensitivityDb: z.number().min(0).max(24).default(6),
  }),
  z.object({
    kind: z.literal('loudness'),
    /** Integrated loudness to reach: -23 LUFS for broadcast, -16 for online, -14 for streaming music. */
    targetLufs: z.number().min(-40).max(-5).default(-16),
    /** True peaks are kept under this, by a limiter if raising would pass it. */
    truePeakDb: z.number().min(-9).max(0).default(-1),
  }),
]);
export type Effect = z.infer<typeof Effect>;
export type EffectKind = Effect['kind'];

/** A stable text of a chain, to name the processed file after. */
export function effectsKey(effects: readonly Effect[]): string {
  return JSON.stringify(effects);
}

/** Why a chain cannot be applied to a source, such as a noise stretch outside it. */
export class EffectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EffectError';
  }
}

function stereo(channels: readonly Float32Array[]): [Float32Array, Float32Array] {
  return [channels[0] ?? new Float32Array(0), channels[1] ?? channels[0] ?? new Float32Array(0)];
}

function applyOne(channels: readonly Float32Array[], effect: Effect): Float32Array[] {
  switch (effect.kind) {
    case 'eq': {
      const designs = effect.bands.map((band) => designBiquad(band, SAMPLE_RATE));
      return channels.map((channel) =>
        designs.reduce((samples, design) => filter(samples, design), channel),
      );
    }
    case 'compressor':
      return compress(channels, SAMPLE_RATE, effect);
    case 'limiter':
      return limit(channels, SAMPLE_RATE, effect);
    case 'denoise': {
      const length = channels[0]?.length ?? 0;
      const from = Math.min(toFrames(effect.noiseFromSeconds), length);
      const to = Math.min(toFrames(effect.noiseToSeconds), length);
      if (to <= from) {
        throw new EffectError('The noise stretch for noise reduction lies outside the sound.');
      }
      try {
        const profile = learnNoise(channels.map((channel) => channel.subarray(from, to)));
        return denoise(channels, profile, effect);
      } catch (error) {
        if (error instanceof RangeError) throw new EffectError(error.message);
        throw error;
      }
    }
    case 'loudness': {
      const measured = measureLoudness(channels, SAMPLE_RATE);
      if (!Number.isFinite(measured.integratedLufs)) return [...channels];
      const gain = 10 ** ((effect.targetLufs - measured.integratedLufs) / 20);
      const raised = channels.map((channel) => Float32Array.from(channel, (v) => v * gain));
      const ceiling = 10 ** (effect.truePeakDb / 20);
      if (truePeak(raised) <= ceiling) return raised;
      // Sample peaks a little under the ceiling keep the peaks between samples under it too.
      return limit(raised, SAMPLE_RATE, { ceilingDb: effect.truePeakDb - 0.5, releaseMs: 60 });
    }
  }
}

/** Runs a chain over a decoded source, returning the processed sound. */
export function applyEffects(source: StereoPcm, effects: readonly Effect[]): StereoPcm {
  let channels: readonly Float32Array[] = source.channels;
  for (const effect of effects) channels = applyOne(channels, effect);
  return { sampleRate: source.sampleRate, channels: stereo(channels) };
}

/** A short line for each effect, for outlines and agents. */
export function describeEffect(effect: Effect): string {
  switch (effect.kind) {
    case 'eq':
      return `EQ: ${effect.bands
        .map((band) =>
          band.type === 'highpass' || band.type === 'lowpass'
            ? `${band.type} ${String(band.frequency)} Hz`
            : `${band.type} ${String(band.frequency)} Hz ${band.gainDb > 0 ? '+' : ''}${String(band.gainDb)} dB`,
        )
        .join(', ')}`;
    case 'compressor':
      return `Compressor: ${String(effect.ratio)}:1 above ${String(effect.thresholdDb)} dB`;
    case 'limiter':
      return `Limiter: ceiling ${String(effect.ceilingDb)} dB`;
    case 'denoise':
      return `Noise reduction: ${String(effect.reductionDb)} dB`;
    case 'loudness':
      return `Loudness: ${String(effect.targetLufs)} LUFS, peaks under ${String(effect.truePeakDb)} dBTP`;
  }
}
