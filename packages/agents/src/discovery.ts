import type { Command, ToolDefinition } from '@imp/core';
import { z } from 'zod';

/** Names without a double underscore can never collide with a command's tool name. */
export const FIND_TOOL = 'find_commands';
export const RUN_TOOL = 'run_command';

const MAX_MATCHES = 6;

export const discoveryTools: readonly ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: FIND_TOOL,
      description:
        'Looks up commands you can run that are not among your tools, and returns each with the exact input it takes. Search by group ("movie.scene"), by id or by what you want to do.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A group, a command id, or a few words.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: RUN_TOOL,
      description:
        'Runs a command found with find_commands. It is checked, approved and logged like any tool.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The command id, for example "movie.scene.create".' },
          input: { type: 'object', description: 'The input, in the shape find_commands returned.' },
        },
        required: ['id', 'input'],
        additionalProperties: false,
      },
    },
  },
];

const groupOf = (id: string): string => id.slice(0, Math.max(id.lastIndexOf('.'), 0)) || id;

/** One line for the instructions: which groups of commands exist beyond the tools. */
export function describeGroups(commands: readonly Command[]): string {
  const counts = new Map<string, number>();
  for (const command of commands) {
    counts.set(groupOf(command.id), (counts.get(groupOf(command.id)) ?? 0) + 1);
  }
  return [...counts]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([group, count]) => `${group} (${String(count)})`)
    .join(', ');
}

function score(command: Command, query: string, words: readonly string[]): number {
  const id = command.id.toLowerCase();
  if (id === query) return 100;
  let total = id.startsWith(query) ? 50 : 0;
  const text = `${command.title} ${command.description}`.toLowerCase();
  for (const word of words) {
    if (id.includes(word)) total += 5;
    if (text.includes(word)) total += 1;
  }
  return total;
}

/** The best matches for a query, each with everything needed to call it. */
export function findCommands(commands: readonly Command[], query: string): unknown {
  const normalized = query.trim().toLowerCase();
  const words = normalized.split(/[^a-z0-9.]+/).filter((word) => word.length > 1);
  const matches = commands
    .map((command) => ({ command, points: score(command, normalized, words) }))
    .filter(({ points }) => points > 0)
    .sort((a, b) => b.points - a.points || (a.command.id < b.command.id ? -1 : 1))
    .slice(0, MAX_MATCHES)
    .map(({ command }) => ({
      id: command.id,
      description: command.description,
      effect: command.effect,
      input: z.toJSONSchema(command.input, { io: 'input' }),
    }));
  return matches.length > 0
    ? { matches }
    : { matches: [], note: `Nothing matched. The groups are: ${describeGroups(commands)}.` };
}

/** True for a command the agent gets as a tool of its own. */
export function isDirect(command: Command, direct: readonly string[] | undefined): boolean {
  return direct === undefined || direct.some((prefix) => command.id.startsWith(prefix));
}
