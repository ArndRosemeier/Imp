import type { Actor } from './actor.js';
import type { Command } from './command.js';

export type PolicyDecision = 'allow' | 'needs-approval' | 'deny';

/** Decides whether an actor may run a command now, must ask first, or may not at all. */
export type ExecutionPolicy = (actor: Actor, command: Command) => PolicyDecision;

/**
 * The default: the user may do anything; an agent reads and writes freely and
 * must ask before spending money or destroying something.
 */
export const defaultPolicy: ExecutionPolicy = (actor, command) => {
  if (actor.kind === 'user') {
    return 'allow';
  }
  return command.effect === 'spend' || command.effect === 'destructive'
    ? 'needs-approval'
    : 'allow';
};
