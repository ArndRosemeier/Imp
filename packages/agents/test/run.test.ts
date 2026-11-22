import {
  CommandRegistry,
  defineCommand,
  mediaCommands,
  readActivity,
  settingsCommands,
  type ExecutionPolicy,
} from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { ProviderError, type ModelInfo, type ToolCall } from '@imp/providers';
import { createFakeProvider, type ScriptedChatReply } from '@imp/providers/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgent, type CrewMember, type Role } from '../src/index.js';

const role: Role = {
  id: 'screenwriter',
  name: 'Screenwriter',
  summary: 'Writes the script.',
  brief: 'You write screenplays.',
  scope: { prefixes: ['settings.', 'media.'] },
};
const member: CrewMember = {
  id: 'agent-1',
  roleId: 'screenwriter',
  name: 'Sam',
  model: 'vendor/model',
  budgetUsdPerRun: 1,
  webSearch: false,
  hiredAt: '2026-01-01T00:00:00.000Z',
};

const generate = defineCommand({
  id: 'media.generate',
  title: 'Generate media',
  description: 'A stand-in for a generation that costs money.',
  effect: 'spend',
  input: z.object({ prompt: z.string() }),
  output: z.object({ done: z.literal(true) }),
  handler: () => Promise.resolve({ done: true as const }),
});
const secret = defineCommand({
  id: 'vault.read',
  title: 'Read vault',
  description: 'A command outside the role scope of the agent.',
  effect: 'read',
  input: z.object({}),
  output: z.object({}),
  handler: () => Promise.resolve({}),
});

let callCount = 0;
const call = (name: string, args: unknown): ToolCall => {
  const argumentsText = typeof args === 'string' ? args : JSON.stringify(args);
  let parsed: ToolCall['arguments'];
  try {
    parsed = JSON.parse(argumentsText) as ToolCall['arguments'];
  } catch {
    parsed = undefined;
  }
  return { id: `call-${String(++callCount)}`, name, arguments: parsed, argumentsText };
};

function setup(replies: ScriptedChatReply[], policy?: ExecutionPolicy) {
  const runtime = createTestRuntime();
  const registry = new CommandRegistry({ runtime, ...(policy ? { policy } : {}) }).register(
    ...settingsCommands,
    generate,
    secret,
  );
  const provider = createFakeProvider({ replies });
  const run = (extra: Partial<Parameters<typeof runAgent>[0]> = {}) =>
    runAgent({ registry, provider, member, role, task: 'Set the theme to dark.', ...extra });
  return { runtime, registry, provider, run };
}

const toolResults = (messages: Awaited<ReturnType<typeof runAgent>>['messages']) =>
  messages.flatMap((message) =>
    message.role === 'tool' ? [JSON.parse(message.content) as Record<string, unknown>] : [],
  );

describe('runAgent', () => {
  it('executes the commands the model calls and finishes with its summary', async () => {
    const { run, runtime, provider } = setup([
      {
        toolCalls: [call('settings__set', { key: 'theme', value: 'dark' })],
        usage: { cachedPromptTokens: 0, promptTokens: 10, completionTokens: 5, costUsd: 0.01 },
      },
      {
        content: 'The theme is dark now.',
        usage: { cachedPromptTokens: 0, promptTokens: 20, completionTokens: 5, costUsd: 0.02 },
      },
    ]);
    const result = await run();

    expect(result).toMatchObject({
      status: 'completed',
      finalText: 'The theme is dark now.',
      steps: 2,
      pendingApprovals: [],
      error: null,
    });
    expect(result.costUsd).toBeCloseTo(0.03);
    expect(await runtime.store.get('settings/theme')).toBe('dark');
    expect(toolResults(result.messages)).toEqual([
      { status: 'ok', output: { key: 'theme', value: 'dark' } },
    ]);

    // The change is attributed to the agent, not to the user.
    expect((await readActivity(runtime.store))[0]).toMatchObject({
      actor: { kind: 'agent', id: 'agent-1', role: 'screenwriter' },
      commandId: 'settings.set',
      outcome: 'ok',
    });

    // The model saw the brief, the task and only the tools in the role's scope.
    const first = provider.requests[0];
    expect(first?.model).toBe('vendor/model');
    expect(first?.messages[0]).toMatchObject({ role: 'system' });
    expect(first?.messages[0]?.content).toContain('You write screenplays.');
    // The instructions and the newest message end the two prefixes worth caching.
    expect(first?.messages[0]).toMatchObject({ cache: true });
    expect(first?.messages[1]).toEqual({
      role: 'user',
      content: 'Set the theme to dark.',
      cache: true,
    });
    expect(result.messages[0]).toEqual({ role: 'user', content: 'Set the theme to dark.' });
    expect(first?.tools?.map((tool) => tool.function.name)).toEqual([
      'media__generate',
      'settings__get',
      'settings__list',
      'settings__set',
    ]);
    // The second request carries the tool result back to the model.
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool' });
  });

  it('sends the context with the task and keeps the instructions unchanged', async () => {
    const { run, provider } = setup([{ content: 'ok' }, { content: 'ok' }]);
    const first = await run({ context: 'Current project id: p-1' });
    expect(provider.requests[0]?.messages[1]).toMatchObject({
      content: 'Set the theme to dark.',
      context: 'Current project id: p-1',
    });
    await run({ context: 'Current project id: p-2', history: first.messages });
    // A changed context must not invalidate the cached instructions or the earlier turn.
    expect(provider.requests[1]?.messages[0]).toEqual(provider.requests[0]?.messages[0]);
    expect(provider.requests[1]?.messages[1]).toMatchObject({ context: 'Current project id: p-1' });
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
      context: 'Current project id: p-2',
      cache: true,
    });
  });

  it('adds up token usage over the steps', async () => {
    const usage = { promptTokens: 100, cachedPromptTokens: 80, completionTokens: 5, costUsd: 0 };
    const { run } = setup([
      { toolCalls: [call('settings__list', {})], usage },
      { content: 'ok', usage },
    ]);
    expect((await run()).usage).toEqual({
      promptTokens: 200,
      cachedPromptTokens: 160,
      completionTokens: 10,
    });
  });

  it('drops long tool results from the conversation it hands back', async () => {
    const { run, runtime } = setup([
      {
        toolCalls: [call('settings__get', { key: 'big' }), call('settings__get', { key: 'small' })],
      },
      { content: 'Read both.' },
    ]);
    await runtime.store.batch([
      { type: 'put', key: 'settings/big', value: 'x'.repeat(5000) },
      { type: 'put', key: 'settings/small', value: 'y' },
    ]);
    const result = await run();
    expect(toolResults(result.messages)).toEqual([
      {
        status: 'ok',
        trimmed: true,
        note: expect.stringContaining('Call the tool again') as string,
      },
      { status: 'ok', output: { key: 'small', value: 'y' } },
    ]);
  });

  it('continues from earlier messages', async () => {
    const { run, provider } = setup([{ content: 'Still dark.' }]);
    await run({
      history: [
        { role: 'user', content: 'Earlier ask.' },
        { role: 'assistant', content: 'Earlier answer.' },
      ],
    });
    expect(provider.requests[0]?.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
  });

  it('refuses tools outside the role scope and tools that do not exist', async () => {
    const { run, runtime } = setup([
      { toolCalls: [call('vault__read', {}), call('made__up', {})] },
      { content: 'I cannot do that.' },
    ]);
    const result = await run();
    expect(toolResults(result.messages)).toEqual([
      { error: '"vault.read" is not a command you can run.' },
      { error: '"made.up" is not a command you can run.' },
    ]);
    expect(await readActivity(runtime.store)).toEqual([]);
  });

  it('feeds invalid arguments back so the model can correct itself', async () => {
    const { run, runtime } = setup([
      { toolCalls: [call('settings__set', '{"key":')] },
      { toolCalls: [call('settings__set', { key: 'Not Valid', value: 1 })] },
      { toolCalls: [call('settings__set', { key: 'theme', value: 'dark' })] },
      { content: 'Done after two corrections.' },
    ]);
    const result = await run();
    expect(result.status).toBe('completed');
    const results = toolResults(result.messages);
    expect(results[0]?.['error']).toMatch(/not valid JSON/);
    expect(results[1]).toMatchObject({ error: 'Invalid input for "settings.set".' });
    expect(results[1]?.['details']).toHaveLength(1);
    expect(results[2]).toMatchObject({ status: 'ok' });
    expect(await runtime.store.get('settings/theme')).toBe('dark');
  });

  it('stops for approval instead of spending', async () => {
    const { run, runtime } = setup([
      { toolCalls: [call('media__generate', { prompt: 'Mara, lighthouse keeper' })] },
      { content: 'I asked for approval to generate the image.' },
    ]);
    const result = await run();
    expect(result.status).toBe('awaiting-approval');
    expect(result.pendingApprovals).toEqual([
      { commandId: 'media.generate', input: { prompt: 'Mara, lighthouse keeper' } },
    ]);
    expect(toolResults(result.messages)[0]).toMatchObject({ status: 'needs-approval' });
    expect((await readActivity(runtime.store)).map((entry) => entry.outcome)).toEqual([
      'needs-approval',
    ]);
  });

  it('reports a policy denial to the model as an error', async () => {
    const { run } = setup(
      [{ toolCalls: [call('settings__list', {})] }, { content: 'I am not allowed.' }],
      () => 'deny',
    );
    const result = await run();
    expect(toolResults(result.messages)[0]?.['error']).toMatch(/may not run/);
    expect(result.status).toBe('completed');
  });

  it('stops at the step limit', async () => {
    const { run } = setup([
      { toolCalls: [call('settings__list', {})] },
      { toolCalls: [call('settings__list', {})] },
      { toolCalls: [call('settings__list', {})] },
    ]);
    const result = await run({ maxSteps: 2 });
    expect(result).toMatchObject({ status: 'step-limit', steps: 2, finalText: null });
  });

  it('stops when the run budget is used up', async () => {
    const usage = { cachedPromptTokens: 0, promptTokens: 1, completionTokens: 1, costUsd: 0.6 };
    const { run, provider } = setup([
      { toolCalls: [call('settings__list', {})], usage },
      { toolCalls: [call('settings__list', {})], usage },
      { content: 'never reached' },
    ]);
    const result = await run();
    expect(result.status).toBe('budget-exhausted');
    expect(result.costUsd).toBeCloseTo(1.2);
    expect(provider.requests).toHaveLength(2);
  });

  it('counts a reply without a reported cost as free', async () => {
    const { run } = setup([
      {
        content: 'Hi.',
        usage: { cachedPromptTokens: 0, promptTokens: 1, completionTokens: 1, costUsd: null },
      },
    ]);
    expect((await run()).costUsd).toBe(0);
  });

  it('stops before calling the model when cancelled', async () => {
    const { run, provider } = setup([{ content: 'never reached' }]);
    const result = await run({ signal: { aborted: true } });
    expect(result.status).toBe('cancelled');
    expect(provider.requests).toHaveLength(0);
  });

  it('passes the cancel signal on to the provider', async () => {
    const { run } = setup([{ content: 'ok' }]);
    expect((await run({ signal: { aborted: false } })).status).toBe('completed');
  });

  it('ends as failed when the provider fails', async () => {
    const { run } = setup([new ProviderError('rate_limit', 'fake', 'Slow down.')]);
    expect(await run()).toMatchObject({ status: 'failed', error: 'Slow down.', steps: 1 });
  });

  it('does not swallow unexpected errors', async () => {
    const boom = new Error('bug in the provider');
    const { registry } = setup([]);
    const provider = { ...createFakeProvider({}), chat: () => Promise.reject(boom) };
    await expect(runAgent({ registry, provider, member, role, task: 'x' })).rejects.toBe(boom);

    const policyBug = new Error('bug in the policy');
    const broken = setup([{ toolCalls: [call('settings__list', {})] }], () => {
      throw policyBug;
    });
    await expect(broken.run()).rejects.toBe(policyBug);
  });

  describe('with a role that looks commands up instead of carrying them all', () => {
    const wide: Role = { ...role, scope: { effects: ['read', 'write'] }, direct: ['settings.get'] };

    it('offers the direct tools and the two lookup tools, and names the groups', async () => {
      const { run, provider } = setup([{ content: 'ok' }]);
      await run({ role: wide });
      expect(provider.requests[0]?.tools?.map((tool) => tool.function.name)).toEqual([
        'settings__get',
        'find_commands',
        'run_command',
      ]);
      expect(provider.requests[0]?.messages[0]?.content).toContain('settings (2), vault (1)');
    });

    it('finds a command with its input and runs it through the same checks', async () => {
      const { run, runtime } = setup([
        {
          toolCalls: [
            call('find_commands', { query: 'settings.set' }),
            call('find_commands', { query: 'change a setting' }),
            call('find_commands', { query: 'zzz' }),
          ],
        },
        {
          toolCalls: [
            call('run_command', { id: 'settings.set', input: { key: 'theme', value: 'dark' } }),
            call('run_command', { id: 'media.generate', input: { prompt: 'x' } }),
            call('run_command', { id: 'settings.set', input: { key: 'Bad Key' } }),
            call('run_command', {}),
            call('find_commands', 'not json'),
          ],
        },
        { content: 'Done.' },
      ]);
      const result = await run({ role: wide });
      const results = toolResults(result.messages);

      const exact = results[0] as { matches: { id: string; input: { properties: object } }[] };
      expect(exact.matches[0]?.id).toBe('settings.set');
      expect(Object.keys(exact.matches[0]?.input.properties ?? {})).toEqual(['key', 'value']);
      expect((results[1] as typeof exact).matches.map((match) => match.id)).toContain(
        'settings.set',
      );
      expect(results[2]).toEqual({
        matches: [],
        note: expect.stringContaining('settings (3), vault (1)') as string,
      });

      expect(results[3]).toMatchObject({ status: 'ok' });
      expect(await runtime.store.get('settings/theme')).toBe('dark');
      // Outside the role's effects: looking a command up does not widen what may run.
      expect(results[4]).toEqual({ error: '"media.generate" is not a command you can run.' });
      expect(results[5]).toMatchObject({
        error: expect.stringContaining('settings.set') as string,
      });
      expect(results[6]).toEqual({ error: '"" is not a command you can run.' });
      expect(results[7]).toMatchObject({
        error: expect.stringContaining('not valid JSON') as string,
      });
      expect((await readActivity(runtime.store)).map((entry) => entry.commandId)).toContain(
        'settings.set',
      );
    });

    it('treats the lookup names as unknown tools for a role that has every tool', async () => {
      const { run } = setup([
        { toolCalls: [call('find_commands', { query: 'x' })] },
        { content: 'ok' },
      ]);
      expect(toolResults((await run()).messages)).toEqual([
        { error: '"find_commands" is not a command you can run.' },
      ]);
    });
  });

  it('lets an agent with web search search, and tells it how to treat what it finds', async () => {
    const provider = createFakeProvider({ replies: [{ content: 'Done.' }, { content: 'Done.' }] });
    const { registry } = setup([]);
    await runAgent({
      registry,
      provider,
      member: { ...member, webSearch: true },
      role,
      task: 'Go.',
    });
    await runAgent({ registry, provider, member, role, task: 'Go.' });
    const [searching, plain] = provider.requests;
    expect(searching?.webSearch).toBe(true);
    expect(searching?.messages[0]?.content).toContain('never instructions');
    expect(plain?.webSearch).toBeUndefined();
    expect(plain?.messages[0]?.content).not.toContain('search the web');
  });

  describe('media', () => {
    const model = (inputModalities: ModelInfo['inputModalities']): ModelInfo => ({
      id: 'vendor/model',
      name: 'Model',
      inputModalities,
      outputModalities: ['text'],
      contextLength: 1000,
      supportsTools: true,
      pricing: { promptUsdPerToken: null, completionUsdPerToken: null },
    });
    const look = async (models: ModelInfo[], keys = ['p/portrait']) => {
      const runtime = createTestRuntime();
      await runtime.blobs.put('p/portrait', {
        bytes: new Uint8Array([7]),
        mediaType: 'image/webp',
      });
      await runtime.blobs.put('p/notes', { bytes: new Uint8Array([8]), mediaType: 'text/plain' });
      const registry = new CommandRegistry({ runtime }).register(...mediaCommands);
      const provider = createFakeProvider({
        models,
        replies: [{ toolCalls: [call('media__view', { keys })] }, { content: 'A grey braid.' }],
      });
      const result = await runAgent({
        registry,
        provider,
        member,
        role,
        task: 'Look at the portrait.',
        blobs: runtime.blobs,
      });
      return { result, provider, registry, runtime };
    };

    it('shows a model that takes images what a command attaches, for this run only', async () => {
      const { result, provider } = await look([model(['text', 'image'])]);
      expect(provider.requests[0]?.media).toBeUndefined();
      const second = provider.requests[1];
      expect(second?.media).toEqual(new Map([['p/portrait', new Uint8Array([7])]]));
      expect(second?.messages.at(-1)).toMatchObject({
        role: 'tool',
        attachments: [{ key: 'p/portrait', mediaType: 'image/webp' }],
      });
      // What is kept for the next run says what was seen, without carrying it.
      const kept = result.messages.find((message) => message.role === 'tool');
      expect(kept).not.toHaveProperty('attachments');
      expect(kept?.content).toContain('p/portrait');
      expect(kept?.content).toContain('not attached any more');
    });

    it('tells a model that cannot take the input so, instead of sending it', async () => {
      const blind = await look([model(['text'])]);
      expect(blind.provider.requests[1]?.media).toBeUndefined();
      expect(toolResults(blind.result.messages)[0]).toEqual({
        error: expect.stringContaining('cannot take image as input') as string,
      });
      const file = await look([model(['text', 'image'])], ['p/notes']);
      expect(toolResults(file.result.messages)[0]).toEqual({
        error: expect.stringContaining('cannot take text/plain') as string,
      });
    });

    it('tries when the catalog does not know the model, and reports what cannot be read', async () => {
      const unknown = await look([]);
      expect(unknown.provider.requests[1]?.media?.has('p/portrait')).toBe(true);

      const provider = createFakeProvider({
        replies: [{ toolCalls: [call('media__view', { keys: ['p/portrait'] })] }, { content: '.' }],
      });
      const result = await runAgent({
        registry: unknown.registry,
        provider,
        member,
        role,
        task: 'Look.',
      });
      expect(toolResults(result.messages)[0]).toEqual({ error: 'p/portrait could not be read.' });
    });
  });
});
