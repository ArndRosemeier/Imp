/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */
import { CommandRegistry, settingsCommands } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { describe, expect, it } from 'vitest';
import {
  coordinatorRole,
  createCrewCommands,
  createModelMixCommands,
  RoleCatalog,
} from '../src/index.js';

const user = { kind: 'user', id: 'arnd' } as const;

function setup() {
  const runtime = createTestRuntime();
  const roles = new RoleCatalog([coordinatorRole]);
  const registry = new CommandRegistry({ runtime }).register(
    ...settingsCommands,
    ...createCrewCommands(roles, { commandIds: () => [] }),
    ...createModelMixCommands([
      { setting: 'coordinator.model', label: 'Agents' },
      { setting: 'video.model', label: 'Video' },
      { setting: 'images.model', label: 'Pictures' },
    ]),
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
  const setting = async (key: string) => (await run('settings.get', { key })).value;
  return { run, fails, setting };
}

describe('model mixes', () => {
  it('keep the models in use under a name and swap whole sets at once', async () => {
    const { run, fails, setting } = setup();
    expect(await fails('models.mix.save', { name: 'Nothing' })).toMatch(/No models/);
    const coordinator = await run('crew.hire', { roleId: 'coordinator', model: 'cheap/agent' });
    await run('settings.set', { key: 'coordinator.member', value: coordinator.id });
    await run('settings.set', { key: 'coordinator.model', value: 'cheap/agent' });
    await run('settings.set', { key: 'video.model', value: 'cheap/video' });

    const draft = await run('models.mix.save', { name: 'Draft', notes: 'cheap' });
    expect(draft.models).toEqual({
      'coordinator.model': 'cheap/agent',
      'video.model': 'cheap/video',
    });
    let listed = await run('models.mix.list', {});
    expect(listed).toMatchObject({ active: draft.id, changed: false });
    expect(listed.slots).toHaveLength(3);

    const final = await run('models.mix.save', {
      name: 'Final',
      models: {
        'coordinator.model': 'best/agent',
        'video.model': 'best/video',
        'images.model': 'best/image',
      },
    });
    // Saving given models does not switch to them.
    expect((await run('models.mix.list', {})).active).toBe(draft.id);
    expect(await fails('models.mix.save', { name: 'Odd', models: { 'nope.model': 'x' } })).toMatch(
      /Invalid input/,
    );

    await run('models.mix.apply', { id: final.id });
    expect(await setting('video.model')).toBe('best/video');
    expect(await setting('images.model')).toBe('best/image');
    expect((await run('crew.list', {})).crew[0].model).toBe('best/agent');
    listed = await run('models.mix.list', {});
    expect(listed).toMatchObject({ active: final.id, changed: false });
    expect(listed.mixes.map((mix: { name: string }) => mix.name)).toEqual(['Draft', 'Final']);

    // Changing one model by hand leaves the mix marked as changed.
    await run('settings.set', { key: 'video.model', value: 'other/video' });
    expect((await run('models.mix.list', {})).changed).toBe(true);

    // Overwriting keeps the id and the name unless told otherwise.
    const updated = await run('models.mix.save', { id: final.id });
    expect(updated).toMatchObject({ id: final.id, name: 'Final', savedAt: final.savedAt });
    expect(updated.models['video.model']).toBe('other/video');
    expect(await fails('models.mix.save', {})).toMatch(/name/);
    expect(await fails('models.mix.apply', { id: 'nope' })).toMatch(/No model mix/);

    await run('models.mix.delete', { id: final.id });
    listed = await run('models.mix.list', {});
    expect(listed.active).toBeNull();
    await run('models.mix.delete', { id: draft.id });
    expect(await fails('models.mix.delete', { id: draft.id })).toMatch(/No model mix/);
  });

  it('applies a mix without an agents model and without a coordinator', async () => {
    const { run, setting } = setup();
    const mix = await run('models.mix.save', {
      name: 'Pictures',
      models: { 'images.model': 'a/b' },
    });
    await run('models.mix.apply', { id: mix.id });
    expect(await setting('images.model')).toBe('a/b');
    const agents = await run('models.mix.save', {
      name: 'Agents',
      models: { 'coordinator.model': 'x/y' },
    });
    expect((await run('models.mix.apply', { id: agents.id })).applied).toEqual({
      'coordinator.model': 'x/y',
    });
  });
});
