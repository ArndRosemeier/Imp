import { GuideTopic } from '@imp/core';
import { createFakeProvider } from '@imp/providers/testing';
import { describe, expect, it } from 'vitest';
import { createMovieMode } from '../src/index.js';

describe('the guide of the movie stages', () => {
  it('has a page with a first-time tip for every stage', () => {
    const mode = createMovieMode({ provider: createFakeProvider({}) });
    for (const stage of mode.stages) {
      const page = GuideTopic.parse(stage.guide);
      expect(page.area).toBe(stage.id);
      expect(page.hint?.body.length ?? 0).toBeGreaterThan(40);
      // Tips are read at a glance: a sentence or three, not a page.
      expect(page.hint?.body.length ?? 0).toBeLessThan(320);
    }
  });
});
