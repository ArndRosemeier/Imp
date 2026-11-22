import { defineConfig, devices } from '@playwright/test';

/**
 * The slow suite: Imp in a real Chromium, at desktop size and on a landscape tablet.
 * It runs by hand (Actions → Slow checks) and nightly, not on every pull request.
 * Run it locally with `pnpm test:slow` from the repository root.
 */
const PORT = 4179;

export default defineConfig({
  testDir: '.',
  outputDir: '../test-results',
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: process.env['CI'] !== undefined,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['github']],
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      // Imp supports landscape tablets, by touch; phones are not supported.
      name: 'tablet',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1180, height: 820 },
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: `pnpm exec vite --port ${String(PORT)} --strictPort`,
    cwd: '..',
    port: PORT,
    reuseExistingServer: process.env['CI'] === undefined,
    timeout: 60_000,
  },
});
