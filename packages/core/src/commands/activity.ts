import { z } from 'zod';
import { ActivityEntry, readActivity } from '../activity.js';
import { defineCommand } from '../command.js';

/** The activity log is read through a command like everything else, so agents can see it too. */
export const activityList = defineCommand({
  id: 'activity.list',
  title: 'Show activity',
  description: 'Returns the most recent command executions, newest first, with who ran each one.',
  effect: 'read',
  input: z.object({
    limit: z.number().int().positive().max(500).default(50).describe('How many entries to return.'),
  }),
  output: z.object({ entries: z.array(ActivityEntry) }),
  handler: async ({ runtime }, { limit }) => ({
    entries: (await readActivity(runtime.store)).slice(-limit).reverse(),
  }),
});

export const activityCommands = [activityList] as const;
