import { describe, expect, it } from 'vitest';
import type { CoreRuntime } from './runtime.js';
import type { KeyValueChange, KeyValueStore } from './storage/kv.js';
import { MemoryKeyValueStore } from './storage/memory.js';

/** A runtime with a memory store, a clock that advances 1 ms per reading and counted ids. */
export function createTestRuntime(store: KeyValueStore = new MemoryKeyValueStore()): CoreRuntime {
  let tick = 0;
  let nextId = 0;
  return {
    store,
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
