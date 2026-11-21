// By path, so Vite bundles it into the config: Node itself cannot load the package's TypeScript.
import { releaseNotesPlugin } from '../../packages/release/src/vite.js';
import { defineConfig } from 'vite';

// The server as one file with everything it needs inside, so that running it takes Node and nothing else.
export default defineConfig({
  // The same version as the interface it serves; see apps/web/vite.config.ts.
  plugins: [
    releaseNotesPlugin({ cwd: import.meta.dirname, release: process.env['IMP_RELEASE'] === '1' }),
  ],
  build: {
    ssr: 'src/main.ts',
    outDir: 'dist/imp-server',
    target: 'node22',
    rolldownOptions: { output: { entryFileNames: 'imp.mjs' } },
  },
  ssr: { noExternal: true },
});
