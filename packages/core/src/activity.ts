import { z } from 'zod';
import { Actor } from './actor.js';
import { EFFECTS } from './command.js';
import type { JsonValue } from './json.js';
import type { KeyValueStore } from './storage/kv.js';

/**
 * One record per command execution that changed something or was refused:
 * who ran what, with which outcome. Successful reads are not recorded.
 */
export const ActivityEntry = z.object({
  id: z.string(),
  at: z.iso.datetime(),
  actor: Actor,
  commandId: z.string(),
  effect: z.enum(EFFECTS),
  outcome: z.enum(['ok', 'needs-approval', 'denied', 'failed']),
  durationMs: z.number().nonnegative(),
  /** The failure message, or null when the command did not fail. */
  error: z.string().nullable(),
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;

export const ACTIVITY_PREFIX = 'activity/';

/** Keys sort by time, so listing the prefix returns the log in order. */
export function activityKey(entry: Pick<ActivityEntry, 'at' | 'id'>): string {
  return `${ACTIVITY_PREFIX}${entry.at.replaceAll(':', '-')}_${entry.id}`;
}

export async function appendActivity(store: KeyValueStore, entry: ActivityEntry): Promise<void> {
  const value: JsonValue = entry;
  await store.batch([{ type: 'put', key: activityKey(entry), value }]);
}

export async function readActivity(store: KeyValueStore): Promise<readonly ActivityEntry[]> {
  const entries = await store.list(ACTIVITY_PREFIX);
  return entries.map((entry) => ActivityEntry.parse(entry.value));
}
