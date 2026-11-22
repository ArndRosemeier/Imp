import type { Mode } from '@imp/agents';
import { LANGUAGES, type GuideTopic, type GuideTranslations, type Language } from '@imp/core';
import { workspaceGuidesDe } from './guide.de.js';

/*
 * Kept apart from guide.ts, which the web app's build config reads and which
 * therefore imports nothing but types.
 */

/** Imp's own pages in each language other than English. */
const workspaceTranslations: GuideTranslations = { de: workspaceGuidesDe };

/** Every translated page, Imp's own and the modes' stages', by language. */
export function guideTranslations(modes: readonly Mode[]): GuideTranslations {
  const result: Partial<Record<Language, GuideTopic[]>> = {};
  for (const { id } of LANGUAGES) {
    if (id === 'en') continue;
    result[id] = [
      ...(workspaceTranslations[id] ?? []),
      ...modes.flatMap((mode) => mode.guideTranslations?.[id] ?? []),
    ];
  }
  return result;
}
