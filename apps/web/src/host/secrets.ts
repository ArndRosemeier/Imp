import type { SecretStore } from '@imp/host';

/** Where versions before the encrypted store kept the key, in plain text. */
export const LEGACY_KEY_NAME = 'imp.openrouter-key';

const DATABASE = 'imp-secrets';
const STORE = 'secrets';
/** The AES key the browser made for this site; it cannot be exported. */
const CIPHER = 'cipher';
/** The OpenRouter key, encrypted: a fresh nonce and the sealed bytes. */
const SEALED = 'openrouter';

interface Sealed {
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly data: ArrayBuffer;
}

/** A secret store that also says when its last change is safely written. */
export interface PersistentSecretStore extends SecretStore {
  /** Resolves once every change so far is stored. */
  flush(): Promise<void>;
}

/** Keeps the key in the browser in plain text: only where encryption is not possible. */
export function createLocalSecretStore(storage: Storage = localStorage): PersistentSecretStore {
  return {
    getKey: () => storage.getItem(LEGACY_KEY_NAME),
    setKey: (key) => {
      storage.setItem(LEGACY_KEY_NAME, key);
    },
    clearKey: () => {
      storage.removeItem(LEGACY_KEY_NAME);
    },
    flush: () => Promise.resolve(),
  };
}

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

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction was aborted.'));
    };
  });
}

export interface EncryptedSecretOptions {
  readonly indexedDB?: IDBFactory;
  readonly crypto?: Crypto;
  /** Where an older version may have left the key in plain text. */
  readonly legacy?: Storage;
}

/**
 * Keeps the OpenRouter key encrypted in the browser. The browser makes an
 * AES-GCM key for this site that cannot be exported (no script, Imp's own
 * included, can read its bytes) and keeps it in IndexedDB beside the
 * encrypted OpenRouter key. Someone who copies the browser's files or looks
 * through its storage sees no key; code running in the page could still ask
 * the browser to decrypt it, so this hides the key at rest rather than
 * making it unreachable. A key an older version left in plain text is
 * encrypted and the plain copy removed.
 */
export async function openEncryptedSecretStore(
  options: EncryptedSecretOptions = {},
): Promise<PersistentSecretStore> {
  const factory = options.indexedDB ?? indexedDB;
  const random = options.crypto ?? crypto;
  const subtle = random.subtle;
  const legacy = options.legacy ?? localStorage;

  const opening = factory.open(DATABASE, 1);
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore(STORE);
  };
  const database = await request(opening);

  const read = async (key: string): Promise<unknown> =>
    request(database.transaction(STORE, 'readonly').objectStore(STORE).get(key));
  const write = async (key: string, value: unknown): Promise<void> => {
    const transaction = database.transaction(STORE, 'readwrite');
    if (value === undefined) transaction.objectStore(STORE).delete(key);
    else transaction.objectStore(STORE).put(value, key);
    await done(transaction);
  };

  let cipher = (await read(CIPHER)) as CryptoKey | undefined;
  if (cipher === undefined) {
    cipher = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    await write(CIPHER, cipher);
  }
  const aes = cipher;

  let held: string | null = null;
  const sealed = (await read(SEALED)) as Sealed | undefined;
  if (sealed !== undefined) {
    try {
      held = new TextDecoder().decode(
        await subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, aes, sealed.data),
      );
    } catch {
      // Sealed with a key that is gone: it can never be read, so it is dropped.
      await write(SEALED, undefined);
    }
  }

  // Changes are written in order; the key in memory is current at once.
  let writing: Promise<void> = Promise.resolve();
  const queue = (step: () => Promise<void>): void => {
    writing = writing.then(step).catch((error: unknown) => {
      console.error('The OpenRouter key could not be stored.', error);
    });
  };
  const sealNow = async (key: string): Promise<void> => {
    const iv = random.getRandomValues(new Uint8Array(12));
    const data = await subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(key));
    await write(SEALED, { iv, data } satisfies Sealed);
  };

  const plain = legacy.getItem(LEGACY_KEY_NAME);
  if (plain !== null) {
    const moving = held === null && plain !== '';
    if (moving) held = plain;
    // The plain copy goes only once the encrypted one is stored.
    queue(async () => {
      if (moving) await sealNow(plain);
      legacy.removeItem(LEGACY_KEY_NAME);
    });
  }

  return {
    getKey: () => held,
    setKey: (key) => {
      held = key;
      queue(() => sealNow(key));
    },
    clearKey: () => {
      held = null;
      queue(() => write(SEALED, undefined));
    },
    flush: () => writing,
  };
}

/**
 * The browser's key store: encrypted where the browser allows it, and the
 * old plain one where it does not (IndexedDB can be off in a private window).
 */
export async function openBrowserSecretStore(
  options: EncryptedSecretOptions = {},
): Promise<PersistentSecretStore> {
  try {
    return await openEncryptedSecretStore(options);
  } catch (error) {
    console.warn('The key cannot be encrypted in this browser; it is kept as before.', error);
    return createLocalSecretStore(options.legacy ?? localStorage);
  }
}
