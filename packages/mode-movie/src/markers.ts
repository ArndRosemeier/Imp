import {
  CommandError,
  defineCommand,
  requireProject,
  type Command,
  type KeyValueStore,
} from '@imp/core';
import { z } from 'zod';
import { markerKey, movieSceneKey } from './commands.js';
import { itemsOf, laidOut, readCut, requireScene } from './edit.js';
import { MODE_ID, Scene } from './schema.js';

/**
 * Markers: notes on the timeline, written by people or agents, for review
 * comments and to-dos. They are not part of the cut, so an agent's note shows
 * at once instead of waiting in a draft, and undoing an edit leaves notes be.
 * A marker follows the piece of picture it was put on, so it stays on the
 * same moment when the cut changes around it.
 */

const ProjectId = z.string().describe('The id of a movie project from project.list.');
const SceneId = z.string().describe('The id of a scene from movie.scene.list.');
const MarkerId = z.string().describe('The id of a marker from movie.edit.marker.list.');

export const MarkerKind = z
  .enum(['note', 'todo', 'problem'])
  .describe('"note" for a remark, "todo" for work to do, "problem" for something wrong.');
export type MarkerKind = z.infer<typeof MarkerKind>;

export const Marker = z.object({
  id: z.string(),
  /** Where it is in the scene when it follows no piece, and where it was put. */
  atSeconds: z.number().min(0),
  /** The piece of picture it follows, if any. */
  itemId: z.string().nullable(),
  /** How far into that piece. */
  offsetSeconds: z.number().min(0),
  text: z.string().min(1).max(1000),
  kind: MarkerKind,
  done: z.boolean(),
  /** "person", or the role of the agent that wrote it. */
  by: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Marker = z.infer<typeof Marker>;

/** A marker where it is now, in its scene and in the whole film. */
export const PlacedMarker = Marker.extend({
  sceneId: z.string(),
  scenePosition: z.number(),
  filmSeconds: z.number(),
});
export type PlacedMarker = z.infer<typeof PlacedMarker>;

const round = (seconds: number): number => Math.round(seconds * 1000) / 1000;

const writeMarkers = async (
  store: KeyValueStore,
  projectId: string,
  sceneId: string,
  markers: readonly Marker[],
): Promise<void> => {
  await store.batch([{ type: 'put', key: markerKey(projectId, sceneId), value: markers }]);
};

async function readMarkers(store: KeyValueStore, projectId: string, sceneId: string) {
  const stored = await store.get(markerKey(projectId, sceneId));
  return stored === undefined ? [] : z.array(Marker).parse(stored);
}

/** The pieces of a scene's cut in time, to put markers on and find them again. */
async function piecesOf(store: KeyValueStore, projectId: string, sceneId: string) {
  const cut = await readCut(store, projectId, sceneId);
  return laidOut(store, projectId, await itemsOf(store, projectId, cut));
}

type Pieces = Awaited<ReturnType<typeof piecesOf>>;

/** The piece on screen at a moment: the later one where two overlap in a dissolve. */
function pieceAt(pieces: Pieces, seconds: number) {
  return pieces.items
    .filter(
      (item) =>
        item.durationSeconds > 0 &&
        seconds >= item.startsAtSeconds &&
        seconds < item.startsAtSeconds + item.durationSeconds,
    )
    .at(-1);
}

/** Ties a moment of the scene to the piece on screen then. */
function anchor(
  pieces: Pieces,
  seconds: number,
): Pick<Marker, 'atSeconds' | 'itemId' | 'offsetSeconds'> {
  const piece = pieceAt(pieces, seconds);
  return {
    atSeconds: round(seconds),
    itemId: piece?.itemId ?? null,
    offsetSeconds: piece === undefined ? 0 : round(seconds - piece.startsAtSeconds),
  };
}

/** Where a marker is now: on its piece if that is still in the cut, else where it was put. */
export function markerSeconds(marker: Marker, pieces: Pieces): number {
  const piece = pieces.items.find((item) => item.itemId === marker.itemId);
  if (piece === undefined) return Math.min(marker.atSeconds, pieces.totalSeconds);
  const into = Math.min(marker.offsetSeconds, Math.max(0, piece.durationSeconds - 0.001));
  return round(piece.startsAtSeconds + into);
}

const byOf = (actor: { kind: string; role?: string }): string =>
  actor.kind === 'agent' ? (actor.role ?? 'agent') : 'person';

async function scenesOf(store: KeyValueStore, projectId: string): Promise<Scene[]> {
  return (await store.list(movieSceneKey(projectId, '')))
    .map((entry) => Scene.parse(entry.value))
    .sort((a, b) => a.position - b.position);
}

/** Every marker of the film, or of one scene, where it is now, in film order. */
export async function placedMarkers(
  store: KeyValueStore,
  projectId: string,
  sceneId?: string,
): Promise<PlacedMarker[]> {
  const placed: PlacedMarker[] = [];
  let filmAt = 0;
  for (const scene of await scenesOf(store, projectId)) {
    const pieces = await piecesOf(store, projectId, scene.id);
    if (sceneId === undefined || scene.id === sceneId) {
      for (const marker of await readMarkers(store, projectId, scene.id)) {
        const at = markerSeconds(marker, pieces);
        placed.push({
          ...marker,
          atSeconds: at,
          sceneId: scene.id,
          scenePosition: scene.position,
          filmSeconds: round(filmAt + at),
        });
      }
    }
    filmAt += pieces.totalSeconds;
  }
  return placed.sort((a, b) => a.filmSeconds - b.filmSeconds);
}

export function createMarkerCommands(): readonly Command[] {
  const list = defineCommand({
    id: 'movie.edit.marker.list',
    title: 'List markers',
    description:
      'Lists the markers on the timeline: notes, to-dos and problems that people and agents left, with where each is in its scene and in the whole film. Leave sceneId out for the whole film; open: true lists only those not done.',
    effect: 'read',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId.optional(),
      open: z.boolean().optional().describe('Only markers that are not done.'),
    }),
    output: z.object({ markers: z.array(PlacedMarker) }),
    handler: async ({ runtime }, { projectId, sceneId, open }) => {
      const id = 'movie.edit.marker.list';
      if (sceneId === undefined) await requireProject(runtime.store, id, projectId, MODE_ID);
      else await requireScene(runtime.store, id, projectId, sceneId);
      const markers = await placedMarkers(runtime.store, projectId, sceneId);
      return { markers: open === true ? markers.filter((marker) => !marker.done) : markers };
    },
  });

  const add = defineCommand({
    id: 'movie.edit.marker.add',
    title: 'Add marker',
    description:
      'Leaves a marker at a moment of a scene: a note, a to-do or a problem, in words a person reads, such as "jump cut, the cup moves" or "needs a reaction shot here". It follows the piece of picture on screen at that moment. Markers are not edits: they show at once, also when your edits go into a draft.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      atSeconds: z.number().min(0).describe('Where in the scene, in seconds.'),
      text: z.string().min(1).max(1000),
      kind: MarkerKind.default('note'),
    }),
    output: z.object({ marker: PlacedMarker }),
    handler: async ({ runtime, actor }, { projectId, sceneId, atSeconds, text, kind }) => {
      await requireScene(runtime.store, 'movie.edit.marker.add', projectId, sceneId);
      const pieces = await piecesOf(runtime.store, projectId, sceneId);
      const now = runtime.now().toISOString();
      const marker: Marker = {
        id: runtime.newId(),
        ...anchor(pieces, Math.min(atSeconds, pieces.totalSeconds)),
        text,
        kind,
        done: false,
        by: byOf(actor),
        createdAt: now,
        updatedAt: now,
      };
      const markers = [...(await readMarkers(runtime.store, projectId, sceneId)), marker];
      await writeMarkers(runtime.store, projectId, sceneId, markers);
      const placed = await placedMarkers(runtime.store, projectId, sceneId);
      return { marker: placed.find((entry) => entry.id === marker.id) ?? placed[0] ?? fail() };
    },
  });

  const find = async (
    store: KeyValueStore,
    commandId: string,
    projectId: string,
    sceneId: string,
    markerId: string,
  ) => {
    await requireScene(store, commandId, projectId, sceneId);
    const markers = await readMarkers(store, projectId, sceneId);
    const index = markers.findIndex((marker) => marker.id === markerId);
    if (index < 0) {
      throw new CommandError('invalid_input', commandId, `No marker "${markerId}" in this scene.`);
    }
    return { markers, index };
  };

  const set = defineCommand({
    id: 'movie.edit.marker.set',
    title: 'Change marker',
    description:
      'Changes a marker: its words, its kind, whether it is done, or where it is (atSeconds, which ties it to the piece on screen there). Mark a to-do or problem done when it is fixed rather than removing it, so the person sees what was dealt with.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      markerId: MarkerId,
      text: z.string().min(1).max(1000).optional(),
      kind: MarkerKind.optional(),
      done: z.boolean().optional(),
      atSeconds: z.number().min(0).optional(),
    }),
    output: z.object({ marker: PlacedMarker }),
    handler: async ({ runtime }, input) => {
      const { projectId, sceneId, markerId } = input;
      const { markers, index } = await find(
        runtime.store,
        'movie.edit.marker.set',
        projectId,
        sceneId,
        markerId,
      );
      const before = markers[index] ?? fail();
      const pieces = await piecesOf(runtime.store, projectId, sceneId);
      const changed: Marker = {
        ...before,
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.done === undefined ? {} : { done: input.done }),
        ...(input.atSeconds === undefined
          ? {}
          : anchor(pieces, Math.min(input.atSeconds, pieces.totalSeconds))),
        updatedAt: runtime.now().toISOString(),
      };
      markers[index] = changed;
      await writeMarkers(runtime.store, projectId, sceneId, markers);
      const placed = await placedMarkers(runtime.store, projectId, sceneId);
      return { marker: placed.find((entry) => entry.id === markerId) ?? fail() };
    },
  });

  const remove = defineCommand({
    id: 'movie.edit.marker.remove',
    title: 'Remove marker',
    description: 'Takes a marker off the timeline.',
    effect: 'write',
    input: z.object({ projectId: ProjectId, sceneId: SceneId, markerId: MarkerId }),
    output: z.object({ markerId: z.string(), remaining: z.number() }),
    handler: async ({ runtime }, { projectId, sceneId, markerId }) => {
      const { markers, index } = await find(
        runtime.store,
        'movie.edit.marker.remove',
        projectId,
        sceneId,
        markerId,
      );
      markers.splice(index, 1);
      await writeMarkers(runtime.store, projectId, sceneId, markers);
      return { markerId, remaining: markers.length };
    },
  });

  return [list, add, set, remove];
}

/** For what cannot happen: a marker just written is always there. */
function fail(): never {
  throw new Error('The marker was not found after writing it.');
}
