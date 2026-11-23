import { checkpointNeed, inputField, type Checkpoint, type Need } from '@imp/agents';
import type { KeyValueStore } from '@imp/core';
import { readWorld } from '@imp/world';
import { characterPrefix, movieDevelopmentKey, readScenes, shotPrefix } from './commands.js';
import { Character, Development, Shot } from './schema.js';
import { visualStyleOf } from './style.js';

/**
 * What the movie crew needs from each other. Each check looks for the work
 * itself, not for a template's placeholders: a template's "The hero" has no
 * look yet, and its scenes have a summary but no text.
 */

export const developmentNeed: Need = {
  id: 'development',
  name: 'The development',
  description:
    'A logline or premise in the development notes: what the film is about. The tone there is the visual style of every picture.',
  providedBy: 'screenwriter',
  check: async (store, projectId) => {
    const stored = await store.get(movieDevelopmentKey(projectId));
    if (stored === undefined) return false;
    const development = Development.parse(stored);
    return development.logline.trim() !== '' || development.premise.trim() !== '';
  },
};

async function hasCast(store: KeyValueStore, projectId: string): Promise<boolean> {
  return (await store.list(characterPrefix(projectId))).some((entry) => {
    const character = Character.parse(entry.value);
    return character.voiceOnly ? character.voice.trim() !== '' : character.appearance.trim() !== '';
  });
}

/** A cast, for the scenes: the Screenwriter writes the lines of characters who exist. */
export const castForScenes: Need = {
  id: 'cast',
  name: 'A cast',
  description:
    'The characters of the film, created by the Casting Director with how they look and sound. Needed to write scenes and lines; the development can be written without it. A film with no characters at all goes without it (crew.needs.waive).',
  providedBy: 'casting-director',
  before: ['movie.scene.create', 'movie.scene.update', 'movie.script.import'],
  check: hasCast,
};

/** A cast, for key frames and clips: a person on screen is drawn from their look. */
export const castForClips: Need = {
  ...castForScenes,
  description:
    'The characters of the film with their look, so that a person on screen looks the same in every shot. Needed for key frames and clips; shots can be planned in words without it.',
  before: ['movie.shot.frame.generate', 'movie.shot.clip.generate'],
};

export const scenesNeed: Need = {
  id: 'scenes',
  name: 'Written scenes',
  description: 'At least one scene of the script with its text written, not only a summary.',
  providedBy: 'screenwriter',
  check: async (store, projectId) =>
    (await readScenes(store, projectId)).some((scene) => scene.body.trim() !== ''),
};

export const locationsNeed: Need = {
  id: 'locations',
  name: 'The places',
  description:
    'The locations the scenes happen in, designed by the Production Designer, so that every shot of a place shows the same place. Needed for key frames and clips.',
  providedBy: 'production-designer',
  before: ['movie.shot.frame.generate', 'movie.shot.clip.generate'],
  check: async (store, projectId) => (await readWorld(store, projectId, 'location')).length > 0,
};

export const clipsNeed: Need = {
  id: 'clips',
  name: 'Clips',
  description: 'At least one shot with a finished video clip to cut.',
  providedBy: 'clip-designer',
  check: async (store, projectId) =>
    (await store.list(shotPrefix(projectId))).some(
      (entry) => Shot.safeParse(entry.value).data?.clip?.status === 'ready',
    ),
};

/**
 * Where the crew stops for the person: the treatment before anything is cast,
 * designed or written into scenes; the storyboard of a scene (its shots and
 * their key frames) before its clips, which cost far more than frames; and
 * the first cut of a scene before its sound and finishing.
 */
export const treatmentCheckpoint: Checkpoint = {
  id: 'treatment',
  name: 'Treatment',
  description:
    'The development: logline, premise, tone and treatment, the film every later step is built on. Casting, design and writing the scenes wait for it.',
  stage: 'development',
};

export const storyboardCheckpoint: Checkpoint = {
  id: 'storyboard',
  name: 'Storyboard',
  description:
    'The shots of a scene with their lengths, joins and key frames, looked at in order before any clip of the scene is made. Frames cost cents and clips dollars, so this is where a scene is changed cheaply. The clips of a scene wait for it.',
  stage: 'shots',
  per: { name: 'scene', plural: 'scenes' },
  main: true,
};

export const firstCutCheckpoint: Checkpoint = {
  id: 'first-cut',
  name: 'First cut',
  description:
    'The first cut of a scene: its clips trimmed and joined, played with their own sound. Extra sound effects and music for the scene wait for it.',
  stage: 'edit',
  per: { name: 'scene', plural: 'scenes' },
};

export const movieCheckpoints: readonly Checkpoint[] = [
  treatmentCheckpoint,
  storyboardCheckpoint,
  firstCutCheckpoint,
];

const sceneOf = inputField('sceneId');

/** The Screenwriter writes the development freely and the scenes once the treatment is signed off. */
export const treatmentForScenes = checkpointNeed(treatmentCheckpoint, [
  'movie.scene.create',
  'movie.scene.update',
  'movie.script.import',
]);

export const treatmentForCast = checkpointNeed(treatmentCheckpoint, [
  'movie.character.create',
  'movie.character.update',
  'movie.character.image.generate',
  'movie.character.voice.generate',
]);

export const treatmentForWorld = checkpointNeed(treatmentCheckpoint, [
  'world.location.create',
  'world.location.update',
  'world.location.view.',
  'world.location.state.',
  'world.location.image.generate',
  'world.object.create',
  'world.object.update',
  'world.object.state.',
  'world.object.image.generate',
]);

/** Clips, and recorded lines laid over them, wait for the storyboard of their scene. */
export const storyboardForClips = checkpointNeed(
  storyboardCheckpoint,
  ['movie.shot.clip.generate', 'movie.shot.dialogue.generate'],
  sceneOf,
);

/** Extra sound for a scene waits for its first cut, which plays with the clips' own sound. */
export const firstCutForSound = checkpointNeed(
  firstCutCheckpoint,
  ['movie.sound.generate'],
  sceneOf,
);

/** The look of the film in words, before any portrait or key frame is drawn. */
export const lookNeed: Need = {
  id: 'look',
  name: 'The visual style',
  description:
    'The look of the film in words (movie.style.update: palette, light, camera, era), set by the Production Designer, ideally with a chosen look picture. Every portrait and key frame is drawn in it. A film written before there was a look keeps its tone instead.',
  providedBy: 'production-designer',
  before: ['movie.character.image.generate', 'movie.shot.frame.generate'],
  check: async (store, projectId) => (await visualStyleOf(store, projectId)).trim() !== '',
};
