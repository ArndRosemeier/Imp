import {
  assertValidKey,
  type JsonValue,
  type KeyValueEntry,
  type KeyValueListener,
  type KeyValueStore,
  type Unsubscribe,
  type WriteOperation,
} from '@imp/core';

const STORE = 'kv';

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => {
      resolve(source.result);
    };
    source.onerror = () => {
      reject(source.error ?? new Error('IndexedDB request failed.'));
    };
  });
}

/** The browser implementation of the storage contract, on one IndexedDB object store. */
export class IndexedDbKeyValueStore implements KeyValueStore {
  readonly #database: IDBDatabase;
  readonly #subscriptions = new Set<{ prefix: string; listener: KeyValueListener }>();

  private constructor(database: IDBDatabase) {
    this.#database = database;
  }

  static async open(
    name: string,
    factory: IDBFactory = indexedDB,
  ): Promise<IndexedDbKeyValueStore> {
    const opening = factory.open(name, 1);
    opening.onupgradeneeded = () => {
      opening.result.createObjectStore(STORE);
    };
    return new IndexedDbKeyValueStore(await request(opening));
  }

  async get(key: string): Promise<JsonValue | undefined> {
    const store = this.#database.transaction(STORE, 'readonly').objectStore(STORE);
    return (await request(store.get(key))) as JsonValue | undefined;
  }

  async list(prefix: string): Promise<readonly KeyValueEntry[]> {
    const store = this.#database.transaction(STORE, 'readonly').objectStore(STORE);
    // Every key that starts with the prefix sorts between it and the prefix plus the last code unit.
    const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
    const [keys, values] = await Promise.all([
      request(store.getAllKeys(range)),
      request(store.getAll(range)),
    ]);
    return keys.map((key, index) => ({ key: key as string, value: values[index] as JsonValue }));
  }

  async batch(operations: readonly WriteOperation[]): Promise<void> {
    for (const operation of operations) {
      assertValidKey(operation.key);
    }
    // One transaction, so the browser applies all operations or none.
    const transaction = this.#database.transaction(STORE, 'readwrite');
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => {
        resolve();
      };
      transaction.onabort = () => {
        reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
      };
    });
    const store = transaction.objectStore(STORE);
    for (const operation of operations) {
      if (operation.type === 'put') {
        store.put(operation.value, operation.key);
      } else {
        store.delete(operation.key);
      }
    }
    await done;
    for (const { prefix, listener } of this.#subscriptions) {
      const changes = operations.filter((operation) => operation.key.startsWith(prefix));
      if (changes.length > 0) {
        listener(changes);
      }
    }
  }

  subscribe(prefix: string, listener: KeyValueListener): Unsubscribe {
    const subscription = { prefix, listener };
    this.#subscriptions.add(subscription);
    return () => {
      this.#subscriptions.delete(subscription);
    };
  }

  close(): void {
    this.#database.close();
  }
}
