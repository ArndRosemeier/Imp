import type { JsonValue } from '@imp/core';
import type { z } from 'zod';
import { decodeBase64, encodeBase64 } from '../base64.js';
import { ProviderError, type ProviderErrorKind } from '../errors.js';
import type { HttpFetch, HttpResponse } from '../http.js';
import {
  MODALITIES,
  modalityOf,
  type Attachment,
  type CallOptions,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type FinishReason,
  type GenerationProvider,
  type ImageRequest,
  type ImageResponse,
  type Modality,
  type MediaInput,
  type ModelInfo,
  type VideoAbilities,
  type VideoJob,
  type VideoRequest,
  type SoundRequest,
  type SoundResponse,
  type SpeechRequest,
  type SpeechResponse,
  type ToolCall,
} from '../types.js';
import {
  AudioStreamChunk,
  ChatCompletionResponse,
  ErrorResponse,
  ImageGenerationResponse,
  ModelsResponse,
  VideoJobResponse,
  VideoModelsResponse,
} from './schemas.js';

export const OPENROUTER_ID = 'openrouter';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export interface OpenRouterOptions {
  readonly fetch: HttpFetch;
  /**
   * Returns the key at call time. A function, so the key stays in the host's
   * secret store and never has to be held by the core or reachable by a command.
   */
  readonly apiKey: () => string | Promise<string>;
  readonly baseUrl?: string;
  /** Shown on OpenRouter's side as the calling application. */
  readonly appName?: string;
}

const KNOWN_MODALITIES: ReadonlySet<string> = new Set(MODALITIES);

function toModalities(values: readonly string[] | null | undefined): Modality[] {
  return (values ?? []).map((value) =>
    KNOWN_MODALITIES.has(value) ? (value as Modality) : 'other',
  );
}

const videoOf = (video: VideoAbilities | undefined): { video?: VideoAbilities } =>
  video === undefined ? {} : { video };

function toPrice(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') {
    return null;
  }
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : null;
}

function toFinishReason(value: string | null | undefined): FinishReason {
  switch (value) {
    case 'stop':
    case 'tool_calls':
    case 'length':
    case 'content_filter':
      return value;
    default:
      return 'other';
  }
}

function parseArguments(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text === '' ? '{}' : text) as JsonValue;
  } catch {
    return undefined;
  }
}

/** Text content, as a marked part when the prefix ending here should be cached. */
function toWireContent(text: string, cache: boolean | undefined): unknown {
  return cache === true ? [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] : text;
}

const toImagePart = (image: MediaInput): Record<string, unknown> => ({
  type: 'image_url',
  image_url: { url: `data:${image.mediaType};base64,${encodeBase64(image.bytes)}` },
});

/** The audio format names the API knows, by the second half of the media type. */
const AUDIO_FORMATS: Readonly<Record<string, string>> = { mpeg: 'mp3', 'x-wav': 'wav', mp4: 'm4a' };

/** One attachment as a content part, or as a line of text when it cannot be sent. */
function toMediaPart(
  attachment: Attachment,
  media: ReadonlyMap<string, Uint8Array> | undefined,
): Record<string, unknown> {
  const bytes = media?.get(attachment.key);
  const kind = modalityOf(attachment.mediaType);
  if (bytes === undefined || kind === undefined) {
    return { type: 'text', text: `[${attachment.key} is not available any more.]` };
  }
  const data = encodeBase64(bytes);
  const url = `data:${attachment.mediaType};base64,${data}`;
  switch (kind) {
    case 'image':
      return { type: 'image_url', image_url: { url } };
    case 'video':
      return { type: 'video_url', video_url: { url } };
    case 'audio': {
      const subtype = attachment.mediaType.split('/')[1] ?? '';
      return {
        type: 'input_audio',
        input_audio: { data, format: AUDIO_FORMATS[subtype] ?? subtype },
      };
    }
  }
}

/**
 * Tool results carry text only on this API, so what a tool attached follows
 * the results of its turn in a user message of its own.
 */
function toWireMessages(
  messages: readonly ChatMessage[],
  media: ReadonlyMap<string, Uint8Array> | undefined,
): Record<string, unknown>[] {
  const wire: Record<string, unknown>[] = [];
  let shown: Attachment[] = [];
  const flush = (): void => {
    if (shown.length === 0) return;
    wire.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Attached, as the tools returned: ${shown.map(({ key }) => key).join(', ')}`,
        },
        ...shown.map((attachment) => toMediaPart(attachment, media)),
      ],
    });
    shown = [];
  };
  for (const message of messages) {
    if (message.role !== 'tool') flush();
    wire.push(toWireMessage(message));
    if (message.role === 'tool') shown.push(...(message.attachments ?? []));
  }
  flush();
  return wire;
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: toWireContent(message.content, message.cache) };
    case 'user':
      return {
        role: 'user',
        content: toWireContent(
          message.context === undefined
            ? message.content
            : `<context>\n${message.context}\n</context>\n\n${message.content}`,
          message.cache,
        ),
      };
    case 'tool':
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: toWireContent(message.content, message.cache),
      };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls !== undefined && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.argumentsText },
              })),
            }
          : {}),
      };
  }
}

function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'insufficient_credit';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'unavailable';
  return 'bad_request';
}

/** Talks to OpenRouter's HTTP API. Holds no state besides its options. */
/** OpenRouter's own search tool. It replaced the `web` plugin and the `:online` suffix. */
const WEB_SEARCH_TOOL = 'openrouter:web_search';

/** What an audio file is, read from its first bytes. The stream does not say. */
function audioTypeOf(bytes: Uint8Array): string | undefined {
  const starts = (...values: number[]): boolean =>
    values.every((value, index) => bytes[index] === value);
  if (starts(0x49, 0x44, 0x33)) return 'audio/mpeg';
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return 'audio/mpeg';
  if (starts(0x52, 0x49, 0x46, 0x46)) return 'audio/wav';
  if (starts(0x4f, 0x67, 0x67, 0x53)) return 'audio/ogg';
  if (starts(0x66, 0x4c, 0x61, 0x43)) return 'audio/flac';
  return undefined;
}

export function createOpenRouterProvider(options: OpenRouterOptions): GenerationProvider {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

  async function send(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    call: CallOptions,
    authenticated: boolean,
    binary = false,
  ): Promise<{
    json: unknown;
    text: string;
    bytes: Uint8Array | null;
    contentType: string | null;
  }> {
    const headers: Record<string, string> = { Accept: binary ? '*/*' : 'application/json' };
    if (authenticated) {
      headers['Authorization'] = `Bearer ${await options.apiKey()}`;
    }
    if (options.appName !== undefined) {
      headers['X-Title'] = options.appName;
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let response: HttpResponse;
    let text: string;
    let bytes: Uint8Array | null = null;
    try {
      response = await options.fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      });
      // A refusal is JSON even where the answer is binary.
      if (binary && response.ok) {
        bytes = await response.bytes();
        text = '';
      } else {
        text = await response.text();
      }
    } catch (cause) {
      throw new ProviderError('network', OPENROUTER_ID, 'Could not reach OpenRouter.', { cause });
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }

    if (!response.ok) {
      const parsed = ErrorResponse.safeParse(json);
      const detail = parsed.success ? parsed.data.error.message : `HTTP ${String(response.status)}`;
      throw new ProviderError(
        kindForStatus(response.status),
        OPENROUTER_ID,
        `OpenRouter refused the request: ${detail}`,
        { status: response.status },
      );
    }
    return { json, text, bytes, contentType: response.contentType };
  }

  const sendJson = async (...args: Parameters<typeof send>): Promise<unknown> =>
    (await send(...args)).json;

  /**
   * What the video models can make. Without it the catalog is still useful, so
   * a failure here only means that abilities are not known.
   */
  async function videoAbilities(call: CallOptions): Promise<Map<string, VideoAbilities>> {
    const abilities = new Map<string, VideoAbilities>();
    try {
      const json = await sendJson('/videos/models', 'GET', undefined, call, false);
      for (const model of parse(VideoModelsResponse, json, 'the video models').data) {
        abilities.set(model.id, {
          // -1 means that the model chooses the length itself.
          durationsSeconds: (model.supported_durations ?? []).filter((seconds) => seconds > 0),
          resolutions: model.supported_resolutions ?? [],
          aspectRatios: model.supported_aspect_ratios ?? [],
          frameImages: model.supported_frame_images ?? [],
          nativeAudio: model.generate_audio ?? null,
        });
      }
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
    }
    return abilities;
  }

  /** Speech models answer with the audio itself. */
  async function speak(body: unknown, call: CallOptions, what: string) {
    const { bytes, contentType } = await send('/audio/speech', 'POST', body, call, true, true);
    const mediaType = contentType?.split(';')[0]?.trim() ?? '';
    if (bytes === null || bytes.length === 0 || !mediaType.startsWith('audio/')) {
      throw new ProviderError(
        'invalid_response',
        OPENROUTER_ID,
        `OpenRouter returned ${what} without readable audio.`,
      );
    }
    return { bytes, mediaType };
  }

  /**
   * Music models are chat models whose audio comes only as a stream of events.
   * The stream is read whole: a piece arrives in one event at the end anyway.
   */
  async function compose(request: SoundRequest, call: CallOptions): Promise<SoundResponse> {
    const body = {
      model: request.model,
      messages: [{ role: 'user', content: request.prompt }],
      modalities: ['text', 'audio'],
      stream: true,
      usage: { include: true },
    };
    const { text } = await send('/chat/completions', 'POST', body, call, true);
    let encoded = '';
    let costUsd: number | null = null;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '' || data === '[DONE]') continue;
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const failure = ErrorResponse.safeParse(json);
      if (failure.success) {
        throw new ProviderError(
          'unavailable',
          OPENROUTER_ID,
          `OpenRouter reported an error: ${failure.data.error.message}`,
        );
      }
      const chunk = AudioStreamChunk.safeParse(json);
      if (!chunk.success) continue;
      encoded += chunk.data.choices?.[0]?.delta?.audio?.data ?? '';
      costUsd = chunk.data.usage?.cost ?? costUsd;
    }
    const bytes = decodeBase64(encoded);
    const mediaType = bytes === undefined ? undefined : audioTypeOf(bytes);
    if (bytes === undefined || mediaType === undefined) {
      throw new ProviderError(
        'invalid_response',
        OPENROUTER_ID,
        'OpenRouter returned music without readable audio.',
      );
    }
    return { model: request.model, audio: { bytes, mediaType }, costUsd };
  }

  function toVideoJob(json: unknown): VideoJob {
    const job = parse(VideoJobResponse, json, 'a video job');
    const done = job.status === 'completed';
    const waiting = job.status === 'pending' || job.status === 'in_progress';
    const reason = typeof job.error === 'string' ? job.error : job.error?.message;
    return {
      id: job.id,
      status: done ? 'completed' : waiting ? 'pending' : 'failed',
      progress: job.progress ?? null,
      // Cancelled and expired jobs come without a reason of their own.
      error: done || waiting ? null : (reason ?? `The job was ${job.status}.`),
      costUsd: job.usage?.cost ?? null,
    };
  }

  function parse<S extends z.ZodType>(schema: S, json: unknown, what: string): z.output<S> {
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      // OpenRouter can answer 200 with an error body, for example when an upstream model fails.
      const error = ErrorResponse.safeParse(json);
      throw new ProviderError(
        error.success ? 'unavailable' : 'invalid_response',
        OPENROUTER_ID,
        error.success
          ? `OpenRouter reported an error: ${error.data.error.message}`
          : `OpenRouter returned ${what} in an unexpected shape.`,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  return {
    id: OPENROUTER_ID,

    async listModels(call = {}): Promise<readonly ModelInfo[]> {
      // Without this parameter the catalog omits image, speech and video models.
      const [json, abilities] = await Promise.all([
        sendJson('/models?output_modalities=all', 'GET', undefined, call, false),
        videoAbilities(call),
      ]);
      return parse(ModelsResponse, json, 'the model catalog').data.map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        inputModalities: toModalities(model.architecture?.input_modalities),
        outputModalities: toModalities(model.architecture?.output_modalities),
        ...videoOf(abilities.get(model.id)),
        contextLength: model.context_length ?? null,
        supportsTools: model.supported_parameters?.includes('tools') ?? false,
        pricing: {
          promptUsdPerToken: toPrice(model.pricing?.prompt),
          completionUsdPerToken: toPrice(model.pricing?.completion),
        },
      }));
    },

    async verifyCredentials(call = {}): Promise<void> {
      await sendJson('/key', 'GET', undefined, call, true);
    },

    async chat(request: ChatRequest, call = {}): Promise<ChatResponse> {
      // Web search is a tool OpenRouter runs itself, listed beside the ones the caller runs.
      const tools = [
        ...(request.tools ?? []),
        ...(request.webSearch === true ? [{ type: WEB_SEARCH_TOOL }] : []),
      ];
      const body = {
        model: request.model,
        messages: toWireMessages(request.messages, request.media),
        usage: { include: true },
        ...(tools.length > 0 ? { tools } : {}),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
      };
      const json = await sendJson('/chat/completions', 'POST', body, call, true);
      const completion = parse(ChatCompletionResponse, json, 'a chat completion');
      const choice = completion.choices[0];
      if (choice === undefined) {
        throw new ProviderError(
          'invalid_response',
          OPENROUTER_ID,
          'OpenRouter returned no choice.',
        );
      }
      const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: parseArguments(toolCall.function.arguments),
        argumentsText: toolCall.function.arguments,
      }));
      return {
        model: completion.model ?? request.model,
        content: choice.message.content ?? null,
        toolCalls,
        finishReason: toFinishReason(choice.finish_reason),
        usage: {
          promptTokens: completion.usage?.prompt_tokens ?? 0,
          cachedPromptTokens: completion.usage?.prompt_tokens_details?.cached_tokens ?? 0,
          completionTokens: completion.usage?.completion_tokens ?? 0,
          costUsd: completion.usage?.cost ?? null,
        },
      };
    },

    async generateImage(request: ImageRequest, call = {}): Promise<ImageResponse> {
      const body = {
        model: request.model,
        prompt: request.prompt,
        ...(request.aspectRatio === undefined ? {} : { aspect_ratio: request.aspectRatio }),
        ...(request.seed === undefined ? {} : { seed: request.seed }),
        ...(request.references === undefined || request.references.length === 0
          ? {}
          : { input_references: request.references.map(toImagePart) }),
      };
      const json = await sendJson('/images', 'POST', body, call, true);
      const generation = parse(ImageGenerationResponse, json, 'an image');
      const images = generation.data.map((image) => {
        const bytes = typeof image.b64_json === 'string' ? decodeBase64(image.b64_json) : undefined;
        if (bytes === undefined || bytes.length === 0) {
          throw new ProviderError(
            'invalid_response',
            OPENROUTER_ID,
            'OpenRouter returned an image without readable data.',
          );
        }
        return { bytes, mediaType: image.media_type ?? 'image/png' };
      });
      return { model: request.model, images, costUsd: generation.usage?.cost ?? null };
    },

    async generateSpeech(request: SpeechRequest, call = {}): Promise<SpeechResponse> {
      const body = {
        model: request.model,
        input: request.text,
        // Without a format the service answers with raw samples no player can open.
        response_format: 'mp3',
        ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
      };
      // The price of speech is not part of the answer.
      return { model: request.model, audio: await speak(body, call, 'speech'), costUsd: null };
    },

    async generateSound(request: SoundRequest, call = {}): Promise<SoundResponse> {
      if (request.kind === 'music') return compose(request, call);
      const prompt = request.prompt.trim();
      const body = {
        model: request.model,
        // A speech model reads its text aloud unless the text opens like this.
        input: /^the sounds? of\b/i.test(prompt) ? prompt : `The sound of ${prompt}`,
        response_format: 'mp3',
      };
      return { model: request.model, audio: await speak(body, call, 'a sound'), costUsd: null };
    },

    async startVideo(request: VideoRequest, call = {}): Promise<VideoJob> {
      const body = {
        model: request.model,
        prompt: request.prompt,
        generate_audio: request.audio,
        ...(request.durationSeconds === undefined ? {} : { duration: request.durationSeconds }),
        ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
        ...(request.aspectRatio === undefined ? {} : { aspect_ratio: request.aspectRatio }),
        ...(request.references === undefined || request.references.length === 0
          ? {}
          : { input_references: request.references.map(toImagePart) }),
        ...(request.firstFrame === undefined
          ? {}
          : { frame_images: [{ ...toImagePart(request.firstFrame), frame_type: 'first_frame' }] }),
      };
      return toVideoJob(await sendJson('/videos', 'POST', body, call, true));
    },

    async checkVideo(jobId: string, call = {}): Promise<VideoJob> {
      const path = `/videos/${encodeURIComponent(jobId)}`;
      return toVideoJob(await sendJson(path, 'GET', undefined, call, true));
    },

    async downloadVideo(jobId: string, call = {}): Promise<MediaInput> {
      const path = `/videos/${encodeURIComponent(jobId)}/content?index=0`;
      const { bytes, contentType } = await send(path, 'GET', undefined, call, true, true);
      const mediaType = contentType?.split(';')[0]?.trim() ?? '';
      if (bytes === null || bytes.length === 0 || !mediaType.startsWith('video/')) {
        throw new ProviderError(
          'invalid_response',
          OPENROUTER_ID,
          'OpenRouter returned a clip without readable video.',
        );
      }
      return { bytes, mediaType };
    },
  };
}
