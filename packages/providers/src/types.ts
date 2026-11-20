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
  | ({
      readonly role: 'tool';
      readonly toolCallId: string;
      readonly content: string;
      /** Media the tool hands the model to look at or listen to, beside its text result. */
      readonly attachments?: readonly Attachment[];
    } & Cacheable);

/**
 * A stored image, sound or video shown to a model. Conversations hold only
 * this reference, so they stay small; the bytes travel in `ChatRequest.media`.
 */
export interface Attachment {
  /** The key of the blob. */
  readonly key: string;
  /** For example `image/webp`, `audio/mpeg`, `video/mp4`. */
  readonly mediaType: string;
}

/** Which kind of input a media type is to a model, or undefined when no model takes it. */
export function modalityOf(mediaType: string): 'image' | 'audio' | 'video' | undefined {
  const kind = mediaType.split('/')[0];
  return kind === 'image' || kind === 'audio' || kind === 'video' ? kind : undefined;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDefinition[];
  /**
   * Lets the model look things up on the web while it answers. The provider
   * runs the searches; they are part of the cost of the call.
   */
  readonly webSearch?: boolean;
  /**
   * The bytes of the attachments the messages refer to, by key. An attachment
   * without an entry here is described to the model as no longer available.
   */
  readonly media?: ReadonlyMap<string, Uint8Array>;
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

export interface ImageRequest {
  /** An id from the catalog whose output modalities include `image`. */
  readonly model: string;
  readonly prompt: string;
  /** Width to height, for example `3:4`. Left out, the model decides. */
  readonly aspectRatio?: string;
  /** The same seed, prompt and model give the same image, where the model supports it. */
  readonly seed?: number;
}

export interface GeneratedImage {
  readonly bytes: Uint8Array;
  /** What the bytes are, for example `image/webp`. Models choose their own format. */
  readonly mediaType: string;
}

export interface ImageResponse {
  readonly model: string;
  readonly images: readonly GeneratedImage[];
  /** What the call cost in US dollars, or null when the provider did not say. */
  readonly costUsd: number | null;
}

export interface SpeechRequest {
  /** An id from the catalog whose output modalities include `speech`. */
  readonly model: string;
  /** What is said. */
  readonly text: string;
  /** How it is said: who speaks, in what manner. Models that take no direction ignore it. */
  readonly instructions?: string;
}

export interface SpeechResponse {
  readonly model: string;
  readonly audio: { readonly bytes: Uint8Array; readonly mediaType: string };
  /** What the call cost in US dollars, or null when the provider did not say. */
  readonly costUsd: number | null;
}

/** A stored file handed to a generation as a guide: a portrait, a first frame. */
export interface MediaInput {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

export interface VideoRequest {
  /** An id from the catalog whose output modalities include `video`. */
  readonly model: string;
  readonly prompt: string;
  /** Models take only certain lengths; a refusal names the ones they take. */
  readonly durationSeconds?: number;
  /** For example `480p` or `720p`. */
  readonly resolution?: string;
  /** Width to height, for example `16:9`. */
  readonly aspectRatio?: string;
  /** Whether the clip gets sound. Always say, because models differ in what they do unasked. */
  readonly audio: boolean;
  /** Images that guide who and what is in the clip, without fixing a frame. */
  readonly references?: readonly MediaInput[];
  /** An image the clip starts on exactly. */
  readonly firstFrame?: MediaInput;
}

/**
 * A video being made. Clips take minutes, so a job is started, looked at
 * again later, and downloaded once it is done.
 */
export interface VideoJob {
  readonly id: string;
  readonly status: 'pending' | 'completed' | 'failed';
  /** Percent done, where the model reports it. */
  readonly progress: number | null;
  /** Why it failed, in the provider's words. */
  readonly error: string | null;
  /** What it cost in US dollars, known once it is done, or null when the provider did not say. */
  readonly costUsd: number | null;
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
 * Audio and video capabilities join this interface as modes need them.
 */
export interface GenerationProvider {
  readonly id: string;
  /** The live catalog. Model ids are never hardcoded; they are chosen from this. */
  listModels(options?: CallOptions): Promise<readonly ModelInfo[]>;
  chat(request: ChatRequest, options?: CallOptions): Promise<ChatResponse>;
  generateImage(request: ImageRequest, options?: CallOptions): Promise<ImageResponse>;
  generateSpeech(request: SpeechRequest, options?: CallOptions): Promise<SpeechResponse>;
  /** Starts a clip and returns at once. Money is spent from here on. */
  startVideo(request: VideoRequest, options?: CallOptions): Promise<VideoJob>;
  checkVideo(jobId: string, options?: CallOptions): Promise<VideoJob>;
  /** The finished clip. Fails while the job is not completed. */
  downloadVideo(jobId: string, options?: CallOptions): Promise<MediaInput>;
  /** Resolves when the stored credentials are accepted, and throws a `ProviderError` otherwise. */
  verifyCredentials(options?: CallOptions): Promise<void>;
}
