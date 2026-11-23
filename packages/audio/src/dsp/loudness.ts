import { filter, type Biquad } from './biquad.js';

/**
 * Loudness as broadcasters measure it (ITU-R BS.1770-4, EBU R 128): the
 * K-weighted, gated loudness in LUFS, the loudest 3-second stretch, the
 * loudness range, and the true peak, which catches peaks between samples.
 */

export interface LoudnessReport {
  /** Integrated loudness over the whole sound, in LUFS. -Infinity for silence. */
  readonly integratedLufs: number;
  /** The loudest 3-second stretch, in LUFS. */
  readonly shortTermMaxLufs: number;
  /** How much the loudness moves, in LU (EBU Tech 3342). */
  readonly rangeLu: number;
  /** The highest peak, including between samples, in dBTP. */
  readonly truePeakDb: number;
  /** The highest sample, in dBFS. */
  readonly samplePeakDb: number;
}

// The K-weighting filters at 48 kHz, as given in BS.1770.
const SHELF: Biquad = {
  b0: 1.53512485958697,
  b1: -2.69169618940638,
  b2: 1.19839281085285,
  a1: -1.69065929318241,
  a2: 0.73248077421585,
};
const HIGHPASS: Biquad = { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 };

const ABSOLUTE_GATE = -70;
const toLufs = (power: number): number =>
  power <= 0 ? -Infinity : -0.691 + 10 * Math.log10(power);

/** Mean squares of K-weighted blocks, summed over channels (all weighted 1, as for stereo). */
function blockPowers(
  channels: readonly Float32Array[],
  sampleRate: number,
  blockSeconds: number,
  stepSeconds: number,
): number[] {
  const weighted = channels.map((channel) => filter(filter(channel, SHELF), HIGHPASS));
  const length = channels[0]?.length ?? 0;
  const block = Math.round(blockSeconds * sampleRate);
  const step = Math.round(stepSeconds * sampleRate);
  // Running sums of squares make every block a subtraction.
  const sums = new Float64Array(length + 1);
  for (let i = 0; i < length; i++) {
    let square = 0;
    for (const channel of weighted) square += (channel[i] ?? 0) ** 2;
    sums[i + 1] = (sums[i] ?? 0) + square;
  }
  const powers: number[] = [];
  for (let start = 0; start + block <= length; start += step) {
    powers.push(((sums[start + block] ?? 0) - (sums[start] ?? 0)) / block);
  }
  return powers;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

/** Integrated loudness with the absolute and relative gates. */
function integrated(powers: readonly number[]): number {
  const loud = powers.filter((power) => toLufs(power) > ABSOLUTE_GATE);
  if (loud.length === 0) return -Infinity;
  const relative = toLufs(mean(loud)) - 10;
  const kept = loud.filter((power) => toLufs(power) > relative);
  return toLufs(mean(kept));
}

/** The loudness range: the spread between the 10th and 95th percentile of short-term loudness. */
function range(powers: readonly number[]): number {
  const loud = powers.filter((power) => toLufs(power) > ABSOLUTE_GATE);
  if (loud.length === 0) return 0;
  const relative = toLufs(mean(loud)) - 20;
  const kept = loud
    .map(toLufs)
    .filter((lufs) => lufs > relative)
    .sort((a, b) => a - b);
  if (kept.length === 0) return 0;
  const at = (q: number): number =>
    kept[Math.min(kept.length - 1, Math.round(q * (kept.length - 1)))] ?? 0;
  return at(0.95) - at(0.1);
}

/** Taps of the 4x oversampling filter for true peak: a windowed sinc. */
const PHASES = 4;
const TAPS_PER_PHASE = 12;
const OVERSAMPLE: Float64Array[] = Array.from({ length: PHASES }, (_, phase) =>
  Float64Array.from({ length: TAPS_PER_PHASE }, (_, tap) => {
    const x = tap - TAPS_PER_PHASE / 2 + 1 - phase / PHASES;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const n = (x + TAPS_PER_PHASE / 2) / TAPS_PER_PHASE;
    const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * n) + 0.08 * Math.cos(4 * Math.PI * n);
    return sinc * window;
  }),
);

/** The highest absolute value of the sound upsampled four times. */
export function truePeak(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      peak = Math.max(peak, Math.abs(channel[i] ?? 0));
      for (const taps of OVERSAMPLE.slice(1)) {
        let sum = 0;
        for (let tap = 0; tap < TAPS_PER_PHASE; tap++) {
          sum += (channel[i + tap - TAPS_PER_PHASE / 2 + 1] ?? 0) * (taps[tap] ?? 0);
        }
        peak = Math.max(peak, Math.abs(sum));
      }
    }
  }
  return peak;
}

const toDb = (level: number): number => (level <= 0 ? -Infinity : 20 * Math.log10(level));

/** Measures loudness. The K-weighting is defined at 48 kHz, the engine rate. */
export function measureLoudness(
  channels: readonly Float32Array[],
  sampleRate = 48_000,
): LoudnessReport {
  const momentary = blockPowers(channels, sampleRate, 0.4, 0.1);
  const shortTerm = blockPowers(channels, sampleRate, 3, 0.1);
  // A sound shorter than one block is measured as one block over its whole length.
  const whole =
    momentary.length === 0 && (channels[0]?.length ?? 0) > 0
      ? blockPowers(channels, sampleRate, (channels[0]?.length ?? 0) / sampleRate, 1)
      : [];
  let samplePeak = 0;
  for (const channel of channels) {
    for (const sample of channel) samplePeak = Math.max(samplePeak, Math.abs(sample));
  }
  const shortMax = (
    shortTerm.length > 0 ? shortTerm : momentary.length > 0 ? momentary : whole
  ).reduce((max, power) => Math.max(max, power), 0);
  return {
    integratedLufs: integrated(momentary.length > 0 ? momentary : whole),
    shortTermMaxLufs: toLufs(shortMax),
    rangeLu: range(shortTerm),
    truePeakDb: toDb(truePeak(channels)),
    samplePeakDb: toDb(samplePeak),
  };
}

/**
 * Integrated loudness measured as the sound streams past, a stretch at a
 * time, for sounds too long to hold at once, such as the mix of a whole film.
 * It keeps the filters' state between stretches and the power of every 100 ms,
 * from which the gated 400 ms blocks are built at the end. Peaks are sample
 * peaks: true peak over a feature film would take too long.
 */
export class LoudnessMeter {
  readonly #sub: number;
  readonly #state: Float64Array[] = [];
  readonly #powers: number[] = [];
  #sum = 0;
  #count = 0;
  #peak = 0;

  constructor(sampleRate = 48_000) {
    this.#sub = Math.round(sampleRate / 10);
  }

  /** Feeds the next stretch: one array per channel, all the same length. */
  push(channels: readonly Float32Array[]): void {
    const length = channels[0]?.length ?? 0;
    channels.forEach((_, index) => {
      this.#state[index] ??= new Float64Array(8);
    });
    for (let i = 0; i < length; i++) {
      let square = 0;
      for (const [index, channel] of channels.entries()) {
        const x = channel[i] ?? 0;
        this.#peak = Math.max(this.#peak, Math.abs(x));
        const state = this.#state[index] ?? new Float64Array(8);
        // Two biquads in a row, direct form I: x1 x2 y1 y2 for each.
        const y =
          SHELF.b0 * x +
          SHELF.b1 * (state[0] ?? 0) +
          SHELF.b2 * (state[1] ?? 0) -
          SHELF.a1 * (state[2] ?? 0) -
          SHELF.a2 * (state[3] ?? 0);
        state[1] = state[0] ?? 0;
        state[0] = x;
        state[3] = state[2] ?? 0;
        state[2] = y;
        const z =
          HIGHPASS.b0 * y +
          HIGHPASS.b1 * (state[4] ?? 0) +
          HIGHPASS.b2 * (state[5] ?? 0) -
          HIGHPASS.a1 * (state[6] ?? 0) -
          HIGHPASS.a2 * (state[7] ?? 0);
        state[5] = state[4] ?? 0;
        state[4] = y;
        state[7] = state[6] ?? 0;
        state[6] = z;
        square += z * z;
      }
      this.#sum += square;
      this.#count += 1;
      if (this.#count === this.#sub) {
        this.#powers.push(this.#sum / this.#sub);
        this.#sum = 0;
        this.#count = 0;
      }
    }
  }

  /** The integrated loudness so far, in LUFS, and the highest sample in dBFS. */
  result(): { integratedLufs: number; samplePeakDb: number } {
    const subs =
      this.#powers.length === 0 && this.#count > 0 ? [this.#sum / this.#count] : this.#powers;
    // 400 ms blocks, overlapping by 75 %: four 100 ms parts each, a part apart.
    const blocks: number[] = [];
    for (let start = 0; start + 4 <= subs.length; start++) {
      blocks.push(
        ((subs[start] ?? 0) +
          (subs[start + 1] ?? 0) +
          (subs[start + 2] ?? 0) +
          (subs[start + 3] ?? 0)) /
          4,
      );
    }
    return {
      integratedLufs: integrated(blocks.length > 0 ? blocks : subs.length > 0 ? [mean(subs)] : []),
      samplePeakDb: toDb(this.#peak),
    };
  }
}
