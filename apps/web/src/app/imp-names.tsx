import type { Language } from '@imp/core';
import { useState, type ReactElement } from 'react';
import { currentLanguage, t } from '../i18n/i18n.js';

/**
 * What the three letters stand for, in each language. The official name is
 * recursive, in the spirit of GNU; the others are the imp trying on hats, one
 * per visit, on the Projects screen and in the mark's tooltip. Every meaning
 * spells I-M-P in its own language, so German has its own list rather than
 * translations that would lose the letters.
 *
 * i18n-ignore-file: the names below are written per language already.
 */
export const IMP_NAMES: Readonly<
  Record<Language, { readonly official: string; readonly aliases: readonly string[] }>
> = {
  en: {
    official: 'Imp Makes Pictures',
    aliases: [
      'Imp Makes Pictures',
      'Imp Movie Production',
      'Intelligent Movie Production',
      'Infinite Montage Pipeline',
      'Images, Mischief, Pictures',
      'It’s Mostly Planning',
      'Impossible Motion Pictures',
      'Impossibly Many Pictures',
      'Independent Motion Pictures',
    ],
  },
  de: {
    official: 'Imp Malt Pixel',
    aliases: [
      'Imp Malt Pixel',
      'Imp Macht Pixelkino',
      'Imp Montiert Perfekt',
      'Ideen Machen Premieren',
      'Illusion, Magie, Projektion',
      'Ist Meistens Planung',
      'Impossible Motion Pictures',
      'Immer Mehr Pixel',
      'Irgendwie Magische Projektionen',
      'Ideen, Mut, Phantasie',
    ],
  },
};

/** The official name in the interface's language. */
export function impName(): string {
  return IMP_NAMES[currentLanguage()].official;
}

/** Every meaning in the interface's language, the official one first. */
export function impAliases(): readonly string[] {
  return IMP_NAMES[currentLanguage()].aliases;
}

/** The alias after `current`, round and round. */
export function nextAlias(current: string): string {
  const aliases = impAliases();
  const at = aliases.indexOf(current);
  return aliases[(at + 1) % aliases.length] ?? impName();
}

// Picked once when the app loads, so this visit's meaning holds still until the next visit.
const visitPick = Math.random();

/** This visit's alias, in the interface's language. */
export function aliasOfTheVisit(): string {
  const aliases = impAliases();
  return aliases[Math.floor(visitPick * aliases.length)] ?? impName();
}

/**
 * The eyebrow over the Projects heading: what Imp stands for this visit. A
 * press tries on the next meaning; the official one is always among them.
 */
export function ImpAlias(): ReactElement {
  const [alias, setAlias] = useState(aliasOfTheVisit);
  return (
    <button
      type="button"
      className="imp-alias"
      title={t('What else could Imp stand for?')}
      onClick={() => {
        setAlias(nextAlias);
      }}
    >
      <span className="imp-alias-word">Imp</span>
      <span aria-hidden="true">·</span>
      <span key={alias} className="imp-alias-name">
        {alias}
      </span>
    </button>
  );
}
