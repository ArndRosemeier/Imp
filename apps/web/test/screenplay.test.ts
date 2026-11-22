import { describe, expect, it } from 'vitest';
import { lineType, makeLine } from '../src/app/screenplay.js';
import { minutesText, pagesText } from '../src/app/movie.js';

const SCENE = 'Rain.\n\nMARA\n(shouting)\nHold it!\n\nCUT TO:';

describe('writing a screenplay', () => {
  it('tells the part of a line from it and its neighbours', () => {
    const lines = SCENE.split('\n');
    expect(lines.map((_, at) => lineType(lines, at))).toEqual([
      'action',
      'action',
      'character',
      'parenthetical',
      'dialogue',
      'action',
      'transition',
    ]);
  });

  it('makes a line a name, a direction, speech, a transition or action', () => {
    const text = 'Rain.\nmara';
    const named = makeLine(text, text.length, 'character');
    expect(named.text).toBe('Rain.\n\nMARA');
    expect(named.caret).toBe(named.text.length);
    expect(makeLine('MARA\nwhispering', 12, 'parenthetical').text).toBe('MARA\n(whispering)');
    expect(makeLine('MARA\n\n(Hold it)', 9, 'dialogue').text).toBe('MARA\nHold it');
    expect(makeLine('Rain.\ncut', 8, 'transition').text).toBe('Rain.\n\nCUT TO:');
    expect(makeLine('fade out.', 0, 'transition').text).toBe('FADE OUT.');
    expect(makeLine('Rain.\n\nBANG', 9, 'action').text).toBe('Rain.\n\n!BANG');
  });
});

describe('script length', () => {
  it('counts pages in eighths and minutes in words', () => {
    expect(pagesText(0.1)).toBe('1/8 pages');
    expect(pagesText(1)).toBe('1 page');
    expect(pagesText(2.375)).toBe('2 3/8 pages');
    expect(minutesText(0.4)).toBe('under a minute');
    expect(minutesText(1.2)).toBe('1 minute');
    expect(minutesText(12.6)).toBe('13 minutes');
  });
});
