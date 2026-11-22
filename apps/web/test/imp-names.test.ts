import { LANGUAGES } from '@imp/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IMP_NAMES,
  aliasOfTheVisit,
  impAliases,
  impName,
  nextAlias,
} from '../src/app/imp-names.js';
import { switchLanguage } from '../src/i18n/i18n.js';

describe('what Imp stands for', () => {
  afterEach(() => {
    switchLanguage('en');
  });

  it('keeps the official name among the meanings and spells each one I-M-P, in every language', () => {
    for (const { id } of LANGUAGES) {
      const { official, aliases } = IMP_NAMES[id];
      expect(aliases[0]).toBe(official);
      for (const alias of aliases) {
        const initials = alias
          .split(/[\s,]+/)
          .filter((word) => word !== '')
          .map((word) => word[0]?.toUpperCase())
          .join('');
        expect(initials, `${id}: ${alias}`).toBe('IMP');
      }
    }
  });

  it('speaks the interface language', () => {
    expect(impName()).toBe('Imp Makes Pictures');
    expect(impAliases()).toContain(aliasOfTheVisit());
    switchLanguage('de');
    expect(impName()).toBe('Imp Malt Pixel');
    expect(impAliases()).toContain(aliasOfTheVisit());
  });

  it('goes round every meaning and back to the first', () => {
    for (const { id } of LANGUAGES) {
      switchLanguage(id);
      const aliases = impAliases();
      let alias = aliases[0] ?? impName();
      const seen = new Set<string>();
      while (!seen.has(alias)) {
        seen.add(alias);
        alias = nextAlias(alias);
      }
      expect(seen.size).toBe(aliases.length);
      expect(alias).toBe(aliases[0]);
    }
  });
});
