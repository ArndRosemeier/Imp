import { z } from 'zod';
import { regionEnd } from './doc.js';
import type { SoundPlacement } from './placement.js';
import { snapSeconds } from './time.js';

/** One word as heard, in seconds of the source file. */
export const SourceWord = z.object({
  text: z.string(),
  startSeconds: z.number().min(0),
  endSeconds: z.number().min(0),
});
export type SourceWord = z.infer<typeof SourceWord>;

/**
 * What is said in a stored sound, kept beside the file. It belongs to the
 * file, not to a region, so every region that plays part of the file (after
 * splits, trims and cuts) finds its words in it.
 */
export const Transcript = z.object({
  model: z.string(),
  language: z.string().nullable(),
  text: z.string(),
  /** How long the source is, so looping regions find their words in each pass. */
  durationSeconds: z.number().positive(),
  words: z.array(SourceWord),
  createdAt: z.iso.datetime(),
});
export type Transcript = z.infer<typeof Transcript>;

/** A word where it plays in a document, in seconds of the document. */
export interface PlacedWord {
  readonly text: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
}

/**
 * The words a region plays, in document time and in order. A word counts
 * when its middle is heard, so a trim through a word keeps it with the part
 * that holds most of it.
 */
export function placeWords(region: SoundPlacement, transcript: Transcript): PlacedWord[] {
  const start = region.startSeconds;
  const end = regionEnd(region);
  const placed: PlacedWord[] = [];
  // A looping region plays its source again from the start after each pass.
  const passes = region.loop ? Math.ceil((end - start) / transcript.durationSeconds) + 1 : 1;
  for (let pass = 0; pass < passes; pass++) {
    const offset =
      start - region.trimStartSeconds + (pass === 0 ? 0 : pass * transcript.durationSeconds);
    for (const word of transcript.words) {
      const from = word.startSeconds + offset;
      const to = word.endSeconds + offset;
      const middle = (from + to) / 2;
      if (middle < start || middle >= end) continue;
      placed.push({
        text: word.text,
        startSeconds: Math.max(start, from),
        endSeconds: Math.min(end, to),
      });
    }
  }
  return placed;
}

/**
 * The stretch to remove for words `from` to `to` (inclusive) of a region,
 * cut in the middle of the pauses around them so that the words either side
 * keep their breath and the gap left behind sounds natural. With no word on
 * a side, the pause up to the region's edge goes too.
 */
export function wordSpan(
  words: readonly PlacedWord[],
  from: number,
  to: number,
  /** Where the region plays, in document time. */
  bounds: { readonly startSeconds: number; readonly endSeconds: number },
): { fromSeconds: number; toSeconds: number } {
  const first = words[from];
  const last = words[to];
  if (first === undefined || last === undefined || to < from) {
    throw new RangeError(
      `Choose words from 0 to ${String(words.length - 1)}, the first before the last.`,
    );
  }
  const before = words[from - 1];
  const after = words[to + 1];
  return {
    fromSeconds: snapSeconds(
      before === undefined ? bounds.startSeconds : (before.endSeconds + first.startSeconds) / 2,
    ),
    toSeconds: snapSeconds(
      after === undefined ? bounds.endSeconds : (last.endSeconds + after.startSeconds) / 2,
    ),
  };
}
