import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type * as Movie from '@imp/mode-movie';
import type * as FilmRender from '../src/host/film-render.js';

const moviePath = `/@fs${resolve(import.meta.dirname, '../../../packages/mode-movie/src/index.ts')}`;

// The film renderer encodes with WebCodecs, which Node does not have, so the
// Vitest suite leaves it out (see docs/adr/0007-films-render-offline-in-the-browser.md).
// Here it renders for real: a title card, then a film that cuts that render in as a clip.
test('renders a film with WebCodecs and reads it back as a clip', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async (moviePath) => {
    // Vite serves the sources, so the page can load the renderer as the worker does.
    const renderPath = '/src/host/film-render.ts';
    const { createFilmRenderer } = (await import(
      /* @vite-ignore */ renderPath
    )) as typeof FilmRender;
    const { DEFAULT_TEXT_STYLES } = (await import(/* @vite-ignore */ moviePath)) as typeof Movie;
    const title = DEFAULT_TEXT_STYLES.find((style) => style.id === 'title');
    if (title === undefined) throw new Error('no title style');
    const renderer = createFilmRenderer();
    const unavailable = renderer.unavailable();
    if (unavailable !== null) throw new Error(unavailable);

    const render = async (
      plan: Parameters<typeof renderer.render>[0]['plan'],
      clips: Record<string, Uint8Array>,
    ) => {
      let file = new Uint8Array(0);
      let progress = 0;
      const rendered = await renderer.render({
        plan,
        clip: (key) => Promise.resolve(clips[key]),
        mix: (_start, frames) => {
          const tone = new Float32Array(frames).map((_, i) => Math.sin(i / 10) * 0.2);
          return Promise.resolve([tone, tone] as const);
        },
        write: (data, position) => {
          if (position + data.length > file.length) {
            const grown = new Uint8Array(position + data.length);
            grown.set(file);
            file = grown;
          }
          file.set(data, position);
          return Promise.resolve();
        },
        progress: (seconds) => {
          progress = seconds;
        },
        cancelled: () => false,
      });
      return { rendered, file, progress };
    };

    const card = await render(
      {
        durationSeconds: 2,
        height: 360,
        fps: 24,
        pictures: [
          {
            kind: 'title',
            startSeconds: 0,
            durationSeconds: 2,
            text: 'Storm',
            style: title,
            fadeInSeconds: 0.25,
            fadeOutSeconds: 0,
          },
        ],
      },
      {},
    );
    const film = await render(
      {
        durationSeconds: 3,
        height: null,
        fps: null,
        pictures: [
          {
            kind: 'clip',
            startSeconds: 0,
            durationSeconds: 2,
            blobKey: 'card',
            sourceStartSeconds: 0,
            fadeInSeconds: 0,
            fadeOutSeconds: 0,
          },
          {
            kind: 'title',
            startSeconds: 1.5,
            durationSeconds: 1.5,
            text: 'The end',
            style: title,
            fadeInSeconds: 0,
            fadeOutSeconds: 0.5,
            transitionIn: { kind: 'dissolve', seconds: 0.5 },
          },
        ],
      },
      { card: card.file },
    );
    return {
      card: { ...card.rendered, bytes: card.file.length, progress: card.progress },
      film: { ...film.rendered, bytes: film.file.length, progress: film.progress },
    };
  }, moviePath);
  expect(result.card).toMatchObject({ height: 360, fps: 24, mediaType: 'video/mp4' });
  expect(result.card.bytes).toBeGreaterThan(1000);
  expect(result.card.progress).toBeCloseTo(2, 1);
  // The film takes its size and rate from the clip it cuts in.
  expect(result.film).toMatchObject({ width: result.card.width, height: 360, fps: 24 });
  expect(result.film.bytes).toBeGreaterThan(1000);
  expect(result.film.progress).toBeCloseTo(3, 1);
});
