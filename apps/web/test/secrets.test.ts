import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import {
  LEGACY_KEY_NAME,
  openBrowserSecretStore,
  openEncryptedSecretStore,
} from '../src/host/secrets.js';

/** A Storage in memory, standing in for localStorage. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => {
      items.clear();
    },
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

/** Everything the database holds, as text, to show the key is not in it. */
async function databaseText(factory: IDBFactory): Promise<string> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = factory.open('imp-secrets', 1);
    opening.onsuccess = () => {
      resolve(opening.result);
    };
    opening.onerror = () => {
      reject(new Error('no database'));
    };
  });
  const values = await new Promise<unknown[]>((resolve) => {
    const all = database.transaction('secrets').objectStore('secrets').getAll();
    all.onsuccess = () => {
      resolve(all.result as unknown[]);
    };
  });
  database.close();
  return values
    .map((value) =>
      value instanceof CryptoKey
        ? `CryptoKey extractable=${String(value.extractable)}`
        : new TextDecoder().decode((value as { data: ArrayBuffer }).data),
    )
    .join('\n');
}

describe('the key kept encrypted in the browser', () => {
  it('keeps the key across reloads without storing it readable', async () => {
    const factory = new IDBFactory();
    const legacy = memoryStorage();
    const first = await openEncryptedSecretStore({ indexedDB: factory, legacy });
    expect(first.getKey()).toBeNull();
    first.setKey('sk-or-v1-secret');
    expect(first.getKey()).toBe('sk-or-v1-secret');
    await first.flush();

    const text = await databaseText(factory);
    expect(text).toContain('CryptoKey extractable=false');
    expect(text).not.toContain('sk-or-v1-secret');
    expect(legacy.length).toBe(0);

    const again = await openEncryptedSecretStore({ indexedDB: factory, legacy });
    expect(again.getKey()).toBe('sk-or-v1-secret');
    again.clearKey();
    await again.flush();
    expect((await openEncryptedSecretStore({ indexedDB: factory, legacy })).getKey()).toBeNull();
  });

  it('encrypts a key an older version left in plain text and removes the plain copy', async () => {
    const factory = new IDBFactory();
    const legacy = memoryStorage();
    legacy.setItem(LEGACY_KEY_NAME, 'sk-old');
    const store = await openEncryptedSecretStore({ indexedDB: factory, legacy });
    expect(store.getKey()).toBe('sk-old');
    await store.flush();
    expect(legacy.getItem(LEGACY_KEY_NAME)).toBeNull();
    expect((await openEncryptedSecretStore({ indexedDB: factory, legacy })).getKey()).toBe(
      'sk-old',
    );
  });

  it('prefers the encrypted key over a stale plain one, and still removes the plain one', async () => {
    const factory = new IDBFactory();
    const legacy = memoryStorage();
    const first = await openEncryptedSecretStore({ indexedDB: factory, legacy });
    first.setKey('sk-new');
    await first.flush();
    legacy.setItem(LEGACY_KEY_NAME, 'sk-stale');
    const second = await openEncryptedSecretStore({ indexedDB: factory, legacy });
    expect(second.getKey()).toBe('sk-new');
    await second.flush();
    expect(legacy.getItem(LEGACY_KEY_NAME)).toBeNull();
  });

  it('keeps the plain copy when the encrypted one cannot be stored', async () => {
    const factory = new IDBFactory();
    const legacy = memoryStorage();
    legacy.setItem(LEGACY_KEY_NAME, 'sk-old');
    const failing: Crypto = {
      getRandomValues: (array) => crypto.getRandomValues(array),
      randomUUID: () => crypto.randomUUID(),
      subtle: {
        generateKey: crypto.subtle.generateKey.bind(crypto.subtle),
        decrypt: crypto.subtle.decrypt.bind(crypto.subtle),
        encrypt: () => Promise.reject(new Error('no')),
      } as unknown as SubtleCrypto,
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = await openEncryptedSecretStore({ indexedDB: factory, legacy, crypto: failing });
    await store.flush();
    expect(store.getKey()).toBe('sk-old');
    expect(legacy.getItem(LEGACY_KEY_NAME)).toBe('sk-old');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('drops a sealed key it can no longer decrypt', async () => {
    const factory = new IDBFactory();
    const legacy = memoryStorage();
    const first = await openEncryptedSecretStore({ indexedDB: factory, legacy });
    first.setKey('sk-gone');
    await first.flush();
    // The site's AES key is replaced, as when only part of the storage survives.
    await new Promise<void>((resolve) => {
      const opening = factory.open('imp-secrets', 1);
      opening.onsuccess = () => {
        const transaction = opening.result.transaction('secrets', 'readwrite');
        transaction.objectStore('secrets').delete('cipher');
        transaction.oncomplete = () => {
          opening.result.close();
          resolve();
        };
      };
    });
    const second = await openEncryptedSecretStore({ indexedDB: factory, legacy });
    expect(second.getKey()).toBeNull();
  });

  it('falls back to the plain store where IndexedDB is not available', async () => {
    const legacy = memoryStorage();
    const broken = {
      open: () => {
        throw new Error('IndexedDB is off');
      },
    } as unknown as IDBFactory;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = await openBrowserSecretStore({ indexedDB: broken, legacy });
    store.setKey('sk-plain');
    await store.flush();
    expect(legacy.getItem(LEGACY_KEY_NAME)).toBe('sk-plain');
    store.clearKey();
    expect(store.getKey()).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('opens the encrypted store where the browser has what it needs', async () => {
    const legacy = memoryStorage();
    const store = await openBrowserSecretStore({ indexedDB: new IDBFactory(), legacy });
    store.setKey('sk-sealed');
    await store.flush();
    expect(legacy.getItem(LEGACY_KEY_NAME)).toBeNull();
  });
});
