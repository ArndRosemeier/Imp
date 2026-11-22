import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The app tests walk whole workflows through the UI; on a busy CI runner one can pass 5 s.
    testTimeout: 20_000,
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/web/src/host/**/*.ts', 'apps/server/src/**/*.ts'],
      // Entry points only wire things together; what they wire is tested.
      // Rendering with WebCodecs needs a real browser: it is checked in
      // Chromium (see docs/adr/0007-films-render-offline-in-the-browser.md), not in Node.
      exclude: ['**/index.ts', 'apps/server/src/main.ts', 'apps/web/src/host/film-render.ts'],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
