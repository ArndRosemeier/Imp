import { defineCommand, requireProject, type Command } from '@imp/core';
import { z } from 'zod';
import { characterPrefix, movieSceneKey, shotPrefix, soundPrefix } from './commands.js';
import { Character, MODE_ID, Scene, Shot, Sound } from './schema.js';

/** One recorded sound of the film, as the audio editor names it. */
export const LibrarySound = z.object({
  key: z.string().describe('The blob key, for audio.region.insert or audio.doc.create.'),
  label: z.string(),
  kind: z.enum(['dialogue', 'effect', 'music', 'voice']),
  sceneId: z.string().nullable().describe('The scene it belongs to; null for voice samples.'),
  sceneHeading: z.string().nullable(),
});
export type LibrarySound = z.infer<typeof LibrarySound>;

const ProjectId = z.string().describe('The id of a movie project from project.list.');

/**
 * Every recorded sound of a movie project in one list, in script order: each
 * scene's recorded dialogue by shot, then its effects and music, then the
 * voice samples of the cast. This is what the audio editor opens and what an
 * agent picks sources from.
 */
export const soundLibrary = defineCommand({
  id: 'movie.sound.library',
  title: 'List recorded sounds',
  description:
    'Returns every recorded sound of the film with its blob key: dialogue lines by shot, sound effects and music by scene, and voice samples of the cast. Use the keys to open sounds in the audio editor (audio.doc.create, audio.region.insert) or to measure them (audio.inspect).',
  effect: 'read',
  input: z.object({ projectId: ProjectId }),
  output: z.object({ sounds: z.array(LibrarySound) }),
  handler: async ({ runtime }, { projectId }) => {
    const { store } = runtime;
    await requireProject(store, 'movie.sound.library', projectId, MODE_ID);
    const scenes = (await store.list(movieSceneKey(projectId, '')))
      .map((entry) => Scene.parse(entry.value))
      .sort((a, b) => a.position - b.position);
    const sounds: LibrarySound[] = [];
    for (const scene of scenes) {
      const at = { sceneId: scene.id, sceneHeading: scene.heading };
      const shots = (await store.list(shotPrefix(projectId, scene.id)))
        .map((entry) => Shot.parse(entry.value))
        .sort((a, b) => a.position - b.position);
      for (const shot of shots) {
        if (shot.dialogue === null) continue;
        const words = shot.dialogue.line.trim();
        sounds.push({
          key: shot.dialogue.blobKey,
          label: `Shot ${String(shot.position)}: ${words.length > 60 ? `${words.slice(0, 59)}…` : words}`,
          kind: 'dialogue',
          ...at,
        });
      }
      const sceneSounds = (await store.list(soundPrefix(projectId, scene.id)))
        .map((entry) => Sound.parse(entry.value))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      for (const sound of sceneSounds) {
        if (sound.take === null) continue;
        sounds.push({
          key: sound.take.blobKey,
          label:
            sound.name === '' ? (sound.kind === 'music' ? 'Music' : 'Sound effect') : sound.name,
          kind: sound.kind,
          ...at,
        });
      }
    }
    const cast = (await store.list(characterPrefix(projectId)))
      .map((entry) => Character.parse(entry.value))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const character of cast) {
      if (character.voiceSample === null) continue;
      sounds.push({
        key: character.voiceSample.blobKey,
        label: `${character.name}, voice sample`,
        kind: 'voice',
        sceneId: null,
        sceneHeading: null,
      });
    }
    return { sounds };
  },
});

export const libraryCommands: readonly Command[] = [soundLibrary];
