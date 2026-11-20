import type { Port } from './port.js';
import { decodeWire, encodeWire } from './wire.js';

/** The slice of the platform's `EventSource` the port needs. */
export interface EventStream {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export interface HttpPortOptions {
  /** Where the server answers, ending in a slash. */
  readonly base: string;
  readonly openStream: (url: string) => EventStream;
  readonly fetch: (
    url: string,
    request: { method: 'POST'; headers: Record<string, string>; body: string },
  ) => Promise<{ ok: boolean }>;
  /** Called when the server has forgotten this interface, for example after its restart. */
  readonly onForgotten: () => void;
  readonly newId: () => string;
}

/**
 * A port to the local server: messages go out as requests, one after
 * another so that they keep their order, and come back on one event stream.
 */
export function createHttpPort(options: HttpPortOptions): { port: Port; lost: Promise<never> } {
  const session = options.newId();
  const query = `session=${encodeURIComponent(session)}`;
  const stream = options.openStream(`${options.base}api/events?${query}`);
  const port: Port = {
    onmessage: null,
    postMessage(message) {
      const body = encodeWire(message);
      const call = (message as { call?: unknown }).call;
      sending = sending
        .then(() =>
          options.fetch(`${options.base}api/message?${query}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          }),
        )
        .then(
          (response) => response.ok,
          () => false,
        )
        .then((delivered) => {
          // Whoever waits for an answer to this must not wait for ever.
          if (!delivered && typeof call === 'number') {
            const error = { name: 'Error', message: 'The local server did not answer.' };
            port.onmessage?.({ data: { call, ok: false, error } });
          }
        });
    },
  };
  let sending: Promise<void> = Promise.resolve();

  let opened = false;
  const lost = new Promise<never>((_, reject) => {
    stream.onerror = () => {
      // Later breaks mend themselves: the stream connects again by itself.
      if (!opened) reject(new Error('the local server did not answer'));
    };
  });
  // Nobody may be listening for the loss; that must not count as an unhandled failure.
  lost.catch(() => undefined);
  stream.onopen = () => {
    opened = true;
  };
  let greeted = false;
  stream.onmessage = ({ data }) => {
    const message = decodeWire(data) as { hello?: { fresh: boolean } };
    if (message.hello === undefined) {
      port.onmessage?.({ data: message });
      return;
    }
    // A server that meets this interface anew after the first greeting has lost what it was
    // told: the key and what to report. Starting over is the one thing that is surely right.
    if (greeted && message.hello.fresh) options.onForgotten();
    greeted = true;
  };
  return { port, lost };
}
