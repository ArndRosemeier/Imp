import { CommandRegistry, defineCommand, readActivity, settingsCommands } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { createFakeProvider, type ScriptedChatReply } from '@imp/providers/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AgentRunSchema,
  coordinatorRole,
  createAgentCommands,
  createCrewCommands,
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
  const registry = new CommandRegistry({ runtime });
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
  return { runtime, registry, provider, run, hire };
}

describe('crew.ask', () => {
  it('runs the agent and returns a result that can be stored and continued', async () => {
    const { run, hire, runtime, provider } = setup([
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
      { content: 'Theme set.' },
      { content: 'It is still dark.' },
    ]);
    const coordinator = await hire('coordinator');
    const first = AgentRunSchema.parse(
      await run('crew.ask', {
        memberId: coordinator.id,
        task: 'Make it dark.',
        context: 'Project: p-1',
      }),
    );
    expect(first).toMatchObject({ status: 'completed', finalText: 'Theme set.', steps: 2 });
    expect(await runtime.store.get('settings/theme')).toBe('dark');
    expect(provider.requests[0]?.messages[0]?.content).toContain('Project: p-1');

    const second = AgentRunSchema.parse(
      await run('crew.ask', {
        memberId: coordinator.id,
        task: 'And now?',
        history: first.messages,
      }),
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

  it('refuses an unknown member and a member whose role is gone', async () => {
    const { run } = setup([]);
    await expect(run('crew.ask', { memberId: 'nobody', task: 'x' })).rejects.toThrow(
      /No crew member/,
    );
    const withoutArtist = setup([], [coordinatorRole]);
    const orphan = await withoutArtist.hire('artist');
    await expect(withoutArtist.run('crew.ask', { memberId: orphan.id, task: 'x' })).rejects.toThrow(
      /no longer available/,
    );
  });
});

describe('crew.approve', () => {
  const askToGenerate: ScriptedChatReply[] = [
    {
      toolCalls: [
        {
          id: 'c1',
          name: 'media__generate',
          arguments: { prompt: 'Mara' },
          argumentsText: '{"prompt":"Mara"}',
        },
      ],
    },
    { content: 'Waiting for your approval.' },
  ];

  it('lets the user run what an agent asked for, attributed to the agent', async () => {
    const { run, hire, runtime } = setup(askToGenerate);
    const member = await hire('artist');
    const result = AgentRunSchema.parse(
      await run('crew.ask', { memberId: member.id, task: 'Draw Mara.' }),
    );
    expect(result.status).toBe('awaiting-approval');
    const [pending] = result.pendingApprovals;

    expect(await run('crew.approve', { memberId: member.id, ...pending })).toEqual({
      commandId: 'media.generate',
      output: { url: 'made:Mara' },
    });
    const generated = (await readActivity(runtime.store)).filter(
      (entry) => entry.commandId === 'media.generate',
    );
    expect(generated.map((entry) => [entry.actor.kind, entry.outcome])).toEqual([
      ['agent', 'needs-approval'],
      ['agent', 'ok'],
    ]);
  });

  it('never lets an agent approve, even one with write access', async () => {
    const { registry, hire } = setup([]);
    const member = await hire('artist');
    await expect(
      registry.executeById(
        'crew.approve',
        { memberId: member.id, commandId: 'media.generate', input: { prompt: 'x' } },
        { actor: { kind: 'agent', id: 'coordinator-1', role: 'coordinator' } },
      ),
    ).rejects.toMatchObject({ code: 'denied' });
  });

  it('refuses an unknown member', async () => {
    const { run } = setup([]);
    await expect(
      run('crew.approve', { memberId: 'nobody', commandId: 'media.generate', input: {} }),
    ).rejects.toThrow(/No crew member/);
  });
});

describe('coordinatorRole', () => {
  it('may read and write but not spend or destroy', () => {
    expect(coordinatorRole.scope).toEqual({ effects: ['read', 'write'] });
  });
});
