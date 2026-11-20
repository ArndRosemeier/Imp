import { MemoryBlobStore } from '../src/index.js';
import { describeBlobStoreContract } from '../src/testing.js';

describeBlobStoreContract('MemoryBlobStore', () => new MemoryBlobStore());
