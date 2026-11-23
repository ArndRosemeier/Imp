// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { clipOptionInput, DEFAULT_CLIP_OPTIONS } from '../src/app/shots.js';
import { DEFAULT_EXPORT_OPTIONS, exportOptionInput } from '../src/app/ExportBar.js';
import { chooseModel, completeSetup, start, setUpAppTests } from './app-harness.js';

setUpAppTests();

/**
 * What agents can change, people can change in the app too: the controls that
 * closed the gaps found on 2026-11-23. ui-parity.test.ts keeps new ones from opening.
 */
describe('App: what agents can change, people can change', () => {
  it('sends only the clip and export options that differ from the defaults', () => {
    expect(clipOptionInput(DEFAULT_CLIP_OPTIONS)).toEqual({});
    expect(
      clipOptionInput({
        ...DEFAULT_CLIP_OPTIONS,
        durationSeconds: 6,
        aspectRatio: '9:16',
        audio: false,
        startFrame: false,
      }),
    ).toEqual({ durationSeconds: 6, aspectRatio: '9:16', audio: false, startFrame: false });
    expect(exportOptionInput(DEFAULT_EXPORT_OPTIONS)).toEqual({});
    expect(
      exportOptionInput({ resolution: '1080p', fps: 25, label: ' rough-cut-2 ', subtitles: false }),
    ).toEqual({ resolution: '1080p', fps: 25, label: 'rough-cut-2', subtitles: false });
  });

  it('makes a silent, upright clip when the person asks for one', async () => {
    const { provider, user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Development' }));
    await user.type(await screen.findByLabelText('Working title'), 'The Lighthouse Keeper');
    await user.click(screen.getByRole('button', { name: /Start the movie/ }));
    await screen.findByLabelText('Logline');
    await user.click(screen.getByRole('button', { name: 'Script' }));
    await user.click(await screen.findByRole('button', { name: /Add scene/ }));
    await user.type(await screen.findByLabelText('Scene heading'), 'INT. LAMP ROOM - NIGHT');
    await user.tab();

    await user.click(screen.getByRole('button', { name: 'Shots' }));
    await user.click(await screen.findByRole('button', { name: /Add shot/ }));
    const card = await screen.findByRole('article', { name: 'Shot 1' });
    await chooseModel(user, await screen.findByLabelText('Video model'), 'vendor/clips');
    await user.type(within(card).getByLabelText('What we see'), 'The lamp turns.');
    await user.tab();

    await user.click(within(card).getByText('Clip options'));
    await user.click(within(card).getByRole('checkbox', { name: 'With its own sound' }));
    await user.selectOptions(within(card).getByLabelText('Aspect ratio'), '9:16');
    await user.selectOptions(within(card).getByLabelText('Length (s)'), '6');
    expect(within(card).getByText('silent')).toBeTruthy();
    const generate = within(card).getByRole('button', { name: /Generate clip/ });
    await vi.waitFor(() => {
      expect(generate).toHaveProperty('disabled', false);
    });
    await user.click(generate);
    await vi.waitFor(() => {
      expect(provider.videoRequests[0]).toMatchObject({
        audio: false,
        aspectRatio: '9:16',
        durationSeconds: 6,
      });
    });
  });

  it('changes a crew member’s name and budget, and what a project goes without', async () => {
    const { imp, user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Development' }));
    await user.type(await screen.findByLabelText('Working title'), 'Squall');
    await user.click(screen.getByRole('button', { name: /Start the movie/ }));
    await screen.findByLabelText('Logline');

    await user.click(screen.getByRole('button', { name: 'Crew' }));
    await user.click(await screen.findByRole('button', { name: /Hire Screenwriter/ }));
    await user.click(await screen.findByRole('button', { name: 'Change Screenwriter' }));
    const form = await screen.findByRole('form', { name: 'Change Screenwriter' });
    const name = within(form).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Mara');
    const budget = within(form).getByLabelText('Most per run (US$)');
    await user.clear(budget);
    await user.type(budget, '2.5');
    await user.click(within(form).getByRole('button', { name: 'Done' }));
    await vi.waitFor(async () => {
      const crew = await imp.registry.executeById(
        'crew.list',
        {},
        { actor: { kind: 'user', id: 'arnd' } },
      );
      const members = (crew.status === 'ok' ? crew.output : { crew: [] }) as {
        crew: { name: string; budgetUsdPerRun: number }[];
      };
      expect(members.crew).toContainEqual(
        expect.objectContaining({ name: 'Mara', budgetUsdPerRun: 2.5 }),
      );
    });

    const section = await screen.findByRole('region', {
      name: 'What the crew needs in this project',
    });
    const cast = within(section).getByText('A cast').closest('li') as HTMLElement;
    await user.click(within(cast).getByRole('checkbox', { name: 'Goes without' }));
    expect(await within(cast).findByText('Goes without', { selector: '.tag' })).toBeTruthy();
  });

  it('switches agent drafts, edits a number setting and keeps the theme where agents can change it', async () => {
    const { imp, user } = start();
    await completeSetup(user);
    const actor = { kind: 'user', id: 'arnd' } as const;
    await imp.registry.executeById('settings.set', { key: 'shots.per-scene', value: 4 }, { actor });

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const drafts = await screen.findByRole('checkbox', {
      name: /Agents’ changes to the cut wait as a draft/,
    });
    await vi.waitFor(() => {
      expect(drafts).toHaveProperty('checked', true);
    });
    await user.click(drafts);
    await vi.waitFor(async () => {
      expect(await imp.store.get('settings/edit.agent-drafts')).toBe(false);
    });

    const number = await screen.findByRole('spinbutton', { name: 'Shots per scene' });
    await user.clear(number);
    await user.type(number, '6');
    await user.tab();
    await vi.waitFor(async () => {
      expect(await imp.store.get('settings/shots.per-scene')).toBe(6);
    });

    const before = document.documentElement.dataset['theme'];
    const next = before === 'dark' ? 'light' : 'dark';
    await imp.registry.executeById('settings.set', { key: 'ui.theme', value: next }, { actor });
    await vi.waitFor(() => {
      expect(document.documentElement.dataset['theme']).toBe(next);
    });
  });

  it('leaves and removes markers in the Audio editor', async () => {
    const { user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Development' }));
    await user.type(await screen.findByLabelText('Working title'), 'Squall');
    await user.click(screen.getByRole('button', { name: /Start the movie/ }));
    await screen.findByLabelText('Logline');
    await user.click(screen.getByRole('button', { name: 'Audio' }));
    await user.type(await screen.findByLabelText('Name'), 'Lamp room');
    await user.click(screen.getByRole('button', { name: /Start empty/ }));
    await screen.findByRole('tab', { name: 'Lamp room' });

    await user.click(screen.getByRole('button', { name: 'Add a marker at the playhead' }));
    const remove = await screen.findByRole('button', { name: 'Remove marker Marker 1' });
    await user.click(remove);
    await vi.waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Remove marker Marker 1' })).toBeNull();
    });
  });
});
