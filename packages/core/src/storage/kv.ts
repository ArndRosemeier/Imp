import type { JsonValue } from '../json.js';

export interface KeyValueEntry {
  readonly key: string;
  readonly value: JsonValue;
}

export type WriteOperation =
  | { readonly type: 'put'; readonly key: string; readonly value: JsonValue }
  | { readonly type: 'delete'; readonly key: string };

export type KeyValueChange = WriteOperation;
export type KeyValueListener = (changes: readonly KeyValueChange[]) => void;
export type Unsubscribe = () => void;

/**
 * The storage contract. The browser host implements it on IndexedDB and the
 * local server on plain files; `describeKeyValueStoreContract` in
 * `@imp/core/testing` is the suite every implementation must pass.
 *
 * Keys are slash-separated paths such as `settings/coordinator-model`.
 */
export interface KeyValueStore {
  /** Returns the stored value, or `undefined` when the key is absent. */
  get(key: string): Promise<JsonValue | undefined>;
  /** Returns every entry whose key starts with `prefix`, sorted by key. */
  list(prefix: string): Promise<readonly KeyValueEntry[]>;
  /** Applies all operations or none of them, in order. */
  batch(operations: readonly WriteOperation[]): Promise<void>;
  /** Calls `listener` after each batch with the changes under `prefix`. */
  subscribe(prefix: string, listener: KeyValueListener): Unsubscribe;
}

const KEY_PATTERN = /^[A-Za-z0-9._:-]+(\/[A-Za-z0-9._:-]+)*$/;

/** Throws when `key` is not a well-formed store key. Implementations call this on every write. */
export function assertValidKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new TypeError(`Invalid store key: "${key}"`);
  }
}
