import { settingsGet } from '@imp/core';
import { describe, expect, it } from 'vitest';
import { defineMode, type Mode } from '../src/index.js';

const base: Mode = {
  id: 'movie',
  name: 'Movie',
  summary: 'Make films.',
  stages: [
    { id: 'script', name: 'Script' },
    { id: 'casting', name: 'Casting' },
  ],
  commands: [],
  roles: [],
};

describe('defineMode', () => {
  it('returns a consistent mode unchanged', () => {
    expect(defineMode(base)).toBe(base);
  });

  it('refuses a malformed id, foreign commands and duplicate stages', () => {
    expect(() => defineMode({ ...base, id: 'Movie Mode' })).toThrow(/Invalid mode id/);
    expect(() => defineMode({ ...base, commands: [settingsGet] })).toThrow(
      /must start with "movie\./,
    );
    expect(() =>
      defineMode({ ...base, stages: [...base.stages, { id: 'script', name: 'Again' }] }),
    ).toThrow(/twice/);
  });
});
