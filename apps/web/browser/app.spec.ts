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

test('changes a model in Settings by tap or click, finding it by search', async ({
  page,
}, testInfo) => {
  const text = (id: string, name: string) => ({
    id,
    name,
    context_length: 100000,
    supported_parameters: ['tools'],
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    pricing: { prompt: '0.000001', completion: '0.000005' },
  });
  const video = (id: string, name: string) => ({
    id,
    name,
    context_length: 0,
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['video'] },
    pricing: { prompt: '0', completion: '0' },
  });
  // A stand-in OpenRouter with more models than a list shows at once.
  const agents = Array.from({ length: 30 }, (_, index) =>
    text(`maker/agent-${String(index).padStart(2, '0')}`, `Maker: Agent ${String(index)}`),
  );
  await page.route('https://openrouter.ai/**', (route) => {
    const url = route.request().url();
    if (url.includes('/videos/models')) {
      return route.fulfill({
        json: {
          data: ['studio/talkie', 'studio/silent-ish'].map((id, index) => ({
            id,
            supported_durations: [4, 8],
            supported_aspect_ratios: ['16:9'],
            supported_frame_images: ['first_frame'],
            generate_audio: index === 0 ? true : null,
          })),
        },
      });
    }
    if (url.includes('/models')) {
      return route.fulfill({
        json: {
          data: [
            ...agents,
            text('rare/hidden-gem', 'Rare: Hidden Gem'),
            video('studio/talkie', 'Studio: Talkie'),
            video('studio/silent-ish', 'Studio: Silent-ish'),
          ],
        },
      });
    }
    return route.fulfill({ json: { data: {} } });
  });
  const touch = testInfo.project.name === 'tablet';
  const press = async (locator: ReturnType<typeof page.locator>): Promise<void> => {
    await (touch ? locator.tap() : locator.click());
  };
  await page.goto('/');
  await page.getByLabel('OpenRouter API key').fill('sk-or-test');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByPlaceholder('Type to search').fill('maker/agent-00');
  await page.getByRole('button', { name: /Hire the coordinator/ }).click();
  await expect(page.locator('.topbar')).toBeVisible();
  await press(page.getByRole('button', { name: 'Settings', exact: true }));
  const models = page.getByRole('region', { name: 'Models' });

  // A video model, picked by tap; the list says which make their own sound.
  await press(models.getByLabel('Video model'));
  const talkie = models.getByRole('option', { name: /studio\/talkie/ });
  await expect(talkie).toContainText('makes its own sound');
  await page.screenshot({ path: testInfo.outputPath('settings-video-list.png') });
  await press(talkie);
  await expect(models.getByLabel('Video model')).toContainText('Talkie');
  await expect(models.getByRole('listbox')).toHaveCount(0);

  // An agent model beyond the first ones listed, found by searching for it.
  await press(models.getByLabel('Agents model'));
  await expect(models.getByText(/25 of 31 shown/)).toBeVisible();
  await models.getByRole('combobox', { name: 'Search for a model' }).fill('gem');
  await press(models.getByRole('option', { name: /rare\/hidden-gem/ }));
  await expect(models.getByLabel('Agents model')).toContainText('Hidden Gem');
  // The coordinator thinks with it now too.
  await press(page.getByRole('button', { name: 'Crew', exact: true }));
  await expect(page.getByText('rare/hidden-gem').first()).toBeVisible();
  await press(page.getByRole('button', { name: 'Settings', exact: true }));
  await expect(models.getByLabel('Agents model')).toContainText('Hidden Gem');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('settings-models.png'), fullPage: true });
});
