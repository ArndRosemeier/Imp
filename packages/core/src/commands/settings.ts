import { z } from 'zod';
import { defineCommand } from '../command.js';
import { CommandError } from '../errors.js';
import type { JsonValue } from '../json.js';
import { Language, LANGUAGE_SETTING, LANGUAGES, readLanguage } from '../language.js';

const SETTINGS_PREFIX = 'settings/';

const SettingKey = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/)
  .describe('Dotted setting name, for example "coordinator.model".');

const SettingValue: z.ZodType<JsonValue> = z.json();

/**
 * Settings only the person may change: what agents may spend without asking.
 * An agent that could raise it would need no approval at all.
 */
const PERSON_ONLY = /^spend\.allowance(\.|$)/;

const Setting = z.object({ key: SettingKey, value: SettingValue });

/**
 * Settings are ordinary commands, which is what lets the coordinator carry out
 * setup by itself once a key and a model are in place.
 */
export const settingsGet = defineCommand({
  id: 'settings.get',
  title: 'Read setting',
  description: 'Returns the value of one setting, or null when it has never been set.',
  effect: 'read',
  input: z.object({ key: SettingKey }),
  output: z.object({ key: SettingKey, value: SettingValue }),
  handler: async ({ runtime }, { key }) => ({
    key,
    value: (await runtime.store.get(`${SETTINGS_PREFIX}${key}`)) ?? null,
  }),
});

export const settingsSet = defineCommand({
  id: 'settings.set',
  title: 'Change setting',
  description: 'Stores a value for one setting, replacing any earlier value.',
  effect: 'write',
  input: Setting,
  output: Setting,
  handler: async ({ actor, runtime }, { key, value }) => {
    if (actor.kind !== 'user' && PERSON_ONLY.test(key)) {
      throw new CommandError(
        'denied',
        'settings.set',
        `Only the person can change "${key}": it is what agents may spend without asking.`,
      );
    }
    await runtime.store.batch([{ type: 'put', key: `${SETTINGS_PREFIX}${key}`, value }]);
    return { key, value };
  },
});

export const settingsList = defineCommand({
  id: 'settings.list',
  title: 'List settings',
  description: 'Returns every setting that has a value, sorted by name.',
  effect: 'read',
  input: z.object({}),
  output: z.object({ settings: z.array(Setting) }),
  handler: async ({ runtime }) => ({
    settings: (await runtime.store.list(SETTINGS_PREFIX)).map((entry) => ({
      key: entry.key.slice(SETTINGS_PREFIX.length),
      value: entry.value,
    })),
  }),
});

const LanguageState = z.object({
  language: Language.describe('The language Imp’s interface is shown in.'),
  available: z
    .array(z.object({ id: Language, name: z.string() }))
    .describe('Every language Imp speaks, by id and by its own name.'),
});

const languageState = (language: Language): z.infer<typeof LanguageState> => ({
  language,
  available: LANGUAGES.map(({ id, name }) => ({ id, name })),
});

export const languageGet = defineCommand({
  id: 'settings.language.get',
  title: 'Show interface language',
  description:
    'Returns the language Imp’s buttons, menus, tips and guide are shown in (English by default) and the languages it speaks. Agents answer the person in this language.',
  keywords: ['language', 'Sprache', 'German', 'Deutsch', 'English', 'Settings'],
  effect: 'read',
  input: z.object({}),
  output: LanguageState,
  handler: async ({ runtime }) => languageState(await readLanguage(runtime.store)),
});

export const languageSet = defineCommand({
  id: 'settings.language.set',
  title: 'Change interface language',
  description:
    'Switches Imp’s whole interface (stages, library, tips, guide, What’s new) to another language, for example "de" for German or "en" for English. The person sees it change at once; agents answer in it from their next message. Save all keeps the choice.',
  keywords: ['language', 'Sprache', 'German', 'Deutsch', 'English', 'translate', 'Settings'],
  effect: 'write',
  input: z.object({ language: Language }),
  output: LanguageState,
  handler: async ({ runtime }, { language }) => {
    await runtime.store.batch([
      { type: 'put', key: `${SETTINGS_PREFIX}${LANGUAGE_SETTING}`, value: language },
    ]);
    return languageState(language);
  },
});

export const languageCommands = [languageGet, languageSet] as const;

export const settingsCommands = [settingsGet, settingsSet, settingsList] as const;
