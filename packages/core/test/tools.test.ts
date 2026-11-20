import { describe, expect, it } from 'vitest';
import {
  CommandRegistry,
  fromToolName,
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
        description: 'Stores a value for one setting, replacing any earlier value.',
        parameters: { type: 'object', required: ['key', 'value'] },
      },
    });
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
