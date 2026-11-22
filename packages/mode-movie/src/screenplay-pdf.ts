import {
  COLUMNS,
  hidden,
  LINES_PER_PAGE,
  wrapColumns,
  type ScriptElement,
  type ScriptElementType,
} from './fountain.js';
import { parseMarkup } from './text-markup.js';

/**
 * A screenplay set as pages in the standard layout (US Letter, Courier 12
 * point, a 1.5 inch left margin, dialogue indented, page numbers top right)
 * and written as a PDF. Courier is one of the fonts every PDF reader has, so
 * nothing is embedded and the file stays small.
 */

/** Where each part of a screenplay starts, in inches from the left edge of the page. */
const INDENT: Record<ScriptElementType, number> = {
  heading: 1.5,
  action: 1.5,
  character: 3.7,
  parenthetical: 3.1,
  dialogue: 2.5,
  lyric: 2.5,
  transition: 1.5,
  centered: 1.5,
  section: 1.5,
  synopsis: 1.5,
  note: 1.5,
  'page-break': 1.5,
};

/** A line on a page: where it goes and what it says, with emphasis marks. */
export interface PageLine {
  readonly text: string;
  /** Inches from the left edge. */
  readonly x: number;
  readonly align: 'left' | 'right' | 'center';
  readonly bold?: boolean;
  /** A scene heading's number, set in both margins as shooting scripts do. */
  readonly sceneNumber?: string;
  /** Dual dialogue: what the second speaker says on the same line, in the right column. */
  readonly beside?: PageLine;
}

/**
 * Dual dialogue sits in two columns: the first speaker on the left, the
 * second on the right, each about half as wide as ordinary dialogue.
 */
const DUAL = {
  left: { character: 2.4, parenthetical: 1.8, dialogue: 1.5 },
  right: { character: 5.4, parenthetical: 4.8, dialogue: 4.5 },
  columns: { character: 24, parenthetical: 22, dialogue: 28 },
} as const;

/** One line of a page; null is an empty line. */
export type Page = readonly (PageLine | null)[];

interface Block {
  readonly type: ScriptElementType | 'dual';
  readonly lines: PageLine[];
  /** Blank lines before it. */
  readonly space: number;
  /** For dialogue, who says it, so that a page break can say they go on. */
  readonly speaker?: string;
}

function linesOf(element: ScriptElement): PageLine[] {
  const x = INDENT[element.type];
  const text =
    element.type === 'heading' || element.type === 'character' || element.type === 'transition'
      ? element.text.toUpperCase()
      : element.text;
  return wrapColumns(text, COLUMNS[element.type]).map((line, index) => ({
    text: line,
    x: element.type === 'transition' ? 7.5 : element.type === 'centered' ? 4.25 : x,
    align:
      element.type === 'transition' ? 'right' : element.type === 'centered' ? 'center' : 'left',
    ...(element.type === 'heading' ? { bold: true } : {}),
    ...(element.type === 'heading' && index === 0 && element.sceneNumber !== undefined
      ? { sceneNumber: element.sceneNumber }
      : {}),
  }));
}

/** One speaker's part of dual dialogue, set in a narrow column on one side. */
function columnLines(speech: readonly ScriptElement[], side: 'left' | 'right'): PageLine[] {
  const at = DUAL[side];
  return speech.flatMap((element) => {
    const part =
      element.type === 'character'
        ? 'character'
        : element.type === 'parenthetical'
          ? 'parenthetical'
          : 'dialogue';
    const text = element.type === 'character' ? element.text.toUpperCase() : element.text;
    return wrapColumns(text, DUAL.columns[part]).map((line): PageLine => ({
      text: line,
      x: at[part],
      align: 'left',
    }));
  });
}

/** Two speeches side by side, row by row. */
function dualLines(first: readonly ScriptElement[], second: readonly ScriptElement[]): PageLine[] {
  const left = columnLines(first, 'left');
  const right = columnLines(second, 'right');
  const rows: PageLine[] = [];
  for (let row = 0; row < Math.max(left.length, right.length); row += 1) {
    const l = left[row];
    const r = right[row];
    if (l !== undefined) rows.push(r === undefined ? l : { ...l, beside: r });
    else if (r !== undefined) rows.push(r);
  }
  return rows;
}

const SPOKEN = new Set<ScriptElementType>(['parenthetical', 'dialogue', 'lyric']);

/** The elements of one speech starting at `from`: the name and what follows it. */
function speechAt(elements: readonly ScriptElement[], from: number): ScriptElement[] {
  const speech: ScriptElement[] = [];
  for (let at = from; at < elements.length; at += 1) {
    const element = elements[at];
    if (element === undefined) break;
    if (at === from ? element.type !== 'character' : !SPOKEN.has(element.type)) break;
    speech.push(element);
  }
  return speech;
}

/** The screenplay's parts as blocks of lines, with the space between them. */
function blocksOf(all: readonly ScriptElement[]): (Block | 'break')[] {
  const blocks: (Block | 'break')[] = [];
  const elements = all.filter((element) => !hidden(element.type));
  let previous: ScriptElementType | null = null;
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    if (element === undefined) continue;
    if (element.type === 'character') {
      const first = speechAt(elements, index);
      const next = elements[index + first.length];
      // A name marked ^ right after a speech: the two are said at once, side by side.
      if (next?.type === 'character' && next.dual === true) {
        const second = speechAt(elements, index + first.length);
        blocks.push({
          type: 'dual',
          lines: dualLines(first, second),
          space: previous === null ? 0 : 1,
        });
        previous = 'dialogue';
        index += first.length + second.length - 1;
        continue;
      }
    }
    if (element.type === 'page-break') {
      blocks.push('break');
      previous = null;
      continue;
    }
    const joined =
      (previous === 'character' || previous === 'parenthetical' || previous === 'dialogue') &&
      (element.type === 'parenthetical' || element.type === 'dialogue' || element.type === 'lyric');
    blocks.push({
      type: element.type,
      lines: linesOf(element),
      space: previous === null || joined ? 0 : element.type === 'heading' ? 2 : 1,
      ...(element.speaker === undefined ? {} : { speaker: element.speaker }),
    });
    previous = element.type;
  }
  return blocks;
}

/**
 * Lays a screenplay out on pages: a heading is never left alone at the
 * bottom of a page, a character's name stays with their first line, and
 * speech that runs over a page ends in (MORE) and goes on under the name
 * with (CONT'D).
 */
export function screenplayPages(elements: readonly ScriptElement[]): Page[] {
  const pages: (PageLine | null)[][] = [];
  let page: (PageLine | null)[] = [];
  const newPage = (): void => {
    pages.push(page);
    page = [];
  };
  const room = (): number => LINES_PER_PAGE - page.length;
  const blocks = blocksOf(elements);
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block === undefined) continue;
    if (block === 'break') {
      if (page.length > 0) newPage();
      continue;
    }
    const space = page.length === 0 ? 0 : block.space;
    const next = blocks[index + 1];
    // A heading or a name needs the first line of what follows on the same page.
    const keep =
      (block.type === 'heading' || block.type === 'character') &&
      next !== undefined &&
      next !== 'break'
        ? next.space + 1
        : 0;
    if (space + block.lines.length + keep <= room()) {
      for (let blank = 0; blank < space; blank += 1) page.push(null);
      page.push(...block.lines);
      continue;
    }
    const splittable = block.type === 'action' || block.type === 'dialogue';
    const fits = room() - space - (block.type === 'dialogue' ? 1 : 0);
    if (splittable && fits >= 2 && block.lines.length - fits >= 2) {
      for (let blank = 0; blank < space; blank += 1) page.push(null);
      page.push(...block.lines.slice(0, fits));
      if (block.type === 'dialogue') {
        page.push({ text: '(MORE)', x: INDENT.character, align: 'left' });
      }
      newPage();
      if (block.type === 'dialogue' && block.speaker !== undefined) {
        page.push({
          text: `${block.speaker.toUpperCase()} (CONT'D)`,
          x: INDENT.character,
          align: 'left',
        });
      }
      page.push(...block.lines.slice(fits));
      continue;
    }
    if (page.length > 0) newPage();
    // A name that ended the last page comes over with its speech.
    page.push(...block.lines.slice(0, LINES_PER_PAGE));
    let rest = block.lines.slice(LINES_PER_PAGE);
    while (rest.length > 0) {
      newPage();
      page.push(...rest.slice(0, LINES_PER_PAGE));
      rest = rest.slice(LINES_PER_PAGE);
    }
  }
  if (page.length > 0 || pages.length === 0) pages.push(page);
  // Pull a name or heading stranded at the foot of a page over to the next.
  for (let at = 0; at < pages.length - 1; at += 1) {
    const current = pages[at] ?? [];
    const last = current.at(-1);
    if (
      last !== null &&
      last !== undefined &&
      (last.x === INDENT.character || last.bold === true)
    ) {
      if (current.length > 1 && !last.text.endsWith('(MORE)')) {
        current.pop();
        while (current.at(-1) === null) current.pop();
        pages[at + 1] = [last, ...(pages[at + 1] ?? [])];
      }
    }
  }
  return pages;
}

/** Characters PDF's standard encoding has above 127, by code. */
const WIN_ANSI: Record<string, number> = {
  '€': 0x80,
  '‚': 0x82,
  ƒ: 0x83,
  '„': 0x84,
  '…': 0x85,
  '†': 0x86,
  '‡': 0x87,
  ˆ: 0x88,
  '‰': 0x89,
  Š: 0x8a,
  '‹': 0x8b,
  Œ: 0x8c,
  Ž: 0x8e,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '˜': 0x98,
  '™': 0x99,
  š: 0x9a,
  '›': 0x9b,
  œ: 0x9c,
  ž: 0x9e,
  Ÿ: 0x9f,
};

/** Text as a PDF hex string in the standard encoding; letters it lacks become "?". */
function pdfString(text: string): string {
  let hex = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 63;
    const byte = code < 128 || (code >= 0xa0 && code <= 0xff) ? code : (WIN_ANSI[char] ?? 63);
    hex += byte.toString(16).padStart(2, '0');
  }
  return `<${hex}>`;
}

const FONTS = ['F1', 'F2', 'F3', 'F4'] as const;
const fontFor = (bold: boolean, italic: boolean): string =>
  FONTS[(bold ? 1 : 0) + (italic ? 2 : 0)] ?? 'F1';

const POINTS = 72;
const SIZE = 12;
/** Courier's letters are 0.6 of the size wide. */
const ADVANCE = SIZE * 0.6;

const num = (value: number): string => String(Math.round(value * 100) / 100);

/** The drawing of one page: its lines, with emphasis, and its number. */
function pageContent(page: Page, number: number): string {
  const ops: string[] = [];
  const top = 792 - POINTS; // One inch down.
  if (number > 1) {
    const label = `${String(number)}.`;
    ops.push(
      `BT /F1 ${String(SIZE)} Tf ${num(7.5 * POINTS - label.length * ADVANCE)} ${num(792 - 0.5 * POINTS - SIZE)} Td ${pdfString(label)} Tj ET`,
    );
  }
  for (const [row, line] of page.entries()) {
    if (line === null) continue;
    const y = top - (row + 1) * SIZE;
    for (const part of line.beside === undefined ? [line] : [line, line.beside]) {
      ops.push(...lineOps(part, y));
    }
    if (line.sceneNumber !== undefined) {
      const label = pdfString(line.sceneNumber);
      const width = Array.from(line.sceneNumber).length * ADVANCE;
      // In both margins: the left one ends before the text, the right one past the right margin.
      ops.push(
        `BT /F2 ${String(SIZE)} Tf ${num(1.25 * POINTS - width)} ${num(y)} Td ${label} Tj ET`,
        `BT /F2 ${String(SIZE)} Tf ${num(7.75 * POINTS - width)} ${num(y)} Td ${label} Tj ET`,
      );
    }
  }
  return ops.join('\n');
}

/** The drawing of one line, run by run, with its emphasis. */
function lineOps(line: PageLine, y: number): string[] {
  const ops: string[] = [];
  const runs = parseMarkup(line.text);
  const letters = runs.reduce((sum, run) => sum + Array.from(run.text).length, 0);
  const width = letters * ADVANCE;
  let x =
    line.align === 'right'
      ? line.x * POINTS - width
      : line.align === 'center'
        ? line.x * POINTS - width / 2
        : line.x * POINTS;
  for (const run of runs) {
    const font = fontFor(run.bold || line.bold === true, run.italic);
    ops.push(`BT /${font} ${String(SIZE)} Tf ${num(x)} ${num(y)} Td ${pdfString(run.text)} Tj ET`);
    const runWidth = Array.from(run.text).length * ADVANCE;
    if (run.underline) ops.push(`${num(x)} ${num(y - 1.5)} ${num(runWidth)} 0.6 re f`);
    x += runWidth;
  }
  return ops;
}

/** A title page: the title in the middle, the credit and author under it, the rest at the foot. */
function titleContent(title: Record<string, string>): string {
  const ops: string[] = [];
  const centre = (text: string, y: number, bold = false): void => {
    const x = 4.25 * POINTS - (Array.from(text).length * ADVANCE) / 2;
    ops.push(
      `BT /${bold ? 'F2' : 'F1'} ${String(SIZE)} Tf ${num(x)} ${num(y)} Td ${pdfString(text)} Tj ET`,
    );
  };
  let y = 792 - 3.5 * POINTS;
  for (const line of (title['title'] ?? '').split('\n')) {
    centre(line.replace(/[*_]/g, '').toUpperCase(), y, true);
    y -= SIZE * 2;
  }
  y -= SIZE * 2;
  for (const key of ['credit', 'author', 'authors', 'source']) {
    const value = title[key];
    if (value === undefined || value.trim() === '') continue;
    for (const line of value.split('\n')) {
      centre(line, y);
      y -= SIZE * 2;
    }
  }
  let foot = POINTS * 1.5 + SIZE * 4;
  for (const key of ['draft date', 'date', 'contact', 'copyright']) {
    const value = title[key];
    if (value === undefined || value.trim() === '') continue;
    for (const line of value.split('\n')) {
      ops.push(
        `BT /F1 ${String(SIZE)} Tf ${num(1.5 * POINTS)} ${num(foot)} Td ${pdfString(line)} Tj ET`,
      );
      foot -= SIZE;
    }
    foot -= SIZE;
  }
  return ops.join('\n');
}

/** A screenplay as a PDF file, with a title page when the title has one. */
export function screenplayPdf(
  title: Record<string, string>,
  elements: readonly ScriptElement[],
): Uint8Array {
  const pages = screenplayPages(elements);
  const contents: string[] = [];
  if ((title['title'] ?? '').trim() !== '') contents.push(titleContent(title));
  pages.forEach((page, index) => {
    contents.push(pageContent(page, index + 1));
  });
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add('');
  const pagesId = add('');
  const fontIds = ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'].map(
    (name) =>
      add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`),
  );
  const fonts = FONTS.map((name, index) => `/${name} ${String(fontIds[index])} 0 R`).join(' ');
  const pageIds: number[] = [];
  for (const content of contents) {
    const bytes = utf8Length(content);
    const contentId = add(`<< /Length ${String(bytes)} >>\nstream\n${content}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${String(pagesId)} 0 R /MediaBox [0 0 612 792] /Resources << /Font << ${fonts} >> >> /Contents ${String(contentId)} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${String(pagesId)} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${String(id)} 0 R`).join(' ')}] /Count ${String(pageIds.length)} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(utf8Length(out));
    out += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xref = utf8Length(out);
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root ${String(catalog)} 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Uint8Array.from(out, (char) => char.charCodeAt(0) & 0xff);
}

/** Every byte written is ASCII (texts go in as hex), so a length in letters is a length in bytes. */
const utf8Length = (text: string): number => text.length;
