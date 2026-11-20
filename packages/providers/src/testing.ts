import { ProviderError } from './errors.js';
import type { HttpFetch, HttpRequest } from './http.js';
import type { ChatRequest, ChatResponse, GenerationProvider, ModelInfo } from './types.js';

export interface RecordedHttpCall {
  readonly url: string;
  readonly request: HttpRequest;
}

/** A `fetch` that answers from a queue and records what it was asked. */
export function createScriptedFetch(
  replies: readonly ({ status: number; body: unknown } | Error)[],
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
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: () => Promise.resolve(text),
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
}): GenerationProvider & {
  readonly requests: ChatRequest[];
  /** Adds replies to the end of the script, for ones that depend on what happened first. */
  script(...replies: ScriptedChatReply[]): void;
} {
  const queue = [...(script.replies ?? [])];
  const requests: ChatRequest[] = [];
  return {
    id: 'fake',
    requests,
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
