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
      message: 'OpenRouter refused the request: No credit',
    });
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
