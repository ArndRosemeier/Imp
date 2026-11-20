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
    ...createCrewCommands(new RoleCatalog([screenwriter, casting])),
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
        },
        { id: 'screenwriter', name: 'Screenwriter', summary: 'Writes and revises the script.' },
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
