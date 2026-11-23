import { CommandRegistry, defineCommand, settingsCommands } from '@imp/core';
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
  createSavedCrewCommands,
  GLOBAL_COORDINATOR_ROLE,
  globalCoordinatorRole,
  passedOnFrom,
  passedOnLine,
  roleCanUse,
  RoleCatalog,
  type Role,
} from '../src/index.js';

const user = { kind: 'user', id: 'arnd' } as const;
const writer: Role = {
  id: 'writer',
  name: 'Writer',
  summary: 'Writes scenes.',
  brief: 'You write scenes.',
  scope: { prefixes: ['movie.'] },
};

/** Stand-ins for commands of the app that the two coordinators divide between them. */
const deleteProject = defineCommand({
  id: 'project.delete',
  title: 'Delete project',
  description: 'A stand-in for deleting a project.',
  effect: 'destructive',
  input: z.object({ projectId: z.string() }),
  output: z.object({ deleted: z.string() }),
  handler: (_context, { projectId }) => Promise.resolve({ deleted: projectId }),
});
const writeScene = defineCommand({
  id: 'movie.scene.create',
  title: 'Write a scene',
  description: 'A stand-in for writing a scene.',
  effect: 'write',
  input: z.object({ title: z.string() }),
  output: z.object({ title: z.string() }),
  handler: (_context, input) => Promise.resolve(input),
});

function setup(replies: ScriptedChatReply[] = []) {
  const runtime = createTestRuntime();
  const provider = createFakeProvider({ replies });
  const roles = new RoleCatalog([coordinatorRole, globalCoordinatorRole, writer]);
  // Giving a task costs money; here it fits the budget, as cents do in the app.
  const registry = new CommandRegistry({
    runtime,
    autoApprove: (_context, command) => Promise.resolve(command.id === 'crew.ask'),
  });
  registry.register(
    ...settingsCommands,
    deleteProject,
    writeScene,
    ...createCrewCommands(roles),
    ...createSavedCrewCommands(roles),
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
  const openProject = async (id: string, name: string) => {
    await runtime.store.batch([
      {
        type: 'put',
        key: `project-index/${id}`,
        value: { id, name, mode: 'movie', createdAt: '2026-11-01T00:00:00.000Z', openedAt: null },
      },
      { type: 'put', key: 'settings/project.current', value: id },
    ]);
  };
  return { runtime, registry, provider, run, hire, conversation, openProject };
}

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  toolCalls: [{ id, name, arguments: args as never, argumentsText: JSON.stringify(args) }],
});

describe('the Imp coordinator', () => {
  it('talks in one chat for all projects, whatever project is open', async () => {
    const { run, hire, conversation, openProject, runtime } = setup([
      { content: 'Hello outside.' },
      { content: 'Still the same chat.' },
    ]);
    const imp = await hire(GLOBAL_COORDINATOR_ROLE);
    await run('crew.ask', { memberId: imp.id, task: 'Hi.' });
    await openProject('p1', 'Dragon bakery');
    await run('crew.ask', { memberId: imp.id, task: 'And now?' });
    const chat = await conversation(imp.id);
    expect(chat.projectId).toBeNull();
    expect(chat.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      'Hi.',
      'And now?',
    ]);
    expect(await runtime.store.get(conversationKey(imp.id, 'p1'))).toBeUndefined();
  });

  it('changes only what concerns all projects, and reads nothing inside one', () => {
    const can = (role: Role, command: typeof writeScene | typeof deleteProject) =>
      roleCanUse(role, command);
    expect(can(globalCoordinatorRole, deleteProject)).toBe(true);
    expect(can(globalCoordinatorRole, writeScene)).toBe(false);
    expect(can(coordinatorRole, deleteProject)).toBe(false);
    expect(globalCoordinatorRole.scope.prefixes).not.toContain('movie.');
    expect(globalCoordinatorRole.sees).toEqual([]);
  });

  it('is one, and stays when the crew is dismissed or a saved crew is loaded', async () => {
    const { run, hire, registry } = setup();
    const imp = await hire(GLOBAL_COORDINATOR_ROLE);
    await expect(hire(GLOBAL_COORDINATOR_ROLE)).rejects.toThrow(/already an Imp coordinator/);
    await expect(run('crew.dismiss', { id: imp.id })).rejects.toThrow(/stays on the crew/);
    await hire('writer');
    const saved = (await run('crew.saved.save', { name: 'All' })) as { id: string };
    await run('crew.saved.load', { id: saved.id, replace: true });
    const { crew } = (await run('crew.list', {})) as { crew: { id: string; roleId: string }[] };
    expect(crew.filter((member) => member.roleId === GLOBAL_COORDINATOR_ROLE)).toEqual([
      expect.objectContaining({ id: imp.id }),
    ]);
    expect(registry.has('crew.saved.load')).toBe(true);
  });

  it('puts what it asks for in front of the user from its own chat, in any project', async () => {
    const { run, hire, conversation, openProject } = setup([
      call('c1', 'project__delete', { projectId: 'p2' }),
      { content: 'Waiting for you.' },
      { content: 'Deleted it.' },
    ]);
    const imp = await hire(GLOBAL_COORDINATOR_ROLE);
    await openProject('p1', 'Dragon bakery');
    await run('crew.ask', { memberId: imp.id, task: 'Delete the old project.' });
    const { approvals } = (await run('crew.approvals.list', {})) as {
      approvals: { memberId: string; approvalId: string; commandId: string }[];
    };
    expect(approvals).toEqual([
      expect.objectContaining({ memberId: imp.id, commandId: 'project.delete' }),
    ]);
    const approved = (await run('crew.approve', {
      memberId: imp.id,
      approvalId: approvals[0]?.approvalId,
    })) as { output: unknown; remaining: number };
    expect(approved).toMatchObject({ output: { deleted: 'p2' }, remaining: 0 });
    expect((await conversation(imp.id)).pendingApprovals).toEqual([]);
  });
});

describe("a project's coordinator", () => {
  it('passes what concerns all projects on, and the Imp coordinator sees from where', async () => {
    const { run, hire, conversation, openProject, provider } = setup();
    const coordinator = await hire('coordinator');
    const imp = await hire(GLOBAL_COORDINATOR_ROLE);
    await openProject('p1', 'Dragon "bakery"');
    provider.script(
      // It tries to change a setting itself and is told whom to pass it to.
      call('c1', 'settings__set', { key: 'images.model', value: 'x/y' }),
      call('c2', 'crew__ask', { memberId: imp.id, task: 'Use x/y for pictures.' }),
      // The Imp coordinator's run.
      call('c3', 'settings__set', { key: 'images.model', value: 'x/y' }),
      { content: 'Pictures now use x/y.' },
      // Back in the project coordinator's run.
      { content: 'Passed to the Imp coordinator: pictures now use x/y.' },
    );
    const result = (await run('crew.ask', {
      memberId: coordinator.id,
      task: 'Use x/y for pictures.',
    })) as { finalText: string };
    expect(result.finalText).toContain('Passed to the Imp coordinator');

    // The project coordinator was told who the Imp coordinator is.
    const first = provider.requests[0]?.messages.at(-1);
    expect(first?.role === 'user' ? first.context : undefined).toContain(imp.id);
    // Its own attempt was refused with a pointer to the Imp coordinator.
    const refused = provider.requests[1]?.messages.at(-1);
    expect(refused?.role).toBe('tool');
    const outcome = JSON.parse(String(refused?.content)) as { error: string; note: string };
    expect(outcome.error).toContain('not a command you can run');
    expect(outcome.note).toContain('Imp coordinator');

    // The Imp coordinator's chat holds the ask, marked with the project it came from.
    const global = await conversation(imp.id);
    expect(global.projectId).toBeNull();
    const asked = global.messages.find((m) => m.role === 'user');
    expect(asked).toMatchObject({ content: 'Use x/y for pictures.' });
    expect(passedOnFrom(asked?.role === 'user' ? asked.context : undefined)).toEqual({
      name: 'Dragon "bakery"',
      id: 'p1',
    });
    expect(await run('settings.get', { key: 'images.model' })).toMatchObject({ value: 'x/y' });
    // The project's chat stays in the project.
    expect((await conversation(coordinator.id)).projectId).toBe('p1');
  });

  it('is pointed to the Imp coordinator when it looks for what is not its own', async () => {
    const { run, hire, openProject, provider } = setup();
    const coordinator = await hire('coordinator');
    await openProject('p1', 'Dragon bakery');
    provider.script(call('c1', 'find_commands', { query: 'delete project' }), {
      content: 'Done.',
    });
    await run('crew.ask', { memberId: coordinator.id, task: 'Delete the other project.' });
    const found = JSON.parse(String(provider.requests[1]?.messages.at(-1)?.content)) as {
      elsewhere?: { commands: string[]; note: string };
    };
    expect(found.elsewhere?.commands).toContain('project.delete');
    expect(found.elsewhere?.note).toContain('Imp coordinator');
  });
});

describe('passed-on marks', () => {
  it('read back the project a message came from', () => {
    const line = passedOnLine({ name: 'A "quoted" (name)', id: 'p-9' });
    expect(passedOnFrom(`${line}\nMore context.`)).toEqual({
      name: 'A "quoted" (name)',
      id: 'p-9',
    });
    expect(passedOnFrom('Open project: "x".')).toBeNull();
    expect(passedOnFrom(undefined)).toBeNull();
  });
});
