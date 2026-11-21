import type { TextAnchor, TextItem, TextKind, TextStyle } from './schema.js';

/**
 * The text lane worked out in time, without drawing: the styles a film starts
 * with, where anchored texts fall, how a text moves at a moment, how spoken
 * lines become subtitles, and subtitle files. Drawing is the host's (the
 * preview and the film renderer share one drawing function), so that what is
 * seen while editing is what the film shows.
 */

const round = (seconds: number): number => Math.round(seconds * 1000) / 1000;

/** The style of titles, and of any text whose style is gone. */
const TITLE_STYLE: TextStyle = {
  id: 'title',
  name: 'Title',
  font: 'serif',
  weight: 400,
  italic: false,
  uppercase: false,
  size: 9,
  tracking: 0,
  leading: 1.1,
  color: '#f5f1e8',
  outlineColor: '#000000',
  outline: 0,
  shadow: 0.55,
  boxColor: '#000000',
  box: 0,
  align: 'center',
  x: 0.5,
  y: 0.5,
  anchor: 'middle',
  width: 80,
  enter: 'fade',
  exit: 'fade',
  ease: 0.8,
  roll: false,
};

/** The styles every film starts with, one for each kind of text, with the kind's id. */
export const DEFAULT_TEXT_STYLES: readonly TextStyle[] = [
  TITLE_STYLE,
  {
    id: 'lower-third',
    name: 'Lower third',
    font: 'sans',
    weight: 600,
    italic: false,
    uppercase: false,
    size: 4.2,
    tracking: 0,
    leading: 1.25,
    color: '#ffffff',
    outlineColor: '#000000',
    outline: 0,
    shadow: 0.3,
    boxColor: '#0b0d12',
    box: 0.62,
    align: 'left',
    x: 0.07,
    y: 0.86,
    anchor: 'bottom',
    width: 50,
    enter: 'rise',
    exit: 'fade',
    ease: 0.35,
    roll: false,
  },
  {
    id: 'subtitle',
    name: 'Subtitle',
    font: 'sans',
    weight: 500,
    italic: false,
    uppercase: false,
    size: 4.6,
    tracking: 0,
    leading: 1.22,
    color: '#ffffff',
    outlineColor: '#000000',
    outline: 9,
    shadow: 0.45,
    boxColor: '#000000',
    box: 0,
    align: 'center',
    x: 0.5,
    y: 0.93,
    anchor: 'bottom',
    width: 82,
    enter: 'cut',
    exit: 'cut',
    ease: 0.08,
    roll: false,
  },
  {
    id: 'caption',
    name: 'Caption',
    font: 'mono',
    weight: 400,
    italic: false,
    uppercase: true,
    size: 3.4,
    tracking: 0.08,
    leading: 1.3,
    color: '#f2efe6',
    outlineColor: '#000000',
    outline: 0,
    shadow: 0.6,
    boxColor: '#000000',
    box: 0,
    align: 'left',
    x: 0.06,
    y: 0.08,
    anchor: 'top',
    width: 60,
    enter: 'type',
    exit: 'fade',
    ease: 0.4,
    roll: false,
  },
  {
    id: 'credits',
    name: 'Credits',
    font: 'serif',
    weight: 400,
    italic: false,
    uppercase: false,
    size: 4.4,
    tracking: 0,
    leading: 1.45,
    color: '#f5f1e8',
    outlineColor: '#000000',
    outline: 0,
    shadow: 0,
    boxColor: '#000000',
    box: 0,
    align: 'center',
    x: 0.5,
    y: 0.5,
    anchor: 'top',
    width: 70,
    enter: 'cut',
    exit: 'cut',
    ease: 0,
    roll: true,
  },
];

/** The style a new text of a kind gets: the style with the kind's id. */
export const styleIdFor = (kind: TextKind): string => kind;

/** The style a text is drawn in: its own, or its kind's, or the first there is. */
export function styleOf(
  styles: readonly TextStyle[],
  text: Pick<TextItem, 'styleId' | 'kind'>,
): TextStyle {
  return (
    styles.find((style) => style.id === text.styleId) ??
    styles.find((style) => style.id === styleIdFor(text.kind)) ??
    DEFAULT_TEXT_STYLES.find((style) => style.id === styleIdFor(text.kind)) ??
    TITLE_STYLE
  );
}

/** Something on the timeline a text can follow. */
export interface Span {
  readonly startsAtSeconds: number;
  readonly durationSeconds: number;
}

/** The pieces and lines of a cut that texts can be anchored to. */
export interface AnchorTargets {
  readonly items: readonly (Span & { readonly itemId: string })[];
  readonly spoken: readonly (Span & {
    readonly source: 'shot' | 'placement' | 'lane';
    readonly id: string;
    readonly who: string;
  })[];
}

/** A text as it falls in a cut: when it shows, and whether what it follows is still there. */
export interface PlacedText {
  readonly startSeconds: number;
  readonly durationSeconds: number;
  /** What it follows, in words, or null for a text with its own time. */
  readonly follows: string | null;
  /** It follows a piece or line that is gone from the cut; it is not shown in the film. */
  readonly orphaned: boolean;
}

/** Where an anchored text is: the share of its piece or line that it covers. */
export function placeText(
  text: Pick<TextItem, 'startSeconds' | 'durationSeconds' | 'anchor'>,
  targets: AnchorTargets,
): PlacedText {
  const anchor = text.anchor;
  if (anchor === null) {
    return {
      startSeconds: text.startSeconds,
      durationSeconds: text.durationSeconds,
      follows: null,
      orphaned: false,
    };
  }
  const found = findAnchor(anchor, targets);
  if (found === undefined || found.span.durationSeconds <= 0) {
    return {
      startSeconds: text.startSeconds,
      durationSeconds: text.durationSeconds,
      follows: found?.name ?? 'a piece that is no longer in the cut',
      orphaned: true,
    };
  }
  const { span } = found;
  const from = Math.min(anchor.from, anchor.to);
  const to = Math.max(anchor.from, anchor.to);
  return {
    startSeconds: round(span.startsAtSeconds + span.durationSeconds * from),
    durationSeconds: round(Math.max(0.2, span.durationSeconds * (to - from))),
    follows: found.name,
    orphaned: false,
  };
}

function findAnchor(
  anchor: TextAnchor,
  targets: AnchorTargets,
): { span: Span; name: string } | undefined {
  if (anchor.on === 'item') {
    const item = targets.items.find((candidate) => candidate.itemId === anchor.id);
    return item === undefined ? undefined : { span: item, name: 'its piece of the picture' };
  }
  const line = targets.spoken.find(
    (candidate) => candidate.source === anchor.on && candidate.id === anchor.id,
  );
  return line === undefined ? undefined : { span: line, name: `the line of ${line.who}` };
}

/** How a text looks at a moment of its time on screen. */
export interface TextMotion {
  /** 0 to 1. */
  readonly opacity: number;
  /** How far below its place it is, as a share of the frame height. */
  readonly drop: number;
  /** The share of its letters typed so far, 0 to 1. */
  readonly typed: number;
  /** For a roll, how far through the frame it has moved, 0 (below) to 1 (above); else null. */
  readonly roll: number | null;
}

const easeOut = (t: number): number => 1 - (1 - t) ** 3;
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * How a text comes on, stays and goes off: since is the seconds since it came
 * on, length how long it shows, letters how many it has (for typing).
 */
export function textMotion(
  style: Pick<TextStyle, 'enter' | 'exit' | 'ease' | 'roll'>,
  since: number,
  length: number,
  letters: number,
): TextMotion {
  const ease = Math.min(style.ease, length / 2);
  const left = length - since;
  const entering = ease <= 0 ? 1 : clamp01(since / ease);
  const leaving = ease <= 0 ? 1 : clamp01(left / ease);
  let opacity = 1;
  let drop = 0;
  let typed = 1;
  if (style.enter === 'fade' || style.enter === 'rise') opacity = entering;
  if (style.enter === 'rise') drop = (1 - easeOut(entering)) * 0.025;
  if (style.enter === 'type') {
    // About 28 letters a second, never longer than half the time on screen.
    const typing = Math.min(length / 2, Math.max(ease, letters / 28));
    typed = typing <= 0 ? 1 : clamp01(since / typing);
  }
  if (style.exit === 'fade') opacity = Math.min(opacity, leaving);
  return {
    opacity: clamp01(opacity),
    drop,
    typed,
    roll: style.roll ? clamp01(length <= 0 ? 1 : since / length) : null,
  };
}

/** One subtitle of a line: its words and the share of the line's time it covers. */
export interface Cue {
  readonly text: string;
  readonly from: number;
  readonly to: number;
}

/** About two lines of 42 letters, the common limit for one subtitle. */
export const CUE_LETTERS = 84;

function splitLong(sentence: string, limit: number): string[] {
  if (sentence.length <= limit) return [sentence];
  // Prefer the pauses a comma or a dash makes, then any space.
  const clauses = sentence.split(/(?<=[,;:–—])\s+/);
  const parts: string[] = [];
  for (const clause of clauses) {
    if (clause.length <= limit) {
      parts.push(clause);
      continue;
    }
    let line = '';
    for (const word of clause.split(/\s+/)) {
      const next = line === '' ? word : `${line} ${word}`;
      if (line !== '' && next.length > limit) {
        parts.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line !== '') parts.push(line);
  }
  return merge(parts, limit);
}

/** Puts neighbouring pieces together while they fit in one subtitle. */
function merge(pieces: readonly string[], limit: number): string[] {
  const cues: string[] = [];
  for (const piece of pieces) {
    const last = cues.at(-1);
    if (last !== undefined && last.length + 1 + piece.length <= limit) {
      cues[cues.length - 1] = `${last} ${piece}`;
    } else {
      cues.push(piece);
    }
  }
  return cues;
}

/**
 * A spoken line as subtitles: whole sentences while they fit, long ones broken
 * at pauses, each given a share of the line's time by its length.
 */
export function subtitleCues(line: string, limit = CUE_LETTERS): Cue[] {
  const words = line.replace(/\s+/g, ' ').trim();
  if (words === '') return [];
  const sentences = words.split(/(?<=[.!?…])\s+/);
  const texts = merge(
    sentences.flatMap((sentence) => splitLong(sentence, limit)),
    limit,
  );
  // A short pause after each cue counts, so that short cues are not flashed.
  const weights = texts.map((text) => text.length + 6);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let at = 0;
  return texts.map((text, index) => {
    const from = at / total;
    at += weights[index] ?? 0;
    return { text, from: round(from), to: index === texts.length - 1 ? 1 : round(at / total) };
  });
}

/** A subtitle in a file: when it shows, in seconds, and its words. */
export interface TimedCue {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly text: string;
}

function stamp(seconds: number, separator: ',' | '.'): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${two(hours)}:${two(minutes)}:${two(secs)}${separator}${String(rest).padStart(3, '0')}`;
}

/** Subtitles as a SubRip (.srt) file, which nearly every player and platform reads. */
export function toSrt(cues: readonly TimedCue[]): string {
  return cues
    .map(
      (cue, index) =>
        `${String(index + 1)}\n${stamp(cue.startSeconds, ',')} --> ${stamp(cue.endSeconds, ',')}\n${cue.text}\n`,
    )
    .join('\n');
}

/** Subtitles as a WebVTT (.vtt) file, the format of the web's video element. */
export function toVtt(cues: readonly TimedCue[]): string {
  const body = cues
    .map(
      (cue) =>
        `${stamp(cue.startSeconds, '.')} --> ${stamp(cue.endSeconds, '.')}\n${cue.text.replace(/-->/g, '→')}\n`,
    )
    .join('\n');
  return `WEBVTT\n\n${body}`;
}
