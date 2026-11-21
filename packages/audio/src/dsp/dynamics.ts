/**
 * Level control: a compressor that evens out loud and quiet passages, and a
 * look-ahead limiter that keeps peaks under a ceiling. Both read both
 * channels together, so the stereo image never shifts.
 */

export interface CompressorSettings {
  /** Above this level (dBFS) the sound is turned down. */
  readonly thresholdDb: number;
  /** How strongly: 4 means 4 dB over the threshold comes out as 1 dB over. */
  readonly ratio: number;
  readonly attackMs: number;
  readonly releaseMs: number;
  /** Width of the soft knee around the threshold, in dB. */
  readonly kneeDb: number;
  /** Gain added afterwards, to win back the level taken off. */
  readonly makeupDb: number;
}

export interface LimiterSettings {
  /** The highest a sample may reach, in dBFS. */
  readonly ceilingDb: number;
  readonly releaseMs: number;
}

/** The smoothing factor of a one-pole follower with a time constant. */
function coefficient(ms: number, sampleRate: number): number {
  return ms <= 0 ? 0 : Math.exp(-1 / ((ms / 1000) * sampleRate));
}

const toDb = (level: number): number => 20 * Math.log10(Math.max(level, 1e-9));

/** How many dB a level over the threshold is taken down, with a soft knee. */
export function gainReductionDb(levelDb: number, settings: CompressorSettings): number {
  const over = levelDb - settings.thresholdDb;
  const knee = Math.max(0, settings.kneeDb);
  const slope = 1 - 1 / Math.max(1, settings.ratio);
  if (2 * over <= -knee) return 0;
  if (knee > 0 && 2 * Math.abs(over) < knee) {
    return (slope * (over + knee / 2) ** 2) / (2 * knee);
  }
  return slope * over;
}

/** Compresses stereo samples, returning new samples. */
export function compress(
  channels: readonly Float32Array[],
  sampleRate: number,
  settings: CompressorSettings,
): Float32Array[] {
  const attack = coefficient(settings.attackMs, sampleRate);
  const release = coefficient(settings.releaseMs, sampleRate);
  const makeup = 10 ** (settings.makeupDb / 20);
  const length = channels[0]?.length ?? 0;
  const out = channels.map(() => new Float32Array(length));
  // A peak follower: it rises with the attack and falls with the release, so
  // it holds the level of a wave across its cycles instead of following each one.
  let level = 0;
  for (let i = 0; i < length; i++) {
    let peak = 0;
    for (const channel of channels) peak = Math.max(peak, Math.abs(channel[i] ?? 0));
    const k = peak > level ? attack : release;
    level = k * level + (1 - k) * peak;
    const gain = 10 ** (-gainReductionDb(toDb(level), settings) / 20) * makeup;
    out.forEach((samples, c) => {
      samples[i] = (channels[c]?.[i] ?? 0) * gain;
    });
  }
  return out;
}

/** The look-ahead of the limiter: long enough to catch a peak before it arrives. */
const LOOKAHEAD_MS = 5;

/**
 * Limits stereo samples to a ceiling. It works on whole files, so it can look
 * ahead without delaying the sound: the gain is already down when a peak
 * arrives, nothing passes above the ceiling, and nothing is clipped.
 */
export function limit(
  channels: readonly Float32Array[],
  sampleRate: number,
  settings: LimiterSettings,
): Float32Array[] {
  const ceiling = 10 ** (settings.ceilingDb / 20);
  const ahead = Math.max(1, Math.round((LOOKAHEAD_MS / 1000) * sampleRate));
  const release = coefficient(settings.releaseMs, sampleRate);
  const length = channels[0]?.length ?? 0;
  // The gain each sample needs on its own.
  const needed = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let peak = 0;
    for (const channel of channels) peak = Math.max(peak, Math.abs(channel[i] ?? 0));
    needed[i] = peak > ceiling ? ceiling / peak : 1;
  }
  // The lowest gain in the window ahead, found with a monotonic queue.
  const windowMin = new Float32Array(length);
  const queue = new Int32Array(length + ahead + 1);
  let head = 0;
  let tail = 0;
  for (let i = length - 1; i >= 0; i--) {
    const value = needed[i] ?? 1;
    while (tail > head && (needed[queue[tail - 1] ?? 0] ?? 1) >= value) tail--;
    queue[tail++] = i;
    while ((queue[head] ?? 0) > i + ahead) head++;
    windowMin[i] = needed[queue[head] ?? i] ?? 1;
  }
  const out = channels.map(() => new Float32Array(length));
  // Falls straight to what the window needs; ramps down across the look-ahead
  // so the drop is smooth, and recovers with the release.
  let gain = 1;
  const step = 1 / ahead;
  for (let i = 0; i < length; i++) {
    const target = windowMin[i] ?? 1;
    if (target < gain) {
      gain = Math.max(target, gain - step * (1 - target));
      // Never above what this sample itself needs.
      gain = Math.min(gain, needed[i] ?? 1);
    } else {
      gain = Math.min(target, release * gain + (1 - release) * target);
    }
    out.forEach((samples, c) => {
      samples[i] = (channels[c]?.[i] ?? 0) * gain;
    });
  }
  return out;
}
