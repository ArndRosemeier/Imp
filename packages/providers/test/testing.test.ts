import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/index.js';
import { createFakeProvider, createScriptedFetch } from '../src/testing.js';

describe('createFakeProvider', () => {
  it('plays back replies in order, records requests and fills in defaults', async () => {
    const provider = createFakeProvider({
      replies: [
        { toolCalls: [{ id: '1', name: 'settings__list', arguments: {}, argumentsText: '{}' }] },
        { content: 'Done.' },
        new ProviderError('rate_limit', 'fake', 'slow down'),
      ],
    });
    const request = { model: 'fake/model', messages: [] };
    expect(await provider.chat(request)).toMatchObject({
      model: 'fake/model',
      content: null,
      finishReason: 'tool_calls',
    });
    expect(await provider.chat(request)).toMatchObject({ content: 'Done.', finishReason: 'stop' });
    await expect(provider.chat(request)).rejects.toMatchObject({ kind: 'rate_limit' });
    await expect(provider.chat(request)).rejects.toThrow(/ran out of replies/);
    expect(provider.requests).toHaveLength(4);
    expect(await provider.listModels()).toEqual([]);
    await expect(provider.verifyCredentials()).resolves.toBeUndefined();
  });

  it('can be scripted to refuse credentials', async () => {
    const refusal = new ProviderError('auth', 'fake', 'bad key');
    const provider = createFakeProvider({ credentialsError: refusal });
    await expect(provider.verifyCredentials()).rejects.toBe(refusal);
  });
});

describe('createScriptedFetch', () => {
  it('fails loudly on a request nobody scripted', async () => {
    const { fetch } = createScriptedFetch([]);
    await expect(fetch('https://example.test', { method: 'GET', headers: {} })).rejects.toThrow(
      /Unexpected request/,
    );
  });
});
