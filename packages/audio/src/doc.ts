import { z } from 'zod';
import type { StereoPcm } from './pcm.js';
import { SoundPlacement } from './placement.js';
import { dbToGain, panGains, placementSpan, renderBlock } from './render.js';
import { snapSeconds, toFrames, toSeconds } from './time.js';

/** One lane of an audio document: regions that play on it, and its own level and pan. */
export const Track = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  gainDb: z.number().min(-60).max(24).default(0),
  pan: z.number().min(-1).max(1).default(0),
  mute: z.boolean().default(false),
  solo: z.boolean().default(false),
  regions: z.array(SoundPlacement).default([]),
});
export type Track = z.infer<typeof Track>;

/** A named point in time, for cues and notes. */
export const Marker = z.object({
  id: z.string(),
  atSeconds: z.number().min(0),
  label: z.string().max(80),
});
export type Marker = z.infer<typeof Marker>;

/** What the audio editor edits: tracks of regions that point into stored sound. */
export const AudioDoc = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  tracks: z.array(Track).default([]),
  markers: z.array(Marker).default([]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AudioDoc = z.infer<typeof AudioDoc>;

/** The shortest piece an edit keeps; anything shorter is a rounding remainder. */
const MIN_SECONDS = 1 / 48_000;

/**
 * How long a region plays. Regions the editor makes always carry their
 * duration; one without (from an older placement) counts as zero until its
 * source is measured.
 */
export function regionDuration(region: SoundPlacement): number {
  return region.durationSeconds ?? 0;
}

export function regionEnd(region: SoundPlacement): number {
  return region.startSeconds + regionDuration(region);
}

/** Where the document ends: the end of its last region. */
export function docDuration(doc: AudioDoc): number {
  return Math.max(0, ...doc.tracks.flatMap((track) => track.regions.map(regionEnd)));
}

type NewId = () => string;

/**
 * Splits a region at a time inside it. The left part keeps the id and its
 * fade in; the right part gets a new id and keeps the fade out. Returns the
 * region whole when the time is not inside it.
 */
export function splitRegion(region: SoundPlacement, at: number, newId: NewId): SoundPlacement[] {
  const cut = snapSeconds(at);
  const end = regionEnd(region);
  if (cut - region.startSeconds < MIN_SECONDS || end - cut < MIN_SECONDS) return [region];
  const leftLength = snapSeconds(cut - region.startSeconds);
  return [
    { ...region, durationSeconds: leftLength, fadeOutSeconds: 0 },
    {
      ...region,
      id: newId(),
      startSeconds: cut,
      trimStartSeconds: snapSeconds(region.trimStartSeconds + leftLength),
      durationSeconds: snapSeconds(end - cut),
      fadeInSeconds: 0,
    },
  ];
}

/** Removes what lies between two times, leaving the rest where it is. */
export function silenceRange(
  regions: readonly SoundPlacement[],
  from: number,
  to: number,
  newId: NewId,
): SoundPlacement[] {
  const a = snapSeconds(from);
  const b = snapSeconds(to);
  return regions.flatMap((region) => {
    if (regionEnd(region) <= a || region.startSeconds >= b) return [region];
    return splitRegion(region, a, newId)
      .flatMap((piece) => splitRegion(piece, b, newId))
      .filter((piece) => piece.startSeconds < a || piece.startSeconds >= b);
  });
}

/** Removes what lies between two times and closes the gap, as Delete does in an audio editor. */
export function deleteRange(
  regions: readonly SoundPlacement[],
  from: number,
  to: number,
  newId: NewId,
): SoundPlacement[] {
  const a = snapSeconds(from);
  const b = snapSeconds(to);
  const gap = b - a;
  return silenceRange(regions, a, b, newId).map((region) =>
    region.startSeconds >= b
      ? { ...region, startSeconds: snapSeconds(region.startSeconds - gap) }
      : region,
  );
}

/** Opens a gap at a time, moving everything from there on later. */
export function insertSilence(
  regions: readonly SoundPlacement[],
  at: number,
  seconds: number,
  newId: NewId,
): SoundPlacement[] {
  const t = snapSeconds(at);
  const gap = snapSeconds(seconds);
  return regions
    .flatMap((region) => splitRegion(region, t, newId))
    .map((region) =>
      region.startSeconds >= t
        ? { ...region, startSeconds: snapSeconds(region.startSeconds + gap) }
        : region,
    );
}

/** The pieces between two times, placed from 0, for the clipboard. */
export function copyRange(
  regions: readonly SoundPlacement[],
  from: number,
  to: number,
  newId: NewId,
): SoundPlacement[] {
  const a = snapSeconds(from);
  const b = snapSeconds(to);
  return regions
    .filter((region) => regionEnd(region) > a && region.startSeconds < b)
    .flatMap((region) => splitRegion(region, a, newId))
    .flatMap((piece) => splitRegion(piece, b, newId))
    .filter((piece) => piece.startSeconds >= a && piece.startSeconds < b)
    .map((piece) => ({ ...piece, id: newId(), startSeconds: snapSeconds(piece.startSeconds - a) }));
}

/** Puts clipboard pieces in at a time, moving what follows later by the clipboard's length. */
export function pasteAt(
  regions: readonly SoundPlacement[],
  clip: readonly SoundPlacement[],
  at: number,
  seconds: number,
  newId: NewId,
): SoundPlacement[] {
  const t = snapSeconds(at);
  const opened = insertSilence(regions, t, seconds, newId);
  const pasted = clip.map((piece) => ({
    ...piece,
    id: newId(),
    startSeconds: snapSeconds(piece.startSeconds + t),
  }));
  return [...opened, ...pasted].sort((x, y) => x.startSeconds - y.startSeconds);
}

/**
 * Mixes a whole document into one block: each track's regions through the
 * shared renderer, then the track's gain and pan; muted tracks are left out,
 * and when any track is soloed only soloed tracks play.
 */
export function renderDoc(
  doc: AudioDoc,
  source: (region: SoundPlacement) => StereoPcm | undefined,
  startFrame: number,
  frames: number,
): [Float32Array, Float32Array] {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const soloing = doc.tracks.some((track) => track.solo);
  const endFrame = toFrames(docDuration(doc));
  for (const track of doc.tracks) {
    if (track.mute || (soloing && !track.solo)) continue;
    const [trackLeft, trackRight] = renderBlock(
      { placements: track.regions, source, endFrame },
      startFrame,
      frames,
    );
    const gain = dbToGain(track.gainDb);
    const [panLeft, panRight] = panGains(track.pan);
    for (let i = 0; i < frames; i++) {
      left[i] = (left[i] ?? 0) + (trackLeft[i] ?? 0) * gain * panLeft;
      right[i] = (right[i] ?? 0) + (trackRight[i] ?? 0) * gain * panRight;
    }
  }
  return [left, right];
}

/** Fills in a region's missing duration from its source's length, so edits can reason about its end. */
export function withDuration(region: SoundPlacement, source: StereoPcm): SoundPlacement {
  if (region.durationSeconds !== null) return region;
  const span = placementSpan(region, source, Number.MAX_SAFE_INTEGER);
  return {
    ...region,
    durationSeconds: span === undefined ? null : toSeconds(span.end - span.start),
  };
}
