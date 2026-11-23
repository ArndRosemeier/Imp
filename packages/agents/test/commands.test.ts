import {
  CommandRegistry,
  defineCommand,
  readActivity,
  settingsCommands,
  type JsonValue,
} from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { ProviderError } from '@imp/providers';
import { createFakeProvider, type ScriptedChatReply } from '@imp/providers/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AgentRunSchema,
  alwaysAllowed,
  ConversationSchema,
  coordinatorRole,
  COORDINATOR_WRITES,
  createAgentCommands,
  createCrewCommands,
  releaseInterruptedRuns,
  RoleCatalog,
  type Role,
} from '../src/index.js';

const user = { kind: 'user', id: 'arnd' } as const;
const artist: Role = {
  id: 'artist',
  name: 'Artist',
  summary: 'Makes images.',
  brief: 'You make images.',
  scope: { prefixes: ['media.'] },
};
const generate = defineCommand({
  id: 'media.generate',
  title: 'Generate media',
  description: 'A stand-in for a generation that costs money.',
  effect: 'spend',
  input: z.object({ prompt: z.string() }),
  output: z.object({ url: z.string() }),
  handler: (_context, { prompt }) => Promise.resolve({ url: `made:${prompt}` }),
});

function setup(replies: ScriptedChatReply[], roles = [coordinatorRole, artist]) {
  const runtime = createTestRuntime();
  const provider = createFakeProvider({ replies });
  const catalog = new RoleCatalog(roles);
  const registry = new CommandRegistry({ runtime, autoApprove: alwaysAllowed });
  registry.register(
    ...settingsCommands,
    generate,
    ...createCrewCommands(new RoleCatalog([coordinatorRole, artist])),
    ...createAgentCommands({ registry, provider, roles: catalog }),
  );
  const run = async (
    id: string,
    input: unknown,
    actor: Parameters<typeof registry.executeById>[2]['actor'] = user,
  ) => {
    const result = await registry.executeById(id, input, { actor });
    if (result.status !== 'ok') {
      throw new Error(`Expected ok, got ${result.status}`);
    }
    return result.output;
  };
  const hire = async (roleId: string) =>
    (await run('crew.hire', { roleId, model: 'vendor/model' })) as { id: string };
  const conversation = async (memberId: string) =>
    ConversationSchema.parse(await run('crew.conversation.get', { memberId }));
  return { runtime, registry, provider, run, hire, conversation };
}

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonValue;

const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  name,
  arguments: args as never,
  argumentsText: JSON.stringify(args),
});

describe('crew.ask', () => {
  it('runs the agent, keeps the conversation and continues it on the next task', async () => {
    const { run, hire, runtime, provider, conversation } = setup([
      { toolCalls: [toolCall('c1', 'settings__set', { key: 'theme', value: 'dark' })] },
      { content: 'Theme set.' },
      { content: 'It is still dark.' },
    ]);
    const coordinator = await hire('coordinator');
    expect(await conversation(coordinator.id)).toMatchObject({ messages: [], running: false });

    const first = AgentRunSchema.parse(
      await run('crew.ask', {
        memberId: coordinator.id,
        task: 'Make it dark.',
        context: 'Project: p-1',
      }),
    );
    expect(first).toMatchObject({ status: 'completed', finalText: 'Theme set.', steps: 2 });
    // The outcome does not carry the messages; they are read from the conversation.
    expect(first).not.toHaveProperty('messages');
    expect(await runtime.store.get('settings/theme')).toBe('dark');
    expect(provider.requests[0]?.messages[1]).toMatchObject({ context: 'Project: p-1' });

    const second = AgentRunSchema.parse(
      await run('crew.ask', { memberId: coordinator.id, task: 'And now?' }),
    );
    expect(second.finalText).toBe('It is still dark.');
    // The continued run sent the whole earlier conversation, tool calls included.
    expect(provider.requests[2]?.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);
    expect(provider.requests[2]?.messages[2]).toMatchObject({ toolCalls: [{ id: 'c1' }] });

    const stored = await conversation(coordinator.id);
    expect(stored).toMatchObject({ running: false, lastStatus: 'completed', lastError: null });
    expect(stored.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('stores the conversation while the agent works', async () => {
    const { run, hire, runtime } = setup([
      { toolCalls: [toolCall('c1', 'settings__list', {})] },
      { content: 'Done.' },
    ]);
    const coordinator = await hire('coordinator');
    const seen: [boolean, number][] = [];
    runtime.store.subscribe('conversations/', (changes) => {
      for (const change of changes) {
        if (change.type === 'put') {
          const stored = ConversationSchema.parse(change.value);
          seen.push([stored.running, stored.messages.length]);
        }
      }
    });
    await run('crew.ask', { memberId: coordinator.id, task: 'Look around.' });
    expect(seen).toEqual([
      [true, 1],
      [true, 3],
      [true, 4],
      [false, 4],
    ]);
  });

  it('retries a failed run without repeating the message', async () => {
    const { run, hire, provider, conversation } = setup([
      new ProviderError('network', 'fake', 'Imp could not reach OpenRouter.'),
      { content: 'Here it is.' },
    ]);
    const coordinator = await hire('coordinator');
    const failed = AgentRunSchema.parse(
      await run('crew.ask', { memberId: coordinator.id, task: 'Write a logline.' }),
    );
    expect(failed).toMatchObject({ status: 'failed', error: 'Imp could not reach OpenRouter.' });
    expect(await conversation(coordinator.id)).toMatchObject({
      lastStatus: 'failed',
      messages: [{ role: 'user', content: 'Write a logline.' }],
    });

    // Without a task, the run goes again from the message that never got an answer.
    const retried = AgentRunSchema.parse(await run('crew.ask', { memberId: coordinator.id }));
    expect(retried).toMatchObject({ status: 'completed', finalText: 'Here it is.' });
    expect(provider.requests[1]?.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
    ]);
    const stored = await conversation(coordinator.id);
    expect(stored).toMatchObject({ lastStatus: 'completed', lastError: null });
    expect(stored.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('records a failed run and adds up what the conversation cost', async () => {
    const usage = { promptTokens: 10, cachedPromptTokens: 4, completionTokens: 2, costUsd: 0.01 };
    const { run, hire, conversation } = setup([
      { content: 'One.', usage },
      { content: 'Two.', usage },
      new ProviderError('rate_limit', 'fake', 'Slow down.'),
    ]);
    const coordinator = await hire('coordinator');
    await run('crew.ask', { memberId: coordinator.id, task: 'a' });
    await run('crew.ask', { memberId: coordinator.id, task: 'b' });
    expect(await conversation(coordinator.id)).toMatchObject({
      costUsd: 0.02,
      usage: { promptTokens: 20, cachedPromptTokens: 8, completionTokens: 4 },
    });
    expect(await run('crew.ask', { memberId: coordinator.id, task: 'c' })).toMatchObject({
      status: 'failed',
    });
    expect(await conversation(coordinator.id)).toMatchObject({
      lastStatus: 'failed',
      lastError: 'Slow down.',
      running: false,
    });
  });

  it('never leaves an agent marked as working, and a host can release stale marks', async () => {
    const { run, hire, runtime, registry, conversation } = setup([]);
    const coordinator = await hire('coordinator');
    const boom = new Error('bug');
    const broken = createAgentCommands({
      registry,
      provider: { ...createFakeProvider({}), chat: () => Promise.reject(boom) },
      roles: new RoleCatalog([coordinatorRole]),
    });
    const ask = broken.find((command) => command.id === 'crew.ask');
    await expect(
      ask?.run({ actor: user, runtime }, { memberId: coordinator.id, task: 'x' }),
    ).rejects.toMatchObject({ code: 'handler_failed', cause: boom });
    expect((await conversation(coordinator.id)).running).toBe(false);

    const stale = { ...(await conversation(coordinator.id)), running: true };
    await runtime.store.batch([
      { type: 'put', key: `conversations/${coordinator.id}`, value: json(stale) },
    ]);
    await expect(run('crew.ask', { memberId: coordinator.id, task: 'x' })).rejects.toThrow(
      /already working/,
    );
    await releaseInterruptedRuns(runtime.store);
    expect(await conversation(coordinator.id)).toMatchObject({
      running: false,
      lastStatus: 'cancelled',
    });
  });

  it('continues a run that was cut off after a command ran', async () => {
    const { run, hire, runtime, conversation } = setup([{ content: 'Done with the rest.' }]);
    const coordinator = await hire('coordinator');
    const cut = {
      ...(await conversation(coordinator.id)),
      running: true,
      messages: [
        { role: 'user', content: 'Make two pictures.' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [toolCall('c1', 'settings_get', { key: 'x' })],
        },
        { role: 'tool', toolCallId: 'c1', content: '{"status":"ok"}' },
      ],
    };
    await runtime.store.batch([
      { type: 'put', key: `conversations/${coordinator.id}`, value: json(cut) },
    ]);
    await releaseInterruptedRuns(runtime.store);
    const result = (await run('crew.ask', { memberId: coordinator.id })) as { finalText: string };
    expect(result.finalText).toBe('Done with the rest.');
    expect(await conversation(coordinator.id)).toMatchObject({ lastStatus: 'completed' });
  });

  it('continues a run that stopped at its step limit with its summary', async () => {
    const { run, hire, runtime, conversation, provider } = setup([
      { content: 'Finished the second half.' },
    ]);
    const coordinator = await hire('coordinator');
    const stopped = {
      ...(await conversation(coordinator.id)),
      lastStatus: 'step-limit',
      messages: [
        { role: 'user', content: 'Write the script.' },
        { role: 'assistant', content: 'Half is written; the rest is left.' },
      ],
    };
    await runtime.store.batch([
      { type: 'put', key: `conversations/${coordinator.id}`, value: json(stopped) },
    ]);
    const result = (await run('crew.ask', { memberId: coordinator.id })) as { finalText: string };
    expect(result.finalText).toBe('Finished the second half.');
    expect(provider.requests.at(-1)?.messages.at(-1)?.content).toMatch(/Continue the task/);
  });

  it('is a spending command, so an agent cannot start another agent unasked', async () => {
    const { registry, hire } = setup([]);
    const coordinator = await hire('coordinator');
    const result = await registry.executeById(
      'crew.ask',
      { memberId: coordinator.id, task: 'x' },
      { actor: { kind: 'agent', id: 'someone', role: 'coordinator' } },
    );
    expect(result.status).toBe('needs-approval');
  });

  it('refuses an unknown member, a member whose role is gone and a task to oneself', async () => {
    const { run, registry, hire } = setup([]);
    await expect(run('crew.ask', { memberId: 'nobody', task: 'x' })).rejects.toThrow(
      /No crew member/,
    );
    const withoutArtist = setup([], [coordinatorRole]);
    const orphan = await withoutArtist.hire('artist');
    await expect(withoutArtist.run('crew.ask', { memberId: orphan.id, task: 'x' })).rejects.toThrow(
      /no longer available/,
    );
    const coordinator = await hire('coordinator');
    await expect(
      registry.executeById(
        'crew.ask',
        { memberId: coordinator.id, task: 'x' },
        { actor: { kind: 'agent', id: coordinator.id, role: 'coordinator' }, approved: true },
      ),
    ).rejects.toThrow(/cannot give itself/);
    await expect(run('crew.ask', { memberId: coordinator.id })).rejects.toThrow(
      /nothing to continue/,
    );
  });

  it('forgets the conversation when it is cleared or the agent is dismissed', async () => {
    const { run, hire, runtime, conversation } = setup([{ content: 'a' }, { content: 'b' }]);
    const coordinator = await hire('coordinator');
    await run('crew.ask', { memberId: coordinator.id, task: 'x' });
    await run('crew.conversation.clear', { memberId: coordinator.id });
    expect((await conversation(coordinator.id)).messages).toEqual([]);

    await run('crew.ask', { memberId: coordinator.id, task: 'x' });
    await run('crew.dismiss', { id: coordinator.id });
    expect(await runtime.store.list('conversations/')).toEqual([]);
  });
});

describe('crew.approve', () => {
  const askToGenerate: ScriptedChatReply[] = [
    { toolCalls: [toolCall('c1', 'media__generate', { prompt: 'Mara' })] },
    { content: 'Waiting for your approval.' },
  ];

  it('runs what the agent asked for, and the agent continues with the result', async () => {
    const { run, hire, runtime, provider, conversation } = setup([
      ...askToGenerate,
      { content: 'Mara is drawn.' },
    ]);
    const member = await hire('artist');
    const result = AgentRunSchema.parse(
      await run('crew.ask', { memberId: member.id, task: 'Draw Mara.' }),
    );
    expect(result.status).toBe('awaiting-approval');
    const [pending] = (await conversation(member.id)).pendingApprovals;
    expect(pending).toMatchObject({ commandId: 'media.generate', input: { prompt: 'Mara' } });

    // While a request is open the agent takes no new task.
    await expect(run('crew.ask', { memberId: member.id, task: 'More.' })).rejects.toThrow(
      /waiting for a decision/,
    );

    expect(await run('crew.approve', { memberId: member.id, approvalId: pending?.id })).toEqual({
      commandId: 'media.generate',
      approved: true,
      output: { url: 'made:Mara' },
      remaining: 0,
    });
    const generated = (await readActivity(runtime.store)).filter(
      (entry) => entry.commandId === 'media.generate',
    );
    expect(generated.map((entry) => [entry.actor.kind, entry.outcome])).toEqual([
      ['agent', 'needs-approval'],
      ['agent', 'ok'],
    ]);

    // Continuing needs no new task: the outcome is the newest message.
    const resumed = AgentRunSchema.parse(await run('crew.ask', { memberId: member.id }));
    expect(resumed.finalText).toBe('Mara is drawn.');
    expect(provider.requests[2]?.messages.at(-1)).toMatchObject({
      role: 'user',
      content: 'Approved: media.generate',
      context: expect.stringContaining('made:Mara') as string,
    });
  });

  it('tells the agent when the user declines, without running anything', async () => {
    const { run, hire, runtime, conversation } = setup(askToGenerate);
    const member = await hire('artist');
    await run('crew.ask', { memberId: member.id, task: 'Draw Mara.' });
    const [pending] = (await conversation(member.id)).pendingApprovals;
    expect(
      await run('crew.approve', { memberId: member.id, approvalId: pending?.id, approve: false }),
    ).toMatchObject({ approved: false, output: null, remaining: 0 });
    expect((await conversation(member.id)).messages.at(-1)).toMatchObject({
      content: 'Declined: media.generate',
      context: expect.stringContaining('declined') as string,
    });
    const outcomes = (await readActivity(runtime.store))
      .filter((entry) => entry.commandId === 'media.generate')
      .map((entry) => entry.outcome);
    expect(outcomes).toEqual(['needs-approval']);
  });

  it('reports a failure of the approved command to the agent', async () => {
    const { run, hire, runtime, conversation } = setup(askToGenerate);
    const member = await hire('artist');
    await run('crew.ask', { memberId: member.id, task: 'Draw Mara.' });
    const stored = await conversation(member.id);
    const [pending] = stored.pendingApprovals;
    if (pending === undefined) throw new Error('nothing pending');
    await runtime.store.batch([
      {
        type: 'put',
        key: `conversations/${member.id}`,
        value: json({ ...stored, pendingApprovals: [{ ...pending, input: { prompt: 5 } }] }),
      },
    ]);
    await run('crew.approve', { memberId: member.id, approvalId: pending.id });
    expect((await conversation(member.id)).messages.at(-1)).toMatchObject({
      context: expect.stringContaining('but it failed') as string,
    });
  });

  it('does not let an approval widen what the role may run', async () => {
    const { run, hire, runtime, conversation } = setup(askToGenerate);
    const member = await hire('artist');
    await run('crew.ask', { memberId: member.id, task: 'Draw Mara.' });
    const stored = await conversation(member.id);
    const [pending] = stored.pendingApprovals;
    if (pending === undefined) throw new Error('nothing pending');
    for (const commandId of ['settings.set', 'made.up']) {
      await runtime.store.batch([
        {
          type: 'put',
          key: `conversations/${member.id}`,
          value: json({ ...stored, pendingApprovals: [{ ...pending, commandId }] }),
        },
      ]);
      await expect(
        run('crew.approve', { memberId: member.id, approvalId: pending.id }),
      ).rejects.toMatchObject({ code: 'denied' });
    }
  });

  it('never lets an agent approve, even one with write access', async () => {
    const { registry, hire } = setup([]);
    const member = await hire('artist');
    await expect(
      registry.executeById(
        'crew.approve',
        { memberId: member.id, approvalId: 'x' },
        { actor: { kind: 'agent', id: 'coordinator-1', role: 'coordinator' } },
      ),
    ).rejects.toMatchObject({ code: 'denied' });
  });

  it('refuses an unknown member and an unknown request', async () => {
    const { run, hire } = setup([]);
    await expect(run('crew.approve', { memberId: 'nobody', approvalId: 'x' })).rejects.toThrow(
      /No crew member/,
    );
    const member = await hire('artist');
    await expect(run('crew.approve', { memberId: member.id, approvalId: 'x' })).rejects.toThrow(
      /Nothing is waiting/,
    );
  });
});

describe('delegation', () => {
  it('lets the coordinator hand a task to a specialist once the user approves', async () => {
    const { run, hire, provider, conversation } = setup([]);
    const coordinator = await hire('coordinator');
    const artist = await hire('artist');
    provider.script(
      { toolCalls: [toolCall('c1', 'crew__ask', { memberId: artist.id, task: 'Draw Mara.' })] },
      { content: 'I asked the Artist; it needs your approval.' },
      // The specialist's own run, started by the approval.
      { content: 'Mara is sketched in words.' },
      // The coordinator, continued with the specialist's report.
      { content: 'The Artist reports: Mara is sketched.' },
    );

    const first = AgentRunSchema.parse(
      await run('crew.ask', { memberId: coordinator.id, task: 'Get Mara drawn.' }),
    );
    expect(first.status).toBe('awaiting-approval');
    const [pending] = first.pendingApprovals;
    expect(pending?.commandId).toBe('crew.ask');

    const approved = await run('crew.approve', {
      memberId: coordinator.id,
      approvalId: pending?.id,
    });
    expect(approved).toMatchObject({ output: { finalText: 'Mara is sketched in words.' } });
    // The specialist worked in its own conversation, on its own context.
    expect((await conversation(artist.id)).messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(provider.requests[2]?.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
    ]);

    const resumed = AgentRunSchema.parse(await run('crew.ask', { memberId: coordinator.id }));
    expect(resumed.finalText).toBe('The Artist reports: Mara is sketched.');
    expect(provider.requests[3]?.messages.at(-1)).toMatchObject({
      context: expect.stringContaining('Mara is sketched in words.') as string,
    });
  });
});

describe('coordinatorRole', () => {
  it('reads everything, changes only the workspace, and may ask to spend or delete', () => {
    expect(coordinatorRole.scope).toEqual({
      effects: ['read', 'write', 'spend', 'destructive'],
      writes: COORDINATOR_WRITES,
    });
    // It coordinates in words: a model that takes only text is enough.
    expect(coordinatorRole.sees).toEqual([]);
  });
});

describe('waiting approvals', () => {
  const askToGenerate = (prompt: string): ScriptedChatReply[] => [
    { toolCalls: [toolCall(`c-${prompt}`, 'media__generate', { prompt })] },
    { content: 'Waiting for your approval.' },
  ];

  it('lists every request waiting across the crew, with who asked', async () => {
    const { run, hire, conversation } = setup([...askToGenerate('Mara'), ...askToGenerate('Ivo')]);
    const first = await hire('artist');
    const second = (await run('crew.hire', {
      roleId: 'artist',
      model: 'vendor/model',
      name: 'Second artist',
    })) as { id: string };
    expect(await run('crew.approvals.list', {})).toEqual({ approvals: [] });
    await run('crew.ask', { memberId: first.id, task: 'Draw Mara.' });
    await run('crew.ask', { memberId: second.id, task: 'Draw Ivo.' });
    const [pending] = (await conversation(first.id)).pendingApprovals;
    const { approvals } = z
      .object({ approvals: z.array(z.record(z.string(), z.unknown())) })
      .parse(await run('crew.approvals.list', {}));
    expect(approvals).toHaveLength(2);
    expect(approvals).toContainEqual({
      memberId: first.id,
      memberName: 'Artist',
      approvalId: pending?.id,
      commandId: 'media.generate',
      title: 'Generate media',
      effect: 'spend',
      input: { prompt: 'Mara' },
    });
    expect(approvals).toContainEqual(
      expect.objectContaining({ memberName: 'Second artist', input: { prompt: 'Ivo' } }),
    );
  });

  it('runs an always-allowed command without asking, until the user takes it back', async () => {
    const { run, hire, runtime } = setup([...askToGenerate('Mara'), ...askToGenerate('Ivo')]);
    const member = await hire('artist');
    expect(
      await run('crew.approvals.always.set', { commandId: 'media.generate', allow: true }),
    ).toEqual({
      commands: [{ commandId: 'media.generate', title: 'Generate media', effect: 'spend' }],
    });
    const allowed = AgentRunSchema.parse(
      await run('crew.ask', { memberId: member.id, task: 'Draw Mara.' }),
    );
    expect(allowed.status).toBe('completed');
    expect(allowed.pendingApprovals).toEqual([]);
    const outcomes = (await readActivity(runtime.store))
      .filter((entry) => entry.commandId === 'media.generate')
      .map((entry) => entry.outcome);
    expect(outcomes).toEqual(['ok']);

    expect(
      await run('crew.approvals.always.set', { commandId: 'media.generate', allow: false }),
    ).toEqual({ commands: [] });
    const asked = AgentRunSchema.parse(
      await run('crew.ask', { memberId: member.id, task: 'Draw Ivo.' }),
    );
    expect(asked.status).toBe('awaiting-approval');
    expect(await run('crew.approvals.always.list', {})).toEqual({ commands: [] });
  });

  it('lets only the user always allow something, and only a command that exists', async () => {
    const { registry, run } = setup([]);
    await expect(
      registry.executeById(
        'crew.approvals.always.set',
        { commandId: 'media.generate' },
        { actor: { kind: 'agent', id: 'coordinator-1', role: 'coordinator' } },
      ),
    ).rejects.toMatchObject({ code: 'denied' });
    await expect(run('crew.approvals.always.set', { commandId: 'made.up' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    // Changing the budget without approval asks every time.
    await expect(
      run('crew.approvals.always.set', { commandId: 'spend.allowance.set' }),
    ).rejects.toThrow(/always asks you first/);
    // Taking back something unknown is harmless.
    expect(await run('crew.approvals.always.set', { commandId: 'made.up', allow: false })).toEqual({
      commands: [],
    });
  });
});
