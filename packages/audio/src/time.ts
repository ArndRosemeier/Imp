/**
 * The rate everything is mixed at. Sources at other rates are converted once,
 * when they are decoded, so every edit lands on the same grid.
 */
export const SAMPLE_RATE = 48_000;

/** Seconds to whole frames at the engine rate. */
export function toFrames(seconds: number): number {
  return Math.round(seconds * SAMPLE_RATE);
}

/** Frames at the engine rate to seconds. */
export function toSeconds(frames: number): number {
  return frames / SAMPLE_RATE;
}

/**
 * Moves a time onto the sample grid. Edits store seconds, as the Edit stage
 * does, and snap them with this, so a cut never falls between two samples and
 * repeated edits never drift.
 */
export function snapSeconds(seconds: number): number {
  return toSeconds(toFrames(seconds));
}
