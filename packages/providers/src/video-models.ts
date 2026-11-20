import type { ModelInfo, VideoAbilities } from './types.js';

/** The picture shape films are made in. */
const FILM_ASPECT_RATIO = '16:9';

export interface VideoModelNotes {
  /** Whether the model makes clips from a description at the shape of a film. */
  readonly fits: boolean;
  /** Why it does not, in words for a person. Null when it does. */
  readonly problem: string | null;
  /** Short labels of what it can do, for a picker. */
  readonly notes: readonly string[];
}

/** `4, 6, 8` becomes `4, 6, 8 s` and `4, 5, 6, 7, 8` becomes `4–8 s`. */
function lengths(seconds: readonly number[]): string {
  const sorted = [...seconds].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted.at(-1);
  if (first === undefined || last === undefined) return '';
  const run = last - first + 1 === sorted.length && sorted.length > 3;
  return `${run ? `${String(first)}–${String(last)}` : sorted.join(', ')} s`;
}

/**
 * What a video model can do for a film, from what it reports about itself. A
 * model that reports nothing is given the benefit of the doubt: hiding every
 * model because a catalog was slow would be worse than listing one in vain.
 */
export function describeVideoModel(model: ModelInfo): VideoModelNotes {
  if (!model.outputModalities.includes('video')) {
    return { fits: false, problem: 'It makes no video.', notes: [] };
  }
  const video = model.video;
  if (video === undefined) return { fits: true, problem: null, notes: [] };
  const notes = [
    ...(video.durationsSeconds.length === 0 ? [] : [lengths(video.durationsSeconds)]),
    ...(video.nativeAudio === true ? ['own sound'] : video.nativeAudio === false ? ['silent'] : []),
    ...(video.frameImages.includes('first_frame') ? ['start picture'] : []),
  ];
  if (video.durationsSeconds.length === 0) {
    return {
      fits: false,
      problem:
        'It works on a photo or an existing video, and makes no clips of a chosen length from a description.',
      notes,
    };
  }
  if (video.aspectRatios.length > 0 && !video.aspectRatios.includes(FILM_ASPECT_RATIO)) {
    return { fits: false, problem: `It cannot make ${FILM_ASPECT_RATIO} pictures.`, notes };
  }
  return { fits: true, problem: null, notes };
}

/**
 * The length to ask for: the shortest the model makes that is at least as long
 * as wanted, or the longest it makes when none is long enough. Without known
 * lengths, what was wanted.
 */
export function fitDuration(video: VideoAbilities | undefined, wanted: number): number {
  const lengths = [...(video?.durationsSeconds ?? [])].sort((a, b) => a - b);
  return lengths.find((seconds) => seconds >= wanted) ?? lengths.at(-1) ?? wanted;
}

const RESOLUTION_NAMES: Record<string, number> = { '2K': 1440, '4K': 2160 };

function lines(resolution: string): number | undefined {
  const named = RESOLUTION_NAMES[resolution.toUpperCase()];
  if (named !== undefined) return named;
  const match = /^(\d+)p$/i.exec(resolution);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** The resolution to ask for: the one wanted, or else the nearest the model makes, the lower on a tie. */
export function fitResolution(video: VideoAbilities | undefined, wanted: string): string {
  const known = video?.resolutions ?? [];
  if (known.length === 0 || known.includes(wanted)) return wanted;
  const target = lines(wanted);
  if (target === undefined) return known[0] ?? wanted;
  return (
    known
      .map((resolution) => ({ resolution, lines: lines(resolution) }))
      .filter((entry): entry is { resolution: string; lines: number } => entry.lines !== undefined)
      .sort(
        (a, b) => Math.abs(a.lines - target) - Math.abs(b.lines - target) || a.lines - b.lines,
      )[0]?.resolution ??
    known[0] ??
    wanted
  );
}
