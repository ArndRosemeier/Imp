import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { patchOf } from '../src/index.js';

describe('patchOf', () => {
  it('makes every field optional and drops defaults', () => {
    const Thing = z.object({ name: z.string(), pan: z.number().default(0) });
    const Patch = patchOf(Thing);
    expect(Patch.parse({})).toEqual({});
    expect(Patch.parse({ pan: 1 })).toEqual({ pan: 1 });
    expect(Thing.partial().parse({})).toEqual({ pan: 0 });
  });
});
