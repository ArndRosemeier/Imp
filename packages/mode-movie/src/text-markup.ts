/**
 * The small markup that texts over the picture are written in, so that a word
 * can be bold, italic, underlined, coloured or sized apart from the rest. It
 * is plain text, so that agents write it as easily as people do, and it uses
 * the marks screenplays use (Fountain), so that the whole app has one way of
 * writing styled text:
 *
 * - `*italic*`, `**bold**`, `***bold italic***`, `_underlined_`
 * - `{#ffd166|coloured}`, `{small|smaller}`, `{big|bigger}`, and together
 *   `{#ffd166 big|both}`
 * - a backslash keeps a mark as it is: `\*`, `\_`, `\{`, `\\`
 *
 * A mark that is not closed is just a character. Markup never breaks a text:
 * whatever is written is shown.
 */

/** A stretch of a text with one look. */
export interface TextRun {
  readonly text: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  /** A colour of its own (#rrggbb), or null for the style's colour. */
  readonly color: string | null;
  /** Its size against the style's size: 1, or smaller or bigger. */
  readonly scale: number;
}

type Look = Omit<TextRun, 'text'>;

const PLAIN: Look = { bold: false, italic: false, underline: false, color: null, scale: 1 };

/** The sizes a span may name, against the style's size. */
export const MARKUP_SIZES = { small: 0.75, big: 1.35 } as const;

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** #abc as #aabbcc, lower case. */
function fullHex(hex: string): string {
  const value = hex.slice(1).toLowerCase();
  return value.length === 3
    ? `#${value
        .split('')
        .map((digit) => digit + digit)
        .join('')}`
    : `#${value}`;
}

/** The look a span's tags give, or null when they are not tags (the brace is then just a brace). */
function tagsLook(tags: string, look: Look): Look | null {
  const words = tags.trim().split(/\s+/);
  if (words.length === 0 || words[0] === '') return null;
  let next = look;
  for (const word of words) {
    const lower = word.toLowerCase();
    if (HEX.test(word)) next = { ...next, color: fullHex(word) };
    else if (lower === 'small' || lower === 'big') {
      next = { ...next, scale: next.scale * MARKUP_SIZES[lower] };
    } else return null;
  }
  return next;
}

const isSpace = (char: string | undefined): boolean => char === undefined || /\s/.test(char);
const isWordChar = (char: string | undefined): boolean =>
  char !== undefined && /[\p{L}\p{N}]/u.test(char);

/** Where the brace opened at `from` closes, minding escapes and inner braces; -1 when it does not. */
function closingBrace(source: string, from: number): number {
  let depth = 0;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      index += 1;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** How many times the character at index repeats from there. */
function runLength(source: string, index: number): number {
  const char = source[index];
  let end = index;
  while (end < source.length && source[end] === char) end += 1;
  return end - index;
}

/**
 * Where a run of `count` marks opened before `from` closes: the next run of
 * exactly that many, right after a letter that is not a space. -1 when none.
 * An underline closes only before a space, punctuation or the end, so that
 * snake_case words keep their underscores.
 */
function closingMark(source: string, from: number, char: '*' | '_', count: number): number {
  for (let index = from; index < source.length; index += 1) {
    const at = source[index];
    if (at === '\\') {
      index += 1;
      continue;
    }
    if (at === '{') {
      const end = closingBrace(source, index);
      if (end > index) index = end;
      continue;
    }
    if (at !== char) continue;
    const length = runLength(source, index);
    if (
      length === count &&
      index > from &&
      !isSpace(source[index - 1]) &&
      (char === '*' || !isWordChar(source[index + length]))
    ) {
      return index;
    }
    index += length - 1;
  }
  return -1;
}

function looksOf(count: number, char: '*' | '_', look: Look): Look {
  if (char === '_') return { ...look, underline: true };
  return {
    ...look,
    italic: look.italic || count !== 2,
    bold: look.bold || count >= 2,
  };
}

function parseInto(source: string, look: Look, runs: TextRun[]): void {
  let text = '';
  const flush = (): void => {
    if (text === '') return;
    const last = runs.at(-1);
    if (
      last?.bold === look.bold &&
      last.italic === look.italic &&
      last.underline === look.underline &&
      last.color === look.color &&
      last.scale === look.scale
    ) {
      runs[runs.length - 1] = { ...last, text: last.text + text };
    } else {
      runs.push({ ...look, text });
    }
    text = '';
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? '';
    const escaped = source[index + 1] ?? '';
    if (char === '\\' && /[\\*_{}|]/.test(escaped) && escaped !== '') {
      text += escaped;
      index += 2;
      continue;
    }
    if (char === '{') {
      const end = closingBrace(source, index);
      const bar = end < 0 ? -1 : source.indexOf('|', index);
      const inner = bar > index && bar < end ? tagsLook(source.slice(index + 1, bar), look) : null;
      if (inner !== null) {
        flush();
        parseInto(source.slice(bar + 1, end), inner, runs);
        index = end + 1;
        continue;
      }
    }
    if (char === '*' || char === '_') {
      const count = Math.min(runLength(source, index), char === '*' ? 3 : 1);
      const opensWord = char === '*' || !isWordChar(source[index - 1]);
      const end =
        opensWord && !isSpace(source[index + count])
          ? closingMark(source, index + count, char, count)
          : -1;
      if (end > 0) {
        flush();
        parseInto(source.slice(index + count, end), looksOf(count, char, look), runs);
        index = end + count;
        continue;
      }
      // Not a mark: the whole run of them is shown as it is.
      const length = runLength(source, index);
      text += source.slice(index, index + length);
      index += length;
      continue;
    }
    text += char;
    index += 1;
  }
  flush();
}

/** A text's runs, in order; new lines stay in the runs' text. */
export function parseMarkup(source: string): TextRun[] {
  const runs: TextRun[] = [];
  parseInto(source, PLAIN, runs);
  return runs;
}

/** A text's lines, each a list of runs (an empty line is an empty list). */
export function markupLines(source: string): TextRun[][] {
  const lines: TextRun[][] = [[]];
  for (const run of parseMarkup(source)) {
    const parts = run.text.split('\n');
    for (const [index, part] of parts.entries()) {
      if (index > 0) lines.push([]);
      if (part !== '') lines.at(-1)?.push({ ...run, text: part });
    }
  }
  return lines;
}

/** The words of a text without its marks. */
export function plainText(source: string): string {
  return parseMarkup(source)
    .map((run) => run.text)
    .join('');
}

/** Words written as they are, with every mark kept from being read as markup. */
export function escapeMarkup(words: string): string {
  return words.replace(/[\\*_{}]/g, (char) => `\\${char}`);
}

/** Whether a text uses any markup at all. */
export function hasMarkup(source: string): boolean {
  return parseMarkup(source).some(
    (run) => run.bold || run.italic || run.underline || run.color !== null || run.scale !== 1,
  );
}

const escapeTags = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A text as subtitle files style it: <b>, <i> and <u> in both, and colours as
 * <font color> in SubRip (which most players read). Sizes have no tag and are
 * left out.
 */
export function subtitleMarkup(source: string, format: 'srt' | 'vtt'): string {
  return parseMarkup(source)
    .map((run) => {
      let text = format === 'vtt' ? escapeTags(run.text) : run.text;
      if (run.underline) text = `<u>${text}</u>`;
      if (run.italic) text = `<i>${text}</i>`;
      if (run.bold) text = `<b>${text}</b>`;
      if (run.color !== null && format === 'srt')
        text = `<font color="${run.color}">${text}</font>`;
      return text;
    })
    .join('');
}

/** How many letters a text shows, for reading speed and typing. */
export const letterCount = (source: string): number => plainText(source).length;

/**
 * How fast a subtitle has to be read, in letters a second. Subtitling guides
 * keep adult subtitles at or below about 17 (Netflix allows 20).
 */
export function readingSpeed(source: string, seconds: number): number {
  const letters = plainText(source).replace(/\s+/g, ' ').trim().length;
  return Math.round((letters / Math.max(0.2, seconds)) * 10) / 10;
}

/** Above this many letters a second, a subtitle is flagged as hard to read. */
export const FAST_READING = 20;
