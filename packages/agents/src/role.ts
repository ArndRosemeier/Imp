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
