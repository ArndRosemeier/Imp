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
  /**
   * Only commands that change something (any effect but read) whose id starts
   * with one of these prefixes. It keeps a role to writing in its own area
   * while it reads more widely. Defaults to everything `prefixes` allows.
   */
  readonly writes?: readonly string[];
}

/** True when `scope` exposes `command`. Agents are held to this at execution time too. */
export function isInScope(command: Command, scope: ToolScope = {}): boolean {
  return (
    (scope.effects?.includes(command.effect) ?? true) &&
    (scope.prefixes?.some((prefix) => command.id.startsWith(prefix)) ?? true) &&
    (command.effect === 'read' ||
      (scope.writes?.some((prefix) => command.id.startsWith(prefix)) ?? true))
  );
}

/**
 * The JSON Schema of what a command takes, for models and for forms. A field
 * that takes any JSON value is described by a schema that refers to itself,
 * which some model providers refuse outright; such a field is left open
 * instead, which says the same thing.
 */
export function inputSchemaOf(command: Command): Record<string, unknown> {
  const schema = z.toJSONSchema(command.input, { io: 'input' }) as Record<string, unknown>;
  const defs = (schema['$defs'] ?? {}) as Record<string, unknown>;
  const loops = new Set(
    Object.keys(defs)
      .map((name) => `#/$defs/${name}`)
      .filter((ref) => JSON.stringify(defs[ref.slice(8)]).includes(`"${ref}"`)),
  );
  if (loops.size === 0) return schema;
  const open = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(open);
    if (typeof value !== 'object' || value === null) return value;
    const { $ref: ref, ...rest } = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(typeof ref === 'string' && loops.has(ref) ? rest : value).map(
        ([key, inner]) => [key, open(inner)],
      ),
    );
  };
  const rest = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$defs'));
  const kept = Object.entries(defs).filter(([name]) => !loops.has(`#/$defs/${name}`));
  return {
    ...(open(rest) as Record<string, unknown>),
    ...(kept.length === 0 ? {} : { $defs: open(Object.fromEntries(kept)) }),
  };
}

/** Derives the tools an agent may call from the same definitions the UI uses. */
export function toToolDefinitions(
  commands: readonly Command[],
  scope: ToolScope = {},
): readonly ToolDefinition[] {
  return commands
    .filter((command) => isInScope(command, scope))
    .map((command) => ({
      type: 'function',
      function: {
        name: toToolName(command.id),
        description: command.description,
        parameters: inputSchemaOf(command),
      },
    }));
}
