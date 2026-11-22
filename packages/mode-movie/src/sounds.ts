import {
  CommandError,
  defineCommand,
  requireProject,
  type Command,
  type KeyValueStore,
  patchOf,
  chosenModel,
} from '@imp/core';
import { ProviderError, type GenerationProvider } from '@imp/providers';
import { z } from 'zod';
import { movieSceneKey, soundPrefix } from './commands.js';
import { MODE_ID, Sound, type SoundTake } from './schema.js';

/** The settings that name the models sounds are made with when a call does not say. */
export const EFFECT_MODEL_SETTING = 'sounds.model';
export const MUSIC_MODEL_SETTING = 'music.model';

const ProjectId = z.string().describe('The id of a movie project from project.list.');
const SceneId = z.string().describe('The id of a scene from movie.scene.list.');
const SoundFields = Sound.pick({ kind: true, name: true, description: true });
const At = { projectId: ProjectId, sceneId: SceneId, soundId: z.string() };

const soundKey = (projectId: string, sceneId: string, soundId: string): string =>
  `${soundPrefix(projectId, sceneId)}${soundId}`;

async function readSounds(store: KeyValueStore, projectId: string, sceneId: string) {
  return (await store.list(soundPrefix(projectId, sceneId)))
    .map((entry) => Sound.parse(entry.value))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

async function loadSound(
  store: KeyValueStore,
  commandId: string,
  at: { projectId: string; sceneId: string; soundId: string },
) {
  await requireProject(store, commandId, at.projectId, MODE_ID);
  const key = soundKey(at.projectId, at.sceneId, at.soundId);
  const stored = await store.get(key);
  if (stored === undefined) {
    throw new CommandError('invalid_input', commandId, `No sound "${at.soundId}" in that scene.`);
  }
  return { key, sound: Sound.parse(stored) };
}

/**
 * What is sent to the model. Music models sing unless told not to, and a film
 * score under dialogue must not, so music is instrumental unless the
 * description asks for a voice.
 */
export function soundPrompt(sound: Pick<Sound, 'kind' | 'description'>): string {
  const description = sound.description.trim();
  if (
    sound.kind === 'effect' ||
    /\b(vocals?|voices?|sung|sings?|singing|choir|lyrics)\b/i.test(description)
  ) {
    return description;
  }
  return `${description}\nInstrumental, no vocals.`;
}

/** The commands for the sound effects and music of a scene. They need a provider to generate. */
export function createSoundCommands(provider: GenerationProvider): readonly Command[] {
  const list = defineCommand({
    id: 'movie.sound.list',
    title: 'List sounds',
    description:
      'Returns the sound effects and music of a scene: what each is, how it is described and whether it was made yet.',
    effect: 'read',
    input: z.object({ projectId: ProjectId, sceneId: SceneId }),
    output: z.object({ sounds: z.array(Sound) }),
    handler: async ({ runtime }, { projectId, sceneId }) => {
      await requireProject(runtime.store, 'movie.sound.list', projectId, MODE_ID);
      return { sounds: await readSounds(runtime.store, projectId, sceneId) };
    },
  });

  const create = defineCommand({
    id: 'movie.sound.create',
    title: 'Add sound',
    description:
      'Adds a sound effect or a piece of music to a scene, in words. One entry is one sound: a door, a wind, a theme. Make it audible with movie.sound.generate.',
    effect: 'write',
    input: SoundFields.partial({ name: true, description: true }).extend({
      projectId: ProjectId,
      sceneId: SceneId,
    }),
    output: Sound,
    handler: async ({ runtime }, { projectId, sceneId, ...fields }) => {
      await requireProject(runtime.store, 'movie.sound.create', projectId, MODE_ID);
      if ((await runtime.store.get(movieSceneKey(projectId, sceneId))) === undefined) {
        throw new CommandError('invalid_input', 'movie.sound.create', `No scene "${sceneId}".`);
      }
      const sound: Sound = {
        id: runtime.newId(),
        sceneId,
        kind: fields.kind,
        name: fields.name ?? '',
        description: fields.description ?? '',
        take: null,
        createdAt: runtime.now().toISOString(),
      };
      await runtime.store.batch([
        { type: 'put', key: soundKey(projectId, sceneId, sound.id), value: sound },
      ]);
      return sound;
    },
  });

  const update = defineCommand({
    id: 'movie.sound.update',
    title: 'Change sound',
    description:
      'Changes the name or description of a sound. Fields left out stay as they are. What was already made is kept; generate again to hear the change.',
    effect: 'write',
    input: patchOf(SoundFields.omit({ kind: true })).extend(At),
    output: Sound,
    handler: async ({ runtime }, { projectId, sceneId, soundId, ...changes }) => {
      const at = { projectId, sceneId, soundId };
      const { key, sound } = await loadSound(runtime.store, 'movie.sound.update', at);
      const next: Sound = {
        ...sound,
        name: changes.name ?? sound.name,
        description: changes.description ?? sound.description,
      };
      await runtime.store.batch([{ type: 'put', key, value: next }]);
      return next;
    },
  });

  const remove = defineCommand({
    id: 'movie.sound.delete',
    title: 'Delete sound',
    description: 'Removes a sound from a scene, with what was made of it.',
    effect: 'destructive',
    input: z.object(At),
    output: z.object({ soundId: z.string() }),
    handler: async ({ runtime }, at) => {
      const { key, sound } = await loadSound(runtime.store, 'movie.sound.delete', at);
      await runtime.store.batch([{ type: 'delete', key }]);
      if (sound.take !== null) await runtime.blobs.delete(sound.take.blobKey);
      return { soundId: sound.id };
    },
  });

  const generate = defineCommand({
    id: 'movie.sound.generate',
    title: 'Generate sound',
    description:
      'Makes a sound effect or piece of music audible from its description and keeps it, replacing what was made before. Listen to it with media.view. Costs money at the model: little for an effect, a few cents for music.',
    effect: 'spend',
    input: z.object({
      ...At,
      model: z
        .string()
        .min(1)
        .optional()
        .describe(
          `For an effect, a model from models.list with output "speech" (default: the setting "${EFFECT_MODEL_SETTING}"). For music, one with output "audio" (default: the setting "${MUSIC_MODEL_SETTING}").`,
        ),
    }),
    output: z.object({ sound: Sound, costUsd: z.number().nullable() }),
    estimate: async ({ runtime }, { model: chosen, ...at }) => {
      const { sound } = await loadSound(runtime.store, 'movie.sound.generate', at);
      const music = sound.kind === 'music';
      return {
        kind: music ? 'music' : 'sound',
        model: await chosenModel(
          runtime.store,
          music ? MUSIC_MODEL_SETTING : EFFECT_MODEL_SETTING,
          chosen,
        ),
      };
    },
    handler: async ({ runtime }, { model: chosen, ...at }) => {
      const id = 'movie.sound.generate';
      const { key, sound } = await loadSound(runtime.store, id, at);
      if (sound.description.trim() === '') {
        throw new CommandError('invalid_input', id, 'Describe what is heard first.');
      }
      const setting = sound.kind === 'music' ? MUSIC_MODEL_SETTING : EFFECT_MODEL_SETTING;
      const model = chosen ?? (await runtime.store.get(`settings/${setting}`));
      if (typeof model !== 'string' || model === '') {
        throw new CommandError(
          'invalid_input',
          id,
          sound.kind === 'music'
            ? `No music model is chosen. Set the setting "${setting}" to an id from models.list with output "audio", or pass a model.`
            : `No model for sound effects is chosen. Set the setting "${setting}" to an id from models.list with output "speech", or pass a model.`,
        );
      }
      const prompt = soundPrompt(sound);

      let made;
      try {
        made = await provider.generateSound({ model, kind: sound.kind, prompt });
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        throw new CommandError('handler_failed', id, `No sound was made: ${error.message}`, {
          cause: error,
        });
      }

      const take: SoundTake = {
        // A new key each time, so nothing that still plays the old one is cut off.
        blobKey: `${key}/take/${runtime.newId()}`,
        mediaType: made.audio.mediaType,
        prompt,
        model,
        costUsd: made.costUsd,
        createdAt: runtime.now().toISOString(),
      };
      await runtime.blobs.put(take.blobKey, made.audio);
      // Read again: music takes a while, and the sound may have been edited or removed meanwhile.
      const latest = await runtime.store.get(key);
      if (latest === undefined) {
        await runtime.blobs.delete(take.blobKey);
        throw new CommandError('invalid_input', id, 'The sound was deleted while it was made.');
      }
      const before = Sound.parse(latest);
      const next: Sound = { ...before, take };
      await runtime.store.batch([{ type: 'put', key, value: next }]);
      if (before.take !== null) await runtime.blobs.delete(before.take.blobKey);
      return { sound: next, costUsd: made.costUsd };
    },
  });

  const fromFile = defineCommand({
    id: 'movie.sound.fromFile',
    title: 'Add sound from a file',
    description:
      "Makes a stored sound file a sound of a scene, as if it had been generated there: an imported file from the library, a sound of another scene or another project. It can then be placed on the scene's audio lane with movie.edit.sound.place and opened in the scene's sound in the audio editor. A file that already is a sound of the scene is not added twice. Costs nothing.",
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      blobKey: z
        .string()
        .min(1)
        .describe('The stored file, for example the blobKey of a library asset.'),
      kind: Sound.shape.kind.default('effect'),
      name: z.string().max(80).default(''),
    }),
    output: z.object({ sound: Sound, added: z.boolean() }),
    handler: async ({ runtime }, { projectId, sceneId, blobKey, kind, name }) => {
      const id = 'movie.sound.fromFile';
      await requireProject(runtime.store, id, projectId, MODE_ID);
      if ((await runtime.store.get(movieSceneKey(projectId, sceneId))) === undefined) {
        throw new CommandError('invalid_input', id, `No scene "${sceneId}".`);
      }
      const existing = (await readSounds(runtime.store, projectId, sceneId)).find(
        (sound) => sound.take?.blobKey === blobKey,
      );
      if (existing !== undefined) return { sound: existing, added: false };
      const blob = await runtime.blobs.get(blobKey);
      if (blob === undefined) {
        throw new CommandError('invalid_input', id, `Nothing is stored under "${blobKey}".`);
      }
      if (!/^(audio|video)\//.test(blob.mediaType)) {
        throw new CommandError(
          'invalid_input',
          id,
          `That file is ${blob.mediaType || 'not a sound'}, not a sound.`,
        );
      }
      const soundId = runtime.newId();
      const key = soundKey(projectId, sceneId, soundId);
      const take: SoundTake = {
        blobKey: `${key}/take/${runtime.newId()}`,
        mediaType: blob.mediaType,
        prompt: '',
        model: 'file',
        costUsd: null,
        createdAt: runtime.now().toISOString(),
      };
      await runtime.blobs.put(take.blobKey, blob);
      const sound: Sound = {
        id: soundId,
        sceneId,
        kind,
        name: name.trim().slice(0, 80),
        description: '',
        take,
        createdAt: runtime.now().toISOString(),
      };
      await runtime.store.batch([{ type: 'put', key, value: sound }]);
      return { sound, added: true };
    },
  });

  return [list, create, update, remove, generate, fromFile];
}
