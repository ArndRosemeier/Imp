import { isInScope, MemoryBlobStore, MemoryKeyValueStore, toToolName } from '@imp/core';
import { coordinatorRole, findCommands, guideRole, isDirect, type Role } from '@imp/agents';
import { createFakeProvider } from '@imp/providers/testing';
import { describe, expect, it } from 'vitest';
import { createImp, createMemorySecretStore } from '../src/index.js';

/**
 * Every capability must be findable by the words people use for it. These run
 * the real lookup over every command the app registers, as the agents get it.
 * A capability that cannot be found is as good as missing to an agent: the
 * coordinator once saved a crew as a text note because "library" never led to
 * crew.saved.save.
 */
function lookup(role: Role) {
  const imp = createImp({
    store: new MemoryKeyValueStore(),
    blobs: new MemoryBlobStore(),
    secrets: createMemorySecretStore(),
    provider: createFakeProvider({}),
  });
  const inScope = imp.registry.list().filter((command) => isInScope(command, role.scope));
  return (query: string): string[] => {
    const found = findCommands(inScope, query, (command) =>
      isDirect(command, role.direct) ? toToolName(command.id) : undefined,
    ) as { matches: { id: string }[] };
    return found.matches.map((match) => match.id);
  };
}

const ASKS: readonly (readonly [string, string])[] = [
  ['save this as a named preproduction crew in the library', 'crew.saved.save'],
  ['save the crew', 'crew.saved.save'],
  ['store crew preset', 'crew.saved.save'],
  ['load a saved crew', 'crew.saved.load'],
  ['which crews are in the library', 'crew.saved.list'],
  ['library crews', 'crew.saved.list'],
  ['delete saved crew', 'crew.saved.delete'],
  ['save these models as a mix', 'models.mix.save'],
  ['keep the model settings in the library', 'models.mix.save'],
  ['apply model mix', 'models.mix.apply'],
  ['library mixes', 'models.mix.list'],
  ['create a custom critic role', 'crew.role.create'],
  ['save project as template', 'project.template.save'],
  ['copy asset to another project', 'library.copy'],
  ['import a picture into the library', 'library.import'],
  ['write a note', 'library.text.create'],
  ['save all backup', 'backup.save'],
  ['export the film', 'movie.edit.export'],
  ['what is new in this version', 'app.changelog'],
  ['turn off tips', 'help.set'],
  ['report a problem', 'support.report.prepare'],
];

describe('finding commands by what people call them', () => {
  for (const role of [coordinatorRole, guideRole]) {
    const find = lookup(role);
    it.each(ASKS)(`${role.name}: "%s" finds %s`, (query, id) => {
      expect(find(query)).toContain(id);
    });
  }

  it('finds every command by the title people see in the app', () => {
    const imp = createImp({
      store: new MemoryKeyValueStore(),
      blobs: new MemoryBlobStore(),
      secrets: createMemorySecretStore(),
      provider: createFakeProvider({}),
    });
    const commands = imp.registry.list();
    const lost = commands.filter((command) => {
      const found = findCommands(commands, command.title) as { matches: { id: string }[] };
      return !found.matches.some((match) => match.id === command.id);
    });
    expect(lost.map((command) => `${command.id} ("${command.title}")`)).toEqual([]);
  });

  it('says a command is already a tool instead of hiding it', () => {
    const imp = createImp({
      store: new MemoryKeyValueStore(),
      secrets: createMemorySecretStore(),
      provider: createFakeProvider({}),
    });
    const found = findCommands(imp.registry.list(), 'crew.saved.save', (command) =>
      isDirect(command, coordinatorRole.direct) ? toToolName(command.id) : undefined,
    ) as { matches: { id: string; tool?: string }[] };
    expect(found.matches[0]).toMatchObject({
      id: 'crew.saved.save',
      tool: toToolName('crew.saved.save'),
    });
  });
});
