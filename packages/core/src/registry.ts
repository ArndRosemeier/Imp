import type { z } from 'zod';
import { appendActivity, type ActivityEntry } from './activity.js';
import type { Actor } from './actor.js';
import type { Command, CommandContext, TypedCommand } from './command.js';
import { CommandError } from './errors.js';
import { defaultPolicy, type ExecutionPolicy } from './policy.js';
import type { CoreRuntime } from './runtime.js';

export type ExecutionResult<T> =
  | { readonly status: 'ok'; readonly output: T }
  /** The policy wants a person to confirm first. Nothing has run. */
  | { readonly status: 'needs-approval'; readonly commandId: string; readonly input: unknown };

export interface ExecuteOptions {
  readonly actor: Actor;
  /** Set once a person has confirmed a `needs-approval` result. Never lifts a `deny`. */
  readonly approved?: boolean;
}

/**
 * Lets a step the policy would put to a person run without asking, such as an
 * agent's spending within the allowance the person set. Never lifts a `deny`.
 */
export type AutoApproval = (
  context: CommandContext,
  command: Command,
  rawInput: unknown,
) => Promise<boolean>;

export interface CommandRegistryOptions {
  readonly runtime: CoreRuntime;
  readonly policy?: ExecutionPolicy;
  readonly autoApprove?: AutoApproval;
}

/**
 * The single entry point for every capability. The UI, hired agents, the
 * coordinator and the HTTP endpoint all execute commands here and nowhere else.
 */
export class CommandRegistry {
  readonly #commands = new Map<string, Command>();
  readonly #runtime: CoreRuntime;
  readonly #policy: ExecutionPolicy;
  readonly #autoApprove: AutoApproval | undefined;

  constructor(options: CommandRegistryOptions) {
    this.#runtime = options.runtime;
    this.#policy = options.policy ?? defaultPolicy;
    this.#autoApprove = options.autoApprove;
  }

  register(...commands: readonly Command[]): this {
    for (const command of commands) {
      if (this.#commands.has(command.id)) {
        throw new CommandError(
          'duplicate_command',
          command.id,
          `Command "${command.id}" is already registered.`,
        );
      }
      this.#commands.set(command.id, command);
    }
    return this;
  }

  has(id: string): boolean {
    return this.#commands.has(id);
  }

  get(id: string): Command {
    const command = this.#commands.get(id);
    if (command === undefined) {
      throw new CommandError('unknown_command', id, `Unknown command "${id}".`);
    }
    return command;
  }

  /** Every registered command, sorted by id. */
  list(): readonly Command[] {
    return [...this.#commands.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** The typed call used by code that holds the command definition. */
  async execute<I extends z.ZodType, O extends z.ZodType>(
    command: TypedCommand<I, O>,
    input: z.input<I>,
    options: ExecuteOptions,
  ): Promise<ExecutionResult<z.output<O>>> {
    const registered = this.get(command.id);
    if (registered !== command) {
      throw new CommandError(
        'unknown_command',
        command.id,
        `A different command is registered as "${command.id}".`,
      );
    }
    return this.#run(command.id, input, options, (context, raw) => command.run(context, raw));
  }

  /** The untyped call used by agents and the HTTP endpoint, where input arrives as data. */
  async executeById(
    id: string,
    rawInput: unknown,
    options: ExecuteOptions,
  ): Promise<ExecutionResult<unknown>> {
    const command = this.get(id);
    return this.#run(id, rawInput, options, (context, raw) => command.run(context, raw));
  }

  /** True when the step may run without asking. A failing check asks, as if there were none. */
  async #allowed(command: Command, actor: Actor, rawInput: unknown): Promise<boolean> {
    if (this.#autoApprove === undefined) return false;
    try {
      return await this.#autoApprove({ actor, runtime: this.#runtime }, command, rawInput);
    } catch {
      return false;
    }
  }

  async #run<T>(
    id: string,
    rawInput: unknown,
    options: ExecuteOptions,
    run: Command['run'] extends (...args: infer A) => unknown ? (...args: A) => Promise<T> : never,
  ): Promise<ExecutionResult<T>> {
    const command = this.get(id);
    const { actor } = options;
    const startedAt = this.#runtime.now();
    const record = async (
      outcome: ActivityEntry['outcome'],
      error: string | null = null,
    ): Promise<void> => {
      await appendActivity(this.#runtime.store, {
        id: this.#runtime.newId(),
        at: startedAt.toISOString(),
        actor,
        commandId: id,
        effect: command.effect,
        outcome,
        durationMs: Math.max(0, this.#runtime.now().getTime() - startedAt.getTime()),
        error,
      });
    };

    const decision = this.#policy(actor, command);
    if (decision === 'deny') {
      await record('denied');
      throw new CommandError('denied', id, `${actor.kind} "${actor.id}" may not run "${id}".`);
    }
    if (
      decision === 'needs-approval' &&
      options.approved !== true &&
      !(await this.#allowed(command, actor, rawInput))
    ) {
      await record('needs-approval');
      return { status: 'needs-approval', commandId: id, input: rawInput };
    }

    try {
      const output = await run({ actor, runtime: this.#runtime }, rawInput);
      // A successful read changes nothing, so it is not worth a log entry. This also
      // lets a view read the log through a command without the read adding to it.
      if (command.effect !== 'read') {
        await record('ok');
      }
      return { status: 'ok', output };
    } catch (error) {
      await record('failed', failureText(error));
      throw error;
    }
  }
}

/** A failure as one line for the log: the message, and what caused it when the message hides it. */
function failureText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = error.cause;
  if (cause instanceof Error && !error.message.includes(cause.message)) {
    return `${error.message} ${cause.message}`;
  }
  return error.message;
}
