import { MemoryBlobStore, MemoryKeyValueStore } from '@imp/core';
import { createFakeProvider } from '@imp/providers/testing';
import { describe, expect, it } from 'vitest';
import { createImp, createMemorySecretStore } from '../src/index.js';

const user = { kind: 'user', id: 'arnd' } as const;
const usage = { promptTokens: 1, cachedPromptTokens: 0, completionTokens: 1, costUsd: 0.001 };

interface Run {
  status: string;
  pendingApprovals: unknown[];
}

/**
 * The Casting Director asked for two portraits in a live run (2026-11-23) and
 * both waited for approval although the budget was set: no picture model was
 * chosen, so they had no price. Within the budget they run unasked; without a
 * model the agent is told at once what to set, and nothing waits.
 */
describe('a crew member spending within the budget', () => {
  async function castingRun(imageModel: string | null) {
    const fake = createFakeProvider({});
    const imp = createImp({
      store: new MemoryKeyValueStore(),
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
    if (imageModel !== null) await run('settings.set', { key: 'images.model', value: imageModel });
    await run('movie.development.update', { projectId, logline: 'A storm.' });
    await run('project.checkpoint.approve', { projectId, checkpointId: 'treatment' });
    await run('movie.style.update', { projectId, palette: 'Cold greys.' });
    const { id: characterId } = await run<{ id: string }>('movie.character.create', {
      projectId,
      name: 'Mara',
      appearance: 'Sixties, weathered.',
    });
    const { id: memberId } = await run<{ id: string }>('crew.hire', {
      roleId: 'casting-director',
      model: 'vendor/chat',
    });
    const args = { projectId, characterId };
    const call = (id: string) => ({
      id,
      name: 'movie__character__image__generate',
      arguments: args,
      argumentsText: JSON.stringify(args),
    });
    fake.script(
      { toolCalls: [call('a'), call('b')], finishReason: 'tool_calls', usage },
      { content: 'Done.', finishReason: 'stop', usage },
    );
    const result = await run<Run>('crew.ask', { memberId, task: 'Make two portraits of Mara.' });
    return { result, fake };
  }

  it('makes the portraits without asking', async () => {
    const { result, fake } = await castingRun('vendor/painter');
    expect(result.status).toBe('completed');
    expect(result.pendingApprovals).toEqual([]);
    expect(fake.imageRequests).toHaveLength(2);
  });

  it('tells the agent to choose a picture model instead of asking for approval', async () => {
    const { result, fake } = await castingRun(null);
    expect(result.pendingApprovals).toEqual([]);
    expect(fake.imageRequests).toHaveLength(0);
    const told = JSON.stringify(fake.requests.at(-1)?.messages.at(-1));
    expect(told).toMatch(/No image model is chosen/);
  });
});
