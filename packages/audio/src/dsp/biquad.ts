/**
 * Second-order filters after Robert Bristow-Johnson's audio EQ cookbook: the
 * building blocks of the equalizer and of loudness weighting.
 */

export type FilterType = 'highpass' | 'lowpass' | 'lowshelf' | 'highshelf' | 'bell';

/** Normalized coefficients: a0 is 1. */
export interface Biquad {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

export interface FilterSpec {
  readonly type: FilterType;
  /** The corner or centre frequency in Hz. */
  readonly frequency: number;
  /** Boost or cut in dB, for shelves and bells. */
  readonly gainDb: number;
  /** Width: 0.707 is the flattest pass or shelf; larger is narrower. */
  readonly q: number;
}

/** The coefficients of one filter at a sample rate. */
export function designBiquad(spec: FilterSpec, sampleRate: number): Biquad {
  // Keep the corner below Nyquist, where the formulas stay stable.
  const frequency = Math.min(Math.max(spec.frequency, 1), sampleRate * 0.49);
  const w = (2 * Math.PI * frequency) / sampleRate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * Math.max(spec.q, 0.05));
  const a = 10 ** (spec.gainDb / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (spec.type) {
    case 'highpass':
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'lowpass':
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'bell':
      b0 = 1 + alpha * a;
      b1 = -2 * cos;
      b2 = 1 - alpha * a;
      a0 = 1 + alpha / a;
      a1 = -2 * cos;
      a2 = 1 - alpha / a;
      break;
    case 'lowshelf': {
      const root = 2 * Math.sqrt(a) * alpha;
      b0 = a * (a + 1 - (a - 1) * cos + root);
      b1 = 2 * a * (a - 1 - (a + 1) * cos);
      b2 = a * (a + 1 - (a - 1) * cos - root);
      a0 = a + 1 + (a - 1) * cos + root;
      a1 = -2 * (a - 1 + (a + 1) * cos);
      a2 = a + 1 + (a - 1) * cos - root;
      break;
    }
    case 'highshelf': {
      const root = 2 * Math.sqrt(a) * alpha;
      b0 = a * (a + 1 + (a - 1) * cos + root);
      b1 = -2 * a * (a - 1 + (a + 1) * cos);
      b2 = a * (a + 1 + (a - 1) * cos - root);
      a0 = a + 1 - (a - 1) * cos + root;
      a1 = 2 * (a - 1 - (a + 1) * cos);
      a2 = a + 1 - (a - 1) * cos - root;
      break;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Runs a filter over samples, returning new samples. */
export function filter(input: Float32Array, coefficients: Biquad): Float32Array {
  const { b0, b1, b2, a1, a2 } = coefficients;
  const output = new Float32Array(input.length);
  // Transposed direct form II: few states, and good numerical behaviour.
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i] ?? 0;
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    output[i] = y;
  }
  return output;
}

/** How much a filter changes a frequency, in dB. For drawing the curve. */
export function responseDb(coefficients: Biquad, frequency: number, sampleRate: number): number {
  const { b0, b1, b2, a1, a2 } = coefficients;
  const w = (2 * Math.PI * frequency) / sampleRate;
  const cos1 = Math.cos(w);
  const cos2 = Math.cos(2 * w);
  const sin1 = Math.sin(w);
  const sin2 = Math.sin(2 * w);
  const numRe = b0 + b1 * cos1 + b2 * cos2;
  const numIm = -(b1 * sin1 + b2 * sin2);
  const denRe = 1 + a1 * cos1 + a2 * cos2;
  const denIm = -(a1 * sin1 + a2 * sin2);
  const magnitude = Math.sqrt((numRe ** 2 + numIm ** 2) / (denRe ** 2 + denIm ** 2));
  return 20 * Math.log10(Math.max(magnitude, 1e-12));
}
