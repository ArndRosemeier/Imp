import { LANGUAGES, MemoryBlobStore, MemoryKeyValueStore, type GuideTopic } from '@imp/core';
import { createFakeProvider } from '@imp/providers/testing';
import { describe, expect, it } from 'vitest';
import { createImp, createMemorySecretStore } from '../src/index.js';
import { guideTranslations, workspaceGuides } from '../src/guide.js';

const imp = createImp({
  store: new MemoryKeyValueStore(),
  blobs: new MemoryBlobStore(),
  secrets: createMemorySecretStore(),
  provider: createFakeProvider({}),
});
const english: readonly GuideTopic[] = [
  ...workspaceGuides,
  ...imp.modes.flatMap((mode) => mode.stages.flatMap((stage) => stage.guide ?? [])),
];
const translations = guideTranslations(imp.modes);

/** The headings of a page, which a translation keeps in the same number and order. */
function headings(body: string): number {
  return body.split('\n').filter((line) => line.startsWith('## ')).length;
}

describe('the guide in every language', () => {
  for (const language of LANGUAGES) {
    if (language.id === 'en') continue;
    const pages = new Map((translations[language.id] ?? []).map((page) => [page.id, page]));

    it(`has every page and tip in ${language.english}`, () => {
      const missing = english.filter((page) => {
        const translated = pages.get(page.id);
        if (translated?.area !== page.area) return true;
        return (page.hint === undefined) !== (translated.hint === undefined);
      });
      expect(missing.map((page) => page.id)).toEqual([]);
    });

    it(`keeps each page's sections in ${language.english}`, () => {
      const differ = english
        .filter((page) => {
          const translated = pages.get(page.id);
          return translated !== undefined && headings(translated.body) !== headings(page.body);
        })
        .map((page) => page.id);
      expect(differ).toEqual([]);
    });
  }

  it('answers help.topic in the language asked for, and in the chosen one by default', async () => {
    const run = async (id: string, input: unknown): Promise<{ title?: string }> => {
      const result = await imp.registry.executeById(id, input, {
        actor: { kind: 'user', id: 'u' },
      });
      if (result.status !== 'ok') throw new Error(`${id}: ${result.status}`);
      return result.output as { title?: string };
    };
    expect((await run('help.topic', { id: 'stage-edit' })).title).toBe('Edit');
    expect((await run('help.topic', { id: 'stage-edit', language: 'de' })).title).toBe('Schnitt');
    await run('settings.language.set', { language: 'de' });
    expect((await run('help.topic', { id: 'stage-edit' })).title).toBe('Schnitt');
  });
});
