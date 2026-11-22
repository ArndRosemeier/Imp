import { describe, expect, it } from 'vitest';
import { IMP_ALIASES, IMP_NAME, aliasOfTheVisit, nextAlias } from '../src/app/imp-names.js';

describe('what Imp stands for', () => {
  it('keeps the official name among the meanings and spells each one I-M-P', () => {
    expect(IMP_ALIASES).toContain(IMP_NAME);
    expect(IMP_ALIASES).toContain(aliasOfTheVisit);
    for (const alias of IMP_ALIASES) {
      const initials = alias
        .split(/[\s,]+/)
        .filter((word) => word !== '')
        .map((word) => word[0]?.toUpperCase())
        .join('');
      expect(initials).toBe('IMP');
    }
  });

  it('goes round every meaning and back to the first', () => {
    let alias = IMP_ALIASES[0] ?? IMP_NAME;
    const seen = new Set<string>();
    while (!seen.has(alias)) {
      seen.add(alias);
      alias = nextAlias(alias);
    }
    expect(seen.size).toBe(IMP_ALIASES.length);
    expect(alias).toBe(IMP_ALIASES[0]);
  });
});
