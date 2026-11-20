import { CommandError, defineCommand, type Command, type KeyValueStore } from '@imp/core';
import { z } from 'zod';
import type { RoleCatalog } from './role.js';

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
  hiredAt: z.iso.datetime(),
});
export type CrewMember = z.infer<typeof CrewMember>;

const RoleSummary = z.object({ id: z.string(), name: z.string(), summary: z.string() });

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
export function createCrewCommands(roles: RoleCatalog): readonly Command[] {
  const roleList = defineCommand({
    id: 'crew.roles',
    title: 'List roles',
    description: 'Returns the roles an agent can be hired for, with what each one does.',
    effect: 'read',
    input: z.object({}),
    output: z.object({ roles: z.array(RoleSummary) }),
    handler: () =>
      Promise.resolve({
        roles: roles.list().map(({ id, name, summary }) => ({ id, name, summary })),
      }),
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
    }),
    output: CrewMember,
    handler: async ({ runtime }, input) => {
      const role = roles.get(input.roleId);
      if (role === undefined) {
        throw new CommandError('invalid_input', 'crew.hire', `Unknown role "${input.roleId}".`, {
          details: [
            `roleId: must be one of ${roles
              .list()
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
        hiredAt: runtime.now().toISOString(),
      };
      await runtime.store.batch([
        { type: 'put', key: `${CREW_PREFIX}${member.id}`, value: member },
      ]);
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
    description: 'Removes an agent from the crew. Work the agent already produced is kept.',
    effect: 'write',
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string(), dismissed: z.boolean() }),
    handler: async ({ runtime }, { id }) => {
      const existed = (await readCrewMember(runtime.store, id)) !== undefined;
      await runtime.store.batch([{ type: 'delete', key: `${CREW_PREFIX}${id}` }]);
      return { id, dismissed: existed };
    },
  });

  return [roleList, hire, list, dismiss];
}
