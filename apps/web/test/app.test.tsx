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
import { createImp } from '../src/host/imp.js';
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

function start(replies: readonly ScriptedChatReply[] = []) {
  const provider = createFakeProvider({
    replies,
    models: [
      model('vendor/writer'),
      model('~vendor/latest'),
      model('vendor/painter', { outputModalities: ['image'] }),
      model('vendor/no-tools', { supportsTools: false }),
    ],
  });
  const imp = createImp({
    store: new MemoryKeyValueStore(),
    secrets: createLocalSecretStore(),
    provider,
  });
  render(<App imp={imp} />);
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

  it('derives form fields from a command schema and builds its input', () => {
    const fields = fieldsOf(
      createImp({
        store: new MemoryKeyValueStore(),
        secrets: createLocalSecretStore(),
        provider: createFakeProvider({}),
      }).registry.get('crew.hire'),
    );
    expect(fields.map(({ name, kind, required }) => ({ name, kind, required }))).toEqual([
      { name: 'roleId', kind: 'string', required: true },
      { name: 'model', kind: 'string', required: true },
      { name: 'name', kind: 'string', required: false },
      { name: 'budgetUsdPerRun', kind: 'number', required: false },
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
    render(<App imp={imp} />);
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
});
