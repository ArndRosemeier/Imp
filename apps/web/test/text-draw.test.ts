import { DEFAULT_TEXT_STYLES, type TextStyle } from '@imp/mode-movie';
import { describe, expect, it } from 'vitest';
import { drawLane, drawText, drawTexts, type TextCanvas } from '@imp/host/film';
import { loadTextFonts, TEXT_FACES, TEXT_FAMILIES } from '../src/host/text-fonts.js';

interface Call {
  readonly op: string;
  readonly text?: string;
  readonly x?: number;
  readonly y?: number;
  readonly font?: string;
  readonly alpha?: number;
  readonly fill?: unknown;
  readonly align?: string;
}

/** A canvas that writes down what is drawn; letters are half as wide as they are high. */
function recorder(): { g: TextCanvas; calls: Call[] } {
  const calls: Call[] = [];
  const g = {
    font: '',
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    lineWidth: 0,
    lineJoin: 'miter',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetY: 0,
    letterSpacing: '0px',
    save: () => calls.push({ op: 'save' }),
    restore: () => calls.push({ op: 'restore' }),
    measureText: (text: string) => {
      const size = Number(/(\d+(\.\d+)?)px/.exec(g.font)?.[1] ?? 10);
      return { width: text.length * size * 0.5 };
    },
    fillText: (text: string, x: number, y: number) =>
      calls.push({
        op: 'fill',
        text,
        x,
        y,
        font: g.font,
        alpha: g.globalAlpha,
        fill: g.fillStyle,
        align: g.textAlign,
      }),
    strokeText: (text: string, x: number, y: number) => calls.push({ op: 'stroke', text, x, y }),
    fillRect: () => calls.push({ op: 'rect' }),
    beginPath: () => calls.push({ op: 'path' }),
    roundRect: (x: number, y: number) => calls.push({ op: 'box', x, y }),
    fill: () => calls.push({ op: 'boxfill', fill: g.fillStyle }),
  };
  return { g: g as unknown as TextCanvas, calls };
}

const style = (id: string, change: Partial<TextStyle> = {}): TextStyle => {
  const found = DEFAULT_TEXT_STYLES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`No style ${id}`);
  return { ...found, ...change };
};

const fills = (calls: readonly Call[]) => calls.filter((call) => call.op === 'fill');

describe('drawing a text', () => {
  it('centres a subtitle at the bottom with an outline, in the film’s sans', () => {
    const { g, calls } = recorder();
    drawText(
      g,
      {
        kind: 'subtitle',
        text: 'Hold the light!',
        style: style('subtitle'),
        startSeconds: 0,
        durationSeconds: 2,
        x: null,
        y: null,
      },
      1,
      1000,
      500,
    );
    const [line] = fills(calls);
    expect(line).toMatchObject({ text: 'Hold the light!', x: 500, align: 'center', alpha: 1 });
    expect(line?.font).toContain(TEXT_FAMILIES.sans);
    // Its bottom sits at 93% of the height: one line of 23 px at 1.22 line height.
    expect(line?.y).toBeCloseTo(465 - (23 * 1.22) / 2);
    expect(calls.some((call) => call.op === 'stroke')).toBe(true);
    expect(calls[0]?.op).toBe('save');
    expect(calls.at(-1)?.op).toBe('restore');
  });

  it('sets the role of a lower third smaller and lighter, on a box', () => {
    const { g, calls } = recorder();
    drawText(
      g,
      {
        kind: 'lower-third',
        text: 'Mara Venn\nKeeper of the light',
        style: style('lower-third'),
        startSeconds: 0,
        durationSeconds: 4,
        x: null,
        y: null,
      },
      2,
      1000,
      1000,
    );
    const [name, role] = fills(calls);
    expect(name?.font).toContain('600 42px');
    expect(role?.font).toContain('400 30.24px');
    expect(role?.fill).toBe('rgba(255, 255, 255, 0.82)');
    expect(calls.find((call) => call.op === 'boxfill')?.fill).toBe('rgba(11, 13, 18, 0.62)');
    expect(name?.x).toBe(70);
  });

  it('wraps long words to the style’s width and puts a text where it was placed', () => {
    const { g, calls } = recorder();
    drawText(
      g,
      {
        kind: 'caption',
        text: 'one two three four five six',
        style: style('caption', { width: 10, enter: 'cut', align: 'right', anchor: 'middle' }),
        startSeconds: 0,
        durationSeconds: 3,
        x: 0.9,
        y: 0.5,
      },
      1,
      400,
      200,
    );
    const lines = fills(calls);
    expect(lines.map((line) => line.text)).toEqual(['ONE TWO', 'THREE FOUR', 'FIVE SIX']);
    expect(lines.every((line) => line.x === 360 && line.align === 'right')).toBe(true);
  });

  it('types a caption in and fades a title out', () => {
    const typed = recorder();
    drawText(
      typed.g,
      {
        kind: 'caption',
        text: 'abcdefghij',
        style: style('caption', { uppercase: false }),
        startSeconds: 0,
        durationSeconds: 4,
        x: null,
        y: null,
      },
      0.2,
      400,
      200,
    );
    expect(fills(typed.calls)[0]?.text).toBe('abcde');
    const fading = recorder();
    drawText(
      fading.g,
      {
        kind: 'title',
        text: 'End',
        style: style('title'),
        startSeconds: 0,
        durationSeconds: 4,
        x: null,
        y: null,
      },
      3.6,
      400,
      200,
      0.5,
    );
    expect(fills(fading.calls)[0]?.alpha).toBeCloseTo(0.25);
  });

  it('draws nothing while a text is wholly faded or nothing is typed yet', () => {
    const { g, calls } = recorder();
    const text = {
      kind: 'title' as const,
      text: 'Hi',
      style: style('title'),
      startSeconds: 0,
      durationSeconds: 4,
      x: null,
      y: null,
    };
    drawText(g, text, 0, 400, 200);
    drawText(g, { ...text, style: style('caption') }, 0, 400, 200);
    expect(calls).toEqual([]);
  });

  it('rolls credits up through the frame and skips lines out of sight', () => {
    const { g, calls } = recorder();
    const text = {
      kind: 'credits' as const,
      text: Array.from({ length: 40 }, (_, index) => `Line ${String(index)}`).join('\n'),
      style: style('credits'),
      startSeconds: 0,
      durationSeconds: 10,
      x: null,
      y: null,
    };
    drawText(g, text, 0.5, 400, 200);
    const early = fills(calls).map((line) => line.text);
    expect(early[0]).toBe('Line 0');
    expect(early.length).toBeLessThan(40);
    calls.length = 0;
    drawText(g, text, 9.5, 400, 200);
    expect(fills(calls).at(-1)?.text).toBe('Line 39');
  });
});

describe('drawing the lane', () => {
  const texts = [
    {
      kind: 'subtitle' as const,
      text: 'First',
      startSeconds: 0,
      durationSeconds: 2,
      styleId: 'subtitle',
      x: null,
      y: null,
    },
    {
      kind: 'title' as const,
      text: 'Gone',
      startSeconds: 0,
      durationSeconds: 2,
      styleId: 'title',
      x: null,
      y: null,
      orphaned: true,
    },
    {
      kind: 'caption' as const,
      text: 'Later',
      startSeconds: 5,
      durationSeconds: 2,
      styleId: 'mine',
      x: null,
      y: null,
    },
  ];

  it('draws the texts on screen at a time, not those whose anchor is gone', () => {
    const { g, calls } = recorder();
    drawLane(g, { texts, styles: DEFAULT_TEXT_STYLES, seconds: 1, width: 400, height: 200 });
    expect(fills(calls).map((call) => call.text)).toEqual(['First']);
    calls.length = 0;
    drawTexts(g, [], 1, 400, 200);
    expect(calls).toEqual([]);
  });

  it('sets a title card’s words in the title style, faded with the card', () => {
    const { g, calls } = recorder();
    drawLane(g, {
      texts: [],
      styles: DEFAULT_TEXT_STYLES,
      seconds: 1,
      width: 400,
      height: 200,
      card: { title: 'Chapter One', brightness: 0.4 },
    });
    const [line] = fills(calls);
    expect(line).toMatchObject({ text: 'Chapter One', alpha: 0.4 });
    expect(line?.font).toContain(TEXT_FAMILIES.serif);
    calls.length = 0;
    drawLane(g, {
      texts: [],
      styles: DEFAULT_TEXT_STYLES,
      seconds: 1,
      width: 400,
      height: 200,
      card: { title: '  ', brightness: 1 },
    });
    expect(calls).toEqual([]);
  });
});

describe('the text fonts', () => {
  it('loads every face once, and says when it cannot', async () => {
    const added: unknown[] = [];
    const made: { family: string; weight: string }[] = [];
    class FakeFace {
      constructor(
        readonly family: string,
        readonly source: string,
        readonly descriptors: { weight: string },
      ) {
        made.push({ family, weight: descriptors.weight });
      }
      load(): Promise<unknown> {
        return Promise.resolve(this);
      }
    }
    const scope = { FontFace: FakeFace, fonts: { add: (face: unknown) => added.push(face) } };
    expect(await loadTextFonts(scope)).toBe(true);
    expect(await loadTextFonts(scope)).toBe(true);
    expect(added).toHaveLength(TEXT_FACES.length);
    expect(new Set(made.map((face) => face.family))).toEqual(
      new Set(['Imp Sans', 'Imp Serif', 'Imp Mono']),
    );
    expect(await loadTextFonts({})).toBe(false);
    class Broken extends FakeFace {
      override load(): Promise<unknown> {
        return Promise.reject(new Error('offline'));
      }
    }
    expect(await loadTextFonts({ FontFace: Broken, fonts: { add: () => undefined } })).toBe(false);
  });
});
