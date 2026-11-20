const KEY_NAME = 'imp.openrouter-key';

/**
 * Where the browser host keeps the OpenRouter key. It is deliberately outside
 * the key-value store, so no command and therefore no agent can read it.
 */
export interface SecretStore {
  getKey(): string | null;
  setKey(key: string): void;
  clearKey(): void;
}

export function createLocalSecretStore(storage: Storage = localStorage): SecretStore {
  return {
    getKey: () => storage.getItem(KEY_NAME),
    setKey: (key) => {
      storage.setItem(KEY_NAME, key);
    },
    clearKey: () => {
      storage.removeItem(KEY_NAME);
    },
  };
}
