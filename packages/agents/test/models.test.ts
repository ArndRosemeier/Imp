import { CommandRegistry } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import type { ModelInfo } from '@imp/providers';
import { createFakeProvider } from '@imp/providers/testing';
import { describe, expect, it } from 'vitest';
import { createModelCommands } from '../src/index.js';

const model = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  name: id.toUpperCase(),
  inputModalities: ['text'],
  outputModalities: ['text'],
  contextLength: 1000,
  supportsTools: true,
  pricing: { promptUsdPerToken: null, completionUsdPerToken: null },
  ...extra,
});

describe('models.list', () => {
  const provider = createFakeProvider({
    models: [
      model('b/writer', {
        pricing: { promptUsdPerToken: 0.000003, completionUsdPerToken: 0.000015 },
      }),
      model('c/cheap', { pricing: { promptUsdPerToken: 1e-7, completionUsdPerToken: 4e-7 } }),
      model('a/plain', { supportsTools: false }),
      model('~a/latest'),
      model('meta/muse-image', { outputModalities: ['image'] }),
      ...Array.from({ length: 30 }, (_, index) => model(`bulk/m${String(index).padStart(2, '0')}`)),
    ],
  });
  const registry = new CommandRegistry({ runtime: createTestRuntime() }).register(
    ...createModelCommands(provider),
  );
  const list = async (input: unknown) => {
    const result = await registry.executeById('models.list', input, {
      actor: { kind: 'agent', id: 'c', role: 'coordinator' },
    });
    if (result.status !== 'ok') throw new Error(result.status);
    return result.output as { models: Record<string, unknown>[]; total: number };
  };

  it('lists text models by default, aliases first, cut to a short list', async () => {
    const listed = await list({});
    expect(listed.total).toBe(34);
    expect(listed.models).toHaveLength(25);
    expect(listed.models.slice(0, 3).map((entry) => entry['id'])).toEqual([
      '~a/latest',
      'a/plain',
      'b/writer',
    ]);
  });

  it('filters by output, tool support and search text', async () => {
    expect(await list({ output: 'image' })).toEqual({
      models: [
        {
          id: 'meta/muse-image',
          name: 'META/MUSE-IMAGE',
          inputUsdPerMillion: null,
          outputUsdPerMillion: null,
        },
      ],
      total: 1,
    });
    expect((await list({ tools: true, search: 'a/' })).models.map((entry) => entry['id'])).toEqual([
      '~a/latest',
    ]);
    expect((await list({ search: 'WRITER' })).models.map((entry) => entry['id'])).toEqual([
      'b/writer',
    ]);
    expect((await list({ sort: 'price' })).models.slice(0, 3)).toEqual([
      { id: 'c/cheap', name: 'C/CHEAP', inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 },
      { id: 'b/writer', name: 'B/WRITER', inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
      { id: '~a/latest', name: '~A/LATEST', inputUsdPerMillion: null, outputUsdPerMillion: null },
    ]);
    expect(await list({ output: 'video' })).toEqual({ models: [], total: 0 });
  });
});
