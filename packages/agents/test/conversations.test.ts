import {
  CommandRegistry,
  copyTree,
  defineCommand,
  projectPrefix,
  settingsCommands,
} from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { createFakeProvider, type ScriptedChatReply } from '@imp/providers/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ConversationSchema,
  conversationKey,
  coordinatorRole,
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

function setup(replies: ScriptedChatReply[] = []) {
  const runtime = createTestRuntime();
  const provider = createFakeProvider({ replies });
  const roles = new RoleCatalog([coordinatorRole, artist]);
  const registry = new CommandRegistry({ runtime });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wait = defineCommand({
    id: 'media.wait',
    title: 'Wait',
    description: 'Holds the run until the test lets it go.',
    effect: 'read',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    handler: async () => {
      await gate;
      return { ok: true };
    },
  });
  registry.register(
    ...settingsCommands,
    wait,
    ...createCrewCommands(roles),
    ...createAgentCommands({ registry, provider, roles }),
  );
  const run = async (id: string, input: unknown) => {
    const result = await registry.executeById(id, input, { actor: user });
    if (result.status !== 'ok') throw new Error(`Expected ok, got ${result.status}`);
    return result.output;
  };
  const hire = async (roleId: string) =>
    (await run('crew.hire', { roleId, model: 'vendor/model' })) as { id: string };
  const conversation = async (memberId: string) =>
    ConversationSchema.extend({ projectId: z.string().nullable() }).parse(
      await run('crew.conversation.get', { memberId }),
    );
  const addProject = async (id: string, name: string, openedAt: string | null = null) => {
    await runtime.store.batch([
      {
        type: 'put',
        key: `project-index/${id}`,
        value: { id, name, mode: 'movie', createdAt: '2026-11-01T00:00:00.000Z', openedAt },
      },
    ]);
  };
  const open = async (id: string | null) => {
    await runtime.store.batch([
      id === null
        ? { type: 'delete', key: 'settings/project.current' }
        : { type: 'put', key: 'settings/project.current', value: id },
    ]);
  };
  return { runtime, registry, provider, run, hire, conversation, addProject, open, release };
}

const said = (messages: { role: string; content?: string | null }[]) =>
  messages.filter((m) => m.role === 'user').map((m) => m.content);

describe('conversations per project', () => {
  it('keeps a separate conversation with each agent in each project', async () => {
    const { run, hire, conversation, addProject, open, provider, runtime } = setup([
      { content: 'Hello A.' },
      { content: 'Hello B.' },
      { content: 'Back in A.' },
    ]);
    const coordinator = await hire('coordinator');
    await addProject('pa', 'Alpha');
    await addProject('pb', 'Beta');

    await open('pa');
    await run('crew.ask', { memberId: coordinator.id, task: 'About Alpha.' });
    await open('pb');
    expect(await conversation(coordinator.id)).toMatchObject({ projectId: 'pb', messages: [] });
    await run('crew.ask', { memberId: coordinator.id, task: 'About Beta.' });
    // The agent in Beta never saw what was said in Alpha.
    expect(provider.requests[1]?.messages.map((m) => m.role)).toEqual(['system', 'user']);

    await open('pa');
    await run('crew.ask', { memberId: coordinator.id, task: 'Alpha again.' });
    expect(said(provider.requests[2]?.messages ?? [])).toEqual(['About Alpha.', 'Alpha again.']);
    expect(said((await conversation(coordinator.id)).messages)).toEqual([
      'About Alpha.',
      'Alpha again.',
    ]);

    // They live under their projects, so copies and exports of a project carry them.
    expect(await runtime.store.get(conversationKey(coordinator.id, 'pa'))).toBeDefined();
    expect(await runtime.store.get(`projects/pb/conversations/${coordinator.id}`)).toBeDefined();
    expect(await runtime.store.get(`conversations/${coordinator.id}`)).toBeUndefined();

    // Outside any project, the agent talks in a workspace-wide conversation.
    await open(null);
    expect(await conversation(coordinator.id)).toMatchObject({ projectId: null, messages: [] });
  });

  it('clears the chat of the open project only, and not while the agent works', async () => {
    const { run, hire, conversation, addProject, open } = setup([
      { content: 'One.' },
      { content: 'Two.' },
    ]);
    const coordinator = await hire('coordinator');
    await addProject('pa', 'Alpha');
    await addProject('pb', 'Beta');
    await open('pa');
    await run('crew.ask', { memberId: coordinator.id, task: 'A.' });
    await open('pb');
    await run('crew.ask', { memberId: coordinator.id, task: 'B.' });

    expect(await run('crew.conversation.clear', { memberId: coordinator.id })).toEqual({
      memberId: coordinator.id,
      projectId: 'pb',
    });
    expect((await conversation(coordinator.id)).messages).toEqual([]);
    await open('pa');
    expect(said((await conversation(coordinator.id)).messages)).toEqual(['A.']);
  });

  it('lets an agent work in one project at a time, and the run stays in its project', async () => {
    const { run, hire, conversation, addProject, open, release, runtime } = setup([
      { toolCalls: [{ id: 'w', name: 'media__wait', arguments: {}, argumentsText: '{}' }] },
      { content: 'Done in Alpha.' },
    ]);
    const painter = await hire('artist');
    await addProject('pa', 'Alpha');
    await addProject('pb', 'Beta');
    await open('pa');
    const working = run('crew.ask', { memberId: painter.id, task: 'Paint.' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The person opens another project while the agent works.
    await open('pb');
    await expect(
      run('crew.ask', { memberId: painter.id, task: 'Paint here too.' }),
    ).rejects.toThrow('still working in "Alpha"');
    await run('crew.conversation.clear', { memberId: painter.id });

    release();
    await working;
    expect((await conversation(painter.id)).messages).toEqual([]);
    const alpha = ConversationSchema.parse(
      await runtime.store.get(conversationKey(painter.id, 'pa')),
    );
    expect(alpha).toMatchObject({ running: false, lastStatus: 'completed', roleId: 'artist' });
  });

  it('forgets a dismissed agent in every project', async () => {
    const { run, hire, addProject, open, runtime } = setup([
      { content: 'A.' },
      { content: 'B.' },
      { content: 'None.' },
    ]);
    const painter = await hire('artist');
    await addProject('pa', 'Alpha');
    await addProject('pb', 'Beta');
    for (const project of ['pa', 'pb', null]) {
      await open(project);
      await run('crew.ask', { memberId: painter.id, task: 'Paint.' });
    }
    await run('crew.dismiss', { id: painter.id });
    for (const project of ['pa', 'pb', null]) {
      expect(await runtime.store.get(conversationKey(painter.id, project))).toBeUndefined();
    }
  });

  it('hands the conversations of a project copied from another Imp to the agents in the same roles', async () => {
    const { run, hire, conversation, addProject, open, provider, runtime } = setup([
      { content: 'There.' },
      { content: 'Here too.' },
    ]);
    // Somewhere else: a project with a conversation with the coordinator.
    const theirs = await hire('coordinator');
    await addProject('pa', 'Alpha');
    await open('pa');
    await run('crew.ask', { memberId: theirs.id, task: 'Remember the lighthouse.' });
    // The project travels; here the coordinator has another id.
    await copyTree(runtime, projectPrefix('pa'), projectPrefix('pc'));
    await addProject('pc', 'Alpha (copy)');
    await runtime.store.batch([{ type: 'delete', key: `crew/${theirs.id}` }]);
    const ours = await hire('coordinator');
    await open('pc');

    expect(said((await conversation(ours.id)).messages)).toEqual(['Remember the lighthouse.']);
    await run('crew.ask', { memberId: ours.id, task: 'And now?' });
    expect(said(provider.requests[1]?.messages ?? [])).toEqual([
      'Remember the lighthouse.',
      'And now?',
    ]);
    // It moved over, once.
    expect(await runtime.store.get(conversationKey(theirs.id, 'pc'))).toBeUndefined();
    // A painter is in another role and takes nothing over.
    const painter = await hire('artist');
    expect((await conversation(painter.id)).messages).toEqual([]);
  });
});

describe('conversations from before they were per project', () => {
  const legacy = (memberId: string, task: string) => ({
    memberId,
    messages: [{ role: 'user', content: task }],
    pendingApprovals: [],
    running: true,
    lastStatus: null,
    lastError: null,
    costUsd: 0.01,
    usage: { promptTokens: 1, cachedPromptTokens: 0, completionTokens: 1 },
  });

  it('moves them into the open project, once', async () => {
    const { hire, conversation, addProject, open, runtime } = setup();
    const coordinator = await hire('coordinator');
    await addProject('pa', 'Alpha');
    await addProject('pb', 'Beta');
    await open('pb');
    await runtime.store.batch([
      {
        type: 'put',
        key: `conversations/${coordinator.id}`,
        value: legacy(coordinator.id, 'Old.'),
      },
    ]);
    await releaseInterruptedRuns(runtime.store);

    expect(await runtime.store.get(`conversations/${coordinator.id}`)).toBeUndefined();
    expect(await conversation(coordinator.id)).toMatchObject({
      projectId: 'pb',
      running: false,
      lastStatus: 'cancelled',
      roleId: 'coordinator',
    });
    expect(said((await conversation(coordinator.id)).messages)).toEqual(['Old.']);

    // Later workspace-wide conversations stay where they are.
    await open(null);
    await runtime.store.batch([
      {
        type: 'put',
        key: `conversations/${coordinator.id}`,
        value: legacy(coordinator.id, 'New.'),
      },
    ]);
    await releaseInterruptedRuns(runtime.store);
    expect(said((await conversation(coordinator.id)).messages)).toEqual(['New.']);
  });

  it('uses the project opened last when none is open, and stays put without projects', async () => {
    const first = setup();
    const member = await first.hire('coordinator');
    await first.addProject('pa', 'Alpha', '2026-11-10T00:00:00.000Z');
    await first.addProject('pb', 'Beta', '2026-11-12T00:00:00.000Z');
    await first.runtime.store.batch([
      { type: 'put', key: `conversations/${member.id}`, value: legacy(member.id, 'Old.') },
    ]);
    await releaseInterruptedRuns(first.runtime.store);
    expect(await first.runtime.store.get(conversationKey(member.id, 'pb'))).toBeDefined();

    const empty = setup();
    const lone = await empty.hire('coordinator');
    await empty.runtime.store.batch([
      { type: 'put', key: `conversations/${lone.id}`, value: legacy(lone.id, 'Old.') },
    ]);
    await releaseInterruptedRuns(empty.runtime.store);
    expect(said((await empty.conversation(lone.id)).messages)).toEqual(['Old.']);
  });
});
