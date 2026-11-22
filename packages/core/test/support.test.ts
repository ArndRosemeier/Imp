import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CommandRegistry,
  createSupportCommands,
  defineCommand,
  ISSUES_URL,
  ProblemReport,
  redactSecrets,
} from '../src/index.js';
import { createTestRuntime } from '../src/testing.js';

const user = { kind: 'user', id: 'arnd' } as const;
const FAKE_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';

const broken = defineCommand({
  id: 'media.broken',
  title: 'Broken',
  description: 'Fails the way a provider call can, with the key in its message.',
  effect: 'read',
  input: z.object({ prompt: z.string() }),
  output: z.object({}),
  handler: () => Promise.reject(new Error(`401 for key ${FAKE_KEY}`)),
});

function setup() {
  const registry = new CommandRegistry({ runtime: createTestRuntime() }).register(
    broken,
    ...createSupportCommands({
      release: { version: '0.017', date: null, preview: false, releases: [] },
      runsOn: 'browser: Test',
    }),
  );
  const run = (id: string, input: unknown) => registry.executeById(id, input, { actor: user });
  return { run };
}

describe('problem reports', () => {
  it('are a filled-in GitHub issue with the version and what failed, never a key or a prompt', async () => {
    const { run } = setup();
    await run('media.broken', { prompt: 'Mara climbs the stairs in secret' }).catch(() => null);
    const result = await run('support.report.prepare', {
      title: 'Clips fail',
      whatHappened: `Every clip fails. My key is ${FAKE_KEY}.`,
      client: '1366×1024, touch',
    });
    if (result.status !== 'ok') throw new Error(result.status);
    const report = ProblemReport.parse(result.output);
    expect(report.url.startsWith(`${ISSUES_URL}?`)).toBe(true);
    expect(report.body).toContain('Version: 0.017');
    expect(report.body).toContain('Runs on: browser: Test');
    expect(report.body).toContain('Screen: 1366×1024, touch');
    expect(report.diagnostics).toMatch(/media\.broken failed: .*401 for key \[key removed\]/);
    expect(report.body).not.toContain(FAKE_KEY);
    expect(decodeURIComponent(report.url)).not.toContain(FAKE_KEY);
    // Inputs are not in the activity log, so the story stays out.
    expect(report.body).not.toContain('Mara');

    const quiet = await run('support.report.prepare', {
      title: 'A question',
      whatHappened: 'Nothing broke.',
      includeActivity: false,
    });
    expect(ProblemReport.parse(quiet.status === 'ok' ? quiet.output : null).body).not.toContain(
      'media.broken',
    );
  });

  it('blank keys and tokens wherever they appear', () => {
    expect(redactSecrets(`Bearer abcdefghijklmnop and ?key=secret123&x=1`)).toBe(
      'Bearer [removed] and ?key=[removed]&x=1',
    );
    expect(redactSecrets('nothing secret here')).toBe('nothing secret here');
  });
});
