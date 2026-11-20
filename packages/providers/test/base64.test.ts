import { describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64 } from '../src/base64.js';

describe('encodeBase64', () => {
  it('pads to whole groups and reads back as the same bytes', () => {
    expect([0, 1, 2, 3].map((length) => encodeBase64(new Uint8Array(length).fill(255)))).toEqual([
      '',
      '/w==',
      '//8=',
      '////',
    ]);
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });
});
