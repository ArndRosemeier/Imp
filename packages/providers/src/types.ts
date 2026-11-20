import type { JsonValue, ToolDefinition } from '@imp/core';

/** What a model can produce. A provider reports these per model. */
export const MODALITIES = [
  'text',
  'image',
  'audio',
  'speech',
  'video',
  'embeddings',
  'transcription',
  'other',
] as const;
export type Modality = (typeof MODALITIES)[number];

export interface ModelInfo {
  /** The id to pass back to the provider, exactly as it reported it. */
  readonly id: string;
  readonly name: string;
  readonly inputModalities: readonly Modality[];
  readonly outputModalities: readonly Modality[];
  readonly contextLength: number | null;
  /** True when the model accepts tool definitions, which agents need. */
  readonly supportsTools: boolean;
  /** US dollars per token, or null when the provider prices the model another way. */
  readonly pricing: {
    readonly promptUsdPerToken: number | null;
    readonly completionUsdPerToken: number | null;
  };
}

export interface ToolCall {
  readonly id: string;
  /** The tool name as sent to the model; map it back with `fromToolName`. */
  readonly name: string;
  /** The parsed arguments, or `undefined` when the model produced invalid JSON. */
  readonly arguments: JsonValue | undefined;
  /** The arguments exactly as the model wrote them. */
  readonly argumentsText: string;
}

/**
 * Marks the end of a stable prefix: the request up to and including this
 * message is expected to be sent again unchanged, so a provider that can
 * cache prompts should cache it. Providers that cannot ignore the mark.
 */
interface Cacheable {
  readonly cache?: boolean;
}

export type ChatMessage =
  | ({ readonly role: 'system'; readonly content: string } & Cacheable)
  | ({
      readonly role: 'user';
      readonly content: string;
      /**
       * Background for the model that the person did not write, sent ahead of
       * the content. Kept apart so that a conversation view shows only their words.
       */
      readonly context?: string;
    } & Cacheable)
  | {
      readonly role: 'assistant';
      readonly content: string | null;
      readonly toolCalls?: readonly ToolCall[];
    }
  | ({ readonly role: 'tool'; readonly toolCallId: string; readonly content: string } & Cacheable);

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'other';

export interface Usage {
  readonly promptTokens: number;
  /** How many of the prompt tokens were read from the provider's cache, at a fraction of the price. */
  readonly cachedPromptTokens: number;
  readonly completionTokens: number;
  /** What the call cost in US dollars, or null when the provider did not say. */
  readonly costUsd: number | null;
}

export interface ChatResponse {
  readonly model: string;
  readonly content: string | null;
  readonly toolCalls: readonly ToolCall[];
  readonly finishReason: FinishReason;
  readonly usage: Usage;
}

/** Lets a caller cancel a request. Structurally matches the platform `AbortSignal`. */
export interface CancelSignal {
  readonly aborted: boolean;
}

export interface CallOptions {
  readonly signal?: CancelSignal;
}

/**
 * A source of generation. Callers ask for a capability and a model and never
 * for a provider-specific endpoint, so providers can be added or swapped.
 * Image, audio and video capabilities join this interface as modes need them.
 */
export interface GenerationProvider {
  readonly id: string;
  /** The live catalog. Model ids are never hardcoded; they are chosen from this. */
  listModels(options?: CallOptions): Promise<readonly ModelInfo[]>;
  chat(request: ChatRequest, options?: CallOptions): Promise<ChatResponse>;
  /** Resolves when the stored credentials are accepted, and throws a `ProviderError` otherwise. */
  verifyCredentials(options?: CallOptions): Promise<void>;
}
