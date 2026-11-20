import { z } from 'zod';

/**
 * Who is acting. Every command execution carries one, so the activity log can
 * attribute each change and the policy can treat people and agents differently.
 */
export const Actor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), id: z.string().min(1) }),
  z.object({ kind: z.literal('agent'), id: z.string().min(1), role: z.string().min(1) }),
]);
export type Actor = z.infer<typeof Actor>;
