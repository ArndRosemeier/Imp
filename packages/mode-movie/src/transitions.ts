import type { TransitionKind } from './schema.js';

/**
 * Transitions between pieces of the picture, worked out without drawing. A
 * dissolve or a wipe lays the next piece over the end of the one before for
 * its length, so the scene grows shorter by it, as in any editor: pictures
 * that overlap are both seen. A dip fades the piece before to black or white
 * and the next one up from it, without overlapping. The Edit preview, the
 * film renderer and the scene's sound all take their timing from here.
 */

const round = (seconds: number): number => Math.round(seconds * 1000) / 1000;

/** Whether a transition lays the next picture over the last one. */
export const overlaps = (kind: TransitionKind): boolean => kind === 'dissolve' || kind === 'wipe';

/**
 * How far a piece starts before the one before it ends: its transition's
 * length, but at most half of either piece, so that neither is wholly covered.
 */
export function overlapSeconds(
  kind: TransitionKind,
  seconds: number,
  beforeSeconds: number,
  ownSeconds: number,
): number {
  if (!overlaps(kind) || beforeSeconds <= 0 || ownSeconds <= 0) return 0;
  return round(Math.max(0, Math.min(seconds, beforeSeconds / 2, ownSeconds / 2)));
}

/** A dip at one edge of a piece: the colour it fades to or from and for how long. */
export interface Dip {
  readonly color: 'black' | 'white';
  readonly seconds: number;
}

/** The half of a dip that falls on each side of the cut, or null for no dip. */
export function dipOf(kind: TransitionKind, seconds: number, ownSeconds: number): Dip | null {
  if (kind !== 'dip-black' && kind !== 'dip-white') return null;
  if (ownSeconds <= 0) return null;
  return {
    color: kind === 'dip-black' ? 'black' : 'white',
    seconds: round(Math.max(0, Math.min(seconds / 2, ownSeconds / 2))),
  };
}

/** What lies over a piece at its edges: its own fades to black and the dips of its cuts. */
export interface Edges {
  readonly fadeInSeconds: number;
  readonly fadeOutSeconds: number;
  readonly dipIn: Dip | null;
  readonly dipOut: Dip | null;
}

const ramp = (seconds: number, left: number): number =>
  seconds > 0 ? Math.min(1, Math.max(0, left / seconds)) : 1;

/**
 * How much black and white lie over a piece a number of seconds into it,
 * each from 0 (none) to 1 (all), for a piece that lasts length seconds.
 */
export function shadeAt(
  edges: Edges,
  since: number,
  length: number,
): { black: number; white: number } {
  const until = length - since;
  let black = 1 - ramp(edges.fadeInSeconds, since) * ramp(edges.fadeOutSeconds, until);
  let white = 0;
  for (const [dip, left] of [
    [edges.dipIn, since],
    [edges.dipOut, until],
  ] as const) {
    if (dip === null || dip.seconds <= 0) continue;
    const amount = 1 - ramp(dip.seconds, left);
    if (dip.color === 'black') black = Math.max(black, amount);
    else white = Math.max(white, amount);
  }
  return { black: Math.min(1, Math.max(0, black)), white: Math.min(1, Math.max(0, white)) };
}

/** How far a dissolve or wipe into a piece has come, 0 to 1, a number of seconds into it. */
export function transitionShare(overlap: number, since: number): number {
  if (overlap <= 0) return 1;
  return Math.min(1, Math.max(0, since / overlap));
}
