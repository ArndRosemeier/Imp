const RATES = [24, 25, 30, 50, 60] as const;

/** The brightness of a picture at a time: faded up from black and down to black at its edges. */
export function fadeLevel(fadeIn: number, fadeOut: number, since: number, until: number): number {
  const up = fadeIn > 0 ? Math.min(1, since / fadeIn) : 1;
  const down = fadeOut > 0 ? Math.min(1, until / fadeOut) : 1;
  return Math.max(0, Math.min(1, up * down));
}

/** The standard rate nearest to a measured one (23.976 plays as 24, 29.97 as 30). */
export function nearestRate(measured: number): number {
  let best: number = RATES[0];
  for (const rate of RATES) if (Math.abs(rate - measured) < Math.abs(best - measured)) best = rate;
  return best;
}

const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);

/**
 * The frame size and rate of the film: as asked, or taken from the clips. The
 * size follows the largest clip, the rate the one that plays longest.
 */
export function chooseFormat(
  clips: readonly { width: number; height: number; fps: number; seconds: number }[],
  height: number | null,
  fps: number | null,
): { width: number; height: number; fps: number } {
  const largest = clips.reduce<{ width: number; height: number } | undefined>(
    (best, clip) =>
      best === undefined || clip.width * clip.height > best.width * best.height ? clip : best,
    undefined,
  );
  const aspect = largest === undefined ? 16 / 9 : largest.width / largest.height;
  const h = Math.min(2160, height ?? largest?.height ?? 720);
  const byRate = new Map<number, number>();
  for (const clip of clips) {
    const rate = nearestRate(clip.fps);
    byRate.set(rate, (byRate.get(rate) ?? 0) + clip.seconds);
  }
  const common = [...byRate.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return { width: even(h * aspect), height: even(h), fps: fps ?? common ?? 30 };
}
