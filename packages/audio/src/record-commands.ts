import {
  CommandError,
  defineCommand,
  projectPrefix,
  requireProject,
  UPLOAD_PREFIX,
  type Command,
} from '@imp/core';
import { z } from 'zod';
import { Track } from './doc.js';
import type { EffectCommandHelpers } from './fx-commands.js';
import { SoundPlacement } from './placement.js';
import { snapSeconds } from './time.js';

/** Where recordings of a project are kept. */
export const recordingPrefix = (projectId: string): string =>
  `${projectPrefix(projectId)}audio/recordings/`;

/**
 * Recordings from the person's microphone. The browser records and uploads
 * the file; these commands keep it in the project and place it on a track,
 * as one step that can be undone.
 */
export function createRecordingCommands(helpers: EffectCommandHelpers): readonly Command[] {
  const keep = defineCommand({
    id: 'audio.recording.keep',
    title: 'Keep a recording',
    description:
      'Keeps a recording the person made with their microphone (an uploaded file) in the project and places it on a track of an audio document at a time: on the track named, or on a new track. People use it from the record button; agents rarely need it.',
    effect: 'write',
    input: z.object({
      projectId: z.string().min(1),
      docId: z.string().min(1),
      uploadKey: z.string().min(1).describe('Where the browser put the file, under "uploads/".'),
      trackId: z.string().min(1).optional().describe('Leave out to record onto a new track.'),
      startSeconds: z.number().min(0).default(0),
      label: z.string().max(120).default(''),
    }),
    output: helpers.outline,
    handler: async (context, input) => {
      const id = 'audio.recording.keep';
      const { runtime } = context;
      await requireProject(runtime.store, id, input.projectId);
      if (!input.uploadKey.startsWith(UPLOAD_PREFIX)) {
        throw new CommandError('invalid_input', id, 'A recording comes in as an upload.');
      }
      const doc = await helpers.load(runtime, id, input.projectId, input.docId);
      if (doc.link !== null) {
        throw new CommandError(
          'invalid_input',
          id,
          "A scene's sound holds only sounds of the film. Record into an audio document of its own.",
        );
      }
      if (input.trackId !== undefined) helpers.trackOf(doc, id, input.trackId);
      const file = await runtime.blobs.get(input.uploadKey);
      if (file === undefined) {
        throw new CommandError(
          'invalid_input',
          id,
          `Nothing was uploaded under "${input.uploadKey}".`,
        );
      }
      const regionId = runtime.newId();
      const key = `${recordingPrefix(input.projectId)}${regionId}.wav`;
      await runtime.blobs.put(key, file);
      let length: number;
      try {
        length = (await helpers.sources(runtime).describe(key)).info.durationSeconds;
      } catch (error) {
        await runtime.blobs.delete(key);
        throw new CommandError(
          'invalid_input',
          id,
          `The recording cannot be read: ${(error as Error).message}`,
          {
            cause: error,
          },
        );
      }
      await runtime.blobs.delete(input.uploadKey);
      const count = doc.tracks.filter((track) => track.name.startsWith('Recording')).length;
      const label = input.label === '' ? `Recording ${String(count + 1)}` : input.label;
      return helpers.done(
        await helpers.change(context, id, input.projectId, input.docId, 'Record', (current) => {
          const region = SoundPlacement.parse({
            id: regionId,
            source: 'file',
            blobKey: key,
            label,
            soundId: '',
            startSeconds: snapSeconds(input.startSeconds),
            durationSeconds: snapSeconds(length),
            volume: 1,
            fadeInSeconds: 0,
            fadeOutSeconds: 0,
            loop: false,
          });
          if (input.trackId === undefined) {
            const track = Track.parse({
              id: runtime.newId(),
              name: `Recording ${String(count + 1)}`,
              regions: [region],
            });
            return { ...current, tracks: [...current.tracks, track] };
          }
          return {
            ...current,
            tracks: current.tracks.map((track) =>
              track.id === input.trackId
                ? { ...track, regions: [...track.regions, region] }
                : track,
            ),
          };
        }),
      );
    },
  });

  const list = defineCommand({
    id: 'audio.recording.list',
    title: 'List recordings',
    description:
      'Returns the microphone recordings of a project with their keys and lengths. Place one with audio.region.insert; it stays in the project even when no document uses it.',
    effect: 'read',
    input: z.object({ projectId: z.string().min(1) }),
    output: z.object({
      recordings: z.array(z.object({ key: z.string(), durationSeconds: z.number().nullable() })),
    }),
    handler: async ({ runtime }, { projectId }) => {
      await requireProject(runtime.store, 'audio.recording.list', projectId);
      const keys = (await runtime.blobs.list(recordingPrefix(projectId))).filter(
        (key) => !key.includes('.audio/'),
      );
      const recordings = [];
      for (const key of keys) {
        const durationSeconds = await helpers
          .sources(runtime)
          .describe(key)
          .then(
            ({ info }) => Math.round(info.durationSeconds * 1000) / 1000,
            () => null,
          );
        recordings.push({ key, durationSeconds });
      }
      return { recordings };
    },
  });

  return [keep, list];
}
