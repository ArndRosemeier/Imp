import { Fft } from './fft.js';

/**
 * Noise reduction by spectral gating, the method of Audacity's noise
 * reduction: learn the noise's spectrum from a stretch with nothing but
 * noise, then turn down every frequency that is no louder than the noise was,
 * moment by moment. Gains are smoothed across time and frequency, so the
 * remaining noise does not warble.
 */

const SIZE = 2048;
const HOP = SIZE / 4;

export interface DenoiseSettings {
  /** How far noise is turned down, in dB. 12 is gentle, 24 strong. */
  readonly reductionDb: number;
  /** How far above the noise a sound must be to be kept, in dB. Higher removes more. */
  readonly sensitivityDb: number;
}

/** The learned noise: its average level in each frequency band. */
export interface NoiseProfile {
  readonly size: number;
  readonly magnitudes: Float32Array;
}

/** A periodic Hann window's square root: applied before and after, the two make a Hann. */
function sqrtHann(): Float64Array {
  return Float64Array.from({ length: SIZE }, (_, i) =>
    Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / SIZE)),
  );
}

/** Calls `visit` with the spectrum of each windowed frame of the samples. */
function frames(
  samples: Float32Array,
  visit: (re: Float64Array, im: Float64Array, start: number) => void,
): void {
  const fft = new Fft(SIZE);
  const window = sqrtHann();
  const re = new Float64Array(SIZE);
  const im = new Float64Array(SIZE);
  // Start one frame early so the first samples are covered by full overlap.
  for (let start = -SIZE + HOP; start < samples.length; start += HOP) {
    for (let i = 0; i < SIZE; i++) {
      re[i] = (samples[start + i] ?? 0) * (window[i] ?? 0);
      im[i] = 0;
    }
    fft.transform(re, im);
    visit(re, im, start);
  }
}

/** Learns the noise from samples that hold only noise (all channels together). */
export function learnNoise(channels: readonly Float32Array[]): NoiseProfile {
  const bins = SIZE / 2 + 1;
  const magnitudes = new Float32Array(bins);
  let count = 0;
  for (const channel of channels) {
    if (channel.length < SIZE) continue;
    frames(channel, (re, im, start) => {
      // Only frames that lie wholly inside the noise.
      if (start < 0 || start + SIZE > channel.length) return;
      for (let k = 0; k < bins; k++) {
        magnitudes[k] = (magnitudes[k] ?? 0) + Math.hypot(re[k] ?? 0, im[k] ?? 0);
      }
      count++;
    });
  }
  if (count === 0) {
    throw new RangeError(
      `Noise reduction needs at least ${String(Math.ceil((SIZE / 48_000) * 1000))} ms of noise to learn from.`,
    );
  }
  for (let k = 0; k < bins; k++) magnitudes[k] = (magnitudes[k] ?? 0) / count;
  return { size: SIZE, magnitudes };
}

/** Turns the noise down in each channel, returning new samples of the same length. */
export function denoise(
  channels: readonly Float32Array[],
  profile: NoiseProfile,
  settings: DenoiseSettings,
): Float32Array[] {
  const bins = SIZE / 2 + 1;
  const floor = 10 ** (-Math.max(0, settings.reductionDb) / 20);
  const threshold = Float64Array.from(
    profile.magnitudes,
    (m) => m * 10 ** (settings.sensitivityDb / 20),
  );
  // A gain may fall back towards the floor only this fast, frame to frame (about 100 ms to the floor).
  const framesToFloor = Math.max(1, Math.round((0.1 * 48_000) / HOP));
  const fall = floor ** (1 / framesToFloor);
  const fft = new Fft(SIZE);
  const window = sqrtHann();
  return channels.map((channel) => {
    const out = new Float64Array(channel.length + SIZE);
    const previous = new Float64Array(bins).fill(1);
    const raw = new Float64Array(bins);
    const gains = new Float64Array(bins);
    frames(channel, (re, im, start) => {
      for (let k = 0; k < bins; k++) {
        raw[k] = Math.hypot(re[k] ?? 0, im[k] ?? 0) > (threshold[k] ?? 0) ? 1 : floor;
      }
      for (let k = 0; k < bins; k++) {
        // Across frequency: the mean in dB of the bin and its neighbours, so a
        // lone noise peak that passed the gate does not open its neighbours.
        let sum = 0;
        let n = 0;
        for (let j = Math.max(0, k - 2); j <= Math.min(bins - 1, k + 2); j++) {
          sum += Math.log(raw[j] ?? 1);
          n++;
        }
        // Across time: rises at once, falls gently.
        const gain = Math.max(Math.exp(sum / n), (previous[k] ?? 1) * fall, floor);
        gains[k] = gain;
        previous[k] = gain;
      }
      for (let k = 0; k < SIZE; k++) {
        const gain = gains[k < bins ? k : SIZE - k] ?? 1;
        re[k] = (re[k] ?? 0) * gain;
        im[k] = (im[k] ?? 0) * gain;
      }
      fft.transform(re, im, true);
      for (let i = 0; i < SIZE; i++) {
        const at = start + i + SIZE;
        if (at >= 0 && at < out.length) out[at] = (out[at] ?? 0) + (re[i] ?? 0) * (window[i] ?? 0);
      }
    });
    // Hann windows at a quarter overlap add up to 2.
    return Float32Array.from(out.subarray(SIZE, SIZE + channel.length), (v) => v / 2);
  });
}
