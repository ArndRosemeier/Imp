import { parseFountain, type ScriptElement, type ScriptElementType } from './fountain.js';
import { escapeMarkup, parseMarkup } from './text-markup.js';

/**
 * Final Draft files (.fdx), the format most screenwriters and productions
 * exchange scripts in: written from a screenplay's parts, and read back into
 * Fountain so that Imp keeps one way of writing scripts.
 */

const PARAGRAPH: Partial<Record<ScriptElementType, string>> = {
  heading: 'Scene Heading',
  action: 'Action',
  character: 'Character',
  parenthetical: 'Parenthetical',
  dialogue: 'Dialogue',
  lyric: 'Dialogue',
  transition: 'Transition',
  centered: 'Action',
};

const xml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function textsOf(words: string): string {
  return parseMarkup(words)
    .map((run) => {
      const styles = [
        run.bold ? 'Bold' : '',
        run.italic ? 'Italic' : '',
        run.underline ? 'Underline' : '',
      ]
        .filter((style) => style !== '')
        .join('+');
      return styles === ''
        ? `<Text>${xml(run.text)}</Text>`
        : `<Text Style="${styles}">${xml(run.text)}</Text>`;
    })
    .join('');
}

/** A screenplay as a Final Draft document, with its title page. */
export function toFdx(title: Record<string, string>, elements: readonly ScriptElement[]): string {
  const paragraphs: string[] = [];
  for (const element of elements) {
    if (element.type === 'page-break') {
      const last = paragraphs.length - 1;
      if (last >= 0) {
        paragraphs[last] = (paragraphs[last] ?? '').replace(
          '<Paragraph ',
          '<Paragraph StartsNewPage="Yes" ',
        );
      }
      continue;
    }
    const type = PARAGRAPH[element.type];
    if (type === undefined) continue;
    const words = element.type === 'lyric' ? `*${element.text}*` : element.text;
    const centred = element.type === 'centered' ? ' Alignment="Center"' : '';
    const number =
      element.type === 'heading' && element.sceneNumber !== undefined
        ? ` Number="${xml(element.sceneNumber)}"`
        : '';
    for (const line of words.split('\n')) {
      paragraphs.push(
        `    <Paragraph Type="${type}"${centred}${number}>${textsOf(line)}</Paragraph>`,
      );
    }
  }
  const titleLines: string[] = [];
  const centre = (text: string): void => {
    titleLines.push(
      `      <Paragraph Alignment="Center" Type="Action">${textsOf(text)}</Paragraph>`,
    );
  };
  if ((title['title'] ?? '').trim() !== '') {
    for (let blank = 0; blank < 12; blank += 1)
      titleLines.push('      <Paragraph Type="Action"><Text></Text></Paragraph>');
    centre(title['title'] ?? '');
    for (const key of ['credit', 'author', 'authors', 'source']) {
      const value = title[key];
      if (value !== undefined && value.trim() !== '') {
        titleLines.push('      <Paragraph Type="Action"><Text></Text></Paragraph>');
        centre(value);
      }
    }
  }
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>',
    '<FinalDraft DocumentType="Script" Template="No" Version="5">',
    '  <Content>',
    ...paragraphs,
    '  </Content>',
    '  <TitlePage>',
    '    <Content>',
    ...titleLines,
    '    </Content>',
    '  </TitlePage>',
    '</FinalDraft>',
    '',
  ].join('\n');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const unxml = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[entity.toLowerCase()] ?? match;
  });

const attribute = (tag: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

/** The words of a paragraph, with Final Draft's bold, italic and underline as Fountain marks. */
function paragraphWords(inner: string): string {
  let words = '';
  for (const match of inner.matchAll(/<Text\b([^>]*)>([\s\S]*?)<\/Text>|<Text\b[^>]*\/>/g)) {
    const text = unxml(match[2] ?? '');
    if (text === '') continue;
    const style = attribute(match[1] ?? '', 'Style') ?? '';
    let marked = escapeMarkup(text.trim());
    if (marked === '') {
      words += text;
      continue;
    }
    if (/Underline/i.test(style)) marked = `_${marked}_`;
    const stars = (/Bold/i.test(style) ? 2 : 0) + (/Italic/i.test(style) ? 1 : 0);
    if (stars > 0) marked = `${'*'.repeat(stars)}${marked}${'*'.repeat(stars)}`;
    const lead = /^\s*/.exec(text)?.[0] ?? '';
    const tail = /\s*$/.exec(text)?.[0] ?? '';
    words += lead + marked + tail;
  }
  return words;
}

/**
 * A Final Draft document as a Fountain script, with a title page from its
 * title page. Paragraph types Fountain has no mark for become action.
 */
export function fdxToFountain(document: string): string {
  const content = /<FinalDraft[\s\S]*?<Content>([\s\S]*?)<\/Content>/.exec(document)?.[1] ?? '';
  const out: string[] = [];
  let previous = '';
  for (const match of content.matchAll(/<Paragraph\b([^>]*)>([\s\S]*?)<\/Paragraph>/g)) {
    const type = attribute(match[1] ?? '', 'Type') ?? 'Action';
    const words = paragraphWords(match[2] ?? '').trim();
    if (attribute(match[1] ?? '', 'StartsNewPage') === 'Yes' && out.length > 0) out.push('', '===');
    if (words === '') continue;
    const speech = type === 'Dialogue' || type === 'Parenthetical';
    const joined =
      speech &&
      (previous === 'Character' || previous === 'Dialogue' || previous === 'Parenthetical');
    if (!joined && out.length > 0) out.push('');
    if (type === 'Scene Heading') {
      const number = attribute(match[1] ?? '', 'Number');
      const heading = /^(INT|EXT|EST|I\/E)/i.test(words) ? words.toUpperCase() : `.${words}`;
      out.push(number === undefined ? heading : `${heading} #${number}#`);
    } else if (type === 'Character') {
      out.push(/\p{Ll}/u.test(words.replace(/\([^)]*\)/g, '')) ? `@${words}` : words);
    } else if (type === 'Parenthetical') {
      out.push(words.startsWith('(') ? words : `(${words})`);
    } else if (type === 'Transition') {
      out.push(words.endsWith('TO:') && words === words.toUpperCase() ? words : `> ${words}`);
    } else if (attribute(match[1] ?? '', 'Alignment') === 'Center') {
      out.push(`> ${words} <`);
    } else {
      // Action that a reader would take for something else is marked as action.
      const fountain = parseFountain(`\n${words}\n`);
      out.push(fountain.length === 1 && fountain[0]?.type === 'action' ? words : `!${words}`);
    }
    previous = type;
  }
  const titlePage = /<TitlePage>([\s\S]*?)<\/TitlePage>/.exec(document)?.[1] ?? '';
  const titleLines = [...titlePage.matchAll(/<Paragraph\b[^>]*>([\s\S]*?)<\/Paragraph>/g)]
    .map((match) => paragraphWords(match[1] ?? '').trim())
    .filter((line) => line !== '');
  const head =
    titleLines.length > 0
      ? `Title: ${titleLines[0] ?? ''}${titleLines.length > 1 ? `\nCredit: ${titleLines.slice(1).join(' ')}` : ''}\n\n`
      : '';
  return `${head}${out.join('\n')}\n`;
}
