import { describe, expect, it } from 'vitest';
import type { CoreRuntime } from './runtime.js';
import { MemoryBlobStore, type BlobStore } from './storage/blob.js';
import type { KeyValueChange, KeyValueStore } from './storage/kv.js';
import { MemoryKeyValueStore } from './storage/memory.js';

/** A runtime with memory stores, a clock that advances 1 ms per reading and counted ids. */
export function createTestRuntime(store: KeyValueStore = new MemoryKeyValueStore()): CoreRuntime {
  let tick = 0;
  let nextId = 0;
  return {
    store,
    blobs: new MemoryBlobStore(),
    now: () => new Date(Date.UTC(2026, 0, 1) + tick++),
    newId: () => `id-${String(++nextId).padStart(4, '0')}`,
  };
}

/**
 * The contract every storage implementation must pass. Call it from the test
 * file of each implementation with a factory that returns an empty store.
 */
export function describeKeyValueStoreContract(
  name: string,
  createStore: () => KeyValueStore | Promise<KeyValueStore>,
): void {
  describe(`${name} (KeyValueStore contract)`, () => {
    it('returns undefined for a missing key', async () => {
      const store = await createStore();
      expect(await store.get('missing/key')).toBeUndefined();
    });

    it('stores and returns JSON values of every kind', async () => {
      const store = await createStore();
      const value = { text: 'a', count: 2, flag: true, nothing: null, list: [1, 'two', { x: 3 }] };
      await store.batch([{ type: 'put', key: 'a/b', value }]);
      expect(await store.get('a/b')).toEqual(value);
    });

    it('does not let callers mutate stored values', async () => {
      const store = await createStore();
      const value = { list: [1] };
      await store.batch([{ type: 'put', key: 'a', value }]);
      value.list.push(2);
      expect(await store.get('a')).toEqual({ list: [1] });
    });

    it('replaces and deletes values', async () => {
      const store = await createStore();
      await store.batch([{ type: 'put', key: 'a', value: 1 }]);
      await store.batch([{ type: 'put', key: 'a', value: 2 }]);
      expect(await store.get('a')).toBe(2);
      await store.batch([{ type: 'delete', key: 'a' }]);
      expect(await store.get('a')).toBeUndefined();
    });

    it('lists by prefix, sorted by key', async () => {
      const store = await createStore();
      await store.batch([
        { type: 'put', key: 'p/b', value: 2 },
        { type: 'put', key: 'p/a', value: 1 },
        { type: 'put', key: 'q/a', value: 3 },
      ]);
      expect(await store.list('p/')).toEqual([
        { key: 'p/a', value: 1 },
        { key: 'p/b', value: 2 },
      ]);
      expect(await store.list('none/')).toEqual([]);
    });

    it('applies the operations of a batch in order', async () => {
      const store = await createStore();
      await store.batch([
        { type: 'put', key: 'a', value: 1 },
        { type: 'delete', key: 'a' },
        { type: 'put', key: 'a', value: 3 },
      ]);
      expect(await store.get('a')).toBe(3);
    });

    it('applies nothing when one operation of a batch is invalid', async () => {
      const store = await createStore();
      await expect(
        store.batch([
          { type: 'put', key: 'good', value: 1 },
          { type: 'put', key: 'bad key', value: 2 },
        ]),
      ).rejects.toThrow();
      expect(await store.get('good')).toBeUndefined();
    });

    it('notifies subscribers of changes under their prefix until they unsubscribe', async () => {
      const store = await createStore();
      const seen: KeyValueChange[][] = [];
      const unsubscribe = store.subscribe('p/', (changes) => seen.push([...changes]));
      await store.batch([
        { type: 'put', key: 'p/a', value: 1 },
        { type: 'put', key: 'q/a', value: 2 },
      ]);
      await store.batch([{ type: 'put', key: 'q/b', value: 3 }]);
      unsubscribe();
      await store.batch([{ type: 'delete', key: 'p/a' }]);
      expect(seen).toEqual([[{ type: 'put', key: 'p/a', value: 1 }]]);
    });
  });
}

/**
 * The contract every blob storage implementation must pass. Call it from the
 * test file of each implementation with a factory that returns an empty store.
 */
export function describeBlobStoreContract(
  name: string,
  createStore: () => BlobStore | Promise<BlobStore>,
): void {
  const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

  describe(`${name} (BlobStore contract)`, () => {
    it('returns undefined for a missing key', async () => {
      const store = await createStore();
      expect(await store.get('missing/key')).toBeUndefined();
    });

    it('stores bytes of every value with their media type, and replaces them', async () => {
      const store = await createStore();
      const all = new Uint8Array(256).map((_, index) => index);
      await store.put('a/b', { bytes: all, mediaType: 'image/webp' });
      const read = await store.get('a/b');
      expect(read?.mediaType).toBe('image/webp');
      expect([...(read?.bytes ?? [])]).toEqual([...all]);

      await store.put('a/b', { bytes: bytes(1, 2), mediaType: 'image/png' });
      const replaced = await store.get('a/b');
      expect(replaced?.mediaType).toBe('image/png');
      expect([...(replaced?.bytes ?? [])]).toEqual([1, 2]);
    });

    it('does not let callers change what is stored', async () => {
      const store = await createStore();
      const given = bytes(1, 2, 3);
      await store.put('a', { bytes: given, mediaType: 'x/y' });
      given[0] = 9;
      const first = await store.get('a');
      if (first !== undefined) first.bytes[1] = 9;
      expect([...((await store.get('a'))?.bytes ?? [])]).toEqual([1, 2, 3]);
    });

    it('lists keys by prefix, sorted, and deletes', async () => {
      const store = await createStore();
      for (const key of ['p/b', 'p/a', 'q/a']) {
        await store.put(key, { bytes: bytes(0), mediaType: 'x/y' });
      }
      expect(await store.list('p/')).toEqual(['p/a', 'p/b']);
      expect(await store.list('')).toEqual(['p/a', 'p/b', 'q/a']);
      await store.delete('p/a');
      await store.delete('never/there');
      expect(await store.list('p/')).toEqual(['p/b']);
      expect(await store.get('p/a')).toBeUndefined();
    });

    it('rejects malformed keys', async () => {
      const store = await createStore();
      await expect(store.put('bad key', { bytes: bytes(0), mediaType: 'x/y' })).rejects.toThrow(
        /Invalid store key/,
      );
    });
  });
}
