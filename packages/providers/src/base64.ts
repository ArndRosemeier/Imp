const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Encodes bytes as standard base64, with padding. */
export function encodeBase64(bytes: Uint8Array): string {
  let text = '';
  for (let at = 0; at < bytes.length; at += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[at], bytes[at + 1], bytes[at + 2]];
    const triple = (a << 16) | (b << 8) | c;
    text +=
      (ALPHABET[(triple >> 18) & 63] ?? '') +
      (ALPHABET[(triple >> 12) & 63] ?? '') +
      (at + 1 < bytes.length ? (ALPHABET[(triple >> 6) & 63] ?? '') : '=') +
      (at + 2 < bytes.length ? (ALPHABET[triple & 63] ?? '') : '=');
  }
  return text;
}

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
