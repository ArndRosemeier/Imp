import { ProviderError } from './errors.js';
import type { HttpFetch, HttpRequest } from './http.js';
import type {
  ChatRequest,
  ChatResponse,
  GenerationProvider,
  ImageRequest,
  ModelInfo,
  SoundRequest,
  SpeechRequest,
  VideoJob,
  VideoRequest,
} from './types.js';

export interface RecordedHttpCall {
  readonly url: string;
  readonly request: HttpRequest;
}

/** A `fetch` that answers from a queue and records what it was asked. */
export function createScriptedFetch(
  replies: readonly (
    | { status: number; body: unknown; contentType?: string }
    | { status: number; bytes: Uint8Array; contentType: string }
    | Error
  )[],
): { fetch: HttpFetch; calls: RecordedHttpCall[] } {
  const queue = [...replies];
  const calls: RecordedHttpCall[] = [];
  const fetch: HttpFetch = (url, request) => {
    calls.push({ url, request });
    const reply = queue.shift();
    if (reply === undefined) {
      return Promise.reject(new Error(`Unexpected request to ${url}`));
    }
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    const body = 'bytes' in reply ? reply.bytes : reply.body;
    const text =
      body instanceof Uint8Array ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      contentType: reply.contentType ?? 'application/json',
      text: () => Promise.resolve(text),
      bytes: () =>
        Promise.resolve(
          body instanceof Uint8Array ? body : Uint8Array.from(text, (c) => c.charCodeAt(0)),
        ),
    });
  };
  return { fetch, calls };
}

export type ScriptedChatReply = Partial<ChatResponse> | ProviderError;

/**
 * A provider that plays back scripted chat replies. Agent tests use it so that
 * agent behaviour is deterministic and costs nothing to run.
 */
export function createFakeProvider(script: {
  readonly models?: readonly ModelInfo[];
  readonly replies?: readonly ScriptedChatReply[];
  /** When set, `verifyCredentials` rejects with it. */
  readonly credentialsError?: ProviderError;
  /** When set, `generateImage` rejects with it. */
  readonly imageError?: ProviderError;
  /** When set, `generateSpeech` rejects with it. */
  readonly speechError?: ProviderError;
  /** When set, `generateSound` rejects with it. */
  readonly soundError?: ProviderError;
  /** When set, `startVideo` rejects with it. */
  readonly videoError?: ProviderError;
  /** When true, `startVideo` refuses requests that carry guiding images, as many models do. */
  readonly videoRefusesReferences?: boolean;
  /** How many times a video job reports that it is still being made. Defaults to one. */
  readonly videoPendingChecks?: number;
  /** When set, video jobs end as failed with this reason. */
  readonly videoFailure?: string;
}): GenerationProvider & {
  readonly requests: ChatRequest[];
  readonly imageRequests: ImageRequest[];
  readonly speechRequests: SpeechRequest[];
  readonly soundRequests: SoundRequest[];
  readonly videoRequests: VideoRequest[];
  /** Adds replies to the end of the script, for ones that depend on what happened first. */
  script(...replies: ScriptedChatReply[]): void;
} {
  const queue = [...(script.replies ?? [])];
  const requests: ChatRequest[] = [];
  const imageRequests: ImageRequest[] = [];
  const speechRequests: SpeechRequest[] = [];
  const videoRequests: VideoRequest[] = [];
  const soundRequests: SoundRequest[] = [];
  const checks = new Map<string, number>();
  const job = (id: string, status: VideoJob['status']): VideoJob => ({
    id,
    status,
    progress: status === 'pending' ? 50 : null,
    error: status === 'failed' ? (script.videoFailure ?? null) : null,
    costUsd: status === 'completed' ? 0.2 : null,
  });
  return {
    id: 'fake',
    requests,
    imageRequests,
    speechRequests,
    soundRequests,
    videoRequests,
    generateSound: (request) => {
      soundRequests.push(request);
      if (script.soundError !== undefined) {
        return Promise.reject(script.soundError);
      }
      return Promise.resolve({
        model: request.model,
        audio: { bytes: new Uint8Array([soundRequests.length]), mediaType: 'audio/mpeg' },
        costUsd: request.kind === 'music' ? 0.04 : null,
      });
    },
    startVideo: (request) => {
      videoRequests.push(request);
      if (script.videoError !== undefined) {
        return Promise.reject(script.videoError);
      }
      if (script.videoRefusesReferences === true && request.references !== undefined) {
        return Promise.reject(
          new ProviderError('bad_request', 'fake', 'This model takes no image references.'),
        );
      }
      const id = `job-${String(videoRequests.length)}`;
      checks.set(id, 0);
      return Promise.resolve(job(id, 'pending'));
    },
    checkVideo: (jobId) => {
      const seen = (checks.get(jobId) ?? 0) + 1;
      checks.set(jobId, seen);
      if (seen <= (script.videoPendingChecks ?? 1)) return Promise.resolve(job(jobId, 'pending'));
      return Promise.resolve(
        job(jobId, script.videoFailure === undefined ? 'completed' : 'failed'),
      );
    },
    downloadVideo: (jobId) =>
      Promise.resolve({
        bytes: new Uint8Array([Number(jobId.split('-')[1] ?? 0)]),
        mediaType: 'video/mp4',
      }),
    generateSpeech: (request) => {
      speechRequests.push(request);
      if (script.speechError !== undefined) {
        return Promise.reject(script.speechError);
      }
      return Promise.resolve({
        model: request.model,
        audio: { bytes: new Uint8Array([speechRequests.length]), mediaType: 'audio/mpeg' },
        costUsd: null,
      });
    },
    generateImage: (request) => {
      imageRequests.push(request);
      if (script.imageError !== undefined) {
        return Promise.reject(script.imageError);
      }
      // The bytes differ per call, so tests can tell generated images apart.
      return Promise.resolve({
        model: request.model,
        images: [{ bytes: new Uint8Array([imageRequests.length]), mediaType: 'image/webp' }],
        costUsd: 0.01,
      });
    },
    script: (...replies) => {
      queue.push(...replies);
    },
    listModels: () => Promise.resolve(script.models ?? []),
    verifyCredentials: () =>
      script.credentialsError === undefined
        ? Promise.resolve()
        : Promise.reject(script.credentialsError),
    chat: (request) => {
      requests.push(request);
      const reply = queue.shift();
      if (reply === undefined) {
        return Promise.reject(
          new ProviderError('invalid_response', 'fake', 'The fake provider ran out of replies.'),
        );
      }
      if (reply instanceof ProviderError) {
        return Promise.reject(reply);
      }
      return Promise.resolve({
        model: request.model,
        content: null,
        toolCalls: [],
        finishReason:
          reply.toolCalls !== undefined && reply.toolCalls.length > 0 ? 'tool_calls' : 'stop',
        usage: { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0, costUsd: 0 },
        ...reply,
      });
    },
  };
}
