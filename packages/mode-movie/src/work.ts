import type { WorkDescriber, WorkSubject } from '@imp/agents';
import type { KeyValueStore } from '@imp/core';
import { readElement } from '@imp/world';
import { characterPrefix, movieSceneKey } from './commands.js';
import { Character, Scene, Shot } from './schema.js';
import { shotKey } from './shots.js';

/** Which stage a command works in, by the start of its id; the first match wins. */
const STAGES: readonly (readonly [prefix: string, stage: string])[] = [
  ['movie.development.', 'development'],
  ['movie.scene.', 'script'],
  ['movie.script.', 'script'],
  ['movie.character.', 'casting'],
  ['world.', 'design'],
  ['movie.shot.', 'shots'],
  ['movie.edit.pickup', 'shots'],
  ['movie.sound.', 'sound'],
  ['movie.edit.', 'edit'],
  ['movie.film', 'edit'],
  ['audio.', 'audio'],
];

export function movieStageOf(commandId: string): string | undefined {
  return STAGES.find(([prefix]) => commandId.startsWith(prefix))?.[1];
}

const short = (text: string, chars = 36): string =>
  text.length <= chars ? text : `${text.slice(0, chars - 1).trimEnd()}…`;

async function nameOf(
  store: KeyValueStore,
  projectId: string,
  subject: WorkSubject,
  input: Readonly<Record<string, unknown>>,
): Promise<string | null> {
  if (subject.kind === 'scene') {
    const stored = await store.get(movieSceneKey(projectId, subject.id));
    if (stored === undefined) return null;
    const scene = Scene.parse(stored);
    return `Scene ${String(scene.position)}: ${short(scene.heading)}`;
  }
  if (subject.kind === 'shot') {
    const sceneId = typeof input['sceneId'] === 'string' ? input['sceneId'] : undefined;
    if (sceneId === undefined) return null;
    const stored = await store.get(shotKey(projectId, sceneId, subject.id));
    const scene = await store.get(movieSceneKey(projectId, sceneId));
    if (stored === undefined) return null;
    const shot = Shot.parse(stored);
    const position = scene === undefined ? null : Scene.parse(scene).position;
    return position === null
      ? `Shot ${String(shot.position)}`
      : `Scene ${String(position)}, shot ${String(shot.position)}`;
  }
  if (subject.kind === 'character' || subject.kind === 'speaker') {
    const stored = await store.get(`${characterPrefix(projectId)}${subject.id}`);
    return stored === undefined ? null : Character.parse(stored).name;
  }
  if (subject.kind === 'location' || subject.kind === 'object') {
    return (await readElement(store, projectId, subject.kind, subject.id))?.name ?? null;
  }
  return null;
}

/** The movie mode on the work board: its stages, and names for scenes, shots, people and places. */
export const movieWork: WorkDescriber = {
  stageOf: movieStageOf,
  label: async (store, projectId, subjects, input) =>
    projectId === null
      ? subjects
      : Promise.all(
          subjects.map(async (subject) =>
            subject.label !== null
              ? subject
              : {
                  ...subject,
                  kind: subject.kind === 'speaker' ? 'character' : subject.kind,
                  label: await nameOf(store, projectId, subject, input),
                },
          ),
        ),
};
