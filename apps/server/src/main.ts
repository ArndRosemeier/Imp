import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImp } from '@imp/host';
import release from 'virtual:imp-release';
import { createFfmpegFilmRenderer } from './ffmpeg-film.js';
import { ffmpegServices, openFfmpegTool } from './ffmpeg-tool.js';
import { createFileSecretStore } from './file-secrets.js';
import { FileBlobStore, FileKeyValueStore } from './file-store.js';
import { createImpServer } from './server.js';

function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

if (process.argv.includes('--help')) {
  console.log(
    [
      `Imp ${release.version}, running on this computer.`,
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
// ffmpeg is optional: the one on this computer, or one Imp downloads into its data folder when asked.
const ffmpeg = await openFfmpegTool({ folder: join(dataDir, 'tools') });

// Films are put together here and encoded by ffmpeg; their texts use the fonts shipped beside imp.mjs.
const filmRenderer = createFfmpegFilmRenderer({
  command: () => ffmpeg.command(),
  font: (file) => {
    try {
      return new Uint8Array(readFileSync(join(here, 'fonts', file)));
    } catch {
      return undefined;
    }
  },
});

const server = createImpServer({
  webDir: join(here, 'web'),
  // The key is kept here, outside the projects, and never handed to the browser.
  secrets: createFileSecretStore(join(dataDir, 'secrets', 'openrouter-key')),
  open: async (secrets) =>
    createImp({
      store: await FileKeyValueStore.open(join(dataDir, 'data.jsonl')),
      blobs: await FileBlobStore.open(join(dataDir, 'media')),
      secrets,
      release,
      runsOn: `local server, Node ${process.version} on ${process.platform}${ffmpeg.command() === null ? ', without ffmpeg' : ', with ffmpeg'}`,
      filmRenderer,
      ffmpeg,
      ...ffmpegServices(ffmpeg),
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
  console.log(
    `Imp ${release.version} is running. Open http://localhost:${String(port)}/ in your browser.`,
  );
  console.log(`Your projects are kept in ${dataDir}`);
  if (ffmpeg.command() === null) {
    console.log(
      'ffmpeg was not found. Imp offers to download it when you export a film (or under Settings). Until then films are recorded in the browser and the sound inside video clips stays silent.',
    );
  }
  console.log('Press Ctrl+C to stop.');
});
