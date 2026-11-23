// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { encodeWav } from '@imp/audio';
import { chooseModel, completeSetup, start, setUpAppTests } from './app-harness.js';

setUpAppTests();

describe('App: library, crew and help', () => {
  it('keeps every asset in one library: import, search, tag, and place a sound in the audio editor', async () => {
    const { imp, user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Development' }));
    await user.type(await screen.findByLabelText('Working title'), 'The Lighthouse Keeper');
    await user.click(screen.getByRole('button', { name: /Start the movie/ }));
    await user.type(await screen.findByLabelText('Logline'), 'A keeper and a storm.');
    await user.tab();

    await user.click(screen.getByRole('button', { name: 'Library' }));
    const library = await screen.findByRole('complementary', { name: 'Library' });
    expect(
      await within(library).findByRole('button', { name: /Logline, Development/ }),
    ).toBeTruthy();

    // A second of silence, as a WAV file the person picks.
    const wav = encodeWav({ sampleRate: 8000, channels: [new Float32Array(8000)] });
    const file = new File([wav.slice()], 'Door slam.wav', { type: 'audio/wav' });
    await user.upload(within(library).getByLabelText('Files to import'), file);
    // A single import opens the new asset.
    const detail = await within(library).findByRole('region', { name: 'Door slam, details' });
    await user.type(within(detail).getByLabelText('Tags'), 'foley{Enter}');
    expect(await within(detail).findByText('foley')).toBeTruthy();
    await user.click(within(detail).getByRole('button', { name: /All assets/ }));

    await user.type(within(library).getByLabelText('Search the library'), 'foley');
    await vi.waitFor(() => {
      expect(within(library).queryByRole('button', { name: /Logline/ })).toBeNull();
    });
    expect(within(library).getByRole('button', { name: /Door slam, Imported sound/ })).toBeTruthy();

    // Nothing on the Development stage takes a sound.
    await user.click(within(library).getByRole('button', { name: /Door slam, Imported sound/ }));
    await user.click(await within(library).findByRole('button', { name: /Use in/ }));
    expect(within(library).getByText(/Nothing on this screen takes a sound/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Audio' }));
    await user.type(await within(screen.getByRole('main')).findByLabelText('Name'), 'Lamp room');
    await user.click(screen.getByRole('button', { name: /Start empty/ }));
    expect(await screen.findByText('1 track')).toBeTruthy();
    // Closed and opened again, the menu offers the editor that is open now.
    await user.click(within(library).getByRole('button', { name: /Use in/ }));
    await user.click(within(library).getByRole('button', { name: /Use in/ }));
    await user.click(
      await within(library).findByRole('button', { name: 'Lamp room, Track 1, at the playhead' }),
    );
    expect((await screen.findAllByText('Place sound')).length).toBeGreaterThan(0);

    const projectId = (
      (await imp.registry.executeById(
        'settings.get',
        { key: 'project.current' },
        { actor: { kind: 'user', id: 't' } },
      )) as { output: { value: string } }
    ).output.value;
    const listed = (await imp.registry.executeById(
      'library.list',
      { projectId, modality: 'sound', kind: 'imported-sound' },
      { actor: { kind: 'user', id: 't' } },
    )) as { output: { assets: { tags: string[] }[] } };
    expect(listed.output.assets.map((asset) => asset.tags)).toEqual([['foley']]);
    const docs = (await imp.registry.executeById(
      'audio.doc.list',
      { projectId },
      { actor: { kind: 'user', id: 't' } },
    )) as { output: { documents: { id: string }[] } };
    const doc = (await imp.registry.executeById(
      'audio.doc.get',
      { projectId, docId: docs.output.documents[0]?.id },
      { actor: { kind: 'user', id: 't' } },
    )) as { output: { document: { tracks: { regions: { label: string }[] }[] } } };
    expect(doc.output.document.tracks[0]?.regions.map((region) => region.label)).toEqual([
      'Door slam',
    ]);
  });

  it('places a sound from the library on the Edit stage, making it a sound of the scene', async () => {
    const { imp, user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Development' }));
    await user.type(await screen.findByLabelText('Working title'), 'The Lighthouse Keeper');
    await user.click(screen.getByRole('button', { name: /Start the movie/ }));
    await screen.findByLabelText('Logline');
    await user.click(screen.getByRole('button', { name: 'Script' }));
    await user.click(await screen.findByRole('button', { name: /Add scene/ }));
    await screen.findByLabelText('Scene heading');

    await user.click(screen.getByRole('button', { name: /^Edit$/ }));
    await user.click(screen.getByRole('button', { name: 'Library' }));
    const library = await screen.findByRole('complementary', { name: 'Library' });
    const wav = encodeWav({ sampleRate: 8000, channels: [new Float32Array(8000)] });
    await user.upload(
      within(library).getByLabelText('Files to import'),
      new File([wav.slice()], 'Gull.wav', { type: 'audio/wav' }),
    );
    const detail = await within(library).findByRole('region', { name: 'Gull, details' });
    await user.click(within(detail).getByRole('button', { name: /Use in/ }));
    await user.click(
      await within(detail).findByRole('button', {
        name: 'Edit stage, audio lane, at the playhead',
      }),
    );

    const actor = { actor: { kind: 'user', id: 't' } } as const;
    const projectId = (
      (await imp.registry.executeById('settings.get', { key: 'project.current' }, actor)) as {
        output: { value: string };
      }
    ).output.value;
    const scenes = (await imp.registry.executeById('movie.scene.list', { projectId }, actor)) as {
      output: { scenes: { id: string }[] };
    };
    const sceneId = scenes.output.scenes[0]?.id;
    await vi.waitFor(async () => {
      const sounds = (await imp.registry.executeById(
        'movie.sound.list',
        { projectId, sceneId },
        actor,
      )) as { output: { sounds: { name: string }[] } };
      expect(sounds.output.sounds.map((sound) => sound.name)).toEqual(['Gull']);
      const cut = (await imp.registry.executeById(
        'movie.edit.get',
        { projectId, sceneId },
        actor,
      )) as {
        output: { sounds: unknown[] };
      };
      expect(cut.output.sounds).toHaveLength(1);
    });
  });

  it('keeps crews in the library under a name and loads them back', async () => {
    const { imp, user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Development' }));
    await user.type(await screen.findByLabelText('Working title'), 'The Lighthouse Keeper');
    await user.click(screen.getByRole('button', { name: /Start the movie/ }));
    await screen.findByLabelText('Logline');
    const actor = { actor: { kind: 'user', id: 't' } } as const;
    await imp.registry.executeById(
      'crew.hire',
      { roleId: 'screenwriter', model: 'm/a', name: 'Ada' },
      actor,
    );

    await user.click(screen.getByRole('button', { name: 'Library' }));
    const library = await screen.findByRole('complementary', { name: 'Library' });
    await user.click(within(library).getByRole('tab', { name: 'Crews, 0' }));
    expect(await within(library).findByText(/No saved crews yet/)).toBeTruthy();
    await user.type(within(library).getByLabelText(/Save the current crew/), 'Core team');
    await user.click(within(library).getByRole('button', { name: /Save/ }));
    const cards = await within(library).findByRole('list', { name: 'Saved crews' });
    expect(await within(cards).findByRole('heading', { name: 'Core team' })).toBeTruthy();
    expect(within(library).getByRole('tab', { name: 'Crews, 1' })).toBeTruthy();

    const crew = async () =>
      (
        (await imp.registry.executeById('crew.list', {}, actor)) as {
          output: { crew: { name: string }[] };
        }
      ).output.crew
        .map((member) => member.name)
        .sort();
    const before = await crew();
    await imp.registry.executeById(
      'crew.hire',
      { roleId: 'screenwriter', model: 'm/b', name: 'Bo' },
      actor,
    );
    await user.click(within(cards).getByRole('button', { name: /Load/ }));
    const confirm = await within(cards).findByRole('group', { name: 'Replace the crew' });
    expect(within(confirm).getByText(/Dismiss Ada, Bo/)).toBeTruthy();
    await user.click(within(confirm).getByRole('button', { name: 'Replace' }));
    await vi.waitFor(async () => {
      expect(await crew()).toEqual(before);
    });

    await user.click(within(cards).getByRole('button', { name: 'Rename Core team' }));
    const name = within(cards).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Drama team');
    await user.click(within(cards).getByRole('button', { name: 'Save' }));
    expect(await within(cards).findByRole('heading', { name: 'Drama team' })).toBeTruthy();
    await user.click(within(cards).getByRole('button', { name: /Add to crew/ }));
    await vi.waitFor(async () => {
      expect(await crew()).toHaveLength(before.length * 2 - 1);
    });
    await user.click(
      within(cards).getByRole('button', { name: 'Update Drama team with the current crew' }),
    );
    await user.click(within(cards).getByRole('button', { name: 'Delete Drama team' }));
    await user.click(within(cards).getByRole('button', { name: 'Delete' }));
    expect(await within(library).findByText(/No saved crews yet/)).toBeTruthy();
  });

  it('keeps the models under a name, switches back to them from a stage chip and the library', async () => {
    const { imp, user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Development' }));
    await user.type(await screen.findByLabelText('Working title'), 'The Lighthouse Keeper');
    await user.click(screen.getByRole('button', { name: /Start the movie/ }));
    await screen.findByLabelText('Logline');
    await user.click(screen.getByRole('button', { name: 'Design' }));

    // The chip opens by itself while a model is missing, and folds once it is chosen.
    const bar = await screen.findByRole('region', { name: 'Models' });
    const chip = within(bar).getByRole('button', { name: /Choose image model/ });
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    await chooseModel(user, within(bar).getByLabelText('Image model'), 'vendor/painter');
    await vi.waitFor(() => {
      expect(chip.getAttribute('aria-expanded')).toBe('false');
    });
    expect(chip.textContent).toContain('painter');

    await user.click(chip);
    await user.click(within(bar).getByRole('button', { name: /Save all models as a mix/ }));
    await user.type(within(bar).getByLabelText('Name of the mix'), 'Drafts');
    await user.click(within(bar).getByRole('button', { name: 'Save' }));
    expect(await within(bar).findByText(/Saved “Drafts”/)).toBeTruthy();
    await vi.waitFor(() => {
      expect(chip.textContent).toContain('Drafts');
    });

    // Another model in use: the chip says the mix was changed, and the mix brings it back.
    const actor = { actor: { kind: 'user', id: 't' } } as const;
    await imp.registry.executeById(
      'settings.set',
      { key: 'images.model', value: '~vendor/latest' },
      actor,
    );
    expect(await within(bar).findByText('changed')).toBeTruthy();
    await user.click(within(bar).getByRole('button', { name: /Drafts/, pressed: true }));
    await vi.waitFor(() => {
      expect(within(bar).queryByText('changed')).toBeNull();
    });

    await user.click(screen.getByRole('button', { name: 'Library' }));
    const library = await screen.findByRole('complementary', { name: 'Library' });
    await user.click(within(library).getByRole('tab', { name: 'Model mixes, 1' }));
    const cards = await within(library).findByRole('list', { name: 'Model mixes' });
    expect(await within(cards).findByText('in use')).toBeTruthy();
    expect(within(cards).getByText('painter')).toBeTruthy();
    await user.type(within(library).getByLabelText(/Save the models in use/), 'Final');
    await user.click(within(library).getByRole('button', { name: /Save/ }));
    expect(await within(cards).findByRole('heading', { name: /Final/ })).toBeTruthy();

    await user.click(within(cards).getByRole('button', { name: 'Rename Drafts' }));
    const name = within(cards).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Cheap');
    await user.click(within(cards).getByRole('button', { name: 'Save' }));
    expect(await within(cards).findByRole('heading', { name: 'Cheap' })).toBeTruthy();
    await user.click(within(cards).getByRole('button', { name: 'Use Cheap' }));
    expect(await within(library).findByText('Using Cheap.')).toBeTruthy();
    await user.click(
      within(cards).getByRole('button', { name: 'Update Cheap with the models in use' }),
    );
    await user.type(within(library).getByRole('searchbox'), 'nothing like it');
    expect(await within(library).findByText('No model mix matches.')).toBeTruthy();
    await user.clear(within(library).getByRole('searchbox'));
    await user.click(await within(cards).findByRole('button', { name: 'Delete Cheap' }));
    await user.click(within(cards).getByRole('button', { name: 'Delete' }));
    await vi.waitFor(() => {
      expect(within(cards).queryByRole('heading', { name: 'Cheap' })).toBeNull();
    });
  });

  it('writes a problem report that opens as a GitHub issue, without the key', async () => {
    const { user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Help' }));
    const help = await screen.findByRole('dialog', { name: /Ask Imp/ });
    await user.click(within(help).getByRole('tab', { name: /Report a problem/ }));
    await user.type(
      within(help).getByLabelText(/The problem in a few words/),
      'Clips never finish',
    );
    await user.type(within(help).getByLabelText(/What happened/), 'The clip spins forever.');
    await user.click(within(help).getByRole('button', { name: 'Write the report' }));
    const link = await within(help).findByRole('link', { name: /Open on GitHub/ });
    const href = link.getAttribute('href') ?? '';
    expect(href.startsWith('https://github.com/ArndRosemeier/Imp/issues/new?title=Clips')).toBe(
      true,
    );
    const preview = within(help).getByLabelText('The report');
    expect(preview.textContent).toMatch(/The clip spins forever/);
    expect(preview.textContent).toMatch(/Version:/);
    expect(href).not.toContain('sk-');
  });

  it('changes models and mixes right in Settings, searching the whole catalog', async () => {
    const { imp, user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const models = await screen.findByRole('region', { name: 'Models' });

    // A search finds a model by part of its name.
    await user.click(within(models).getByLabelText('Video model'));
    await user.type(within(models).getByRole('combobox', { name: 'Search for a model' }), 'clip');
    await user.click(await within(models).findByRole('option', { name: /vendor\/clips/ }));
    await vi.waitFor(async () => {
      expect(await imp.store.get('settings/video.model')).toBe('vendor/clips');
    });
    expect(within(models).queryByRole('listbox')).toBeNull();

    // The agents' model is the coordinator's own, so it changes too.
    await chooseModel(user, within(models).getByLabelText('Agents model'), '~vendor/latest');
    await vi.waitFor(async () => {
      const crew = await imp.store.list('crew/');
      expect(crew.map((entry) => (entry.value as { model: string }).model)).toEqual([
        '~vendor/latest',
      ]);
    });
    // Models that cannot call tools are no use to an agent.
    await user.click(within(models).getByLabelText('Agents model'));
    await within(models).findByRole('option', { name: /vendor\/writer/ });
    expect(within(models).queryByRole('option', { name: /no-tools/ })).toBeNull();
    await user.keyboard('{Escape}');
    expect(within(models).queryByRole('listbox')).toBeNull();

    // Saved as a mix, switched away from, and switched back with one tap.
    await user.click(within(models).getByRole('button', { name: /Save all models as a mix/ }));
    await user.type(within(models).getByLabelText('Name of the mix'), 'Drafts');
    await user.click(within(models).getByRole('button', { name: 'Save' }));
    const drafts = await within(models).findByRole('button', { name: /Drafts/ });
    expect(drafts.getAttribute('aria-pressed')).toBe('true');
    await chooseModel(user, within(models).getByLabelText('Agents model'), 'vendor/writer');
    expect(await within(models).findByText('changed')).toBeTruthy();
    await user.click(drafts);
    await vi.waitFor(async () => {
      expect(await imp.store.get('settings/coordinator.model')).toBe('~vendor/latest');
    });
  });

  it('says where it runs, and offers the download only when it runs in the browser', async () => {
    const { user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    // Settings read as words; what the app keeps for itself stays out of the list.
    const models = await screen.findByRole('region', { name: 'Models' });
    expect((await within(models).findByLabelText('Agents model')).textContent).toContain(
      'vendor/writer',
    );
    const list = screen.getByRole('region', { name: 'Preferences' });
    expect(within(list).queryByText(/coordinator\.member/)).toBeNull();
    expect(within(list).queryByText('Coordinator model')).toBeNull();
    // The budget without approval is set here too, not only in the Spending panel.
    const agents = screen.getByRole('region', { name: 'What agents do without asking' });
    const budget = await within(agents).findByRole('region', { name: 'Budget without approval' });
    const field = within(budget).getByLabelText('Per project, $');
    await user.clear(field);
    await user.type(field, '3');
    await user.tab();
    await vi.waitFor(() => {
      expect(budget.textContent).toContain('$3.00 left of $3.00');
    });
    expect(within(list).queryByText('Budget without approval, per project')).toBeNull();
    // A button, so the save dialog can ask where the download goes.
    expect(
      await screen.findByRole('button', { name: /Download Imp for your computer/ }),
    ).toBeTruthy();

    cleanup();
    const mark = document.createElement('meta');
    mark.setAttribute('name', 'imp-host');
    mark.setAttribute('content', 'server');
    document.head.append(mark);
    try {
      const served = start();
      // The key is still in this browser, so setup goes on at the coordinator.
      await served.user.type(await screen.findByLabelText(/Model/), 'vendor/writer');
      await served.user.click(screen.getByRole('button', { name: /Hire the coordinator/ }));
      await served.user.click(await screen.findByRole('button', { name: 'Settings' }));
      expect(await screen.findByText(/Imp runs on this computer/)).toBeTruthy();
      expect(screen.queryByRole('link', { name: /Download Imp/ })).toBeNull();
    } finally {
      mark.remove();
    }
  });

  it('shows a tip the first time a stage opens, and turns all tips off in one step', async () => {
    const { imp, user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Development' }));
    await user.type(await screen.findByLabelText('Working title'), 'The Keeper');
    await user.click(screen.getByRole('button', { name: /Start the movie/ }));

    const first = await screen.findByRole('complementary', { name: /Start with the idea/ });
    await user.click(within(first).getByRole('button', { name: 'Got it' }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('complementary', { name: /Start with the idea/ })).toBeNull();
    });

    await user.click(screen.getByRole('button', { name: 'Script' }));
    const second = await screen.findByRole('complementary', { name: /Break the story/ });
    await user.click(within(second).getByRole('button', { name: 'Turn off all tips' }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('complementary', { name: /Break the story/ })).toBeNull();
    });
    await user.click(screen.getByRole('button', { name: 'Casting' }));
    await screen.findByRole('heading', { name: 'Casting' });
    expect(screen.queryByRole('complementary', { name: /^Tip/ })).toBeNull();
    expect((await imp.store.get('settings/help.enabled')) ?? true).toBe(false);

    // The guide stays, and searching finds the page about the Edit stage.
    await user.click(screen.getByRole('button', { name: /Help/ }));
    await user.click(await screen.findByRole('tab', { name: /Guide/ }));
    const guide = await screen.findByRole('dialog', { name: 'The Imp guide' });
    expect(await within(guide).findByRole('heading', { name: 'Getting started' })).toBeTruthy();
    await user.type(within(guide).getByRole('searchbox'), 'dissolve');
    await user.click(await within(guide).findByRole('button', { name: /^Edit/ }));
    expect(await within(guide).findByRole('heading', { name: 'Edit' })).toBeTruthy();

    // Tips come back from the same switch, in the guide or in Settings.
    await user.click(within(guide).getByRole('switch', { name: /Show tips/ }));
    await vi.waitFor(async () => {
      expect(await imp.store.get('settings/help.enabled')).toBe(true);
    });
  });

  it('answers questions from the guide with Ask Imp, hired the first time help opens', async () => {
    const { imp, provider, user } = start([
      {
        toolCalls: [
          {
            id: 'h1',
            name: 'help__topics',
            arguments: { query: 'dissolve' },
            argumentsText: '{"query":"dissolve"}',
          },
        ],
      },
      { content: 'Select the shot on the Edit stage and choose Dissolve in its inspector.' },
    ]);
    await completeSetup(user);
    expect((await imp.store.list('crew/')).length).toBe(1);

    await user.click(screen.getByRole('button', { name: /Help/ }));
    const panel = await screen.findByRole('dialog', { name: 'Ask Imp' });
    const chat = await within(panel).findByRole('complementary', { name: 'Conversation with Imp' });
    await user.click(within(chat).getByRole('button', { name: /dissolve between two shots/ }));
    await user.click(within(chat).getByRole('button', { name: /Send/ }));
    expect(await within(chat).findByText(/choose Dissolve in its inspector/)).toBeTruthy();
    // It looked in the guide, on the coordinator's model.
    expect(provider.requests.at(-1)?.model).toBe('vendor/writer');
    const crew = await imp.store.list('crew/');
    expect(crew.map((entry) => (entry.value as { roleId: string }).roleId).sort()).toEqual([
      'coordinator',
      'guide',
    ]);
  });

  it('shows the price on a button that spends, and keeps a running total', async () => {
    const { user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Development' }));
    await user.type(await screen.findByLabelText('Working title'), 'The Keeper');
    await user.click(screen.getByRole('button', { name: /Start the movie/ }));
    await screen.findByLabelText('Logline');
    await user.click(screen.getByRole('button', { name: 'Casting' }));
    await user.click(await screen.findByRole('button', { name: /Add character/ }));
    const card = await screen.findByRole('article', { name: 'New character' });
    await chooseModel(user, screen.getByLabelText('Image model'), 'vendor/painter');

    // Before the model has been used, the price is a rough typical one.
    const make = within(card).getByRole('button', { name: /Portrait/ });
    await vi.waitFor(() => {
      expect(make.textContent).toContain('≈ $0.01');
    });
    expect(screen.getByRole('button', { name: /Spent \$0\.00 on this project/ })).toBeTruthy();

    await user.click(make);
    await within(card).findByRole('img', { name: 'Portrait of New character' });
    // The fake painter charges a cent: the total counts it, and the next price comes from it.
    const total = await screen.findByRole('button', { name: /Spent \$0\.01 on this project/ });
    await vi.waitFor(() => {
      const again = within(card).getByRole('button', { name: /Another/ });
      expect(again.querySelector('.price')?.getAttribute('data-basis')).toBe('your history');
    });
    await user.click(total);
    const panel = await screen.findByRole('dialog', { name: 'What Imp has spent' });
    expect(within(panel).getAllByText('Pictures').length).toBe(2);
    expect(within(panel).getAllByText('vendor/painter').length).toBeGreaterThan(0);

    // The budget without approval: what is left of it here, and the person sets it.
    const budget = within(panel).getByRole('region', { name: 'Budget without approval' });
    await vi.waitFor(() => {
      expect(budget.textContent).toContain('$0.99 left of $1.00');
    });
    const field = within(budget).getByLabelText('Per project, $');
    await user.clear(field);
    await user.type(field, '5');
    await user.tab();
    await vi.waitFor(() => {
      expect(budget.textContent).toContain('$4.99 left of $5.00');
    });
  });

  it('switches web search on for a crew member', async () => {
    const { imp, user } = start();
    await completeSetup(user);
    await user.click(await screen.findByRole('button', { name: 'Crew' }));
    const box = await screen.findByRole('checkbox', { name: 'Coordinator can search the web' });
    expect(box).toHaveProperty('checked', false);
    await user.click(box);
    await vi.waitFor(async () => {
      const [member] = await imp.store.list('crew/');
      expect(member?.value).toMatchObject({ webSearch: true });
    });
    await vi.waitFor(() => {
      expect(box).toHaveProperty('checked', true);
    });
  });

  it('defines a custom role, hires for it and deletes it again', async () => {
    const { imp, user } = start();
    await completeSetup(user);
    await user.click(await screen.findByRole('button', { name: 'Crew' }));
    await user.click(screen.getByRole('button', { name: /New role/ }));
    const form = screen.getByRole('form', { name: 'New role' });
    await user.type(within(form).getByLabelText('Name'), 'Dialogue Polisher');
    await user.type(within(form).getByLabelText('Instructions'), 'Tighten the dialogue.');
    expect(within(form).getByRole('button', { name: /Create the role/ })).toHaveProperty(
      'disabled',
      true,
    );
    // It reads the film and changes nothing: a text-only model is enough.
    await user.click(
      within(within(form).getByRole('group', { name: 'May read' })).getByLabelText('movie'),
    );
    expect(within(form).getByText('A text-only model is enough')).toBeTruthy();
    await user.click(within(form).getByLabelText('ask to delete things'));
    await user.click(within(form).getByRole('button', { name: /Create the role/ }));

    await user.click(await screen.findByRole('button', { name: /Hire Dialogue Polisher/ }));
    await screen.findByLabelText('Talking to');
    expect(await imp.store.get('roles/dialogue-polisher')).toMatchObject({
      scope: { prefixes: ['movie.'], writes: [], effects: ['read', 'destructive'] },
      sees: [],
      webSearch: false,
    });

    // Everything a role holds can be changed here too: what it changes, sees and needs.
    await user.click(screen.getByRole('button', { name: /^Change$/ }));
    const change = await screen.findByRole('form', { name: 'Change role' });
    expect(within(change).getByLabelText('Name')).toHaveProperty('value', 'Dialogue Polisher');
    await user.click(
      within(within(change).getByRole('group', { name: /May change/ })).getByLabelText('movie'),
    );
    await user.click(within(change).getByLabelText('pictures'));
    await user.click(within(change).getByLabelText('search the web'));
    await user.click(await within(change).findByLabelText('Written scenes'));
    await user.click(within(change).getByRole('button', { name: /Save the role/ }));
    await vi.waitFor(async () => {
      expect(await imp.store.get('roles/dialogue-polisher')).toMatchObject({
        scope: { prefixes: ['movie.'], writes: ['movie.'] },
        sees: ['image'],
        webSearch: true,
        needs: [{ id: 'scenes', providedBy: 'screenwriter' }],
      });
    });
    // A role someone holds cannot be deleted, so the button is offered only after dismissal.
    expect(screen.queryByRole('button', { name: /Delete role/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Dismiss Dialogue Polisher' }));
    await user.click(await screen.findByRole('button', { name: /Delete role/ }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await vi.waitFor(async () => {
      expect(await imp.store.get('roles/dialogue-polisher')).toBeUndefined();
    });
  });
});

describe('extra roles', () => {
  it('keeps the Critic out of the roles until it is added, then offers it for hire', async () => {
    const { user } = start();
    await completeSetup(user);
    await user.click(await screen.findByRole('button', { name: 'Crew' }));
    expect(await screen.findByRole('heading', { name: 'More roles' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Hire Critic/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Add Critic/ }));
    expect(await screen.findByRole('button', { name: /Hire Critic/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'More roles' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Put away' }));
    expect(await screen.findByRole('button', { name: /Add Critic/ })).toBeTruthy();
  });
});

describe('fades of a placed sound', () => {
  it('follows the audio editor: linear, or a soft S, and silent outside the sound', async () => {
    const { fadeGain } = await import('../src/app/cut-player.js');
    expect(fadeGain(1, 10, 2, 0, 'linear')).toBeCloseTo(0.5);
    expect(fadeGain(1, 10, 2, 0, 'smooth')).toBeCloseTo(0.5);
    expect(fadeGain(0.5, 10, 2, 0, 'smooth')).toBeCloseTo(0.1464, 3);
    expect(fadeGain(9, 10, 0, 2, 'linear')).toBeCloseTo(0.5);
    expect(fadeGain(5, 10, 0, 0, 'linear')).toBe(1);
  });
});

describe('pan of a placed sound', () => {
  it('is a balance: the middle leaves both sides alone', async () => {
    const { panGains } = await import('../src/app/cut-player.js');
    expect(panGains(0)).toEqual([1, 1]);
    expect(panGains(-1)).toEqual([1, 0]);
    expect(panGains(0.5)).toEqual([0.5, 1]);
  });
});

describe('sound with effects on the Edit stage', () => {
  it('plays the processed copy, and the recording when it cannot be processed', async () => {
    const { Cut, withProcessedSound } = await import('../src/app/cut-player.js');
    const asked: unknown[] = [];
    const imp = {
      run: (id: string, input: { key: string }) => {
        asked.push([id, input.key]);
        return Promise.resolve(
          input.key === 'take/broken'
            ? { status: 'failed', output: null }
            : { status: 'ok', output: { key: `${input.key}.fx.wav` } },
        );
      },
    } as unknown as Parameters<typeof withProcessedSound>[0];
    const placement = (id: string, soundId: string, effects: unknown[]) => ({
      id,
      source: 'sound',
      soundId,
      sceneId: 's',
      shotId: '',
      trimStartSeconds: 0,
      startSeconds: 0,
      volume: 1,
      fadeInSeconds: 0,
      fadeOutSeconds: 0,
      loop: false,
      effects,
      name: soundId,
      kind: 'effect',
      recorded: true,
    });
    const cut = Cut.parse({
      totalSeconds: 4,
      canUndo: false,
      canRedo: false,
      items: [],
      unplaced: [],
      sounds: [
        placement('p1', 'wind', [{ kind: 'limiter' }]),
        placement('p2', 'rain', []),
        placement('p3', 'broken', [{ kind: 'limiter' }]),
      ],
      lines: [],
      lanes: [],
    });
    const take = (id: string) => ({ id, take: { blobKey: `take/${id}` } });
    const out = await withProcessedSound(imp, cut, {
      shots: [],
      sounds: [take('wind'), take('rain'), take('broken')] as never,
    });
    expect(out.sounds.map((sound) => sound.playKey)).toEqual(['take/wind.fx.wav', null, null]);
    expect(asked).toEqual([
      ['audio.fx.processed', 'take/wind'],
      ['audio.fx.processed', 'take/broken'],
    ]);
  });
});

describe('title cards in an exported video', () => {
  it('wraps words into lines that fit', async () => {
    const { wrapLines } = await import('../src/app/export.js');
    const fits = (line: string): boolean => line.length <= 10;
    expect(wrapLines('One two three four', fits)).toEqual(['One two', 'three four']);
    expect(wrapLines('A\nB', fits)).toEqual(['A', 'B']);
    expect(wrapLines('', fits)).toEqual(['']);
  });
});
