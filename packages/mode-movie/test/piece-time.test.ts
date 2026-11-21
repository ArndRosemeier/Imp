import { describe, expect, it } from 'vitest';
import {
  movingSeconds,
  pieceSeconds,
  placePicture,
  playsOwnSound,
  sourceTime,
  splitTrims,
  usedSeconds,
  zoomAt,
  type PieceTiming,
} from '../src/piece-time.js';

const piece = (change: Partial<PieceTiming> = {}): PieceTiming => ({
  sourceSeconds: 6,
  trimStartSeconds: 1,
  trimEndSeconds: 1,
  speed: 1,
  reverse: false,
  holdSeconds: 0,
  ...change,
});

describe('the time of a piece', () => {
  it('plays its trimmed stretch as filmed', () => {
    const plain = piece();
    expect(usedSeconds(plain)).toBe(4);
    expect(pieceSeconds(plain)).toBe(4);
    expect(sourceTime(plain, 0)).toBe(1);
    expect(sourceTime(plain, 2.5)).toBe(3.5);
    expect(playsOwnSound(plain)).toBe(true);
  });

  it('slows down, speeds up and holds its last frame', () => {
    const slow = piece({ speed: 0.5, holdSeconds: 2 });
    expect(movingSeconds(slow)).toBe(8);
    expect(pieceSeconds(slow)).toBe(10);
    expect(sourceTime(slow, 4)).toBe(3);
    // Held, the last frame stays, just inside the clip.
    expect(sourceTime(slow, 9)).toBeCloseTo(5 - 1 / 60);
    expect(playsOwnSound(slow)).toBe(false);
    expect(pieceSeconds(piece({ speed: 2 }))).toBe(2);
    expect(pieceSeconds(piece({ trimStartSeconds: 6, holdSeconds: 3 }))).toBe(0);
    expect(movingSeconds(piece({ speed: 0 }))).toBe(4);
  });

  it('plays backwards from the end of its stretch', () => {
    const back = piece({ reverse: true });
    expect(sourceTime(back, 0)).toBeCloseTo(5 - 1 / 60);
    expect(sourceTime(back, 1)).toBe(4);
    expect(sourceTime(back, 4)).toBe(1);
    expect(sourceTime(back, -1)).toBeCloseTo(5 - 1 / 60);
    expect(playsOwnSound(back)).toBe(false);
  });

  it('splits so that the halves play on as the whole did', () => {
    expect(splitTrims(piece({ speed: 2 }), 1)).toEqual({
      first: { trimStartSeconds: 1, trimEndSeconds: 3 },
      second: { trimStartSeconds: 3, trimEndSeconds: 1 },
    });
    // Backwards, the first half is the end of the stretch.
    expect(splitTrims(piece({ reverse: true }), 1)).toEqual({
      first: { trimStartSeconds: 4, trimEndSeconds: 1 },
      second: { trimStartSeconds: 1, trimEndSeconds: 2 },
    });
  });
});

describe('a punch-in', () => {
  it('eases from one zoom to another over the piece', () => {
    const push = { zoom: 1, zoomTo: 2, focusX: 0.5, focusY: 0.5 };
    expect(zoomAt(push, 0)).toBe(1);
    expect(zoomAt(push, 0.5)).toBe(1.5);
    expect(zoomAt(push, 2)).toBe(2);
    expect(zoomAt({ ...push, zoomTo: null, zoom: 1.4 }, 0.7)).toBe(1.4);
  });

  it('keeps its focus in view without showing the edges of the picture', () => {
    expect(placePicture(1920, 1080, 1920, 1080, 1, 0.5, 0.5)).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
    expect(placePicture(1920, 1080, 960, 540, 2, 0.5, 0.5)).toEqual({
      x: -960,
      y: -540,
      width: 3840,
      height: 2160,
    });
    // A focus near a corner goes as far as the picture allows, and no further.
    expect(placePicture(100, 100, 100, 100, 2, 0, 1)).toEqual({
      x: 0,
      y: -100,
      width: 200,
      height: 200,
    });
    // A tall picture in a wide frame stays centred across, with black beside it.
    expect(placePicture(200, 100, 50, 100, 1, 0, 0)).toMatchObject({ x: 75, y: 0 });
  });
});
