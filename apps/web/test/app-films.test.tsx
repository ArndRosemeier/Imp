// @vitest-environment jsdom
import type { FilmExport, FilmRenderer } from '@imp/mode-movie';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { filmCardPlaces, filmsMentioned } from '../src/app/film-mentions.js';
import { completeSetup, setUpAppTests, start } from './app-harness.js';

setUpAppTests();

const renderer: FilmRenderer = {
  unavailable: () => null,
  render: async (job) => {
    await job.write(new Uint8Array([1, 2, 3, 4]), 0);
    return {
      mediaType: 'video/mp4',
      extension: 'mp4',
      videoCodec: 'avc',
      audioCodec: 'aac',
      width: 1280,
      height: 720,
      fps: 24,
    };
  },
};

const film = (id: string, fileName: string, status: FilmExport['status'] = 'ready') =>
  ({ id, fileName, status }) as FilmExport;

describe('films named in a conversation', () => {
  it('finds ready films by id or file name, the newest of a shared name', () => {
    const films = [
      film('f3', 'Storm-film.mp4'),
      film('f2', 'Storm-film.mp4'),
      film('f1', 'Storm-cut.mp4', 'failed'),
    ];
    expect(filmsMentioned('Done: Storm-film.mp4', films).map((f) => f.id)).toEqual(['f3']);
    expect(filmsMentioned('{"id":"f2"}', films).map((f) => f.id)).toEqual(['f2']);
    expect(filmsMentioned('Storm-cut.mp4 is done', films)).toEqual([]);
    expect(filmsMentioned('', films)).toEqual([]);
  });

  it('puts each card under the last message that names its film', () => {
    const films = [film('f1', 'Storm-film.mp4')];
    const places = filmCardPlaces(['', '{"id":"f1"}', 'nothing', 'Storm-film.mp4 is ready'], films);
    expect([...places.keys()]).toEqual([3]);
  });
});

async function movieWithATitle(started: ReturnType<typeof start>): Promise<string> {
  const { imp, user } = started;
  await completeSetup(user);
  await user.click(screen.getByRole('button', { name: 'Development' }));
  await user.type(await screen.findByLabelText('Working title'), 'Storm');
  await user.click(screen.getByRole('button', { name: /Start the movie/ }));
  await screen.findByLabelText('Logline');
  const projectId = (await imp.store.get('settings/project.current')) as string;
  const actor = { kind: 'user', id: 'local' } as const;
  const scene = await imp.registry.executeById(
    'movie.scene.create',
    { projectId, heading: 'EXT. CLIFF' },
    { actor },
  );
  if (scene.status !== 'ok') throw new Error('no scene');
  await imp.registry.executeById(
    'movie.edit.title.add',
    { projectId, sceneId: (scene.output as { id: string }).id, text: 'Storm' },
    { actor },
  );
  return projectId;
}

describe('App: films an agent makes', () => {
  it('shows the film under the reply, with a notice, and keeps it in the library', async () => {
    const started = start([], undefined, renderer);
    const { provider, user } = started;
    const projectId = await movieWithATitle(started);
    // The Film Editor has every command of its own as a tool.
    const input = { projectId };
    provider.script(
      {
        toolCalls: [
          {
            id: 'x1',
            name: 'movie__edit__export',
            arguments: input,
            argumentsText: JSON.stringify(input),
          },
        ],
      },
      { content: 'Your film **Storm-film.mp4** is ready.' },
    );
    // Exporting is the Film Editor's work, not the coordinator's.
    await user.click(screen.getByRole('button', { name: 'Crew' }));
    await user.click(await screen.findByRole('button', { name: /Hire Film Editor/ }));
    // The agents' model sees no pictures, which the Film Editor needs: only fitting ones are offered.
    expect(await screen.findByText(/needs a model that takes pictures/)).toBeTruthy();
    await user.click(screen.getByLabelText('Hire with a model that fits'));
    const offered = await screen.findByRole('listbox', { name: 'Models found' });
    expect(within(offered).queryByRole('option', { name: /vendor\/writer/ })).toBeNull();
    await user.click(await within(offered).findByRole('option', { name: /vendor\/seer/ }));
    await user.selectOptions(await screen.findByLabelText('Talking to'), 'Film Editor');
    await user.type(screen.getByLabelText('Message to Film Editor'), 'Make a film of the shots.');
    await user.click(screen.getByRole('button', { name: /Send/ }));

    // A card under the reply plays and saves it.
    const panel = screen.getByRole('complementary', { name: /Conversation with Film Editor/ });
    const card = await within(panel).findByRole('article', { name: 'Storm-film.mp4' });
    expect(within(card).getByText(/by Film Editor · 0:03 · 1280×720 24 fps/)).toBeTruthy();
    await user.click(within(card).getByRole('button', { name: /Play/ }));
    await vi.waitFor(() => {
      expect(card.querySelector('video')?.getAttribute('src')).toMatch(/^blob:/);
    });

    // A notice says it is done; Watch opens the library on its films.
    const notice = await screen.findByText('Film Editor finished a film');
    const box = notice.closest<HTMLElement>('.film-notice');
    if (box === null) throw new Error('no notice');
    await user.click(within(box).getByRole('button', { name: /Watch/ }));
    const library = await screen.findByRole('complementary', { name: 'Library' });
    expect(
      within(library)
        .getByRole('tab', { name: /Films, 1/ })
        .getAttribute('aria-selected'),
    ).toBe('true');
    const shelved = await within(library).findByRole('article', { name: 'Storm-film.mp4' });
    await vi.waitFor(() => {
      expect(shelved.querySelector('video')).not.toBeNull();
    });
    expect(screen.queryByText('Coordinator finished a film')).toBeNull();
  });
});
