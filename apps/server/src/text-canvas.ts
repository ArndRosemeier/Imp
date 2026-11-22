import type { TextCanvas } from '@imp/host/film';
import * as opentypeModule from 'opentype.js';
import {
  blur,
  dilate,
  erode,
  Rasterizer,
  roundRectPath,
  type Mask,
  type PathCommand,
} from './raster.js';

/**
 * The text drawing of a 2D canvas, on a plain RGBA frame, for the local
 * server: the film's texts are drawn by the same function as in the browser
 * (drawTexts), into this instead of an OffscreenCanvas. Letters come from the
 * fonts Imp ships, read with opentype.js and filled by the rasterizer here.
 */

/** A frame of pixels, four bytes each (RGBA), drawn on in place. */
export interface Frame {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

type Font = ReturnType<typeof parseFontFile>;

// The package is ES module for the bundle and CommonJS for Node; parse sits in either place.
const opentype = opentypeModule as unknown as {
  parse?: typeof opentypeModule.parse;
  default?: { parse: typeof opentypeModule.parse };
};
function parseFontFile(buffer: ArrayBuffer): opentypeModule.Font {
  const parse = opentype.parse ?? opentype.default?.parse;
  if (parse === undefined) throw new Error('opentype.js has no parse.');
  return parse(buffer);
}

/** One face of a family: its weight, whether it is italic, and its font files (Latin, then extended Latin). */
export interface Face {
  readonly family: string;
  readonly weight: number;
  readonly italic: boolean;
  readonly files: readonly string[];
}

/** The font files Imp ships, by family name as TEXT_FAMILIES names them. */
export function textFaces(): Face[] {
  const faces: Face[] = [];
  for (const weight of [100, 200, 300, 400, 500, 600, 700, 800, 900]) {
    for (const italic of [false, true]) {
      const style = italic ? 'italic' : 'normal';
      faces.push({
        family: 'Imp Sans',
        weight,
        italic,
        files: [
          `inter-latin-${String(weight)}-${style}.woff`,
          `inter-latin-ext-${String(weight)}-${style}.woff`,
        ],
      });
    }
  }
  for (const italic of [false, true]) {
    const style = italic ? 'italic' : 'normal';
    faces.push({
      family: 'Imp Serif',
      weight: 400,
      italic,
      files: [
        `instrument-serif-latin-400-${style}.woff`,
        `instrument-serif-latin-ext-400-${style}.woff`,
      ],
    });
  }
  faces.push(
    {
      family: 'Imp Mono',
      weight: 400,
      italic: false,
      files: ['courier-prime-latin-400-normal.woff', 'courier-prime-latin-ext-400-normal.woff'],
    },
    {
      family: 'Imp Mono',
      weight: 400,
      italic: true,
      files: ['courier-prime-latin-400-italic.woff'],
    },
    {
      family: 'Imp Mono',
      weight: 700,
      italic: false,
      files: ['courier-prime-latin-700-normal.woff'],
    },
    {
      family: 'Imp Mono',
      weight: 700,
      italic: true,
      files: ['courier-prime-latin-700-italic.woff'],
    },
  );
  return faces;
}

/** Fonts read once and kept, by file name. */
export class FontBook {
  readonly #fonts = new Map<string, Font[]>();
  readonly #faces: readonly Face[];

  constructor(
    private readonly read: (file: string) => Uint8Array | undefined,
    faces: readonly Face[] = textFaces(),
  ) {
    this.#faces = faces;
  }

  /** The fonts of the face nearest to a family, weight and slant; empty when none can be read. */
  fonts(family: string, weight: number, italic: boolean): Font[] {
    const candidates = this.#faces.filter((face) => face.family === family);
    const pool =
      candidates.length > 0 ? candidates : this.#faces.filter((f) => f.family === 'Imp Sans');
    const best = [...pool].sort(
      (a, b) =>
        Number(a.italic !== italic) - Number(b.italic !== italic) ||
        Math.abs(a.weight - weight) - Math.abs(b.weight - weight),
    )[0];
    if (best === undefined) return [];
    const key = `${best.family}|${String(best.weight)}|${String(best.italic)}`;
    const known = this.#fonts.get(key);
    if (known !== undefined) return known;
    const fonts: Font[] = [];
    for (const file of best.files) {
      const bytes = this.read(file);
      if (bytes === undefined) continue;
      try {
        fonts.push(parseFontFile(new Uint8Array(bytes).buffer));
      } catch {
        // A font that cannot be read leaves its letters to the next one.
      }
    }
    this.#fonts.set(key, fonts);
    return fonts;
  }
}

interface Color {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const TRANSPARENT: Color = { r: 0, g: 0, b: 0, a: 0 };

/** Reads the colours drawTexts sets: #rgb, #rrggbb, rgb() and rgba(). */
export function parseColor(text: string): Color {
  const value = text.trim();
  if (value.startsWith('#')) {
    const hex =
      value.length === 4
        ? value
            .slice(1)
            .split('')
            .map((digit) => digit + digit)
            .join('')
        : value.slice(1, 7);
    const number = Number.parseInt(hex, 16);
    if (Number.isNaN(number)) return TRANSPARENT;
    return { r: (number >> 16) & 255, g: (number >> 8) & 255, b: number & 255, a: 1 };
  }
  const match = /^rgba?\(([^)]*)\)$/.exec(value);
  if (match === null) return TRANSPARENT;
  const parts = (match[1] ?? '').split(',').map((part) => Number.parseFloat(part));
  return {
    r: parts[0] ?? 0,
    g: parts[1] ?? 0,
    b: parts[2] ?? 0,
    a: parts.length > 3 ? Math.min(1, Math.max(0, parts[3] ?? 1)) : 1,
  };
}

interface ParsedFont {
  readonly family: string;
  readonly weight: number;
  readonly italic: boolean;
  readonly size: number;
}

/** Reads a CSS font shorthand as drawTexts writes it: "italic 700 32px "Imp Sans", …". */
export function parseFont(text: string): ParsedFont {
  const match = /^(italic\s+)?(\d+)\s+([\d.]+)px\s+(.+)$/.exec(text.trim());
  if (match === null) return { family: 'Imp Sans', weight: 400, italic: false, size: 10 };
  const family = (match[4] ?? '').split(',')[0]?.trim().replace(/^"|"$/g, '') ?? 'Imp Sans';
  return {
    family,
    weight: Number(match[2]),
    italic: match[1] !== undefined,
    size: Number(match[3]),
  };
}

interface State {
  font: string;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetY: number;
  letterSpacing: string;
}

const initial = (): State => ({
  font: '400 10px "Imp Sans"',
  fillStyle: '#000000',
  strokeStyle: '#000000',
  lineWidth: 1,
  lineJoin: 'miter',
  textAlign: 'start',
  textBaseline: 'alphabetic',
  globalAlpha: 1,
  shadowColor: 'rgba(0, 0, 0, 0)',
  shadowBlur: 0,
  shadowOffsetY: 0,
  letterSpacing: '0px',
});

/** A line of text laid out: its glyph outlines from the pen at 0, and how wide it is. */
interface Laid {
  readonly commands: PathCommand[];
  readonly width: number;
  readonly ascent: number;
  readonly descent: number;
}

/** A shape ready to lay on the frame: a mask and where its top left corner goes. */
interface Placed {
  readonly mask: Mask;
  readonly left: number;
  readonly top: number;
}

/** How many shapes are kept between frames; a text on screen for a while is drawn once. */
const CACHE = 256;

export class FrameTextCanvas implements TextCanvas {
  #state: State = initial();
  readonly #stack: State[] = [];
  #path: PathCommand[] = [];
  readonly #shapes = new Map<string, Placed>();
  frame: Frame;

  constructor(
    frame: Frame,
    private readonly book: FontBook,
  ) {
    this.frame = frame;
  }

  get font(): string {
    return this.#state.font;
  }
  set font(value: string) {
    this.#state.font = value;
  }
  get fillStyle(): string {
    return this.#state.fillStyle;
  }
  set fillStyle(value: string | CanvasGradient | CanvasPattern) {
    if (typeof value === 'string') this.#state.fillStyle = value;
  }
  get strokeStyle(): string {
    return this.#state.strokeStyle;
  }
  set strokeStyle(value: string | CanvasGradient | CanvasPattern) {
    if (typeof value === 'string') this.#state.strokeStyle = value;
  }
  get lineWidth(): number {
    return this.#state.lineWidth;
  }
  set lineWidth(value: number) {
    this.#state.lineWidth = value;
  }
  get lineJoin(): CanvasLineJoin {
    return this.#state.lineJoin;
  }
  set lineJoin(value: CanvasLineJoin) {
    this.#state.lineJoin = value;
  }
  get textAlign(): CanvasTextAlign {
    return this.#state.textAlign;
  }
  set textAlign(value: CanvasTextAlign) {
    this.#state.textAlign = value;
  }
  get textBaseline(): CanvasTextBaseline {
    return this.#state.textBaseline;
  }
  set textBaseline(value: CanvasTextBaseline) {
    this.#state.textBaseline = value;
  }
  get globalAlpha(): number {
    return this.#state.globalAlpha;
  }
  set globalAlpha(value: number) {
    this.#state.globalAlpha = Math.min(1, Math.max(0, value));
  }
  get shadowColor(): string {
    return this.#state.shadowColor;
  }
  set shadowColor(value: string) {
    this.#state.shadowColor = value;
  }
  get shadowBlur(): number {
    return this.#state.shadowBlur;
  }
  set shadowBlur(value: number) {
    this.#state.shadowBlur = value;
  }
  get shadowOffsetY(): number {
    return this.#state.shadowOffsetY;
  }
  set shadowOffsetY(value: number) {
    this.#state.shadowOffsetY = value;
  }
  get letterSpacing(): string {
    return this.#state.letterSpacing;
  }
  set letterSpacing(value: string) {
    this.#state.letterSpacing = value;
  }

  save(): void {
    this.#stack.push({ ...this.#state });
  }

  restore(): void {
    const last = this.#stack.pop();
    if (last !== undefined) this.#state = last;
  }

  beginPath(): void {
    this.#path = [];
  }

  roundRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radii?: number | DOMPointInit | (number | DOMPointInit)[],
  ): void {
    const radius = typeof radii === 'number' ? radii : 0;
    this.#path.push(...roundRectPath(x, y, width, height, radius));
  }

  fill(): void {
    if (this.#path.length === 0) return;
    const shape = this.#shape(`path|${JSON.stringify(this.#path)}`, () => fillMask(this.#path, 1));
    this.#lay(shape, parseColor(this.#state.fillStyle));
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    const path = roundRectPath(x, y, width, height, 0);
    const shape = this.#shape(`rect|${JSON.stringify(path)}`, () => fillMask(path, 1));
    this.#lay(shape, parseColor(this.#state.fillStyle));
  }

  measureText(text: string): TextMetrics {
    return { width: this.#layout(text).width } as TextMetrics;
  }

  fillText(text: string, x: number, y: number): void {
    this.#text(text, x, y, false);
  }

  strokeText(text: string, x: number, y: number): void {
    this.#text(text, x, y, true);
  }

  /** The letter spacing in pixels, from "0.05em" or "2px". */
  #spacing(size: number): number {
    const value = this.#state.letterSpacing.trim();
    const number = Number.parseFloat(value);
    if (Number.isNaN(number)) return 0;
    return value.endsWith('em') ? number * size : number;
  }

  #layout(text: string): Laid {
    const font = parseFont(this.#state.font);
    const fonts = this.book.fonts(font.family, font.weight, font.italic);
    const spacing = this.#spacing(font.size);
    const commands: PathCommand[] = [];
    let pen = 0;
    let previous: { font: Font; index: number } | undefined;
    const main = fonts[0];
    for (const char of text) {
      const owner = fonts.find((candidate) => candidate.charToGlyphIndex(char) > 0) ?? main;
      if (owner === undefined) break;
      const glyph = owner.charToGlyph(char);
      const scale = font.size / owner.unitsPerEm;
      if (previous?.font === owner) {
        pen += owner.getKerningValue(previous.index, glyph.index) * scale;
      }
      for (const command of glyph.getPath(pen, 0, font.size).commands) {
        commands.push(command as PathCommand);
      }
      pen += (glyph.advanceWidth ?? 0) * scale + spacing;
      previous = { font: owner, index: glyph.index };
    }
    // The em box, normalised to the font size as browsers do it, places "middle" and "top".
    const ascender = main?.ascender ?? 800;
    const descender = Math.abs(main?.descender ?? -200);
    const ascent = (font.size * ascender) / (ascender + descender);
    return { commands, width: pen, ascent, descent: font.size - ascent };
  }

  #text(text: string, x: number, y: number, stroke: boolean): void {
    if (text === '') return;
    const state = this.#state;
    const laid = this.#layout(text);
    const align = state.textAlign;
    const dx =
      align === 'center' ? -laid.width / 2 : align === 'right' || align === 'end' ? -laid.width : 0;
    const baseline = state.textBaseline;
    const dy =
      baseline === 'middle'
        ? (laid.ascent - laid.descent) / 2
        : baseline === 'top' || baseline === 'hanging'
          ? laid.ascent
          : baseline === 'bottom' || baseline === 'ideographic'
            ? -laid.descent
            : 0;
    const penX = Math.round(x + dx);
    const penY = Math.round(y + dy);
    const width = stroke ? state.lineWidth : 0;
    const key = `${stroke ? 'stroke' : 'fill'}|${state.font}|${state.letterSpacing}|${String(width)}|${text}`;
    const shape = this.#shape(key, () => {
      const filled = fillMask(laid.commands, 2 + Math.ceil(width));
      if (!stroke) return filled;
      const half = width / 2;
      const outer = dilate(filled.mask, half);
      const inner = erode(filled.mask, half);
      const data = outer.data.map((value, i) => Math.max(0, value - (inner.data[i] ?? 0)));
      return { ...filled, mask: { ...outer, data } };
    });
    this.#lay(
      { ...shape, left: shape.left + penX, top: shape.top + penY },
      parseColor(stroke ? state.strokeStyle : state.fillStyle),
    );
  }

  #shape(key: string, make: () => Placed): Placed {
    const known = this.#shapes.get(key);
    if (known !== undefined) return known;
    const made = make();
    if (this.#shapes.size >= CACHE) {
      const oldest = this.#shapes.keys().next().value;
      if (oldest !== undefined) this.#shapes.delete(oldest);
    }
    this.#shapes.set(key, made);
    return made;
  }

  /** Lays a shape on the frame in a colour, its shadow first when one is set. */
  #lay(shape: Placed, color: Color): void {
    const state = this.#state;
    const shadow = parseColor(state.shadowColor);
    if (shadow.a > 0 && (state.shadowBlur > 0 || state.shadowOffsetY !== 0)) {
      const sigma = state.shadowBlur / 2;
      const pad = Math.ceil(sigma * 3);
      const key = `shadow|${String(sigma)}|${String(shape.mask.width)}x${String(shape.mask.height)}|${String(maskSum(shape.mask))}`;
      const soft = this.#shape(key, () => {
        const padded = pad > 0 ? padMask(shape.mask, pad) : shape.mask;
        return { mask: blur(padded, sigma), left: -pad, top: -pad };
      });
      composite(
        this.frame,
        soft.mask,
        shape.left + soft.left,
        shape.top + soft.top + Math.round(state.shadowOffsetY),
        shadow,
        state.globalAlpha,
      );
    }
    composite(this.frame, shape.mask, shape.left, shape.top, color, state.globalAlpha);
  }
}

/** Fills a path into a mask just big enough for it, with a margin; left and top place the mask. */
function fillMask(commands: readonly PathCommand[], margin: number): Placed {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const command of commands) {
    if (command.type === 'Z') continue;
    const xs =
      command.type === 'C'
        ? [command.x, command.x1, command.x2]
        : command.type === 'Q'
          ? [command.x, command.x1]
          : [command.x];
    const ys =
      command.type === 'C'
        ? [command.y, command.y1, command.y2]
        : command.type === 'Q'
          ? [command.y, command.y1]
          : [command.y];
    for (const x of xs) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
    for (const y of ys) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX))
    return { mask: { width: 1, height: 1, data: new Float32Array(1) }, left: 0, top: 0 };
  const left = Math.floor(minX) - margin;
  const top = Math.floor(minY) - margin;
  const width = Math.ceil(maxX) + margin - left + 1;
  const height = Math.ceil(maxY) + margin - top + 1;
  const raster = new Rasterizer(width, height);
  raster.path(commands.map((command) => shift(command, -left, -top)));
  return { mask: raster.mask(), left, top };
}

function shift(command: PathCommand, dx: number, dy: number): PathCommand {
  switch (command.type) {
    case 'Z':
      return command;
    case 'M':
    case 'L':
      return { type: command.type, x: command.x + dx, y: command.y + dy };
    case 'Q':
      return {
        type: 'Q',
        x1: command.x1 + dx,
        y1: command.y1 + dy,
        x: command.x + dx,
        y: command.y + dy,
      };
    case 'C':
      return {
        type: 'C',
        x1: command.x1 + dx,
        y1: command.y1 + dy,
        x2: command.x2 + dx,
        y2: command.y2 + dy,
        x: command.x + dx,
        y: command.y + dy,
      };
  }
}

function padMask(mask: Mask, pad: number): Mask {
  const width = mask.width + pad * 2;
  const height = mask.height + pad * 2;
  const data = new Float32Array(width * height);
  for (let y = 0; y < mask.height; y++) {
    data.set(mask.data.subarray(y * mask.width, (y + 1) * mask.width), (y + pad) * width + pad);
  }
  return { width, height, data };
}

function maskSum(mask: Mask): number {
  let sum = 0;
  for (const value of mask.data) sum += value;
  return Math.round(sum * 100);
}

/** Lays a colour through a mask onto the frame at a place, over what is there. */
export function composite(
  frame: Frame,
  mask: Mask,
  left: number,
  top: number,
  color: Color,
  alpha: number,
): void {
  const strength = color.a * alpha;
  if (strength <= 0) return;
  const { data, width, height } = frame;
  const x0 = Math.max(0, left);
  const y0 = Math.max(0, top);
  const x1 = Math.min(width, left + mask.width);
  const y1 = Math.min(height, top + mask.height);
  for (let y = y0; y < y1; y++) {
    let source = (y - top) * mask.width + (x0 - left);
    let target = (y * width + x0) * 4;
    for (let x = x0; x < x1; x++, source++, target += 4) {
      const a = (mask.data[source] ?? 0) * strength;
      if (a <= 0) continue;
      const keep = 1 - a;
      data[target] = (data[target] ?? 0) * keep + color.r * a;
      data[target + 1] = (data[target + 1] ?? 0) * keep + color.g * a;
      data[target + 2] = (data[target + 2] ?? 0) * keep + color.b * a;
    }
  }
}
