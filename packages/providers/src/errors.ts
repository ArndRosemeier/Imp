export type ProviderErrorKind =
  | 'auth'
  | 'insufficient_credit'
  | 'rate_limit'
  | 'bad_request'
  | 'unavailable'
  | 'network'
  | 'invalid_response';

/** The one error type providers throw, so callers can decide whether to retry or ask the user. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly providerId: string;
  readonly status: number | null;

  constructor(
    kind: ProviderErrorKind,
    providerId: string,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.kind = kind;
    this.providerId = providerId;
    this.status = options.status ?? null;
  }

  /** True when the same request may succeed if sent again later. */
  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'unavailable' || this.kind === 'network';
  }
}
