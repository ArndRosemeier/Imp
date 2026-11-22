import { DEFAULT_LANGUAGE, Language } from '@imp/core';
import { de } from './de.js';

/**
 * Imp's interface in more than one language.
 *
 * English text is the key: `t('Save all')` shows "Save all" in English and the
 * catalog's "Alles sichern" in German. Placeholders in braces are filled from
 * `values`: `t('Ask {name}', { name })`. A test reads every `t` and `tn` call
 * in the app and fails when a language lacks one of them, or when a string
 * someone will read is not passed through `t` at all.
 *
 * Call `t` while rendering or handling an event, never at the top of a module:
 * the language can change while Imp runs, and the interface is then drawn again.
 */
export type Catalog = Readonly<Record<string, string>>;

/** The translations of every language but English, which is the source. */
export const CATALOGS: Readonly<Record<Exclude<Language, 'en'>, Catalog>> = { de };

/** Where the page remembers the language, so it starts in it before the core has loaded. */
export const LANGUAGE_STORAGE_KEY = 'imp.language';

function stored(): Language {
  try {
    const parsed = Language.safeParse(
      typeof localStorage === 'undefined' ? null : localStorage.getItem(LANGUAGE_STORAGE_KEY),
    );
    return parsed.success ? parsed.data : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

let current: Language = stored();
markDocument(current);

function markDocument(language: Language): void {
  if (typeof document !== 'undefined') document.documentElement.lang = language;
}

/** The language the interface is drawn in now. */
export function currentLanguage(): Language {
  return current;
}

/** Draws from now on in `language`; returns whether it changed. */
export function switchLanguage(language: Language): boolean {
  if (language === current) return false;
  current = language;
  markDocument(language);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // A browser that keeps nothing still shows the language; it only starts in English next time.
  }
  return true;
}

type Values = Readonly<Record<string, string | number>>;

function fill(text: string, values: Values | undefined): string {
  if (values === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : String(value);
  });
}

/** `english` in the current language, with `{placeholders}` filled from `values`. */
export function t(english: string, values?: Values): string {
  const translated = current === 'en' ? undefined : CATALOGS[current][english];
  return fill(translated ?? english, values);
}

/**
 * A phrase that changes with a number: `tn(n, '{count} shot', '{count} shots')`.
 * `{count}` is the number; both forms are translated on their own.
 */
export function tn(count: number, one: string, other: string, values?: Values): string {
  return t(count === 1 ? one : other, { count, ...values });
}

/**
 * A word that comes from data rather than from the app's code, such as a
 * stage's or a role's name. Translated when the catalog knows it; a test
 * checks the catalog knows every name Imp ships with.
 */
export function tx(english: string, values?: Values): string {
  return t(english, values);
}

/** Numbers as the language writes them: 1,234.5 in English, 1.234,5 in German. */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(current, options).format(value);
}

/** A number with a fixed count of decimals, as the language writes it: 2.50, or 2,50 in German. */
export function fixed(value: number, digits: number): string {
  return formatNumber(value, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  });
}

/**
 * A keyboard shortcut as the language names its keys: "Control+Shift+Z" reads
 * "Strg+Umschalt+Z" in German. The shortcut itself, for aria-keyshortcuts, stays as it is.
 */
export function keyLabel(keys: string): string {
  const names: Readonly<Record<string, string>> = {
    Control: t('Ctrl'),
    Shift: t('Shift'),
    Alt: t('Alt'),
    Space: t('Space'),
    Delete: t('Delete'),
    Backspace: t('Backspace'),
    Home: t('Home'),
    End: t('End'),
    Escape: t('Esc'),
    Enter: t('Enter'),
  };
  return keys
    .split(' ')
    .map((chord) =>
      chord
        .split('+')
        .map((key) => names[key] ?? key)
        .join('+'),
    )
    .join(' ');
}
