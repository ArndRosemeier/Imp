import type { BlobStore } from './storage/blob.js';
import type { KeyValueStore } from './storage/kv.js';

/**
 * Everything the core needs from its host. The browser worker and the local
 * server each build one of these; nothing in the core touches a host API directly.
 */
export interface CoreRuntime {
  readonly store: KeyValueStore;
  /** Binary data such as generated images. The key-value store points into it by key. */
  readonly blobs: BlobStore;
  /** The current time. Injected so tests are deterministic. */
  readonly now: () => Date;
  /** A new unique id. Injected because the source of randomness differs per host. */
  readonly newId: () => string;
}
