import { styleOf, textMotion, type FilmText, type TextStyle } from '@imp/mode-movie';
import { TEXT_FAMILIES } from './text-fonts.js';
import { wrapLines } from './title-lines.js';

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

const rgba = (hex: string, alpha: number): string => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${String((value >> 16) & 255)}, ${String((value >> 8) & 255)}, ${String(value & 255)}, ${String(Math.round(alpha * 1000) / 1000)})`;
};

interface Line {
  readonly words: string;
  readonly size: number;
  readonly font: string;
  readonly width: number;
  readonly secondary: boolean;
}

function fontOf(style: TextStyle, size: number, weight: number): string {
  return `${style.italic ? 'italic ' : ''}${String(weight)} ${String(Math.round(size * 100) / 100)}px ${TEXT_FAMILIES[style.font]}`;
}

/**
 * The lines of a text, wrapped to its style's width. In a lower third the
 * lines after the first (the role under the name) are smaller and lighter.
 */
function layLines(g: TextCanvas, text: DrawnText, shown: string, frame: number, width: number) {
  const { style } = text;
  const size = (style.size / 100) * frame;
  const widest = (style.width / 100) * width;
  const lines: Line[] = [];
  for (const [index, paragraph] of shown.split('\n').entries()) {
    const secondary = text.kind === 'lower-third' && index > 0;
    const lineSize = secondary ? size * 0.72 : size;
    const font = fontOf(style, lineSize, secondary ? Math.min(style.weight, 400) : style.weight);
    g.font = font;
    for (const words of wrapLines(paragraph, (line) => g.measureText(line).width <= widest)) {
      lines.push({ words, size: lineSize, font, width: g.measureText(words).width, secondary });
    }
  }
  return { lines, size };
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
  const words = style.uppercase ? text.text.toUpperCase() : text.text;
  const motion = textMotion(style, since, text.durationSeconds, words.length);
  if (motion.opacity * alpha <= 0) return;
  const shown = words.slice(0, Math.round(words.length * motion.typed));
  if (shown.trim() === '') return;
  g.save();
  if ('letterSpacing' in g) g.letterSpacing = `${String(style.tracking)}em`;
  const { lines, size } = layLines(g, text, shown, height, width);
  const heights = lines.map((line) => line.size * style.leading);
  const blockHeight = heights.reduce((sum, value) => sum + value, 0);
  const blockWidth = Math.max(...lines.map((line) => line.width));
  const x = (text.x ?? style.x) * width;
  const y = (text.y ?? style.y) * height;
  let top =
    motion.roll === null
      ? style.anchor === 'top'
        ? y
        : style.anchor === 'middle'
          ? y - blockHeight / 2
          : y - blockHeight
      : height - motion.roll * (height + blockHeight);
  top += motion.drop * height;
  const left =
    style.align === 'left' ? x : style.align === 'center' ? x - blockWidth / 2 : x - blockWidth;
  g.globalAlpha = motion.opacity * alpha;
  if (style.box > 0) {
    const padX = size * 0.5;
    const padY = size * 0.28;
    g.fillStyle = rgba(style.boxColor, style.box);
    g.beginPath();
    g.roundRect(
      left - padX,
      top - padY,
      blockWidth + padX * 2,
      blockHeight + padY * 2,
      size * 0.18,
    );
    g.fill();
  }
  g.textAlign = style.align;
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  for (const [index, line] of lines.entries()) {
    const lineHeight = heights[index] ?? 0;
    const middle = top + lineHeight / 2;
    top += lineHeight;
    if (middle < -lineHeight || middle > height + lineHeight) continue;
    g.font = line.font;
    g.shadowColor = style.shadow > 0 ? rgba('#000000', style.shadow) : 'rgba(0, 0, 0, 0)';
    g.shadowBlur = style.shadow > 0 ? line.size * 0.28 : 0;
    g.shadowOffsetY = style.shadow > 0 ? line.size * 0.06 : 0;
    if (style.outline > 0) {
      g.strokeStyle = style.outlineColor;
      // The stroke is centred on the edge of the letters: twice as wide shows the width outside.
      g.lineWidth = (style.outline / 100) * line.size * 2;
      g.strokeText(line.words, x, middle);
      g.shadowColor = 'rgba(0, 0, 0, 0)';
    }
    g.fillStyle = line.secondary ? rgba(style.color, 0.82) : style.color;
    g.fillText(line.words, x, middle);
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
