import { z } from 'zod';
import { defineCommand, type Command } from '../command.js';
import { Language, readLanguage } from '../language.js';

const Version = z
  .string()
  .regex(/^\d+\.\d{3}$/)
  .describe('A version such as "0.004". Each merge to main adds 0.001.');

export const ReleaseEntry = z.object({
  version: Version,
  date: z
    .string()
    .nullable()
    .describe('The day it was published (YYYY-MM-DD), or null if not yet.'),
  title: z.string(),
  pr: z.number().int().optional().describe('The pull request that brought it.'),
  notes: z.array(z.string()).describe('One plain-language line per change people will notice.'),
  translations: z
    .record(z.string(), z.object({ title: z.string(), notes: z.array(z.string()) }))
    .optional()
    .describe('The title and notes in other languages, by language id.'),
});
export type ReleaseEntry = z.infer<typeof ReleaseEntry>;

export const ReleaseNotes = z.object({
  version: Version,
  date: z.string().nullable(),
  preview: z
    .boolean()
    .describe('True for a build that is not a published version, such as one under development.'),
  releases: z.array(ReleaseEntry).describe('Newest first.'),
});
export type ReleaseNotes = z.infer<typeof ReleaseNotes>;

/** A build that knows nothing of its history, as tests and bare hosts are. */
export const UNKNOWN_RELEASE: ReleaseNotes = {
  version: '0.000',
  date: null,
  preview: true,
  releases: [],
};

/** Orders "0.010" after "0.009" and "1.000" after "0.999". */
function versionNumber(version: string): number {
  return Math.round(Number(version) * 1000);
}

/**
 * The version of this build and what changed in each version, read by the
 * What's new panel and by agents that want to know what Imp can do now.
 */
export function createReleaseCommands(release: ReleaseNotes): readonly Command[] {
  // A build that carries broken notes fails here, at start, rather than in front of someone.
  const notes = ReleaseNotes.parse(release);
  const appVersion = defineCommand({
    id: 'app.version',
    title: 'Show version',
    description:
      'Returns the version of Imp that is running, the day it was published, and whether it is a preview build.',
    effect: 'read',
    input: z.object({}),
    output: z.object({ version: Version, date: z.string().nullable(), preview: z.boolean() }),
    handler: () =>
      Promise.resolve({ version: notes.version, date: notes.date, preview: notes.preview }),
  });

  const appChangelog = defineCommand({
    id: 'app.changelog',
    title: "What's new",
    description:
      'Lists what changed in Imp, version by version, newest first, in plain language. Use it to learn about features added recently or to tell the user what is new. Pass `since` to get only versions newer than one you already know, and `limit` to get only the latest few.',
    effect: 'read',
    input: z.object({
      since: Version.optional().describe('Only versions newer than this one.'),
      limit: z.number().int().min(1).optional().describe('At most this many versions.'),
      language: Language.optional().describe(
        'The language to tell it in; the interface language when left out. Versions not translated stay in English.',
      ),
    }),
    output: z.object({
      version: Version,
      preview: z.boolean(),
      releases: z.array(ReleaseEntry),
      more: z.number().int().describe('How many more versions match but were left out by `limit`.'),
    }),
    handler: async ({ runtime }, { since, limit, language }) => {
      const told = language ?? (await readLanguage(runtime.store));
      const after = since === undefined ? -1 : versionNumber(since);
      const matching = notes.releases.filter((release) => versionNumber(release.version) > after);
      const releases = (limit === undefined ? matching : matching.slice(0, limit)).map(
        ({ translations, ...release }) => ({ ...release, ...translations?.[told] }),
      );
      return {
        version: notes.version,
        preview: notes.preview,
        releases,
        more: matching.length - releases.length,
      };
    },
  });

  return [appVersion, appChangelog];
}
