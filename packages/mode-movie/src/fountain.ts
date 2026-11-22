import { escapeMarkup, markupLines, plainText, type TextRun } from './text-markup.js';

/**
 * Screenplays in Fountain (https://fountain.io), the plain-text screenplay
 * format: a scene's text is written the way screenwriters write it, and this
 * reads it into the parts of a screenplay (action, a character's name, the
 * words they say, how they say them, transitions) so that Imp can set it as
 * a script page, count its pages, find its dialogue and write it as a PDF or
 * a Final Draft file. Emphasis (`*italic*`, `**bold**`, `_underline_`) is the
 * same markup the texts in films use.
 */

export type ScriptElementType =
  | 'heading'
  | 'action'
  | 'character'
  | 'parenthetical'
  | 'dialogue'
  | 'lyric'
  | 'transition'
  | 'centered'
  | 'section'
  | 'synopsis'
  | 'note'
  | 'page-break';

export interface ScriptElement {
  readonly type: ScriptElementType;
  /** The words, with their emphasis marks; for a character, the name and its extension. */
  readonly text: string;
  /** For dialogue, parentheticals and characters: the speaker's name, without extension. */
  readonly speaker?: string;
  /** A character's extension, such as V.O., O.S. or CONT'D, without the brackets. */
  readonly extension?: string;
  /** Dual dialogue: this character speaks at the same time as the one before. */
  readonly dual?: boolean;
  /** For a heading, the scene number written after it (#12#), if any. */
  readonly sceneNumber?: string;
  /** For a section, how deep it is (# is 1). */
  readonly depth?: number;
}

const HEADING = /^(?:INT|EXT|EST|INT\.?\/EXT|I\/E)[ .]/i;
const SCENE_NUMBER = /\s*#([\w.-]+)#\s*$/;

/** Where a note was taken out of a line; a character no script contains. */
const NOTE_MARK = '\uE000';

/** Takes out boneyard (/* … *\/) and notes ([[ … ]]) that sit inside lines. */
function stripHidden(source: string): { text: string; notes: string[] } {
  const notes: string[] = [];
  const text = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\[\[([\s\S]*?)\]\]/g, (_match, note: string) => {
      notes.push(note.trim());
      return NOTE_MARK;
    });
  return { text, notes };
}

const isUpper = (line: string): boolean => /\p{Lu}/u.test(line) && line === line.toUpperCase();

/** A character cue: the name, its extension in brackets and the dual mark. */
function readCharacter(line: string): { name: string; extension?: string; dual: boolean } {
  let rest = line.trim();
  const dual = rest.endsWith('^');
  if (dual) rest = rest.slice(0, -1).trim();
  if (rest.startsWith('@')) rest = rest.slice(1);
  const match = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(rest);
  if (match !== null) {
    return { name: (match[1] ?? '').trim(), extension: (match[2] ?? '').trim(), dual };
  }
  return { name: rest, dual };
}

/** Whether a line could be a character's cue (the rest decides by what follows it). */
function looksLikeCharacter(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith('@')) return trimmed.length > 1;
  if (trimmed.startsWith('!') || trimmed.startsWith('.') || trimmed.startsWith('>')) return false;
  // The name before any extension is in capitals; the extension may not be.
  const name = trimmed.replace(/\s*\^$/, '').replace(/\s*\([^)]*\)\s*$/, '');
  return name !== '' && isUpper(name) && !/^\d+$/.test(name) && !HEADING.test(`${name} `);
}

/**
 * Reads Fountain text into the parts of a screenplay. Works on a whole script
 * or on one scene's text; a title page, if there is one, is left out (see
 * fountainTitlePage).
 */
export function parseFountain(source: string): ScriptElement[] {
  const { text, notes } = stripHidden(source.replace(/\r\n?/g, '\n'));
  const lines = text.split('\n');
  const elements: ScriptElement[] = [];
  let noteIndex = 0;
  const unnote = (line: string): string =>
    line.replaceAll(NOTE_MARK, () => {
      const note = notes[noteIndex] ?? '';
      noteIndex += 1;
      elements.push({ type: 'note', text: note });
      return '';
    });
  let index = startAfterTitlePage(lines);
  const blank = (at: number): boolean => at < 0 || (lines[at] ?? '').trim() === '';
  let action: string[] = [];
  const flushAction = (): void => {
    while (action.length > 0 && (action.at(-1) ?? '').trim() === '') action.pop();
    if (action.length > 0) elements.push({ type: 'action', text: action.join('\n') });
    action = [];
  };
  while (index < lines.length) {
    const raw = unnote(lines[index] ?? '');
    const line = raw.trimEnd();
    const trimmed = line.trim();
    const before = blank(index - 1);
    const after = blank(index + 1);
    if (trimmed === '') {
      if (action.length > 0) action.push('');
      index += 1;
      continue;
    }
    if (/^={3,}$/.test(trimmed)) {
      flushAction();
      elements.push({ type: 'page-break', text: '' });
      index += 1;
      continue;
    }
    if (trimmed.startsWith('#')) {
      flushAction();
      const depth = /^#+/.exec(trimmed)?.[0].length ?? 1;
      elements.push({ type: 'section', text: trimmed.slice(depth).trim(), depth });
      index += 1;
      continue;
    }
    if (trimmed.startsWith('=') && !trimmed.startsWith('==')) {
      flushAction();
      elements.push({ type: 'synopsis', text: trimmed.slice(1).trim() });
      index += 1;
      continue;
    }
    if (trimmed.startsWith('~')) {
      flushAction();
      elements.push({ type: 'lyric', text: trimmed.slice(1).trim() });
      index += 1;
      continue;
    }
    if (trimmed.startsWith('>') && trimmed.endsWith('<')) {
      flushAction();
      elements.push({ type: 'centered', text: trimmed.slice(1, -1).trim() });
      index += 1;
      continue;
    }
    if (trimmed.startsWith('!')) {
      // Forced action keeps going until a blank line.
      action.push(line.replace(/^(\s*)!/, '$1'));
      index += 1;
      continue;
    }
    const forcedHeading = trimmed.startsWith('.') && !trimmed.startsWith('..');
    if (before && (forcedHeading || HEADING.test(trimmed))) {
      flushAction();
      let heading = forcedHeading ? trimmed.slice(1).trim() : trimmed;
      const number = SCENE_NUMBER.exec(heading);
      if (number !== null) heading = heading.slice(0, number.index).trim();
      elements.push({
        type: 'heading',
        text: forcedHeading ? heading : heading.toUpperCase(),
        ...(number === null ? {} : { sceneNumber: number[1] ?? '' }),
      });
      index += 1;
      continue;
    }
    if (
      trimmed.startsWith('>') ||
      (before && after && isUpper(trimmed) && trimmed.endsWith('TO:'))
    ) {
      flushAction();
      elements.push({ type: 'transition', text: trimmed.replace(/^>\s*/, '') });
      index += 1;
      continue;
    }
    if (before && !after && looksLikeCharacter(trimmed)) {
      flushAction();
      const cue = readCharacter(trimmed);
      elements.push({
        type: 'character',
        text: cue.extension === undefined ? cue.name : `${cue.name} (${cue.extension})`,
        speaker: cue.name,
        ...(cue.extension === undefined ? {} : { extension: cue.extension }),
        ...(cue.dual ? { dual: true } : {}),
      });
      index += 1;
      // What follows, up to a blank line, is said by them, with how they say it in brackets.
      let words: string[] = [];
      const flushWords = (): void => {
        if (words.length > 0) {
          elements.push({ type: 'dialogue', text: words.join('\n'), speaker: cue.name });
        }
        words = [];
      };
      while (index < lines.length) {
        const spoken = unnote(lines[index] ?? '');
        if (spoken.trim() === '' && spoken !== '  ') break;
        const said = spoken.trim();
        if (said.startsWith('(') && said.endsWith(')')) {
          flushWords();
          elements.push({ type: 'parenthetical', text: said, speaker: cue.name });
        } else if (said.startsWith('~')) {
          flushWords();
          elements.push({ type: 'lyric', text: said.slice(1).trim(), speaker: cue.name });
        } else {
          words.push(said);
        }
        index += 1;
      }
      flushWords();
      continue;
    }
    action.push(line);
    index += 1;
  }
  flushAction();
  return elements;
}

/** Where the text starts after a title page ("Title: …" lines at the very top), if there is one. */
function startAfterTitlePage(lines: readonly string[]): number {
  if (
    !/^(title|credit|author|authors|source|draft date|date|contact|notes|copyright):/i.test(
      lines[0] ?? '',
    )
  ) {
    return 0;
  }
  const end = lines.findIndex((line) => line.trim() === '');
  return end < 0 ? lines.length : end + 1;
}

/** The fields of a title page at the top of a Fountain script, by lower-case key. */
export function fountainTitlePage(source: string): Record<string, string> {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const end = startAfterTitlePage(lines);
  const fields: Record<string, string> = {};
  let key: string | null = null;
  for (const line of lines.slice(0, end)) {
    const match = /^([A-Za-z ]+):\s*(.*)$/.exec(line);
    if (match !== null) {
      key = (match[1] ?? '').trim().toLowerCase();
      fields[key] = (match[2] ?? '').trim();
    } else if (key !== null && line.trim() !== '') {
      fields[key] = `${fields[key] ?? ''}${fields[key] ? '\n' : ''}${line.trim()}`;
    }
  }
  return fields;
}

/** A scene heading as Fountain writes it: forced with a full stop when it does not start INT or EXT. */
export function headingLine(heading: string): string {
  const trimmed = heading.trim();
  if (trimmed === '') return '';
  return HEADING.test(trimmed) ? trimmed.toUpperCase() : `.${trimmed}`;
}

/** A scene as it is written in a script. */
export interface ScriptScene {
  readonly heading: string;
  readonly summary: string;
  readonly body: string;
}

/** A whole script as one Fountain file: a title page, then every scene. */
export function toFountain(title: Record<string, string>, scenes: readonly ScriptScene[]): string {
  const page = Object.entries(title)
    .filter(([, value]) => value.trim() !== '')
    .map(([key, value]) => {
      const name = key.replace(/\b\w/g, (char) => char.toUpperCase());
      return value.includes('\n')
        ? `${name}:\n${value
            .split('\n')
            .map((line) => `    ${line}`)
            .join('\n')}`
        : `${name}: ${value}`;
    });
  const parts: string[] = page.length > 0 ? [page.join('\n')] : [];
  for (const scene of scenes) {
    const lines: string[] = [];
    const heading = headingLine(scene.heading);
    if (heading !== '') lines.push(heading);
    if (scene.summary.trim() !== '') lines.push(`= ${scene.summary.trim().replace(/\n+/g, ' ')}`);
    const head = lines.join('\n\n');
    const body = scene.body.trim();
    parts.push([head, body].filter((part) => part !== '').join('\n\n'));
  }
  return `${parts.join('\n\n')}\n`;
}

/**
 * A Fountain script cut into scenes at its headings: each scene's heading,
 * the synopsis right after it as its summary, and the rest as its text.
 * Writing before the first heading becomes a scene without a heading.
 */
export function fountainScenes(source: string): ScriptScene[] {
  const normal = source.replace(/\r\n?/g, '\n');
  const lines = normal.split('\n');
  const start = startAfterTitlePage(lines);
  const scenes: { heading: string; lines: string[] }[] = [];
  let current: { heading: string; lines: string[] } = { heading: '', lines: [] };
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    const before = index === start || (lines[index - 1] ?? '').trim() === '';
    const forced = trimmed.startsWith('.') && !trimmed.startsWith('..');
    if (before && (forced || HEADING.test(trimmed))) {
      if (current.heading !== '' || current.lines.some((candidate) => candidate.trim() !== '')) {
        scenes.push(current);
      }
      let heading = forced ? trimmed.slice(1).trim() : trimmed.toUpperCase();
      const number = SCENE_NUMBER.exec(heading);
      if (number !== null) heading = heading.slice(0, number.index).trim();
      current = { heading, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.heading !== '' || current.lines.some((candidate) => candidate.trim() !== '')) {
    scenes.push(current);
  }
  return scenes.map((scene) => {
    const body = [...scene.lines];
    while (body.length > 0 && (body[0] ?? '').trim() === '') body.shift();
    let summary = '';
    const first = (body[0] ?? '').trim();
    if (first.startsWith('=') && !first.startsWith('==')) {
      summary = first.slice(1).trim();
      body.shift();
    }
    return { heading: scene.heading, summary, body: body.join('\n').trim() };
  });
}

/** A line someone says in a scene's text, as the script has it. */
export interface ScriptLine {
  /** Its place among the scene's lines, from 0. */
  readonly index: number;
  readonly speaker: string;
  readonly extension: string | null;
  /** How it is said, from the parentheticals before and within it, without brackets. */
  readonly direction: string;
  /** The words, without emphasis marks. */
  readonly words: string;
}

/** The lines spoken in a scene's text, each with who says it and how. */
export function scriptLines(body: string): ScriptLine[] {
  const elements = parseFountain(body);
  const lines: ScriptLine[] = [];
  let speaker = '';
  let extension: string | null = null;
  let directions: string[] = [];
  let words: string[] = [];
  const flush = (): void => {
    if (words.length > 0) {
      lines.push({
        index: lines.length,
        speaker,
        extension,
        direction: directions.join('; '),
        words: words.join(' '),
      });
    }
    directions = [];
    words = [];
  };
  for (const element of elements) {
    if (element.type === 'character') {
      flush();
      speaker = element.speaker ?? element.text;
      extension = element.extension ?? null;
    } else if (element.type === 'parenthetical') {
      directions.push(
        plainText(element.text)
          .replace(/^\(|\)$/g, '')
          .trim(),
      );
    } else if (element.type === 'dialogue' || (element.type === 'lyric' && element.speaker)) {
      words.push(plainText(element.text).replace(/\s+/g, ' ').trim());
    } else if (element.type !== 'note') {
      flush();
    }
  }
  flush();
  return lines;
}

/** Words compared loosely: case, punctuation and spacing do not count. */
export const looseWords = (words: string): string =>
  words
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * How many lines each part of a screenplay takes on a page, with the widths
 * of the standard layout (Courier 12 point, 10 letters to the inch): action
 * 6 inches, dialogue 3.5, parentheticals 2.5.
 */
export const COLUMNS: Record<ScriptElementType, number> = {
  heading: 60,
  action: 60,
  character: 38,
  parenthetical: 25,
  dialogue: 35,
  lyric: 35,
  transition: 60,
  centered: 60,
  section: 60,
  synopsis: 60,
  note: 60,
  'page-break': 60,
};

/** A run written back as markup, with only the marks a screenplay keeps. */
function runMarkup(run: TextRun): string {
  if (run.text.trim() === '') return run.text;
  // Marks hug the words; spaces around them stay outside.
  const lead = /^\s*/.exec(run.text)?.[0] ?? '';
  const tail = /\s*$/.exec(run.text)?.[0] ?? '';
  let words = escapeMarkup(run.text.trim());
  if (run.underline) words = `_${words}_`;
  const stars = (run.bold ? 2 : 0) + (run.italic ? 1 : 0);
  if (stars > 0) words = `${'*'.repeat(stars)}${words}${'*'.repeat(stars)}`;
  return lead + words + tail;
}

/** A line's runs as markup, neighbours of one look written as one. */
function lineMarkup(runs: readonly TextRun[]): string {
  const merged: TextRun[] = [];
  for (const run of runs) {
    const last = merged.at(-1);
    if (last?.bold === run.bold && last.italic === run.italic && last.underline === run.underline) {
      merged[merged.length - 1] = { ...last, text: last.text + run.text };
    } else {
      merged.push(run);
    }
  }
  return merged.map(runMarkup).join('');
}

/**
 * A paragraph broken into lines of at most columns letters, at spaces. The
 * emphasis marks are kept on each line, so that a bold phrase that breaks
 * over two lines is bold on both.
 */
export function wrapColumns(text: string, columns: number): string[] {
  const out: string[] = [];
  for (const runs of markupLines(text)) {
    const words: TextRun[][] = [[]];
    for (const run of runs) {
      for (const part of run.text.split(/(\s+)/)) {
        if (part === '') continue;
        if (/^\s+$/.test(part)) words.push([]);
        else words.at(-1)?.push({ ...run, text: part });
      }
    }
    let line: TextRun[] = [];
    let length = 0;
    for (const word of words.filter((candidate) => candidate.length > 0)) {
      let size = word.reduce((sum, run) => sum + Array.from(run.text).length, 0);
      if (length > 0 && length + 1 + size > columns) {
        out.push(lineMarkup(line));
        line = [];
        length = 0;
      }
      if (length > 0) {
        const last = line.at(-1);
        if (last !== undefined) line[line.length - 1] = { ...last, text: `${last.text} ` };
        length += 1;
      }
      // A word longer than a line is broken where it must be.
      let pieces = word;
      while (length + size > columns && size > columns) {
        const room = columns - length;
        const taken: TextRun[] = [];
        let left = room;
        const rest: TextRun[] = [];
        for (const run of pieces) {
          const letters = Array.from(run.text);
          if (left <= 0) rest.push(run);
          else if (letters.length <= left) {
            taken.push(run);
            left -= letters.length;
          } else {
            taken.push({ ...run, text: letters.slice(0, left).join('') });
            rest.push({ ...run, text: letters.slice(left).join('') });
            left = 0;
          }
        }
        out.push(lineMarkup([...line, ...taken]));
        line = [];
        length = 0;
        pieces = rest;
        size = rest.reduce((sum, run) => sum + Array.from(run.text).length, 0);
      }
      line.push(...pieces);
      length += size;
    }
    out.push(lineMarkup(line));
  }
  return out;
}

/** The lines of a page: about 55 at 12 point between one-inch margins. */
export const LINES_PER_PAGE = 55;

/** Which parts of a screenplay are not printed on its pages. */
export const hidden = (type: ScriptElementType): boolean =>
  type === 'section' || type === 'synopsis' || type === 'note';

/** How long a script runs on the page: pages, and minutes at the usual page a minute. */
export function scriptLength(elements: readonly ScriptElement[]): {
  lines: number;
  pages: number;
  minutes: number;
} {
  let lines = 0;
  let previous: ScriptElementType | null = null;
  for (const element of elements) {
    if (hidden(element.type)) continue;
    if (element.type === 'page-break') {
      lines = Math.ceil(lines / LINES_PER_PAGE) * LINES_PER_PAGE;
      continue;
    }
    const joined =
      previous === 'character' || previous === 'parenthetical' || previous === 'dialogue'
        ? element.type === 'parenthetical' ||
          element.type === 'dialogue' ||
          element.type === 'lyric'
        : false;
    if (previous !== null && !joined) lines += element.type === 'heading' ? 2 : 1;
    lines += wrapColumns(element.text, COLUMNS[element.type]).length;
    previous = element.type;
  }
  const pages = Math.round((lines / LINES_PER_PAGE) * 8) / 8;
  return { lines, pages, minutes: Math.round(pages * 10) / 10 };
}
