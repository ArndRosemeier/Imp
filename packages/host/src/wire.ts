import { decodeBase64, encodeBase64 } from '@imp/providers';

/**
 * Messages as text, for a channel that carries only text, such as HTTP to the
 * local server. Bytes travel as base64 under a marker; the rest is JSON.
 */
export function encodeWire(message: unknown): string {
  return JSON.stringify(message, (_key, value: unknown) =>
    value instanceof Uint8Array ? { $bytes: encodeBase64(value) } : value,
  );
}

export function decodeWire(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown) => {
    if (typeof value !== 'object' || value === null) return value;
    const marked = (value as { $bytes?: unknown }).$bytes;
    return typeof marked === 'string' && Object.keys(value).length === 1
      ? (decodeBase64(marked) ?? new Uint8Array())
      : value;
  });
}
