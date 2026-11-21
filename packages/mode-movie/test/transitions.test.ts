import { describe, expect, it } from 'vitest';
import { dipOf, overlaps, overlapSeconds, shadeAt, transitionShare } from '../src/transitions.js';

describe('transitions between pieces', () => {
  it('overlap pieces only for a dissolve or wipe, by at most half of either', () => {
    expect(overlaps('dissolve')).toBe(true);
    expect(overlaps('dip-black')).toBe(false);
    expect(overlapSeconds('cut', 1, 4, 4)).toBe(0);
    expect(overlapSeconds('dissolve', 1, 4, 4)).toBe(1);
    expect(overlapSeconds('wipe', 3, 4, 2)).toBe(1);
    expect(overlapSeconds('dissolve', 1, 0, 4)).toBe(0);
  });

  it('dip for half the transition on each side', () => {
    expect(dipOf('cut', 1, 4)).toBeNull();
    expect(dipOf('dip-white', 2, 4)).toEqual({ color: 'white', seconds: 1 });
    expect(dipOf('dip-black', 4, 1)).toEqual({ color: 'black', seconds: 0.5 });
    expect(dipOf('dip-black', 1, 0)).toBeNull();
  });

  it('lay black and white over the edges of a piece', () => {
    const none = { fadeInSeconds: 0, fadeOutSeconds: 0, dipIn: null, dipOut: null };
    expect(shadeAt(none, 1, 4)).toEqual({ black: 0, white: 0 });
    const faded = { ...none, fadeInSeconds: 2 };
    expect(shadeAt(faded, 1, 4).black).toBe(0.5);
    const dipped = {
      ...none,
      dipIn: { color: 'white', seconds: 1 } as const,
      dipOut: { color: 'black', seconds: 1 } as const,
    };
    expect(shadeAt(dipped, 0, 4)).toEqual({ black: 0, white: 1 });
    expect(shadeAt(dipped, 0.5, 4)).toEqual({ black: 0, white: 0.5 });
    expect(shadeAt(dipped, 3.75, 4)).toEqual({ black: 0.75, white: 0 });
    expect(shadeAt({ ...none, dipIn: { color: 'black', seconds: 0 } }, 0, 4).black).toBe(0);
  });

  it('say how far a dissolve has come', () => {
    expect(transitionShare(0, 0)).toBe(1);
    expect(transitionShare(2, 0.5)).toBe(0.25);
    expect(transitionShare(2, 5)).toBe(1);
  });
});
