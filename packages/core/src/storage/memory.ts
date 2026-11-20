import type { JsonValue } from '../json.js';
import {
  assertValidKey,
  type KeyValueEntry,
  type KeyValueListener,
  type KeyValueStore,
  type Unsubscribe,
  type WriteOperation,
} from './kv.js';

interface Subscription {
  readonly prefix: string;
  readonly listener: KeyValueListener;
}

/** Stores JSON text, so callers can never share a mutable object with the store. */
export class MemoryKeyValueStore implements KeyValueStore {
  readonly #data = new Map<string, string>();
  readonly #subscriptions = new Set<Subscription>();

  get(key: string): Promise<JsonValue | undefined> {
    const text = this.#data.get(key);
    return Promise.resolve(text === undefined ? undefined : (JSON.parse(text) as JsonValue));
  }

  list(prefix: string): Promise<readonly KeyValueEntry[]> {
    const entries: KeyValueEntry[] = [];
    for (const [key, text] of this.#data) {
      if (key.startsWith(prefix)) {
        entries.push({ key, value: JSON.parse(text) as JsonValue });
      }
    }
    entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return Promise.resolve(entries);
  }

  batch(operations: readonly WriteOperation[]): Promise<void> {
    try {
      // Validate and serialise everything first, so a bad operation leaves the store untouched.
      const prepared = operations.map((operation) => {
        assertValidKey(operation.key);
        return operation.type === 'put'
          ? { operation, text: JSON.stringify(operation.value) }
          : { operation, text: undefined };
      });
      for (const { operation, text } of prepared) {
        if (text === undefined) {
          this.#data.delete(operation.key);
        } else {
          this.#data.set(operation.key, text);
        }
      }
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.#notify(operations);
    return Promise.resolve();
  }

  subscribe(prefix: string, listener: KeyValueListener): Unsubscribe {
    const subscription: Subscription = { prefix, listener };
    this.#subscriptions.add(subscription);
    return () => {
      this.#subscriptions.delete(subscription);
    };
  }

  #notify(operations: readonly WriteOperation[]): void {
    for (const { prefix, listener } of this.#subscriptions) {
      const changes = operations.filter((operation) => operation.key.startsWith(prefix));
      if (changes.length > 0) {
        listener(changes);
      }
    }
  }
}
