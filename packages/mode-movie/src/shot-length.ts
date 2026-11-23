import type { Shot } from './schema.js';

/** Rough speaking time when the file's length cannot be read: about 2.5 words a second. */
export function spokenSeconds(line: string): number {
  return Math.max(1, line.trim().split(/\s+/).length / 2.5);
}

/** How long a shot holds in the cut when nothing else says: long enough to read. */
export const DEFAULT_SHOT_SECONDS = 4;

/**
 * Seconds a clip is made longer than its shot holds in the cut. Generated clips
 * settle in and run out slowly; the slack gives the edit room to cut in late and
 * out early, at the best moment, instead of playing every clip whole.
 */
export const CLIP_SLACK_SECONDS = 1.5;

/**
 * The least a shot must hold for its line to be heard whole: the recording plus
 * half a second when it is laid over the clip, otherwise the words at speaking
 * pace plus a beat. Zero for a shot without a line.
 */
export function speechSeconds(shot: Shot, voiceApart: boolean): number {
  if (shot.speakerId === null || shot.line.trim() === '') return 0;
  if (voiceApart && typeof shot.dialogue?.durationSeconds === 'number') {
    return shot.dialogue.durationSeconds + 0.5;
  }
  return spokenSeconds(shot.line) + 1;
}

/**
 * How long a shot is planned to hold in the cut: its planned length, never
 * shorter than its line. Null when nobody planned one, so the edit knows not to
 * trim by it.
 */
export function plannedShotSeconds(shot: Shot, voiceApart: boolean): number | null {
  if (shot.lengthSeconds === null) return null;
  return Math.max(shot.lengthSeconds, speechSeconds(shot, voiceApart));
}

/**
 * The seconds to ask the video model for: what the shot holds (its plan, or its
 * line, or the default) and the slack for the edit.
 */
export function clipSecondsWanted(shot: Shot, voiceApart: boolean): number {
  const holds =
    plannedShotSeconds(shot, voiceApart) ??
    Math.max(speechSeconds(shot, voiceApart), DEFAULT_SHOT_SECONDS);
  return Math.ceil(holds + CLIP_SLACK_SECONDS);
}
