import { describe, expect, it } from 'vitest';
import { snapBox, wrapSelection } from '../src/app/texts.js';

describe('styling the selected words', () => {
  it('wraps the selection in marks and keeps it selected', () => {
    expect(wrapSelection('Hold the light', 5, 8, '**', '**')).toEqual({
      value: 'Hold **the** light',
      from: 7,
      to: 10,
    });
  });

  it('takes the marks away again when the selection already has them', () => {
    expect(wrapSelection('Hold **the** light', 7, 10, '**', '**')).toEqual({
      value: 'Hold the light',
      from: 5,
      to: 8,
    });
    expect(wrapSelection('a {#ffd166|b} c', 2, 13, '{#ffd166|', '}')).toEqual({
      value: 'a b c',
      from: 2,
      to: 3,
    });
  });

  it('puts the marks at the caret when nothing is selected', () => {
    expect(wrapSelection('ab', 1, 1, '*', '*')).toEqual({ value: 'a**b', from: 2, to: 2 });
  });
});

describe('placing a text on the picture', () => {
  const box = { left: 100, top: 100, width: 200, height: 40 };

  it('moves freely away from the guides', () => {
    expect(snapBox(box, 37, 21, 1000, 500)).toEqual({ dx: 37, dy: 21, guides: [] });
  });

  it('snaps to the centre and to the title-safe edges when close', () => {
    // The box's centre (200) dragged to 497 snaps to the middle at 500.
    const centred = snapBox(box, 297, 0, 1000, 500);
    expect(centred.dx).toBe(300);
    expect(centred.guides).toContain('centre-x');
    // Its left edge dragged to 46 snaps to the title-safe edge at 50.
    expect(snapBox(box, -54, 0, 1000, 500).dx).toBe(-50);
    // Its bottom dragged to 470 snaps to the title-safe bottom at 475.
    const low = snapBox(box, 0, 330, 1000, 500);
    expect(low.dy).toBe(335);
    expect(low.guides).toContain('bottom');
  });
});
