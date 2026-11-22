import { CommandRegistry, defineCommand, settingsCommands } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { createFakeProvider, type ScriptedChatReply } from '@imp/providers/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  coordinatorRole,
  createAgentCommands,
  createCrewCommands,
  KEPT_FINISHED_WORK,
  mergeSubjects,
  readWork,
  releaseInterruptedRuns,
  RoleCatalog,
  subjectsOfInput,
  WorkBoardSchema,
  WorkEntry,
  workKey,
  type Role,
  type WorkDescriber,
} from '../src/index.js';

const user = { kind: 'user', id: 'arnd' } as const;
const artist: Role = {
  id: 'artist',
  name: 'Artist',
  summary: 'Makes images.',
  brief: 'You make images.',
  scope: { prefixes: ['media.'] },
};
const tag = defineCommand({
  id: 'media.tag',
  title: 'Tag a scene',
  description: 'A stand-in for a change to a scene and its shots.',
  effect: 'write',
  input: z.object({ sceneId: z.string(), shotIds: z.array(z.string()).default([]) }),
  output: z.object({ ok: z.boolean() }),
  handler: () => Promise.resolve({ ok: true }),
});
const look = defineCommand({
  id: 'media.look',
  title: 'Look at a scene',
  description: 'A stand-in for a read.',
  effect: 'read',
  input: z.object({ sceneId: z.string() }),
  output: z.object({ ok: z.boolean() }),
  handler: () => Promise.resolve({ ok: true }),
});

const describer: WorkDescriber = {
  stageOf: (commandId) => (commandId.startsWith('media.') ? 'shots' : undefined),
  label: (_store, _projectId, subjects) =>
    Promise.resolve(
      subjects.map((subject) =>
        subject.kind === 'scene' ? { ...subject, label: `Scene ${subject.id}` } : subject,
      ),
    ),
};

function setup(replies: ScriptedChatReply[]) {
  const runtime = createTestRuntime();
  const provider = createFakeProvider({ replies });
  const catalog = new RoleCatalog([coordinatorRole, artist]);
  const registry = new CommandRegistry({ runtime });
  registry.register(
    ...settingsCommands,
    tag,
    look,
    ...createCrewCommands(catalog),
    ...createAgentCommands({ registry, provider, roles: catalog, work: describer }),
  );
  const run = async (id: string, input: unknown) => {
    const result = await registry.executeById(id, input, { actor: user });
    if (result.status !== 'ok') throw new Error(`Expected ok, got ${result.status}`);
    return result.output;
  };
  const hire = async (roleId: string) =>
    (await run('crew.hire', { roleId, model: 'vendor/model' })) as { id: string };
  const board = async (input: unknown = {}) =>
    WorkBoardSchema.parse(await run('crew.work.list', input));
  return { runtime, provider, run, hire, board };
}

const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  name,
  arguments: args as never,
  argumentsText: JSON.stringify(args),
});

describe('subjectsOfInput', () => {
  it('finds the things a command names by id, one or many', () => {
    expect(
      subjectsOfInput({
        projectId: 'p',
        memberId: 'm',
        sceneId: 's1',
        shotIds: ['a', 'b', 3],
        name: 'x',
        characterId: '',
      }),
    ).toEqual([
      { kind: 'scene', id: 's1', label: null },
      { kind: 'shot', id: 'a', label: null },
      { kind: 'shot', id: 'b', label: null },
    ]);
    expect(subjectsOfInput(null)).toEqual([]);
    expect(subjectsOfInput(['sceneId'])).toEqual([]);
  });

  it('keeps the latest subjects last, without repeats', () => {
    const s = (id: string) => ({ kind: 'scene', id, label: null });
    expect(mergeSubjects([s('1'), s('2')], [s('1'), s('3')])).toEqual([s('2'), s('1'), s('3')]);
    const many = Array.from({ length: 20 }, (_, index) => s(String(index)));
    expect(mergeSubjects([], many)).toHaveLength(16);
  });
});

describe('the work board', () => {
  it('shows what an agent does while it works and what it did after', async () => {
    const { run, hire, board, provider, runtime } = setup([]);
    const member = await hire('artist');
    const seen: WorkEntry[][] = [];
    provider.script(
      { toolCalls: [toolCall('c1', 'media__look', { sceneId: 's0' })] },
      { toolCalls: [toolCall('c2', 'media__tag', { sceneId: 's1', shotIds: ['x'] })] },
      { content: 'Tagged scene 1.' },
    );
    runtime.store.subscribe('work/', () => {
      void readWork(runtime.store).then((entries) => seen.push(entries));
    });
    await run('crew.ask', { memberId: member.id, task: 'Tag the first scene.' });

    const { working, recent, workingUsd } = await board();
    expect(working).toEqual([]);
    expect(workingUsd).toBe(0);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      memberId: member.id,
      memberName: 'Artist',
      roleName: 'Artist',
      task: 'Tag the first scene.',
      askedBy: { kind: 'user', id: 'arnd', name: null },
      parentId: null,
      status: 'completed',
      steps: 3,
      commands: 2,
      stages: ['shots'],
      now: null,
      summary: 'Tagged scene 1.',
      // The read is not listed: only what was changed.
      subjects: [
        { kind: 'scene', id: 's1', label: 'Scene s1' },
        { kind: 'shot', id: 'x', label: null },
      ],
    });
    expect(recent[0]?.endedAt).not.toBeNull();

    // While it worked, the board showed it working on the scene of the moment.
    const during = seen.flat().filter((entry) => entry.status === 'working');
    expect(during.some((entry) => entry.now?.kind === 'thinking')).toBe(true);
    // Thinking after a command, it still shows what it is thinking over.
    expect(
      during.some(
        (entry) => entry.now?.kind === 'thinking' && entry.now.after?.title === 'Tag a scene',
      ),
    ).toBe(true);
    expect(
      during.some(
        (entry) =>
          entry.now?.kind === 'command' &&
          entry.now.title === 'Tag a scene' &&
          entry.now.stage === 'shots' &&
          entry.now.subjects[0]?.label === 'Scene s1',
      ),
    ).toBe(true);
  });

  it('files a task one agent gave another under the run that asked', async () => {
    const { run, hire, board, provider } = setup([]);
    const coordinator = await hire('coordinator');
    const member = await hire('artist');
    provider.script(
      { toolCalls: [toolCall('c1', 'crew__ask', { memberId: member.id, task: 'Draw Mara.' })] },
      { content: 'Waiting for approval.' },
      { content: 'Drawn.' },
    );
    const first = (await run('crew.ask', { memberId: coordinator.id, task: 'Get Mara.' })) as {
      pendingApprovals: { id: string }[];
    };
    const waiting = await board();
    expect(waiting.waiting).toEqual([
      { memberId: coordinator.id, memberName: 'Coordinator', commandIds: ['crew.ask'] },
    ]);
    expect(waiting.recent[0]?.status).toBe('awaiting-approval');

    await run('crew.approve', {
      memberId: coordinator.id,
      approvalId: first.pendingApprovals[0]?.id,
    });
    const after = await board();
    expect(after.waiting).toEqual([]);
    const [latest, asking] = after.recent;
    expect(latest).toMatchObject({
      memberId: member.id,
      askedBy: { kind: 'agent', id: coordinator.id, name: 'Coordinator' },
      parentId: asking?.id,
    });
  });

  it('cuts long texts in the list and has them whole in crew.work.get', async () => {
    const { run, hire, board, provider } = setup([{ content: 'ok' }]);
    const member = await hire('artist');
    const task = 'Paint '.repeat(100);
    await run('crew.ask', { memberId: member.id, task });
    const [entry] = (await board()).recent;
    expect(entry?.task?.length).toBe(200);
    expect(entry?.task?.endsWith('…')).toBe(true);
    const whole = WorkEntry.parse(await run('crew.work.get', { workId: entry?.id }));
    expect(whole.task).toBe(task);
    await expect(run('crew.work.get', { workId: 'nope' })).rejects.toThrow(/No run/);
    expect(provider.requests).toHaveLength(1);
  });

  it('keeps the latest finished runs and releases runs a stopped host left working', async () => {
    const { runtime, board } = setup([]);
    const at = (index: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    const entry = (index: number, status: WorkEntry['status']): WorkEntry => ({
      id: `w${String(index)}`,
      memberId: 'm',
      memberName: 'M',
      roleId: 'artist',
      roleName: 'Artist',
      projectId: null,
      task: 't',
      askedBy: { kind: 'user', id: 'arnd', name: null },
      parentId: null,
      status,
      startedAt: at(index),
      updatedAt: at(index),
      endedAt: status === 'working' ? null : at(index),
      steps: 1,
      maxSteps: 20,
      costUsd: 0.01,
      budgetUsd: 1,
      now: status === 'working' ? { kind: 'thinking', at: at(index), after: null } : null,
      stages: [],
      subjects: [],
      commands: 0,
      summary: null,
      error: null,
    });
    await runtime.store.batch(
      Array.from({ length: KEPT_FINISHED_WORK + 5 }, (_, index) => {
        const value = entry(index, index === 0 ? 'working' : 'completed');
        return { type: 'put' as const, key: workKey(value), value };
      }),
    );
    expect((await board({ limit: 3 })).working).toHaveLength(1);
    expect((await board({ limit: 3 })).recent.map(({ id }) => id)).toEqual(['w64', 'w63', 'w62']);
    expect((await board({ limit: 3 })).workingUsd).toBeCloseTo(0.01);

    await releaseInterruptedRuns(runtime.store);
    const all = await readWork(runtime.store);
    expect(all.find(({ id }) => id === 'w0')).toMatchObject({ status: 'cancelled', now: null });
  });

  it('prunes the oldest finished runs when a new one starts', async () => {
    const { runtime, run, hire } = setup([{ content: 'ok' }]);
    const member = await hire('artist');
    const old = Array.from({ length: KEPT_FINISHED_WORK + 3 }, (_, index) => ({
      id: `old${String(index)}`,
      startedAt: new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString(),
    }));
    await runtime.store.batch(
      old.map((item) => ({
        type: 'put' as const,
        key: workKey(item),
        value: {
          ...item,
          memberId: 'm',
          memberName: 'M',
          roleId: 'artist',
          roleName: 'Artist',
          projectId: null,
          task: null,
          askedBy: { kind: 'user', id: 'arnd', name: null },
          parentId: null,
          status: 'completed',
          updatedAt: item.startedAt,
          endedAt: item.startedAt,
          steps: 1,
          maxSteps: 20,
          costUsd: 0,
          budgetUsd: 1,
          now: null,
          stages: [],
          subjects: [],
          commands: 0,
          summary: null,
          error: null,
        },
      })),
    );
    await run('crew.ask', { memberId: member.id, task: 'Again.' });
    const kept = await readWork(runtime.store);
    expect(kept).toHaveLength(KEPT_FINISHED_WORK + 1);
    expect(kept.some(({ id }) => id === 'old0')).toBe(false);
  });
});
