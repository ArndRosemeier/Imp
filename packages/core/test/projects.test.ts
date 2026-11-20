import { describe, expect, it } from 'vitest';
import {
  CommandRegistry,
  projectCommands,
  projectCreate,
  projectDelete,
  projectList,
  projectPrefix,
  projectRename,
  requireProject,
} from '../src/index.js';
import { createTestRuntime } from '../src/testing.js';

const user = { kind: 'user', id: 'arnd' } as const;
const agent = { kind: 'agent', id: 'a', role: 'coordinator' } as const;

function setup() {
  const runtime = createTestRuntime();
  const registry = new CommandRegistry({ runtime }).register(...projectCommands);
  const create = async (name: string, mode = 'movie') => {
    const result = await registry.execute(projectCreate, { name, mode }, { actor: user });
    if (result.status !== 'ok') throw new Error('not ok');
    return result.output;
  };
  return { runtime, registry, create };
}

describe('project commands', () => {
  it('creates, lists oldest first and renames', async () => {
    const { registry, create } = setup();
    const first = await create('The Lighthouse Keeper');
    const second = await create('Second');
    expect(first).toMatchObject({ name: 'The Lighthouse Keeper', mode: 'movie' });

    await registry.execute(projectRename, { projectId: first.id, name: 'Keeper' }, { actor: user });
    const listed = await registry.execute(projectList, {}, { actor: user });
    expect(listed.status === 'ok' && listed.output.projects.map((p) => p.name)).toEqual([
      'Keeper',
      'Second',
    ]);
    expect(second.id).not.toBe(first.id);
  });

  it('deletes a project with everything under it, and only that', async () => {
    const { registry, runtime, create } = setup();
    const doomed = await create('Doomed');
    const kept = await create('Kept');
    await runtime.store.batch([
      { type: 'put', key: `${projectPrefix(doomed.id)}movie/scenes/1`, value: 1 },
      { type: 'put', key: `${projectPrefix(kept.id)}movie/scenes/1`, value: 1 },
    ]);
    const image = { bytes: new Uint8Array([1]), mediaType: 'image/png' };
    await runtime.blobs.put(`${projectPrefix(doomed.id)}movie/images/1`, image);
    await runtime.blobs.put(`${projectPrefix(kept.id)}movie/images/1`, image);
    const result = await registry.execute(projectDelete, { projectId: doomed.id }, { actor: user });
    expect(result).toEqual({ status: 'ok', output: { projectId: doomed.id, removedEntries: 2 } });
    expect(await runtime.blobs.list('')).toEqual([`${projectPrefix(kept.id)}movie/images/1`]);
    expect(await runtime.store.list(projectPrefix(doomed.id))).toEqual([]);
    expect(await runtime.store.list(projectPrefix(kept.id))).toHaveLength(1);
    const listed = await registry.execute(projectList, {}, { actor: user });
    expect(listed.status === 'ok' && listed.output.projects).toHaveLength(1);
  });

  it('makes an agent ask before deleting', async () => {
    const { registry, create } = setup();
    const project = await create('Safe');
    const result = await registry.execute(
      projectDelete,
      { projectId: project.id },
      { actor: agent },
    );
    expect(result.status).toBe('needs-approval');
  });

  it('refuses unknown projects and projects of another mode', async () => {
    const { registry, runtime, create } = setup();
    await expect(
      registry.execute(projectRename, { projectId: 'nope', name: 'x' }, { actor: user }),
    ).rejects.toThrow(/No project "nope"/);
    await expect(
      registry.execute(projectDelete, { projectId: 'nope' }, { actor: user }),
    ).rejects.toThrow(/No project/);
    const podcast = await create('Talk', 'podcast');
    await expect(requireProject(runtime.store, 'movie.x', podcast.id, 'movie')).rejects.toThrow(
      /is a podcast project, not a movie project/,
    );
    expect(await requireProject(runtime.store, 'movie.x', podcast.id, 'podcast')).toEqual(podcast);
  });
});
