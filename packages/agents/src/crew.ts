import { CommandError, defineCommand, type Command, type KeyValueStore, patchOf } from '@imp/core';
import type { ModelInfo } from '@imp/providers';
import { z } from 'zod';
import { forgetConversations } from './conversations.js';
import {
  ADDED_ROLE_PREFIX,
  GLOBAL_COORDINATOR_ROLE,
  CUSTOM_ROLE_PREFIX,
  modelNeedsOf,
  modelProblem,
  ROLE_ID,
  SEEN_KINDS,
  StoredNeed,
  StoredRole,
  type Role,
  type RoleCatalog,
} from './role.js';

const CREW_PREFIX = 'crew/';

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
  /** Present for an extra built-in role that was added, which crew.role.remove puts away. */
  extra: z.literal(true).optional(),
  /** What its model must take besides text; empty when a text-only model is enough. */
  modelInput: z.array(z.string()),
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
      'What the role may read and use, as command ids or prefixes of them, for example "movie." or "project.list". Give it what it needs to read for context.',
    ),
  writes: z
    .array(z.string().min(1))
    .describe(
      'What the role may change, create, spend on or delete: only its own area, as command ids or prefixes, for example ["movie.scene.update"] for a dialogue polisher. Empty for a role that only reads. Work that belongs to another role stays with that role.',
    ),
  sees: z
    .array(z.enum(SEEN_KINDS))
    .describe(
      'What the role must be shown besides text to do its work: "image" for judging pictures, "audio" for listening, "video" for watching clips. Empty for a role that works from text alone, such as writing, so that a model that takes only text is enough. Only models that take all of these can be hired for it.',
    ),
  needs: z
    .array(StoredNeed)
    .describe(
      'What the role needs before it can work, such as a cast or written scenes, with the role that provides each. The coordinator checks these with crew.needs before it gives the role a task. Reuse the ids other roles use for the same thing (crew.needs lists them).',
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

/** A role reads at least what it may write; what it writes is held to `writes`. */
function readsWhatItWrites(
  commands: readonly string[],
  writes: readonly string[],
  effects: StoredRole['scope']['effects'],
): StoredRole['scope'] {
  const prefixes = [...commands];
  for (const prefix of writes) {
    if (!prefixes.some((read) => prefix.startsWith(read))) prefixes.push(prefix);
  }
  return { prefixes, writes: [...writes], effects };
}

const toSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[-0-9]+|-+$/g, '');

export interface CrewCommandOptions {
  /** The ids of the commands that exist, so a role is not given ones that do not. */
  readonly commandIds?: () => readonly string[];
  /** The live model catalog, so that a role gets only a model that can do its work. */
  readonly models?: () => Promise<readonly ModelInfo[]>;
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

  /**
   * Refuses a model that cannot do the role's work: one without tool calling,
   * or one that cannot take the input the role must see. A model the catalog
   * does not know, or a catalog that cannot be reached, is let through.
   */
  async function checkModel(commandId: string, role: Role, modelId: string): Promise<void> {
    let catalog: readonly ModelInfo[];
    try {
      catalog = (await options.models?.()) ?? [];
    } catch {
      return;
    }
    const model = catalog.find(({ id }) => id === modelId);
    if (model === undefined) return;
    const problem = modelProblem(role, model);
    if (problem !== null) {
      throw new CommandError('invalid_input', commandId, problem, {
        details: [
          `model: pick one from models.list with role "${role.id}", which lists only the models that fit`,
        ],
      });
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
    description:
      'Returns the roles an agent can be hired for, with what each one does, and the extra built-in roles (such as a critic) that are not offered until added with crew.role.add.',
    effect: 'read',
    input: z.object({}),
    output: z.object({
      roles: z.array(RoleSummary),
      extras: z
        .array(z.object({ id: z.string(), name: z.string(), summary: z.string() }))
        .describe('Built-in roles not offered for hire yet; crew.role.add offers one.'),
    }),
    handler: async ({ runtime }) => ({
      roles: (await roles.all(runtime.store)).map((role) => ({
        id: role.id,
        name: role.name,
        summary: role.summary,
        custom: role.custom,
        ...(role.optional === true ? { extra: true as const } : {}),
        modelInput: [...modelNeedsOf(role).input],
      })),
      extras: (await roles.extras(runtime.store)).map(({ id, name, summary }) => ({
        id,
        name,
        summary,
      })),
    }),
  });

  function requireExtra(commandId: string, id: string) {
    const role = roles.get(id);
    if (role?.optional !== true) {
      throw new CommandError(
        'invalid_input',
        commandId,
        role === undefined
          ? `No built-in role "${id}".`
          : `"${id}" is always offered; only extra roles are added and put away.`,
        {
          details: [
            `id: the extra roles are ${roles
              .list()
              .filter((candidate) => candidate.optional === true)
              .map((candidate) => candidate.id)
              .join(', ')}`,
          ],
        },
      );
    }
    return role;
  }

  const roleAdd = defineCommand({
    id: 'crew.role.add',
    title: 'Add a role',
    description:
      'Offers one of the extra built-in roles (listed under extras by crew.roles, such as the critic) for hire in this workspace. It does not hire anyone; crew.hire does.',
    effect: 'write',
    input: z.object({ id: z.string().describe('A role id from the extras of crew.roles.') }),
    output: z.object({ id: z.string(), name: z.string() }),
    handler: async ({ runtime }, { id }) => {
      const role = requireExtra('crew.role.add', id);
      await runtime.store.batch([{ type: 'put', key: `${ADDED_ROLE_PREFIX}${id}`, value: true }]);
      return { id, name: role.name };
    },
  });

  const roleRemove = defineCommand({
    id: 'crew.role.remove',
    title: 'Put a role away',
    description:
      'Stops offering an extra built-in role for hire, as it was before it was added. Refused while an agent is hired for it.',
    effect: 'write',
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string() }),
    handler: async ({ runtime }, { id }) => {
      requireExtra('crew.role.remove', id);
      const holders = (await runtime.store.list(CREW_PREFIX))
        .map((entry) => CrewMember.parse(entry.value))
        .filter((member) => member.roleId === id);
      if (holders.length > 0) {
        throw new CommandError(
          'invalid_input',
          'crew.role.remove',
          `Dismiss ${holders.map((member) => member.name).join(', ')} first.`,
        );
      }
      await runtime.store.batch([{ type: 'delete', key: `${ADDED_ROLE_PREFIX}${id}` }]);
      return { id };
    },
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
      writes: z
        .array(z.string())
        .describe('What it may change, create, spend on or delete: its own area.'),
      effects: z.array(z.string()),
      webSearch: z.boolean(),
      sees: z
        .array(z.string())
        .nullable()
        .describe('What it is shown besides text; null for whatever its model takes.'),
      model: z
        .object({ tools: z.literal(true), input: z.array(z.string()) })
        .describe('What a model needs to be hired for it: tool calling, and these inputs.'),
      needs: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          providedBy: z.string().nullable(),
          before: z.array(z.string()).nullable(),
        }),
      ),
    }),
    handler: async ({ runtime }, { id }) => {
      // Extra roles can be read before they are added, to decide whether to add them.
      const role =
        (await roles.all(runtime.store)).find((candidate) => candidate.id === id) ??
        (await roles.extras(runtime.store))
          .filter((candidate) => candidate.id === id)
          .map((candidate) => ({ ...candidate, custom: false }))[0];
      if (role === undefined) {
        throw new CommandError('invalid_input', 'crew.role.get', `Unknown role "${id}".`);
      }
      return {
        id: role.id,
        name: role.name,
        summary: role.summary,
        custom: role.custom,
        modelInput: [...modelNeedsOf(role).input],
        brief: role.brief,
        commands: [...(role.scope.prefixes ?? [''])],
        writes: [...(role.scope.writes ?? role.scope.prefixes ?? [''])],
        effects: [...(role.scope.effects ?? ['read', 'write', 'spend', 'destructive'])],
        webSearch: role.webSearch ?? false,
        sees: role.sees === undefined ? null : [...role.sees],
        model: { tools: true as const, input: [...modelNeedsOf(role).input] },
        needs: (role.needs ?? []).map((need) => ({
          id: need.id,
          name: need.name,
          description: need.description,
          providedBy: need.providedBy ?? null,
          before: need.before === undefined ? null : [...need.before],
        })),
      };
    },
  });

  const roleCreate = defineCommand({
    id: 'crew.role.create',
    keywords: ['custom role', 'new job', 'critic', 'advisor', 'reviewer', 'specialist'],
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
      needs: RoleFields.needs.default([]),
      sees: RoleFields.sees.default([]),
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
      checkCommands('crew.role.create', input.writes);
      const role: StoredRole = {
        id,
        name: input.name,
        summary: input.summary,
        brief: input.brief,
        scope: readsWhatItWrites(input.commands, input.writes, input.effects),
        webSearch: input.webSearch,
        needs: input.needs,
        sees: input.sees,
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
    input: patchOf(z.object(RoleFields)).extend({ id: z.string() }),
    output: StoredRole,
    handler: async ({ runtime }, { id, ...changes }) => {
      const current = await requireCustom(runtime.store, 'crew.role.update', id);
      if (changes.commands !== undefined) checkCommands('crew.role.update', changes.commands);
      if (changes.writes !== undefined) checkCommands('crew.role.update', changes.writes);
      const role: StoredRole = {
        id,
        name: changes.name ?? current.name,
        summary: changes.summary ?? current.summary,
        brief: changes.brief ?? current.brief,
        scope: readsWhatItWrites(
          changes.commands ?? current.scope.prefixes,
          // A role stored before roles were kept to an area wrote wherever it read.
          changes.writes ?? current.scope.writes ?? current.scope.prefixes,
          changes.effects ?? current.scope.effects,
        ),
        webSearch: changes.webSearch ?? current.webSearch,
        needs: changes.needs ?? current.needs,
        sees: changes.sees ?? current.sees,
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
      await checkModel('crew.hire', role, input.model);
      if (role.id === GLOBAL_COORDINATOR_ROLE) {
        const existing = (await runtime.store.list(CREW_PREFIX)).find(
          (entry) =>
            (entry.value as { roleId?: unknown } | null)?.roleId === GLOBAL_COORDINATOR_ROLE,
        );
        if (existing !== undefined) {
          throw new CommandError(
            'invalid_input',
            'crew.hire',
            'There is already an Imp coordinator: one looks after all projects. Change it with crew.update.',
          );
        }
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
        // Hiring for an extra role adds it, so it stays offered after a dismissal.
        ...(role.optional === true
          ? [{ type: 'put' as const, key: `${ADDED_ROLE_PREFIX}${role.id}`, value: true }]
          : []),
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
      if (changes.model !== undefined && changes.model !== current.model) {
        const role = await roles.find(runtime.store, current.roleId);
        if (role !== undefined) await checkModel('crew.update', role, changes.model);
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
      'Removes an agent from the crew, with the conversations held with it in every project. Work the agent produced is kept.',
    effect: 'write',
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string(), dismissed: z.boolean() }),
    handler: async ({ runtime }, { id }) => {
      const current = await readCrewMember(runtime.store, id);
      if (current?.roleId === GLOBAL_COORDINATOR_ROLE) {
        throw new CommandError(
          'invalid_input',
          'crew.dismiss',
          'The Imp coordinator looks after all projects and stays on the crew. Change its model or budget with crew.update.',
        );
      }
      const existed = current !== undefined;
      await runtime.store.batch([
        { type: 'delete', key: `${CREW_PREFIX}${id}` },
        ...(await forgetConversations(runtime.store, [id])),
      ]);
      return { id, dismissed: existed };
    },
  });

  return [
    roleList,
    roleGet,
    roleCreate,
    roleUpdate,
    roleDelete,
    roleAdd,
    roleRemove,
    hire,
    update,
    list,
    dismiss,
  ];
}
