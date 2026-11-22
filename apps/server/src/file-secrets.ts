import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SecretStore } from '@imp/host';

/**
 * Keeps the OpenRouter key in a file of its own, readable only by the user
 * running Imp (on systems that have such permissions). It lives outside the
 * project data, so no command and no agent can read it, and the browser is
 * never given it.
 */
export function createFileSecretStore(path: string): SecretStore {
  let held: string | null;
  try {
    const text = readFileSync(path, 'utf8').trim();
    held = text === '' ? null : text;
  } catch {
    held = null;
  }
  return {
    getKey: () => held,
    setKey: (key) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // Written beside it first, so a crash never leaves half a key.
      const next = `${path}.new`;
      writeFileSync(next, `${key}\n`, { mode: 0o600 });
      chmodSync(next, 0o600);
      renameSync(next, path);
      held = key;
    },
    clearKey: () => {
      rmSync(path, { force: true });
      held = null;
    },
  };
}
