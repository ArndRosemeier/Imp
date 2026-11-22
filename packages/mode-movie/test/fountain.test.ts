import { decodeUtf8 } from '@imp/core';
import { describe, expect, it } from 'vitest';
import {
  fdxToFountain,
  fountainScenes,
  fountainTitlePage,
  headingLine,
  looseWords,
  numberScenes,
  parseFountain,
  screenplayPages,
  screenplayPdf,
  scriptLength,
  scriptLines,
  toFdx,
  toFountain,
  wrapColumns,
} from '../src/index.js';

const SCENE = `The lamp turns. Rain hammers the glass.

MARA
(shouting)
Hold the light!
They're *close* now.

JON (O.S.)
I can't see them!

MARA ^
(quietly)
Then **listen**.

CUT TO:

> THE END <

[[check the lamp prop]]
/* an old line
nobody wants */
BANG.`;

const types = (source: string) => parseFountain(source).map((element) => element.type);

describe('reading Fountain', () => {
  it('reads action, characters, parentheticals, dialogue, transitions and centred text', () => {
    expect(types(SCENE)).toEqual([
      'action',
      'character',
      'parenthetical',
      'dialogue',
      'character',
      'dialogue',
      'character',
      'parenthetical',
      'dialogue',
      'transition',
      'centered',
      'note',
      'action',
    ]);
    const elements = parseFountain(SCENE);
    expect(elements[3]).toMatchObject({
      text: "Hold the light!\nThey're *close* now.",
      speaker: 'MARA',
    });
    expect(elements[4]).toMatchObject({ speaker: 'JON', extension: 'O.S.' });
    expect(elements[6]).toMatchObject({ speaker: 'MARA', dual: true });
    expect(elements[11]).toMatchObject({ type: 'note', text: 'check the lamp prop' });
    expect(elements.at(-1)?.text).toBe('BANG.');
  });

  it('reads headings, forced elements, sections, synopses, lyrics and page breaks', () => {
    const elements = parseFountain(
      'int. lamp room - night #4#\n\n.THE SEA\n\n# Act one\n\n= Mara holds the light.\n\n~Row, row\n\n===\n\n!SHOUTING IN THE DARK\n\n@McCLANE\nYippee.\n\n> FADE OUT.',
    );
    expect(elements.map((element) => element.type)).toEqual([
      'heading',
      'heading',
      'section',
      'synopsis',
      'lyric',
      'page-break',
      'action',
      'character',
      'dialogue',
      'transition',
    ]);
    expect(elements[0]).toMatchObject({ text: 'INT. LAMP ROOM - NIGHT', sceneNumber: '4' });
    expect(elements[1]?.text).toBe('THE SEA');
    expect(elements[2]).toMatchObject({ text: 'Act one', depth: 1 });
    expect(elements[6]?.text).toBe('SHOUTING IN THE DARK');
    expect(elements[7]?.speaker).toBe('McCLANE');
    expect(elements[9]?.text).toBe('FADE OUT.');
  });

  it('lists the spoken lines with who says them and how', () => {
    expect(scriptLines(SCENE)).toEqual([
      {
        index: 0,
        speaker: 'MARA',
        extension: null,
        direction: 'shouting',
        words: "Hold the light! They're close now.",
      },
      { index: 1, speaker: 'JON', extension: 'O.S.', direction: '', words: "I can't see them!" },
      { index: 2, speaker: 'MARA', extension: null, direction: 'quietly', words: 'Then listen.' },
    ]);
    expect(looseWords("Hold the LIGHT!  They're")).toBe('hold the light they re');
  });

  it('reads a title page and leaves it out of the script', () => {
    const script =
      'Title: The Keeper\nCredit: Written by\nAuthor: Arnd\n\nINT. LAMP ROOM - NIGHT\n\nRain.';
    expect(fountainTitlePage(script)).toEqual({
      title: 'The Keeper',
      credit: 'Written by',
      author: 'Arnd',
    });
    expect(types(script)).toEqual(['heading', 'action']);
  });
});

describe('scenes and files', () => {
  it('writes headings as Fountain, forcing those that do not start INT or EXT', () => {
    expect(headingLine('int. kitchen - day')).toBe('INT. KITCHEN - DAY');
    expect(headingLine('The lighthouse')).toBe('.The lighthouse');
    expect(headingLine('  ')).toBe('');
  });

  it('writes a script and reads it back into the same scenes', () => {
    const scenes = [
      { heading: 'INT. LAMP ROOM - NIGHT', summary: 'Mara holds the light.', body: SCENE },
      { heading: 'Montage', summary: '', body: 'Waves.' },
    ];
    const fountain = toFountain({ title: 'The Keeper', notes: 'Line one\nLine two' }, scenes);
    expect(
      fountain.startsWith(
        'Title: The Keeper\nNotes:\n    Line one\n    Line two\n\nINT. LAMP ROOM',
      ),
    ).toBe(true);
    const back = fountainScenes(fountain);
    expect(back).toEqual(scenes.map((scene) => ({ ...scene, body: scene.body.trim() })));
  });

  it('keeps writing before the first heading as a scene of its own', () => {
    expect(fountainScenes('FADE IN:\n\nEXT. SEA - DAY\n\nWaves.')).toEqual([
      { heading: '', summary: '', body: 'FADE IN:' },
      { heading: 'EXT. SEA - DAY', summary: '', body: 'Waves.' },
    ]);
  });

  it('writes Final Draft and reads it back', () => {
    const elements = parseFountain(`INT. LAMP ROOM - NIGHT\n\n${SCENE}`);
    const fdx = toFdx({ title: 'The Keeper', author: 'Arnd' }, elements);
    expect(fdx).toContain(
      '<Paragraph Type="Scene Heading"><Text>INT. LAMP ROOM - NIGHT</Text></Paragraph>',
    );
    expect(fdx).toContain('<Text Style="Italic">close</Text>');
    expect(fdx).toContain('<Text Style="Bold">listen</Text>');
    const fountain = fdxToFountain(fdx);
    expect(fountainTitlePage(fountain)['title']).toBe('The Keeper');
    const back = parseFountain(fountain).filter((element) => element.type !== 'centered');
    const kept = elements.filter(
      (element) => element.type !== 'note' && element.type !== 'centered',
    );
    expect(back.map((element) => [element.type, element.text])).toEqual(
      kept.map((element) => [
        element.type,
        element.type === 'character' ? element.text : element.text,
      ]),
    );
  });

  it('reads Final Draft entities, styles and unknown paragraph types', () => {
    const fountain = fdxToFountain(
      '<FinalDraft><Content><Paragraph Type="Shot"><Text>CLOSE ON MARA</Text></Paragraph><Paragraph Type="Action"><Text>Tom &amp; </Text><Text Style="Underline">Jerry</Text></Paragraph></Content></FinalDraft>',
    );
    expect(fountain).toBe('CLOSE ON MARA\n\nTom & _Jerry_\n');
  });
});

describe('pages', () => {
  it('wraps to columns and keeps emphasis on each line', () => {
    expect(wrapColumns('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    expect(wrapColumns('**bold words here**', 10)).toEqual(['**bold words**', '**here**']);
    expect(wrapColumns('a *b* c', 10)).toEqual(['a *b* c']);
    expect(wrapColumns('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('counts pages and minutes at a page a minute', () => {
    const long = Array.from({ length: 110 }, () => 'Waves.').join('\n\n');
    const length = scriptLength(parseFountain(long));
    expect(length.pages).toBeGreaterThan(3.5);
    expect(length.minutes).toBeCloseTo(length.pages, 1);
    expect(scriptLength([]).pages).toBe(0);
  });

  it('breaks speech over a page with MORE and CONT’D, and numbers pages', () => {
    const filler = Array.from({ length: 25 }, () => 'Waves.').join('\n\n');
    const speech = Array.from({ length: 10 }, () => 'I keep the light burning every night.').join(
      ' ',
    );
    const pages = screenplayPages(parseFountain(`${filler}\n\nMARA\n${speech}`));
    expect(pages.length).toBe(2);
    const first = pages[0] ?? [];
    expect(first.at(-1)?.text).toBe('(MORE)');
    expect(pages[1]?.[0]?.text).toBe("MARA (CONT'D)");
    const pdf = decodeUtf8(screenplayPdf({ title: 'The Keeper' }, parseFountain(SCENE)));
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('/BaseFont /Courier-Bold');
    expect(pdf).toContain('/Count 2');
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('sets dual dialogue side by side, the first speaker on the left', () => {
    const elements = parseFountain(
      'Waves.\n\nMARA\n(shouting)\nGet down!\n\nTOM ^\nThe lamp! The lamp is out and the boats are coming in, all of them, right now.\n\nThey duck.',
    );
    const page = screenplayPages(elements)[0] ?? [];
    const rows = page.filter((line) => line !== null);
    const names = rows.find((line) => line.text === 'MARA');
    expect(names).toMatchObject({ x: 2.4, beside: { text: 'TOM', x: 5.4 } });
    expect(rows.find((line) => line.text === '(shouting)')?.beside?.x).toBe(4.5);
    // The right column is longer, so it goes on alone under the left one.
    const tomOnly = rows.filter((line) => line.x === 4.5 && line.beside === undefined);
    expect(tomOnly.length).toBeGreaterThan(0);
    expect(rows.at(-1)?.text).toBe('They duck.');
    const pdf = decodeUtf8(screenplayPdf({}, elements));
    expect(pdf).toContain(`${String(5.4 * 72)} `);
  });

  it('numbers scenes in both margins, keeping a number the writer gave', () => {
    const elements = numberScenes([
      { type: 'heading', text: 'INT. LAMP ROOM - NIGHT' },
      { type: 'action', text: 'Rain.' },
      { type: 'heading', text: 'EXT. CLIFF - DAWN', sceneNumber: '7' },
      { type: 'heading', text: 'EXT. SEA - DAY' },
    ]);
    expect(elements.flatMap((element) => element.sceneNumber ?? [])).toEqual(['1', '7', '8']);
    const page = screenplayPages(elements)[0] ?? [];
    expect(page[0]).toMatchObject({ text: 'INT. LAMP ROOM - NIGHT', sceneNumber: '1' });
    const pdf = decodeUtf8(screenplayPdf({}, elements));
    // "1" (hex 31) in the left margin and in the right one.
    expect(pdf.match(/Td <31> Tj/g)?.length).toBe(2);
  });
});
