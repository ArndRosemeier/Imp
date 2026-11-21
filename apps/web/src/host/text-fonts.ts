import type { TextFont } from '@imp/mode-movie';
import interItalic from '@fontsource-variable/inter/files/inter-latin-wght-italic.woff2?url';
import interItalicExt from '@fontsource-variable/inter/files/inter-latin-ext-wght-italic.woff2?url';
import inter from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';
import interExt from '@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2?url';
import mono from '@fontsource/courier-prime/files/courier-prime-latin-400-normal.woff2?url';
import monoItalic from '@fontsource/courier-prime/files/courier-prime-latin-400-italic.woff2?url';
import monoBold from '@fontsource/courier-prime/files/courier-prime-latin-700-normal.woff2?url';
import monoBoldItalic from '@fontsource/courier-prime/files/courier-prime-latin-700-italic.woff2?url';
import monoExt from '@fontsource/courier-prime/files/courier-prime-latin-ext-400-normal.woff2?url';
import serif from '@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2?url';
import serifItalic from '@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2?url';
import serifExt from '@fontsource/instrument-serif/files/instrument-serif-latin-ext-400-normal.woff2?url';

/**
 * The fonts texts are drawn in, under names of their own, loaded the same way
 * on the page (for the preview) and in the worker (for the film), so that the
 * two draw the same letters. They ship with Imp: nothing is fetched from elsewhere.
 */
export const TEXT_FAMILIES: Record<TextFont, string> = {
  sans: '"Imp Sans", "Inter Variable", system-ui, sans-serif',
  serif: '"Imp Serif", "Instrument Serif", Georgia, serif',
  mono: '"Imp Mono", "Courier Prime", "Courier New", monospace',
};

const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

interface Face {
  readonly family: string;
  readonly url: string;
  readonly weight: string;
  readonly style: 'normal' | 'italic';
  readonly range: string;
}

export const TEXT_FACES: readonly Face[] = [
  { family: 'Imp Sans', url: inter, weight: '100 900', style: 'normal', range: LATIN },
  { family: 'Imp Sans', url: interExt, weight: '100 900', style: 'normal', range: LATIN_EXT },
  { family: 'Imp Sans', url: interItalic, weight: '100 900', style: 'italic', range: LATIN },
  { family: 'Imp Sans', url: interItalicExt, weight: '100 900', style: 'italic', range: LATIN_EXT },
  { family: 'Imp Serif', url: serif, weight: '400', style: 'normal', range: LATIN },
  { family: 'Imp Serif', url: serifExt, weight: '400', style: 'normal', range: LATIN_EXT },
  { family: 'Imp Serif', url: serifItalic, weight: '400', style: 'italic', range: LATIN },
  { family: 'Imp Mono', url: mono, weight: '400', style: 'normal', range: LATIN },
  { family: 'Imp Mono', url: monoExt, weight: '400', style: 'normal', range: LATIN_EXT },
  { family: 'Imp Mono', url: monoItalic, weight: '400', style: 'italic', range: LATIN },
  { family: 'Imp Mono', url: monoBold, weight: '700', style: 'normal', range: LATIN },
  { family: 'Imp Mono', url: monoBoldItalic, weight: '700', style: 'italic', range: LATIN },
];

/** What loading needs from the page or the worker. */
export interface FontScope {
  readonly FontFace?: new (
    family: string,
    source: string,
    descriptors: { weight: string; style: string; unicodeRange: string },
  ) => { load(): Promise<unknown> };
  readonly fonts?: { add(face: unknown): unknown };
}

const loaded = new WeakMap<object, Promise<boolean>>();

/**
 * Loads the text fonts into a page or a worker, once; true when they are
 * there. Where fonts cannot be loaded, texts are drawn in the fallbacks.
 */
export function loadTextFonts(scope: FontScope = globalThis): Promise<boolean> {
  const known = loaded.get(scope);
  if (known !== undefined) return known;
  const { FontFace: Face, fonts } = scope;
  const loading =
    Face === undefined || fonts === undefined
      ? Promise.resolve(false)
      : Promise.all(
          TEXT_FACES.map(async (face) => {
            const font = new Face(face.family, `url(${face.url})`, {
              weight: face.weight,
              style: face.style,
              unicodeRange: face.range,
            });
            fonts.add(await font.load());
          }),
        ).then(
          () => true,
          () => false,
        );
  loaded.set(scope, loading);
  return loading;
}
