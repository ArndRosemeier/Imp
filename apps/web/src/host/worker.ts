import { createImp, serveImp, type Port } from '@imp/host';
import { toJpeg } from './frame-image.js';
import { IndexedDbBlobStore, IndexedDbKeyValueStore } from './indexeddb-store.js';

// The core of the browser host: storage, providers, commands and agent runs,
// off the thread that draws the interface.
serveImp(
  async (secrets) =>
    createImp({
      store: await IndexedDbKeyValueStore.open('imp'),
      blobs: await IndexedDbBlobStore.open('imp-blobs'),
      secrets,
      frameImage: toJpeg,
    }),
  self as unknown as Port,
);
