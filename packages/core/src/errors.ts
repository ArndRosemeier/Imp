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

  constructor(
    code: CommandErrorCode,
    commandId: string,
    message: string,
    options: { details?: readonly string[]; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CommandError';
    this.code = code;
    this.commandId = commandId;
    this.details = options.details ?? [];
  }
}
