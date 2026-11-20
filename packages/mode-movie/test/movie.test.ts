import { RoleCatalog } from '@imp/agents';
import {
  CommandRegistry,
  isInScope,
  projectCommands,
  projectCreate,
  type Command,
} from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { describe, expect, it } from 'vitest';
import { castingDirector, movieCommands, movieMode, screenwriter } from '../src/index.js';

const user = { kind: 'user', id: 'arnd' } as const;
const writer = { kind: 'agent', id: 'w', role: 'screenwriter' } as const;

async function setup() {
  const runtime = createTestRuntime();
  const registry = new CommandRegistry({ runtime }).register(...projectCommands, ...movieCommands);
  const created = await registry.execute(
    projectCreate,
    { name: 'The Lighthouse Keeper', mode: 'movie' },
    { actor: user },
  );
  if (created.status !== 'ok') throw new Error('not ok');
  const projectId = created.output.id;
  const run = async (
    id: string,
    input: Record<string, unknown>,
    actor: typeof user | typeof writer = user,
  ) => {
    const result = await registry.executeById(id, { projectId, ...input }, { actor });
    if (result.status !== 'ok') throw new Error(`${id}: ${result.status}`);
    return result.output as { id: string } & Record<string, unknown>;
  };
  return { runtime, registry, projectId, run };
}

interface Listed {
  scenes: { id: string; heading: string; position: number }[];
}
const headings = (listed: unknown): string[] =>
  (listed as Listed).scenes.map((scene) => `${String(scene.position)} ${scene.heading}`);

describe('the movie mode', () => {
  it('is a consistent mode with its roles limited to its own commands', () => {
    expect(movieMode.stages.map((stage) => stage.id)).toEqual(['development', 'script', 'casting']);
    expect(() => new RoleCatalog(movieMode.roles)).not.toThrow();
    const outside = projectCommands.filter((command: Command) =>
      isInScope(command, screenwriter.scope),
    );
    expect(outside.map((command) => command.id)).toEqual(['project.list']);
    expect(movieCommands.every((command) => isInScope(command, castingDirector.scope))).toBe(true);
  });

  it('refuses projects that do not exist or belong to another mode', async () => {
    const { registry } = await setup();
    const other = await registry.execute(
      projectCreate,
      { name: 'Song', mode: 'music' },
      { actor: user },
    );
    if (other.status !== 'ok') throw new Error('not ok');
    for (const projectId of ['missing', other.output.id]) {
      await expect(
        registry.executeById('movie.scene.list', { projectId }, { actor: user }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });
});

describe('development', () => {
  it('starts empty and changes only the fields given', async () => {
    const { run } = await setup();
    expect(await run('movie.development.get', {})).toEqual({
      logline: '',
      premise: '',
      tone: '',
      treatment: '',
    });
    await run('movie.development.update', { logline: 'A keeper finds a light that is alive.' });
    await run('movie.development.update', { tone: 'Quiet, wet, warm.' });
    expect(await run('movie.development.get', {})).toEqual({
      logline: 'A keeper finds a light that is alive.',
      premise: '',
      tone: 'Quiet, wet, warm.',
      treatment: '',
    });
  });
});

describe('scenes', () => {
  it('appends, inserts and keeps positions gapless', async () => {
    const { run } = await setup();
    await run('movie.scene.create', { heading: 'EXT. HARBOUR - DUSK' });
    await run('movie.scene.create', { heading: 'INT. LAMP ROOM - NIGHT' });
    const inserted = await run('movie.scene.create', {
      heading: 'INT. STAIRS - NIGHT',
      position: 2,
    });
    expect(inserted).toMatchObject({ position: 2, summary: '', body: '' });
    await run('movie.scene.create', { heading: 'EXT. SEA - DAWN', position: 99 });
    expect(headings(await run('movie.scene.list', {}))).toEqual([
      '1 EXT. HARBOUR - DUSK',
      '2 INT. STAIRS - NIGHT',
      '3 INT. LAMP ROOM - NIGHT',
      '4 EXT. SEA - DAWN',
    ]);
  });

  it('changes text in place and moves a scene', async () => {
    const { run } = await setup();
    const a = await run('movie.scene.create', { heading: 'A' });
    await run('movie.scene.create', { heading: 'B' });
    await run('movie.scene.create', { heading: 'C' });

    const edited = await run('movie.scene.update', { sceneId: a.id, body: 'Mara climbs.' });
    expect(edited).toMatchObject({ heading: 'A', body: 'Mara climbs.', position: 1 });

    const moved = await run('movie.scene.update', { sceneId: a.id, position: 3, heading: 'A2' });
    expect(moved).toMatchObject({ position: 3, body: 'Mara climbs.' });
    expect(headings(await run('movie.scene.list', {}))).toEqual(['1 B', '2 C', '3 A2']);

    await run('movie.scene.update', { sceneId: a.id, position: 1, summary: 'She climbs.' });
    expect(headings(await run('movie.scene.list', {}))).toEqual(['1 A2', '2 B', '3 C']);
  });

  it('deletes with renumbering, and an agent needs approval for it', async () => {
    const { run, registry, projectId } = await setup();
    const a = await run('movie.scene.create', { heading: 'A' });
    await run('movie.scene.create', { heading: 'B' });

    const asked = await registry.executeById(
      'movie.scene.delete',
      { projectId, sceneId: a.id },
      { actor: writer },
    );
    expect(asked.status).toBe('needs-approval');

    expect(await run('movie.scene.delete', { sceneId: a.id })).toEqual({
      sceneId: a.id,
      remaining: 1,
    });
    expect(headings(await run('movie.scene.list', {}))).toEqual(['1 B']);
  });

  it('refuses unknown scenes', async () => {
    const { registry, projectId } = await setup();
    for (const id of ['movie.scene.update', 'movie.scene.delete']) {
      await expect(
        registry.executeById(id, { projectId, sceneId: 'nope' }, { actor: user }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });
});

describe('characters', () => {
  it('creates, lists by name, changes and deletes', async () => {
    const { run, registry, projectId } = await setup();
    const tomas = await run('movie.character.create', { name: 'Tomas' });
    const mara = await run(
      'movie.character.create',
      { name: 'Mara', part: 'protagonist', appearance: 'Sixty, wiry, grey braid.' },
      writer,
    );
    expect(tomas).toMatchObject({ part: '', description: '', appearance: '', voice: '' });

    await run('movie.character.update', { characterId: mara.id, voice: 'Low and dry.' });
    const listed = (await run('movie.character.list', {})) as unknown as {
      characters: Record<string, string>[];
    };
    expect(listed.characters).toEqual([
      {
        id: mara.id,
        name: 'Mara',
        part: 'protagonist',
        description: '',
        appearance: 'Sixty, wiry, grey braid.',
        voice: 'Low and dry.',
      },
      expect.objectContaining({ name: 'Tomas' }),
    ]);

    expect(await run('movie.character.delete', { characterId: tomas.id })).toEqual({
      characterId: tomas.id,
    });
    for (const id of ['movie.character.update', 'movie.character.delete']) {
      await expect(
        registry.executeById(id, { projectId, characterId: tomas.id }, { actor: user }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });
});
