import type { z } from 'zod';
import type { Actor } from './actor.js';
import { CommandError } from './errors.js';
import type { CostRequest } from './cost.js';
import type { CoreRuntime } from './runtime.js';

/**
 * What a command does to the world. Approval rules and budgets key on this.
 * - `read`: returns state and changes nothing
 * - `write`: changes project state and can be undone
 * - `spend`: costs money at a provider
 * - `destructive`: removes something that cannot be restored
 */
export const EFFECTS = ['read', 'write', 'spend', 'destructive'] as const;
export type Effect = (typeof EFFECTS)[number];

export interface CommandContext {
  readonly actor: Actor;
  readonly runtime: CoreRuntime;
}

export interface CommandSpec<I extends z.ZodType, O extends z.ZodType> {
  /** Dotted, lower-case, globally unique: `movie.character.create`. */
  readonly id: string;
  /** A short label for menus and the command palette. */
  readonly title: string;
  /** What the command does, written for an LLM choosing a tool. */
  readonly description: string;
  /**
   * Other words people and agents use for it, such as where it sits in the UI
   * ("library", "Crews tab") or what they call the thing ("preset"). Only
   * command lookup reads them.
   */
  readonly keywords?: readonly string[];
  readonly effect: Effect;
  readonly input: I;
  readonly output: O;
  readonly handler: (context: CommandContext, input: z.output<I>) => Promise<z.input<O>>;
  /**
   * For commands that spend: what running it with this input would make, so
   * it can be priced first. Reads only; null when it cannot say.
   */
  readonly estimate?: (context: CommandContext, input: z.output<I>) => Promise<CostRequest | null>;
}

/** The type-erased form the registry stores and every caller can run. */
export interface Command {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Extra search words for command lookup; see CommandSpec. */
  readonly keywords?: readonly string[];
  readonly effect: Effect;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  /** Validates `rawInput`, runs the handler and validates the result. */
  readonly run: (context: CommandContext, rawInput: unknown) => Promise<unknown>;
  /** What it would make, for pricing before it runs. Null for invalid input or when it cannot say. */
  readonly estimate?: (context: CommandContext, rawInput: unknown) => Promise<CostRequest | null>;
}

/** A command that still remembers its input and output types, for typed callers. */
export interface TypedCommand<I extends z.ZodType, O extends z.ZodType> extends Command {
  readonly input: I;
  readonly output: O;
  readonly run: (context: CommandContext, rawInput: unknown) => Promise<z.output<O>>;
}

const ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const MIN_DESCRIPTION_LENGTH = 20;

function issueLines(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });
}

/**
 * Declares a capability once. The UI, agents and outside callers all reach it
 * through the registry, so nothing here may assume who is calling.
 */
export function defineCommand<I extends z.ZodType, O extends z.ZodType>(
  spec: CommandSpec<I, O>,
): TypedCommand<I, O> {
  if (!ID_PATTERN.test(spec.id)) {
    throw new CommandError(
      'invalid_definition',
      spec.id,
      `Command id "${spec.id}" must be dotted and lower-case, like "settings.get".`,
    );
  }
  if (spec.title.trim() === '') {
    throw new CommandError('invalid_definition', spec.id, `Command "${spec.id}" needs a title.`);
  }
  if (spec.description.trim().length < MIN_DESCRIPTION_LENGTH) {
    throw new CommandError(
      'invalid_definition',
      spec.id,
      `Command "${spec.id}" needs a description an agent can choose it by.`,
    );
  }

  return {
    id: spec.id,
    title: spec.title,
    description: spec.description,
    ...(spec.keywords === undefined ? {} : { keywords: spec.keywords }),
    effect: spec.effect,
    input: spec.input,
    output: spec.output,
    ...(spec.estimate === undefined
      ? {}
      : {
          estimate: async (context: CommandContext, rawInput: unknown) => {
            const input = spec.input.safeParse(rawInput);
            if (!input.success || spec.estimate === undefined) return null;
            return spec.estimate(context, input.data);
          },
        }),
    run: async (context, rawInput) => {
      const input = spec.input.safeParse(rawInput);
      if (!input.success) {
        throw new CommandError('invalid_input', spec.id, `Invalid input for "${spec.id}".`, {
          details: issueLines(input.error),
        });
      }
      let result: z.input<O>;
      try {
        result = await spec.handler(context, input.data);
      } catch (error) {
        if (error instanceof CommandError) {
          throw error;
        }
        throw new CommandError('handler_failed', spec.id, `Command "${spec.id}" failed.`, {
          cause: error,
        });
      }
      const output = spec.output.safeParse(result);
      if (!output.success) {
        throw new CommandError('invalid_output', spec.id, `"${spec.id}" returned invalid output.`, {
          details: issueLines(output.error),
        });
      }
      return output.data;
    },
  };
}
