import type { SecretStore } from '@imp/host';

const KEY_NAME = 'imp.openrouter-key';

/** Keeps the key in the browser, on the page's side of the channel. */
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
