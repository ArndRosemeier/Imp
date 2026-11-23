// @vitest-environment jsdom
import { MemoryKeyValueStore, settingsGet, type JsonValue, type ReleaseNotes } from '@imp/core';
import { ProviderError } from '@imp/providers';
import { createFakeProvider } from '@imp/providers/testing';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/app/App.js';
import { fieldsOf, toInput } from '../src/app/CommandPalette.js';
import { agentModels } from '../src/app/Setup.js';
import { starterMixes } from '../src/app/onboarding/presets.js';
import { unseenVersions } from '../src/app/WhatsNew.js';
import { createImp } from '@imp/host';
import { createLocalSecretStore } from '../src/host/secrets.js';
import { chooseModel, completeSetup, connect, model, start, setUpAppTests } from './app-harness.js';

setUpAppTests();

describe('helpers', () => {
  it('offers only models that can run an agent, aliases first', () => {
    const list = [
      model('b/model'),
      model('a/image', { outputModalities: ['image'] }),
      model('a/plain', { supportsTools: false }),
      model('~z/latest'),
      model('a/model'),
    ];
    expect(agentModels(list).map((entry) => entry.id)).toEqual(['~z/latest', 'a/model', 'b/model']);
  });

  it('derives form fields from a command schema and builds its input', async () => {
    const client = connect(
      createImp({
        store: new MemoryKeyValueStore(),
        secrets: createLocalSecretStore(),
        provider: createFakeProvider({}),
      }),
    );
    expect(client.commands).toEqual([]);
    await client.start();
    const hire = client.commands.find((command) => command.id === 'crew.hire');
    if (hire === undefined) throw new Error('crew.hire is not registered');
    const fields = fieldsOf(hire);
    expect(fields.map(({ name, kind, required }) => ({ name, kind, required }))).toEqual([
      { name: 'roleId', kind: 'string', required: true },
      { name: 'model', kind: 'string', required: true },
      { name: 'name', kind: 'string', required: false },
      { name: 'budgetUsdPerRun', kind: 'number', required: false },
      { name: 'webSearch', kind: 'boolean', required: false },
    ]);
    expect(
      toInput(fields, { roleId: 'coordinator', model: 'm', name: ' ', budgetUsdPerRun: '0.5' }),
    ).toEqual({ roleId: 'coordinator', model: 'm', budgetUsdPerRun: 0.5 });
  });
});

const RELEASE: ReleaseNotes = {
  version: '0.003',
  date: '2026-11-23',
  preview: false,
  releases: [
    {
      version: '0.003',
      date: '2026-11-23',
      title: 'Ripple delete',
      pr: 41,
      notes: ['Gaps close.'],
    },
    { version: '0.002', date: '2026-11-22', title: 'Faster timeline', notes: [] },
    { version: '0.001', date: '2026-11-21', title: 'Imp so far', notes: ['Everything.'] },
  ],
};

describe("What's new", () => {
  it('marks only the latest version for someone new, and what came since for everyone else', () => {
    const pending = {
      ...RELEASE,
      preview: true,
      releases: [{ version: '0.004', date: null, title: 'Draft', notes: [] }, ...RELEASE.releases],
    };
    expect([...unseenVersions(pending, null)]).toEqual(['0.003']);
    expect([...unseenVersions(pending, '0.001')]).toEqual(['0.003', '0.002']);
    expect([...unseenVersions(pending, '0.003')]).toEqual([]);
  });

  it('shows the version in the top bar and what changed, and remembers it was seen', async () => {
    localStorage.setItem('imp.whatsNew.seen', '0.001');
    const { user } = start([], RELEASE);
    await completeSetup(user);
    const button = await screen.findByRole('button', {
      name: /What’s new in Imp 0\.003, with changes/,
    });
    expect(button.textContent).toContain('0.003');
    await user.click(button);
    const panel = screen.getByRole('dialog', { name: 'Imp 0.003' });
    expect(within(panel).getByText(/Every change that lands adds 0\.001/)).toBeTruthy();
    const items = within(panel)
      .getAllByRole('listitem')
      .filter((item) => item.classList.contains('release'));
    expect(items.map((item) => item.dataset['new'] ?? '')).toEqual(['true', 'true', '']);
    expect(within(panel).getByText('Gaps close.')).toBeTruthy();
    expect(
      within(panel)
        .getByRole('link', { name: /Change #41/ })
        .getAttribute('href'),
    ).toMatch(/\/pull\/41$/);
    expect(localStorage.getItem('imp.whatsNew.seen')).toBe('0.003');
    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('button', { name: 'What’s new in Imp 0.003' })).toBeTruthy();
  });

  it('says so when a build knows no history', async () => {
    const { user } = start();
    await completeSetup(user);
    await user.click(await screen.findByRole('button', { name: /What’s new in Imp 0\.000/ }));
    expect(screen.getByText(/made without its history/)).toBeTruthy();
    expect(screen.getByText(/A preview build/)).toBeTruthy();
  });
});

describe('App: setup and agents', () => {
  it('walks through setup, hires the coordinator and opens the workspace', async () => {
    const { imp, user } = start();
    await completeSetup(user);

    expect(imp.secrets.getKey()).toBe('sk-test');
    const stored = await imp.registry.execute(
      settingsGet,
      { key: 'coordinator.model' },
      { actor: { kind: 'user', id: 't' } },
    );
    expect(stored).toMatchObject({ output: { value: 'vendor/writer' } });
    // The start screen shows the Imp coordinator, for all projects; the project coordinator waits.
    expect(
      await screen.findByRole('complementary', { name: /Conversation with Imp coordinator/ }),
    ).toBeTruthy();
    expect(screen.getByRole('tab', { name: /All projects/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('tab', { name: /No project open/ })).toHaveProperty('disabled', true);
    const crew = (await imp.store.list('crew/')).map(
      (entry) => (entry.value as { roleId: string; model: string }).roleId,
    );
    expect(crew.sort()).toEqual(['coordinator', 'global-coordinator']);
    // The setup itself went through commands, so it shows in the activity strip.
    const strip = screen.getByRole('contentinfo', { name: 'Activity' });
    // One line with the latest command; a tap opens the recent ones.
    const toggle = await within(strip).findByRole('button', { name: /Recent/ });
    expect(within(strip).queryByRole('list')).toBeNull();
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const recent = await within(strip).findByRole('list');
    expect((await within(recent).findAllByText(/you · crew\.hire · ok/)).length).toBe(2);
    await user.click(toggle);
    expect(within(strip).queryByRole('list')).toBeNull();
  });

  it('starts with a model mix and no tips, for someone who knows their way around', async () => {
    const provider = createFakeProvider({
      models: [
        model('~anthropic/claude-haiku-latest'),
        model('~anthropic/claude-sonnet-latest'),
        model('meta/muse-image', { outputModalities: ['image'], supportsTools: false }),
        model('bytedance-seed/seed-audio-1-0', {
          outputModalities: ['speech'],
          supportsTools: false,
        }),
        model('google/veo-3.1-lite', {
          outputModalities: ['video'],
          supportsTools: false,
          video: {
            durationsSeconds: [4, 6, 8],
            resolutions: ['720p'],
            aspectRatios: ['16:9'],
            frameImages: [],
            nativeAudio: true,
            pricing: { perSecond: [{ resolution: '720p', audio: true, usd: 0.05 }], perToken: [] },
          },
        }),
      ],
    });
    const imp = createImp({
      store: new MemoryKeyValueStore(),
      secrets: createLocalSecretStore(),
      provider,
    });
    render(<App imp={connect(imp)} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('OpenRouter API key'), 'sk-test');
    await user.click(screen.getByRole('button', { name: /Continue/ }));

    const balanced = await screen.findByRole('radio', { name: /Balanced/ });
    // The clip price on the card comes from the video model's price list.
    expect(balanced.closest('label')?.textContent).toContain('≈ $0.20');
    await user.click(balanced);
    await user.click(screen.getByRole('radio', { name: /I know my way around/ }));
    await user.click(screen.getByRole('button', { name: /Start with Balanced/ }));
    await screen.findByRole('heading', { name: 'Projects' });

    expect(await imp.store.get('settings/coordinator.model')).toBe(
      '~anthropic/claude-sonnet-latest',
    );
    expect(await imp.store.get('settings/video.model')).toBe('google/veo-3.1-lite');
    expect(await imp.store.get('settings/speech.model')).toBe('bytedance-seed/seed-audio-1-0');
    expect(await imp.store.get('settings/help.enabled')).toBe(false);
    // All three mixes are kept, so the final film is one switch away.
    expect((await imp.store.list('model-mixes/')).length).toBe(3);
  });

  it('fills the starter mixes from the catalog, newest versions first', () => {
    const mixes = starterMixes([
      model('~anthropic/claude-haiku-latest'),
      model('bytedance/seedance-2.0-mini', { outputModalities: ['video'] }),
      model('bytedance/seedance-2.10-mini', { outputModalities: ['video'] }),
      model('google/lyria-3-clip-preview', { outputModalities: ['audio'] }),
      model('elevenlabs/scribe-v2', { outputModalities: ['transcription'] }),
    ]);
    expect(mixes[0]?.models).toMatchObject({
      'coordinator.model': '~anthropic/claude-haiku-latest',
      'video.model': 'bytedance/seedance-2.10-mini',
      'music.model': 'google/lyria-3-clip-preview',
      'transcription.model': 'elevenlabs/scribe-v2',
    });
    // Nothing is guessed: a slot the catalog cannot fill is left out.
    expect(mixes[0]?.models['images.model']).toBeUndefined();
    expect(mixes[2]?.models['coordinator.model']).toBeUndefined();
  });

  it('does not accept a model that is not in the catalog', async () => {
    const { user } = start();
    await user.type(await screen.findByLabelText('OpenRouter API key'), 'sk-test');
    await user.click(screen.getByRole('button', { name: /Continue/ }));
    await user.type(await screen.findByLabelText(/Model/), 'vendor/painter');
    expect(screen.getByRole('button', { name: /Hire the coordinator/ })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('lets the coordinator act through commands and shows what it did', async () => {
    const { imp, user } = start([
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'settings__set',
            arguments: { key: 'theme', value: 'dark' },
            argumentsText: '{"key":"theme","value":"dark"}',
          },
        ],
      },
      { content: 'The **theme** is `dark` now.' },
    ]);
    await completeSetup(user);
    await user.type(await screen.findByLabelText('Message to Imp coordinator'), 'Make it dark.');
    await user.click(screen.getByRole('button', { name: /Send/ }));

    const panel = screen.getByRole('complementary', { name: /Conversation with Imp coordinator/ });
    expect(await within(panel).findByText(/settings\.set/)).toBeTruthy();
    expect((await screen.findByText('theme', { selector: 'strong' })).tagName).toBe('STRONG');
    expect(screen.getByText('dark', { selector: 'code' })).toBeTruthy();
    expect(await imp.store.get('settings/theme')).toBe('dark');
    const strip = screen.getByRole('contentinfo', { name: 'Activity' });
    expect(await within(strip).findByText(/global-coordinator · settings\.set · ok/)).toBeTruthy();
  });

  it('runs any command from the palette with a generated form', async () => {
    const { imp, user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: /Run a command/ }));
    await user.type(screen.getByLabelText('Search commands'), 'change setting');
    await user.click(screen.getByRole('button', { name: /Change setting/ }));
    await user.type(screen.getByLabelText(/^key/), 'budget.daily');
    await user.type(screen.getByLabelText(/^value/), '5');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByLabelText('Result')).toBeTruthy();
    expect(await imp.store.get('settings/budget.daily')).toBe(5);
  });

  it('starts a movie and edits development, script and cast through commands', async () => {
    const { imp, user } = start();
    await completeSetup(user);

    await user.click(screen.getByRole('button', { name: 'Development' }));
    await user.type(await screen.findByLabelText('Working title'), 'The Lighthouse Keeper');
    await user.click(screen.getByRole('button', { name: /Start the movie/ }));

    await user.type(await screen.findByLabelText('Logline'), 'A keeper finds a living light.');
    await user.tab();
    const [project] = await imp.store.list('project-index/');
    const projectId = (project?.value as { id: string }).id;
    await vi.waitFor(async () => {
      expect(await imp.store.get(`projects/${projectId}/movie/development`)).toMatchObject({
        logline: 'A keeper finds a living light.',
      });
    });
    expect(screen.getByLabelText('Project')).toHaveProperty('value', projectId);

    await user.click(screen.getByRole('button', { name: 'Script' }));
    await user.click(await screen.findByRole('button', { name: /Add scene/ }));
    await user.type(await screen.findByLabelText('Scene heading'), 'INT. LAMP ROOM - NIGHT');
    await user.tab();
    expect(await screen.findByRole('tab', { name: '1 · Lamp Room, night' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Delete scene/ }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/There are no scenes yet/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Casting' }));
    await user.click(await screen.findByRole('button', { name: /Add character/ }));
    const card = await screen.findByRole('article', { name: 'New character' });
    await user.type(within(card).getByLabelText('Appearance'), 'Sixty, wiry.');
    await user.tab();
    await vi.waitFor(async () => {
      const [stored] = await imp.store.list(`projects/${projectId}/movie/characters/`);
      expect(stored?.value).toMatchObject({ name: 'New character', appearance: 'Sixty, wiry.' });
    });
  });

  it('makes portraits of a character, switches between them and deletes one', async () => {
    const { imp, provider, user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Development' }));
    await user.type(await screen.findByLabelText('Working title'), 'The Lighthouse Keeper');
    await user.click(screen.getByRole('button', { name: /Start the movie/ }));
    await screen.findByLabelText('Logline');
    await user.click(screen.getByRole('button', { name: 'Casting' }));
    await user.click(await screen.findByRole('button', { name: /Add character/ }));
    const card = await screen.findByRole('article', { name: 'New character' });

    // Nothing can be made before a model is chosen.
    const make = within(card).getByRole('button', { name: /Portrait/ });
    expect(make).toHaveProperty('disabled', true);
    await chooseModel(user, screen.getByLabelText('Image model'), 'vendor/painter');
    await vi.waitFor(() => {
      expect(make).toHaveProperty('disabled', false);
    });

    await user.click(make);
    expect(
      await within(card).findByRole('img', { name: 'Portrait of New character' }),
    ).toBeTruthy();
    await user.type(within(card).getByLabelText('Direction for the next image'), 'In profile.');
    await user.click(within(card).getByRole('button', { name: /Another/ }));
    const second = await within(card).findByRole('button', { name: 'Use image 2 as the portrait' });
    expect(provider.imageRequests.map((request) => request.model)).toEqual([
      'vendor/painter',
      'vendor/painter',
    ]);
    expect(provider.imageRequests[1]?.prompt).toContain('In profile.');

    const stored = async () => {
      const [entry] = await imp.store.list('project-index/');
      const characters = await imp.store.list(
        `projects/${(entry?.value as { id: string }).id}/movie/characters/`,
      );
      return characters[0]?.value as { images: { id: string }[]; portraitId: string };
    };
    await user.click(second);
    await vi.waitFor(async () => {
      const character = await stored();
      expect(character.portraitId).toBe(character.images[1]?.id);
    });
    await user.click(within(card).getByRole('button', { name: /Delete image/ }));
    await user.click(within(card).getByRole('button', { name: 'Delete' }));
    await vi.waitFor(async () => {
      expect((await stored()).images).toHaveLength(1);
      expect(await imp.blobs.list('')).toHaveLength(1);
    });

    // The voice: nothing before a model is chosen, then a line with its delivery.
    const voice = within(card).getByRole('form', { name: 'Voice of New character' });
    const recordButton = within(voice).getByRole('button', { name: /Record voice/ });
    expect(recordButton).toHaveProperty('disabled', true);
    await chooseModel(user, screen.getByLabelText('Voice model'), 'vendor/speaker');
    await vi.waitFor(() => {
      expect(recordButton).toHaveProperty('disabled', false);
    });
    await user.type(within(voice).getByLabelText('Line to record'), 'Get back!');
    await user.type(within(voice).getByLabelText('Delivery'), 'Shouting.');
    await user.click(recordButton);
    expect(await within(voice).findByLabelText('Voice sample of New character')).toBeTruthy();
    expect(provider.speechRequests[0]).toMatchObject({
      model: 'vendor/speaker',
      text: 'Get back!',
      instructions: expect.stringContaining('Delivery: Shouting.') as string,
    });
    await user.click(within(voice).getByRole('button', { name: /Delete recording/ }));
    await user.click(within(voice).getByRole('button', { name: 'Delete' }));
    await vi.waitFor(async () => {
      expect(await imp.blobs.list('')).toHaveLength(1);
      expect(within(voice).queryByLabelText('Voice sample of New character')).toBeNull();
    });
  });

  it('hires a screenwriter who writes into the open project', async () => {
    // The scripted model cannot know the project id, so the call is completed further down.
    const call = {
      id: 'c1',
      name: 'movie__scene__create',
      arguments: { projectId: '', heading: 'EXT. HARBOUR - DUSK' },
      argumentsText: '',
    };
    const { imp, provider, user } = start([
      { toolCalls: [call] },
      { content: 'The opening scene is in.' },
    ]);
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Script' }));
    await user.type(await screen.findByLabelText('Working title'), 'Keeper');
    await user.click(screen.getByRole('button', { name: /Start the movie/ }));
    await screen.findByRole('heading', { name: 'Script' });
    const [project] = await imp.store.list('project-index/');
    const projectId = (project?.value as { id: string }).id;
    call.arguments.projectId = projectId;
    call.argumentsText = JSON.stringify(call.arguments);
    // Scenes are written for a cast; this film has nobody in it.
    await imp.registry.executeById(
      'crew.needs.waive',
      { need: 'cast', reason: 'No people in this film.' },
      { actor: { kind: 'user', id: 'local' } },
    );

    await user.click(screen.getByRole('button', { name: 'Crew' }));
    await user.click(await screen.findByRole('button', { name: /Hire Screenwriter/ }));
    await user.selectOptions(await screen.findByLabelText('Talking to'), 'Screenwriter');
    await user.type(screen.getByLabelText('Message to Screenwriter'), 'Write the opening.');
    await user.click(screen.getByRole('button', { name: /Send/ }));

    const panel = screen.getByRole('complementary', { name: /Conversation with Screenwriter/ });
    expect(await within(panel).findByText('The opening scene is in.')).toBeTruthy();
    expect(provider.requests[0]?.messages[1]).toMatchObject({
      context: expect.stringContaining(`projectId "${projectId}"`) as string,
    });
    await user.click(screen.getByRole('button', { name: 'Script' }));
    expect(await screen.findByRole('tab', { name: '1 · Harbour, dusk' })).toBeTruthy();
  });

  it('lets the library and the crew take turns only when the stage would get too narrow', async () => {
    const { user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Development' }));
    await user.type(await screen.findByLabelText('Working title'), 'The Lighthouse Keeper');
    await user.click(screen.getByRole('button', { name: /Start the movie/ }));
    await screen.findByLabelText('Logline');
    const shell = (): string | null | undefined =>
      document.querySelector('.shell')?.getAttribute('data-crew');
    const width = window.innerWidth;
    try {
      // A wide screen has room for both.
      window.innerWidth = 2400;
      await user.click(screen.getByRole('button', { name: 'Library' }));
      await screen.findByRole('complementary', { name: 'Library' });
      expect(shell()).toBe('open');
      await user.click(screen.getByRole('button', { name: 'Library' }));

      // A 1440 px screen does not: opening the library hides the crew, and the other way round.
      window.innerWidth = 1440;
      await user.click(screen.getByRole('button', { name: 'Library' }));
      await screen.findByRole('complementary', { name: 'Library' });
      expect(shell()).toBe('closed');
      await user.click(screen.getByRole('button', { name: 'Crew panel' }));
      await vi.waitFor(() => {
        expect(screen.queryByRole('complementary', { name: 'Library' })).toBeNull();
      });
      expect(shell()).toBe('open');
    } finally {
      window.innerWidth = width;
    }
  });

  it('resizes the side panels with the keyboard and remembers the widths', async () => {
    const { user } = start();
    await completeSetup(user);
    const nav = screen.getByRole('separator', { name: 'Resize the navigation' });
    const crew = screen.getByRole('separator', { name: 'Resize the crew panel' });
    expect(nav.getAttribute('aria-valuenow')).toBe('220');

    nav.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(nav.getAttribute('aria-valuenow')).toBe('252');
    await user.keyboard('{Home}');
    expect(nav.getAttribute('aria-valuenow')).toBe('168');

    // The crew panel is on the right, so it grows towards the left.
    crew.focus();
    await user.keyboard('{ArrowLeft}');
    expect(crew.getAttribute('aria-valuenow')).toBe('376');
    expect(localStorage.getItem('imp.width.crew')).toBe('376');
    expect(
      document.querySelector<HTMLElement>('.shell')?.style.getPropertyValue('--crew-width'),
    ).toBe('376px');

    // Dragging the left edge of the crew panel 100 px to the left widens it by 100 px.
    fireEvent.pointerDown(crew, { clientX: 900, pointerId: 1 });
    fireEvent.pointerMove(crew, { clientX: 800, pointerId: 1 });
    fireEvent.pointerUp(crew, { pointerId: 1 });
    fireEvent.pointerMove(crew, { clientX: 500, pointerId: 1 });
    expect(crew.getAttribute('aria-valuenow')).toBe('476');

    await user.dblClick(crew);
    expect(crew.getAttribute('aria-valuenow')).toBe('360');
    expect(localStorage.getItem('imp.width.crew')).toBeNull();
    // The crew panel can be put away, for example to give a tablet's stage the room.
    const toggle = screen.getByRole('button', { name: 'Crew panel' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.shell')?.getAttribute('data-crew')).toBe('closed');
    expect(screen.queryByRole('separator', { name: 'Resize the crew panel' })).toBeNull();
    expect(localStorage.getItem('imp.crew.open')).toBe('false');
    await user.click(toggle);
    expect(screen.getByRole('separator', { name: 'Resize the crew panel' })).toBeTruthy();
  });

  it('continues an agent run that was cut off', async () => {
    const { imp, provider, user } = start([{ content: 'Hello.' }]);
    await completeSetup(user);
    await user.type(await screen.findByLabelText('Message to Imp coordinator'), 'Hi.');
    await user.click(screen.getByRole('button', { name: /Send/ }));
    expect(await screen.findByText('Hello.')).toBeTruthy();

    // The tab closed part way: the task was saved, the answer never came.
    const global = (await imp.store.list('crew/'))
      .map((entry) => entry.value as { id: string; roleId: string })
      .find((member) => member.roleId === 'global-coordinator');
    if (global === undefined) throw new Error('an Imp coordinator expected');
    const memberId = global.id;
    const key = `conversations/${memberId}`;
    const saved = (await imp.store.get(key)) as { messages: JsonValue[] };
    await imp.store.batch([
      {
        type: 'put',
        key,
        value: {
          ...saved,
          messages: [...saved.messages, { role: 'user', content: 'Write the logline.' }],
          lastStatus: 'cancelled',
        },
      },
    ]);
    cleanup();
    render(<App imp={connect(imp)} />);
    expect(await screen.findByText(/The last run was interrupted/)).toBeTruthy();
    provider.script({ content: 'Logline written.' });
    await user.click(
      screen.getByRole('button', { name: 'Continue where Imp coordinator stopped' }),
    );
    expect(await screen.findByText('Logline written.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Continue where/ })).toBeNull();
  });

  it('retries a message that did not reach the model, without sending it twice', async () => {
    const { provider, user } = start([
      new ProviderError(
        'network',
        'openrouter',
        'Imp could not reach OpenRouter. Check the internet connection, then try again.',
      ),
    ]);
    await completeSetup(user);
    await user.type(
      await screen.findByLabelText('Message to Imp coordinator'),
      'Write the logline.',
    );
    await user.click(screen.getByRole('button', { name: /Send/ }));
    expect(await screen.findByText('Imp coordinator did not get your message')).toBeTruthy();
    expect(screen.getByText(/could not reach OpenRouter/)).toBeTruthy();

    provider.script({ content: 'Logline written.' });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Logline written.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    // The message is in the conversation once, and the model was sent it once more, not twice.
    expect(screen.getAllByText('Write the logline.')).toHaveLength(1);
    const retried = provider.requests.at(-1)?.messages ?? [];
    expect(retried.filter((message) => message.role === 'user')).toHaveLength(1);
  });

  it('keeps the conversation across a restart and resumes after an approval', async () => {
    const { imp, provider, user } = start([
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'run_command',
            arguments: { id: 'project.delete', input: { projectId: 'nope' } },
            argumentsText: '{"id":"project.delete","input":{"projectId":"nope"}}',
          },
        ],
      },
      { content: 'Waiting for you.' },
    ]);
    await completeSetup(user);
    // Deleting is put to the person first; declining lets the coordinator carry on.
    await user.type(await screen.findByLabelText('Message to Imp coordinator'), 'Delete it.');
    await user.click(screen.getByRole('button', { name: /Send/ }));
    const deleting = await screen.findByRole('region', { name: 'Needs your approval' });
    expect(within(deleting).getByText('Delete project')).toBeTruthy();
    await user.click(within(deleting).getByRole('button', { name: /Decline/ }));
    expect(await screen.findByText('Waiting for you.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Needs your approval' })).toBeNull();

    // A second page on the same store shows the same conversation.
    cleanup();
    render(<App imp={connect(imp)} />);
    expect(await screen.findByText('Waiting for you.')).toBeTruthy();
    expect(screen.getByText('Delete it.')).toBeTruthy();

    // Hiring a specialist and handing it work goes through an approval and then continues,
    // in a project, where the crew works.
    const created = await imp.registry.executeById(
      'project.create',
      { name: 'Keeper', mode: 'movie' },
      { actor: { kind: 'user', id: 't' } },
    );
    await imp.registry.executeById(
      'project.open',
      { projectId: (created as { output: { id: string } }).output.id },
      { actor: { kind: 'user', id: 't' } },
    );
    await user.click(await screen.findByRole('button', { name: 'Crew' }));
    await user.click(await screen.findByRole('button', { name: /Hire Screenwriter/ }));
    await screen.findByLabelText('Talking to');
    const crew = await imp.store.list('crew/');
    const writer = crew
      .map((entry) => entry.value as { id: string; roleId: string })
      .find((member) => member.roleId === 'screenwriter');
    const args = { memberId: writer?.id ?? '', task: 'Write a scene.', without: ['cast'] };
    // With no budget without approval, every paid step asks.
    await imp.store.batch([{ type: 'put', key: 'settings/spend.allowance.project', value: 0 }]);
    provider.script(
      {
        toolCalls: [
          { id: 'c2', name: 'crew__ask', arguments: args, argumentsText: JSON.stringify(args) },
        ],
      },
      { content: 'I asked the Screenwriter.' },
      { content: 'Scene written.' },
      { content: 'The Screenwriter is done.' },
    );
    await user.type(screen.getByLabelText('Message to Coordinator'), 'Get a scene written.');
    await user.click(screen.getByRole('button', { name: /Send/ }));
    const approval = await screen.findByRole('region', { name: 'Needs your approval' });
    expect(within(approval).getByText('Give an agent a task')).toBeTruthy();
    // The request names the crew member instead of showing an id.
    expect(within(approval).getByText('Screenwriter')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Send/ })).toHaveProperty('disabled', true);
    await user.click(within(approval).getByRole('button', { name: /Approve/ }));

    expect(await screen.findByText('The Screenwriter is done.')).toBeTruthy();
    expect(screen.getByText('Approved: crew.ask')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Needs your approval' })).toBeNull();

    // Clearing asks first; keeping changes nothing.
    await user.click(screen.getByRole('button', { name: /Clear chat/ }));
    const asking = screen.getByRole('group', { name: 'Clear this chat?' });
    await user.click(within(asking).getByRole('button', { name: 'Keep' }));
    expect(screen.getByText('The Screenwriter is done.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Clear chat/ }));
    await user.click(
      within(screen.getByRole('group', { name: 'Clear this chat?' })).getByRole('button', {
        name: 'Clear',
      }),
    );
    expect(await screen.findByText(/Tell Coordinator what you want/)).toBeTruthy();
  });
});
