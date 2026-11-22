import { z } from 'zod';
import { readActivity } from '../activity.js';
import { defineCommand, type Command } from '../command.js';
import type { ReleaseNotes } from './release.js';

/** Where problems are reported: the project's issue tracker. */
export const ISSUES_URL = 'https://github.com/ArndRosemeier/Imp/issues/new';

/** Browsers and GitHub refuse very long addresses, so the report is kept under this many characters. */
const MAX_BODY = 6000;
const MAX_ERROR = 300;

/**
 * Anything shaped like a key or a token is blanked before it can reach a
 * report: OpenRouter keys, bearer tokens and long secrets in URLs.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[a-z0-9-]{2,}[-_]?[A-Za-z0-9_-]{8,}/gi, '[key removed]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [removed]')
    .replace(/([?&](?:key|token|api_key|access_token)=)[^&\s]+/gi, '$1[removed]');
}

export const ProblemReport = z.object({
  title: z.string(),
  body: z.string().describe('The text of the issue, diagnostics included.'),
  url: z
    .string()
    .describe(
      'Opens a new GitHub issue with the title and text filled in. The person checks it, then submits it with their GitHub account.',
    ),
  diagnostics: z.string().describe('Only the technical part, for showing before it is sent.'),
});
export type ProblemReport = z.infer<typeof ProblemReport>;

/** The report an agent prepared last, for the button in its chat. */
export const READY_REPORT_KEY = 'support/report';

export const ReadyReport = z.object({
  memberId: z.string(),
  title: z.string(),
  url: z.string(),
  at: z.string(),
});
export type ReadyReport = z.infer<typeof ReadyReport>;

export interface SupportOptions {
  readonly release: ReleaseNotes;
  /** Where this copy of Imp runs, for example "browser" or "local server, Node 24 on linux". */
  readonly runsOn: string;
}

/**
 * Reporting a problem: the report is written here, with the version, where
 * Imp runs and what failed lately, and opened as a new GitHub issue that the
 * person reads and submits themselves. Nothing is sent from here, and keys,
 * prompts and story text never go in: the activity log holds only command
 * names, outcomes and error messages, and errors are scrubbed of secrets.
 */
export function createSupportCommands(options: SupportOptions): readonly Command[] {
  const prepare = defineCommand({
    id: 'support.report.prepare',
    title: 'Prepare a problem report',
    description:
      "Writes a problem report for Imp's developers and returns a link that opens it as a new GitHub issue, filled in, for the person to check and submit. It adds the version, where Imp runs and, unless told not to, the latest commands with their errors. No keys, prompts or story text go in. When an agent prepares it, the person gets a button for it in that agent's chat, because the link is long and carries the whole report: tell them to use the button there instead of pasting the link. Nothing is sent until they submit it on GitHub.",
    effect: 'read',
    input: z.object({
      title: z.string().min(1).max(200).describe('The problem in a few words.'),
      whatHappened: z
        .string()
        .min(1)
        .max(3000)
        .describe('What happened, and what was done before.'),
      expected: z.string().max(1500).default('').describe('What should have happened.'),
      includeActivity: z
        .boolean()
        .default(true)
        .describe('Add the latest commands, their outcomes and errors. No inputs or outputs.'),
      client: z
        .string()
        .max(300)
        .default('')
        .describe('The screen and input the person uses, as the interface knows it.'),
    }),
    output: ProblemReport,
    handler: async ({ actor, runtime }, input) => {
      const { release } = options;
      const lines = [
        `- Version: ${release.version}${release.preview ? ' (preview build)' : ''}`,
        `- Runs on: ${options.runsOn}`,
        ...(input.client === '' ? [] : [`- Screen: ${input.client}`]),
      ];
      if (input.includeActivity) {
        const latest = (await readActivity(runtime.store)).slice(-15).reverse();
        const failed = latest.filter((entry) => entry.outcome === 'failed').length;
        lines.push('', `Latest commands (${String(failed)} failed), newest first:`, '');
        for (const entry of latest) {
          const error =
            entry.error === null
              ? ''
              : `: ${redactSecrets(entry.error).slice(0, MAX_ERROR).replaceAll('\n', ' ')}`;
          lines.push(
            `- ${entry.at.slice(11, 19)} ${entry.actor.kind} ${entry.commandId} ${entry.outcome}${error}`,
          );
        }
      }
      const diagnostics = lines.join('\n');
      const parts = [
        '## What happened',
        '',
        redactSecrets(input.whatHappened.trim()),
        ...(input.expected.trim() === ''
          ? []
          : ['', '## What I expected', '', redactSecrets(input.expected.trim())]),
        '',
        '## Diagnostics',
        '',
        diagnostics,
        '',
        '_Reported from inside Imp. No keys, prompts or story text are included._',
      ];
      let body = parts.join('\n');
      if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n\n(cut short)`;
      const title = redactSecrets(input.title.trim());
      const url = `${ISSUES_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
      if (actor.kind === 'agent') {
        // Agents retell links shortened, and a cut link loses the report it carries.
        const ready: ReadyReport = {
          memberId: actor.id,
          title,
          url,
          at: runtime.now().toISOString(),
        };
        await runtime.store.batch([{ type: 'put', key: READY_REPORT_KEY, value: ready }]);
      }
      return { title, body, url, diagnostics };
    },
  });

  const latest = defineCommand({
    id: 'support.report.ready',
    title: 'Show the report an agent prepared',
    description:
      'Returns the problem report an agent prepared last and the person has not opened or dismissed yet, with its full link, or null.',
    effect: 'read',
    input: z.object({}),
    output: z.object({ report: ReadyReport.nullable() }),
    handler: async ({ runtime }) => {
      const parsed = ReadyReport.safeParse(await runtime.store.get(READY_REPORT_KEY));
      return { report: parsed.success ? parsed.data : null };
    },
  });

  const dismiss = defineCommand({
    id: 'support.report.dismiss',
    title: 'Dismiss the prepared report',
    description: 'Removes the button for the problem report an agent prepared.',
    effect: 'write',
    input: z.object({}),
    output: z.object({}),
    handler: async ({ runtime }) => {
      await runtime.store.batch([{ type: 'delete', key: READY_REPORT_KEY }]);
      return {};
    },
  });
  return [prepare, latest, dismiss];
}
