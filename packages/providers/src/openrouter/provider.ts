import type { JsonValue } from '@imp/core';
import type { z } from 'zod';
import { decodeBase64 } from '../base64.js';
import { ProviderError, type ProviderErrorKind } from '../errors.js';
import type { HttpFetch, HttpResponse } from '../http.js';
import {
  MODALITIES,
  type CallOptions,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type FinishReason,
  type GenerationProvider,
  type ImageRequest,
  type ImageResponse,
  type Modality,
  type ModelInfo,
  type ToolCall,
} from '../types.js';
import {
  ChatCompletionResponse,
  ErrorResponse,
  ImageGenerationResponse,
  ModelsResponse,
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
export function createOpenRouterProvider(options: OpenRouterOptions): GenerationProvider {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

  async function send(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    call: CallOptions,
    authenticated: boolean,
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' };
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
    try {
      response = await options.fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      });
      text = await response.text();
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
    return json;
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
      const json = await send('/models?output_modalities=all', 'GET', undefined, call, false);
      return parse(ModelsResponse, json, 'the model catalog').data.map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        inputModalities: toModalities(model.architecture?.input_modalities),
        outputModalities: toModalities(model.architecture?.output_modalities),
        contextLength: model.context_length ?? null,
        supportsTools: model.supported_parameters?.includes('tools') ?? false,
        pricing: {
          promptUsdPerToken: toPrice(model.pricing?.prompt),
          completionUsdPerToken: toPrice(model.pricing?.completion),
        },
      }));
    },

    async verifyCredentials(call = {}): Promise<void> {
      await send('/key', 'GET', undefined, call, true);
    },

    async chat(request: ChatRequest, call = {}): Promise<ChatResponse> {
      const body = {
        model: request.model,
        messages: request.messages.map(toWireMessage),
        usage: { include: true },
        ...(request.tools !== undefined && request.tools.length > 0
          ? { tools: request.tools }
          : {}),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
      };
      const json = await send('/chat/completions', 'POST', body, call, true);
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
      };
      const json = await send('/images', 'POST', body, call, true);
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
  };
}
