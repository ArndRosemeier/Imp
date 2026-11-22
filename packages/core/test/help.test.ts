import { describe, expect, it } from 'vitest';
import {
  CommandRegistry,
  createHelpCommands,
  settingsCommands,
  type GuideTopic,
} from '../src/index.js';
import { createTestRuntime } from '../src/testing.js';

const pages: GuideTopic[] = [
  {
    id: 'getting-started',
    area: 'workspace',
    title: 'Getting started',
    summary: 'What Imp is.',
    body: 'Tell the coordinator your story.',
  },
  {
    id: 'stage-edit',
    area: 'edit',
    title: 'Edit',
    summary: 'Join clips into the film.',
    body: 'Drag a dissolve between two shots.',
    hint: { title: 'Put the film together', body: 'Open a scene.' },
  },
  {
    id: 'costs',
    area: 'workspace',
    title: 'What things cost',
    summary: 'Prices of clips and pictures.',
    body: 'A clip costs more than an edit.',
  },
];

function setup(topics: readonly GuideTopic[] = pages) {
  const registry = new CommandRegistry({ runtime: createTestRuntime() }).register(
    ...settingsCommands,
    ...createHelpCommands(topics),
  );
  // An agent, as the help agent and the coordinator use these commands too.
  return async (id: string, input: unknown): Promise<unknown> => {
    const result = await registry.executeById(id, input, {
      actor: { kind: 'agent', id: 'a', role: 'coordinator' },
    });
    if (result.status !== 'ok') throw new Error(`${id}: ${result.status}`);
    return result.output;
  };
}

describe('help commands', () => {
  it('show tips by default, with none closed', async () => {
    expect(await setup()('help.state', {})).toEqual({ enabled: true, dismissed: [] });
  });

  it('close one tip at a time, once each', async () => {
    const run = setup();
    await run('help.hint.dismiss', { id: 'stage.edit' });
    await run('help.hint.dismiss', { id: 'stage.edit' });
    await run('help.hint.dismiss', { id: 'stage.shots' });
    expect(await run('help.state', {})).toEqual({
      enabled: true,
      dismissed: ['stage.edit', 'stage.shots'],
    });
  });

  it('turn every tip off in one step, and back on with the closed ones again', async () => {
    const run = setup();
    await run('help.hint.dismiss', { id: 'stage.edit' });
    expect(await run('help.set', { enabled: false })).toEqual({
      enabled: false,
      dismissed: ['stage.edit'],
    });
    // Kept as ordinary settings, so the coordinator sees them with settings.list.
    expect(await run('settings.get', { key: 'help.enabled' })).toMatchObject({ value: false });
    expect(await run('help.set', { enabled: true, reset: true })).toEqual({
      enabled: true,
      dismissed: [],
    });
  });

  it('list and search the guide, best matches first', async () => {
    const run = setup();
    expect(await run('help.topics', {})).toMatchObject({
      topics: [{ id: 'getting-started' }, { id: 'stage-edit' }, { id: 'costs' }],
    });
    expect(await run('help.topics', { query: 'clip cost' })).toMatchObject({
      topics: [{ id: 'costs' }, { id: 'stage-edit' }],
    });
    expect(await run('help.topics', { query: 'dissolve' })).toMatchObject({
      topics: [{ id: 'stage-edit' }],
    });
    expect(await run('help.topics', { area: 'edit' })).toMatchObject({
      topics: [{ id: 'stage-edit' }],
    });
    expect(await run('help.topics', { query: 'xylophone' })).toEqual({ topics: [] });
  });

  it('read one page in full, and say so when it does not exist', async () => {
    const run = setup();
    expect(await run('help.topic', { id: 'stage-edit' })).toMatchObject({
      title: 'Edit',
      hint: { title: 'Put the film together' },
    });
    await expect(run('help.topic', { id: 'nope' })).rejects.toThrow();
  });

  it('refuse a guide with the same page twice', () => {
    const [page] = pages;
    if (page === undefined) throw new Error('No page.');
    expect(() => createHelpCommands([page, page])).toThrow(/twice/);
  });
});
