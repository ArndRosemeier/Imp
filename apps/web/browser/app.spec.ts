import { expect, test } from '@playwright/test';

test('opens on setup without errors, and fits the screen', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.getByLabel('OpenRouter API key')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
  expect(errors).toEqual([]);
});

test('switches the first screen to German, which still fits the screen', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('radio', { name: 'Deutsch' }).click();
  await expect(page.getByRole('heading', { name: 'OpenRouter verbinden' })).toBeVisible();
  await expect(page.getByLabel('OpenRouter-API-Schlüssel')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('de');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
  // The choice is kept across a reload.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'OpenRouter verbinden' })).toBeVisible();
});

test('keeps the top bar below an iPad status bar, where taps reach the buttons', async ({
  page,
}) => {
  // A stand-in OpenRouter, so the test reaches the workspace without a key.
  await page.route('https://openrouter.ai/**', (route) => {
    const url = route.request().url();
    if (url.includes('/videos/models')) return route.fulfill({ json: { data: [] } });
    if (url.includes('/models')) {
      return route.fulfill({
        json: {
          data: [
            {
              id: 'test/agent',
              name: 'Test agent',
              context_length: 100000,
              supported_parameters: ['tools'],
              architecture: { input_modalities: ['text'], output_modalities: ['text'] },
              pricing: { prompt: '0', completion: '0' },
            },
          ],
        },
      });
    }
    return route.fulfill({ json: { data: {} } });
  });
  await page.goto('/');
  await page.getByLabel('OpenRouter API key').fill('sk-or-test');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByPlaceholder('Type to search').fill('test/agent');
  await page.getByRole('button', { name: /Hire the coordinator/ }).click();
  await expect(page.locator('.topbar')).toBeVisible();
  // An installed copy on an iPad reports a 24 pixel status bar through
  // env(safe-area-inset-top); Chromium cannot emulate it, so set what it feeds.
  await page.addStyleTag({ content: '.shell { --safe-top: 24px !important; }' });
  const tops = await page.evaluate(() =>
    [...document.querySelectorAll('.topbar > button, .topbar > * > button')]
      .map((element) => element.getBoundingClientRect())
      .filter((box) => box.height > 0)
      .map((box) => box.top),
  );
  expect(tops.length).toBeGreaterThan(3);
  for (const top of tops) expect(top).toBeGreaterThanOrEqual(24);
});
