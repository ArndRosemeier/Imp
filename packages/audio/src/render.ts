import type { StereoPcm } from './pcm.js';
import { frameCount } from './pcm.js';
import type { FadeCurve, SoundPlacement } from './placement.js';
import { toFrames } from './time.js';

/** A placement's source, decoded for the engine; undefined while it is missing or unreadable. */
export type SourceLookup = (placement: SoundPlacement) => StereoPcm | undefined;

export interface MixInput {
  readonly placements: readonly SoundPlacement[];
  readonly source: SourceLookup;
  /** The length of the timeline in frames. Looping placements stop here. */
  readonly endFrame: number;
}

/** Where a placement sounds on the timeline, in frames, and the stretch of its source it plays. */
export interface PlacementSpan {
  readonly start: number;
  readonly end: number;
  /** The first source frame played, and how many follow before a loop starts over. */
  readonly sourceStart: number;
  readonly sourceLength: number;
}

/**
 * Works out where a placement plays. Without a duration it plays its source
 * to the end, or, looping, to the end of the timeline. A duration longer than
 * the source loops it when looping and stops at the source's end otherwise.
 */
export function placementSpan(
  placement: SoundPlacement,
  source: StereoPcm,
  endFrame: number,
): PlacementSpan | undefined {
  const start = toFrames(placement.startSeconds);
  const sourceStart = Math.min(toFrames(placement.trimStartSeconds), frameCount(source));
  const available = frameCount(source) - sourceStart;
  if (available <= 0) return undefined;
  const wanted = placement.durationSeconds === null ? null : toFrames(placement.durationSeconds);
  let length: number;
  if (placement.loop) {
    length = wanted ?? Math.max(0, endFrame - start);
  } else {
    length = Math.min(wanted ?? available, available);
  }
  if (length <= 0) return undefined;
  return { start, end: start + length, sourceStart, sourceLength: available };
}

function shape(curve: FadeCurve, x: number): number {
  return curve === 'linear' ? x : 0.5 - 0.5 * Math.cos(Math.PI * x);
}

/**
 * The gain of the fades at a point of the placement, 0 to 1. Fades that
 * overlap on a short placement multiply, so neither jumps.
 */
export function fadeGain(
  offset: number,
  length: number,
  fadeIn: number,
  fadeOut: number,
  curve: FadeCurve,
): number {
  const rise = fadeIn > 0 ? Math.min(1, offset / fadeIn) : 1;
  const fall = fadeOut > 0 ? Math.min(1, (length - offset) / fadeOut) : 1;
  return shape(curve, Math.max(0, rise)) * shape(curve, Math.max(0, fall));
}

/**
 * Left and right gains for a pan position. A balance law: the middle leaves
 * both sides untouched, and moving one way lowers the other side, so a
 * placement at 0 plays exactly as recorded.
 */
export function panGains(pan: number): readonly [number, number] {
  return [pan > 0 ? 1 - pan : 1, pan < 0 ? 1 + pan : 1];
}

/**
 * Mixes the placements into one block of stereo samples. This is the one
 * renderer behind playback, analysis and export, so they always agree, and it
 * works block by block, so a long timeline never sits in memory whole.
 */
export function renderBlock(
  input: MixInput,
  startFrame: number,
  frames: number,
): [Float32Array, Float32Array] {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const blockEnd = startFrame + frames;
  for (const placement of input.placements) {
    const source = input.source(placement);
    if (source === undefined || placement.volume === 0) continue;
    const span = placementSpan(placement, source, input.endFrame);
    if (span === undefined || span.end <= startFrame || span.start >= blockEnd) continue;
    const length = span.end - span.start;
    const fadeIn = toFrames(placement.fadeInSeconds);
    const fadeOut = toFrames(placement.fadeOutSeconds);
    const [panLeft, panRight] = panGains(placement.pan);
    const [sourceLeft, sourceRight] = source.channels;
    const from = Math.max(span.start, startFrame);
    const to = Math.min(span.end, blockEnd);
    for (let frame = from; frame < to; frame++) {
      const offset = frame - span.start;
      const at = span.sourceStart + (offset % span.sourceLength);
      const gain =
        placement.volume * fadeGain(offset, length, fadeIn, fadeOut, placement.fadeCurve);
      const index = frame - startFrame;
      left[index] = (left[index] ?? 0) + (sourceLeft[at] ?? 0) * gain * panLeft;
      right[index] = (right[index] ?? 0) + (sourceRight[at] ?? 0) * gain * panRight;
    }
  }
  return [left, right];
}
