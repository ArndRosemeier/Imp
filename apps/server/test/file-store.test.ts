import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeBlobStoreContract, describeKeyValueStoreContract } from '@imp/core/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { FileBlobStore, FileKeyValueStore } from '../src/file-store.js';

const folders: string[] = [];
async function folder(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'imp-store-'));
  folders.push(created);
  return created;
}
afterAll(async () => {
  for (const created of folders) await rm(created, { recursive: true, force: true });
});

describeKeyValueStoreContract('FileKeyValueStore', async () =>
  FileKeyValueStore.open(join(await folder(), 'nested', 'data.jsonl')),
);
describeBlobStoreContract('FileBlobStore', async () => FileBlobStore.open(await folder()));

describe('FileKeyValueStore', () => {
  it('finds everything again after a restart', async () => {
    const path = join(await folder(), 'data.jsonl');
    const first = await FileKeyValueStore.open(path);
    await first.batch([
      { type: 'put', key: 'a', value: { n: 1 } },
      { type: 'put', key: 'a/b', value: 'two' },
    ]);
    await first.batch([]);
    await first.batch([{ type: 'delete', key: 'a' }]);
    const second = await FileKeyValueStore.open(path);
    expect(await second.list('')).toEqual([{ key: 'a/b', value: 'two' }]);
  });

  it('ignores a write that was cut off, and goes on from before it', async () => {
    const path = join(await folder(), 'data.jsonl');
    await (await FileKeyValueStore.open(path)).batch([{ type: 'put', key: 'kept', value: 1 }]);
    await appendFile(path, '[{"type":"put","key":"torn","val');
    const store = await FileKeyValueStore.open(path);
    expect(await store.list('')).toEqual([{ key: 'kept', value: 1 }]);
    await store.batch([{ type: 'put', key: 'next', value: 2 }]);
    expect((await (await FileKeyValueStore.open(path)).list('')).map(({ key }) => key)).toEqual([
      'kept',
      'next',
    ]);
  });

  it('rewrites a journal that has grown far beyond what it holds', async () => {
    const path = join(await folder(), 'data.jsonl');
    const line = (value: number) => `[{"type":"put","key":"k","value":${String(value)}}]\n`;
    await writeFile(path, Array.from({ length: 1200 }, (_, index) => line(index)).join(''));
    const store = await FileKeyValueStore.open(path);
    expect(await store.get('k')).toBe(1199);
    expect(await readFile(path, 'utf8')).toBe(line(1199));
  });

  it('keeps writing after a write that was refused, and fails on a folder it cannot read', async () => {
    const root = await folder();
    const store = await FileKeyValueStore.open(join(root, 'data.jsonl'));
    await expect(store.batch([{ type: 'put', key: 'bad key', value: 1 }])).rejects.toThrow();
    await store.batch([{ type: 'put', key: 'good', value: 1 }]);
    expect(await store.get('good')).toBe(1);
    await expect(FileKeyValueStore.open(root)).rejects.toThrow();
  });
});

describe('FileBlobStore', () => {
  it('finds files again after a restart, under keys that would be unsafe as paths', async () => {
    const root = await folder();
    const first = await FileBlobStore.open(root);
    await first.put('a/../b:c', { bytes: new Uint8Array([7]), mediaType: 'audio/mpeg' });
    const second = await FileBlobStore.open(root);
    expect(await second.list('')).toEqual(['a/../b:c']);
    expect(await second.get('a/../b:c')).toEqual({
      bytes: new Uint8Array([7]),
      mediaType: 'audio/mpeg',
    });
    await expect(
      second.put('bad key', { bytes: new Uint8Array(), mediaType: 'x/y' }),
    ).rejects.toThrow();
  });

  it('answers with nothing when a file went missing, and fails on other trouble', async () => {
    const root = await folder();
    const store = await FileBlobStore.open(root);
    await store.put('gone', { bytes: new Uint8Array([1]), mediaType: 'x/y' });
    const { readdir, mkdir } = await import('node:fs/promises');
    const [file] = (await readdir(root)).filter((name) => name.endsWith('.bin'));
    await rm(join(root, file ?? ''));
    expect(await store.get('gone')).toBeUndefined();
    await mkdir(join(root, file ?? ''));
    await expect(store.get('gone')).rejects.toThrow();
  });
});
