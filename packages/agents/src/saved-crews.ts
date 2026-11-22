import { CommandError, defineCommand, type Command, type KeyValueStore } from '@imp/core';
import { z } from 'zod';
import { forgetConversations } from './conversations.js';
import { CrewMember } from './crew.js';
import { CUSTOM_ROLE_PREFIX, StoredRole, type RoleCatalog } from './role.js';

const CREW_PREFIX = 'crew/';
/** Where saved crews are kept, by id. They belong to the workspace, not to one project. */
export const SAVED_CREW_PREFIX = 'saved-crews/';
/** The coordinator is never swapped out by loading a crew: it may be the one loading it. */
const COORDINATOR = 'coordinator';

/** One agent of a saved crew: everything needed to hire it again. */
export const SavedCrewMember = CrewMember.pick({
  roleId: true,
  name: true,
  model: true,
  budgetUsdPerRun: true,
  webSearch: true,
});
export type SavedCrewMember = z.infer<typeof SavedCrewMember>;

export const SavedCrew = z.object({
  id: z.string(),
  name: z.string().min(1),
  notes: z.string().default(''),
  members: z.array(SavedCrewMember),
  /** Copies of the custom roles its agents hold, so the crew loads even after one is deleted. */
  roles: z.array(StoredRole).default([]),
  savedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SavedCrew = z.infer<typeof SavedCrew>;

const Summary = SavedCrew.pick({ id: true, name: true, notes: true, updatedAt: true }).extend({
  members: z.array(SavedCrewMember.pick({ roleId: true, name: true, model: true })),
});

async function readCrew(store: KeyValueStore): Promise<CrewMember[]> {
  return (await store.list(CREW_PREFIX)).map((entry) => CrewMember.parse(entry.value));
}

async function readSaved(store: KeyValueStore): Promise<SavedCrew[]> {
  return (await store.list(SAVED_CREW_PREFIX)).map((entry) => SavedCrew.parse(entry.value));
}

async function requireSaved(store: KeyValueStore, commandId: string, id: string) {
  const stored = await store.get(`${SAVED_CREW_PREFIX}${id}`);
  if (stored === undefined) {
    throw new CommandError('invalid_input', commandId, `No saved crew "${id}".`, {
      details: [
        `id: saved crews are ${
          (await readSaved(store)).map((crew) => `${crew.id} (${crew.name})`).join(', ') || 'none'
        }`,
      ],
    });
  }
  return SavedCrew.parse(stored);
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/**
 * Saved crews: the current crew kept under a name, to bring back later in any
 * project. Agents save and load them with the same commands the library uses.
 */
export function createSavedCrewCommands(roles: RoleCatalog): readonly Command[] {
  const list = defineCommand({
    id: 'crew.saved.list',
    title: 'List saved crews',
    description:
      'Returns the crews saved under a name, with who is on each. They belong to the workspace, so every project can load them.',
    effect: 'read',
    input: z.object({ query: z.string().default('').describe('Words to look for in names.') }),
    output: z.object({ crews: z.array(Summary) }),
    handler: async ({ runtime }, { query }) => {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const crews = (await readSaved(runtime.store))
        .filter((crew) => {
          const haystack = [crew.name, crew.notes, ...crew.members.map((m) => m.name)]
            .join(' ')
            .toLowerCase();
          return words.every((word) => haystack.includes(word));
        })
        .sort(byName);
      return {
        crews: crews.map(({ id, name, notes, updatedAt, members }) => ({
          id,
          name,
          notes,
          updatedAt,
          members: members.map(({ roleId, name: member, model }) => ({
            roleId,
            name: member,
            model,
          })),
        })),
      };
    },
  });

  const get = defineCommand({
    id: 'crew.saved.get',
    title: 'Read saved crew',
    description:
      'Returns one saved crew whole: each agent with role, model, budget and web search.',
    effect: 'read',
    input: z.object({ id: z.string() }),
    output: SavedCrew,
    handler: async ({ runtime }, { id }) => requireSaved(runtime.store, 'crew.saved.get', id),
  });

  const save = defineCommand({
    id: 'crew.saved.save',
    title: 'Save the crew',
    description:
      'Saves everyone on the current crew under a name: role, name, model, budget and web search, plus the custom roles they hold. Pass the id of a saved crew to overwrite it with the current crew. Conversations are not saved.',
    effect: 'write',
    input: z.object({
      name: z.string().trim().min(1).optional().describe('Required for a new saved crew.'),
      id: z.string().optional().describe('A saved crew to overwrite, from crew.saved.list.'),
      notes: z.string().optional().describe('What this crew is good for.'),
    }),
    output: SavedCrew,
    handler: async ({ runtime }, input) => {
      const id = 'crew.saved.save';
      const previous =
        input.id === undefined ? undefined : await requireSaved(runtime.store, id, input.id);
      const name = input.name ?? previous?.name;
      if (name === undefined) {
        throw new CommandError('invalid_input', id, 'Give the crew a name.');
      }
      const crew = await readCrew(runtime.store);
      if (crew.length === 0) {
        throw new CommandError('invalid_input', id, 'The crew is empty. Hire someone first.');
      }
      const customIds = new Set(crew.map((member) => member.roleId));
      const custom: StoredRole[] = [];
      for (const roleId of customIds) {
        if (roles.get(roleId) !== undefined) continue;
        const stored = await runtime.store.get(`${CUSTOM_ROLE_PREFIX}${roleId}`);
        if (stored !== undefined) custom.push(StoredRole.parse(stored));
      }
      const now = runtime.now().toISOString();
      const saved: SavedCrew = {
        id: previous?.id ?? runtime.newId(),
        name,
        notes: input.notes ?? previous?.notes ?? '',
        members: [...crew]
          .sort((a, b) => a.hiredAt.localeCompare(b.hiredAt))
          .map(({ roleId, name: member, model, budgetUsdPerRun, webSearch }) => ({
            roleId,
            name: member,
            model,
            budgetUsdPerRun,
            webSearch,
          })),
        roles: custom,
        savedAt: previous?.savedAt ?? now,
        updatedAt: now,
      };
      await runtime.store.batch([
        { type: 'put', key: `${SAVED_CREW_PREFIX}${saved.id}`, value: saved },
      ]);
      return saved;
    },
  });

  const load = defineCommand({
    id: 'crew.saved.load',
    title: 'Load a saved crew',
    description:
      'Hires the agents of a saved crew. With replace true (the default) the current agents are dismissed first, with their conversations; the coordinator always stays. With replace false they join the current crew. Custom roles the crew needs are brought back if they were deleted.',
    effect: 'write',
    input: z.object({
      id: z.string().describe('A saved crew id from crew.saved.list.'),
      replace: z.boolean().default(true),
    }),
    output: z.object({
      hired: z.array(CrewMember),
      dismissed: z.array(z.string()).describe('Names of the agents that were dismissed.'),
      rolesRestored: z.array(z.string()),
    }),
    handler: async ({ runtime }, { id, replace }) => {
      const saved = await requireSaved(runtime.store, 'crew.saved.load', id);
      const current = await readCrew(runtime.store);
      const leaving = replace ? current.filter((member) => member.roleId !== COORDINATOR) : [];
      const staying = current.filter((member) => !leaving.includes(member));
      const hasCoordinator = staying.some((member) => member.roleId === COORDINATOR);
      const rolesRestored: StoredRole[] = [];
      for (const role of saved.roles) {
        if ((await roles.find(runtime.store, role.id)) === undefined) rolesRestored.push(role);
      }
      const hired: CrewMember[] = [];
      for (const member of saved.members) {
        if (member.roleId === COORDINATOR && hasCoordinator) continue;
        const known =
          rolesRestored.some((role) => role.id === member.roleId) ||
          (await roles.find(runtime.store, member.roleId)) !== undefined;
        if (!known) {
          throw new CommandError(
            'invalid_input',
            'crew.saved.load',
            `The role "${member.roleId}" of ${member.name} no longer exists.`,
          );
        }
        hired.push({
          ...member,
          id: runtime.newId(),
          hiredAt: runtime.now().toISOString(),
        });
      }
      await runtime.store.batch([
        ...leaving.map((member) => ({
          type: 'delete' as const,
          key: `${CREW_PREFIX}${member.id}`,
        })),
        ...(await forgetConversations(
          runtime.store,
          leaving.map((member) => member.id),
        )),
        ...rolesRestored.map((role) => ({
          type: 'put' as const,
          key: `${CUSTOM_ROLE_PREFIX}${role.id}`,
          value: role,
        })),
        ...hired.map((member) => ({
          type: 'put' as const,
          key: `${CREW_PREFIX}${member.id}`,
          value: member,
        })),
      ]);
      return {
        hired,
        dismissed: leaving.map((member) => member.name),
        rolesRestored: rolesRestored.map((role) => role.id),
      };
    },
  });

  const update = defineCommand({
    id: 'crew.saved.update',
    title: 'Rename saved crew',
    description:
      'Changes the name or notes of a saved crew. To change who is on it, use crew.saved.save with its id.',
    effect: 'write',
    input: z.object({
      id: z.string(),
      name: z.string().trim().min(1).optional(),
      notes: z.string().optional(),
    }),
    output: SavedCrew,
    handler: async ({ runtime }, { id, name, notes }) => {
      const current = await requireSaved(runtime.store, 'crew.saved.update', id);
      const saved: SavedCrew = {
        ...current,
        name: name ?? current.name,
        notes: notes ?? current.notes,
        updatedAt: runtime.now().toISOString(),
      };
      await runtime.store.batch([{ type: 'put', key: `${SAVED_CREW_PREFIX}${id}`, value: saved }]);
      return saved;
    },
  });

  const remove = defineCommand({
    id: 'crew.saved.delete',
    title: 'Delete saved crew',
    description: 'Deletes a saved crew. The agents on the current crew are not touched.',
    effect: 'destructive',
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string() }),
    handler: async ({ runtime }, { id }) => {
      await requireSaved(runtime.store, 'crew.saved.delete', id);
      await runtime.store.batch([{ type: 'delete', key: `${SAVED_CREW_PREFIX}${id}` }]);
      return { id };
    },
  });

  return [list, get, save, load, update, remove];
}
