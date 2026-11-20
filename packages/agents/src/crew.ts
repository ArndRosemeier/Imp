import { CommandError, defineCommand, type Command, type KeyValueStore } from '@imp/core';
import { z } from 'zod';
import { CUSTOM_ROLE_PREFIX, ROLE_ID, StoredRole, type RoleCatalog } from './role.js';

const CREW_PREFIX = 'crew/';
/** Where the conversation with each crew member is kept, by member id. */
export const CONVERSATION_PREFIX = 'conversations/';

export const CrewMember = z.object({
  id: z.string(),
  roleId: z.string(),
  /** What the user calls this agent. Defaults to the role's name. */
  name: z.string().min(1),
  /** A model id from the provider's live catalog. */
  model: z.string().min(1),
  /** The most this agent may spend on a single run, in US dollars. */
  budgetUsdPerRun: z.number().positive(),
  /** Whether this agent can look things up on the web while it works. */
  webSearch: z.boolean().default(false),
  hiredAt: z.iso.datetime(),
});
export type CrewMember = z.infer<typeof CrewMember>;

const RoleSummary = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  /** True for a role defined while using the app, which can be changed and removed. */
  custom: z.boolean(),
});

const RoleFields = {
  name: z.string().min(1).describe('What the role is called, for example "Dialogue Polisher".'),
  summary: z.string().describe('One line shown when choosing whom to hire.'),
  brief: z
    .string()
    .min(1)
    .describe('The standing instructions the agent works under: what it does and how.'),
  commands: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      'What the role may use, as command ids or prefixes of them, for example "movie.scene." or "project.list".',
    ),
  effects: z
    .array(z.enum(['read', 'write', 'spend', 'destructive']))
    .min(1)
    .describe(
      'Which kinds of command the role may use. Spending and destroying are still put to the user first.',
    ),
  webSearch: z
    .boolean()
    .describe(
      'Whether agents in this role can search the web, for research, fact checks or references. Each search costs about a cent.',
    ),
};

const toSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[-0-9]+|-+$/g, '');

export interface CrewCommandOptions {
  /** The ids of the commands that exist, so a role is not given ones that do not. */
  readonly commandIds?: () => readonly string[];
}

export async function readCrewMember(
  store: KeyValueStore,
  id: string,
): Promise<CrewMember | undefined> {
  const value = await store.get(`${CREW_PREFIX}${id}`);
  return value === undefined ? undefined : CrewMember.parse(value);
}

/**
 * Hiring is a set of ordinary commands, so the coordinator builds a crew the
 * same way a person does.
 */
export function createCrewCommands(
  roles: RoleCatalog,
  options: CrewCommandOptions = {},
): readonly Command[] {
  function checkCommands(commandId: string, commands: readonly string[]): void {
    const known = options.commandIds?.();
    if (known === undefined) return;
    const unknown = commands.filter((prefix) => !known.some((id) => id.startsWith(prefix)));
    if (unknown.length > 0) {
      throw new CommandError(
        'invalid_input',
        commandId,
        `No command starts with ${unknown.map((prefix) => `"${prefix}"`).join(', ')}.`,
        { details: [`commands: the existing commands are ${known.join(', ')}`] },
      );
    }
  }

  async function requireCustom(store: KeyValueStore, commandId: string, id: string) {
    const stored = await store.get(`${CUSTOM_ROLE_PREFIX}${id}`);
    if (stored === undefined || roles.get(id) !== undefined) {
      throw new CommandError(
        'invalid_input',
        commandId,
        roles.get(id) === undefined
          ? `No custom role "${id}".`
          : `"${id}" is a built-in role and cannot be changed.`,
      );
    }
    return StoredRole.parse(stored);
  }

  const roleList = defineCommand({
    id: 'crew.roles',
    title: 'List roles',
    description: 'Returns the roles an agent can be hired for, with what each one does.',
    effect: 'read',
    input: z.object({}),
    output: z.object({ roles: z.array(RoleSummary) }),
    handler: async ({ runtime }) => ({
      roles: (await roles.all(runtime.store)).map(({ id, name, summary, custom }) => ({
        id,
        name,
        summary,
        custom,
      })),
    }),
  });

  const roleGet = defineCommand({
    id: 'crew.role.get',
    title: 'Read role',
    description: 'Returns one role with its instructions and what it may use.',
    effect: 'read',
    input: z.object({ id: z.string() }),
    output: RoleSummary.extend({
      brief: z.string(),
      commands: z.array(z.string()),
      effects: z.array(z.string()),
      webSearch: z.boolean(),
    }),
    handler: async ({ runtime }, { id }) => {
      const role = (await roles.all(runtime.store)).find((candidate) => candidate.id === id);
      if (role === undefined) {
        throw new CommandError('invalid_input', 'crew.role.get', `Unknown role "${id}".`);
      }
      return {
        id: role.id,
        name: role.name,
        summary: role.summary,
        custom: role.custom,
        brief: role.brief,
        commands: [...(role.scope.prefixes ?? [''])],
        effects: [...(role.scope.effects ?? ['read', 'write', 'spend', 'destructive'])],
        webSearch: role.webSearch ?? false,
      };
    },
  });

  const roleCreate = defineCommand({
    id: 'crew.role.create',
    title: 'Create role',
    description:
      'Defines a new role an agent can be hired for: its instructions and the commands it may use. Hire for it with crew.hire.',
    effect: 'write',
    input: z.object({
      ...RoleFields,
      id: z
        .string()
        .regex(ROLE_ID)
        .optional()
        .describe('Lower-case and dashed. Defaults to the name in that form.'),
      summary: RoleFields.summary.default(''),
      effects: RoleFields.effects.default(['read', 'write']),
      webSearch: RoleFields.webSearch.default(false),
    }),
    output: StoredRole,
    handler: async ({ runtime }, input) => {
      const id = input.id ?? toSlug(input.name);
      if (!ROLE_ID.test(id)) {
        throw new CommandError(
          'invalid_input',
          'crew.role.create',
          `"${input.name}" does not give a usable id. Pass an id.`,
        );
      }
      if ((await roles.find(runtime.store, id)) !== undefined) {
        throw new CommandError('invalid_input', 'crew.role.create', `Role "${id}" already exists.`);
      }
      checkCommands('crew.role.create', input.commands);
      const role: StoredRole = {
        id,
        name: input.name,
        summary: input.summary,
        brief: input.brief,
        scope: { prefixes: input.commands, effects: input.effects },
        webSearch: input.webSearch,
      };
      await runtime.store.batch([{ type: 'put', key: `${CUSTOM_ROLE_PREFIX}${id}`, value: role }]);
      return role;
    },
  });

  const roleUpdate = defineCommand({
    id: 'crew.role.update',
    title: 'Change role',
    description:
      'Changes a custom role. Fields left out stay as they are. Agents already hired for it work under the new version from their next task.',
    effect: 'write',
    input: z.object(RoleFields).partial().extend({ id: z.string() }),
    output: StoredRole,
    handler: async ({ runtime }, { id, ...changes }) => {
      const current = await requireCustom(runtime.store, 'crew.role.update', id);
      if (changes.commands !== undefined) checkCommands('crew.role.update', changes.commands);
      const role: StoredRole = {
        id,
        name: changes.name ?? current.name,
        summary: changes.summary ?? current.summary,
        brief: changes.brief ?? current.brief,
        scope: {
          prefixes: changes.commands ?? current.scope.prefixes,
          effects: changes.effects ?? current.scope.effects,
        },
        webSearch: changes.webSearch ?? current.webSearch,
      };
      await runtime.store.batch([{ type: 'put', key: `${CUSTOM_ROLE_PREFIX}${id}`, value: role }]);
      return role;
    },
  });

  const roleDelete = defineCommand({
    id: 'crew.role.delete',
    title: 'Delete role',
    description: 'Removes a custom role. Refused while an agent is hired for it.',
    effect: 'destructive',
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string() }),
    handler: async ({ runtime }, { id }) => {
      await requireCustom(runtime.store, 'crew.role.delete', id);
      const holders = (await runtime.store.list(CREW_PREFIX))
        .map((entry) => CrewMember.parse(entry.value))
        .filter((member) => member.roleId === id);
      if (holders.length > 0) {
        throw new CommandError(
          'invalid_input',
          'crew.role.delete',
          `Dismiss ${holders.map((member) => member.name).join(', ')} first.`,
        );
      }
      await runtime.store.batch([{ type: 'delete', key: `${CUSTOM_ROLE_PREFIX}${id}` }]);
      return { id };
    },
  });

  const hire = defineCommand({
    id: 'crew.hire',
    title: 'Hire agent',
    description:
      'Adds an agent to the crew in the given role, running on the given model. Returns the new crew member.',
    effect: 'write',
    input: z.object({
      roleId: z.string().describe('A role id from crew.roles.'),
      model: z.string().min(1).describe('A model id from the provider catalog.'),
      name: z.string().min(1).optional().describe('Display name. Defaults to the role name.'),
      budgetUsdPerRun: z.number().positive().default(1),
      webSearch: z
        .boolean()
        .optional()
        .describe(
          'Whether the agent can search the web while it works. Defaults to what the role says.',
        ),
    }),
    output: CrewMember,
    handler: async ({ runtime }, input) => {
      const role = await roles.find(runtime.store, input.roleId);
      if (role === undefined) {
        throw new CommandError('invalid_input', 'crew.hire', `Unknown role "${input.roleId}".`, {
          details: [
            `roleId: must be one of ${(await roles.all(runtime.store))
              .map((r) => r.id)
              .join(', ')}`,
          ],
        });
      }
      const member: CrewMember = {
        id: runtime.newId(),
        roleId: role.id,
        name: input.name ?? role.name,
        model: input.model,
        budgetUsdPerRun: input.budgetUsdPerRun,
        webSearch: input.webSearch ?? role.webSearch ?? false,
        hiredAt: runtime.now().toISOString(),
      };
      await runtime.store.batch([
        { type: 'put', key: `${CREW_PREFIX}${member.id}`, value: member },
      ]);
      return member;
    },
  });

  const update = defineCommand({
    id: 'crew.update',
    title: 'Change agent',
    description:
      'Changes an agent on the crew: its name, model, budget per run, or whether it can search the web. Fields left out stay as they are. The conversation with it is kept.',
    effect: 'write',
    input: z.object({
      id: z.string().describe('A crew member id from crew.list.'),
      name: z.string().min(1).optional(),
      model: z.string().min(1).optional().describe('A model id from models.list.'),
      budgetUsdPerRun: z.number().positive().optional(),
      webSearch: z.boolean().optional(),
    }),
    output: CrewMember,
    handler: async ({ runtime }, { id, ...changes }) => {
      const current = await readCrewMember(runtime.store, id);
      if (current === undefined) {
        throw new CommandError('invalid_input', 'crew.update', `No crew member "${id}".`);
      }
      const member: CrewMember = {
        ...current,
        name: changes.name ?? current.name,
        model: changes.model ?? current.model,
        budgetUsdPerRun: changes.budgetUsdPerRun ?? current.budgetUsdPerRun,
        webSearch: changes.webSearch ?? current.webSearch,
      };
      await runtime.store.batch([{ type: 'put', key: `${CREW_PREFIX}${id}`, value: member }]);
      return member;
    },
  });

  const list = defineCommand({
    id: 'crew.list',
    title: 'List crew',
    description: 'Returns every agent currently on the crew, with role, model and budget.',
    effect: 'read',
    input: z.object({}),
    output: z.object({ crew: z.array(CrewMember) }),
    handler: async ({ runtime }) => ({
      crew: (await runtime.store.list(CREW_PREFIX)).map((entry) => CrewMember.parse(entry.value)),
    }),
  });

  const dismiss = defineCommand({
    id: 'crew.dismiss',
    title: 'Dismiss agent',
    description:
      'Removes an agent from the crew, with the conversation held with it. Work the agent produced is kept.',
    effect: 'write',
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string(), dismissed: z.boolean() }),
    handler: async ({ runtime }, { id }) => {
      const existed = (await readCrewMember(runtime.store, id)) !== undefined;
      await runtime.store.batch([
        { type: 'delete', key: `${CREW_PREFIX}${id}` },
        { type: 'delete', key: `${CONVERSATION_PREFIX}${id}` },
      ]);
      return { id, dismissed: existed };
    },
  });

  return [roleList, roleGet, roleCreate, roleUpdate, roleDelete, hire, update, list, dismiss];
}
