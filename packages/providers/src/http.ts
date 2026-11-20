import type { CancelSignal } from './types.js';

export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal?: CancelSignal;
}

export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/**
 * The slice of `fetch` a provider needs. Both hosts pass their platform
 * `fetch`; tests pass a scripted function. Keeping it this small is what lets
 * the package compile without browser or Node type libraries.
 */
export type HttpFetch = (url: string, request: HttpRequest) => Promise<HttpResponse>;
