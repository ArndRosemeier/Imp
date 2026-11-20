import type { KeyValueStore, ToolScope } from '@imp/core';
import { z } from 'zod';

/**
 * A job an agent can be hired for. Modes contribute roles; the user or the
 * coordinator hires a crew member into one.
 */
export interface Role {
  /** Lower-case and dashed: `screenwriter`, `casting-director`. */
  readonly id: string;
  readonly name: string;
  /** One line shown when choosing whom to hire. */
  readonly summary: string;
  /** The standing instructions the agent works under. */
  readonly brief: string;
  /** The commands this role may call. An agent cannot act outside it. */
  readonly scope: ToolScope;
  /**
   * Prefixes of the commands handed to the model as tools from the start.
   * Everything else in scope stays reachable, but the agent looks it up when
   * it needs it, so a wide scope does not cost context on every request.
   * Left out, every command in scope is a tool.
   */
  readonly direct?: readonly string[];
}

export const ROLE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Where the roles defined while using the app are kept, by role id. */
export const CUSTOM_ROLE_PREFIX = 'roles/';

/** A role as stored data. Built-in roles come from code and are never stored. */
export const StoredRole = z.object({
  id: z.string().regex(ROLE_ID),
  name: z.string().min(1),
  summary: z.string(),
  brief: z.string().min(1),
  scope: z.object({
    effects: z.array(z.enum(['read', 'write', 'spend', 'destructive'])).min(1),
    prefixes: z.array(z.string().min(1)).min(1),
  }),
});
export type StoredRole = z.infer<typeof StoredRole>;

function toRole(stored: StoredRole): Role {
  return {
    id: stored.id,
    name: stored.name,
    summary: stored.summary,
    brief: stored.brief,
    scope: { prefixes: stored.scope.prefixes, effects: stored.scope.effects },
  };
}

/**
 * The roles available for hire: the ones the enabled modes contribute, fixed
 * at start-up, plus the ones people or agents define while using the app.
 */
export class RoleCatalog {
  readonly #roles = new Map<string, Role>();

  constructor(roles: readonly Role[] = []) {
    for (const role of roles) {
      if (!ROLE_ID.test(role.id)) {
        throw new TypeError(`Invalid role id: "${role.id}"`);
      }
      if (this.#roles.has(role.id)) {
        throw new TypeError(`Role "${role.id}" is defined twice.`);
      }
      this.#roles.set(role.id, role);
    }
  }

  get(id: string): Role | undefined {
    return this.#roles.get(id);
  }

  list(): readonly Role[] {
    return [...this.#roles.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** A built-in role, or one defined while using the app. Built-in ones win. */
  async find(store: KeyValueStore, id: string): Promise<Role | undefined> {
    const builtIn = this.#roles.get(id);
    if (builtIn !== undefined) return builtIn;
    const stored = await store.get(`${CUSTOM_ROLE_PREFIX}${id}`);
    return stored === undefined ? undefined : toRole(StoredRole.parse(stored));
  }

  /** Every role that can be hired for, sorted by id, with whether it is a custom one. */
  async all(store: KeyValueStore): Promise<readonly (Role & { readonly custom: boolean })[]> {
    const custom = (await store.list(CUSTOM_ROLE_PREFIX))
      .map((entry) => toRole(StoredRole.parse(entry.value)))
      .filter((role) => !this.#roles.has(role.id));
    return [
      ...this.list().map((role) => ({ ...role, custom: false })),
      ...custom.map((role) => ({ ...role, custom: true })),
    ].sort((a, b) => (a.id < b.id ? -1 : 1));
  }
}

/**
 * The agent the user talks to. It has no mechanism of its own: it plans and
 * delegates through the same commands a person uses. It reads and writes
 * freely, may ask to spend, and cannot destroy.
 */
export const coordinatorRole: Role = {
  id: 'coordinator',
  name: 'Coordinator',
  summary: 'Talks with you, plans the work, hires the crew and keeps things moving.',
  brief: [
    'You are the coordinator of this workspace. The user tells you what they want to make.',
    'Work out what is needed, look at the current state with the read tools, and carry out',
    'setup and organisation yourself: adjust settings, pick models from models.list (never',
    'guess a model id), see which roles exist, and hire crew',
    'members for the work. Give specialised work to the crew member whose role it is with',
    'crew.ask, in one task that says everything they need, and pass on what they report.',
    'Giving a task costs money, so the user is asked to approve it first. Prefer doing over',
    "asking, and ask only when a choice is truly the user's. Be brief and concrete.",
  ].join(' '),
  // Spending is in scope so that it can be asked for; the policy still puts it to the user.
  scope: { effects: ['read', 'write', 'spend'] },
  direct: ['crew.', 'project.', 'settings.', 'models.'],
};
