import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImp } from '@imp/host';
import { createFfmpegMp4Decoder, hasFfmpeg } from './ffmpeg-audio.js';
import { createFfmpegColorSampler, createFfmpegFrameGrabber } from './ffmpeg-frames.js';
import { FileBlobStore, FileKeyValueStore } from './file-store.js';
import { createImpServer } from './server.js';

function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

if (process.argv.includes('--help')) {
  console.log(
    [
      'Imp, running on this computer.',
      '',
      '  node imp.mjs [--port 4747] [--data <folder>]',
      '',
      '  --port  The port to answer on. Default 4747.',
      '  --data  Where projects and media are kept. Default: the folder "Imp" in your home folder.',
    ].join('\n'),
  );
  process.exit(0);
}

const port = Number(option('port') ?? 4747);
const dataDir = resolve(option('data') ?? join(homedir(), 'Imp'));
const here = dirname(fileURLToPath(import.meta.url));
// The sound inside video clips is AAC, which only a native decoder reads.
const ffmpeg = await hasFfmpeg();

const server = createImpServer({
  webDir: join(here, 'web'),
  open: async (secrets) =>
    createImp({
      store: await FileKeyValueStore.open(join(dataDir, 'data.jsonl')),
      blobs: await FileBlobStore.open(join(dataDir, 'media')),
      secrets,
      ...(ffmpeg
        ? {
            mp4Audio: createFfmpegMp4Decoder(),
            frameGrabber: createFfmpegFrameGrabber(),
            colorSampler: createFfmpegColorSampler(),
          }
        : {}),
    }),
});
server.on('error', (error: Error & { code?: string }) => {
  console.error(
    error.code === 'EADDRINUSE'
      ? `Port ${String(port)} is taken. Is Imp already running? Otherwise choose another with --port.`
      : `Imp could not start: ${error.message}`,
  );
  process.exit(1);
});
// This computer only: the server is never reachable from the network.
server.listen(port, '127.0.0.1', () => {
  console.log(`Imp is running. Open http://localhost:${String(port)}/ in your browser.`);
  console.log(`Your projects are kept in ${dataDir}`);
  if (!ffmpeg) {
    console.log(
      'ffmpeg was not found, so the sound inside video clips stays silent and agents see no stills of the cut. Install it for both.',
    );
  }
  console.log('Press Ctrl+C to stop.');
});
