import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CommandRegistry,
  defineCommand,
  fromToolName,
  inputSchemaOf,
  isInScope,
  settingsCommands,
  toToolDefinitions,
  toToolName,
} from '../src/index.js';
import { createTestRuntime } from '../src/testing.js';

const registry = new CommandRegistry({ runtime: createTestRuntime() }).register(
  ...settingsCommands,
);

describe('tool definitions', () => {
  it('maps command ids to tool names and back', () => {
    expect(toToolName('movie.character.create')).toBe('movie__character__create');
    expect(fromToolName('movie__character__create')).toBe('movie.character.create');
  });

  it('exposes a command with its description and a JSON Schema for its input', () => {
    const tool = toToolDefinitions(registry.list()).find(
      (candidate) => candidate.function.name === 'settings__set',
    );
    expect(tool).toMatchObject({
      type: 'function',
      function: {
        description: expect.stringContaining(
          'Stores a value for one setting, replacing any earlier value.',
        ) as string,
        parameters: { type: 'object', required: ['key', 'value'] },
      },
    });
  });

  it('leaves a field that takes any JSON value open instead of describing it by a loop', () => {
    const set = inputSchemaOf(registry.get('settings.set'));
    expect(JSON.stringify(set)).not.toContain('$ref');
    expect(set).not.toHaveProperty('$defs');
    expect(set).toMatchObject({ properties: { key: { type: 'string' }, value: {} } });
    const shared = z.object({ name: z.string() }).meta({ id: 'Named' });
    const mixed = defineCommand({
      id: 'test.mixed',
      title: 'Mixed',
      description: 'Takes a shared shape twice and any value in a list.',
      effect: 'read',
      input: z.object({ a: shared, b: shared, any: z.array(z.json()) }),
      output: z.object({}),
      handler: () => Promise.resolve({}),
    });
    expect(inputSchemaOf(mixed)).toMatchObject({
      properties: { a: { $ref: '#/$defs/Named' }, any: { type: 'array', items: {} } },
      $defs: { Named: { type: 'object' } },
    });
    expect(Object.keys(inputSchemaOf(mixed)['$defs'] as object)).toEqual(['Named']);
    expect(inputSchemaOf(registry.get('settings.get'))).not.toHaveProperty('$defs');
  });

  it('narrows the tools to a scope', () => {
    const names = (scope: Parameters<typeof toToolDefinitions>[1]) =>
      toToolDefinitions(registry.list(), scope).map((tool) => tool.function.name);
    expect(names({ effects: ['read'] })).toEqual(['settings__get', 'settings__list']);
    expect(names({ prefixes: ['movie.'] })).toEqual([]);
    expect(names({ prefixes: ['settings.'], effects: ['write'] })).toEqual(['settings__set']);
  });
});

/**
 * Parity: every capability must be reachable by an agent. This walks whatever
 * is registered, so it keeps holding as commands are added.
 */
describe('parity', () => {
  it('gives every registered command exactly one valid, reversible tool', () => {
    const commands = registry.list();
    const tools = toToolDefinitions(commands);
    expect(tools).toHaveLength(commands.length);
    for (const [index, tool] of tools.entries()) {
      expect(tool.function.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(fromToolName(tool.function.name)).toBe(commands[index]?.id);
      expect(tool.function.description.length).toBeGreaterThanOrEqual(20);
      expect(tool.function.parameters).toHaveProperty('type', 'object');
    }
  });
});

describe('a scope that keeps writing to an area', () => {
  const command = (id: string, effect: 'read' | 'write' | 'spend') =>
    defineCommand({
      id,
      title: id,
      description: 'A command to test which scopes expose it.',
      effect,
      input: z.object({}),
      output: z.object({}),
      handler: () => Promise.resolve({}),
    });

  it('reads widely and changes only what `writes` names', () => {
    const scope = { prefixes: ['story.'], writes: ['story.scene.'] };
    expect(isInScope(command('story.cast.get', 'read'), scope)).toBe(true);
    expect(isInScope(command('story.scene.write', 'write'), scope)).toBe(true);
    expect(isInScope(command('story.cast.add', 'write'), scope)).toBe(false);
    expect(isInScope(command('story.cast.picture', 'spend'), scope)).toBe(false);
    // Left out, it writes wherever it reads, as before.
    expect(isInScope(command('story.cast.add', 'write'), { prefixes: ['story.'] })).toBe(true);
  });
});
