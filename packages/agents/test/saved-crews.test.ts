/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-explicit-any */
import { CommandRegistry } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { describe, expect, it } from 'vitest';
import {
  coordinatorRole,
  createCrewCommands,
  createSavedCrewCommands,
  RoleCatalog,
  type Role,
} from '../src/index.js';

const screenwriter: Role = {
  id: 'screenwriter',
  name: 'Screenwriter',
  summary: 'Writes and revises the script.',
  brief: 'You write screenplays.',
  scope: { prefixes: ['settings.'] },
};
const user = { kind: 'user', id: 'arnd' } as const;

function setup() {
  const runtime = createTestRuntime();
  const roles = new RoleCatalog([coordinatorRole, screenwriter]);
  const registry = new CommandRegistry({ runtime }).register(
    ...createCrewCommands(roles, { commandIds: () => ['settings.get'] }),
    ...createSavedCrewCommands(roles),
  );
  const run = async (id: string, input: unknown): Promise<any> => {
    const result = await registry.executeById(id, input, { actor: user });
    if (result.status !== 'ok') throw new Error(`${id}: ${JSON.stringify(result)}`);
    return result.output;
  };
  const fails = async (id: string, input: unknown): Promise<string> => {
    try {
      const result = await registry.executeById(id, input, { actor: user });
      return result.status === 'ok' ? 'not refused' : JSON.stringify(result);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  const crewNames = async () =>
    ((await run('crew.list', {})).crew as { name: string }[]).map((member) => member.name).sort();
  return { runtime, run, fails, crewNames };
}

describe('saved crews', () => {
  it('keep the current crew under a name and bring it back, keeping the coordinator', async () => {
    const { run, fails, crewNames } = setup();
    expect(await fails('crew.saved.save', { name: 'Empty' })).toMatch(/empty/);
    const boss = await run('crew.hire', { roleId: 'coordinator', model: 'm/boss' });
    await run('crew.role.create', {
      id: 'critic',
      name: 'Critic',
      brief: 'You judge cuts.',
      commands: ['settings.get'],
      writes: [],
    });
    await run('crew.hire', { roleId: 'screenwriter', model: 'm/a', name: 'Ada', webSearch: true });
    await run('crew.hire', { roleId: 'critic', model: 'm/b', budgetUsdPerRun: 2 });
    expect(await fails('crew.saved.save', {})).toMatch(/name/);

    const drama = await run('crew.saved.save', { name: 'Drama team', notes: 'For dialogue' });
    expect(drama).toMatchObject({
      name: 'Drama team',
      notes: 'For dialogue',
      members: [
        { roleId: 'coordinator', name: 'Coordinator', model: 'm/boss' },
        { roleId: 'screenwriter', name: 'Ada', model: 'm/a', webSearch: true },
        { roleId: 'critic', name: 'Critic', budgetUsdPerRun: 2 },
      ],
      roles: [{ id: 'critic', name: 'Critic' }],
    });
    expect(await run('crew.saved.get', { id: drama.id })).toEqual(drama);

    // A different crew, then the saved one back in its place.
    for (const member of (await run('crew.list', {})).crew) {
      if (member.roleId !== 'coordinator') await run('crew.dismiss', { id: member.id });
    }
    await run('crew.role.delete', { id: 'critic' });
    await run('crew.hire', { roleId: 'screenwriter', model: 'm/c', name: 'Bo' });
    const loaded = await run('crew.saved.load', { id: drama.id });
    expect(loaded.dismissed).toEqual(['Bo']);
    expect(loaded.rolesRestored).toEqual(['critic']);
    expect(loaded.hired.map((member: any) => member.name)).toEqual(['Ada', 'Critic']);
    expect(await crewNames()).toEqual(['Ada', 'Coordinator', 'Critic']);
    expect((await run('crew.list', {})).crew.find((m: any) => m.roleId === 'coordinator').id).toBe(
      boss.id,
    );

    // Added to the crew instead of replacing it.
    const added = await run('crew.saved.load', { id: drama.id, replace: false });
    expect(added.dismissed).toEqual([]);
    expect(await crewNames()).toEqual(['Ada', 'Ada', 'Coordinator', 'Critic', 'Critic']);

    // Overwrite with the current crew, rename, search, delete.
    const resaved = await run('crew.saved.save', { id: drama.id });
    expect(resaved.members).toHaveLength(5);
    expect(resaved.name).toBe('Drama team');
    expect(resaved.savedAt).toBe(drama.savedAt);
    const renamed = await run('crew.saved.update', { id: drama.id, name: 'Big team' });
    expect(renamed).toMatchObject({ name: 'Big team', notes: 'For dialogue' });
    await run('crew.saved.save', { name: 'Solo' });
    expect((await run('crew.saved.list', {})).crews.map((crew: any) => crew.name)).toEqual([
      'Big team',
      'Solo',
    ]);
    expect(
      (await run('crew.saved.list', { query: 'dialogue' })).crews.map((crew: any) => crew.name),
    ).toEqual(['Big team']);
    expect((await run('crew.saved.list', { query: 'ada' })).crews[0].members[1]).toEqual({
      roleId: 'screenwriter',
      name: 'Ada',
      model: 'm/a',
    });
    await run('crew.saved.delete', { id: drama.id });
    expect(await fails('crew.saved.get', { id: drama.id })).toMatch(/No saved crew/);
    expect(await fails('crew.saved.load', { id: 'nope' })).toMatch(/No saved crew/);
  });

  it('hire a saved coordinator only when there is none, and refuse a role that is gone', async () => {
    const { runtime, run, fails, crewNames } = setup();
    await run('crew.hire', { roleId: 'coordinator', model: 'm/boss' });
    const saved = await run('crew.saved.save', { name: 'Just me' });
    for (const member of (await run('crew.list', {})).crew) {
      await run('crew.dismiss', { id: member.id });
    }
    await run('crew.saved.load', { id: saved.id });
    expect(await crewNames()).toEqual(['Coordinator']);

    await runtime.store.batch([
      {
        type: 'put',
        key: `saved-crews/${saved.id}`,
        value: { ...saved, members: [{ ...saved.members[0], roleId: 'ghost', name: 'Ghost' }] },
      },
    ]);
    expect(await fails('crew.saved.load', { id: saved.id })).toMatch(/"ghost" of Ghost/);
  });
});
