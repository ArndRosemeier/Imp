import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { drawText } from '@imp/host/film';
import { DEFAULT_TEXT_STYLES, type TextStyle } from '@imp/mode-movie';
import { describe, expect, it } from 'vitest';
import { blur, dilate, erode, Rasterizer, roundRectPath } from '../src/raster.js';
import { FontBook, FrameTextCanvas, parseColor, parseFont } from '../src/text-canvas.js';

const require = createRequire(import.meta.url);
const fontFile = (file: string): Uint8Array | undefined => {
  const pkg = file.startsWith('inter')
    ? '@fontsource/inter'
    : file.startsWith('instrument')
      ? '@fontsource/instrument-serif'
      : '@fontsource/courier-prime';
  try {
    return new Uint8Array(readFileSync(require.resolve(`${pkg}/files/${file}`)));
  } catch {
    return undefined;
  }
};

const frame = (width: number, height: number) => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4).fill(0),
});

const style = (id: string, change: Partial<TextStyle> = {}): TextStyle => {
  const found = DEFAULT_TEXT_STYLES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(id);
  return { ...found, ...change };
};

describe('rasterizer', () => {
  it('covers a square exactly, with soft edges for half pixels', () => {
    const raster = new Rasterizer(10, 10);
    raster.path(roundRectPath(2, 2, 4, 4, 0));
    const mask = raster.mask();
    expect(mask.data[3 * 10 + 3]).toBeCloseTo(1);
    expect(mask.data[0]).toBeCloseTo(0);
    const half = new Rasterizer(10, 10);
    half.path(roundRectPath(2.5, 2, 4, 4, 0));
    expect(half.mask().data[3 * 10 + 2]).toBeCloseTo(0.5);
    const total = mask.data.reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(16);
  });

  it('fills a circle-like rounded square by area', () => {
    const raster = new Rasterizer(40, 40);
    raster.path(roundRectPath(10, 10, 20, 20, 10));
    const area = raster.mask().data.reduce((sum, value) => sum + value, 0);
    expect(area).toBeGreaterThan(Math.PI * 100 * 0.97);
    expect(area).toBeLessThan(Math.PI * 100 * 1.01);
  });

  it('fills cubic and quadratic curves and closes open contours', () => {
    const raster = new Rasterizer(40, 40);
    raster.path([
      { type: 'M', x: 5, y: 20 },
      { type: 'C', x1: 5, y1: 5, x2: 35, y2: 5, x: 35, y: 20 },
      { type: 'Q', x1: 20, y1: 40, x: 5, y: 20 },
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 3, y: 0 },
      { type: 'L', x: 3, y: 3 },
    ]);
    const mask = raster.mask();
    expect(mask.data[20 * 40 + 20]).toBeCloseTo(1);
    expect(mask.data[39 * 40 + 39]).toBeCloseTo(0);
    expect(erode(mask, 0)).toBe(mask);
    expect(erode(mask, 2).data[20 * 40 + 20]).toBeCloseTo(1);
    expect(erode(mask, 2).data[20 * 40 + 6]).toBeLessThan(0.5);
  });

  it('grows and blurs masks without losing them', () => {
    const raster = new Rasterizer(20, 20);
    raster.path(roundRectPath(8, 8, 4, 4, 0));
    const mask = raster.mask();
    const grown = dilate(mask, 2);
    expect(grown.data[6 * 20 + 9]).toBeCloseTo(1);
    const soft = blur(mask, 2);
    const before = mask.data.reduce((sum, value) => sum + value, 0);
    const after = soft.data.reduce((sum, value) => sum + value, 0);
    expect(after).toBeCloseTo(before, 0);
  });
});

describe('text canvas', () => {
  it('reads colours and fonts as drawTexts writes them', () => {
    expect(parseColor('#ff8000')).toEqual({ r: 255, g: 128, b: 0, a: 1 });
    expect(parseColor('rgba(0, 0, 0, 0.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseFont('italic 700 32.5px "Imp Serif", Georgia, serif')).toEqual({
      family: 'Imp Serif',
      weight: 700,
      italic: true,
      size: 32.5,
    });
  });

  it('measures and draws letters from the shipped fonts', () => {
    const book = new FontBook(fontFile);
    const target = frame(640, 360);
    const g = new FrameTextCanvas(target, book);
    g.font = '700 48px "Imp Sans"';
    const wide = g.measureText('WWWW').width;
    const narrow = g.measureText('iiii').width;
    expect(wide).toBeGreaterThan(narrow * 2);
    drawText(
      g,
      {
        kind: 'title',
        text: 'Storm at the Lighthouse',
        style: style('title'),
        startSeconds: 0,
        durationSeconds: 4,
        x: null,
        y: null,
      },
      2,
      640,
      360,
    );
    drawText(
      g,
      {
        kind: 'lower-third',
        text: 'Mara Vale\nLighthouse keeper',
        style: style('lower-third'),
        startSeconds: 0,
        durationSeconds: 4,
        x: null,
        y: null,
      },
      2,
      640,
      360,
    );
    let lit = 0;
    for (let i = 0; i < target.data.length; i += 4) if ((target.data[i] ?? 0) > 128) lit++;
    expect(lit).toBeGreaterThan(1500);
    if (process.env['IMP_TEXT_PREVIEW'] !== undefined) {
      const rgb = Buffer.alloc(640 * 360 * 3);
      for (let i = 0, j = 0; i < target.data.length; i += 4, j += 3) {
        rgb[j] = target.data[i] ?? 0;
        rgb[j + 1] = target.data[i + 1] ?? 0;
        rgb[j + 2] = target.data[i + 2] ?? 0;
      }
      writeFileSync(
        process.env['IMP_TEXT_PREVIEW'],
        Buffer.concat([Buffer.from('P6 640 360 255\n'), rgb]),
      );
    }
  });

  it('outlines, shadows and boxes texts as drawTexts asks', () => {
    const book = new FontBook(fontFile);
    const plain = frame(320, 180);
    const styled = frame(320, 180);
    const text = (target: ReturnType<typeof frame>, change: Partial<TextStyle>) => {
      drawText(
        new FrameTextCanvas(target, book),
        {
          kind: 'caption',
          text: 'Hold the light',
          style: style('caption', { box: 0, shadow: 0, outline: 0, ...change }),
          startSeconds: 0,
          durationSeconds: 4,
          x: 0.5,
          y: 0.5,
        },
        2,
        320,
        180,
      );
    };
    const lit = (target: ReturnType<typeof frame>) => {
      let count = 0;
      for (let i = 0; i < target.data.length; i += 4) if ((target.data[i + 2] ?? 0) > 20) count++;
      return count;
    };
    text(plain, {});
    text(styled, {
      outline: 8,
      outlineColor: '#3366ff',
      shadow: 0.8,
      box: 0.5,
      boxColor: '#202020',
    });
    expect(lit(styled)).toBeGreaterThan(lit(plain));
  });

  it('places text by alignment and baseline, and keeps state across save and restore', () => {
    const book = new FontBook(fontFile);
    const target = frame(200, 100);
    const g = new FrameTextCanvas(target, book);
    g.font = 'italic 400 20px "Imp Mono"';
    g.letterSpacing = '2px';
    const spaced = g.measureText('ab').width;
    g.letterSpacing = 'none';
    expect(g.measureText('ab').width).toBeLessThan(spaced);
    g.save();
    g.fillStyle = '#fff';
    g.textAlign = 'right';
    g.textBaseline = 'top';
    g.fillText('x', 100, 10);
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.fillText('x', 100, 90);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillText('', 0, 50);
    g.restore();
    expect(g.textAlign).toBe('start');
    expect(g.fillStyle).toBe('#000000');
    g.restore();
    const top = target.data.slice(0, 200 * 40 * 4).some((value, i) => i % 4 === 0 && value > 128);
    const bottom = target.data.slice(200 * 60 * 4).some((value, i) => i % 4 === 0 && value > 128);
    expect(top).toBe(true);
    expect(bottom).toBe(true);
    g.fillStyle = 'rgb(255, 0, 0)';
    g.globalAlpha = 2;
    g.fillRect(0, 0, 4, 4);
    expect(target.data[0]).toBe(255);
    g.beginPath();
    g.fill();
    g.strokeStyle = '#0f0';
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.shadowColor = 'rgba(0, 0, 0, 0.5)';
    g.shadowBlur = 0;
    g.shadowOffsetY = 2;
    g.strokeText('o', 150, 50);
    expect([g.strokeStyle, g.lineWidth, g.lineJoin, g.shadowBlur, g.shadowOffsetY]).toEqual([
      '#0f0',
      2,
      'round',
      0,
      2,
    ]);
    expect(g.shadowColor).toBe('rgba(0, 0, 0, 0.5)');
    expect(g.font).toContain('Imp Mono');
    expect(g.globalAlpha).toBe(1);
  });

  it('falls back when colours, fonts or font files are unknown', () => {
    expect(parseColor('#f80')).toEqual({ r: 255, g: 136, b: 0, a: 1 });
    expect(parseColor('#zzzzzz').a).toBe(0);
    expect(parseColor('papayawhip').a).toBe(0);
    expect(parseColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseFont('bold big')).toEqual({
      family: 'Imp Sans',
      weight: 400,
      italic: false,
      size: 10,
    });
    const empty = new FontBook(() => undefined);
    expect(empty.fonts('Imp Sans', 400, false)).toEqual([]);
    const broken = new FontBook(() => new Uint8Array([1, 2, 3]));
    expect(broken.fonts('Nothing', 400, false)).toEqual([]);
    const g = new FrameTextCanvas(frame(10, 10), empty);
    expect(g.measureText('abc').width).toBe(0);
    g.fillText('abc', 0, 5);
  });
});
