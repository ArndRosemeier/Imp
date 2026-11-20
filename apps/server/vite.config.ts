import { defineConfig } from 'vite';

// The server as one file with everything it needs inside, so that running it takes Node and nothing else.
export default defineConfig({
  build: {
    ssr: 'src/main.ts',
    outDir: 'dist/imp-server',
    target: 'node22',
    rolldownOptions: { output: { entryFileNames: 'imp.mjs' } },
  },
  ssr: { noExternal: true },
});
