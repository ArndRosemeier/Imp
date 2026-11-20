const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUES = new Map(Array.from(ALPHABET, (character, index) => [character, index]));

/**
 * Decodes standard base64 into bytes. Written out because the package
 * compiles without host libraries, and binary must never pass through a
 * text decoder on the way. Returns `undefined` for anything that is not base64.
 */
export function decodeBase64(text: string): Uint8Array | undefined {
  const clean = text.replace(/[\r\n]/g, '').replace(/=+$/, '');
  if (clean.length % 4 === 1) return undefined;
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let at = 0;
  for (const character of clean) {
    const value = VALUES.get(character);
    if (value === undefined) return undefined;
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[at++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes;
}
