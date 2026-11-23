import { MemoryBlobStore, MemoryKeyValueStore, type JsonValue } from '@imp/core';
import { createFakeProvider } from '@imp/providers/testing';
import { describe, expect, it } from 'vitest';
import { storyboardForClips } from '@imp/mode-movie';
import { createImp, createMemorySecretStore } from '../src/index.js';

const user = { kind: 'user', id: 'arnd' } as const;
const usage = { promptTokens: 1, cachedPromptTokens: 0, completionTokens: 1, costUsd: 0.001 };

interface Run {
  status: string;
  pendingApprovals: { commandId: string }[];
}
interface Checkpoints {
  style: string;
  checkpoints: { id: string; stops: boolean; signedAt: string | null; items: unknown[] }[];
}

/**
 * Arnd (2026-11-23): a new project made the crew cast, write and shoot with
 * no question asked. The crew now stops at the treatment, the storyboard of
 * each scene and the first cut of each scene, and only the person signs one
 * off; the working style lets them say how far it goes on its own.
 */
describe('checkpoints', () => {
  async function setUp() {
    const fake = createFakeProvider({});
    const store = new MemoryKeyValueStore();
    const imp = createImp({
      store,
      blobs: new MemoryBlobStore(),
      secrets: createMemorySecretStore(),
      provider: fake,
    });
    const run = async <T>(id: string, input: unknown): Promise<T> => {
      const result = await imp.registry.executeById(id, input, { actor: user });
      if (result.status !== 'ok') throw new Error(`${id}: ${result.status}`);
      return result.output as T;
    };
    const { id: projectId } = await run<{ id: string }>('project.create', {
      name: 'Storm',
      mode: 'movie',
    });
    await run('project.open', { projectId });
    await run('settings.set', { key: 'images.model', value: 'vendor/painter' });
    await run('movie.development.update', { projectId, logline: 'A storm.' });
    const tool = (id: string, command: string, args: Record<string, JsonValue>) => ({
      id,
      name: command.replaceAll('.', '__'),
      arguments: args,
      argumentsText: JSON.stringify(args),
    });
    const ask = async (roleId: string, calls: ReturnType<typeof tool>[]) => {
      const { id: memberId } = await run<{ id: string }>('crew.hire', {
        roleId,
        model: 'vendor/chat',
      });
      fake.script(
        { toolCalls: calls, finishReason: 'tool_calls', usage },
        { content: 'Done.', finishReason: 'stop', usage },
      );
      const result = await run<Run>('crew.ask', { memberId, task: 'Go.' });
      const told = JSON.stringify(fake.requests.at(-1)?.messages);
      return { result, told };
    };
    return { imp, fake, store, run, projectId, tool, ask };
  }

  it('lists the four checkpoints of a film, stopping at each by default', async () => {
    const { run, projectId } = await setUp();
    const listed = await run<Checkpoints>('project.checkpoint.list', { projectId });
    expect(listed.style).toBe('each');
    expect(listed.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint.stops])).toEqual([
      ['treatment', true],
      ['storyboard', true],
      ['first-cut', true],
      ['fine-cut', true],
    ]);
  });

  it('keeps casting waiting until the treatment is signed off', async () => {
    const { fake, run, projectId, tool, ask } = await setUp();
    const { result, told } = await ask('casting-director', [
      tool('a', 'movie.character.create', { projectId, name: 'Mara', appearance: 'Sixties.' }),
    ]);
    expect(result.status).toBe('completed');
    expect(told).toMatch(/waits for The person's sign-off of the treatment/);
    expect(fake.imageRequests).toHaveLength(0);
    const characters = await run<{ characters: unknown[] }>('movie.character.list', { projectId });
    expect(characters.characters).toHaveLength(0);

    await run('project.checkpoint.approve', { projectId, checkpointId: 'treatment' });
    await ask('casting-director', [
      tool('b', 'movie.character.create', { projectId, name: 'Mara', appearance: 'Sixties.' }),
    ]);
    const after = await run<{ characters: unknown[] }>('movie.character.list', { projectId });
    expect(after.characters).toHaveLength(1);
  });

  it("puts an agent's sign-off and working style to the person every time", async () => {
    const { run, projectId, tool, ask } = await setUp();
    await expect(
      run('crew.approvals.always.set', { commandId: 'project.checkpoint.approve' }),
    ).rejects.toThrow();
    const { result } = await ask('coordinator', [
      tool('a', 'project.checkpoint.approve', { projectId, checkpointId: 'treatment' }),
      tool('b', 'project.checkpoint.style', { projectId, style: 'none' }),
    ]);
    expect(result.pendingApprovals.map((pending) => pending.commandId)).toEqual([
      'project.checkpoint.approve',
      'project.checkpoint.style',
    ]);
    const listed = await run<Checkpoints>('project.checkpoint.list', { projectId });
    expect(listed.style).toBe('each');
    expect(listed.checkpoints[0]?.signedAt).toBeNull();
  });

  it('cannot be waived', async () => {
    const { run } = await setUp();
    await expect(
      run('crew.needs.waive', { need: 'checkpoint:treatment', reason: 'In a hurry' }),
    ).rejects.toThrow();
  });

  it('holds back the clips of a scene until its storyboard is signed off', async () => {
    const { run, store, projectId } = await setUp();
    await run('project.checkpoint.approve', { projectId, checkpointId: 'treatment' });
    const { id: sceneId } = await run<{ id: string }>('movie.scene.create', {
      projectId,
      heading: 'EXT. CLIFF - NIGHT',
    });
    const { id: otherId } = await run<{ id: string }>('movie.scene.create', {
      projectId,
      heading: 'INT. HUT - NIGHT',
    });
    await run('project.checkpoint.approve', {
      projectId,
      checkpointId: 'storyboard',
      itemIds: [sceneId],
    });
    const listed = await run<Checkpoints>('project.checkpoint.list', { projectId });
    expect(listed.checkpoints[1]?.items.map((item) => (item as { itemId: string }).itemId)).toEqual(
      [sceneId],
    );

    const need = storyboardForClips;
    expect(need.before).toContain('movie.shot.clip.generate');
    expect(await need.check?.(store, projectId, { projectId, sceneId })).toBe(true);
    expect(await need.check?.(store, projectId, { projectId, sceneId: otherId })).toBe(false);
  });

  it('lets the crew through when the working style says so', async () => {
    const { run, projectId, tool, ask } = await setUp();
    await run('project.checkpoint.style', { projectId, style: 'main' });
    const listed = await run<Checkpoints>('project.checkpoint.list', { projectId });
    expect(listed.checkpoints.map((checkpoint) => checkpoint.stops)).toEqual([
      false,
      true,
      false,
      false,
    ]);
    await ask('casting-director', [
      tool('a', 'movie.character.create', { projectId, name: 'Mara', appearance: 'Sixties.' }),
    ]);
    const characters = await run<{ characters: unknown[] }>('movie.character.list', { projectId });
    expect(characters.characters).toHaveLength(1);
  });

  it('takes a sign-off back', async () => {
    const { run, projectId } = await setUp();
    await run('project.checkpoint.approve', { projectId, checkpointId: 'treatment' });
    await run('project.checkpoint.reopen', { projectId, checkpointId: 'treatment' });
    const listed = await run<Checkpoints>('project.checkpoint.list', { projectId });
    expect(listed.checkpoints[0]?.signedAt).toBeNull();
    await expect(
      run('project.checkpoint.approve', { projectId, checkpointId: 'storyboard' }),
    ).rejects.toThrow(/name the scenes/);
  });
});
