import type { CoreRuntime } from '@imp/core';
import type { MediaInput } from '@imp/providers';
import type { FrameGrabber } from './edit-review.js';
import type { Clip, KeyFrame, Shot } from './schema.js';

/** How wide the last frame of a clip is taken, to start the next clip or guide its key frame. */
const LAST_FRAME_WIDTH = 1280;

/** The shot before this one in its scene, or undefined for the first. */
export function shotBefore(shots: readonly Shot[], shot: Shot): Shot | undefined {
  return shots.filter((candidate) => candidate.position < shot.position).at(-1);
}

/** The end frame chosen for a shot, if any. */
export function chosenEndFrame(shot: Shot): KeyFrame | undefined {
  return shot.endFrames.find((frame) => frame.id === shot.endFrameId);
}

/**
 * The last frame of a ready clip as a picture, taken once and kept beside the
 * clip. Undefined when the clip is not ready or the host cannot read frames.
 */
export async function lastFrameOf(
  runtime: CoreRuntime,
  grab: FrameGrabber | undefined,
  clip: Clip | null,
): Promise<MediaInput | undefined> {
  if (clip?.status !== 'ready' || clip.blobKey === null) return undefined;
  const key = `${clip.blobKey}.last`;
  const kept = await runtime.blobs.get(key);
  if (kept !== undefined) return kept;
  if (grab === undefined) return undefined;
  const video = await runtime.blobs.get(clip.blobKey);
  if (video === undefined) return undefined;
  // The length asked for is not always the length made: try a little earlier too.
  const end = clip.durationSeconds ?? 4;
  const times = [end - 0.05, end - 0.25, end - 0.6].filter((seconds) => seconds > 0);
  const grabbed = await grab(video, times, LAST_FRAME_WIDTH).catch(() => []);
  const picture = grabbed.find((candidate) => candidate !== undefined);
  if (picture === undefined) return undefined;
  await runtime.blobs.put(key, picture);
  return picture;
}

/**
 * Why a continuing shot cannot be made yet, or null when it can: it carries on
 * from the clip of the shot before, so it waits for that clip.
 */
export function continuesProblem(shot: Shot, before: Shot | undefined): string | null {
  if (shot.join !== 'continues') return null;
  if (before === undefined) {
    return `Shot ${String(shot.position)} is the first of its scene, so it continues nothing. Set its join to "cut".`;
  }
  const which = `shot ${String(before.position)}`;
  if (before.clip?.status === 'pending') {
    return `Shot ${String(shot.position)} continues ${which}, so it waits for that clip, which is being made. Check it with movie.shot.clip.check and make this one when it is ready.`;
  }
  if (before.clip?.status !== 'ready') {
    return `Shot ${String(shot.position)} continues ${which}, so it starts on the last frame of that clip. Make the clip of ${which} first.`;
  }
  return null;
}

/** Whether a continuing shot's clip was made from a clip of the shot before that has been replaced. */
export function outOfStep(shot: Shot, before: Shot | undefined): boolean {
  const from = shot.clip?.continuesFrom;
  if (from === null || from === undefined) return false;
  return before?.id !== from.shotId || before.clip?.blobKey !== from.clipKey;
}
