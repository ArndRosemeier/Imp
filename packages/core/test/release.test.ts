import { describe, expect, it } from 'vitest';
import {
  CommandRegistry,
  createReleaseCommands,
  UNKNOWN_RELEASE,
  type ReleaseNotes,
} from '../src/index.js';
import { createTestRuntime } from '../src/testing.js';

const notes: ReleaseNotes = {
  version: '0.010',
  date: '2026-11-25',
  preview: false,
  releases: [
    { version: '0.010', date: '2026-11-25', title: 'Ten', pr: 50, notes: ['Tenth.'] },
    { version: '0.009', date: '2026-11-24', title: 'Nine', notes: [] },
    { version: '0.002', date: '2026-11-22', title: 'Two', notes: ['Second.'] },
    { version: '0.001', date: '2026-11-21', title: 'Imp so far', notes: ['Everything.'] },
  ],
};

function setup(release: ReleaseNotes = notes) {
  const registry = new CommandRegistry({ runtime: createTestRuntime() }).register(
    ...createReleaseCommands(release),
  );
  return (id: string, input: unknown) =>
    registry.executeById(id, input, { actor: { kind: 'agent', id: 'a', role: 'coordinator' } });
}

describe('release commands', () => {
  it('tell agents which version runs', async () => {
    expect(await setup()('app.version', {})).toMatchObject({
      status: 'ok',
      output: { version: '0.010', date: '2026-11-25', preview: false },
    });
    expect(await setup(UNKNOWN_RELEASE)('app.version', {})).toMatchObject({
      output: { version: '0.000', date: null, preview: true },
    });
  });

  it('list the changes newest first, since a version and up to a limit', async () => {
    const run = setup();
    const all = await run('app.changelog', {});
    expect(all).toMatchObject({ status: 'ok', output: { version: '0.010', more: 0 } });
    expect((all as { output: ReleaseNotes }).output.releases).toHaveLength(4);

    // "0.010" is newer than "0.009", not older than "0.002".
    expect(await run('app.changelog', { since: '0.002' })).toMatchObject({
      output: { releases: [{ version: '0.010', pr: 50 }, { version: '0.009' }], more: 0 },
    });
    expect(await run('app.changelog', { limit: 1 })).toMatchObject({
      output: { releases: [{ version: '0.010' }], more: 3 },
    });
    await expect(run('app.changelog', { since: 'latest' })).rejects.toThrow();
  });

  it('refuse broken notes when the build starts', () => {
    expect(() => createReleaseCommands({ ...notes, version: 'one' })).toThrow();
  });
});
