import {
  CommandError,
  defineCommand,
  projectPrefix,
  requireProject,
  type Command,
  type KeyValueStore,
} from '@imp/core';
import { z } from 'zod';
import { Character, Development, EMPTY_DEVELOPMENT, MODE_ID, Scene } from './schema.js';

const ProjectId = z.string().describe('The id of a movie project from project.list.');

const base = (projectId: string): string => `${projectPrefix(projectId)}movie/`;
const developmentKey = (projectId: string): string => `${base(projectId)}development`;
const scenePrefix = (projectId: string): string => `${base(projectId)}scenes/`;
const characterPrefix = (projectId: string): string => `${base(projectId)}characters/`;

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

export const sceneList = defineCommand({
  id: 'movie.scene.list',
  title: 'List scenes',
  description: 'Returns every scene of the script in order, with heading, summary and full text.',
  effect: 'read',
  input: z.object({ projectId: ProjectId }),
  output: z.object({ scenes: z.array(Scene) }),
  handler: async ({ runtime }, { projectId }) => {
    await requireProject(runtime.store, 'movie.scene.list', projectId, MODE_ID);
    return { scenes: await readScenes(runtime.store, projectId) };
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
  description: 'Removes a scene from the script. Its text is lost. Later scenes move up.',
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
      ...renumbered(projectId, remaining),
    ]);
    return { sceneId, remaining: remaining.length };
  },
});

// Casting

const CharacterFields = Character.omit({ id: true });

export const characterList = defineCommand({
  id: 'movie.character.list',
  title: 'List characters',
  description: 'Returns the cast of a movie project with every detail of each character.',
  effect: 'read',
  input: z.object({ projectId: ProjectId }),
  output: z.object({ characters: z.array(Character) }),
  handler: async ({ runtime }, { projectId }) => {
    await requireProject(runtime.store, 'movie.character.list', projectId, MODE_ID);
    return {
      characters: (await runtime.store.list(characterPrefix(projectId)))
        .map((entry) => Character.parse(entry.value))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
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
  }),
  output: Character,
  handler: async ({ runtime }, { projectId, ...fields }) => {
    await requireProject(runtime.store, 'movie.character.create', projectId, MODE_ID);
    const character: Character = { id: runtime.newId(), ...fields };
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
    };
    await runtime.store.batch([{ type: 'put', key, value: next }]);
    return next;
  },
});

export const characterDelete = defineCommand({
  id: 'movie.character.delete',
  title: 'Delete character',
  description: 'Removes a character from the cast. Its details are lost.',
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
    return { characterId };
  },
});

export const movieCommands: readonly Command[] = [
  developmentGet,
  developmentUpdate,
  sceneList,
  sceneCreate,
  sceneUpdate,
  sceneDelete,
  characterList,
  characterCreate,
  characterUpdate,
  characterDelete,
];
