import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LANGUAGES, MemoryKeyValueStore } from '@imp/core';
import { createImp } from '@imp/host';
import { createFakeProvider } from '@imp/providers/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalSecretStore } from '../src/host/secrets.js';
import { CATALOGS, switchLanguage, t, tn } from '../src/i18n/i18n.js';
import { placeholders, readsAsWords, scan } from './i18n-scan.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const app = fileURLToPath(new URL('../src/', import.meta.url));

// The host folder runs in the core's worker, which speaks English like every command does.
const found = scan(app, (path) => /\/(i18n|docs|host)\//.test(path));

/** Every English literal a regular expression finds in a package file. */
function literals(file: string, pattern: RegExp): string[] {
  const text = readFileSync(`${root}${file}`, 'utf8');
  return [...text.matchAll(pattern)].flatMap((match) => match.slice(1).filter(Boolean));
}

/**
 * Words the interface shows that come from the core rather than from the
 * app's code: stage and role names, command titles, kinds of things in the
 * library, templates, the first-film steps and the like. The app passes them
 * through `tx`, so each language needs them in its catalog.
 */
function wordsFromTheCore(): Set<string> {
  const imp = createImp({
    store: new MemoryKeyValueStore(),
    secrets: createLocalSecretStore({
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    } as unknown as Storage),
    provider: createFakeProvider({ replies: [], models: [] }),
  });
  const words = [
    ...imp.registry.list().map((command) => command.title),
    ...imp.roles.list().flatMap((role) => [role.name, role.summary]),
    ...imp.modes.flatMap((mode) => [
      mode.name,
      ...mode.stages.map((stage) => stage.name),
      ...(mode.project?.templates ?? []).flatMap((template) => [template.name, template.summary]),
      ...(mode.project?.path?.steps ?? []).flatMap((step) => [step.title, step.body]),
    ]),
    // Kinds of things in the library and in project copies: label, plural and singular.
    ...[
      'packages/core/src/library/model.ts',
      'packages/core/src/library/own.ts',
      'packages/mode-movie/src/library.ts',
      'packages/mode-movie/src/project.ts',
      'packages/world/src/library.ts',
      'packages/audio/src/library.ts',
    ].flatMap((file) => {
      try {
        return literals(file, /(?:label|plural|singular): '([^']+)'/g);
      } catch {
        return [];
      }
    }),
    // The overview's lines about each stage, and the phases of Save all and Load all.
    ...literals(
      'packages/mode-movie/src/project.ts',
      /phrase\('([^']+)'|counted\([^,]+,\s*'([^']+)',\s*'([^']+)'/g,
    ),
    ...literals('packages/core/src/commands/backup.ts', /progress\.report\('([^']+)'/g),
    // The steps of an audio document's history.
    ...['packages/audio/src/doc-commands.ts', 'packages/audio/src/fx-commands.ts'].flatMap((file) =>
      literals(
        file,
        /'audio\.[a-z.]+',\s*(?:input\.)?projectId,\s*(?:input\.)?docId,\s*'([A-Z][^']+)'|rangeEdit\('[^']+', '([^']+)'/g,
      ),
    ),
    // The kinds of model in a mix, and the built-in styles of film texts.
    ...literals('packages/agents/src/model-mixes.ts', /label: '([^']+)'/g),
    ...literals('packages/mode-movie/src/text-layout.ts', /name: '([^']+)'/g),
  ];
  return new Set(words.filter((word) => word.trim() !== ''));
}

const fromTheCore = wordsFromTheCore();
const used = new Set([...found.uses.map((use) => use.key), ...fromTheCore]);

describe('the interface in every language', () => {
  afterEach(() => {
    switchLanguage('en');
  });

  it('passes every text a person reads through a translation', () => {
    // A string here is shown to people in English whatever the language. Wrap it in
    // t('...'), or mark a line that is not for people with an `i18n-ignore` comment.
    expect(found.untranslated.map((at) => `${at.file}:${String(at.line)} ${at.text}`)).toEqual([]);
  });

  it('translates while drawing, never once at the top of a module', () => {
    expect(found.tooEarly.map((at) => `${at.file}:${String(at.line)} ${at.text}`)).toEqual([]);
  });

  for (const language of LANGUAGES) {
    if (language.id === 'en') continue;
    const catalog = CATALOGS[language.id];

    it(`has every text in ${language.english}`, () => {
      const missing = [...used].filter((key) => catalog[key] === undefined).sort();
      expect(missing).toEqual([]);
    });

    it(`fills the same placeholders in ${language.english} as in English`, () => {
      const wrong = Object.entries(catalog)
        .filter(([key, text]) => placeholders(key).join() !== placeholders(text).join())
        .map(([key, text]) => `${key} → ${text}`);
      expect(wrong).toEqual([]);
    });

    it(`keeps no ${language.english} text that nothing shows any more`, () => {
      expect(Object.keys(catalog).filter((key) => !used.has(key))).toEqual([]);
    });

    it(`leaves no ${language.english} text empty or still in English by mistake`, () => {
      const suspicious = Object.entries(catalog)
        .filter(([key, text]) => text.trim() === '' || (text === key && readsAsWords(key)))
        .map(([key]) => key)
        .filter((key) => !SAME_IN.has(key));
      expect(suspicious).toEqual([]);
    });
  }

  it('switches the words, numbers and plurals with the language', () => {
    expect(t('Save all and Load all')).toBe('Save all and Load all');
    expect(tn(1, '{count} scene', '{count} scenes')).toBe('1 scene');
    switchLanguage('de');
    expect(t('Save all and Load all')).not.toBe('Save all and Load all');
    expect(tn(3, '{count} scene', '{count} scenes')).toBe('3 Szenen');
    expect(t('Ask {name}', { name: 'Mara' })).toContain('Mara');
  });
});

/** Words German writes just like English: loanwords and names. */
const SAME_IN = new Set<string>([
  'Limiter',
  'Radio',
  'Monster',
  'Band',
  'Hz',
  'Attack',
  'Release',
  'Online −16',
  'Streaming −14',
  'Bits',
  'Region',
  'Linear',
  'Transport',
  'Pause',
  'Solo',
  'Name',
  'Audio',
  'Esc',
  'Touch',
  'Zoom',
  'Film',
  'Magenta',
  'Warm',
  'Noir',
  'Tags',
  'Text',
  'Crews',
  'Tag',
  'Problem',
  'Marker',
  'Logline',
  'Treatment',
  'Casting',
  'Final Draft',
  'Crew',
  'Video',
  'Take',
  'Fastnet Rock, 1891',
  'Serif (Instrument)',
  'In',
  'Out',
  'Clip',
  'Clips',
  'Trailer',
]);
