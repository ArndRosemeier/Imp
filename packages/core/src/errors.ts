export type CommandErrorCode =
  | 'unknown_command'
  | 'duplicate_command'
  | 'invalid_definition'
  | 'invalid_input'
  | 'invalid_output'
  | 'denied'
  | 'handler_failed';

/** The one error type the command layer throws, so every caller can branch on `code`. */
export class CommandError extends Error {
  readonly code: CommandErrorCode;
  readonly commandId: string;
  readonly details: readonly string[];
  /**
   * True when running the same command again may well succeed, because what
   * failed was outside Imp: the provider could not be reached, was busy, or
   * had a problem of its own. People get a Retry button; agents try again.
   * Left out, it follows the cause, so a provider error that is worth
   * retrying stays so when a command wraps it.
   */
  readonly retryable: boolean;

  constructor(
    code: CommandErrorCode,
    commandId: string,
    message: string,
    options: { details?: readonly string[]; cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CommandError';
    this.code = code;
    this.commandId = commandId;
    this.details = options.details ?? [];
    this.retryable = options.retryable ?? isRetryable(options.cause);
  }
}

/** Whether an error says that trying again may help, as provider errors and command errors do. */
export function isRetryable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { retryable?: unknown }).retryable === true
  );
}
