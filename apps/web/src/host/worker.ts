import { createImp } from './imp.js';
import { IndexedDbBlobStore, IndexedDbKeyValueStore } from './indexeddb-store.js';
import type { Port } from './port.js';
import { serveImp } from './serve.js';

// The core of the browser host: storage, providers, commands and agent runs,
// off the thread that draws the interface.
serveImp(
  async (secrets) =>
    createImp({
      store: await IndexedDbKeyValueStore.open('imp'),
      blobs: await IndexedDbBlobStore.open('imp-blobs'),
      secrets,
    }),
  self as unknown as Port,
);
