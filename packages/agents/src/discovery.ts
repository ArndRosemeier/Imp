import { inputSchemaOf, type Command, type ToolDefinition } from '@imp/core';

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
        'Looks up every command you can run, your own tools included, and returns each with the exact input it takes. Search by group ("movie.scene"), by id, by where it is in the app ("library crews") or by what you want to do. Look before you say Imp cannot do something.',
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

/** Words that say nothing about which command is meant. */
const STOP_WORDS = new Set(
  'a an and as at be by do for from i in into is it its let lets me my of on or our so that the this to us we with you your'.split(
    ' ',
  ),
);

/** The word and its plain forms, so "crews" finds crew and "saved" finds save. */
function formsOf(word: string): string[] {
  const forms = [word];
  if (word.length > 3) {
    if (word.endsWith('es')) forms.push(word.slice(0, -2));
    if (word.endsWith('s')) forms.push(word.slice(0, -1));
    if (word.endsWith('ed')) forms.push(word.slice(0, -2), word.slice(0, -1));
    if (word.endsWith('ing')) forms.push(word.slice(0, -3), `${word.slice(0, -3)}e`);
  }
  return forms;
}

const wordsOf = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

/**
 * How well a command answers the query. The id counts most, then the title
 * (the label people see in the app) and the keywords, as whole words, then
 * any mention in the description.
 */
function score(command: Command, query: string, words: readonly string[]): number {
  const id = command.id.toLowerCase();
  if (id === query) return 100;
  let total = id.startsWith(query) ? 50 : 0;
  const title = wordsOf(command.title);
  const keywords = wordsOf((command.keywords ?? []).join(' '));
  const text = `${command.title} ${command.description}`.toLowerCase();
  for (const word of words) {
    const forms = formsOf(word);
    if (forms.some((form) => id.includes(form))) total += 5;
    if (forms.some((form) => title.has(form))) total += 3;
    if (forms.some((form) => keywords.has(form))) total += 3;
    if (forms.some((form) => text.includes(form))) total += 1;
  }
  return total;
}

/**
 * The best matches for a query, each with everything needed to call it. It
 * searches every command the agent may run, its own tools too, so a lookup
 * never makes a capability look missing; `toolOf` names the tool for those.
 */
export function findCommands(
  commands: readonly Command[],
  query: string,
  toolOf: (command: Command) => string | undefined = () => undefined,
): unknown {
  const normalized = query.trim().toLowerCase();
  const words = normalized
    .split(/[^a-z0-9.]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
  const matches = commands
    .map((command) => ({ command, points: score(command, normalized, words) }))
    .filter(({ points }) => points > 0)
    .sort((a, b) => b.points - a.points || (a.command.id < b.command.id ? -1 : 1))
    .slice(0, MAX_MATCHES)
    .map(({ command }) => {
      const tool = toolOf(command);
      return {
        id: command.id,
        description: command.description,
        effect: command.effect,
        ...(tool === undefined
          ? { input: inputSchemaOf(command) }
          : { tool, note: 'Already one of your tools: call it directly.' }),
      };
    });
  return matches.length > 0
    ? { matches }
    : { matches: [], note: `Nothing matched. The groups are: ${describeGroups(commands)}.` };
}

/** True for a command the agent gets as a tool of its own. */
export function isDirect(command: Command, direct: readonly string[] | undefined): boolean {
  return direct === undefined || direct.some((prefix) => command.id.startsWith(prefix));
}
