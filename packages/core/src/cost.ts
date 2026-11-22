import { z } from 'zod';

/**
 * What a command that spends money is about to make, so it can be priced
 * before it runs: by the person deciding whether to press the button, and by
 * the approval card an agent's request shows. The command describes the
 * work; pricing it is the job of whoever knows the prices.
 */
export const CostRequest = z.object({
  kind: z.enum(['chat', 'image', 'speech', 'sound', 'music', 'video', 'transcription']),
  /** The model that will be used, or null when none is chosen yet. */
  model: z.string().nullable(),
  /** How many: pictures, sounds, pieces of music. Defaults to 1. */
  count: z.number().positive().optional(),
  /** How long: a clip, or the sound to write down. */
  seconds: z.number().positive().optional(),
  /** How much is said, for speech. */
  characters: z.number().int().nonnegative().optional(),
  /** A clip's size, for example `720p`, and whether it has sound of its own. */
  resolution: z.string().optional(),
  audio: z.boolean().optional(),
  /** The most it can cost, when that is known and the usual cost is not: an agent's budget per run. */
  maxUsd: z.number().nonnegative().optional(),
});
export type CostRequest = z.infer<typeof CostRequest>;

/** The model a command will use: the one passed, else the setting, else null. */
export async function chosenModel(
  store: { get(key: string): Promise<unknown> },
  setting: string,
  passed?: string,
): Promise<string | null> {
  if (passed !== undefined && passed !== '') return passed;
  const value = await store.get(`settings/${setting}`);
  return typeof value === 'string' && value !== '' ? value : null;
}
