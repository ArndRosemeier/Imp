// Puts the built interface beside the built server, with a note on how to start it.
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'imp-server');
const web = join(root, '..', 'web', 'dist');

await rm(join(out, 'web'), { recursive: true, force: true });
// The download itself sits in the published site; it does not belong inside itself.
await cp(web, join(out, 'web'), { recursive: true, filter: (path) => !path.endsWith('.zip') });
// The fonts the film's texts are drawn in when the server renders a film (WOFF, Latin and extended Latin).
const require = createRequire(import.meta.url);
await rm(join(out, 'fonts'), { recursive: true, force: true });
await mkdir(join(out, 'fonts'));
for (const pkg of [
  '@fontsource/inter',
  '@fontsource/instrument-serif',
  '@fontsource/courier-prime',
]) {
  const files = join(dirname(require.resolve(`${pkg}/package.json`)), 'files');
  for (const file of await readdir(files)) {
    if (/-latin(-ext)?-\d+-(normal|italic)\.woff$/.test(file)) {
      await cp(join(files, file), join(out, 'fonts', file));
    }
  }
}

await writeFile(
  join(out, 'README.txt'),
  [
    'Imp, running on your computer',
    '',
    'You need Node.js 22 or newer: https://nodejs.org/',
    '',
    'Start it from this folder with:',
    '',
    '    node imp.mjs',
    '',
    'Then open http://localhost:4747/ in your browser.',
    '',
    'Imp uses ffmpeg to render films in the background and to hear the sound inside video clips.',
    'If it is not installed, Imp offers to download it the first time you export a film (or under',
    'Settings). Until then films are recorded in the browser.',
    '',
    'Your OpenRouter key is kept in the file secrets/openrouter-key in the data folder, readable',
    'only by your user account. The browser never holds it.',
    '',
    'This download is not signed. Started with "node imp.mjs" from a terminal nothing asks, but if',
    'your system warns about a file:',
    '  macOS: System Settings > Privacy & Security > Open Anyway (or Control-click the file > Open).',
    '  Windows: "Windows protected your PC" > More info > Run anyway (or zip Properties > Unblock).',
    '  Linux: nothing to confirm; make a file runnable with chmod +x if needed.',
    '',
    'Your projects and media are kept in the folder "Imp" in your home folder.',
    'Choose another folder with --data <folder>, another port with --port <number>.',
    'Imp answers only on this computer and is not reachable from the network.',
    '',
  ].join('\n'),
);
