import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CommandError, defineCommand, type Actor, type CommandContext } from '../src/index.js';
import { createTestRuntime } from '../src/testing.js';

const user: Actor = { kind: 'user', id: 'arnd' };
const context = (): CommandContext => ({ actor: user, runtime: createTestRuntime() });

const base = {
  id: 'test.double',
  title: 'Double',
  description: 'Returns the given number multiplied by two.',
  effect: 'read',
  input: z.object({ n: z.number() }),
  output: z.object({ n: z.number() }),
  handler: ({ n }: { n: number }) => Promise.resolve({ n: n * 2 }),
} as const;

const double = defineCommand({ ...base, handler: (_context, input) => base.handler(input) });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CommandError) {
      return error.code;
    }
    throw error;
  }
  return 'no error';
}

describe('defineCommand', () => {
  it('validates input, runs the handler and returns validated output', async () => {
    expect(await double.run(context(), { n: 21 })).toEqual({ n: 42 });
  });

  it('rejects invalid input with the failing paths', async () => {
    const attempt = double.run(context(), { n: 'x' });
    await expect(attempt).rejects.toMatchObject({
      code: 'invalid_input',
      commandId: 'test.double',
    });
    await attempt.catch((error: unknown) => {
      expect(error).toBeInstanceOf(CommandError);
      expect((error as CommandError).details[0]).toMatch(/^n: /);
    });
  });

  it('rejects output that does not match the schema', async () => {
    const broken = defineCommand({
      ...base,
      output: z.object({ n: z.number().max(10) }),
      handler: () => Promise.resolve({ n: 99 }),
    });
    expect(await codeOf(broken.run(context(), { n: 1 }))).toBe('invalid_output');
  });

  it('wraps handler failures and keeps the cause', async () => {
    const cause = new Error('boom');
    const failing = defineCommand({ ...base, handler: () => Promise.reject(cause) });
    await expect(failing.run(context(), { n: 1 })).rejects.toMatchObject({
      code: 'handler_failed',
      cause,
    });
  });

  it('passes a CommandError thrown by a handler through unchanged', async () => {
    const thrown = new CommandError('denied', 'test.double', 'no');
    const failing = defineCommand({ ...base, handler: () => Promise.reject(thrown) });
    await expect(failing.run(context(), { n: 1 })).rejects.toBe(thrown);
  });

  it('reports root-level schema issues without a path', async () => {
    const attempt = double.run(context(), 'not an object');
    await attempt.catch((error: unknown) => {
      expect((error as CommandError).details[0]).toMatch(/^Invalid input/);
    });
    expect(await codeOf(attempt)).toBe('invalid_input');
  });

  it.each([
    ['an id without a namespace', { id: 'double' }],
    ['an upper-case id', { id: 'Test.double' }],
    ['an id with an underscore', { id: 'test.do_uble' }],
    ['an empty title', { title: ' ' }],
    ['a description too short to choose by', { description: 'Doubles.' }],
  ])('refuses %s', (_label, override) => {
    expect(() =>
      defineCommand({ ...base, handler: (_c, input) => base.handler(input), ...override }),
    ).toThrow(CommandError);
  });
});
