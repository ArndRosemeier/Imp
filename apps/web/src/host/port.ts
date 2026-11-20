/**
 * One end of a message channel. A worker and the page each hold one end; so
 * would the page and a local server. Only values that survive structured
 * cloning cross it, which is what keeps the interface and the core apart.
 */
export interface Port {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/**
 * Two connected ends in the same thread. Messages are cloned and delivered
 * later, exactly as between a page and a worker, so code that works over
 * these works over a real worker. Used where workers are missing, and in tests.
 */
export function createLocalPorts(): [Port, Port] {
  const end = (other: () => Port): Port => ({
    onmessage: null,
    postMessage(message) {
      const data: unknown = structuredClone(message);
      queueMicrotask(() => {
        other().onmessage?.({ data });
      });
    },
  });
  const a: Port = end(() => b);
  const b: Port = end(() => a);
  return [a, b];
}
