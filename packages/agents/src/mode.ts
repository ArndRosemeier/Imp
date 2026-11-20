import type { Command, ProjectSupport } from '@imp/core';
import type { Role } from './role.js';

/** One step of a mode's workflow, shown in the navigation. Stages can be visited in any order. */
export interface Stage {
  readonly id: string;
  readonly name: string;
}

/**
 * A working mode: everything one kind of creation adds to Imp. The core, the
 * crew, approvals and the activity log know nothing about any particular mode,
 * so adding one means adding a package that exports one of these.
 */
export interface Mode {
  /** Lower-case; also the `mode` of the projects made in it and the prefix of its command ids. */
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly stages: readonly Stage[];
  readonly commands: readonly Command[];
  readonly roles: readonly Role[];
  /** Templates, progress for the start screen, and what can be copied between projects. */
  readonly project?: ProjectSupport;
}

/** Checks a mode's own consistency once, at start-up, instead of failing later in use. */
export function defineMode(mode: Mode): Mode {
  if (!/^[a-z][a-z0-9]*$/.test(mode.id)) {
    throw new TypeError(`Invalid mode id: "${mode.id}"`);
  }
  for (const command of mode.commands) {
    if (!command.id.startsWith(`${mode.id}.`)) {
      throw new TypeError(
        `Command "${command.id}" of mode "${mode.id}" must start with "${mode.id}.".`,
      );
    }
  }
  const stageIds = new Set(mode.stages.map((stage) => stage.id));
  if (stageIds.size !== mode.stages.length) {
    throw new TypeError(`Mode "${mode.id}" lists a stage twice.`);
  }
  return mode;
}
