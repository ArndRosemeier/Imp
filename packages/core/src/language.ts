import { z } from 'zod';
import type { KeyValueStore } from './storage/kv.js';

/**
 * The languages Imp's interface speaks. English is the source every other
 * language is translated from, and the default. Adding a language means one
 * entry here, plus its catalogs (see apps/web/src/i18n/README.md); tests fail
 * until every string, guide page and What's new entry has its translation.
 */
export const LANGUAGES = [
  { id: 'en', name: 'English', english: 'English' },
  { id: 'de', name: 'Deutsch', english: 'German' },
] as const;

export const Language = z.enum(['en', 'de']);
export type Language = z.infer<typeof Language>;

export const DEFAULT_LANGUAGE: Language = 'en';

/** The setting that holds the interface language, so Save all keeps it and agents can change it. */
export const LANGUAGE_SETTING = 'ui.language';

/** The interface language a store holds, English when none (or an unknown one) is set. */
export async function readLanguage(store: Pick<KeyValueStore, 'get'>): Promise<Language> {
  const parsed = Language.safeParse(await store.get(`settings/${LANGUAGE_SETTING}`));
  return parsed.success ? parsed.data : DEFAULT_LANGUAGE;
}

/** The language's own name and its name in English, for instructions to agents. */
export function languageInfo(id: Language): (typeof LANGUAGES)[number] {
  return LANGUAGES.find((language) => language.id === id) ?? LANGUAGES[0];
}
