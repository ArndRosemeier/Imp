import {
  CommandRegistry,
  defineCommand,
  readActivity,
  settingsCommands,
  type ExecutionPolicy,
} from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { ProviderError, type ToolCall } from '@imp/providers';
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
        usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.01 },
      },
      {
        content: 'The theme is dark now.',
        usage: { promptTokens: 20, completionTokens: 5, costUsd: 0.02 },
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
    expect(first?.messages[1]).toEqual({ role: 'user', content: 'Set the theme to dark.' });
    expect(first?.tools?.map((tool) => tool.function.name)).toEqual([
      'media__generate',
      'settings__get',
      'settings__list',
      'settings__set',
    ]);
    // The second request carries the tool result back to the model.
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool' });
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
      { error: '"vault__read" is not a tool you have.' },
      { error: '"made__up" is not a tool you have.' },
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
    const usage = { promptTokens: 1, completionTokens: 1, costUsd: 0.6 };
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
      { content: 'Hi.', usage: { promptTokens: 1, completionTokens: 1, costUsd: null } },
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
});
