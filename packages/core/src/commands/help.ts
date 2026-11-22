import { z } from 'zod';
import { defineCommand, type Command } from '../command.js';

/**
 * One page of Imp's own guide. The same pages are the help panel, the first
 * tip on each stage, the docs site and what the help agent reads, so the app
 * explains itself in one voice wherever someone asks.
 *
 * The body is a small subset of Markdown: `## ` headings, `- ` bullets,
 * `1. ` steps, blank lines between paragraphs, and **bold** and `code` inline.
 */
export const GuideTopic = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  title: z.string().min(1),
  /** One line, shown in lists and search results. */
  summary: z.string().min(1),
  /** Where it belongs: a stage id, "workspace" for app-wide pages. */
  area: z.string().min(1),
  body: z.string().min(1),
  /** The short tip shown the first time someone opens the stage this page is about. */
  hint: z.object({ title: z.string().min(1), body: z.string().min(1) }).optional(),
});
export type GuideTopic = z.infer<typeof GuideTopic>;

/** Settings, so the help layer is as visible to agents as any other choice. */
export const HELP_ENABLED = 'help.enabled';
export const HELP_DISMISSED = 'help.dismissed';
const SETTINGS = 'settings/';

export const HelpState = z.object({
  enabled: z
    .boolean()
    .describe(
      'Whether tips and guidance are shown. Off means none at all; the help panel and asking for help stay.',
    ),
  dismissed: z.array(z.string()).describe('The tips the person has closed, by id.'),
});
export type HelpState = z.infer<typeof HelpState>;

const Words = /[a-z0-9]+/g;

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(Words) ?? [];
}

/** How well a page answers a search: title words count most, then the summary, then the body. */
function score(topic: GuideTopic, query: readonly string[]): number {
  const title = wordsOf(topic.title);
  const summary = wordsOf(topic.summary);
  const body = wordsOf(topic.body);
  let total = 0;
  for (const word of query) {
    const hit = (list: readonly string[]): boolean => list.some((w) => w.startsWith(word));
    if (hit(title)) total += 5;
    if (hit(summary)) total += 3;
    if (hit(body)) total += 1;
  }
  return total;
}

/**
 * The help layer: whether tips are shown, which have been closed, and the
 * guide's pages. Turning help off is one command, so a person who knows Imp
 * (or an agent asked to) silences every tip at once.
 */
export function createHelpCommands(topics: readonly GuideTopic[]): readonly Command[] {
  const pages = topics.map((topic) => GuideTopic.parse(topic));
  const ids = new Set<string>();
  for (const page of pages) {
    if (ids.has(page.id)) throw new TypeError(`Guide page "${page.id}" is defined twice.`);
    ids.add(page.id);
  }

  const helpState = defineCommand({
    id: 'help.state',
    title: 'Show help settings',
    description:
      'Returns whether tips and guidance are shown to the person, and which tips they have already closed.',
    effect: 'read',
    input: z.object({}),
    output: HelpState,
    handler: async ({ runtime }) => {
      const enabled = await runtime.store.get(`${SETTINGS}${HELP_ENABLED}`);
      const dismissed = await runtime.store.get(`${SETTINGS}${HELP_DISMISSED}`);
      return {
        enabled: enabled !== false,
        dismissed: Array.isArray(dismissed)
          ? dismissed.filter((id): id is string => typeof id === 'string')
          : [],
      };
    },
  });

  const helpSet = defineCommand({
    id: 'help.set',
    title: 'Turn tips on or off',
    description:
      'Turns every tip and piece of guidance on or off in one step. Off suits people who know Imp; the help panel and asking for help stay available either way. Turning it on also shows closed tips again when reset is true.',
    effect: 'write',
    input: z.object({
      enabled: z.boolean(),
      reset: z.boolean().default(false).describe('Show the tips already closed again.'),
    }),
    output: HelpState,
    handler: async (context, { enabled, reset }) => {
      const before = await helpState.run(context, {});
      const dismissed = reset ? [] : before.dismissed;
      await context.runtime.store.batch([
        { type: 'put', key: `${SETTINGS}${HELP_ENABLED}`, value: enabled },
        { type: 'put', key: `${SETTINGS}${HELP_DISMISSED}`, value: dismissed },
      ]);
      return { enabled, dismissed };
    },
  });

  const hintDismiss = defineCommand({
    id: 'help.hint.dismiss',
    title: 'Close a tip',
    description:
      'Marks one tip as read so it is not shown again, for example "stage.shots" for the first tip on the Shots stage.',
    effect: 'write',
    input: z.object({ id: z.string().min(1).max(120) }),
    output: HelpState,
    handler: async (context, { id }) => {
      const before = await helpState.run(context, {});
      const dismissed = before.dismissed.includes(id)
        ? before.dismissed
        : [...before.dismissed, id];
      await context.runtime.store.batch([
        { type: 'put', key: `${SETTINGS}${HELP_DISMISSED}`, value: dismissed },
      ]);
      return { enabled: before.enabled, dismissed };
    },
  });

  const TopicListing = z.object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    area: z.string(),
  });
  const listing = (page: GuideTopic): z.infer<typeof TopicListing> => ({
    id: page.id,
    title: page.title,
    summary: page.summary,
    area: page.area,
  });

  const topicsList = defineCommand({
    id: 'help.topics',
    title: 'List guide pages',
    description:
      "Lists the pages of Imp's own guide (how each stage and feature works), or searches them when a query is given. Read one with help.topic.",
    effect: 'read',
    input: z.object({
      query: z.string().max(200).optional().describe('Words to search for; best matches first.'),
      area: z.string().optional().describe('Only pages about this stage id, or "workspace".'),
    }),
    output: z.object({ topics: z.array(TopicListing) }),
    handler: (_context, { query, area }) => {
      let found = area === undefined ? pages : pages.filter((page) => page.area === area);
      const words = wordsOf(query ?? '');
      if (words.length > 0) {
        found = found
          .map((page) => ({ page, score: score(page, words) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((entry) => entry.page);
      }
      return Promise.resolve({ topics: found.map(listing) });
    },
  });

  const topicGet = defineCommand({
    id: 'help.topic',
    title: 'Read a guide page',
    description:
      "Returns one page of Imp's own guide in full, with its first-time tip if it has one.",
    effect: 'read',
    input: z.object({ id: z.string() }),
    output: GuideTopic,
    handler: (_context, { id }) => {
      const page = pages.find((candidate) => candidate.id === id);
      if (page === undefined) {
        return Promise.reject(new Error(`No guide page "${id}". See help.topics for the list.`));
      }
      return Promise.resolve(page);
    },
  });

  return [helpState, helpSet, hintDismiss, topicsList, topicGet];
}
