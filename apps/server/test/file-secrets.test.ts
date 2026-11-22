import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileSecretStore } from '../src/file-secrets.js';

let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'imp-secrets-'));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('the key kept by the local server', () => {
  it('keeps the key in a file only its user can read, across restarts', async () => {
    const path = join(folder, 'secrets', 'openrouter-key');
    const first = createFileSecretStore(path);
    expect(first.getKey()).toBeNull();
    first.setKey('sk-server');
    expect(first.getKey()).toBe('sk-server');
    expect((await readFile(path, 'utf8')).trim()).toBe('sk-server');
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect(createFileSecretStore(path).getKey()).toBe('sk-server');
    first.clearKey();
    expect(first.getKey()).toBeNull();
    expect(createFileSecretStore(path).getKey()).toBeNull();
  });
});
