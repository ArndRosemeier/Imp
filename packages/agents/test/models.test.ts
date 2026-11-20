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
      model('v/clips', {
        outputModalities: ['video'],
        video: {
          durationsSeconds: [4, 6, 8],
          resolutions: ['720p'],
          aspectRatios: ['16:9'],
          frameImages: [],
          nativeAudio: true,
        },
      }),
      model('v/avatar', {
        outputModalities: ['video'],
        video: {
          durationsSeconds: [],
          resolutions: ['1080p'],
          aspectRatios: [],
          frameImages: [],
          nativeAudio: false,
        },
      }),
      model('v/unknown', { outputModalities: ['video'] }),
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
  });

  it('lists the video models that can make clips, with what they can do, and the rest on request', async () => {
    const clips = await list({ output: 'video' });
    expect(clips.total).toBe(2);
    expect(clips.models.map((entry) => entry['id'])).toEqual(['v/clips', 'v/unknown']);
    expect(clips.models[0]).toMatchObject({ abilities: ['4, 6, 8 s', 'own sound'] });
    expect(clips.models[0]).not.toHaveProperty('unsuitable');
    expect(clips.models[1]).not.toHaveProperty('abilities');
    const all = await list({ output: 'video', all: true });
    expect(all.total).toBe(3);
    expect(all.models.find((entry) => entry['id'] === 'v/avatar')).toMatchObject({
      abilities: ['silent'],
      unsuitable: expect.stringContaining('photo or an existing video') as string,
    });
  });
});
