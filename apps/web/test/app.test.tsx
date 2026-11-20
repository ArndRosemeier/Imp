// @vitest-environment jsdom
import { MemoryKeyValueStore, settingsGet } from '@imp/core';
import type { ModelInfo } from '@imp/providers';
import { createFakeProvider, type ScriptedChatReply } from '@imp/providers/testing';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app/App.js';
import { fieldsOf, toInput } from '../src/app/CommandPalette.js';
import { agentModels } from '../src/app/Setup.js';
import { connectImp, createImp, createLocalPorts, serveImp, type Imp } from '@imp/host';
import { createLocalSecretStore } from '../src/host/secrets.js';

const model = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  name: id,
  inputModalities: ['text'],
  outputModalities: ['text'],
  contextLength: 1000,
  supportsTools: true,
  pricing: { promptUsdPerToken: null, completionUsdPerToken: null },
  ...extra,
});

/** The interface reaches the core only through messages, as it does with a worker. */
function connect(imp: Imp) {
  const [page, core] = createLocalPorts();
  serveImp(() => imp, core);
  return connectImp(page, imp.secrets);
}

function start(replies: readonly ScriptedChatReply[] = []) {
  const provider = createFakeProvider({
    replies,
    models: [
      model('vendor/writer'),
      model('~vendor/latest'),
      model('vendor/painter', { outputModalities: ['image'] }),
      model('vendor/speaker', { outputModalities: ['speech'] }),
      model('vendor/clips', { outputModalities: ['video'] }),
      model('vendor/composer', { outputModalities: ['text', 'audio'] }),
      model('vendor/no-tools', { supportsTools: false }),
    ],
  });
  const imp = createImp({
    store: new MemoryKeyValueStore(),
    secrets: createLocalSecretStore(),
    provider,
  });
  render(<App imp={connect(imp)} />);
  return { imp, provider, user: userEvent.setup() };
}

async function completeSetup(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('OpenRouter API key'), 'sk-test');
  await user.click(screen.getByRole('button', { name: /Continue/ }));
  await user.type(await screen.findByLabelText(/Model/), 'vendor/writer');
  await user.click(screen.getByRole('button', { name: /Hire the coordinator/ }));
  await screen.findByRole('heading', { name: 'Crew' });
}

beforeAll(() => {
  // jsdom implements neither scrolling nor the modal dialog methods.
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.setPointerCapture = () => undefined;
  // Nor does it play media.
  HTMLMediaElement.prototype.pause = () => undefined;
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  // jsdom has no object URLs either.
  let urls = 0;
  URL.createObjectURL = () => `blob:test/${String((urls += 1))}`;
  URL.revokeObjectURL = () => undefined;
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

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

describe('App', () => {
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
    expect(
      screen.getByRole('complementary', { name: /Conversation with Coordinator/ }),
    ).toBeTruthy();
    // The setup itself went through commands, so it shows in the activity strip.
    const strip = screen.getByRole('contentinfo', { name: 'Activity' });
    expect(await within(strip).findByText(/you · crew\.hire · ok/)).toBeTruthy();
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
    await user.type(screen.getByLabelText('Message to Coordinator'), 'Make it dark.');
    await user.click(screen.getByRole('button', { name: /Send/ }));

    const panel = screen.getByRole('complementary', { name: /Conversation with Coordinator/ });
    expect(await within(panel).findByText(/settings\.set/)).toBeTruthy();
    expect((await screen.findByText('theme', { selector: 'strong' })).tagName).toBe('STRONG');
    expect(screen.getByText('dark', { selector: 'code' })).toBeTruthy();
    expect(await imp.store.get('settings/theme')).toBe('dark');
    const strip = screen.getByRole('contentinfo', { name: 'Activity' });
    expect(await within(strip).findByText(/coordinator · settings\.set · ok/)).toBeTruthy();
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
    expect(await screen.findByRole('tab', { name: /1 · INT\. LAMP ROOM - NIGHT/ })).toBeTruthy();
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
    await screen.findByRole('option', { name: 'vendor/painter' });
    await user.selectOptions(screen.getByLabelText('Image model'), 'vendor/painter');
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
    await user.selectOptions(screen.getByLabelText('Voice model'), 'vendor/speaker');
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
    expect(await screen.findByRole('tab', { name: /1 · EXT\. HARBOUR - DUSK/ })).toBeTruthy();
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
    // Deleting is outside what the coordinator may do, so it cannot even ask for it.
    await user.type(screen.getByLabelText('Message to Coordinator'), 'Delete it.');
    await user.click(screen.getByRole('button', { name: /Send/ }));
    expect(await screen.findByText('Waiting for you.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Needs your approval' })).toBeNull();

    // A second page on the same store shows the same conversation.
    cleanup();
    render(<App imp={connect(imp)} />);
    expect(await screen.findByText('Waiting for you.')).toBeTruthy();
    expect(screen.getByText('Delete it.')).toBeTruthy();

    // Hiring a specialist and handing it work goes through an approval and then continues.
    await user.click(await screen.findByRole('button', { name: /Hire Screenwriter/ }));
    await screen.findByLabelText('Talking to');
    const crew = await imp.store.list('crew/');
    const writer = crew
      .map((entry) => entry.value as { id: string; roleId: string })
      .find((member) => member.roleId === 'screenwriter');
    const args = { memberId: writer?.id ?? '', task: 'Write a scene.' };
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

    await user.click(screen.getByRole('button', { name: /Start over/ }));
    expect(await screen.findByText(/Tell Coordinator what you want/)).toBeTruthy();
  });

  it('breaks a scene into shots and makes a clip that arrives later', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { imp, provider, user } = start();
      await completeSetup(user);
      await user.click(screen.getByRole('button', { name: 'Development' }));
      await user.type(await screen.findByLabelText('Working title'), 'The Lighthouse Keeper');
      await user.click(screen.getByRole('button', { name: /Start the movie/ }));
      await screen.findByLabelText('Logline');

      await user.click(screen.getByRole('button', { name: 'Shots' }));
      expect(await screen.findByText(/there are no scenes yet/)).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Script' }));
      await user.click(await screen.findByRole('button', { name: /Add scene/ }));
      await user.type(await screen.findByLabelText('Scene heading'), 'INT. LAMP ROOM - NIGHT');
      await user.tab();
      await user.click(screen.getByRole('button', { name: 'Casting' }));
      await user.click(await screen.findByRole('button', { name: /Add character/ }));
      await screen.findByRole('article', { name: 'New character' });

      await user.click(screen.getByRole('button', { name: 'Shots' }));
      expect(await screen.findByText(/This scene has no shots yet/)).toBeTruthy();
      await user.click(screen.getByRole('button', { name: /Add shot/ }));
      const card = await screen.findByRole('article', { name: 'Shot 1' });
      const generate = within(card).getByRole('button', { name: /Generate clip/ });
      expect(generate).toHaveProperty('disabled', true);
      await user.selectOptions(await screen.findByLabelText('Video model'), 'vendor/clips');
      await user.type(within(card).getByLabelText('What we see'), 'The lamp turns.');
      await user.tab();
      await user.click(within(card).getByRole('checkbox', { name: 'New character' }));
      await user.selectOptions(within(card).getByLabelText('Spoken by'), 'New character');
      await user.type(within(card).getByLabelText('Line, as it is said'), 'Get back!');
      await user.tab();
      await vi.waitFor(() => {
        expect(generate).toHaveProperty('disabled', false);
      });

      await user.click(generate);
      expect(await within(card).findByText(/Being made, 50%/)).toBeTruthy();
      expect(provider.videoRequests[0]).toMatchObject({
        model: 'vendor/clips',
        audio: true,
        prompt: expect.stringContaining('New character says "Get back!"') as string,
      });
      // The view looks again by itself until the clip is there.
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await within(card).findByLabelText('Clip of shot 1')).toBeTruthy();
      expect(within(card).getByText(/vendor\/clips.*\$0\.20/)).toBeTruthy();

      await user.click(within(card).getByRole('button', { name: /Delete clip/ }));
      await user.click(within(card).getByRole('button', { name: 'Delete' }));
      expect(await within(card).findByText('No clip yet')).toBeTruthy();
      await user.click(within(card).getByRole('button', { name: /Delete shot/ }));
      await user.click(within(card).getByRole('button', { name: 'Delete' }));
      expect(await screen.findByText(/This scene has no shots yet/)).toBeTruthy();
      expect(await imp.blobs.list('')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cuts a film: copy, paste, undo, title cards and an overview', async () => {
    const { imp, user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Development' }));
    await user.type(await screen.findByLabelText('Working title'), 'The Lighthouse Keeper');
    await user.click(screen.getByRole('button', { name: /Start the movie/ }));
    await screen.findByLabelText('Logline');

    const actor = { kind: 'user', id: 'arnd' } as const;
    const call = async (id: string, input: Record<string, unknown>) => {
      const result = await imp.registry.executeById(id, input, { actor });
      if (result.status !== 'ok') throw new Error(id);
      return result.output as Record<string, string>;
    };
    const projects = (await call('project.list', {})) as unknown as { projects: { id: string }[] };
    const projectId = projects.projects[0]?.id ?? '';
    await call('settings.set', { key: 'video.model', value: 'vendor/clips' });
    const scene = await call('movie.scene.create', {
      projectId,
      heading: 'INT. LAMP ROOM - NIGHT',
    });
    for (const description of ['The lamp turns.', 'Mara at the stairs.']) {
      const shot = await call('movie.shot.create', {
        projectId,
        sceneId: scene['id'],
        description,
      });
      const at = { projectId, sceneId: scene['id'], shotId: shot['id'] };
      await call('movie.shot.clip.generate', { ...at, durationSeconds: 4 });
      await call('movie.shot.clip.check', at);
      await call('movie.shot.clip.check', at);
    }

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByText(/2 of 2 pieces ready/)).toBeTruthy();
    const first = await screen.findByRole('button', { name: /Shot 1: The lamp turns/ });
    expect(screen.getByRole('button', { name: /Shot 2: Mara at the stairs/ })).toBeTruthy();
    expect(screen.getAllByText(/0:08/).length).toBeGreaterThan(0);

    await user.click(first);
    expect(await screen.findByText(/Shot 1/, { selector: 'h3' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /^Copy/ }));
    await user.click(screen.getByRole('button', { name: /^Paste/ }));
    // The copy goes in right after the original.
    expect(await screen.findByRole('button', { name: /Shot 2: The lamp turns/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Shot 3: Mara at the stairs/ })).toBeTruthy();
    expect(screen.getAllByText(/0:12/).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: /Undo/ }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('button', { name: /Shot 3: Mara/ })).toBeNull();
    });
    await user.click(screen.getByRole('button', { name: /Redo/ }));
    expect(await screen.findByRole('button', { name: /Shot 3: Mara/ })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Add title/ }));
    expect(await screen.findByRole('button', { name: /Title 2: Title/ })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Delete/ }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('button', { name: /Title 2: Title/ })).toBeNull();
    });
  });

  it('gives a scene sound effects and music', async () => {
    const { imp, provider, user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Development' }));
    await user.type(await screen.findByLabelText('Working title'), 'The Lighthouse Keeper');
    await user.click(screen.getByRole('button', { name: /Start the movie/ }));
    await screen.findByLabelText('Logline');

    await user.click(screen.getByRole('button', { name: 'Sound' }));
    expect(await screen.findByText(/there are no scenes yet/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Script' }));
    await user.click(await screen.findByRole('button', { name: /Add scene/ }));
    await screen.findByLabelText('Scene heading');
    await user.click(screen.getByRole('button', { name: 'Sound' }));
    expect(await screen.findByText(/This scene is silent so far/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Add sound effect/ }));
    const effect = await screen.findByRole('article', { name: 'Sound effect' });
    const generate = within(effect).getByRole('button', { name: /Generate/ });
    expect(generate).toHaveProperty('disabled', true);
    await user.selectOptions(await screen.findByLabelText('Sound effects model'), 'vendor/speaker');
    await user.type(within(effect).getByLabelText('What is heard'), 'A gale at sea.');
    await user.tab();
    await vi.waitFor(() => {
      expect(generate).toHaveProperty('disabled', false);
    });
    await user.type(within(effect).getByLabelText('Name'), 'Wind');
    await user.tab();
    const wind = await screen.findByRole('article', { name: 'Wind' });
    await user.click(within(wind).getByRole('button', { name: /Generate/ }));
    expect(await within(wind).findByLabelText('Recording of Wind')).toBeTruthy();
    expect(within(wind).getByRole('button', { name: /Generate again/ })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Add music/ }));
    const music = await screen.findByRole('article', { name: 'Music' });
    await user.selectOptions(await screen.findByLabelText('Music model'), 'vendor/composer');
    await user.type(within(music).getByLabelText('What is heard'), 'Low strings.');
    await user.tab();
    await vi.waitFor(() => {
      expect(within(music).getByRole('button', { name: /Generate/ })).toHaveProperty(
        'disabled',
        false,
      );
    });
    await user.click(within(music).getByRole('button', { name: /Generate/ }));
    expect(await within(music).findByText(/vendor\/composer · \$0\.04/)).toBeTruthy();
    expect(provider.soundRequests).toEqual([
      { model: 'vendor/speaker', kind: 'effect', prompt: 'A gale at sea.' },
      { model: 'vendor/composer', kind: 'music', prompt: 'Low strings.\nInstrumental, no vocals.' },
    ]);
    expect(screen.getByText('2 sounds in this scene')).toBeTruthy();

    for (const card of [wind, music]) {
      await user.click(within(card).getByRole('button', { name: /Delete sound/ }));
      await user.click(within(card).getByRole('button', { name: 'Delete' }));
    }
    expect(await screen.findByText(/This scene is silent so far/)).toBeTruthy();
    expect(await imp.blobs.list('')).toEqual([]);
  });

  it('says where it runs, and offers the download only when it runs in the browser', async () => {
    const { user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const link = await screen.findByRole('link', { name: /Download Imp for your computer/ });
    expect(link.getAttribute('href')).toBe('./imp-server.zip');

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

  it('switches web search on for a crew member', async () => {
    const { imp, user } = start();
    await completeSetup(user);
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
    await user.click(screen.getByRole('button', { name: /New role/ }));
    const form = screen.getByRole('form', { name: 'New role' });
    await user.type(within(form).getByLabelText('Name'), 'Dialogue Polisher');
    await user.type(within(form).getByLabelText('Instructions'), 'Tighten the dialogue.');
    expect(within(form).getByRole('button', { name: /Create the role/ })).toHaveProperty(
      'disabled',
      true,
    );
    await user.click(within(form).getByLabelText('movie'));
    // A critic reads and does not change anything.
    await user.click(within(form).getByLabelText('change things'));
    await user.click(within(form).getByLabelText('ask to delete things'));
    await user.click(within(form).getByRole('button', { name: /Create the role/ }));

    await user.click(await screen.findByRole('button', { name: /Hire Dialogue Polisher/ }));
    await screen.findByLabelText('Talking to');
    expect(await imp.store.get('roles/dialogue-polisher')).toMatchObject({
      scope: { prefixes: ['movie.'], effects: ['read', 'destructive'] },
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
