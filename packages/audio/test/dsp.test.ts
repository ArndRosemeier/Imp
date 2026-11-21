import { describe, expect, it } from 'vitest';
import { designBiquad, filter, responseDb } from '../src/dsp/biquad.js';
import { compress, gainReductionDb, limit } from '../src/dsp/dynamics.js';
import { denoise, learnNoise } from '../src/dsp/denoise.js';
import { Fft } from '../src/dsp/fft.js';
import { measureLoudness, truePeak } from '../src/dsp/loudness.js';
import { applyEffects, describeEffect, Effect, EffectError } from '../src/effects.js';

const RATE = 48_000;

function sine(frequency: number, amplitude: number, seconds: number, phase = 0): Float32Array {
  return Float32Array.from(
    { length: Math.round(seconds * RATE) },
    (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / RATE + phase),
  );
}

/** Deterministic white noise. */
function noise(amplitude: number, seconds: number, seed = 1): Float32Array {
  let state = seed;
  return Float32Array.from({ length: Math.round(seconds * RATE) }, () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return amplitude * ((state / 2 ** 32) * 2 - 1);
  });
}

const rms = (samples: Float32Array, from = 0, to = samples.length): number => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += (samples[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
};
const db = (ratio: number): number => 20 * Math.log10(ratio);
const peak = (samples: Float32Array, from = 0): number =>
  samples.subarray(from).reduce((max, v) => Math.max(max, Math.abs(v)), 0);

/** The level change a filter makes to a steady sine, measured after it settles. */
function measuredDb(type: Parameters<typeof designBiquad>[0], frequency: number): number {
  const input = sine(frequency, 0.5, 0.5);
  const output = filter(input, designBiquad(type, RATE));
  return db(rms(output, RATE / 4) / rms(input, RATE / 4));
}

describe('filters', () => {
  it('cut below and above their corners and pass the rest', () => {
    const highpass = { type: 'highpass', frequency: 100, gainDb: 0, q: 0.707 } as const;
    expect(measuredDb(highpass, 30)).toBeLessThan(-15);
    expect(measuredDb(highpass, 1000)).toBeCloseTo(0, 0);
    const lowpass = { type: 'lowpass', frequency: 4000, gainDb: 0, q: 0.707 } as const;
    expect(measuredDb(lowpass, 16_000)).toBeLessThan(-15);
    expect(measuredDb(lowpass, 200)).toBeCloseTo(0, 0);
  });

  it('raise and lower by the gain asked for', () => {
    const bell = { type: 'bell', frequency: 1000, gainDb: 6, q: 1 } as const;
    expect(measuredDb(bell, 1000)).toBeCloseTo(6, 1);
    expect(measuredDb(bell, 100)).toBeCloseTo(0, 0);
    const low = { type: 'lowshelf', frequency: 200, gainDb: -9, q: 0.707 } as const;
    expect(measuredDb(low, 40)).toBeCloseTo(-9, 0);
    const high = { type: 'highshelf', frequency: 6000, gainDb: 4, q: 0.707 } as const;
    expect(measuredDb(high, 18_000)).toBeCloseTo(4, 0);
  });

  it('report the same response they produce', () => {
    const spec = { type: 'bell', frequency: 2500, gainDb: -8, q: 3 } as const;
    const design = designBiquad(spec, RATE);
    for (const frequency of [500, 2500, 4000]) {
      expect(responseDb(design, frequency, RATE)).toBeCloseTo(measuredDb(spec, frequency), 0);
    }
  });
});

describe('dynamics', () => {
  const settings = {
    thresholdDb: -18,
    ratio: 4,
    attackMs: 5,
    releaseMs: 100,
    kneeDb: 0,
    makeupDb: 0,
  };

  it('works out the gain reduction with and without a knee', () => {
    expect(gainReductionDb(-30, settings)).toBe(0);
    expect(gainReductionDb(-6, settings)).toBeCloseTo(9, 6);
    const soft = { ...settings, kneeDb: 6 };
    expect(gainReductionDb(-18, soft)).toBeGreaterThan(0);
    expect(gainReductionDb(-18, soft)).toBeLessThan(1);
    expect(gainReductionDb(-6, soft)).toBeCloseTo(9, 6);
  });

  it('turns loud sound down by the ratio and leaves quiet sound alone', () => {
    const loud = sine(200, 10 ** (-6 / 20), 1);
    const [out = new Float32Array(0)] = compress([loud, loud], RATE, settings);
    // 12 dB over the threshold comes out 3 dB over, give or take the follower's ripple.
    const level = db(peak(out, RATE / 2));
    expect(level).toBeGreaterThan(-15.5);
    expect(level).toBeLessThan(-14);
    const quiet = sine(200, 10 ** (-30 / 20), 0.5);
    const [kept = new Float32Array(0)] = compress([quiet], RATE, { ...settings, makeupDb: 2 });
    expect(db(peak(kept, RATE / 4) / peak(quiet))).toBeCloseTo(2, 1);
  });

  it('keeps every sample under the ceiling without touching the quiet part', () => {
    const quiet = sine(300, 0.2, 0.5);
    const loud = sine(300, 1, 0.5);
    const input = new Float32Array([...quiet, ...loud]);
    const [out = new Float32Array(0)] = limit([input, input], RATE, {
      ceilingDb: -1,
      releaseMs: 50,
    });
    expect(peak(out)).toBeLessThanOrEqual(10 ** (-1 / 20) + 1e-6);
    expect(rms(out, 0, RATE / 4)).toBeCloseTo(rms(input, 0, RATE / 4), 6);
    expect(db(peak(out, RATE * 0.75))).toBeCloseTo(-1, 1);
  });
});

describe('FFT', () => {
  it('finds a tone in its bin and transforms back', () => {
    const fft = new Fft(64);
    const re = Float64Array.from({ length: 64 }, (_, i) => Math.cos((2 * Math.PI * 4 * i) / 64));
    const original = re.slice();
    const im = new Float64Array(64);
    fft.transform(re, im);
    expect(re[4]).toBeCloseTo(32, 6);
    expect(Math.abs(re[5] ?? 1)).toBeLessThan(1e-9);
    fft.transform(re, im, true);
    for (let i = 0; i < 64; i++) expect(re[i]).toBeCloseTo(original[i] ?? 0, 9);
    expect(() => new Fft(48)).toThrow(/power of two/);
  });
});

describe('noise reduction', () => {
  it('turns down noise and keeps what stands above it', () => {
    const hiss = noise(0.02, 2);
    const voice = sine(440, 0.3, 1);
    const input = hiss.slice();
    for (let i = 0; i < voice.length; i++)
      input[RATE + i] = (input[RATE + i] ?? 0) + (voice[i] ?? 0);
    const profile = learnNoise([hiss.subarray(0, RATE / 2)]);
    const [out = new Float32Array(0)] = denoise([input], profile, {
      reductionDb: 18,
      sensitivityDb: 6,
    });
    const cleaned = out;
    expect(cleaned).toHaveLength(input.length);
    // Noise alone: down by most of the reduction.
    expect(
      db(rms(cleaned, RATE / 4, (RATE * 3) / 4) / rms(input, RATE / 4, (RATE * 3) / 4)),
    ).toBeLessThan(-12);
    // The tone: kept within a decibel.
    expect(db(rms(cleaned, RATE * 1.25, RATE * 1.75) / rms(voice))).toBeCloseTo(0, 0);
  });

  it('needs enough noise to learn from', () => {
    expect(() => learnNoise([noise(0.1, 0.01)])).toThrow(/at least/);
  });
});

describe('loudness', () => {
  it('measures the EBU reference tone at -23 LUFS', () => {
    const tone = sine(1000, 10 ** (-23 / 20), 20);
    const report = measureLoudness([tone, tone]);
    expect(report.integratedLufs).toBeCloseTo(-23, 1);
    expect(report.shortTermMaxLufs).toBeCloseTo(-23, 1);
    expect(report.rangeLu).toBeCloseTo(0, 1);
    expect(report.samplePeakDb).toBeCloseTo(-23, 1);
  });

  it('gates silence out and measures short sounds whole', () => {
    const tone = sine(1000, 10 ** (-23 / 20), 10);
    const withSilence = new Float32Array([...tone, ...new Float32Array(RATE * 10)]);
    // EBU Tech 3341 allows 0.1 LU.
    expect(Math.abs(measureLoudness([withSilence, withSilence]).integratedLufs + 23)).toBeLessThan(
      0.1,
    );
    expect(measureLoudness([new Float32Array(RATE)]).integratedLufs).toBe(-Infinity);
    const blip = sine(1000, 0.5, 0.2);
    expect(Number.isFinite(measureLoudness([blip, blip]).integratedLufs)).toBe(true);
  });

  it('finds peaks between samples', () => {
    // A quarter of the sample rate at 45 degrees: every sample is at 0.707, the wave reaches 1.
    const between = Float32Array.from({ length: 4800 }, (_, i) =>
      Math.sin((Math.PI * i) / 2 + Math.PI / 4),
    );
    expect(db(peak(between))).toBeCloseTo(-3, 0);
    expect(db(truePeak([between]))).toBeGreaterThan(-0.5);
  });
});

describe('effect chains', () => {
  const tone = (amplitude: number) => {
    const samples = sine(1000, amplitude, 6);
    return {
      sampleRate: RATE,
      channels: [samples, samples.slice()] as [Float32Array, Float32Array],
    };
  };

  it('normalizes loudness to a target and keeps peaks under the ceiling', () => {
    const quiet = applyEffects(tone(0.01), [Effect.parse({ kind: 'loudness', targetLufs: -16 })]);
    expect(measureLoudness(quiet.channels).integratedLufs).toBeCloseTo(-16, 0);
    const pushed = applyEffects(tone(0.1), [
      Effect.parse({ kind: 'loudness', targetLufs: -6, truePeakDb: -1 }),
    ]);
    expect(measureLoudness(pushed.channels).truePeakDb).toBeLessThanOrEqual(-1 + 0.05);
    const silent = {
      sampleRate: RATE,
      channels: [new Float32Array(10), new Float32Array(10)] as [Float32Array, Float32Array],
    };
    expect(applyEffects(silent, [Effect.parse({ kind: 'loudness' })]).channels[0]).toHaveLength(10);
    // Seconds of oversampled true-peak measurement: slow on a shared CI runner with coverage on.
  }, 30_000);

  it('runs every kind in order', () => {
    const effects = [
      Effect.parse({
        kind: 'eq',
        bands: [
          { type: 'highpass', frequency: 80 },
          { type: 'bell', frequency: 3000, gainDb: 3, q: 1 },
        ],
      }),
      Effect.parse({ kind: 'compressor' }),
      Effect.parse({ kind: 'denoise', noiseFromSeconds: 0, noiseToSeconds: 1 }),
      Effect.parse({ kind: 'limiter' }),
    ];
    const out = applyEffects(tone(0.5), effects);
    expect(out.channels[1]).toHaveLength(6 * RATE);
    expect(effects.map(describeEffect)).toEqual([
      'EQ: highpass 80 Hz, bell 3000 Hz +3 dB',
      'Compressor: 3:1 above -18 dB',
      'Noise reduction: 18 dB',
      'Limiter: ceiling -1 dB',
    ]);
    expect(describeEffect(Effect.parse({ kind: 'loudness' }))).toBe(
      'Loudness: -16 LUFS, peaks under -1 dBTP',
    );
  });

  it('refuses a noise stretch outside the sound or too short', () => {
    expect(() =>
      applyEffects(tone(0.5), [
        Effect.parse({ kind: 'denoise', noiseFromSeconds: 7, noiseToSeconds: 8 }),
      ]),
    ).toThrow(EffectError);
    expect(() =>
      applyEffects(tone(0.5), [
        Effect.parse({ kind: 'denoise', noiseFromSeconds: 0, noiseToSeconds: 0.01 }),
      ]),
    ).toThrow(/at least/);
  });
});
