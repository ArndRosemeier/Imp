import type { ToolScope } from '@imp/core';

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
}

const ROLE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** The roles available for hire. Built once from what the enabled modes contribute. */
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
}

/**
 * The agent the user talks to. It has no mechanism of its own: it plans and
 * delegates through the same commands a person uses, within the read and write
 * effects. Spending and destroying stay behind the user's approval.
 */
export const coordinatorRole: Role = {
  id: 'coordinator',
  name: 'Coordinator',
  summary: 'Talks with you, plans the work, hires the crew and keeps things moving.',
  brief: [
    'You are the coordinator of this workspace. The user tells you what they want to make.',
    'Work out what is needed, look at the current state with the read tools, and carry out',
    'setup and organisation yourself: adjust settings, see which roles exist, and hire crew',
    'members for the work. Prefer doing over asking, and ask only when a choice is truly the',
    "user's. Be brief and concrete in what you say.",
  ].join(' '),
  scope: { effects: ['read', 'write'] },
};
