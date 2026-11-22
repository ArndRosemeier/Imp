import {
  letterCount,
  markupLines,
  styleOf,
  textMotion,
  type FilmText,
  type TextFont,
  type TextRun,
  type TextStyle,
} from '@imp/mode-movie';

/**
 * Draws the text lane onto a frame: the one drawing function behind the
 * preview on the Edit screen and the film export, so that a text looks and
 * moves the same in both. Sizes are shares of the frame, so a text sits the
 * same on a small preview as in a 4K film.
 */

/** The part of a 2D canvas context that drawing texts uses. */
export type TextCanvas = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'measureText'
  | 'fillText'
  | 'strokeText'
  | 'fillRect'
  | 'beginPath'
  | 'roundRect'
  | 'fill'
  | 'font'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'lineJoin'
  | 'textAlign'
  | 'textBaseline'
  | 'globalAlpha'
  | 'shadowColor'
  | 'shadowBlur'
  | 'shadowOffsetY'
> & { letterSpacing?: string };

/** A text of the lane, in film or scene time, with the style it is drawn in. */
export type DrawnText = Omit<FilmText, 'style'> & { readonly style: TextStyle };

/**
 * The font families texts are drawn in, under names of their own. Each host
 * loads the faces behind them: the browser from the bundled web fonts, the
 * local server from the same fonts as files.
 */
export const TEXT_FAMILIES: Record<TextFont, string> = {
  sans: '"Imp Sans", "Inter Variable", system-ui, sans-serif',
  serif: '"Imp Serif", "Instrument Serif", Georgia, serif',
  mono: '"Imp Mono", "Courier Prime", "Courier New", monospace',
};

/**
 * The weights each family really has. A heavier weight than a family has is
 * drawn as its nearest weight with the letters thickened by Imp itself, so
 * that the browser (which would fake bold its own way) and the local server
 * (which cannot) draw the same letters.
 */
export const FAMILY_WEIGHTS: Record<TextFont, readonly number[]> = {
  sans: [100, 200, 300, 400, 500, 600, 700, 800, 900],
  serif: [400],
  mono: [400, 700],
};

const rgba = (hex: string, alpha: number): string => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${String((value >> 16) & 255)}, ${String((value >> 8) & 255)}, ${String(value & 255)}, ${String(Math.round(alpha * 1000) / 1000)})`;
};

/** Where the alphabetic baseline sits below the middle of a line, as a share of the size. */
const BASELINE = 0.3;

/** A stretch of a line in one look, laid out. */
interface Piece {
  readonly text: string;
  readonly font: string;
  readonly size: number;
  readonly color: string;
  readonly alpha: number;
  readonly underline: boolean;
  /** How much to thicken the letters (a stroke width in pixels), 0 for none. */
  readonly embolden: number;
  /** Where it starts from the left of its line, and how wide it is. */
  readonly x: number;
  readonly width: number;
  /** How many letters come before it in the text, for typing. */
  readonly before: number;
}

interface LaidLine {
  readonly pieces: readonly Piece[];
  readonly width: number;
  /** The tallest letters in the line. */
  readonly size: number;
  readonly height: number;
}

/** A text laid out in its frame, before it moves. */
export interface TextLayout {
  readonly lines: readonly LaidLine[];
  /** The text's block: where it sits when still, in pixels of the frame. */
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** The style's letter size in pixels. */
  readonly size: number;
  readonly letters: number;
}

/** The look of a word as it is laid out. */
interface Look {
  readonly font: string;
  readonly size: number;
  readonly color: string;
  readonly alpha: number;
  readonly underline: boolean;
  readonly embolden: number;
}

function lookOf(style: TextStyle, run: TextRun, size: number, secondary: boolean): Look {
  const wanted = secondary ? Math.min(style.weight, 400) : style.weight;
  const weight = run.bold ? Math.max(700, Math.min(900, wanted + 300)) : wanted;
  const weights = FAMILY_WEIGHTS[style.font];
  const real = weights.reduce(
    (best, candidate) =>
      Math.abs(candidate - weight) < Math.abs(best - weight) ||
      (Math.abs(candidate - weight) === Math.abs(best - weight) && candidate < best)
        ? candidate
        : best,
    weights[0] ?? 400,
  );
  const runSize = size * run.scale;
  const italic = style.italic !== run.italic;
  const font = `${italic ? 'italic ' : ''}${String(real)} ${String(Math.round(runSize * 100) / 100)}px ${TEXT_FAMILIES[style.font]}`;
  return {
    font,
    size: runSize,
    color: run.color ?? style.color,
    alpha: secondary && run.color === null ? 0.82 : 1,
    underline: run.underline,
    embolden: weight > real ? (runSize * 0.045 * (weight - real)) / 300 : 0,
  };
}

const sameLook = (a: Look, b: Look): boolean =>
  a.font === b.font &&
  a.color === b.color &&
  a.alpha === b.alpha &&
  a.underline === b.underline &&
  a.embolden === b.embolden;

/** A word or a space, with its look. */
interface Bit {
  readonly text: string;
  readonly look: Look;
  readonly space: boolean;
}

/** The bits of a paragraph: its words and the spaces between, each with its look. */
function bitsOf(style: TextStyle, runs: readonly TextRun[], size: number, secondary: boolean) {
  const bits: Bit[] = [];
  for (const run of runs) {
    const look = lookOf(style, run, size, secondary);
    const words = style.uppercase ? run.text.toUpperCase() : run.text;
    for (const part of words.split(/(\s+)/)) {
      if (part === '') continue;
      bits.push({ text: part, look, space: /^\s+$/.test(part) });
    }
  }
  return bits;
}

/** A line of bits put together: neighbouring bits of one look are measured as one. */
function lineOf(
  g: TextCanvas,
  bits: readonly Bit[],
  leading: number,
  base: number,
  before: number,
) {
  let start = 0;
  let end = bits.length;
  while (start < end && bits[start]?.space === true) start += 1;
  while (end > start && bits[end - 1]?.space === true) end -= 1;
  const pieces: Piece[] = [];
  let x = 0;
  let letters = before;
  let size = 0;
  for (let index = start; index < end; index += 1) {
    const bit = bits[index];
    if (bit === undefined) continue;
    const last = pieces.at(-1);
    if (last !== undefined && sameLook(last, bit.look)) {
      const text = last.text + bit.text;
      g.font = bit.look.font;
      const width = g.measureText(text).width;
      x = last.x + width;
      pieces[pieces.length - 1] = { ...last, text, width };
    } else {
      g.font = bit.look.font;
      const width = g.measureText(bit.text).width;
      pieces.push({ ...bit.look, text: bit.text, x, width, before: letters });
      x += width;
    }
    letters += bit.text.length;
    size = Math.max(size, bit.look.size);
  }
  const tallest = size > 0 ? size : base;
  return {
    line: { pieces, width: x, size: tallest, height: tallest * leading },
    letters: letters - before,
  };
}

/** Breaks a paragraph's bits into lines no wider than widest. */
function breakBits(g: TextCanvas, bits: readonly Bit[], widest: number): Bit[][] {
  const lines: Bit[][] = [];
  let line: Bit[] = [];
  let width = 0;
  for (const bit of bits) {
    g.font = bit.look.font;
    const bitWidth = g.measureText(bit.text).width;
    if (!bit.space && line.some((candidate) => !candidate.space) && width + bitWidth > widest) {
      while (line.at(-1)?.space === true) line.pop();
      lines.push(line);
      line = [];
      width = 0;
    }
    if (bit.space && line.length === 0) continue;
    line.push(bit);
    width += bitWidth;
  }
  lines.push(line);
  return lines;
}

/**
 * Breaks a paragraph into lines. Centred texts are balanced: no more lines
 * than are needed, but as even as they can be, so that a two line subtitle
 * does not leave one word alone on its second line.
 */
function wrapBits(g: TextCanvas, bits: readonly Bit[], widest: number, balance: boolean): Bit[][] {
  const greedy = breakBits(g, bits, widest);
  if (!balance || greedy.length < 2) return greedy;
  let low = widest / greedy.length;
  let high = widest;
  let best = greedy;
  for (let step = 0; step < 12; step += 1) {
    const middle = (low + high) / 2;
    const tried = breakBits(g, bits, middle);
    if (tried.length <= greedy.length) {
      best = tried;
      high = middle;
    } else {
      low = middle;
    }
  }
  return best;
}

const layouts = new WeakMap<object, Map<string, Omit<TextLayout, 'left' | 'top'>>>();
const LAYOUTS = 300;

/** The lines of a text, wrapped to its style's width, kept for the next frame. */
function linesOf(g: TextCanvas, text: DrawnText, width: number, height: number) {
  const { style } = text;
  const key = `${text.kind}|${text.text}|${JSON.stringify(style)}|${String(width)}x${String(height)}`;
  let known = layouts.get(g);
  if (known === undefined) {
    known = new Map();
    layouts.set(g, known);
  }
  const found = known.get(key);
  if (found !== undefined) return found;
  const size = (style.size / 100) * height;
  const widest = (style.width / 100) * width;
  const lines: LaidLine[] = [];
  let letters = 0;
  for (const [index, runs] of markupLines(text.text).entries()) {
    // In a lower third the lines after the first (the role under the name) are smaller and lighter.
    const secondary = text.kind === 'lower-third' && index > 0;
    const lineSize = secondary ? size * 0.72 : size;
    const bits = bitsOf(style, runs, lineSize, secondary);
    const wrapped = wrapBits(g, bits, widest, style.align === 'center' && !style.roll);
    for (const lineBits of wrapped) {
      const laid = lineOf(g, lineBits, style.leading, lineSize, letters);
      lines.push(laid.line);
      letters += laid.letters;
    }
    // A new line counts as a letter while typing, as it did before.
    letters += 1;
  }
  const made = {
    lines,
    width: Math.max(0, ...lines.map((line) => line.width)),
    height: lines.reduce((sum, line) => sum + line.height, 0),
    size,
    letters: Math.max(0, letters - 1),
  };
  if (known.size >= LAYOUTS) {
    const oldest = known.keys().next().value;
    if (oldest !== undefined) known.delete(oldest);
  }
  known.set(key, made);
  return made;
}

/**
 * Where a text sits in a frame when it is still: its lines and its block.
 * The Edit screen uses it to put a frame around the selected text and to
 * drag it to a new place.
 */
export function layoutText(
  g: TextCanvas,
  text: DrawnText,
  width: number,
  height: number,
): TextLayout {
  const { style } = text;
  g.save();
  if ('letterSpacing' in g) g.letterSpacing = `${String(style.tracking)}em`;
  const laid = linesOf(g, text, width, height);
  g.restore();
  const x = (text.x ?? style.x) * width;
  const y = (text.y ?? style.y) * height;
  const top =
    style.anchor === 'top' ? y : style.anchor === 'middle' ? y - laid.height / 2 : y - laid.height;
  const left =
    style.align === 'left' ? x : style.align === 'center' ? x - laid.width / 2 : x - laid.width;
  return { ...laid, left, top };
}

/** Draws one text, since seconds after it came on; alpha fades it further (a title card's fade). */
export function drawText(
  g: TextCanvas,
  text: DrawnText,
  since: number,
  width: number,
  height: number,
  alpha = 1,
): void {
  const { style } = text;
  const motion = textMotion(style, since, text.durationSeconds, letterCount(text.text));
  if (motion.opacity * alpha <= 0 || motion.typed <= 0) return;
  const laid = layoutText(g, text, width, height);
  const typed = Math.round(laid.letters * motion.typed);
  if (typed <= 0 || laid.lines.every((line) => line.pieces.length === 0)) return;
  const { size } = laid;
  const x = (text.x ?? style.x) * width;
  let top = motion.roll === null ? laid.top : height - motion.roll * (height + laid.height);
  top += motion.drop * height;
  g.save();
  if ('letterSpacing' in g) g.letterSpacing = `${String(style.tracking)}em`;
  g.globalAlpha = motion.opacity * alpha;
  if (style.box > 0) {
    // While typing, the box grows with the words, as it did when it was laid out from them.
    const shown = laid.lines.filter((line) => (line.pieces[0]?.before ?? Infinity) < typed);
    const shownWidth = Math.max(
      0,
      ...shown.map((line) =>
        Math.min(line.width, ...line.pieces.filter((p) => p.before >= typed).map((p) => p.x)),
      ),
    );
    const boxWidth = typed >= laid.letters ? laid.width : shownWidth;
    const boxHeight = shown.reduce((sum, line) => sum + line.height, 0);
    const boxLeft =
      style.align === 'left' ? x : style.align === 'center' ? x - boxWidth / 2 : x - boxWidth;
    const padX = size * 0.5;
    const padY = size * 0.28;
    g.fillStyle = rgba(style.boxColor, style.box);
    g.beginPath();
    g.roundRect(boxLeft - padX, top - padY, boxWidth + padX * 2, boxHeight + padY * 2, size * 0.18);
    g.fill();
  }
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.lineJoin = 'round';
  const shadow = (on: boolean, lineSize: number): void => {
    g.shadowColor = on && style.shadow > 0 ? rgba('#000000', style.shadow) : 'rgba(0, 0, 0, 0)';
    g.shadowBlur = on && style.shadow > 0 ? lineSize * 0.28 : 0;
    g.shadowOffsetY = on && style.shadow > 0 ? lineSize * 0.06 : 0;
  };
  for (const line of laid.lines) {
    const lineTop = top;
    top += line.height;
    if (lineTop + line.height < 0 || lineTop > height) continue;
    const baseline = lineTop + line.height / 2 + line.size * BASELINE;
    const start =
      style.align === 'left' ? x : style.align === 'center' ? x - line.width / 2 : x - line.width;
    const pieces = line.pieces.flatMap((piece) => {
      if (piece.before >= typed) return [];
      if (piece.before + piece.text.length <= typed) return [piece];
      return [{ ...piece, text: piece.text.slice(0, typed - piece.before) }];
    });
    if (pieces.length === 0) continue;
    // Outlines first, all of them, so that no outline covers a neighbouring letter.
    if (style.outline > 0) {
      shadow(true, line.size);
      g.strokeStyle = style.outlineColor;
      g.fillStyle = style.outlineColor;
      for (const piece of pieces) {
        g.font = piece.font;
        // The stroke is centred on the edge of the letters: twice as wide shows the width outside.
        const outline = (style.outline / 100) * piece.size * 2;
        g.lineWidth = outline + piece.embolden;
        g.strokeText(piece.text, start + piece.x, baseline);
        if (piece.underline) {
          const thick = Math.max(1, piece.size * 0.06);
          const grow = outline / 2;
          g.fillRect(
            start + piece.x - grow,
            baseline + piece.size * 0.1 - grow,
            g.measureText(piece.text).width + grow * 2,
            thick + grow * 2,
          );
        }
      }
    }
    shadow(style.outline <= 0, line.size);
    for (const piece of pieces) {
      g.font = piece.font;
      const color = piece.alpha < 1 ? rgba(piece.color, piece.alpha) : piece.color;
      g.fillStyle = color;
      if (piece.embolden > 0) {
        g.strokeStyle = color;
        g.lineWidth = piece.embolden;
        g.strokeText(piece.text, start + piece.x, baseline);
      }
      g.fillText(piece.text, start + piece.x, baseline);
      if (piece.underline) {
        g.fillRect(
          start + piece.x,
          baseline + piece.size * 0.1,
          g.measureText(piece.text).width,
          Math.max(1, piece.size * 0.06),
        );
      }
    }
  }
  g.restore();
}

/** Draws every text that is on screen at a time, in the order of the lane. */
export function drawTexts(
  g: TextCanvas,
  texts: readonly DrawnText[],
  seconds: number,
  width: number,
  height: number,
): void {
  for (const text of texts) {
    const since = seconds - text.startSeconds;
    if (since < 0 || since >= text.durationSeconds) continue;
    drawText(g, text, since, width, height);
  }
}

/** A text of a scene's lane as the Edit screen has it. */
export interface LaneText {
  readonly kind: DrawnText['kind'];
  readonly text: string;
  readonly startSeconds: number;
  readonly durationSeconds: number;
  readonly styleId: string;
  readonly x: number | null;
  readonly y: number | null;
  readonly orphaned?: boolean;
}

/**
 * Draws what lies over the picture of a scene at a time: the words of a title
 * card in the title style, faded with the card, and the texts of the lane in
 * their styles. Texts whose anchor is gone are not drawn, as in the film.
 */
export function drawLane(
  g: TextCanvas,
  lane: {
    readonly texts: readonly LaneText[];
    readonly styles: readonly TextStyle[];
    readonly seconds: number;
    readonly width: number;
    readonly height: number;
    readonly card?: { readonly title: string; readonly brightness: number } | null;
  },
): void {
  const { texts, styles, seconds, width, height, card } = lane;
  if (card !== undefined && card !== null && card.title.trim() !== '') {
    const style = styleOf(styles, { styleId: 'title', kind: 'title' });
    drawText(
      g,
      {
        kind: 'title',
        text: card.title,
        style: { ...style, enter: 'cut', exit: 'cut', roll: false },
        startSeconds: 0,
        durationSeconds: 1,
        x: null,
        y: null,
      },
      0,
      width,
      height,
      card.brightness,
    );
  }
  drawTexts(
    g,
    texts
      .filter((text) => text.orphaned !== true)
      .map((text) => ({ ...text, style: styleOf(styles, text) })),
    seconds,
    width,
    height,
  );
}
