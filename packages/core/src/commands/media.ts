import { z } from 'zod';
import { defineCommand } from '../command.js';
import { CommandError } from '../errors.js';

/** A stored file handed to whoever ran the command, to look at or listen to. */
export const MediaAttachment = z.object({
  key: z.string(),
  mediaType: z.string(),
  sizeBytes: z.number(),
});
export type MediaAttachment = z.infer<typeof MediaAttachment>;

/** The most that is shown at once, so one call cannot fill a model's context. */
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/**
 * Looking at stored media is a command, so an agent whose model takes images,
 * sound or video sees what a person sees in the app. A command shows media by
 * returning `attachments`; whatever runs the agent delivers the files.
 */
export const mediaView = defineCommand({
  id: 'media.view',
  title: 'Look at media',
  description:
    'Shows you stored images, sounds or videos by their keys, so you can judge them yourself. Keys come from other commands, for example the blobKey of a character image. Works only if your model takes that kind of input.',
  effect: 'read',
  input: z.object({
    keys: z.array(z.string().min(1)).min(1).max(4).describe('The keys of up to four files.'),
  }),
  output: z.object({ attachments: z.array(MediaAttachment) }),
  handler: async ({ runtime }, { keys }) => {
    const attachments: MediaAttachment[] = [];
    for (const key of keys) {
      const blob = await runtime.blobs.get(key);
      if (blob === undefined) {
        throw new CommandError('invalid_input', 'media.view', `Nothing is stored under "${key}".`);
      }
      attachments.push({ key, mediaType: blob.mediaType, sizeBytes: blob.bytes.length });
    }
    if (attachments.reduce((sum, { sizeBytes }) => sum + sizeBytes, 0) > MAX_TOTAL_BYTES) {
      throw new CommandError(
        'invalid_input',
        'media.view',
        'These files are too large to show together. Ask for fewer at a time.',
      );
    }
    return { attachments };
  },
});

export const mediaCommands = [mediaView] as const;
