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
