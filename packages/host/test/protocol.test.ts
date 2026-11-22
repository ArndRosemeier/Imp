import { MemoryBlobStore, MemoryKeyValueStore } from '@imp/core';
import { ProviderError } from '@imp/providers';
import { createFakeProvider } from '@imp/providers/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  connectImp,
  createImp,
  createLocalPorts,
  createMemorySecretStore,
  fromWireError,
  serveImp,
  toWireError,
  type SecretStore,
} from '../src/index.js';

function setup(options: Parameters<typeof createFakeProvider>[0] = {}) {
  const [page, core] = createLocalPorts();
  const store = new MemoryKeyValueStore();
  const blobs = new MemoryBlobStore();
  const held: { secrets?: SecretStore } = {};
  const open = vi.fn((secrets: SecretStore) => {
    held.secrets = secrets;
    return createImp({ store, blobs, secrets, provider: createFakeProvider(options) });
  });
  serveImp(open, core);
  const stored = createMemorySecretStore();
  return { page, store, blobs, held, open, stored };
}

describe('the channel between the interface and the core', () => {
  it('opens the core once, and describes its commands and modes', async () => {
    const { page, open, stored } = setup();
    const client = connectImp(page, stored);
    await client.start();
    await client.listModels();
    expect(open).toHaveBeenCalledTimes(1);
    expect(client.modes).toEqual([
      expect.objectContaining({ id: 'movie', stages: expect.any(Array) as unknown }),
    ]);
    expect(client.commands.find((command) => command.id === 'settings.set')).toMatchObject({
      title: expect.any(String) as string,
      effect: 'write',
      input: { type: 'object' },
    });
  });

  it('runs commands as the user and carries errors over with what they say', async () => {
    const { page, stored } = setup({
      credentialsError: new ProviderError('auth', 'fake', 'The key was refused.'),
    });
    const client = connectImp(page, stored);
    await client.start();
    expect(await client.run('settings.set', { key: 'theme', value: 'dark' })).toMatchObject({
      status: 'ok',
    });
    await expect(client.run('settings.set', {})).rejects.toMatchObject({
      name: 'CommandError',
      code: 'invalid_input',
      details: expect.any(Array) as unknown,
    });
    await expect(client.verifyCredentials()).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'auth',
      message: 'The key was refused.',
    });
  });

  it('hands the key to the core and takes it away again', async () => {
    const { page, held, stored } = setup();
    stored.setKey('sk-first');
    const client = connectImp(page, stored);
    await client.start();
    expect(held.secrets?.getKey()).toBe('sk-first');
    expect(client.secrets.hasKey()).toBe(true);
    client.secrets.setKey('sk-second');
    await client.verifyCredentials();
    expect([stored.getKey(), held.secrets?.getKey()]).toEqual(['sk-second', 'sk-second']);
    client.secrets.clearKey();
    expect(client.secrets.hasKey()).toBe(false);
    await client.listModels();
    expect([stored.getKey(), held.secrets?.getKey()]).toEqual([null, null]);
  });

  it('leaves the key with a core that keeps its own, and never holds it', async () => {
    const { page, held } = setup();
    const client = connectImp(page, { by: 'core' });
    await client.start();
    expect(client.secrets.hasKey()).toBe(false);
    client.secrets.setKey('sk-core');
    await client.verifyCredentials();
    expect(held.secrets?.getKey()).toBe('sk-core');
    expect(client.secrets.hasKey()).toBe(true);
    expect(client.secrets).not.toHaveProperty('getKey');
  });

  it('moves a key an older version left in the page over to the core once', async () => {
    const { page, held } = setup();
    const forget = vi.fn();
    const client = connectImp(page, { by: 'core', leftover: { key: 'sk-old', forget } });
    await client.start();
    await client.listModels();
    expect(held.secrets?.getKey()).toBe('sk-old');
    expect(client.secrets.hasKey()).toBe(true);
    expect(forget).toHaveBeenCalledOnce();
  });

  it('keeps the core’s own key over one left in the page', async () => {
    const [page, core] = createLocalPorts();
    const secrets = createMemorySecretStore();
    secrets.setKey('sk-core');
    serveImp(
      (held) =>
        createImp({
          store: new MemoryKeyValueStore(),
          secrets: held,
          provider: createFakeProvider({}),
        }),
      core,
      secrets,
    );
    const forget = vi.fn();
    const client = connectImp(page, { by: 'core', leftover: { key: 'sk-old', forget } });
    await client.start();
    await client.listModels();
    expect(secrets.getKey()).toBe('sk-core');
    expect(client.secrets.hasKey()).toBe(true);
    expect(forget).toHaveBeenCalledOnce();
  });

  it('tells subscribers of changes until they unsubscribe, also one made at once', async () => {
    const { page, stored } = setup();
    const client = connectImp(page, stored);
    await client.start();
    const seen = vi.fn();
    const never = vi.fn();
    const stop = client.subscribe('settings/', seen);
    client.subscribe('settings/', never)();
    await client.run('settings.set', { key: 'theme', value: 'dark' });
    await vi.waitFor(() => {
      expect(seen).toHaveBeenCalledTimes(1);
    });
    stop();
    await client.run('settings.set', { key: 'theme', value: 'light' });
    await client.listModels();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(never).not.toHaveBeenCalled();
  });

  it('returns stored files as bytes, and nothing for a key without one', async () => {
    const { page, blobs, stored } = setup();
    const client = connectImp(page, stored);
    await blobs.put('a/b', { bytes: new Uint8Array([1, 2, 255]), mediaType: 'image/webp' });
    expect(await client.blob('a/b')).toEqual({
      bytes: new Uint8Array([1, 2, 255]),
      mediaType: 'image/webp',
    });
    expect(await client.blob('a/none')).toBeUndefined();
  });

  it('takes in a picked file in parts and imports it; an export is removed once saved', async () => {
    const { page, blobs, stored } = setup();
    const client = connectImp(page, stored);
    await client.start();
    const created = await client.run('project.create', { name: 'Keeper', mode: 'movie' });
    const project = (created as { output: { id: string } }).output;
    await blobs.put(`projects/${project.id}/movie/characters/c/images/i`, {
      bytes: new Uint8Array(5 * 1024 * 1024).fill(7),
      mediaType: 'image/png',
    });
    const exported = (await client.run('project.export', { projectId: project.id })) as {
      output: { fileKey: string };
    };
    const file = await client.blob(exported.output.fileKey, true);
    expect(await blobs.get(exported.output.fileKey)).toBeUndefined();
    // Larger than one part, so it crosses in two.
    const key = await client.upload(file?.bytes ?? new Uint8Array(), 'application/zip');
    expect(key).toMatch(/^uploads\//);
    expect((await blobs.get(key))?.bytes.length).toBe(file?.bytes.length);
    const imported = await client.run('project.import', { fileKey: key });
    expect(imported).toMatchObject({ status: 'ok', output: { name: 'Keeper (2)', files: 1 } });
    expect(await client.upload(new Uint8Array(), 'text/plain')).toMatch(/^uploads\//);
  });

  it('fails the start when the other end is lost', async () => {
    const [page] = createLocalPorts();
    const client = connectImp(
      page,
      createMemorySecretStore(),
      Promise.reject(new Error('its core did not load')),
    );
    await expect(client.start()).rejects.toThrow('its core did not load');
  });

  it('carries anything thrown as an error', () => {
    expect(toWireError('plain')).toEqual({ name: 'Error', message: 'plain' });
    const error = fromWireError({ name: 'X', message: 'm', code: 'c', details: ['d'] });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'X', message: 'm', code: 'c', details: ['d'] });
  });
});
