import { describe, expect, it } from 'vitest';
import { shortSceneTitle } from '../src/scene-title.js';

describe('shortSceneTitle', () => {
  it.each([
    ['INT. SKERRIG LIGHTHOUSE, KITCHEN - DAY', 'Kitchen, day'],
    ['EXT. SKERRIG LIGHTHOUSE, GALLERY – NIGHT', 'Gallery, night'],
    ['INT./EXT. MARA’S CAR - MOVING - LATER', 'Mara’s Car, moving - later'],
    ['I/E. LAMP ROOM', 'Lamp Room'],
    ['EXT. Lighthouse gallery - dusk', 'Lighthouse gallery, dusk'],
    ['int. o’brien’s pub - night', 'o’brien’s pub, night'],
    ['EXT. - NIGHT', 'Night'],
    ['INT.', 'INT.'],
    ['INT. , - DAWN', 'Dawn'],
    ['Opening montage', 'Opening montage'],
    ['  ', 'Untitled'],
  ])('names %j as %j', (heading, title) => {
    expect(shortSceneTitle(heading)).toBe(title);
  });
});
