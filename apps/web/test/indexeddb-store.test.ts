import { describeBlobStoreContract, describeKeyValueStoreContract } from '@imp/core/testing';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { IndexedDbBlobStore, IndexedDbKeyValueStore } from '../src/host/indexeddb-store.js';

describeKeyValueStoreContract('IndexedDbKeyValueStore', () =>
  IndexedDbKeyValueStore.open('test', new IDBFactory()),
);

it('keeps data across reopening the database', async () => {
  const factory = new IDBFactory();
  const first = await IndexedDbKeyValueStore.open('imp', factory);
  await first.batch([{ type: 'put', key: 'settings/theme', value: 'dark' }]);
  first.close();
  const second = await IndexedDbKeyValueStore.open('imp', factory);
  expect(await second.get('settings/theme')).toBe('dark');
});

describeBlobStoreContract('IndexedDbBlobStore', () =>
  IndexedDbBlobStore.open('test-blobs', new IDBFactory()),
);

it('keeps blobs across reopening the database', async () => {
  const factory = new IDBFactory();
  const first = await IndexedDbBlobStore.open('imp-blobs', factory);
  await first.put('a/b', { bytes: new Uint8Array([7, 8]), mediaType: 'image/webp' });
  first.close();
  const second = await IndexedDbBlobStore.open('imp-blobs', factory);
  expect([...((await second.get('a/b'))?.bytes ?? [])]).toEqual([7, 8]);
});
