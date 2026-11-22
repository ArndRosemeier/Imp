import react from '@vitejs/plugin-react';
// By path, so Vite bundles it into the config: Node itself cannot load the package's TypeScript.
import { releaseNotesPlugin } from '../../packages/release/src/vite.js';
import { readReleaseNotes } from '../../packages/release/src/git.js';
import { defineConfig, type Plugin } from 'vite';
import { workspaceGuides } from '../../packages/host/src/guide.js';
import { movieGuides } from '../../packages/mode-movie/src/guide.js';
import { docsSite } from './src/docs/site.js';

// The version and What's new, from git. Builds for main set IMP_RELEASE=1 and need the whole history.
const release = releaseNotesPlugin({
  cwd: import.meta.dirname,
  release: process.env['IMP_RELEASE'] === '1',
});

// The guide as a static docs site under docs/, built from the same pages as the Help panel.
const docs: Plugin = {
  name: 'imp-docs',
  apply: 'build',
  generateBundle() {
    for (const [fileName, source] of docsSite([...workspaceGuides, ...movieGuides])) {
      this.emitFile({ type: 'asset', fileName: `docs/${fileName}`, source });
    }
  },
};

// version.json beside the page, so an open or stored copy of Imp can ask whether a newer one is out.
const versionFile: Plugin = {
  name: 'imp-version-file',
  apply: 'build',
  generateBundle() {
    const notes = readReleaseNotes({
      cwd: import.meta.dirname,
      release: process.env['IMP_RELEASE'] === '1',
    });
    this.emitFile({
      type: 'asset',
      fileName: 'version.json',
      source: `${JSON.stringify({ version: notes.version, date: notes.date })}\n`,
    });
  },
};

export default defineConfig({
  plugins: [react(), release, docs, versionFile],
  // Relative asset paths, so the built files work from any folder of a static host.
  base: './',
  build: { target: 'es2023', sourcemap: true },
  // A module worker, so the audio decoders load as separate files only when a sound is first decoded.
  worker: { format: 'es', plugins: () => [release] },
});
