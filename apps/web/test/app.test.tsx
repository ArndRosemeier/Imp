// @vitest-environment jsdom
import { MemoryKeyValueStore, settingsGet, type JsonValue, type ReleaseNotes } from '@imp/core';
import type { ModelInfo } from '@imp/providers';
import { createFakeProvider, type ScriptedChatReply } from '@imp/providers/testing';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app/App.js';
import { fieldsOf, toInput } from '../src/app/CommandPalette.js';
import { agentModels } from '../src/app/Setup.js';
import { unseenVersions } from '../src/app/WhatsNew.js';
import { connectImp, createImp, createLocalPorts, serveImp, type Imp } from '@imp/host';
import { createLocalSecretStore } from '../src/host/secrets.js';
import { encodeWav } from '@imp/audio';

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

function start(replies: readonly ScriptedChatReply[] = [], release?: ReleaseNotes) {
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
    ...(release === undefined ? {} : { release }),
  });
  render(<App imp={connect(imp)} />);
  return { imp, provider, user: userEvent.setup() };
}

async function completeSetup(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('OpenRouter API key'), 'sk-test');
  await user.click(screen.getByRole('button', { name: /Continue/ }));
  await user.type(await screen.findByLabelText(/Model/), 'vendor/writer');
  await user.click(screen.getByRole('button', { name: /Hire the coordinator/ }));
  await screen.findByRole('heading', { name: 'Projects' });
}

beforeAll(() => {
  // jsdom implements neither scrolling nor the modal dialog methods.
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
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
      name: /What's new in Imp 0\.003, with changes/,
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
    expect(screen.getByRole('button', { name: "What's new in Imp 0.003" })).toBeTruthy();
  });

  it('says so when a build knows no history', async () => {
    const { user } = start();
    await completeSetup(user);
    await user.click(await screen.findByRole('button', { name: /What's new in Imp 0\.000/ }));
    expect(screen.getByText(/made without its history/)).toBeTruthy();
    expect(screen.getByText(/A preview build/)).toBeTruthy();
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
    expect(await screen.findByRole('tab', { name: '1 · Harbour, dusk' })).toBeTruthy();
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
    await user.type(screen.getByLabelText('Message to Coordinator'), 'Hi.');
    await user.click(screen.getByRole('button', { name: /Send/ }));
    expect(await screen.findByText('Hello.')).toBeTruthy();

    // The tab closed part way: the task was saved, the answer never came.
    const memberId = (await imp.store.get('settings/coordinator.member')) as string;
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
    await user.click(screen.getByRole('button', { name: 'Continue where Coordinator stopped' }));
    expect(await screen.findByText('Logline written.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Continue where/ })).toBeNull();
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
    await user.type(screen.getByLabelText('Message to Coordinator'), 'Delete it.');
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

    // Hiring a specialist and handing it work goes through an approval and then continues.
    await user.click(await screen.findByRole('button', { name: 'Crew' }));
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

  it('designs a location from two views, links it to a scene and films a shot from a view', async () => {
    const { provider, user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Development' }));
    await user.type(await screen.findByLabelText('Working title'), 'The Lighthouse Keeper');
    await user.click(screen.getByRole('button', { name: /Start the movie/ }));
    await screen.findByLabelText('Logline');

    await user.click(screen.getByRole('button', { name: 'Design' }));
    expect(await screen.findByText(/No places yet/)).toBeTruthy();
    await user.selectOptions(await screen.findByLabelText('Image model'), 'vendor/painter');
    await user.click(screen.getByRole('button', { name: /Add location/ }));
    const card = await screen.findByRole('article', { name: 'New location' });
    await user.type(within(card).getByLabelText('Look'), 'Round iron room.');
    await user.tab();
    await user.click(within(card).getByRole('button', { name: /Draw/ }));
    await vi.waitFor(() => {
      expect(provider.imageRequests).toHaveLength(1);
    });
    expect(provider.imageRequests[0]?.prompt).toContain('Round iron room.');

    await user.type(within(card).getByLabelText('Add view'), 'From the stairs');
    await user.click(within(card).getByRole('button', { name: /Add view/ }));
    expect(
      await within(card).findByRole('heading', { name: 'View · From the stairs' }),
    ).toBeTruthy();
    expect(within(card).getByText(/Stand-in/)).toBeTruthy();
    await user.click(within(card).getByRole('button', { name: /Draw/ }));
    await vi.waitFor(() => {
      expect(provider.imageRequests).toHaveLength(2);
    });
    // The second view is drawn to agree with the first.
    expect(provider.imageRequests[1]?.references).toHaveLength(1);
    await user.type(within(card).getByLabelText('Add state'), 'Night');
    await user.click(within(card).getByRole('button', { name: /Add state/ }));
    expect(await within(card).findByRole('heading', { name: 'State · Night' })).toBeTruthy();
    expect(
      within(card).getByRole('button', { name: 'From the stairs, Night, not drawn' }),
    ).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: /Objects/ }));
    await user.click(await screen.findByRole('button', { name: /Add object/ }));
    await screen.findByRole('article', { name: 'New object' });

    await user.click(screen.getByRole('button', { name: 'Script' }));
    await user.click(await screen.findByRole('button', { name: /Add scene/ }));
    await user.selectOptions(await screen.findByLabelText('Location'), 'New location');
    await user.selectOptions(await screen.findByLabelText('State'), 'Night');

    await user.click(screen.getByRole('button', { name: 'Shots' }));
    await user.click(await screen.findByRole('button', { name: /Add shot/ }));
    const shot = await screen.findByRole('article', { name: 'Shot 1' });
    await user.selectOptions(await within(shot).findByLabelText(/Filmed from/), 'From the stairs');
    await user.click(within(shot).getByRole('checkbox', { name: 'New object' }));
    await vi.waitFor(() => {
      expect(within(shot).getByRole('checkbox', { name: 'New object' })).toHaveProperty(
        'checked',
        true,
      );
    });
    await user.type(within(shot).getByLabelText('What we see'), 'Mara climbs into the light.');
    await user.tab();
    const paint = within(shot).getByRole('button', { name: /Paint frame/ });
    await vi.waitFor(() => {
      expect(paint).toHaveProperty('disabled', false);
    });
    await user.click(paint);
    expect(await within(shot).findByText('The clip starts exactly on this frame.')).toBeTruthy();
    expect(provider.imageRequests.at(-1)?.prompt).toContain('The first frame of a film shot');
    // The place's picture of that view guides the frame.
    expect(provider.imageRequests.at(-1)?.references).toHaveLength(1);
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

    await call('movie.character.create', {
      projectId,
      name: 'Narrator',
      voiceOnly: true,
      ownLane: true,
    });
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByText(/2 of 2 pieces ready/)).toBeTruthy();
    // A character with its own lane gets a lane, where lines are added at the playhead.
    await user.click(await screen.findByRole('button', { name: /Add a line to Narrator/ }));
    expect(await screen.findByText(/not recorded/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Narrator: New line/ })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Remove line/ }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('button', { name: /Narrator: New line/ })).toBeNull();
    });
    const first = await screen.findByRole('button', { name: /Shot 1: The lamp turns/ });
    expect(screen.getByRole('button', { name: /Shot 2: Mara at the stairs/ })).toBeTruthy();
    expect(screen.getAllByText(/0:08/).length).toBeGreaterThan(0);
    // jsdom cannot record video, so export says so instead of offering a broken button.
    // Export and help live in menus, so the picture and the timeline share one screen.
    await user.click(screen.getByRole('button', { name: /^Export/ }));
    expect(screen.getByText(/cannot record video/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Export film/ }).disabled).toBe(
      true,
    );
    await user.click(screen.getByRole('button', { name: 'Close export' }));

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

    await user.click(screen.getByRole('button', { name: 'Add to the scene' }));
    await user.click(screen.getByRole('button', { name: /Add title/ }));
    expect(await screen.findByRole('button', { name: /Title 2: Title/ })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Delete/ }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('button', { name: /Title 2: Title/ })).toBeNull();
    });

    // A piece moves by dragging it onto another; at 48 pixels a second, shot 3
    // starts at 384 and shot 1 covers 0 to 192.
    const drag = (pointerType: string) => {
      const last = screen.getByRole('button', { name: /Shot 3: Mara/ });
      const at = (clientX: number) => ({ clientX, pointerId: 2, pointerType });
      fireEvent.pointerDown(last, at(400));
      fireEvent.pointerMove(last, at(100));
      fireEvent.pointerUp(last, at(100));
    };
    // A finger on a piece that is not selected scrolls instead of moving it.
    drag('touch');
    expect(screen.getByRole('button', { name: /Shot 3: Mara/ })).toBeTruthy();
    drag('mouse');
    expect(await screen.findByRole('button', { name: /Shot 1: Mara/ })).toBeTruthy();
  });

  it('manages projects from the start screen: templates, duplicates, export, import, delete', async () => {
    const { imp, user } = start();
    await completeSetup(user);
    const call = async (id: string, input: unknown) => {
      const result = await imp.registry.executeById(id, input, {
        actor: { kind: 'user', id: 'local' },
      });
      return (result as { output: Record<string, unknown> }).output;
    };

    await user.click(screen.getByRole('button', { name: 'New project' }));
    await user.type(await screen.findByLabelText('Working title'), 'Storm');
    await user.click(screen.getByRole('radio', { name: 'Short film' }));
    await user.click(screen.getByRole('button', { name: /Create project/ }));
    await screen.findByRole('heading', { name: 'Development' });
    await user.click(screen.getByRole('button', { name: 'Projects' }));
    expect(await screen.findByRole('heading', { name: 'Storm' })).toBeTruthy();
    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getAllByText('0/5').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Duplicate: Storm' }));
    expect(await screen.findByRole('heading', { name: 'Storm (2)' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Rename: Storm (2)' }));
    const field = screen.getByLabelText('Project name');
    await user.clear(field);
    await user.type(field, 'Squall{Enter}');
    expect(await screen.findByRole('heading', { name: 'Squall' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Save as template: Squall' }));
    await user.click(await screen.findByRole('button', { name: /Save template/ }));
    expect(await screen.findByText(/Saved the template “Squall template”/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Your templates' })).toBeTruthy();

    // Export hands the file over and removes it from the store.
    let saved = 0;
    HTMLAnchorElement.prototype.click = () => {
      saved += 1;
    };
    await user.click(screen.getByRole('button', { name: 'Export to a file: Squall' }));
    expect(await screen.findByText(/Saved Squall\.imp\.zip/)).toBeTruthy();
    expect(saved).toBe(1);
    expect(await imp.blobs.list('exports/')).toEqual([]);

    // Import a file made by export.
    const projects = (await call('project.list', {}))['projects'] as { id: string; name: string }[];
    const squall = projects.find((p) => p.name === 'Squall');
    const exported = await call('project.export', { projectId: squall?.id });
    const file = await imp.blobs.get(String(exported['fileKey']));
    const picked = new File([file?.bytes.slice() ?? new Uint8Array()], 'Squall.imp.zip', {
      type: 'application/zip',
    });
    await user.upload(screen.getByLabelText('Project file to import'), picked);
    expect(await screen.findByRole('heading', { name: 'Squall (2)' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Delete: Squall (2)' }));
    await user.click(await screen.findByRole('button', { name: /Delete for good/ }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Squall (2)' })).toBeNull();
    });
    await user.click(screen.getByRole('button', { name: 'Delete template Squall template' }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Your templates' })).toBeNull();
    });
  });

  it('copies between projects and puts collisions to the person, also when an agent copies', async () => {
    const { imp, user } = start();
    await completeSetup(user);
    const call = async (
      id: string,
      input: unknown,
      actor: Record<string, string> = { kind: 'user', id: 'local' },
    ) => {
      const result = await imp.registry.executeById(id, input, { actor: actor as never });
      return (result as { output: Record<string, unknown> }).output;
    };
    const a = await call('project.create', { name: 'Keeper', mode: 'movie' });
    const b = await call('project.create', { name: 'Tide', mode: 'movie' });
    await call('movie.character.create', { projectId: a['id'], name: 'Mara' });
    await call('movie.character.create', { projectId: a['id'], name: 'Tomas' });
    await call('movie.character.create', { projectId: b['id'], name: 'Mara' });

    await user.click(await screen.findByRole('button', { name: 'Copy between projects' }));
    await user.selectOptions(screen.getByLabelText('From', { exact: true }), 'Keeper');
    await user.selectOptions(screen.getByLabelText('Into', { exact: true }), 'Tide');
    await user.click(await screen.findByRole('checkbox', { name: /^Tomas/ }));
    await user.click(screen.getByRole('button', { name: /^Copy 1/ }));
    expect(await screen.findByText(/Copied 1 into “Tide”/)).toBeTruthy();

    // An agent asks; the question comes to the person.
    const cast = (await call('movie.character.list', { projectId: a['id'] }))['characters'] as {
      id: string;
      name: string;
    }[];
    const maraId = cast.find((c) => c.name === 'Mara')?.id;
    const asked = await call(
      'project.resources.copy',
      {
        fromProjectId: a['id'],
        toProjectId: b['id'],
        items: [{ kind: 'character', id: maraId }],
        note: 'Mara appears in the sequel.',
      },
      { kind: 'agent', id: 'c', role: 'casting-director' },
    );
    expect(asked['status']).toBe('waiting-for-person');
    const dialog = await screen.findByRole('dialog', { name: 'Already in the target' });
    expect(within(dialog).getByText(/Casting director wants to copy/)).toBeTruthy();
    expect(within(dialog).getByText('Mara appears in the sequel.')).toBeTruthy();
    expect(within(dialog).getByRole('radio', { name: 'Keep both' })).toHaveProperty(
      'checked',
      true,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Skip' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Overwrite' }));
    await user.click(within(dialog).getByRole('button', { name: 'Copy' }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Already in the target' })).toBeNull();
    });
    const request = await call('project.resources.request.get', { requestId: asked['requestId'] });
    expect(request['status']).toBe('done');
    expect((request['outcomes'] as { outcome: string }[])[0]?.outcome).toBe('overwritten');

    // Cancelling also answers it.
    const again = await call('project.resources.copy', {
      fromProjectId: a['id'],
      toProjectId: b['id'],
      items: [{ kind: 'character', id: maraId }],
    });
    await user.click(await screen.findByRole('button', { name: 'Cancel the copy' }));
    await vi.waitFor(async () => {
      expect(
        (await call('project.resources.request.get', { requestId: again['requestId'] }))['status'],
      ).toBe('cancelled');
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

  it('opens an audio document and edits its tracks with undo', async () => {
    const { user } = start();
    await completeSetup(user);
    await user.click(screen.getByRole('button', { name: 'Development' }));
    await user.type(await screen.findByLabelText('Working title'), 'The Lighthouse Keeper');
    await user.click(screen.getByRole('button', { name: /Start the movie/ }));
    await screen.findByLabelText('Logline');

    await user.click(screen.getByRole('button', { name: 'Audio' }));
    expect(await screen.findByText(/No sounds are recorded yet/)).toBeTruthy();
    await user.type(screen.getByLabelText('Name'), 'Lamp room');
    await user.click(screen.getByRole('button', { name: /Start empty/ }));
    expect(await screen.findByRole('tab', { name: 'Lamp room' })).toBeTruthy();
    expect(await screen.findByText('1 track')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Add track/ }));
    expect(await screen.findByText('2 tracks')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Mute Track 2' }));
    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: 'Mute Track 2' })).toHaveProperty(
        'ariaPressed',
        'true',
      );
    });
    expect(await screen.findByRole('heading', { name: 'Audio' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: 'Mute Track 2' })).toHaveProperty(
        'ariaPressed',
        'false',
      );
    });
    expect(screen.getByRole('button', { name: 'Play' })).toHaveProperty('disabled', true);
  });

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
    await screen.findByRole('option', { name: 'vendor/painter' });
    await user.selectOptions(within(bar).getByLabelText('Image model'), 'vendor/painter');
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
    await screen.findByRole('option', { name: 'vendor/painter' });
    await user.selectOptions(screen.getByLabelText('Image model'), 'vendor/painter');

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
