import { describe, expect, it } from 'vitest';
import { encodeBase64 } from '../src/base64.js';
import {
  createOpenRouterProvider,
  ProviderError,
  refusalMessage,
  type ProviderErrorKind,
} from '../src/index.js';
import { createScriptedFetch } from '../src/testing.js';

type Reply = Parameters<typeof createScriptedFetch>[0][number];

function setup(...replies: Reply[]) {
  const scripted = createScriptedFetch(replies);
  const provider = createOpenRouterProvider({
    fetch: scripted.fetch,
    apiKey: () => 'test-key',
    appName: 'Imp',
    baseUrl: 'https://example.test/api/v1/',
    // Automatic retries have tests of their own below.
    retryDelaysMs: [],
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
  it('adds what video models can make, and leaves it out when that list is not there', async () => {
    const entry = (id: string, output: string[]) => ({
      id,
      architecture: { input_modalities: ['text'], output_modalities: output },
    });
    const catalog = {
      status: 200,
      body: { data: [entry('v/clips', ['video']), entry('v/text', ['text'])] },
    };
    const { provider, calls } = setup(catalog, {
      status: 200,
      body: {
        data: [
          {
            id: 'v/clips',
            supported_durations: [-1, 4, 8],
            supported_resolutions: ['720p'],
            supported_aspect_ratios: null,
            supported_frame_images: ['first_frame'],
            generate_audio: true,
          },
        ],
      },
    });
    const [clips, text] = await provider.listModels();
    expect(clips?.video).toEqual({
      durationsSeconds: [4, 8],
      resolutions: ['720p'],
      aspectRatios: [],
      frameImages: ['first_frame'],
      nativeAudio: true,
    });
    expect(text).not.toHaveProperty('video');
    expect(calls.map((call) => call.url)).toEqual([
      'https://example.test/api/v1/models?output_modalities=all',
      'https://example.test/api/v1/videos/models',
    ]);

    const without = setup(catalog, { status: 503, body: { error: { message: 'Busy' } } });
    expect((await without.provider.listModels()).map((model) => model.id)).toEqual([
      'v/clips',
      'v/text',
    ]);
  });

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

  it('marks cache points and sends context ahead of what the user wrote', async () => {
    const { provider, calls } = setup(completion({ content: 'ok' }));
    await provider.chat({
      model: 'vendor/model-a',
      messages: [
        { role: 'system', content: 'Rules.', cache: true },
        { role: 'user', content: 'Write it.', context: 'Project p-1' },
        { role: 'tool', toolCallId: 'c', content: '{}', cache: true },
      ],
    });
    const mark = { cache_control: { type: 'ephemeral' } };
    expect((JSON.parse(calls[0]?.request.body ?? '') as { messages: unknown }).messages).toEqual([
      { role: 'system', content: [{ type: 'text', text: 'Rules.', ...mark }] },
      { role: 'user', content: '<context>\nProject p-1\n</context>\n\nWrite it.' },
      { role: 'tool', tool_call_id: 'c', content: [{ type: 'text', text: '{}', ...mark }] },
    ]);
  });

  it("adds the search tool beside the caller's tools when web search is asked for", async () => {
    const { provider, calls } = setup(completion({ content: 'ok' }), completion({ content: 'ok' }));
    const tool = {
      type: 'function' as const,
      function: { name: 'note', description: 'Notes.', parameters: { type: 'object' } },
    };
    await provider.chat({ model: 'vendor/model-a', messages: [], tools: [tool], webSearch: true });
    await provider.chat({ model: 'vendor/model-a', messages: [], webSearch: true });
    const sent = calls.map(
      (call) => (JSON.parse(call.request.body ?? '') as { tools: unknown }).tools,
    );
    expect(sent).toEqual([
      [tool, { type: 'openrouter:web_search' }],
      [{ type: 'openrouter:web_search' }],
    ]);
  });

  it('sends what a tool attached after the results of its turn, by kind', async () => {
    const { provider, calls } = setup(completion({ content: 'ok' }));
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await provider.chat({
      model: 'vendor/model-a',
      media: new Map([
        ['p/a', bytes],
        ['p/b', bytes],
        ['p/c', bytes],
        ['p/d', bytes],
        ['p/f', bytes],
      ]),
      messages: [
        { role: 'user', content: 'Look.' },
        { role: 'assistant', content: null },
        {
          role: 'tool',
          toolCallId: '1',
          content: '{}',
          attachments: [
            { key: 'p/a', mediaType: 'image/webp' },
            { key: 'p/b', mediaType: 'audio/mpeg' },
          ],
        },
        {
          role: 'tool',
          toolCallId: '2',
          content: '{}',
          attachments: [
            { key: 'p/c', mediaType: 'video/mp4' },
            { key: 'p/d', mediaType: 'audio/flac' },
            { key: 'p/e', mediaType: 'image/png' },
            { key: 'p/f', mediaType: 'application/pdf' },
          ],
        },
        { role: 'assistant', content: 'Seen.' },
        { role: 'tool', toolCallId: '3', content: '{}' },
      ],
    });
    const sent = (JSON.parse(calls[0]?.request.body ?? '') as { messages: unknown[] }).messages;
    expect(sent.map((message) => (message as { role: string }).role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
      'assistant',
      'tool',
    ]);
    expect(sent[4]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Attached, as the tools returned: p/a, p/b, p/c, p/d, p/e, p/f' },
        { type: 'image_url', image_url: { url: 'data:image/webp;base64,AQIDBA==' } },
        { type: 'input_audio', input_audio: { data: 'AQIDBA==', format: 'mp3' } },
        { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AQIDBA==' } },
        { type: 'input_audio', input_audio: { data: 'AQIDBA==', format: 'flac' } },
        { type: 'text', text: '[p/e is not available any more.]' },
        { type: 'text', text: '[p/f is not available any more.]' },
      ],
    });
  });

  it('returns text with usage and cost', async () => {
    const { provider } = setup(
      completion(
        { content: 'Hello.' },
        {
          usage: {
            prompt_tokens: 12,
            completion_tokens: 3,
            cost: 0.00042,
            prompt_tokens_details: { cached_tokens: 8 },
          },
        },
      ),
    );
    expect(await provider.chat({ model: 'vendor/model-a', messages: [] })).toEqual({
      model: 'vendor/model-a',
      content: 'Hello.',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 12, cachedPromptTokens: 8, completionTokens: 3, costUsd: 0.00042 },
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
    expect(response.usage).toEqual({
      promptTokens: 0,
      cachedPromptTokens: 0,
      completionTokens: 0,
      costUsd: null,
    });
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
    await expect(provider.chat({ model: 'm', messages: [] })).rejects.toThrow(/error 502/);
  });

  it('treats an error body under HTTP 200 as the provider being unavailable', async () => {
    const { provider } = setup({ status: 200, body: { error: { message: 'upstream failed' } } });
    const attempt = provider.chat({ model: 'm', messages: [] });
    await expect(attempt).rejects.toMatchObject({ kind: 'unavailable', status: null });
    await expect(attempt).rejects.toThrow(/upstream failed/);
  });

  it('says in plain words what to do about each refusal', () => {
    expect(refusalMessage('auth', 401, null)).toBe(
      'OpenRouter did not accept the API key. Check it in Settings.',
    );
    expect(refusalMessage('rate_limit', 429, 'Slow down')).toMatch(
      /^OpenRouter is limiting requests right now\. Wait a moment, then try again\. OpenRouter said: "Slow down"$/,
    );
    expect(refusalMessage('unavailable', 503, null)).toMatch(/error 503.*Try again/);
    expect(refusalMessage('bad_request', 400, null)).toBe(
      'OpenRouter refused the request: error 400',
    );
    const long = refusalMessage('bad_request', 400, `{"raw": "${'x'.repeat(1000)}"}`);
    expect(long.length).toBeLessThan(300);
    expect(long.endsWith('…')).toBe(true);
  });

  it('gives up on a chat answer that never comes, as a retryable error', async () => {
    const provider = createOpenRouterProvider({
      fetch: () => new Promise(() => undefined),
      apiKey: () => 'k',
      chatTimeoutMs: 5,
      retryDelaysMs: [],
    });
    await expect(provider.chat({ model: 'm', messages: [] })).rejects.toMatchObject({
      kind: 'network',
      retryable: true,
      message:
        'The model did not answer within 1 second. The connection may have dropped. Try again.',
    });
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
      retryDelaysMs: [],
    });
    await provider.chat({ model: 'm', messages: [] });
    expect(scripted.calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(scripted.calls[0]?.request.headers).toMatchObject({ Authorization: 'Bearer async-key' });
    expect(scripted.calls[0]?.request.headers).not.toHaveProperty('X-Title');
  });
});

describe('OpenRouter provider: automatic retries', () => {
  function retrying(...replies: Reply[]) {
    const scripted = createScriptedFetch(replies);
    const waits: number[] = [];
    const provider = createOpenRouterProvider({
      fetch: scripted.fetch,
      apiKey: () => 'k',
      retryDelaysMs: [100, 300],
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    return { provider, calls: scripted.calls, waits };
  }
  const offline = Object.assign(new TypeError('Failed to fetch'), {
    cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
  });

  it('sends a request again after a dropped connection, a busy server or a failing model', async () => {
    const { provider, calls, waits } = retrying(
      offline,
      { status: 502, body: '<html>Bad gateway</html>' },
      completion({ content: 'Third time lucky.' }),
    );
    expect((await provider.chat({ model: 'm', messages: [] })).content).toBe('Third time lucky.');
    expect(calls).toHaveLength(3);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(100);
    expect(waits[0]).toBeLessThanOrEqual(120);
    expect(waits[1]).toBeGreaterThanOrEqual(300);
  });

  it('gives up after the last wait and keeps what the browser said', async () => {
    const { provider, calls } = retrying(offline, offline, offline);
    await expect(provider.chat({ model: 'm', messages: [] })).rejects.toMatchObject({
      kind: 'network',
      message: expect.stringContaining('(Failed to fetch: ECONNRESET)') as string,
    });
    expect(calls).toHaveLength(3);
  });

  it('retries a chat model that failed under HTTP 200', async () => {
    const { provider, calls } = retrying(
      { status: 200, body: { error: { message: 'Provider returned error' } } },
      completion({ content: 'ok' }),
    );
    expect((await provider.chat({ model: 'm', messages: [] })).content).toBe('ok');
    expect(calls).toHaveLength(2);
  });

  it('waits as long as OpenRouter asks, but not for minutes', async () => {
    const { provider, waits } = retrying(
      { status: 429, body: { error: { message: 'Slow down' } }, headers: { 'retry-after': '2' } },
      completion({ content: 'ok' }),
    );
    await provider.chat({ model: 'm', messages: [] });
    expect(waits).toEqual([2000]);

    const patient = retrying({
      status: 429,
      body: { error: { message: 'Slow down' } },
      headers: { 'retry-after': '600' },
    });
    expect(await kindOf(patient.provider.chat({ model: 'm', messages: [] }))).toBe('rate_limit');
    expect(patient.waits).toEqual([]);
  });

  it('never retries what cannot go through by waiting', async () => {
    const { provider, calls } = retrying({ status: 401, body: { error: { message: 'bad key' } } });
    expect(await kindOf(provider.chat({ model: 'm', messages: [] }))).toBe('auth');
    expect(calls).toHaveLength(1);
  });

  it('starts a paid video again only when OpenRouter said it did not take it', async () => {
    const request = { model: 'm', prompt: 'x', audio: false, durationSeconds: 5 };
    const lost = retrying(offline);
    expect(await kindOf(lost.provider.startVideo(request))).toBe('network');
    expect(lost.calls).toHaveLength(1);

    const busy = retrying(
      { status: 503, body: { error: { message: 'busy' } } },
      { status: 200, body: { id: 'job-1', status: 'pending' } },
    );
    expect(await busy.provider.startVideo(request)).toMatchObject({ id: 'job-1' });
    expect(busy.calls).toHaveLength(2);
  });

  it('stops retrying once the caller cancels', async () => {
    const { provider, calls } = retrying(offline, completion({ content: 'ok' }));
    await expect(
      provider.chat({ model: 'm', messages: [] }, { signal: { aborted: true } }),
    ).rejects.toMatchObject({ kind: 'network' });
    expect(calls).toHaveLength(1);
  });
});

describe('OpenRouter provider: images', () => {
  it('sends the request and returns the bytes with their type and the cost', async () => {
    const { provider, calls } = setup({
      status: 200,
      body: {
        // "AQID/w==" is the bytes 1, 2, 3, 255.
        data: [{ b64_json: 'AQID/w==', media_type: 'image/webp' }, { b64_json: 'AAEC' }],
        usage: { cost: 0.01 },
      },
    });
    const result = await provider.generateImage({
      model: 'vendor/painter',
      prompt: 'A lighthouse.',
      aspectRatio: '3:4',
      seed: 7,
    });
    expect(calls[0]?.url).toBe('https://example.test/api/v1/images');
    expect(JSON.parse(calls[0]?.request.body ?? '')).toEqual({
      model: 'vendor/painter',
      prompt: 'A lighthouse.',
      aspect_ratio: '3:4',
      seed: 7,
    });
    expect(result.costUsd).toBe(0.01);
    expect(result.images.map((image) => [[...image.bytes], image.mediaType])).toEqual([
      [[1, 2, 3, 255], 'image/webp'],
      [[0, 1, 2], 'image/png'],
    ]);
  });

  it('sends reference images for a picture as data URLs', async () => {
    const { provider, calls } = setup({ status: 200, body: { data: [{ b64_json: 'AA==' }] } });
    await provider.generateImage({
      model: 'vendor/painter',
      prompt: 'The same room from the door.',
      references: [{ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }],
    });
    expect(JSON.parse(calls[0]?.request.body ?? '')).toEqual({
      model: 'vendor/painter',
      prompt: 'The same room from the door.',
      input_references: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }],
    });
  });

  it('leaves out what was not asked for and reports a missing cost as null', async () => {
    const { provider, calls } = setup({ status: 200, body: { data: [{ b64_json: 'AA==' }] } });
    const result = await provider.generateImage({ model: 'vendor/painter', prompt: 'x' });
    expect(JSON.parse(calls[0]?.request.body ?? '')).toEqual({
      model: 'vendor/painter',
      prompt: 'x',
    });
    expect(result.costUsd).toBeNull();
  });

  it('refuses an image without readable data', async () => {
    for (const image of [
      { url: 'https://example.test/i.png' },
      { b64_json: 'not base64!' },
      { b64_json: 'A' },
      { b64_json: '' },
    ]) {
      const { provider } = setup({ status: 200, body: { data: [image] } });
      expect(await kindOf(provider.generateImage({ model: 'm', prompt: 'x' }))).toBe(
        'invalid_response',
      );
    }
  });

  it('asks for speech as mp3 and returns the bytes as they came', async () => {
    const audio = new Uint8Array([73, 68, 51, 255, 0, 128]);
    const { provider, calls } = setup(
      { status: 200, bytes: audio, contentType: 'audio/mpeg; charset=binary' },
      { status: 200, bytes: audio, contentType: 'audio/mpeg' },
    );
    expect(
      await provider.generateSpeech({ model: 'v/speaker', text: 'Hello.', instructions: 'Low.' }),
    ).toEqual({
      model: 'v/speaker',
      audio: { bytes: audio, mediaType: 'audio/mpeg' },
      costUsd: null,
    });
    await provider.generateSpeech({ model: 'v/speaker', text: 'Hello.' });
    expect(calls[0]?.url).toBe('https://example.test/api/v1/audio/speech');
    expect(calls.map((call) => JSON.parse(call.request.body ?? '') as unknown)).toEqual([
      { model: 'v/speaker', input: 'Hello.', response_format: 'mp3', instructions: 'Low.' },
      { model: 'v/speaker', input: 'Hello.', response_format: 'mp3' },
    ]);
  });

  it('refuses speech that is not audio, and passes refusals on', async () => {
    for (const reply of [
      { status: 200, bytes: new Uint8Array(), contentType: 'audio/mpeg' },
      { status: 200, bytes: new Uint8Array([1]), contentType: 'text/html' },
    ]) {
      const { provider } = setup(reply);
      expect(await kindOf(provider.generateSpeech({ model: 'm', text: 'x' }))).toBe(
        'invalid_response',
      );
    }
    const { provider } = setup({ status: 402, body: { error: { message: 'No credit' } } });
    await expect(provider.generateSpeech({ model: 'm', text: 'x' })).rejects.toMatchObject({
      kind: 'insufficient_credit',
      message: expect.stringMatching(/run out of credit.*OpenRouter said: "No credit"/) as string,
    });
  });

  it('transcribes with word timings, and without them for models that only write text', async () => {
    const { provider, calls } = setup(
      {
        status: 200,
        body: {
          text: ' The lamp burns. ',
          language: 'en',
          words: [
            { word: ' The', start: 0.4, end: 0.6 },
            { word: 'lamp', start: 0.7, end: 1.1 },
            { word: ' ', start: 1.1, end: 1.1 },
            { word: 'burns.', start: 1.2, end: 1.1 },
          ],
          usage: { cost: 0.0004 },
        },
      },
      { status: 400, body: { error: { message: 'Use "json" instead of "verbose_json".' } } },
      { status: 200, body: { text: 'Hello.' } },
    );
    const audio = { bytes: new Uint8Array([1, 2, 3]), mediaType: 'audio/wav' };
    expect(await provider.transcribe({ model: 'a/ears', audio, language: 'en' })).toEqual({
      model: 'a/ears',
      text: 'The lamp burns.',
      words: [
        { text: 'The', startSeconds: 0.4, endSeconds: 0.6 },
        { text: 'lamp', startSeconds: 0.7, endSeconds: 1.1 },
        { text: 'burns.', startSeconds: 1.2, endSeconds: 1.2 },
      ],
      language: 'en',
      costUsd: 0.0004,
    });
    expect(
      await provider.transcribe({ model: 'b/plain', audio: { ...audio, mediaType: 'audio/mpeg' } }),
    ).toEqual({ model: 'b/plain', text: 'Hello.', words: [], language: null, costUsd: null });
    expect(calls[0]?.url).toBe('https://example.test/api/v1/audio/transcriptions');
    expect(calls.map((call) => JSON.parse(call.request.body ?? '') as unknown)).toEqual([
      {
        model: 'a/ears',
        input_audio: { data: 'AQID', format: 'wav' },
        language: 'en',
        temperature: 0,
        response_format: 'verbose_json',
        timestamp_granularities: ['word'],
      },
      {
        model: 'b/plain',
        input_audio: { data: 'AQID', format: 'mp3' },
        temperature: 0,
        response_format: 'verbose_json',
        timestamp_granularities: ['word'],
      },
      { model: 'b/plain', input_audio: { data: 'AQID', format: 'mp3' }, temperature: 0 },
    ]);
    const refused = setup({ status: 402, body: { error: { message: 'No credit' } } }).provider;
    await expect(refused.transcribe({ model: 'm', audio })).rejects.toMatchObject({
      kind: 'insufficient_credit',
    });
  });

  it('makes an effect with a speech model, opened so that it is not read aloud', async () => {
    const audio = new Uint8Array([73, 68, 51, 1]);
    const reply = { status: 200, bytes: audio, contentType: 'audio/mpeg' };
    const { provider, calls } = setup(reply, reply);
    expect(
      await provider.generateSound({ model: 'v/speaker', kind: 'effect', prompt: ' a door ' }),
    ).toEqual({
      model: 'v/speaker',
      audio: { bytes: audio, mediaType: 'audio/mpeg' },
      costUsd: null,
    });
    await provider.generateSound({
      model: 'v/speaker',
      kind: 'effect',
      prompt: 'The sounds of rain',
    });
    expect(calls[0]?.url).toBe('https://example.test/api/v1/audio/speech');
    expect(calls.map((call) => JSON.parse(call.request.body ?? '') as unknown)).toEqual([
      { model: 'v/speaker', input: 'The sound of a door', response_format: 'mp3' },
      { model: 'v/speaker', input: 'The sounds of rain', response_format: 'mp3' },
    ]);
  });

  it('collects music from the stream of a chat model', async () => {
    const event = (value: unknown) => `data: ${JSON.stringify(value)}`;
    const stream = [
      ': OPENROUTER PROCESSING',
      event({ choices: [{ delta: { content: '<instrumental>' } }] }),
      'data: not json',
      event({ choices: [{ delta: { audio: { data: 'SUQz' } } }] }),
      event({ choices: [{ delta: { audio: { data: 'AQID' } } }] }),
      event({ choices: [{ delta: {} }], usage: { cost: 0.04 } }),
      'data: [DONE]',
    ].join('\n');
    const { provider, calls } = setup({
      status: 200,
      body: stream,
      contentType: 'text/event-stream',
    });
    expect(
      await provider.generateSound({ model: 'v/composer', kind: 'music', prompt: 'Low strings' }),
    ).toEqual({
      model: 'v/composer',
      audio: { bytes: new Uint8Array([73, 68, 51, 1, 2, 3]), mediaType: 'audio/mpeg' },
      costUsd: 0.04,
    });
    expect(calls[0]?.url).toBe('https://example.test/api/v1/chat/completions');
    expect(JSON.parse(calls[0]?.request.body ?? '')).toEqual({
      model: 'v/composer',
      messages: [{ role: 'user', content: 'Low strings' }],
      modalities: ['text', 'audio'],
      stream: true,
      usage: { include: true },
    });
  });

  it('tells apart the audio formats music can come in', async () => {
    const formats: [number[], string][] = [
      [[0xff, 0xfb, 0x90], 'audio/mpeg'],
      [[0x52, 0x49, 0x46, 0x46], 'audio/wav'],
      [[0x4f, 0x67, 0x67, 0x53], 'audio/ogg'],
      [[0x66, 0x4c, 0x61, 0x43], 'audio/flac'],
    ];
    for (const [start, mediaType] of formats) {
      const data = encodeBase64(new Uint8Array(start));
      const { provider } = setup({
        status: 200,
        body: `data: ${JSON.stringify({ choices: [{ delta: { audio: { data } } }] })}`,
      });
      const made = await provider.generateSound({ model: 'm', kind: 'music', prompt: 'x' });
      expect(made.audio.mediaType).toBe(mediaType);
      expect(made.costUsd).toBeNull();
    }
  });

  it('refuses music without audio, and passes on an error inside the stream', async () => {
    const music = { model: 'm', kind: 'music', prompt: 'x' } as const;
    for (const body of [
      '',
      `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: 'AAAA' } } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: '!' } } }] })}`,
    ]) {
      const { provider } = setup({ status: 200, body });
      expect(await kindOf(provider.generateSound(music))).toBe('invalid_response');
    }
    const { provider } = setup({
      status: 200,
      body: `data: ${JSON.stringify({ error: { message: 'Upstream failed' } })}`,
    });
    await expect(provider.generateSound(music)).rejects.toMatchObject({
      kind: 'unavailable',
      message: expect.stringMatching(/Try again.*OpenRouter said: "Upstream failed"/) as string,
    });
    const refused = setup({ status: 400, body: { error: { message: 'No such model' } } });
    expect(await kindOf(refused.provider.generateSound(music))).toBe('bad_request');
    const silent = setup({ status: 200, bytes: new Uint8Array(), contentType: 'audio/mpeg' });
    expect(
      await kindOf(silent.provider.generateSound({ model: 'm', kind: 'effect', prompt: 'x' })),
    ).toBe('invalid_response');
  });

  it('starts a clip with its guides, looks at it again and downloads it', async () => {
    const clip = new Uint8Array([0, 0, 0, 24, 102, 116]);
    const image = { bytes: new Uint8Array([1, 2, 3, 4]), mediaType: 'image/webp' };
    const { provider, calls } = setup(
      { status: 200, body: { id: 'gen-vid-1', status: 'pending', polling_url: '/x' } },
      { status: 200, body: { id: 'gen-vid-1', status: 'in_progress', progress: 40.5 } },
      { status: 200, body: { id: 'gen-vid-1', status: 'completed', usage: { cost: 0.21 } } },
      { status: 200, bytes: clip, contentType: 'video/mp4' },
      { status: 200, body: { id: 'gen-vid-2', status: 'pending' } },
    );
    const started = await provider.startVideo({
      model: 'v/clips',
      prompt: 'A lamp room at night.',
      durationSeconds: 4,
      resolution: '480p',
      aspectRatio: '16:9',
      audio: true,
      references: [image],
      firstFrame: image,
    });
    expect(started).toEqual({
      id: 'gen-vid-1',
      status: 'pending',
      progress: null,
      error: null,
      costUsd: null,
    });
    expect(await provider.checkVideo('gen-vid-1')).toMatchObject({
      status: 'pending',
      progress: 40.5,
    });
    expect(await provider.checkVideo('gen-vid-1')).toMatchObject({
      status: 'completed',
      costUsd: 0.21,
    });
    expect(await provider.downloadVideo('gen-vid-1')).toEqual({
      bytes: clip,
      mediaType: 'video/mp4',
    });
    await provider.startVideo({ model: 'v/clips', prompt: 'Silent.', audio: false });

    const part = { type: 'image_url', image_url: { url: 'data:image/webp;base64,AQIDBA==' } };
    expect(JSON.parse(calls[0]?.request.body ?? '')).toEqual({
      model: 'v/clips',
      prompt: 'A lamp room at night.',
      generate_audio: true,
      duration: 4,
      resolution: '480p',
      aspect_ratio: '16:9',
      input_references: [part],
      frame_images: [{ ...part, frame_type: 'first_frame' }],
    });
    expect(JSON.parse(calls[4]?.request.body ?? '')).toEqual({
      model: 'v/clips',
      prompt: 'Silent.',
      generate_audio: false,
    });
    expect(calls.map((call) => [call.request.method, call.url.replace(/^.*\/v1/, '')])).toEqual([
      ['POST', '/videos'],
      ['GET', '/videos/gen-vid-1'],
      ['GET', '/videos/gen-vid-1'],
      ['GET', '/videos/gen-vid-1/content?index=0'],
      ['POST', '/videos'],
    ]);
  });

  it('reports why a clip was not made, and refuses a download that is not video', async () => {
    const { provider } = setup(
      { status: 200, body: { id: 'j', status: 'failed', error: 'Blocked by the content filter.' } },
      { status: 200, body: { id: 'j', status: 'failed', error: { message: 'Out of capacity.' } } },
      { status: 200, body: { id: 'j', status: 'expired' } },
      { status: 200, body: '<html>', contentType: 'text/html' },
      { status: 400, body: { error: { message: 'duration must be one of 4, 6, 8' } } },
    );
    expect(await provider.checkVideo('j')).toMatchObject({
      status: 'failed',
      error: 'Blocked by the content filter.',
    });
    expect(await provider.checkVideo('j')).toMatchObject({ error: 'Out of capacity.' });
    expect(await provider.checkVideo('j')).toMatchObject({
      status: 'failed',
      error: 'The job was expired.',
    });
    expect(await kindOf(provider.downloadVideo('j'))).toBe('invalid_response');
    await expect(
      provider.startVideo({ model: 'm', prompt: 'x', audio: false, durationSeconds: 5 }),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      message: 'OpenRouter refused the request: duration must be one of 4, 6, 8',
    });
  });

  it('passes provider refusals on', async () => {
    const { provider } = setup({ status: 402, body: { error: { message: 'No credit' } } });
    expect(await kindOf(provider.generateImage({ model: 'm', prompt: 'x' }))).toBe(
      'insufficient_credit',
    );
  });
});
