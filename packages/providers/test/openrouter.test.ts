import { describe, expect, it } from 'vitest';
import { createOpenRouterProvider, ProviderError, type ProviderErrorKind } from '../src/index.js';
import { createScriptedFetch } from '../src/testing.js';

type Reply = Parameters<typeof createScriptedFetch>[0][number];

function setup(...replies: Reply[]) {
  const scripted = createScriptedFetch(replies);
  const provider = createOpenRouterProvider({
    fetch: scripted.fetch,
    apiKey: () => 'test-key',
    appName: 'Imp',
    baseUrl: 'https://example.test/api/v1/',
  });
  return { provider, calls: scripted.calls };
}

const completion = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: { model: 'vendor/model-a', choices: [{ finish_reason: 'stop', message }], ...extra },
});

async function kindOf(promise: Promise<unknown>): Promise<ProviderErrorKind | 'no error'> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) {
      return error.kind;
    }
    throw error;
  }
  return 'no error';
}

describe('OpenRouter provider: models', () => {
  it('asks for every modality and needs no key', async () => {
    const { provider, calls } = setup({ status: 200, body: { data: [] } });
    expect(await provider.listModels()).toEqual([]);
    expect(calls[0]?.url).toBe('https://example.test/api/v1/models?output_modalities=all');
    expect(calls[0]?.request.method).toBe('GET');
    expect(calls[0]?.request.headers).not.toHaveProperty('Authorization');
    expect(calls[0]?.request.headers['X-Title']).toBe('Imp');
  });

  it('maps catalog entries, tolerating missing and unknown fields', async () => {
    const { provider } = setup({
      status: 200,
      body: {
        data: [
          {
            id: 'vendor/chat',
            name: 'Vendor Chat',
            context_length: 200000,
            architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
            pricing: { prompt: '0.000003', completion: '0.000015' },
            supported_parameters: ['tools', 'temperature'],
            something_new: true,
          },
          {
            id: 'vendor/video',
            architecture: { input_modalities: ['text'], output_modalities: ['video', 'hologram'] },
            pricing: { prompt: '', completion: 'free' },
          },
          { id: 'vendor/bare', context_length: null, pricing: { prompt: '-1' } },
        ],
      },
    });
    expect(await provider.listModels()).toEqual([
      {
        id: 'vendor/chat',
        name: 'Vendor Chat',
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        contextLength: 200000,
        supportsTools: true,
        pricing: { promptUsdPerToken: 0.000003, completionUsdPerToken: 0.000015 },
      },
      {
        id: 'vendor/video',
        name: 'vendor/video',
        inputModalities: ['text'],
        outputModalities: ['video', 'other'],
        contextLength: null,
        supportsTools: false,
        pricing: { promptUsdPerToken: null, completionUsdPerToken: null },
      },
      {
        id: 'vendor/bare',
        name: 'vendor/bare',
        inputModalities: [],
        outputModalities: [],
        contextLength: null,
        supportsTools: false,
        pricing: { promptUsdPerToken: null, completionUsdPerToken: null },
      },
    ]);
  });

  it('rejects a catalog in an unexpected shape', async () => {
    const { provider } = setup({ status: 200, body: { models: [] } });
    expect(await kindOf(provider.listModels())).toBe('invalid_response');
  });
});

describe('OpenRouter provider: credentials', () => {
  it('accepts a key the service accepts', async () => {
    const { provider, calls } = setup({ status: 200, body: { data: { label: 'k' } } });
    await expect(provider.verifyCredentials()).resolves.toBeUndefined();
    expect(calls[0]?.url).toBe('https://example.test/api/v1/key');
    expect(calls[0]?.request.headers).toMatchObject({ Authorization: 'Bearer test-key' });
  });

  it('rejects a key the service refuses', async () => {
    const { provider } = setup({ status: 401, body: { error: { message: 'No auth' } } });
    expect(await kindOf(provider.verifyCredentials())).toBe('auth');
  });
});

describe('OpenRouter provider: chat', () => {
  it('sends the conversation and tools in wire format with the key', async () => {
    const { provider, calls } = setup(completion({ content: 'done' }));
    const signal = { aborted: false };
    await provider.chat(
      {
        model: 'vendor/model-a',
        temperature: 0.2,
        maxOutputTokens: 500,
        tools: [
          {
            type: 'function',
            function: {
              name: 'settings__get',
              description: 'Reads.',
              parameters: { type: 'object' },
            },
          },
        ],
        messages: [
          { role: 'system', content: 'You are a screenwriter.' },
          { role: 'user', content: 'Read the theme.' },
          {
            role: 'assistant',
            content: null,
            toolCalls: [
              {
                id: 'call-1',
                name: 'settings__get',
                arguments: { key: 'theme' },
                argumentsText: '{"key":"theme"}',
              },
            ],
          },
          { role: 'tool', toolCallId: 'call-1', content: '{"value":"dark"}' },
          { role: 'assistant', content: 'It is dark.', toolCalls: [] },
        ],
      },
      { signal },
    );

    const call = calls[0];
    expect(call?.url).toBe('https://example.test/api/v1/chat/completions');
    expect(call?.request.signal).toBe(signal);
    expect(call?.request.headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(call?.request.body ?? '')).toEqual({
      model: 'vendor/model-a',
      temperature: 0.2,
      max_tokens: 500,
      usage: { include: true },
      tools: [
        {
          type: 'function',
          function: {
            name: 'settings__get',
            description: 'Reads.',
            parameters: { type: 'object' },
          },
        },
      ],
      messages: [
        { role: 'system', content: 'You are a screenwriter.' },
        { role: 'user', content: 'Read the theme.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'settings__get', arguments: '{"key":"theme"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call-1', content: '{"value":"dark"}' },
        { role: 'assistant', content: 'It is dark.' },
      ],
    });
  });

  it('returns text with usage and cost', async () => {
    const { provider } = setup(
      completion(
        { content: 'Hello.' },
        { usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.00042 } },
      ),
    );
    expect(await provider.chat({ model: 'vendor/model-a', messages: [] })).toEqual({
      model: 'vendor/model-a',
      content: 'Hello.',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 12, completionTokens: 3, costUsd: 0.00042 },
    });
  });

  it('returns tool calls, parsing arguments and flagging invalid JSON', async () => {
    const { provider } = setup({
      status: 200,
      body: {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'a',
                  function: { name: 'settings__set', arguments: '{"key":"theme","value":"dark"}' },
                },
                { id: 'b', function: { name: 'settings__list', arguments: '' } },
                { id: 'c', function: { name: 'settings__get', arguments: '{"key":' } },
              ],
            },
          },
        ],
      },
    });
    const response = await provider.chat({ model: 'vendor/requested', messages: [], tools: [] });
    expect(response.model).toBe('vendor/requested');
    expect(response.finishReason).toBe('tool_calls');
    expect(response.usage).toEqual({ promptTokens: 0, completionTokens: 0, costUsd: null });
    expect(response.toolCalls).toEqual([
      {
        id: 'a',
        name: 'settings__set',
        arguments: { key: 'theme', value: 'dark' },
        argumentsText: '{"key":"theme","value":"dark"}',
      },
      { id: 'b', name: 'settings__list', arguments: {}, argumentsText: '' },
      { id: 'c', name: 'settings__get', arguments: undefined, argumentsText: '{"key":' },
    ]);
  });

  it.each([
    ['length', 'length'],
    ['content_filter', 'content_filter'],
    ['something_else', 'other'],
    [null, 'other'],
  ])('maps finish reason %s to %s', async (wire, expected) => {
    const { provider } = setup({
      status: 200,
      body: { choices: [{ finish_reason: wire, message: { content: 'x' } }] },
    });
    expect((await provider.chat({ model: 'm', messages: [] })).finishReason).toBe(expected);
  });

  it.each<[number, ProviderErrorKind, boolean]>([
    [400, 'bad_request', false],
    [401, 'auth', false],
    [403, 'auth', false],
    [402, 'insufficient_credit', false],
    [429, 'rate_limit', true],
    [503, 'unavailable', true],
  ])('maps HTTP %i to %s', async (status, kind, retryable) => {
    const { provider } = setup({ status, body: { error: { message: 'nope' } } });
    const attempt = provider.chat({ model: 'm', messages: [] });
    await expect(attempt).rejects.toMatchObject({
      kind,
      status,
      retryable,
      providerId: 'openrouter',
    });
    await expect(attempt).rejects.toThrow(/nope/);
  });

  it('reports the status when an error body is not JSON', async () => {
    const { provider } = setup({ status: 502, body: '<html>Bad gateway</html>' });
    await expect(provider.chat({ model: 'm', messages: [] })).rejects.toThrow(/HTTP 502/);
  });

  it('treats an error body under HTTP 200 as the provider being unavailable', async () => {
    const { provider } = setup({ status: 200, body: { error: { message: 'upstream failed' } } });
    const attempt = provider.chat({ model: 'm', messages: [] });
    await expect(attempt).rejects.toMatchObject({ kind: 'unavailable', status: null });
    await expect(attempt).rejects.toThrow(/upstream failed/);
  });

  it('rejects a completion without choices', async () => {
    const { provider } = setup({ status: 200, body: { choices: [] } });
    expect(await kindOf(provider.chat({ model: 'm', messages: [] }))).toBe('invalid_response');
  });

  it('reports a failed connection as a retryable network error with its cause', async () => {
    const cause = new Error('offline');
    const { provider } = setup(cause);
    await expect(provider.chat({ model: 'm', messages: [] })).rejects.toMatchObject({
      kind: 'network',
      retryable: true,
      cause,
    });
  });

  it('never puts the key anywhere but the Authorization header', async () => {
    const { provider, calls } = setup({ status: 401, body: { error: { message: 'bad key' } } });
    const error = await provider.chat({ model: 'm', messages: [] }).catch((e: unknown) => e);
    expect(String(error)).not.toContain('test-key');
    expect(calls[0]?.url).not.toContain('test-key');
    expect(calls[0]?.request.body).not.toContain('test-key');
  });

  it('uses the public endpoint by default and awaits an async key', async () => {
    const scripted = createScriptedFetch([completion({ content: 'ok' })]);
    const provider = createOpenRouterProvider({
      fetch: scripted.fetch,
      apiKey: () => Promise.resolve('async-key'),
    });
    await provider.chat({ model: 'm', messages: [] });
    expect(scripted.calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(scripted.calls[0]?.request.headers).toMatchObject({ Authorization: 'Bearer async-key' });
    expect(scripted.calls[0]?.request.headers).not.toHaveProperty('X-Title');
  });
});
