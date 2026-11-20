/**
 * Where a host keeps the OpenRouter key. It is deliberately outside the
 * key-value store, so no command and therefore no agent can read it.
 */
export interface SecretStore {
  getKey(): string | null;
  setKey(key: string): void;
  clearKey(): void;
}

/** Secrets for a core that has no storage of its own for them: it is told the key. */
export function createMemorySecretStore(): SecretStore {
  let held: string | null = null;
  return {
    getKey: () => held,
    setKey: (key) => {
      held = key;
    },
    clearKey: () => {
      held = null;
    },
  };
}
