import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  activityList,
  CommandRegistry,
  defineCommand,
  readActivity,
  settingsCommands,
  settingsGet,
  settingsList,
  settingsSet,
  type Actor,
  type Effect,
  type ExecutionPolicy,
} from '../src/index.js';
import { createTestRuntime } from '../src/testing.js';

const user: Actor = { kind: 'user', id: 'arnd' };
const agent: Actor = { kind: 'agent', id: 'agent-1', role: 'screenwriter' };

const withEffect = (effect: Effect) =>
  defineCommand({
    id: `test.${effect}`,
    title: `Do ${effect}`,
    description: `A test command whose effect level is ${effect}.`,
    effect,
    input: z.object({}),
    output: z.object({ done: z.literal(true) }),
    handler: () => Promise.resolve({ done: true as const }),
  });

function setup(policy?: ExecutionPolicy) {
  const runtime = createTestRuntime();
  const registry = new CommandRegistry({ runtime, ...(policy ? { policy } : {}) });
  registry.register(...settingsCommands);
  return { runtime, registry };
}

describe('CommandRegistry', () => {
  it('lists commands sorted by id and finds them', () => {
    const { registry } = setup();
    expect(registry.list().map((command) => command.id)).toEqual([
      'settings.get',
      'settings.list',
      'settings.set',
    ]);
    expect(registry.has('settings.get')).toBe(true);
    expect(registry.has('settings.nope')).toBe(false);
    expect(registry.get('settings.get')).toBe(settingsGet);
  });

  it('refuses a duplicate id and an unknown id', () => {
    const { registry } = setup();
    expect(() => registry.register(settingsGet)).toThrow(/already registered/);
    expect(() => registry.get('nope.nope')).toThrow(/Unknown command/);
  });

  it('refuses a typed call with a definition that is not the registered one', async () => {
    const { registry } = setup();
    const impostor = defineCommand({
      id: 'settings.get',
      title: 'Impostor',
      description: 'Has the same id as a registered command.',
      effect: 'read',
      input: z.object({}),
      output: z.object({}),
      handler: () => Promise.resolve({}),
    });
    await expect(registry.execute(impostor, {}, { actor: user })).rejects.toMatchObject({
      code: 'unknown_command',
    });
  });

  it('gives the same result through the typed call and the call by id', async () => {
    const { registry } = setup();
    const typed = await registry.execute(
      settingsSet,
      { key: 'coordinator.model', value: 'some/model' },
      { actor: user },
    );
    expect(typed).toEqual({
      status: 'ok',
      output: { key: 'coordinator.model', value: 'some/model' },
    });

    // An agent reaches the very same state through the untyped path.
    const byId = await registry.executeById(
      'settings.get',
      { key: 'coordinator.model' },
      { actor: agent },
    );
    expect(byId).toEqual({
      status: 'ok',
      output: { key: 'coordinator.model', value: 'some/model' },
    });
  });

  it('runs the settings commands end to end', async () => {
    const { registry } = setup();
    const unset = await registry.execute(settingsGet, { key: 'theme' }, { actor: user });
    expect(unset).toEqual({ status: 'ok', output: { key: 'theme', value: null } });

    await registry.execute(settingsSet, { key: 'theme', value: 'dark' }, { actor: user });
    await registry.execute(settingsSet, { key: 'budget.daily', value: 5 }, { actor: user });
    const listed = await registry.execute(settingsList, {}, { actor: user });
    expect(listed).toEqual({
      status: 'ok',
      output: {
        settings: [
          { key: 'budget.daily', value: 5 },
          { key: 'theme', value: 'dark' },
        ],
      },
    });
  });

  it('records every execution with its actor and outcome', async () => {
    const { registry, runtime } = setup();
    await registry.execute(settingsSet, { key: 'theme', value: 'dark' }, { actor: user });
    await expect(
      registry.executeById('settings.set', { key: 'Not Valid' }, { actor: agent }),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    const log = await readActivity(runtime.store);
    expect(
      log.map(({ actor, commandId, effect, outcome }) => ({ actor, commandId, effect, outcome })),
    ).toEqual([
      { actor: user, commandId: 'settings.set', effect: 'write', outcome: 'ok' },
      { actor: agent, commandId: 'settings.set', effect: 'write', outcome: 'failed' },
    ]);
    expect(log[0]?.error).toBeNull();
    expect(log[1]?.error).toMatch(/Invalid input/);
    expect(log[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns the log through a command, newest first and limited, without logging reads', async () => {
    const { registry } = setup();
    registry.register(activityList);
    await registry.execute(settingsSet, { key: 'a', value: 1 }, { actor: user });
    await registry.execute(settingsSet, { key: 'b', value: 2 }, { actor: agent });
    await registry.execute(settingsGet, { key: 'a' }, { actor: agent });
    const all = await registry.execute(activityList, {}, { actor: user });
    expect(
      all.status === 'ok' && all.output.entries.map((entry) => [entry.actor.kind, entry.commandId]),
    ).toEqual([
      ['agent', 'settings.set'],
      ['user', 'settings.set'],
    ]);
    const one = await registry.execute(activityList, { limit: 1 }, { actor: user });
    expect(one.status === 'ok' && one.output.entries).toHaveLength(1);
  });

  it('records a non-Error failure as text', async () => {
    const { registry, runtime } = setup();
    const odd = defineCommand({
      id: 'test.odd',
      title: 'Odd',
      description: 'A command registered with a run that rejects oddly.',
      effect: 'read',
      input: z.object({}),
      output: z.object({}),
      handler: () => Promise.resolve({}),
    });
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test
    registry.register({ ...odd, run: () => Promise.reject('plain text') });
    await expect(registry.executeById('test.odd', {}, { actor: user })).rejects.toBe('plain text');
    expect((await readActivity(runtime.store))[0]?.error).toBe('plain text');
  });

  describe('default policy', () => {
    it.each<[Effect, 'ok' | 'needs-approval']>([
      ['read', 'ok'],
      ['write', 'ok'],
      ['spend', 'needs-approval'],
      ['destructive', 'needs-approval'],
    ])('lets an agent run a %s command with result %s', async (effect, status) => {
      const { registry } = setup();
      const command = withEffect(effect);
      registry.register(command);
      const result = await registry.execute(command, {}, { actor: agent });
      expect(result.status).toBe(status);
    });

    it.each<Effect>(['read', 'write', 'spend', 'destructive'])(
      'lets the user run a %s command directly',
      async (effect) => {
        const { registry } = setup();
        const command = withEffect(effect);
        registry.register(command);
        expect((await registry.execute(command, {}, { actor: user })).status).toBe('ok');
      },
    );

    it('returns the pending call without running it, then runs it once approved', async () => {
      const { registry, runtime } = setup();
      const spend = withEffect('spend');
      registry.register(spend);

      const pending = await registry.executeById('test.spend', {}, { actor: agent });
      expect(pending).toEqual({ status: 'needs-approval', commandId: 'test.spend', input: {} });

      const approved = await registry.executeById(
        'test.spend',
        {},
        { actor: agent, approved: true },
      );
      expect(approved).toEqual({ status: 'ok', output: { done: true } });

      expect((await readActivity(runtime.store)).map((entry) => entry.outcome)).toEqual([
        'needs-approval',
        'ok',
      ]);
    });
  });

  it('never lets approval lift a denial', async () => {
    const { registry, runtime } = setup((actor) => (actor.kind === 'agent' ? 'deny' : 'allow'));
    await expect(
      registry.executeById('settings.list', {}, { actor: agent, approved: true }),
    ).rejects.toMatchObject({ code: 'denied' });
    expect((await readActivity(runtime.store))[0]?.outcome).toBe('denied');
  });
});

describe('approval without asking', () => {
  function withAutoApprove(autoApprove: (actor: Actor) => Promise<boolean>) {
    const runtime = createTestRuntime();
    const registry = new CommandRegistry({
      runtime,
      autoApprove: (context) => autoApprove(context.actor),
    });
    registry.register(withEffect('spend'), withEffect('read'));
    return registry;
  }

  it('lets a step the policy would ask about run when the check allows it', async () => {
    const registry = withAutoApprove(() => Promise.resolve(true));
    expect(await registry.executeById('test.spend', {}, { actor: agent })).toMatchObject({
      status: 'ok',
    });
  });

  it('asks when the check says no or fails, and never lifts a deny', async () => {
    expect(
      await withAutoApprove(() => Promise.resolve(false)).executeById(
        'test.spend',
        {},
        { actor: agent },
      ),
    ).toMatchObject({ status: 'needs-approval' });
    expect(
      await withAutoApprove(() => Promise.reject(new Error('no prices'))).executeById(
        'test.spend',
        {},
        { actor: agent },
      ),
    ).toMatchObject({ status: 'needs-approval' });
    const denying = new CommandRegistry({
      runtime: createTestRuntime(),
      policy: () => 'deny',
      autoApprove: () => Promise.resolve(true),
    }).register(withEffect('spend'));
    await expect(denying.executeById('test.spend', {}, { actor: agent })).rejects.toThrow(
      /may not run/,
    );
  });
});
