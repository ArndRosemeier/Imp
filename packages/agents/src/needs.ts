import {
  CommandError,
  defineCommand,
  projectPrefix,
  type Command,
  type KeyValueStore,
} from '@imp/core';
import { z } from 'zod';
import { currentConversationProject } from './conversations.js';
import type { Need, Role, RoleCatalog } from './role.js';

/** Where a project keeps the needs it goes without, with why. It is copied along with the project. */
export const waivedNeedsKey = (projectId: string): string =>
  `${projectPrefix(projectId)}crew-needs`;

const Waived = z.object({ waived: z.record(z.string(), z.string()) });

export async function readWaivedNeeds(
  store: KeyValueStore,
  projectId: string,
): Promise<Record<string, string>> {
  const parsed = Waived.safeParse(await store.get(waivedNeedsKey(projectId)));
  return parsed.success ? parsed.data.waived : {};
}

export const NeedState = z.enum(['met', 'missing', 'waived', 'unchecked']);
export type NeedState = z.infer<typeof NeedState>;

export const NeedStatus = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  providedBy: z.string().nullable().describe('The role whose work provides it.'),
  before: z
    .array(z.string())
    .nullable()
    .describe(
      'The commands it is needed for. Null when the role needs it for all of its work and cannot be given a task until it is there.',
    ),
  state: NeedState.describe(
    'met: it is there. missing: it is not, and the role cannot do the work that needs it. waived: this project goes without it. unchecked: Imp cannot check it; judge it from the project.',
  ),
  waivedBecause: z.string().nullable(),
});
export type NeedStatus = z.infer<typeof NeedStatus>;

/** Where each need of a role stands in a project. Outside any project nothing can be checked. */
export async function needStatus(
  store: KeyValueStore,
  role: Role,
  projectId: string | null,
): Promise<NeedStatus[]> {
  const waived = projectId === null ? {} : await readWaivedNeeds(store, projectId);
  return Promise.all(
    (role.needs ?? []).map(async (need: Need): Promise<NeedStatus> => {
      const because = waived[need.id];
      const state: NeedState =
        because !== undefined
          ? 'waived'
          : need.check === undefined || projectId === null
            ? 'unchecked'
            : (await need.check(store, projectId))
              ? 'met'
              : 'missing';
      return {
        id: need.id,
        name: need.name,
        description: need.description,
        providedBy: need.providedBy ?? null,
        before: need.before === undefined ? null : [...need.before],
        state,
        waivedBecause: because ?? null,
      };
    }),
  );
}

/** "A cast (from the Casting Director)", for messages. */
export function describeNeed(need: NeedStatus, roleName: (id: string) => string): string {
  return need.providedBy === null
    ? need.name
    : `${need.name} (made by the ${roleName(need.providedBy)})`;
}

/**
 * The note a crew member gets with its task about what it needs: what is
 * there, what is missing, and what to do when something is missing.
 */
export function needsNote(
  statuses: readonly NeedStatus[],
  roleName: (id: string) => string,
): string | undefined {
  if (statuses.length === 0) return undefined;
  const lines = statuses.map((need) => {
    const state =
      need.state === 'waived'
        ? `this project goes without it${need.waivedBecause === '' ? '' : ` (${need.waivedBecause ?? ''})`}`
        : need.state === 'unchecked'
          ? 'check it yourself'
          : need.state;
    return `- ${describeNeed(need, roleName)}: ${state}`;
  });
  return [
    'What your work needs:',
    ...lines,
    'When something your task needs is missing, do not make it yourself and do not make it up: call report_missing and stop.',
  ].join('\n');
}

/**
 * Reading what a role needs and saying that a project goes without
 * something are commands too, so the coordinator checks before it gives a
 * task, and a person can see and do the same.
 */
export function createNeedCommands(roles: RoleCatalog): readonly Command[] {
  const list = defineCommand({
    id: 'crew.needs',
    keywords: ['prerequisites', 'requirements', 'ready', 'before tasking', 'missing'],
    title: 'Check what a role needs',
    description:
      'Returns what each role needs before it can work in the open project (for example a cast before the scenes are written), whether it is there, and which role makes it. Check it before giving a crew member a task, and have the role that makes a missing piece make it first.',
    effect: 'read',
    input: z.object({
      roleId: z.string().optional().describe('One role id from crew.roles. Left out, every role.'),
    }),
    output: z.object({
      projectId: z.string().nullable(),
      roles: z.array(
        z.object({
          roleId: z.string(),
          name: z.string(),
          ready: z.boolean().describe('False while a need it has for all of its work is missing.'),
          needs: z.array(NeedStatus),
        }),
      ),
    }),
    handler: async ({ runtime }, { roleId }) => {
      const { store } = runtime;
      const projectId = await currentConversationProject(store);
      const all = await roles.all(store);
      if (roleId !== undefined && all.every((role) => role.id !== roleId)) {
        throw new CommandError('invalid_input', 'crew.needs', `Unknown role "${roleId}".`, {
          details: [`roleId: must be one of ${all.map((role) => role.id).join(', ')}`],
        });
      }
      return {
        projectId,
        roles: await Promise.all(
          all
            .filter((role) => roleId === undefined || role.id === roleId)
            .map(async (role) => {
              const needs = await needStatus(store, role, projectId);
              return {
                roleId: role.id,
                name: role.name,
                ready: needs.every((need) => need.state !== 'missing' || need.before !== null),
                needs,
              };
            }),
        ),
      };
    },
  });

  const waive = defineCommand({
    id: 'crew.needs.waive',
    keywords: ['not needed', 'goes without', 'no cast', 'skip prerequisite'],
    title: 'Go without a need',
    description:
      'Says that the open project goes without something roles usually need, such as a cast for a film with no characters, so that no role waits for it. waived false takes it back.',
    effect: 'write',
    input: z.object({
      need: z.string().min(1).describe('A need id from crew.needs, such as "cast".'),
      reason: z.string().default('').describe('Why this project goes without it.'),
      waived: z.boolean().default(true),
    }),
    output: z.object({ projectId: z.string(), waived: z.record(z.string(), z.string()) }),
    handler: async ({ runtime }, { need, reason, waived }) => {
      const { store } = runtime;
      const projectId = await currentConversationProject(store);
      if (projectId === null) {
        throw new CommandError('invalid_input', 'crew.needs.waive', 'Open a project first.');
      }
      const known = new Set(
        (await roles.all(store)).flatMap((role) => (role.needs ?? []).map(({ id }) => id)),
      );
      if (!known.has(need)) {
        throw new CommandError('invalid_input', 'crew.needs.waive', `No role needs "${need}".`, {
          details: [`need: the needs are ${[...known].sort().join(', ')}`],
        });
      }
      const current = Object.fromEntries(
        Object.entries(await readWaivedNeeds(store, projectId)).filter(([id]) => id !== need),
      );
      if (waived) current[need] = reason;
      await store.batch([
        { type: 'put', key: waivedNeedsKey(projectId), value: { waived: current } },
      ]);
      return { projectId, waived: current };
    },
  });

  return [list, waive];
}

/** For messages: a function from role id to the role's name. */
export async function roleNames(
  roles: RoleCatalog,
  store: KeyValueStore,
): Promise<(id: string) => string> {
  const all = await roles.all(store);
  return (id) => all.find((role) => role.id === id)?.name ?? id;
}
