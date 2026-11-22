import { createWebCodecsMp4Decoder, webCodecs } from '@imp/audio';
import { createImp, serveImp, type Port } from '@imp/host';
import release from 'virtual:imp-release';
import { createFilmRenderer } from './film-render.js';
import { createColorSampler, createFrameGrabber } from './frame-grab.js';
import { toJpeg } from './frame-image.js';
import { IndexedDbBlobStore, IndexedDbKeyValueStore } from './indexeddb-store.js';

// The core of the browser host: storage, providers, commands and agent runs,
// off the thread that draws the interface.
const codecs = webCodecs();
const frameGrabber = createFrameGrabber();
const colorSampler = createColorSampler();
serveImp(
  async (secrets) =>
    createImp({
      store: await IndexedDbKeyValueStore.open('imp'),
      blobs: await IndexedDbBlobStore.open('imp-blobs'),
      secrets,
      frameImage: toJpeg,
      release,
      runsOn: `browser: ${navigator.userAgent}`,
      filmRenderer: createFilmRenderer(),
      ...(frameGrabber === undefined ? {} : { frameGrabber }),
      ...(colorSampler === undefined ? {} : { colorSampler }),
      ...(codecs === undefined ? {} : { mp4Audio: createWebCodecsMp4Decoder(codecs) }),
    }),
  self as unknown as Port,
);
