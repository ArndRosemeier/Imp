import { z } from 'zod';
import type { Command, Effect } from './command.js';

/** A command in the shape chat-completion APIs accept as a callable tool. */
export interface ToolDefinition {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

/**
 * Tool names may not contain dots, so `settings.get` travels as `settings__get`.
 * Command ids never contain underscores, which makes the mapping reversible.
 */
export function toToolName(commandId: string): string {
  return commandId.replaceAll('.', '__');
}

export function fromToolName(toolName: string): string {
  return toolName.replaceAll('__', '.');
}

export interface ToolScope {
  /** Only commands with one of these effects are exposed. Defaults to all. */
  readonly effects?: readonly Effect[];
  /** Only commands whose id starts with one of these prefixes. Defaults to all. */
  readonly prefixes?: readonly string[];
}

/** Derives the tools an agent may call from the same definitions the UI uses. */
export function toToolDefinitions(
  commands: readonly Command[],
  scope: ToolScope = {},
): readonly ToolDefinition[] {
  return commands
    .filter((command) => scope.effects?.includes(command.effect) ?? true)
    .filter((command) => scope.prefixes?.some((prefix) => command.id.startsWith(prefix)) ?? true)
    .map((command) => ({
      type: 'function',
      function: {
        name: toToolName(command.id),
        description: command.description,
        parameters: z.toJSONSchema(command.input, { io: 'input' }),
      },
    }));
}
