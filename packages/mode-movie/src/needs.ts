import type { Need } from '@imp/agents';
import type { KeyValueStore } from '@imp/core';
import { readWorld } from '@imp/world';
import { characterPrefix, movieDevelopmentKey, readScenes, shotPrefix } from './commands.js';
import { Character, Development, Shot } from './schema.js';

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
