import { useState, type ReactElement } from 'react';

/**
 * What the three letters stand for. The official name is recursive, in the
 * spirit of GNU; the others are the imp trying on hats, one per visit, on the
 * Projects screen and in the mark's tooltip.
 */
export const IMP_NAME = 'Imp Makes Pictures';

export const IMP_ALIASES: readonly string[] = [
  IMP_NAME,
  'Imp Movie Production',
  'Intelligent Movie Production',
  'Infinite Montage Pipeline',
  'Images, Mischief, Pictures',
  'It’s Mostly Planning',
  'Impossibly Many Pictures',
  'Independent Motion Pictures',
];

/** The alias after `current`, round and round. */
export function nextAlias(current: string): string {
  const at = IMP_ALIASES.indexOf(current);
  return IMP_ALIASES[(at + 1) % IMP_ALIASES.length] ?? IMP_NAME;
}

/** This visit's alias: picked once when the app loads, so it holds still until the next visit. */
export const aliasOfTheVisit: string =
  IMP_ALIASES[Math.floor(Math.random() * IMP_ALIASES.length)] ?? IMP_NAME;

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
      title="What else could Imp stand for?"
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
