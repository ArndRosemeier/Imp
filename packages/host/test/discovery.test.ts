import { MemoryBlobStore, MemoryKeyValueStore, toToolName } from '@imp/core';
import {
  coordinatorRole,
  findCommands,
  globalCoordinatorRole,
  guideRole,
  isDirect,
  roleCanUse,
  type Role,
} from '@imp/agents';
import { filmEditor } from '@imp/mode-movie';
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
  const inScope = imp.registry.list().filter((command) => roleCanUse(role, command));
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
  ['switch the interface to German', 'settings.language.set'],
  ['Sprache auf Deutsch stellen', 'settings.language.set'],
  ['which language is the app in', 'settings.language.get'],
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
  ['what is new in this version', 'app.changelog'],
  ['turn off tips', 'help.set'],
  ['report a problem', 'support.report.prepare'],
  ['set a budget so agents spend without asking', 'spend.allowance.set'],
  ['how much budget is left without approval', 'spend.allowance.get'],
];

/** Asks only some roles can act on: each role finds what is its own to do. */
const ROLE_ASKS: readonly (readonly [Role, string, string])[] = [
  [guideRole, 'export the film', 'movie.edit.export'],
  [filmEditor, 'export the film', 'movie.edit.export'],
  [coordinatorRole, 'what does the screenwriter need before writing', 'crew.needs'],
  [coordinatorRole, 'check prerequisites before tasking', 'crew.needs'],
  [coordinatorRole, 'this film has no characters, so no cast is needed', 'crew.needs.waive'],
  [coordinatorRole, 'which models fit the casting director', 'models.list'],
];

describe('finding commands by what people call them', () => {
  for (const role of [globalCoordinatorRole, guideRole]) {
    const find = lookup(role);
    it.each(ASKS)(`${role.name}: "%s" finds %s`, (query, id) => {
      expect(find(query)).toContain(id);
    });
  }

  it.each(ROLE_ASKS.map(([role, query, id]) => [role.name, query, id, role] as const))(
    '%s: "%s" finds %s',
    (_name, query, id, role) => {
      expect(lookup(role)(query)).toContain(id);
    },
  );

  it('never offers the coordinator the work of the crew', () => {
    const find = lookup(coordinatorRole);
    expect(find('export the film')).not.toContain('movie.edit.export');
    expect(find('write a scene')).not.toContain('movie.scene.create');
  });

  it("keeps what concerns all projects from a project's coordinator, which passes it on", () => {
    const find = lookup(coordinatorRole);
    for (const [query, id] of [
      ['save the crew', 'crew.saved.save'],
      ['switch the interface to German', 'settings.language.set'],
      ['create a custom critic role', 'crew.role.create'],
      ['save all backup', 'backup.save'],
    ] as const) {
      expect(find(query)).not.toContain(id);
    }
    // Its own project's things it still does.
    expect(find('copy asset to another project')).toContain('library.copy');
    expect(find('report a problem')).toContain('support.report.prepare');
  });

  it('never offers the Imp coordinator the work inside a project', () => {
    const find = lookup(globalCoordinatorRole);
    expect(find('export the film')).not.toContain('movie.edit.export');
    expect(find('write a scene')).not.toContain('movie.scene.create');
  });

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
