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
  /**
   * Prefixes of the commands handed to the model as tools from the start.
   * Everything else in scope stays reachable, but the agent looks it up when
   * it needs it, so a wide scope does not cost context on every request.
   * Left out, every command in scope is a tool.
   */
  readonly direct?: readonly string[];
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
    'setup and organisation yourself: adjust settings, see which roles exist, and hire crew',
    'members for the work. Give specialised work to the crew member whose role it is with',
    'crew.ask, in one task that says everything they need, and pass on what they report.',
    'Giving a task costs money, so the user is asked to approve it first. Prefer doing over',
    "asking, and ask only when a choice is truly the user's. Be brief and concrete.",
  ].join(' '),
  // Spending is in scope so that it can be asked for; the policy still puts it to the user.
  scope: { effects: ['read', 'write', 'spend'] },
  direct: ['crew.', 'project.', 'settings.'],
};
