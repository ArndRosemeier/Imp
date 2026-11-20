import {
  CommandError,
  defineCommand,
  projectPrefix,
  requireProject,
  type Command,
  type KeyValueStore,
} from '@imp/core';
import { z } from 'zod';
import {
  Character,
  CharacterImage,
  Development,
  EMPTY_DEVELOPMENT,
  MODE_ID,
  Scene,
  VoiceSample,
} from './schema.js';

const ProjectId = z.string().describe('The id of a movie project from project.list.');

const base = (projectId: string): string => `${projectPrefix(projectId)}movie/`;
const developmentKey = (projectId: string): string => `${base(projectId)}development`;
const scenePrefix = (projectId: string): string => `${base(projectId)}scenes/`;
/** Shots are kept under their scene, so removing a scene removes them and their clips. */
export const shotPrefix = (projectId: string, sceneId?: string): string =>
  `${base(projectId)}shots/${sceneId === undefined ? '' : `${sceneId}/`}`;
/** Sounds are kept under their scene too. */
export const soundPrefix = (projectId: string, sceneId?: string): string =>
  `${base(projectId)}sounds/${sceneId === undefined ? '' : `${sceneId}/`}`;
/** The cut of a scene. */
export const editKey = (projectId: string, sceneId: string): string =>
  `${base(projectId)}edit/${sceneId}`;
export const editHistoryKey = (projectId: string, sceneId: string): string =>
  `${base(projectId)}edit-history/${sceneId}`;
export const movieSceneKey = (projectId: string, sceneId: string): string =>
  `${scenePrefix(projectId)}${sceneId}`;
export const characterPrefix = (projectId: string): string => `${base(projectId)}characters/`;
export const movieDevelopmentKey = (projectId: string): string => developmentKey(projectId);

async function readScenes(store: KeyValueStore, projectId: string): Promise<Scene[]> {
  return (await store.list(scenePrefix(projectId)))
    .map((entry) => Scene.parse(entry.value))
    .sort((a, b) => a.position - b.position);
}

/** Writes the scenes back with positions 1..n in the given order. */
function renumbered(projectId: string, scenes: readonly Scene[]) {
  return scenes.map((scene, index) => ({
    type: 'put' as const,
    key: `${scenePrefix(projectId)}${scene.id}`,
    value: { ...scene, position: index + 1 },
  }));
}

function clamp(position: number | undefined, length: number): number {
  return Math.min(Math.max((position ?? length + 1) - 1, 0), length);
}

// Development

export const developmentGet = defineCommand({
  id: 'movie.development.get',
  title: 'Read development',
  description: 'Returns the logline, premise, tone and treatment of a movie project.',
  effect: 'read',
  input: z.object({ projectId: ProjectId }),
  output: Development,
  handler: async ({ runtime }, { projectId }) => {
    await requireProject(runtime.store, 'movie.development.get', projectId, MODE_ID);
    const stored = await runtime.store.get(developmentKey(projectId));
    return stored === undefined ? EMPTY_DEVELOPMENT : Development.parse(stored);
  },
});

export const developmentUpdate = defineCommand({
  id: 'movie.development.update',
  title: 'Change development',
  description:
    'Changes the logline, premise, tone or treatment of a movie project. Fields left out stay as they are.',
  effect: 'write',
  input: Development.partial().extend({ projectId: ProjectId }),
  output: Development,
  handler: async ({ runtime }, { projectId, ...changes }) => {
    await requireProject(runtime.store, 'movie.development.update', projectId, MODE_ID);
    const stored = await runtime.store.get(developmentKey(projectId));
    const current = stored === undefined ? EMPTY_DEVELOPMENT : Development.parse(stored);
    const next: Development = {
      logline: changes.logline ?? current.logline,
      premise: changes.premise ?? current.premise,
      tone: changes.tone ?? current.tone,
      treatment: changes.treatment ?? current.treatment,
    };
    await runtime.store.batch([{ type: 'put', key: developmentKey(projectId), value: next }]);
    return next;
  },
});

// Script

const Full = z
  .boolean()
  .default(false)
  .describe('Also return the long fields of every item. Costly; prefer fetching single items.');

const countWords = (text: string): number => text.split(/\s+/).filter(Boolean).length;

export const sceneList = defineCommand({
  id: 'movie.scene.list',
  title: 'List scenes',
  description:
    'Returns the outline of the script: every scene in order with id, heading, summary and length. The text of a scene comes from movie.scene.get.',
  effect: 'read',
  input: z.object({ projectId: ProjectId, full: Full }),
  output: z.object({
    scenes: z.array(Scene.partial({ body: true }).extend({ words: z.number() })),
  }),
  handler: async ({ runtime }, { projectId, full }) => {
    await requireProject(runtime.store, 'movie.scene.list', projectId, MODE_ID);
    return {
      scenes: (await readScenes(runtime.store, projectId)).map(({ body, ...outline }) => ({
        ...outline,
        words: countWords(body),
        ...(full ? { body } : {}),
      })),
    };
  },
});

export const sceneGet = defineCommand({
  id: 'movie.scene.get',
  title: 'Read scene',
  description: 'Returns one scene with its full text.',
  effect: 'read',
  input: z.object({ projectId: ProjectId, sceneId: z.string() }),
  output: Scene,
  handler: async ({ runtime }, { projectId, sceneId }) => {
    await requireProject(runtime.store, 'movie.scene.get', projectId, MODE_ID);
    const stored = await runtime.store.get(`${scenePrefix(projectId)}${sceneId}`);
    if (stored === undefined) {
      throw new CommandError('invalid_input', 'movie.scene.get', `No scene "${sceneId}".`);
    }
    return Scene.parse(stored);
  },
});

export const sceneCreate = defineCommand({
  id: 'movie.scene.create',
  title: 'Add scene',
  description:
    'Adds a scene to the script. It goes to the end unless a position is given; later scenes move down.',
  effect: 'write',
  input: z.object({
    projectId: ProjectId,
    heading: Scene.shape.heading,
    summary: Scene.shape.summary.default(''),
    body: Scene.shape.body.default(''),
    position: z.number().int().positive().optional().describe('Where to insert it, starting at 1.'),
  }),
  output: Scene,
  handler: async ({ runtime }, input) => {
    await requireProject(runtime.store, 'movie.scene.create', input.projectId, MODE_ID);
    const scenes = await readScenes(runtime.store, input.projectId);
    const index = clamp(input.position, scenes.length);
    const scene: Scene = {
      id: runtime.newId(),
      position: index + 1,
      heading: input.heading,
      summary: input.summary,
      body: input.body,
    };
    scenes.splice(index, 0, scene);
    await runtime.store.batch(renumbered(input.projectId, scenes));
    return scene;
  },
});

export const sceneUpdate = defineCommand({
  id: 'movie.scene.update',
  title: 'Change scene',
  description:
    'Changes the heading, summary or text of a scene, or moves it to another position. Fields left out stay as they are.',
  effect: 'write',
  input: z.object({
    projectId: ProjectId,
    sceneId: z.string(),
    heading: Scene.shape.heading.optional(),
    summary: Scene.shape.summary.optional(),
    body: Scene.shape.body.optional(),
    position: z.number().int().positive().optional().describe('The new position, starting at 1.'),
  }),
  output: Scene,
  handler: async ({ runtime }, input) => {
    await requireProject(runtime.store, 'movie.scene.update', input.projectId, MODE_ID);
    const scenes = await readScenes(runtime.store, input.projectId);
    const from = scenes.findIndex((scene) => scene.id === input.sceneId);
    const current = scenes[from];
    if (current === undefined) {
      throw new CommandError('invalid_input', 'movie.scene.update', `No scene "${input.sceneId}".`);
    }
    const changed: Scene = {
      ...current,
      heading: input.heading ?? current.heading,
      summary: input.summary ?? current.summary,
      body: input.body ?? current.body,
    };
    scenes.splice(from, 1);
    const to = input.position === undefined ? from : clamp(input.position, scenes.length);
    scenes.splice(to, 0, changed);
    await runtime.store.batch(renumbered(input.projectId, scenes));
    return { ...changed, position: to + 1 };
  },
});

export const sceneDelete = defineCommand({
  id: 'movie.scene.delete',
  title: 'Delete scene',
  description:
    'Removes a scene from the script. Its text, its shots with their clips and its sounds are lost. Later scenes move up.',
  effect: 'destructive',
  input: z.object({ projectId: ProjectId, sceneId: z.string() }),
  output: z.object({ sceneId: z.string(), remaining: z.number() }),
  handler: async ({ runtime }, { projectId, sceneId }) => {
    await requireProject(runtime.store, 'movie.scene.delete', projectId, MODE_ID);
    const scenes = await readScenes(runtime.store, projectId);
    const remaining = scenes.filter((scene) => scene.id !== sceneId);
    if (remaining.length === scenes.length) {
      throw new CommandError('invalid_input', 'movie.scene.delete', `No scene "${sceneId}".`);
    }
    await runtime.store.batch([
      { type: 'delete', key: `${scenePrefix(projectId)}${sceneId}` },
      { type: 'delete', key: editKey(projectId, sceneId) },
      { type: 'delete', key: editHistoryKey(projectId, sceneId) },
      ...[
        ...(await runtime.store.list(shotPrefix(projectId, sceneId))),
        ...(await runtime.store.list(soundPrefix(projectId, sceneId))),
      ].map((entry) => ({ type: 'delete' as const, key: entry.key })),
      ...renumbered(projectId, remaining),
    ]);
    for (const prefix of [shotPrefix(projectId, sceneId), soundPrefix(projectId, sceneId)]) {
      for (const blobKey of await runtime.blobs.list(prefix)) {
        await runtime.blobs.delete(blobKey);
      }
    }
    return { sceneId, remaining: remaining.length };
  },
});

// Casting

const CharacterFields = Character.omit({
  id: true,
  images: true,
  portraitId: true,
  voiceSample: true,
});

export const characterList = defineCommand({
  id: 'movie.character.list',
  title: 'List characters',
  description:
    'Returns the cast of a movie project: id, name, part and portrait of each character. The details of a character come from movie.character.get.',
  effect: 'read',
  input: z.object({ projectId: ProjectId, full: Full }),
  output: z.object({
    characters: z.array(
      // `images` is spelled out because a field with a default would otherwise fill itself in.
      Character.omit({ images: true, voiceSample: true })
        .partial({ description: true, appearance: true, voice: true })
        .extend({
          images: z.array(CharacterImage).optional(),
          voiceSample: VoiceSample.nullable().optional(),
        }),
    ),
  }),
  handler: async ({ runtime }, { projectId, full }) => {
    await requireProject(runtime.store, 'movie.character.list', projectId, MODE_ID);
    return {
      characters: (await runtime.store.list(characterPrefix(projectId)))
        .map((entry) => Character.parse(entry.value))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((character) =>
          full
            ? character
            : {
                id: character.id,
                name: character.name,
                part: character.part,
                portraitId: character.portraitId,
              },
        ),
    };
  },
});

export const characterGet = defineCommand({
  id: 'movie.character.get',
  title: 'Read character',
  description: 'Returns one character with description, appearance and voice.',
  effect: 'read',
  input: z.object({ projectId: ProjectId, characterId: z.string() }),
  output: Character,
  handler: async ({ runtime }, { projectId, characterId }) => {
    await requireProject(runtime.store, 'movie.character.get', projectId, MODE_ID);
    const stored = await runtime.store.get(`${characterPrefix(projectId)}${characterId}`);
    if (stored === undefined) {
      throw new CommandError(
        'invalid_input',
        'movie.character.get',
        `No character "${characterId}".`,
      );
    }
    return Character.parse(stored);
  },
});

export const characterCreate = defineCommand({
  id: 'movie.character.create',
  title: 'Add character',
  description: 'Adds a character to the cast of a movie project.',
  effect: 'write',
  input: z.object({
    projectId: ProjectId,
    name: Character.shape.name,
    part: Character.shape.part.default(''),
    description: Character.shape.description.default(''),
    appearance: Character.shape.appearance.default(''),
    voice: Character.shape.voice.default(''),
    voiceOnly: Character.shape.voiceOnly,
  }),
  output: Character,
  handler: async ({ runtime }, { projectId, ...fields }) => {
    await requireProject(runtime.store, 'movie.character.create', projectId, MODE_ID);
    const character: Character = {
      id: runtime.newId(),
      ...fields,
      images: [],
      portraitId: null,
      voiceSample: null,
    };
    await runtime.store.batch([
      { type: 'put', key: `${characterPrefix(projectId)}${character.id}`, value: character },
    ]);
    return character;
  },
});

export const characterUpdate = defineCommand({
  id: 'movie.character.update',
  title: 'Change character',
  description: 'Changes details of a character. Fields left out stay as they are.',
  effect: 'write',
  input: CharacterFields.partial().extend({ projectId: ProjectId, characterId: z.string() }),
  output: Character,
  handler: async ({ runtime }, { projectId, characterId, ...changes }) => {
    await requireProject(runtime.store, 'movie.character.update', projectId, MODE_ID);
    const key = `${characterPrefix(projectId)}${characterId}`;
    const stored = await runtime.store.get(key);
    if (stored === undefined) {
      throw new CommandError(
        'invalid_input',
        'movie.character.update',
        `No character "${characterId}".`,
      );
    }
    const current = Character.parse(stored);
    const next: Character = {
      id: current.id,
      name: changes.name ?? current.name,
      part: changes.part ?? current.part,
      description: changes.description ?? current.description,
      appearance: changes.appearance ?? current.appearance,
      voice: changes.voice ?? current.voice,
      voiceOnly: changes.voiceOnly ?? current.voiceOnly,
      images: current.images,
      portraitId: current.portraitId,
      voiceSample: current.voiceSample,
    };
    await runtime.store.batch([{ type: 'put', key, value: next }]);
    return next;
  },
});

export const characterDelete = defineCommand({
  id: 'movie.character.delete',
  title: 'Delete character',
  description: 'Removes a character from the cast. Its details, images and voice sample are lost.',
  effect: 'destructive',
  input: z.object({ projectId: ProjectId, characterId: z.string() }),
  output: z.object({ characterId: z.string() }),
  handler: async ({ runtime }, { projectId, characterId }) => {
    await requireProject(runtime.store, 'movie.character.delete', projectId, MODE_ID);
    const key = `${characterPrefix(projectId)}${characterId}`;
    if ((await runtime.store.get(key)) === undefined) {
      throw new CommandError(
        'invalid_input',
        'movie.character.delete',
        `No character "${characterId}".`,
      );
    }
    await runtime.store.batch([{ type: 'delete', key }]);
    for (const blobKey of await runtime.blobs.list(`${key}/`)) {
      await runtime.blobs.delete(blobKey);
    }
    return { characterId };
  },
});

export const movieCommands: readonly Command[] = [
  developmentGet,
  developmentUpdate,
  sceneList,
  sceneGet,
  sceneCreate,
  sceneUpdate,
  sceneDelete,
  characterList,
  characterGet,
  characterCreate,
  characterUpdate,
  characterDelete,
];
