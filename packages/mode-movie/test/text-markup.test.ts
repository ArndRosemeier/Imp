import { describe, expect, it } from 'vitest';
import {
  escapeMarkup,
  hasMarkup,
  markupLines,
  parseMarkup,
  plainText,
  readingSpeed,
  subtitleMarkup,
  toSrt,
  toVtt,
} from '../src/index.js';

const looks = (source: string) =>
  parseMarkup(source).map((run) => {
    const marks = [
      run.bold ? 'b' : '',
      run.italic ? 'i' : '',
      run.underline ? 'u' : '',
      run.color ?? '',
      run.scale === 1 ? '' : `x${String(run.scale)}`,
    ].join('');
    return marks === '' ? run.text : `${run.text}:${marks}`;
  });

describe('text markup', () => {
  it('reads italic, bold, bold italic and underline', () => {
    expect(looks('a *b* c')).toEqual(['a ', 'b:i', ' c']);
    expect(looks('**Hold** it')).toEqual(['Hold:b', ' it']);
    expect(looks('***now***')).toEqual(['now:bi']);
    expect(looks('_mine_')).toEqual(['mine:u']);
    expect(looks('*a **b** c*')).toEqual(['a :i', 'b:bi', ' c:i']);
  });

  it('reads colours and sizes, alone and together, and nests them', () => {
    expect(looks('{#ffd166|gold} rest')).toEqual(['gold:#ffd166', ' rest']);
    expect(looks('{#FD1|short}')).toEqual(['short:#ffdd11']);
    expect(looks('{small|Directed by}')).toEqual(['Directed by:x0.75']);
    expect(looks('{#ff0000 big|*loud*}')).toEqual(['loud:i#ff0000x1.35']);
  });

  it('leaves marks that are not closed, or not markup, as they are', () => {
    expect(plainText('2 * 3 = 6')).toBe('2 * 3 = 6');
    expect(plainText('*open')).toBe('*open');
    expect(plainText('snake_case_name')).toBe('snake_case_name');
    expect(plainText('{not a tag|x}')).toBe('{not a tag|x}');
    expect(plainText('{brace}')).toBe('{brace}');
    expect(plainText('** spaced **')).toBe('** spaced **');
    expect(hasMarkup('2 * 3 = 6')).toBe(false);
    expect(hasMarkup('a *b*')).toBe(true);
  });

  it('keeps escaped marks, and escapes words so they read back unchanged', () => {
    expect(plainText('\\*not italic\\*')).toBe('*not italic*');
    const words = 'Rate *5* {stars} \\ a_b';
    expect(plainText(escapeMarkup(words))).toBe(words);
    expect(hasMarkup(escapeMarkup('*x*'))).toBe(false);
  });

  it('splits into lines, keeping the look across a new line', () => {
    const lines = markupLines('{small|Directed by\nJo} Hale\n\nEnd');
    expect(lines.map((line) => line.map((run) => run.text))).toEqual([
      ['Directed by'],
      ['Jo', ' Hale'],
      [],
      ['End'],
    ]);
    expect(lines[1]?.[0]?.scale).toBe(0.75);
  });

  it('writes subtitle files with tags players read', () => {
    expect(subtitleMarkup('*off screen* {#ff0000|red}', 'srt')).toBe(
      '<i>off screen</i> <font color="#ff0000">red</font>',
    );
    expect(subtitleMarkup('**a** < b', 'vtt')).toBe('<b>a</b> &lt; b');
    expect(toSrt([{ startSeconds: 0, endSeconds: 1, text: '_u_' }])).toContain('<u>u</u>');
    expect(toVtt([{ startSeconds: 0, endSeconds: 1, text: '*i*' }])).toContain('<i>i</i>');
  });

  it('measures reading speed on the words alone', () => {
    expect(readingSpeed('**ten letter**', 1)).toBe(10);
    expect(readingSpeed('abc', 0)).toBe(15);
  });
});
