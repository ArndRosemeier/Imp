import { CommandRegistry } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { describe, expect, it } from 'vitest';
import { createCrewCommands, readCrewMember, RoleCatalog, type Role } from '../src/index.js';

const screenwriter: Role = {
  id: 'screenwriter',
  name: 'Screenwriter',
  summary: 'Writes and revises the script.',
  brief: 'You write screenplays.',
  scope: { prefixes: ['settings.'] },
};
const casting: Role = { ...screenwriter, id: 'casting-director', name: 'Casting Director' };
const user = { kind: 'user', id: 'arnd' } as const;

function setup() {
  const runtime = createTestRuntime();
  const registry = new CommandRegistry({ runtime }).register(
    ...createCrewCommands(new RoleCatalog([screenwriter, casting]), {
      commandIds: () => ['settings.get', 'settings.set', 'movie.scene.update'],
    }),
  );
  const run = async (id: string, input: unknown) => {
    const result = await registry.executeById(id, input, { actor: user });
    return result.status === 'ok' ? result.output : result;
  };
  return { runtime, run };
}

describe('RoleCatalog', () => {
  it('lists roles sorted by id and finds them', () => {
    const catalog = new RoleCatalog([screenwriter, casting]);
    expect(catalog.list().map((role) => role.id)).toEqual(['casting-director', 'screenwriter']);
    expect(catalog.get('screenwriter')).toBe(screenwriter);
    expect(catalog.get('nobody')).toBeUndefined();
    expect(new RoleCatalog().list()).toEqual([]);
  });

  it('refuses malformed and duplicate ids', () => {
    expect(() => new RoleCatalog([{ ...screenwriter, id: 'Screen Writer' }])).toThrow(/Invalid/);
    expect(() => new RoleCatalog([screenwriter, screenwriter])).toThrow(/twice/);
  });
});

describe('crew commands', () => {
  it('lists the roles available for hire', async () => {
    const { run } = setup();
    expect(await run('crew.roles', {})).toEqual({
      roles: [
        {
          id: 'casting-director',
          name: 'Casting Director',
          summary: 'Writes and revises the script.',
          custom: false,
        },
        {
          id: 'screenwriter',
          name: 'Screenwriter',
          summary: 'Writes and revises the script.',
          custom: false,
        },
      ],
    });
  });

  it('hires with defaults, lists and dismisses', async () => {
    const { run, runtime } = setup();
    const hired = await run('crew.hire', { roleId: 'screenwriter', model: 'vendor/model' });
    expect(hired).toEqual({
      id: 'id-0001',
      roleId: 'screenwriter',
      name: 'Screenwriter',
      model: 'vendor/model',
      budgetUsdPerRun: 1,
      hiredAt: '2026-01-01T00:00:00.001Z',
    });
    expect(await readCrewMember(runtime.store, 'id-0001')).toEqual(hired);

    await run('crew.hire', {
      roleId: 'casting-director',
      model: 'vendor/other',
      name: 'Cass',
      budgetUsdPerRun: 0.25,
    });
    expect(await run('crew.list', {})).toMatchObject({
      crew: [{ name: 'Screenwriter' }, { name: 'Cass', budgetUsdPerRun: 0.25 }],
    });

    expect(await run('crew.dismiss', { id: 'id-0001' })).toEqual({
      id: 'id-0001',
      dismissed: true,
    });
    expect(await run('crew.dismiss', { id: 'id-0001' })).toEqual({
      id: 'id-0001',
      dismissed: false,
    });
    expect(await readCrewMember(runtime.store, 'id-0001')).toBeUndefined();
  });

  it('refuses an unknown role and names the valid ones', async () => {
    const { run } = setup();
    await expect(run('crew.hire', { roleId: 'director', model: 'm' })).rejects.toMatchObject({
      code: 'invalid_input',
      details: ['roleId: must be one of casting-director, screenwriter'],
    });
  });
});

describe('custom roles', () => {
  const polisher = {
    name: 'Dialogue Polisher',
    summary: 'Tightens dialogue.',
    brief: 'You tighten dialogue without changing what is said.',
    commands: ['movie.scene.'],
  };

  it('creates a role that can be listed, read and hired for', async () => {
    const { run, runtime } = setup();
    expect(await run('crew.role.create', polisher)).toEqual({
      id: 'dialogue-polisher',
      name: 'Dialogue Polisher',
      summary: 'Tightens dialogue.',
      brief: polisher.brief,
      scope: { prefixes: ['movie.scene.'], effects: ['read', 'write'] },
    });
    const listed = (await run('crew.roles', {})) as { roles: { id: string; custom: boolean }[] };
    expect(listed.roles.map((role) => [role.id, role.custom])).toEqual([
      ['casting-director', false],
      ['dialogue-polisher', true],
      ['screenwriter', false],
    ]);
    expect(await run('crew.role.get', { id: 'dialogue-polisher' })).toMatchObject({
      custom: true,
      commands: ['movie.scene.'],
      effects: ['read', 'write'],
    });
    // A built-in role without limits reports that it may use everything.
    expect(await run('crew.role.get', { id: 'screenwriter' })).toMatchObject({
      custom: false,
      commands: ['settings.'],
      effects: ['read', 'write', 'spend', 'destructive'],
    });

    const hired = (await run('crew.hire', { roleId: 'dialogue-polisher', model: 'm' })) as {
      id: string;
    };
    expect(await readCrewMember(runtime.store, hired.id)).toMatchObject({
      name: 'Dialogue Polisher',
      roleId: 'dialogue-polisher',
    });
    const catalog = new RoleCatalog([screenwriter]);
    expect(await catalog.find(runtime.store, 'dialogue-polisher')).toMatchObject({
      scope: { prefixes: ['movie.scene.'] },
    });
    expect(await catalog.find(runtime.store, 'screenwriter')).toBe(screenwriter);
  });

  it('changes and deletes a custom role, but not while someone holds it', async () => {
    const { run } = setup();
    await run('crew.role.create', { ...polisher, id: 'polisher' });
    expect(
      await run('crew.role.update', { id: 'polisher', brief: 'Shorter.', effects: ['read'] }),
    ).toMatchObject({
      name: 'Dialogue Polisher',
      brief: 'Shorter.',
      scope: { prefixes: ['movie.scene.'], effects: ['read'] },
    });
    expect(
      await run('crew.role.update', { id: 'polisher', name: 'P', commands: ['settings.get'] }),
    ).toMatchObject({ name: 'P', brief: 'Shorter.', scope: { prefixes: ['settings.get'] } });

    const hired = (await run('crew.hire', { roleId: 'polisher', model: 'm' })) as { id: string };
    await expect(run('crew.role.delete', { id: 'polisher' })).rejects.toThrow(/Dismiss P first/);
    await run('crew.dismiss', { id: hired.id });
    expect(await run('crew.role.delete', { id: 'polisher' })).toEqual({ id: 'polisher' });
    await expect(run('crew.role.get', { id: 'polisher' })).rejects.toThrow(/Unknown role/);
  });

  it('refuses duplicates, built-in roles, unusable names and commands that do not exist', async () => {
    const { run } = setup();
    await run('crew.role.create', polisher);
    await expect(run('crew.role.create', polisher)).rejects.toThrow(/already exists/);
    await expect(run('crew.role.create', { ...polisher, id: 'screenwriter' })).rejects.toThrow(
      /already exists/,
    );
    await expect(run('crew.role.create', { ...polisher, name: '!!!' })).rejects.toThrow(
      /usable id/,
    );
    await expect(
      run('crew.role.create', { ...polisher, name: 'Other', commands: ['vault.'] }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('"vault."') as string,
      details: [expect.stringContaining('settings.get') as string],
    });
    await expect(
      run('crew.role.update', { id: 'dialogue-polisher', commands: ['nope'] }),
    ).rejects.toThrow(/No command starts with/);
    for (const id of ['crew.role.update', 'crew.role.delete']) {
      await expect(run(id, { id: 'screenwriter' })).rejects.toThrow(/built-in role/);
      await expect(run(id, { id: 'nobody' })).rejects.toThrow(/No custom role/);
    }
  });

  it('accepts any command when the host does not say which exist', async () => {
    const runtime = createTestRuntime();
    const registry = new CommandRegistry({ runtime }).register(
      ...createCrewCommands(new RoleCatalog()),
    );
    const result = await registry.executeById(
      'crew.role.create',
      { ...polisher, commands: ['anything.'] },
      { actor: user },
    );
    expect(result.status).toBe('ok');
  });
});
