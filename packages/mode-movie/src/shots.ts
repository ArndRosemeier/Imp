import {
  CommandError,
  defineCommand,
  requireProject,
  type Command,
  type CoreRuntime,
  type KeyValueStore,
} from '@imp/core';
import {
  describeVideoModel,
  fitDuration,
  fitResolution,
  mp3DurationSeconds,
  ProviderError,
  type GenerationProvider,
  type MediaInput,
  type ModelInfo,
} from '@imp/providers';
import { z } from 'zod';
import { characterPrefix, movieDevelopmentKey, movieSceneKey, shotPrefix } from './commands.js';
import { SPEECH_MODEL_SETTING, voiceDirection } from './voice.js';
import { Character, Clip, Development, DialogueTake, MODE_ID, Shot } from './schema.js';

/** The setting that names the model clips are made with when a call does not say. */
export const VIDEO_MODEL_SETTING = 'video.model';

const ProjectId = z.string().describe('The id of a movie project from project.list.');
const SceneId = z.string().describe('The id of a scene from movie.scene.list.');
const ShotFields = Shot.omit({
  id: true,
  sceneId: true,
  position: true,
  clip: true,
  dialogue: true,
});

const shotKey = (projectId: string, sceneId: string, shotId: string): string =>
  `${shotPrefix(projectId, sceneId)}${shotId}`;

async function readShots(store: KeyValueStore, projectId: string, sceneId: string) {
  return (await store.list(shotPrefix(projectId, sceneId)))
    .map((entry) => Shot.parse(entry.value))
    .sort((a, b) => a.position - b.position);
}

async function requireScene(
  store: KeyValueStore,
  commandId: string,
  projectId: string,
  sceneId: string,
): Promise<void> {
  await requireProject(store, commandId, projectId, MODE_ID);
  if ((await store.get(movieSceneKey(projectId, sceneId))) === undefined) {
    throw new CommandError('invalid_input', commandId, `No scene "${sceneId}".`);
  }
}

async function loadShot(
  store: KeyValueStore,
  commandId: string,
  at: { projectId: string; sceneId: string; shotId: string },
) {
  await requireProject(store, commandId, at.projectId, MODE_ID);
  const key = shotKey(at.projectId, at.sceneId, at.shotId);
  const stored = await store.get(key);
  if (stored === undefined) {
    throw new CommandError('invalid_input', commandId, `No shot "${at.shotId}" in that scene.`);
  }
  return { key, shot: Shot.parse(stored) };
}

async function readCast(store: KeyValueStore, projectId: string, shot: Shot) {
  const cast: Character[] = [];
  for (const id of new Set([
    ...shot.characterIds,
    ...(shot.speakerId === null ? [] : [shot.speakerId]),
  ])) {
    const stored = await store.get(`${characterPrefix(projectId)}${id}`);
    if (stored !== undefined) cast.push(Character.parse(stored));
  }
  return cast;
}

/**
 * What is sent to the video model. The line goes in as written and is framed
 * by who says it and how, because models take the emotion from the words and
 * not from the situation; the bodies are directed in a sentence of their own.
 */
export function clipPrompt(
  shot: Shot,
  cast: readonly Character[],
  tone: string,
  /** The line is recorded apart and laid over the clip, so the clip must not voice it. */
  dialogueApart = false,
): string {
  const speaker = cast.find((character) => character.id === shot.speakerId);
  const onScreen = cast.filter((character) => !character.voiceOnly);
  const said =
    shot.line.trim() === ''
      ? 'Nobody speaks.'
      : speaker?.voiceOnly === true
        ? 'Nobody in the picture speaks; a voice-over is added later.'
        : dialogueApart
          ? `${speaker?.name ?? 'Someone'} speaks${
              shot.delivery.trim() === '' ? '' : `, ${shot.delivery.trim().replace(/[.!?]+$/, '')},`
            } and the lips move, but no sound is heard: the voice is added later.`
          : `${speaker?.name ?? 'A voice'} says${
              shot.delivery.trim() === '' ? '' : `, ${shot.delivery.trim().replace(/[.!?]+$/, '')},`
            } "${shot.line.trim()}"`;
  return [
    shot.description,
    ...onScreen.map((character) =>
      character.appearance === '' ? '' : `${character.name}: ${character.appearance}`,
    ),
    shot.performance === '' ? '' : `Performance: ${shot.performance}`,
    said,
    tone === '' ? '' : `Visual style: ${tone}`,
  ]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('\n');
}

const At = { projectId: ProjectId, sceneId: SceneId, shotId: z.string() };

async function deleteClipFile(runtime: CoreRuntime, clip: Clip | null): Promise<void> {
  const blobKey = clip?.blobKey ?? null;
  if (blobKey !== null) await runtime.blobs.delete(blobKey);
}

async function deleteDialogueFile(
  runtime: CoreRuntime,
  dialogue: DialogueTake | null,
): Promise<void> {
  if (dialogue !== null) await runtime.blobs.delete(dialogue.blobKey);
}

/** Rough speaking time when the file's length cannot be read: about 2.5 words a second. */
function spokenSeconds(line: string): number {
  return Math.max(1, line.trim().split(/\s+/).length / 2.5);
}

/** What the provider knows of a model, or nothing when it cannot be asked. */
async function findModel(provider: GenerationProvider, id: string): Promise<ModelInfo | undefined> {
  try {
    return (await provider.listModels()).find((model) => model.id === id);
  } catch (error) {
    if (error instanceof ProviderError) return undefined;
    throw error;
  }
}

/** The commands for the shots of a scene and their clips. They need a provider to generate. */
export function createShotCommands(provider: GenerationProvider): readonly Command[] {
  const list = defineCommand({
    id: 'movie.shot.list',
    title: 'List shots',
    description:
      'Returns the shots of a scene in order: id, what is seen, the line and whether there is dialogue and a clip. The details of a shot come from movie.shot.get.',
    effect: 'read',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      full: z.boolean().default(false).describe('Also return every field of every shot. Costly.'),
    }),
    output: z.object({
      shots: z.array(
        z.union([
          Shot,
          Shot.pick({ id: true, position: true, description: true, line: true }).extend({
            dialogue: z.boolean(),
            clip: Clip.shape.status.nullable(),
          }),
        ]),
      ),
    }),
    handler: async ({ runtime }, { projectId, sceneId, full }) => {
      await requireScene(runtime.store, 'movie.shot.list', projectId, sceneId);
      return {
        shots: (await readShots(runtime.store, projectId, sceneId)).map((shot) =>
          full
            ? shot
            : {
                id: shot.id,
                position: shot.position,
                description: shot.description,
                line: shot.line,
                dialogue: shot.dialogue !== null,
                clip: shot.clip?.status ?? null,
              },
        ),
      };
    },
  });

  const get = defineCommand({
    id: 'movie.shot.get',
    title: 'Read shot',
    description: 'Returns one shot with all its fields and the state of its clip.',
    effect: 'read',
    input: z.object(At),
    output: Shot,
    handler: async ({ runtime }, at) => (await loadShot(runtime.store, 'movie.shot.get', at)).shot,
  });

  const create = defineCommand({
    id: 'movie.shot.create',
    title: 'Add shot',
    description:
      'Adds a shot to the end of a scene. A shot is one uninterrupted piece of film of a few seconds: what is seen, what the bodies do, and at most one spoken line.',
    effect: 'write',
    input: ShotFields.partial().extend({ projectId: ProjectId, sceneId: SceneId }),
    output: Shot,
    handler: async ({ runtime }, { projectId, sceneId, ...fields }) => {
      await requireScene(runtime.store, 'movie.shot.create', projectId, sceneId);
      const shot: Shot = {
        id: runtime.newId(),
        sceneId,
        position: (await readShots(runtime.store, projectId, sceneId)).length + 1,
        description: fields.description ?? '',
        characterIds: fields.characterIds ?? [],
        performance: fields.performance ?? '',
        speakerId: fields.speakerId ?? null,
        line: fields.line ?? '',
        delivery: fields.delivery ?? '',
        dialogue: null,
        clip: null,
      };
      await runtime.store.batch([
        { type: 'put', key: shotKey(projectId, sceneId, shot.id), value: shot },
      ]);
      return shot;
    },
  });

  const update = defineCommand({
    id: 'movie.shot.update',
    title: 'Change shot',
    description:
      'Changes a shot. Fields left out stay as they are. An existing clip and dialogue are kept; generate again to see the change.',
    effect: 'write',
    input: ShotFields.partial().extend(At),
    output: Shot,
    handler: async ({ runtime }, { projectId, sceneId, shotId, ...changes }) => {
      const { key, shot } = await loadShot(runtime.store, 'movie.shot.update', {
        projectId,
        sceneId,
        shotId,
      });
      const next: Shot = {
        ...shot,
        description: changes.description ?? shot.description,
        characterIds: changes.characterIds ?? shot.characterIds,
        performance: changes.performance ?? shot.performance,
        speakerId: changes.speakerId === undefined ? shot.speakerId : changes.speakerId,
        line: changes.line ?? shot.line,
        delivery: changes.delivery ?? shot.delivery,
      };
      await runtime.store.batch([{ type: 'put', key, value: next }]);
      return next;
    },
  });

  const remove = defineCommand({
    id: 'movie.shot.delete',
    title: 'Delete shot',
    description: 'Removes a shot and its clip. Later shots of the scene move up.',
    effect: 'destructive',
    input: z.object(At),
    output: z.object({ shotId: z.string(), remaining: z.number() }),
    handler: async ({ runtime }, at) => {
      const { key, shot } = await loadShot(runtime.store, 'movie.shot.delete', at);
      const remaining = (await readShots(runtime.store, at.projectId, at.sceneId)).filter(
        (candidate) => candidate.id !== shot.id,
      );
      await runtime.store.batch([
        { type: 'delete', key },
        ...remaining.map((candidate, index) => ({
          type: 'put' as const,
          key: shotKey(at.projectId, at.sceneId, candidate.id),
          value: { ...candidate, position: index + 1 },
        })),
      ]);
      await deleteClipFile(runtime, shot.clip);
      await deleteDialogueFile(runtime, shot.dialogue);
      return { shotId: shot.id, remaining: remaining.length };
    },
  });

  const clipGenerate = defineCommand({
    id: 'movie.shot.clip.generate',
    title: 'Generate clip',
    description:
      'Starts making the video clip of a shot from its description and performance, guided by the portraits of its characters where the model takes them (the clip says how many were used). When the shot has dialogue (movie.shot.dialogue.generate) the clip is made silent and long enough for it; the voice is played over it. Lengths and sizes are fitted to what the model makes, and a model that cannot make a film is refused before anything is spent. Returns at once with the clip pending; it takes a minute or more, so check on it with movie.shot.clip.check. Replaces an earlier clip. Costs money at the video model, more than anything else here.',
    effect: 'spend',
    input: z.object({
      ...At,
      model: z
        .string()
        .min(1)
        .optional()
        .describe(
          `A model from models.list with output "video". Defaults to the setting "${VIDEO_MODEL_SETTING}".`,
        ),
      durationSeconds: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe(
          'Seconds wanted. Defaults to the length of the dialogue, or 4. The nearest length the model makes is used.',
        ),
      resolution: z.string().default('720p').describe('The nearest size the model makes is used.'),
      aspectRatio: z.string().default('16:9'),
      audio: z
        .boolean()
        .optional()
        .describe(
          'Whether the clip has sound of its own, in which the model invents the voice. Defaults to no when the shot has dialogue, and to yes when it has a line without dialogue.',
        ),
      portraits: z
        .boolean()
        .default(true)
        .describe(
          'Send the portraits of the characters as guides. Switch off for models that refuse them.',
        ),
    }),
    output: z.object({ clip: Clip }),
    handler: async ({ runtime }, input) => {
      const id = 'movie.shot.clip.generate';
      const { key, shot } = await loadShot(runtime.store, id, input);
      const model = input.model ?? (await runtime.store.get(`settings/${VIDEO_MODEL_SETTING}`));
      if (typeof model !== 'string' || model === '') {
        throw new CommandError(
          'invalid_input',
          id,
          `No video model is chosen. Set the setting "${VIDEO_MODEL_SETTING}" to an id from models.list with output "video", or pass a model.`,
        );
      }
      if (shot.description.trim() === '') {
        throw new CommandError('invalid_input', id, 'Describe what the shot shows first.');
      }
      const info = await findModel(provider, model);
      if (info !== undefined) {
        const verdict = describeVideoModel(info);
        if (!verdict.fits) {
          throw new CommandError(
            'invalid_input',
            id,
            `${model} cannot be used for clips: ${verdict.problem ?? 'it does not fit.'} Pick another from models.list with output "video".`,
          );
        }
      }
      const cast = await readCast(runtime.store, input.projectId, shot);
      const development = await runtime.store.get(movieDevelopmentKey(input.projectId));
      const tone = development === undefined ? '' : Development.parse(development).tone;
      const dialogueApart = shot.dialogue !== null && shot.line.trim() !== '';
      const prompt = clipPrompt(shot, cast, tone, dialogueApart);
      const durationSeconds = fitDuration(
        info?.video,
        input.durationSeconds ??
          (dialogueApart && typeof shot.dialogue?.durationSeconds === 'number'
            ? Math.ceil(shot.dialogue.durationSeconds + 0.5)
            : 4),
      );
      const audio = input.audio ?? (dialogueApart ? false : shot.line.trim() !== '');

      const references: MediaInput[] = [];
      if (input.portraits) {
        for (const character of cast.filter((candidate) => !candidate.voiceOnly)) {
          const portrait = character.images.find((image) => image.id === character.portraitId);
          const blob =
            portrait === undefined ? undefined : await runtime.blobs.get(portrait.blobKey);
          if (blob !== undefined) references.push(blob);
        }
      }

      const request = {
        model,
        prompt,
        durationSeconds,
        resolution: fitResolution(info?.video, input.resolution),
        aspectRatio: input.aspectRatio,
        audio,
      };
      let job;
      let portraits = references.length;
      try {
        try {
          job = await provider.startVideo(
            references.length === 0 ? request : { ...request, references },
          );
        } catch (error) {
          // Many models take no guiding images and refuse the request, which costs nothing.
          // The clip is then made from the words alone, and says so.
          if (
            !(error instanceof ProviderError) ||
            error.kind !== 'bad_request' ||
            portraits === 0
          ) {
            throw error;
          }
          portraits = 0;
          job = await provider.startVideo(request);
        }
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        throw new CommandError('handler_failed', id, `No clip was started: ${error.message}`, {
          cause: error,
        });
      }
      const clip: Clip = {
        status: job.status === 'failed' ? 'failed' : 'pending',
        jobId: job.id,
        blobKey: null,
        mediaType: null,
        prompt,
        model,
        portraits,
        progress: job.progress,
        error: job.error,
        durationSeconds,
        silent: !audio,
        costUsd: job.costUsd,
        createdAt: runtime.now().toISOString(),
      };
      const latest = (await loadShot(runtime.store, id, input)).shot;
      await runtime.store.batch([{ type: 'put', key, value: { ...latest, clip } }]);
      await deleteClipFile(runtime, latest.clip);
      return { clip };
    },
  });

  const clipCheck = defineCommand({
    id: 'movie.shot.clip.check',
    title: 'Check clip',
    description:
      'Looks at a clip that is being made and, once it is done, stores the video. Returns the clip with status pending, ready or failed. A ready clip can be watched with media.view under its blobKey.',
    effect: 'write',
    input: z.object(At),
    output: z.object({ clip: Clip }),
    handler: async ({ runtime }, at) => {
      const id = 'movie.shot.clip.check';
      const { key, shot } = await loadShot(runtime.store, id, at);
      if (shot.clip === null) {
        throw new CommandError('invalid_input', id, 'This shot has no clip. Generate one first.');
      }
      if (shot.clip.status !== 'pending') return { clip: shot.clip };

      let clip: Clip;
      try {
        const job = await provider.checkVideo(shot.clip.jobId);
        if (job.status === 'completed') {
          const video = await provider.downloadVideo(job.id);
          const blobKey = `${key}/clip/${runtime.newId()}`;
          await runtime.blobs.put(blobKey, video);
          clip = {
            ...shot.clip,
            status: 'ready',
            blobKey,
            mediaType: video.mediaType,
            progress: null,
            costUsd: job.costUsd,
          };
        } else {
          clip = {
            ...shot.clip,
            status: job.status,
            progress: job.progress,
            error: job.error,
            costUsd: job.costUsd,
          };
        }
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        throw new CommandError(
          'handler_failed',
          id,
          `The clip could not be checked: ${error.message}`,
          {
            cause: error,
          },
        );
      }
      // Only if it is still the same job: a new clip may have been started meanwhile.
      const latest = (await loadShot(runtime.store, id, at)).shot;
      if (latest.clip?.jobId !== clip.jobId || latest.clip.status !== 'pending') {
        await deleteClipFile(runtime, clip);
        return { clip: latest.clip ?? clip };
      }
      await runtime.store.batch([{ type: 'put', key, value: { ...latest, clip } }]);
      return { clip };
    },
  });

  const clipDelete = defineCommand({
    id: 'movie.shot.clip.delete',
    title: 'Delete clip',
    description: 'Removes the clip of a shot. The shot itself stays.',
    effect: 'destructive',
    input: z.object(At),
    output: z.object({ shotId: z.string(), deleted: z.boolean() }),
    handler: async ({ runtime }, at) => {
      const { key, shot } = await loadShot(runtime.store, 'movie.shot.clip.delete', at);
      if (shot.clip === null) return { shotId: shot.id, deleted: false };
      await runtime.store.batch([{ type: 'put', key, value: { ...shot, clip: null } }]);
      await deleteClipFile(runtime, shot.clip);
      return { shotId: shot.id, deleted: true };
    },
  });

  const dialogueGenerate = defineCommand({
    id: 'movie.shot.dialogue.generate',
    title: 'Record dialogue',
    description:
      "Records the line of a shot in the voice of its speaker, directed by the voice written for the character and the shot's delivery, and keeps it as the dialogue of the shot, replacing an earlier one. Clips are then made silent and as long as the dialogue, and the dialogue is played over them. The speaker and a line must be set. Costs a little at the speech model.",
    effect: 'spend',
    input: z.object({
      ...At,
      model: z
        .string()
        .min(1)
        .optional()
        .describe(
          `A model from models.list with output "speech". Defaults to the setting "${SPEECH_MODEL_SETTING}".`,
        ),
    }),
    output: z.object({ dialogue: DialogueTake }),
    handler: async ({ runtime }, input) => {
      const id = 'movie.shot.dialogue.generate';
      const { key, shot } = await loadShot(runtime.store, id, input);
      if (shot.speakerId === null || shot.line.trim() === '') {
        throw new CommandError(
          'invalid_input',
          id,
          'Set the speaker and the line of the shot first.',
        );
      }
      const model = input.model ?? (await runtime.store.get(`settings/${SPEECH_MODEL_SETTING}`));
      if (typeof model !== 'string' || model === '') {
        throw new CommandError(
          'invalid_input',
          id,
          `No speech model is chosen. Set the setting "${SPEECH_MODEL_SETTING}" to an id from models.list with output "speech", or pass a model.`,
        );
      }
      const stored = await runtime.store.get(
        `${characterPrefix(input.projectId)}${shot.speakerId}`,
      );
      if (stored === undefined) {
        throw new CommandError(
          'invalid_input',
          id,
          `The speaker "${shot.speakerId}" is not a character.`,
        );
      }
      const speaker = Character.parse(stored);
      const direction = voiceDirection(speaker, shot.delivery);
      let spoken;
      try {
        spoken = await provider.generateSpeech({
          model,
          text: shot.line.trim(),
          instructions: direction,
        });
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        throw new CommandError('handler_failed', id, `No dialogue was recorded: ${error.message}`, {
          cause: error,
        });
      }
      const dialogue: DialogueTake = {
        blobKey: `${key}/dialogue/${runtime.newId()}`,
        mediaType: spoken.audio.mediaType,
        line: shot.line,
        direction,
        model,
        durationSeconds:
          mp3DurationSeconds(spoken.audio.bytes) ?? Math.round(spokenSeconds(shot.line) * 10) / 10,
        costUsd: spoken.costUsd,
        createdAt: runtime.now().toISOString(),
      };
      await runtime.blobs.put(dialogue.blobKey, spoken.audio);
      const latest = (await loadShot(runtime.store, id, input)).shot;
      await runtime.store.batch([{ type: 'put', key, value: { ...latest, dialogue } }]);
      await deleteDialogueFile(runtime, latest.dialogue);
      return { dialogue };
    },
  });

  const dialogueDelete = defineCommand({
    id: 'movie.shot.dialogue.delete',
    title: 'Delete dialogue',
    description: 'Removes the recorded dialogue of a shot. The line stays.',
    effect: 'destructive',
    input: z.object(At),
    output: z.object({ shotId: z.string(), deleted: z.boolean() }),
    handler: async ({ runtime }, at) => {
      const { key, shot } = await loadShot(runtime.store, 'movie.shot.dialogue.delete', at);
      if (shot.dialogue === null) return { shotId: shot.id, deleted: false };
      await runtime.store.batch([{ type: 'put', key, value: { ...shot, dialogue: null } }]);
      await deleteDialogueFile(runtime, shot.dialogue);
      return { shotId: shot.id, deleted: true };
    },
  });

  return [
    list,
    get,
    create,
    update,
    remove,
    dialogueGenerate,
    dialogueDelete,
    clipGenerate,
    clipCheck,
    clipDelete,
  ];
}
