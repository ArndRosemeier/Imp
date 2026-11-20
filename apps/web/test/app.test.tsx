// @vitest-environment jsdom
import { MemoryKeyValueStore, settingsGet } from '@imp/core';
import type { ModelInfo } from '@imp/providers';
import { createFakeProvider, type ScriptedChatReply } from '@imp/providers/testing';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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
});
