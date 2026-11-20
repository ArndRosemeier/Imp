import { assertValidKey } from './kv.js';

/** A file-like value: bytes and what they are. Images, audio and video are stored like this. */
export interface StoredBlob {
  readonly bytes: Uint8Array;
  /** The media type, for example `image/webp`. */
  readonly mediaType: string;
}

/**
 * Storage for binary data, beside the key-value store, which holds only JSON.
 * Records in the key-value store point at blobs by key. Keys follow the same
 * rules and the same project prefixes, so one sweep removes both.
 *
 * `describeBlobStoreContract` in `@imp/core/testing` is the suite every
 * implementation must pass.
 */
export interface BlobStore {
  /** Returns the blob, or `undefined` when the key is absent. */
  get(key: string): Promise<StoredBlob | undefined>;
  /** Stores the blob, replacing any earlier one under the key. */
  put(key: string, blob: StoredBlob): Promise<void>;
  /** Removes the blob. Removing an absent key is not an error. */
  delete(key: string): Promise<void>;
  /** Returns every key that starts with `prefix`, sorted. */
  list(prefix: string): Promise<readonly string[]>;
}

/** Keeps blobs in memory. For tests, and for hosts without durable storage. */
export class MemoryBlobStore implements BlobStore {
  readonly #data = new Map<string, StoredBlob>();

  get(key: string): Promise<StoredBlob | undefined> {
    const blob = this.#data.get(key);
    // A copy, so callers can never change what is stored.
    return Promise.resolve(
      blob === undefined ? undefined : { bytes: blob.bytes.slice(), mediaType: blob.mediaType },
    );
  }

  put(key: string, blob: StoredBlob): Promise<void> {
    // An async wrapper would do, but the other methods are synchronous inside too.
    return Promise.resolve().then(() => {
      assertValidKey(key);
      this.#data.set(key, { bytes: blob.bytes.slice(), mediaType: blob.mediaType });
    });
  }

  delete(key: string): Promise<void> {
    this.#data.delete(key);
    return Promise.resolve();
  }

  list(prefix: string): Promise<readonly string[]> {
    return Promise.resolve([...this.#data.keys()].filter((key) => key.startsWith(prefix)).sort());
  }
}
