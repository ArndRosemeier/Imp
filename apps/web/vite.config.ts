import react from '@vitejs/plugin-react';
// By path, so Vite bundles it into the config: Node itself cannot load the package's TypeScript.
import { releaseNotesPlugin } from '../../packages/release/src/vite.js';
import { defineConfig } from 'vite';

// The version and What's new, from git. Builds for main set IMP_RELEASE=1 and need the whole history.
const release = releaseNotesPlugin({
  cwd: import.meta.dirname,
  release: process.env['IMP_RELEASE'] === '1',
});

export default defineConfig({
  plugins: [react(), release],
  // Relative asset paths, so the built files work from any folder of a static host.
  base: './',
  build: { target: 'es2023', sourcemap: true },
  // A module worker, so the audio decoders load as separate files only when a sound is first decoded.
  worker: { format: 'es', plugins: () => [release] },
});
