import type { KeyValueStore } from './storage/kv.js';

/**
 * Everything the core needs from its host. The browser worker and the local
 * server each build one of these; nothing in the core touches a host API directly.
 */
export interface CoreRuntime {
  readonly store: KeyValueStore;
  /** The current time. Injected so tests are deterministic. */
  readonly now: () => Date;
  /** A new unique id. Injected because the source of randomness differs per host. */
  readonly newId: () => string;
}
