import { describeKeyValueStoreContract } from '@imp/core/testing';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { IndexedDbKeyValueStore } from '../src/host/indexeddb-store.js';

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
