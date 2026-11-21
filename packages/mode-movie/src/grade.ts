import { z } from 'zod';

/**
 * Colour grading worked out without drawing: a simple grade per piece
 * (exposure, contrast, temperature, tint, saturation) and one look for the
 * whole film, each turned into a colour matrix. The matrices are affine, so a
 * piece's grade and the film's look combine into one, which the Edit preview
 * hands to an SVG colour-matrix filter and the film renderer applies to each
 * frame's pixels. Both use the same numbers, so they agree.
 */

const Amount = z.number().min(-1).max(1);

export const Grade = z.object({
  /** Brighter or darker, in stops: +1 doubles the light. */
  exposure: z.number().min(-3).max(3).default(0),
  /** More or less contrast around the middle grey: -1 flat, +1 twice as steep. */
  contrast: Amount.default(0),
  /** Warmer (towards orange) or cooler (towards blue). */
  temperature: Amount.default(0),
  /** Towards magenta (+) or green (-). */
  tint: Amount.default(0),
  /** More or less colour: -1 is black and white, +1 twice as vivid. */
  saturation: Amount.default(0),
});
export type Grade = z.infer<typeof Grade>;

export const NEUTRAL_GRADE: Grade = {
  exposure: 0,
  contrast: 0,
  temperature: 0,
  tint: 0,
  saturation: 0,
};

/** The grade fields, for agents and for the parts of a grade a command may change. */
export const GRADE_FIELDS = ['exposure', 'contrast', 'temperature', 'tint', 'saturation'] as const;

export const isNeutral = (grade: Grade): boolean =>
  GRADE_FIELDS.every((field) => Math.abs(grade[field]) < 1e-4);

/** Ready-made looks for the whole film, as grades. */
export const LOOK_PRESETS = {
  none: NEUTRAL_GRADE,
  warm: { ...NEUTRAL_GRADE, temperature: 0.3, saturation: 0.1, contrast: 0.05 },
  cool: { ...NEUTRAL_GRADE, temperature: -0.3, tint: -0.05, contrast: 0.05 },
  'bleach-bypass': { ...NEUTRAL_GRADE, saturation: -0.55, contrast: 0.35, exposure: -0.1 },
  noir: { ...NEUTRAL_GRADE, saturation: -1, contrast: 0.4, exposure: -0.15 },
  golden: { ...NEUTRAL_GRADE, temperature: 0.45, tint: 0.05, saturation: 0.15, exposure: 0.1 },
  night: { ...NEUTRAL_GRADE, temperature: -0.5, saturation: -0.35, exposure: -0.6, contrast: 0.15 },
} as const satisfies Record<string, Grade>;
export type LookPreset = keyof typeof LOOK_PRESETS;
export const LookPreset = z.enum(Object.keys(LOOK_PRESETS) as [LookPreset, ...LookPreset[]]);

/** The film's look: a grade over every piece, and the preset it began from, if any. */
export const FilmLook = Grade.extend({
  preset: LookPreset.nullable().default(null),
});
export type FilmLook = z.infer<typeof FilmLook>;

export const NEUTRAL_LOOK: FilmLook = { ...NEUTRAL_GRADE, preset: null };

/**
 * A colour matrix in the order of an SVG feColorMatrix: four rows (red, green,
 * blue, alpha) of five numbers, the last of each an offset in 0 to 1.
 */
export type ColorMatrix = readonly number[];

// prettier-ignore
export const IDENTITY_MATRIX: ColorMatrix = [
  1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0,
];

/** Rec. 709 weights: how much each channel adds to how bright a colour looks. */
const LUMA = [0.2126, 0.7152, 0.0722] as const;

/** a then b: the matrix that does what a does and then what b does. */
export function combine(a: ColorMatrix, b: ColorMatrix): ColorMatrix {
  const out: number[] = [];
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 5; column++) {
      let sum = column === 4 ? (b[row * 5 + 4] ?? 0) : 0;
      for (let k = 0; k < 4; k++) {
        sum += (b[row * 5 + k] ?? 0) * (a[k * 5 + column] ?? 0);
      }
      out.push(sum);
    }
  }
  return out;
}

/** A matrix that only scales and shifts each colour channel. */
// prettier-ignore
const channels = (scale: readonly number[], offset: readonly number[]): ColorMatrix => [
  scale[0] ?? 1, 0, 0, 0, offset[0] ?? 0,
  0, scale[1] ?? 1, 0, 0, offset[1] ?? 0,
  0, 0, scale[2] ?? 1, 0, offset[2] ?? 0,
  0, 0, 0, 1, 0,
];

/** Mixes each colour with its own grey: 0 is grey, 1 unchanged, 2 twice as vivid. */
function saturate(amount: number): ColorMatrix {
  const [r, g, b] = LUMA;
  const rest = 1 - amount;
  // prettier-ignore
  return [
    r * rest + amount, g * rest, b * rest, 0, 0,
    r * rest, g * rest + amount, b * rest, 0, 0,
    r * rest, g * rest, b * rest + amount, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

/** The matrix of a grade: exposure, then white balance, then contrast, then saturation. */
export function gradeMatrix(grade: Grade): ColorMatrix {
  if (isNeutral(grade)) return IDENTITY_MATRIX;
  const gain = 2 ** grade.exposure;
  // Warmer lifts red and lowers blue; a tint towards magenta lowers green.
  const warm = grade.temperature * 0.25;
  const magenta = grade.tint * 0.2;
  const balance = channels([gain * (1 + warm), gain * (1 - magenta), gain * (1 - warm)], [0, 0, 0]);
  const slope = 1 + grade.contrast;
  const shift = 0.5 * (1 - slope);
  const contrast = channels([slope, slope, slope], [shift, shift, shift]);
  return combine(combine(balance, contrast), saturate(1 + grade.saturation));
}

/** The matrix a piece is drawn with: its own grade, then the film's look. Null when neither changes it. */
export function pieceMatrix(grade: Grade, look: Grade): ColorMatrix | null {
  if (isNeutral(grade) && isNeutral(look)) return null;
  return combine(gradeMatrix(grade), gradeMatrix(look));
}

/** Applies a matrix to RGBA pixels in place, as the film renderer draws a frame. */
export function applyMatrix(pixels: Uint8ClampedArray, matrix: ColorMatrix): void {
  const at = (index: number): number => matrix[index] ?? 0;
  const [r0, r1, r2, r4] = [at(0), at(1), at(2), at(4)];
  const [g0, g1, g2, g4] = [at(5), at(6), at(7), at(9)];
  const [b0, b1, b2, b4] = [at(10), at(11), at(12), at(14)];
  const ro = r4 * 255;
  const go = g4 * 255;
  const bo = b4 * 255;
  for (let index = 0; index < pixels.length; index += 4) {
    const r = pixels[index] ?? 0;
    const g = pixels[index + 1] ?? 0;
    const b = pixels[index + 2] ?? 0;
    // A clamped array rounds and clips what is written to it.
    pixels[index] = r0 * r + r1 * g + r2 * b + ro;
    pixels[index + 1] = g0 * r + g1 * g + g2 * b + go;
    pixels[index + 2] = b0 * r + b1 * g + b2 * b + bo;
  }
}

/** How the colours of a frame lie: per channel and for brightness, from 0 to 1. */
export interface ColorStats {
  readonly mean: readonly [number, number, number];
  readonly luma: number;
  readonly lumaSpread: number;
  /** How far colours lie from their grey, on average: how colourful the frame is. */
  readonly chroma: number;
}

/** The colour statistics of pixels, 3 (RGB) or 4 (RGBA) bytes each. */
export function colorStats(pixels: ArrayLike<number>, stride: 3 | 4): ColorStats {
  let count = 0;
  const sum = [0, 0, 0];
  let lumaSum = 0;
  let lumaSquares = 0;
  let chromaSum = 0;
  for (let index = 0; index + 2 < pixels.length; index += stride) {
    const r = (pixels[index] ?? 0) / 255;
    const g = (pixels[index + 1] ?? 0) / 255;
    const b = (pixels[index + 2] ?? 0) / 255;
    const y = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
    sum[0] = (sum[0] ?? 0) + r;
    sum[1] = (sum[1] ?? 0) + g;
    sum[2] = (sum[2] ?? 0) + b;
    lumaSum += y;
    lumaSquares += y * y;
    chromaSum += (Math.abs(r - y) + Math.abs(g - y) + Math.abs(b - y)) / 3;
    count++;
  }
  if (count === 0) return { mean: [0, 0, 0], luma: 0, lumaSpread: 0, chroma: 0 };
  const luma = lumaSum / count;
  return {
    mean: [(sum[0] ?? 0) / count, (sum[1] ?? 0) / count, (sum[2] ?? 0) / count],
    luma,
    lumaSpread: Math.sqrt(Math.max(0, lumaSquares / count - luma * luma)),
    chroma: chromaSum / count,
  };
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));
const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * A grade that brings a frame's colours near a reference frame's: its
 * brightness, contrast, white balance and colourfulness. A starting point to
 * judge by eye, not an exact match; light that differs in kind cannot be
 * matched by one grade.
 */
export function matchGrade(from: ColorStats, to: ColorStats): Grade {
  const safe = (value: number): number => Math.max(1e-3, value);
  // Brightness and contrast depend on each other: the gain sets the spread, contrast pivots on
  // middle grey and so moves the mean. A few rounds settle both.
  let gain = safe(to.luma) / safe(from.luma);
  let slope = 1;
  for (let round = 0; round < 4; round++) {
    slope = clamp(safe(to.lumaSpread) / safe(gain * from.lumaSpread), 0, 2);
    gain = clamp(((to.luma - 0.5) / Math.max(0.05, slope) + 0.5) / safe(from.luma), 0.125, 8);
  }
  const exposure = clamp(Math.log2(gain), -3, 3);
  const contrast = clamp(slope - 1, -1, 1);
  const colourful = (stats: ColorStats): number => stats.chroma / safe(stats.luma);
  const saturation = clamp(safe(colourful(to)) / safe(colourful(from)) - 1, -1, 1);
  // White balance: the red and blue of each frame against its own brightness. A temperature of
  // t moves warmth by about t / 2 and a tint of t moves magenta by about t / 5, and saturation
  // then strengthens either, so it is taken out.
  const warmth = (stats: ColorStats): number => (stats.mean[0] - stats.mean[2]) / safe(stats.luma);
  const magenta = (stats: ColorStats): number =>
    ((stats.mean[0] + stats.mean[2]) / 2 - stats.mean[1]) / safe(stats.luma);
  const vivid = Math.max(0.1, 1 + saturation);
  let grade: Grade = {
    exposure,
    contrast,
    temperature: clamp(((warmth(to) - warmth(from)) * 2) / vivid, -1, 1),
    tint: clamp(((magenta(to) - magenta(from)) * 5) / vivid, -1, 1),
    saturation,
  };
  // A grade moves a frame's average colour exactly as it moves each pixel, so the average can
  // be brought onto the reference's by small steps.
  for (let step = 0; step < 24; step++) {
    const now = gradeStats(from, gradeMatrix(grade));
    grade = {
      ...grade,
      exposure: clamp(grade.exposure + 0.8 * Math.log2(safe(to.luma) / safe(now.luma)), -3, 3),
      temperature: clamp(grade.temperature + (0.8 * (warmth(to) - warmth(now)) * 2) / vivid, -1, 1),
      tint: clamp(grade.tint + (0.8 * (magenta(to) - magenta(now)) * 5) / vivid, -1, 1),
    };
  }
  return {
    exposure: round2(grade.exposure),
    contrast: round2(grade.contrast),
    temperature: round2(grade.temperature),
    tint: round2(grade.tint),
    saturation: round2(grade.saturation),
  };
}

/** The colour statistics of a frame once a matrix is applied to it, worked out from its mean. */
export function gradeStats(stats: ColorStats, matrix: ColorMatrix): ColorStats {
  const [r, g, b] = stats.mean;
  const row = (index: number): number =>
    (matrix[index * 5] ?? 0) * r +
    (matrix[index * 5 + 1] ?? 0) * g +
    (matrix[index * 5 + 2] ?? 0) * b +
    (matrix[index * 5 + 4] ?? 0);
  const mean: [number, number, number] = [row(0), row(1), row(2)];
  const luma = LUMA[0] * mean[0] + LUMA[1] * mean[1] + LUMA[2] * mean[2];
  // Spread and colour scale with the matrix's slope and saturation, near enough.
  const slope =
    LUMA[0] * (matrix[0] ?? 1) + LUMA[1] * (matrix[6] ?? 1) + LUMA[2] * (matrix[12] ?? 1);
  return {
    mean,
    luma,
    lumaSpread: stats.lumaSpread * Math.abs(slope),
    chroma: stats.chroma * Math.abs(slope),
  };
}

/** A grade in a few words, for an edit decision list. */
export function gradeText(grade: Grade): string {
  const parts: string[] = [];
  const sign = (value: number): string => `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
  for (const field of GRADE_FIELDS) {
    if (Math.abs(grade[field]) >= 0.005) parts.push(`${field} ${sign(grade[field])}`);
  }
  return parts.join(', ');
}
