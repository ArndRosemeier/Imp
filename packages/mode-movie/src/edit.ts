import {
  CommandError,
  defineCommand,
  requireProject,
  type Command,
  type CoreRuntime,
  type KeyValueStore,
} from '@imp/core';
import { mp3DurationSeconds, ProviderError, type GenerationProvider } from '@imp/providers';
import { z } from 'zod';
import {
  characterPrefix,
  editHistoryKey,
  editKey,
  linePrefix,
  movieSceneKey,
  shotPrefix,
  soundPrefix,
} from './commands.js';
import { SPEECH_MODEL_SETTING, voiceDirection } from './voice.js';
import {
  Character,
  CutHistory,
  CutItem,
  CutLine,
  MODE_ID,
  Scene,
  SceneCut,
  Shot,
  Sound,
  SoundPlacement,
} from './schema.js';

const ProjectId = z.string().describe('The id of a movie project from project.list.');
const SceneId = z
  .string()
  .describe('The id of the scene whose cut this is, from movie.scene.list.');
const ItemId = z.string().describe('The id of an item of the cut, from movie.edit.get.');

const round = (seconds: number): number => Math.round(seconds * 100) / 100;

/** The most steps of undo kept for a scene. */
const HISTORY_LIMIT = 50;
/** The shortest piece worth having: splitting nearer to an end than this is refused. */
const SHORTEST_SECONDS = 0.2;

/** What stands in the way of an item being part of the film. */
const ItemState = z.enum([
  'ready',
  'no_clip',
  'clip_pending',
  'clip_failed',
  'dialogue_missing',
  'dialogue_outdated',
  'shot_missing',
]);
type ItemState = z.infer<typeof ItemState>;

const shotKey = (projectId: string, sceneId: string, shotId: string): string =>
  `${shotPrefix(projectId, sceneId)}${shotId}`;

function stateOf(shot: Shot | undefined): ItemState {
  if (shot === undefined) return 'shot_missing';
  if (shot.clip === null) return 'no_clip';
  if (shot.clip.status === 'pending') return 'clip_pending';
  if (shot.clip.status === 'failed') return 'clip_failed';
  const speaks = shot.speakerId !== null && shot.line.trim() !== '';
  if (speaks && shot.dialogue === null && shot.clip.silent) return 'dialogue_missing';
  if (shot.dialogue !== null && shot.dialogue.line !== shot.line) return 'dialogue_outdated';
  return 'ready';
}

/** How long the whole clip of a shot plays, before trims. */
const clipSeconds = (shot: Shot): number =>
  shot.clip?.durationSeconds ?? shot.dialogue?.durationSeconds ?? 0;

async function readShots(store: KeyValueStore, projectId: string, sceneId: string) {
  return (await store.list(shotPrefix(projectId, sceneId)))
    .map((entry) => Shot.parse(entry.value))
    .sort((a, b) => a.position - b.position);
}

async function loadShot(store: KeyValueStore, projectId: string, sceneId: string, shotId: string) {
  const stored = await store.get(shotKey(projectId, sceneId, shotId));
  return stored === undefined ? undefined : Shot.parse(stored);
}

export async function requireScene(
  store: KeyValueStore,
  commandId: string,
  projectId: string,
  sceneId: string,
): Promise<Scene> {
  await requireProject(store, commandId, projectId, MODE_ID);
  const stored = await store.get(movieSceneKey(projectId, sceneId));
  if (stored === undefined) {
    throw new CommandError('invalid_input', commandId, `No scene "${sceneId}".`);
  }
  return Scene.parse(stored);
}

const wholeShot = (shot: Shot): CutItem => ({
  // The shot's own id, so that the default cut has the same ids every time it is read.
  id: shot.id,
  kind: 'shot',
  sceneId: shot.sceneId,
  shotId: shot.id,
  trimStartSeconds: 0,
  trimEndSeconds: 0,
  dialogueVolume: 1,
  clipAudioVolume: 1,
  fadeInSeconds: 0,
  fadeOutSeconds: 0,
  text: '',
  titleSeconds: 3,
});

/** The items of a cut: as stored, or the scene's shots in order, whole. */
export async function itemsOf(
  store: KeyValueStore,
  projectId: string,
  cut: SceneCut,
): Promise<CutItem[]> {
  if (cut.items !== null) return cut.items;
  return (await readShots(store, projectId, cut.sceneId)).map(wholeShot);
}

export async function readCut(
  store: KeyValueStore,
  projectId: string,
  sceneId: string,
): Promise<SceneCut> {
  const stored = await store.get(editKey(projectId, sceneId));
  return stored === undefined ? SceneCut.parse({ sceneId }) : SceneCut.parse(stored);
}

/**
 * The items laid out in time, one after the other. A shot item lasts as long
 * as its clip less the trims, and a title as long as it says; items whose
 * clip is not ready take no time and are not in the film.
 */
async function layOut(store: KeyValueStore, projectId: string, items: readonly CutItem[]) {
  let at = 0;
  const laid = [];
  for (const [index, item] of items.entries()) {
    const shot =
      item.kind === 'shot'
        ? await loadShot(store, projectId, item.sceneId, item.shotId)
        : undefined;
    const state: ItemState = item.kind === 'title' ? 'ready' : stateOf(shot);
    const duration =
      item.kind === 'title'
        ? item.titleSeconds
        : shot?.clip?.status === 'ready'
          ? Math.max(0, clipSeconds(shot) - item.trimStartSeconds - item.trimEndSeconds)
          : 0;
    laid.push({
      itemId: item.id,
      kind: item.kind,
      index: index + 1,
      sceneId: item.sceneId,
      shotId: item.shotId,
      label: item.kind === 'title' ? item.text : (shot?.description ?? ''),
      state,
      trimStartSeconds: item.trimStartSeconds,
      trimEndSeconds: item.trimEndSeconds,
      dialogueVolume: item.dialogueVolume,
      clipAudioVolume: item.clipAudioVolume,
      /** Whether the clip has a sound of its own that can be taken apart. */
      hasClipAudio: shot?.clip?.status === 'ready' && !shot.clip.silent,
      fadeInSeconds: item.fadeInSeconds,
      fadeOutSeconds: item.fadeOutSeconds,
      text: item.text,
      startsAtSeconds: round(at),
      durationSeconds: round(duration),
      /** How long the clip is before trims, for a split point to be chosen within. */
      sourceSeconds: shot === undefined ? 0 : round(clipSeconds(shot)),
    });
    at += duration;
  }
  return { items: laid, totalSeconds: round(at) };
}

/** Where each item starts and how long it plays, for the audio editor. */
export async function itemTimes(
  store: KeyValueStore,
  projectId: string,
  items: readonly CutItem[],
): Promise<{
  items: { startsAtSeconds: number; durationSeconds: number }[];
  totalSeconds: number;
}> {
  return layOut(store, projectId, items);
}

const LineView = CutLine.extend({
  /** Whether a recording exists. */
  recorded: z.boolean(),
  /** The words changed after the recording was made. */
  outdated: z.boolean(),
  durationSeconds: z.number(),
});

function lineView(line: CutLine): z.infer<typeof LineView> {
  return {
    ...line,
    recorded: line.take !== null,
    outdated: line.take !== null && line.take.line !== line.text,
    durationSeconds: line.take?.durationSeconds ?? 0,
  };
}

/** The characters that have a lane of their own, in the order they were cast. */
async function ownLaneCharacters(store: KeyValueStore, projectId: string) {
  return (await store.list(characterPrefix(projectId)))
    .map((entry) => Character.parse(entry.value))
    .filter((character) => character.ownLane);
}

/** Writes a cut, and keeps what it was so that the change can be undone. */
export async function save(
  runtime: CoreRuntime,
  projectId: string,
  before: SceneCut,
  after: SceneCut,
): Promise<void> {
  const key = editHistoryKey(projectId, after.sceneId);
  const stored = await runtime.store.get(key);
  const history = stored === undefined ? CutHistory.parse({}) : CutHistory.parse(stored);
  await runtime.store.batch([
    { type: 'put', key: editKey(projectId, after.sceneId), value: after },
    {
      type: 'put',
      key,
      value: { undo: [...history.undo, before].slice(-HISTORY_LIMIT), redo: [] },
    },
  ]);
}

const TrimFields = {
  trimStartSeconds: z.number().min(0).max(600).optional(),
  trimEndSeconds: z.number().min(0).max(600).optional(),
  dialogueVolume: z.number().min(0).max(1).optional(),
  clipAudioVolume: z.number().min(0).max(1).optional(),
  fadeInSeconds: z.number().min(0).max(30).optional(),
  fadeOutSeconds: z.number().min(0).max(30).optional(),
};

const PlacementFields = SoundPlacement.pick({
  startSeconds: true,
  volume: true,
  fadeInSeconds: true,
  fadeOutSeconds: true,
  loop: true,
  trimStartSeconds: true,
  pan: true,
  gainDb: true,
  fadeCurve: true,
});

const InsertAt = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('Where in the cut it goes, counted from 0. Defaults to the end.');

/** The commands that put the pieces of a film together. Nothing here spends money. */
export function createEditCommands(provider: GenerationProvider): readonly Command[] {
  async function open(runtime: CoreRuntime, commandId: string, projectId: string, sceneId: string) {
    await requireScene(runtime.store, commandId, projectId, sceneId);
    const cut = await readCut(runtime.store, projectId, sceneId);
    return { cut, items: await itemsOf(runtime.store, projectId, cut) };
  }

  /** A cut is saved with explicit items, so that what was seen is what is kept. */
  const withItems = (cut: SceneCut, items: readonly CutItem[]): SceneCut => ({
    ...cut,
    items: [...items],
  });

  function indexOfItem(items: readonly CutItem[], commandId: string, itemId: string): number {
    const index = items.findIndex((item) => item.id === itemId);
    if (index < 0) {
      throw new CommandError('invalid_input', commandId, `No item "${itemId}" in this cut.`);
    }
    return index;
  }

  /** The item at an index that was just found, which is always there. */
  function itemAt(items: readonly CutItem[], index: number): CutItem {
    const item = items[index];
    if (item === undefined) throw new Error('The item went missing between two lines.');
    return item;
  }

  const insertedAt = <T>(list: readonly T[], at: number | undefined, value: T): T[] => {
    const index = at === undefined ? list.length : Math.min(at, list.length);
    return [...list.slice(0, index), value, ...list.slice(index)];
  };

  const get = defineCommand({
    id: 'movie.edit.get',
    title: 'Read cut',
    description:
      'Returns the cut of a scene. Picture: its items in playing order, each with its start and length on the scene timeline and whether it is ready for the film or what is missing (no clip, clip pending or failed, dialogue missing or out of date), and the shots of the scene that are not in the cut. Sound: the audio lane of placed sounds, clip sounds that were taken apart and dialogue, each with its own start, volume and fades. Also whether undo or redo is possible. The total counts items with a ready clip only.',
    effect: 'read',
    input: z.object({ projectId: ProjectId, sceneId: SceneId }),
    output: z.object({
      sceneId: z.string(),
      totalSeconds: z.number(),
      canUndo: z.boolean(),
      canRedo: z.boolean(),
      items: z.array(
        z.object({
          itemId: z.string(),
          kind: z.enum(['shot', 'title']),
          index: z.number(),
          sceneId: z.string(),
          shotId: z.string(),
          label: z.string(),
          state: ItemState,
          trimStartSeconds: z.number(),
          trimEndSeconds: z.number(),
          dialogueVolume: z.number(),
          clipAudioVolume: z.number(),
          hasClipAudio: z.boolean(),
          fadeInSeconds: z.number(),
          fadeOutSeconds: z.number(),
          text: z.string(),
          startsAtSeconds: z.number(),
          durationSeconds: z.number(),
          sourceSeconds: z.number(),
        }),
      ),
      unplaced: z.array(
        z.object({ shotId: z.string(), position: z.number(), description: z.string() }),
      ),
      sounds: z.array(
        SoundPlacement.extend({
          name: z.string(),
          kind: z.enum(['effect', 'music', 'clip', 'dialogue']),
          recorded: z.boolean(),
        }),
      ),
      lanes: z.array(
        z.object({ characterId: z.string(), name: z.string(), voiceOnly: z.boolean() }),
      ),
      lines: z.array(LineView),
    }),
    handler: async ({ runtime }, { projectId, sceneId }) => {
      const { cut, items } = await open(runtime, 'movie.edit.get', projectId, sceneId);
      const laid = await layOut(runtime.store, projectId, items);
      const sounds = (await runtime.store.list(soundPrefix(projectId, sceneId))).map((entry) =>
        Sound.parse(entry.value),
      );
      const used = new Set(items.map((item) => item.shotId));
      const stored = await runtime.store.get(editHistoryKey(projectId, sceneId));
      const history = stored === undefined ? CutHistory.parse({}) : CutHistory.parse(stored);
      const lane = [];
      for (const placement of cut.sounds) {
        if (placement.source === 'sound') {
          const sound = sounds.find((candidate) => candidate.id === placement.soundId);
          // A placement of a sound that was deleted since is not shown.
          if (sound === undefined) continue;
          lane.push({
            ...placement,
            name: sound.name,
            kind: sound.kind,
            recorded: sound.take !== null,
          });
          continue;
        }
        // Stored files are the audio editor's own sources; a scene's lane does not hold them.
        if (placement.source === 'file') continue;
        const shot = await loadShot(runtime.store, projectId, placement.sceneId, placement.shotId);
        if (shot === undefined) continue;
        lane.push({
          ...placement,
          name: `${placement.source === 'clip' ? 'Clip sound' : 'Dialogue'} of shot ${String(shot.position)}`,
          kind: placement.source,
          recorded:
            placement.source === 'clip'
              ? shot.clip?.status === 'ready' && !shot.clip.silent
              : shot.dialogue !== null,
        });
      }
      return {
        sceneId,
        totalSeconds: laid.totalSeconds,
        canUndo: history.undo.length > 0,
        canRedo: history.redo.length > 0,
        items: laid.items,
        // Only once the cut is explicit: before that every shot is in it.
        unplaced:
          cut.items === null
            ? []
            : (await readShots(runtime.store, projectId, sceneId))
                .filter((shot) => !used.has(shot.id))
                .map((shot) => ({
                  shotId: shot.id,
                  position: shot.position,
                  description: shot.description,
                })),
        sounds: lane,
        lanes: (await ownLaneCharacters(runtime.store, projectId)).map((character) => ({
          characterId: character.id,
          name: character.name,
          voiceOnly: character.voiceOnly,
        })),
        lines: cut.lines.map((line) => lineView(line)),
      };
    },
  });

  const add = defineCommand({
    id: 'movie.edit.item.add',
    title: 'Add shot to cut',
    description:
      'Puts a shot into the cut of a scene, whole, at a place in the order. The shot may belong to another scene (paste across scenes), and the same shot can be added many times.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      shotId: z.string(),
      shotSceneId: z
        .string()
        .optional()
        .describe('The scene the shot belongs to, when it is not the scene of this cut.'),
      toIndex: InsertAt,
    }),
    output: z.object({ item: CutItem }),
    handler: async ({ runtime }, input) => {
      const id = 'movie.edit.item.add';
      const { cut, items } = await open(runtime, id, input.projectId, input.sceneId);
      const shot = await loadShot(
        runtime.store,
        input.projectId,
        input.shotSceneId ?? input.sceneId,
        input.shotId,
      );
      if (shot === undefined) {
        throw new CommandError('invalid_input', id, `No shot "${input.shotId}" in that scene.`);
      }
      const item: CutItem = { ...wholeShot(shot), id: runtime.newId() };
      await save(
        runtime,
        input.projectId,
        cut,
        withItems(cut, insertedAt(items, input.toIndex, item)),
      );
      return { item };
    },
  });

  const addTitle = defineCommand({
    id: 'movie.edit.title.add',
    title: 'Add title card',
    description:
      'Puts a title card, white words on black, into the cut: a film title, a place and time, credits.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      text: z.string().min(1).max(500),
      seconds: z.number().min(0.5).max(60).default(3),
      toIndex: InsertAt,
    }),
    output: z.object({ item: CutItem }),
    handler: async ({ runtime }, input) => {
      const { cut, items } = await open(
        runtime,
        'movie.edit.title.add',
        input.projectId,
        input.sceneId,
      );
      const item: CutItem = {
        id: runtime.newId(),
        kind: 'title',
        sceneId: '',
        shotId: '',
        trimStartSeconds: 0,
        trimEndSeconds: 0,
        dialogueVolume: 1,
        clipAudioVolume: 1,
        fadeInSeconds: 0.5,
        fadeOutSeconds: 0.5,
        text: input.text,
        titleSeconds: input.seconds,
      };
      await save(
        runtime,
        input.projectId,
        cut,
        withItems(cut, insertedAt(items, input.toIndex, item)),
      );
      return { item };
    },
  });

  const setItem = defineCommand({
    id: 'movie.edit.item.set',
    title: 'Change item',
    description:
      "Changes an item of the cut: seconds trimmed off its start and end, the volume of its dialogue and of the clip's own sound (0 silences either), fades from and to black at its edges, and for a title card its words and length. Fields left out stay as they are.",
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      itemId: ItemId,
      ...TrimFields,
      text: z.string().min(1).max(500).optional(),
      titleSeconds: z.number().min(0.5).max(60).optional(),
    }),
    output: z.object({ item: CutItem }),
    handler: async ({ runtime }, { projectId, sceneId, itemId, ...changes }) => {
      const id = 'movie.edit.item.set';
      const { cut, items } = await open(runtime, id, projectId, sceneId);
      const index = indexOfItem(items, id, itemId);
      const before = itemAt(items, index);
      const item: CutItem = {
        ...before,
        trimStartSeconds: changes.trimStartSeconds ?? before.trimStartSeconds,
        trimEndSeconds: changes.trimEndSeconds ?? before.trimEndSeconds,
        dialogueVolume: changes.dialogueVolume ?? before.dialogueVolume,
        clipAudioVolume: changes.clipAudioVolume ?? before.clipAudioVolume,
        fadeInSeconds: changes.fadeInSeconds ?? before.fadeInSeconds,
        fadeOutSeconds: changes.fadeOutSeconds ?? before.fadeOutSeconds,
        text: changes.text ?? before.text,
        titleSeconds: changes.titleSeconds ?? before.titleSeconds,
      };
      await save(
        runtime,
        projectId,
        cut,
        withItems(
          cut,
          items.map((candidate, at) => (at === index ? item : candidate)),
        ),
      );
      return { item };
    },
  });

  const move = defineCommand({
    id: 'movie.edit.item.move',
    title: 'Move item',
    description:
      'Moves an item to another place in the order of the cut. toIndex counts from 0 in the cut as it is after the item is taken out.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      itemId: ItemId,
      toIndex: z.number().int().min(0),
    }),
    output: z.object({ itemId: z.string(), index: z.number() }),
    handler: async ({ runtime }, { projectId, sceneId, itemId, toIndex }) => {
      const id = 'movie.edit.item.move';
      const { cut, items } = await open(runtime, id, projectId, sceneId);
      const index = indexOfItem(items, id, itemId);
      const rest = items.filter((_, at) => at !== index);
      const to = Math.min(toIndex, rest.length);
      await save(
        runtime,
        projectId,
        cut,
        withItems(cut, insertedAt(rest, to, itemAt(items, index))),
      );
      return { itemId, index: to };
    },
  });

  const duplicate = defineCommand({
    id: 'movie.edit.item.duplicate',
    title: 'Copy item',
    description:
      'Copies an item, with its trims and fades, and puts the copy at a place in the cut: right after the original when toIndex is left out. This is copy and paste; remove the original for cut and paste. With toSceneId the copy goes into the cut of another scene, at toIndex or its end.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      itemId: ItemId,
      toIndex: InsertAt,
      toSceneId: z.string().optional(),
    }),
    output: z.object({ item: CutItem, sceneId: z.string() }),
    handler: async ({ runtime }, input) => {
      const id = 'movie.edit.item.duplicate';
      const { cut, items } = await open(runtime, id, input.projectId, input.sceneId);
      const index = indexOfItem(items, id, input.itemId);
      const copy: CutItem = { ...itemAt(items, index), id: runtime.newId() };
      const target = input.toSceneId ?? input.sceneId;
      if (target === input.sceneId) {
        await save(
          runtime,
          input.projectId,
          cut,
          withItems(cut, insertedAt(items, input.toIndex ?? index + 1, copy)),
        );
      } else {
        const other = await open(runtime, id, input.projectId, target);
        await save(
          runtime,
          input.projectId,
          other.cut,
          withItems(other.cut, insertedAt(other.items, input.toIndex, copy)),
        );
      }
      return { item: copy, sceneId: target };
    },
  });

  const remove = defineCommand({
    id: 'movie.edit.item.remove',
    title: 'Remove item',
    description:
      'Takes an item out of the cut. A shot stays in the scene and can be added again; it then shows under "unplaced".',
    effect: 'destructive',
    input: z.object({ projectId: ProjectId, sceneId: SceneId, itemId: ItemId }),
    output: z.object({ itemId: z.string(), remaining: z.number() }),
    handler: async ({ runtime }, { projectId, sceneId, itemId }) => {
      const id = 'movie.edit.item.remove';
      const { cut, items } = await open(runtime, id, projectId, sceneId);
      indexOfItem(items, id, itemId);
      const rest = items.filter((item) => item.id !== itemId);
      await save(runtime, projectId, cut, withItems(cut, rest));
      return { itemId, remaining: rest.length };
    },
  });

  const split = defineCommand({
    id: 'movie.edit.item.split',
    title: 'Split item',
    description:
      'Cuts an item in two at a time within it, counted in seconds from the start of the item as it plays (after its trim). The two pieces stay next to each other and can then be trimmed, moved or removed on their own.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      itemId: ItemId,
      atSeconds: z.number().positive(),
    }),
    output: z.object({ first: CutItem, second: CutItem }),
    handler: async ({ runtime }, { projectId, sceneId, itemId, atSeconds }) => {
      const id = 'movie.edit.item.split';
      const { cut, items } = await open(runtime, id, projectId, sceneId);
      const index = indexOfItem(items, id, itemId);
      const item = itemAt(items, index);
      if (item.kind !== 'shot') {
        throw new CommandError('invalid_input', id, 'A title card cannot be split.');
      }
      const shot = await loadShot(runtime.store, projectId, item.sceneId, item.shotId);
      if (shot === undefined || clipSeconds(shot) === 0) {
        throw new CommandError('invalid_input', id, 'This item has no clip to split yet.');
      }
      const length = clipSeconds(shot) - item.trimStartSeconds - item.trimEndSeconds;
      if (atSeconds < SHORTEST_SECONDS || atSeconds > length - SHORTEST_SECONDS) {
        throw new CommandError(
          'invalid_input',
          id,
          `Split between ${String(SHORTEST_SECONDS)} and ${String(round(length - SHORTEST_SECONDS))} seconds; the item plays ${String(round(length))}.`,
        );
      }
      const first: CutItem = {
        ...item,
        trimEndSeconds: round(item.trimEndSeconds + length - atSeconds),
        fadeOutSeconds: 0,
      };
      const second: CutItem = {
        ...item,
        id: runtime.newId(),
        trimStartSeconds: round(item.trimStartSeconds + atSeconds),
        fadeInSeconds: 0,
      };
      await save(
        runtime,
        projectId,
        cut,
        withItems(cut, [...items.slice(0, index), first, second, ...items.slice(index + 1)]),
      );
      return { first, second };
    },
  });

  const detach = defineCommand({
    id: 'movie.edit.audio.detach',
    title: 'Take clip sound apart',
    description:
      "Takes the sound of an item's clip off its picture and puts it in the audio lane at the same time, so that picture and sound can be trimmed, moved, faded and mixed on their own, for example to let a line start before its shot (a J cut) or to keep ambience under the next shot. The picture goes on without that sound. Only clips with a sound of their own have one to take; clips made silent have none.",
    effect: 'write',
    input: z.object({ projectId: ProjectId, sceneId: SceneId, itemId: ItemId }),
    output: SoundPlacement,
    handler: async ({ runtime }, { projectId, sceneId, itemId }) => {
      const id = 'movie.edit.audio.detach';
      const { cut, items } = await open(runtime, id, projectId, sceneId);
      const index = indexOfItem(items, id, itemId);
      const item = itemAt(items, index);
      const laid = (await layOut(runtime.store, projectId, items)).items[index];
      if (item.kind !== 'shot' || !laid?.hasClipAudio) {
        throw new CommandError(
          'invalid_input',
          id,
          'This item has no sound of its own to take apart: it is a title, has no ready clip, or its clip was made silent.',
        );
      }
      const placement = SoundPlacement.parse({
        id: runtime.newId(),
        source: 'clip',
        soundId: '',
        sceneId: item.sceneId,
        shotId: item.shotId,
        trimStartSeconds: item.trimStartSeconds,
        startSeconds: laid.startsAtSeconds,
        volume: item.clipAudioVolume,
        fadeInSeconds: item.fadeInSeconds,
        fadeOutSeconds: item.fadeOutSeconds,
        loop: false,
      });
      await save(runtime, projectId, cut, {
        ...cut,
        items: items.map((candidate, at) =>
          at === index ? { ...candidate, clipAudioVolume: 0 } : candidate,
        ),
        sounds: [...cut.sounds, placement],
      });
      return placement;
    },
  });

  const place = defineCommand({
    id: 'movie.edit.sound.place',
    title: 'Place sound',
    description:
      'Lays a sound on the audio lane of the scene at a start time in seconds, with a volume and fades. By default a sound of the scene (soundId, from movie.sound.list). With source "dialogue" it lays the recorded dialogue of a shot (shotId) anywhere, and with source "clip" the own sound of a shot\'s clip. A sound can be placed more than once. Music belongs quieter than dialogue, around 0.3 to 0.5.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      source: z.enum(['sound', 'clip', 'dialogue']).default('sound'),
      soundId: z.string().optional().describe('For source "sound".'),
      shotId: z.string().optional().describe('For the sources "clip" and "dialogue".'),
      shotSceneId: z
        .string()
        .optional()
        .describe('The scene of that shot, when it is another one.'),
      startSeconds: z.number().min(0).max(36000).default(0),
      trimStartSeconds: z.number().min(0).max(600).default(0),
      volume: z.number().min(0).max(1).default(1),
      fadeInSeconds: z.number().min(0).max(60).default(0),
      fadeOutSeconds: z.number().min(0).max(60).default(0),
      loop: z.boolean().default(false).describe('Repeat until the scene ends.'),
    }),
    output: SoundPlacement,
    handler: async ({ runtime }, input) => {
      const id = 'movie.edit.sound.place';
      const { projectId, sceneId, soundId, shotId, shotSceneId, ...fields } = input;
      const { cut } = await open(runtime, id, projectId, sceneId);
      const source = await (async () => {
        if (fields.source === 'sound') {
          if (
            soundId === undefined ||
            (await runtime.store.get(`${soundPrefix(projectId, sceneId)}${soundId}`)) === undefined
          ) {
            throw new CommandError(
              'invalid_input',
              id,
              `No sound "${soundId ?? ''}" in that scene.`,
            );
          }
          return { soundId, sceneId: '', shotId: '' };
        }
        const from = shotSceneId ?? sceneId;
        const shot =
          shotId === undefined ? undefined : await loadShot(runtime.store, projectId, from, shotId);
        if (shot === undefined) {
          throw new CommandError('invalid_input', id, `No shot "${shotId ?? ''}" in that scene.`);
        }
        if (fields.source === 'dialogue' && shot.dialogue === null) {
          throw new CommandError('invalid_input', id, 'That shot has no recorded dialogue yet.');
        }
        return { soundId: '', sceneId: from, shotId: shot.id };
      })();
      const placement = SoundPlacement.parse({ id: runtime.newId(), ...fields, ...source });
      await save(runtime, projectId, cut, { ...cut, sounds: [...cut.sounds, placement] });
      return placement;
    },
  });

  const updateSound = defineCommand({
    id: 'movie.edit.sound.update',
    title: 'Change placed sound',
    description:
      'Changes where, how loud and from where in the source a placed sound plays, and its pan (-1 left to 1 right, 0 is the middle), extra gain in dB and the shape of its fades. Fields left out stay as they are.',
    effect: 'write',
    input: PlacementFields.partial().extend({
      projectId: ProjectId,
      sceneId: SceneId,
      placementId: z.string().describe('The id of a placement from movie.edit.get.'),
    }),
    output: SoundPlacement,
    handler: async ({ runtime }, { projectId, sceneId, placementId, ...changes }) => {
      const id = 'movie.edit.sound.update';
      const { cut } = await open(runtime, id, projectId, sceneId);
      const before = cut.sounds.find((placement) => placement.id === placementId);
      if (before === undefined) {
        throw new CommandError('invalid_input', id, `No placement "${placementId}".`);
      }
      const next: SoundPlacement = {
        ...before,
        startSeconds: changes.startSeconds ?? before.startSeconds,
        trimStartSeconds: changes.trimStartSeconds ?? before.trimStartSeconds,
        volume: changes.volume ?? before.volume,
        fadeInSeconds: changes.fadeInSeconds ?? before.fadeInSeconds,
        fadeOutSeconds: changes.fadeOutSeconds ?? before.fadeOutSeconds,
        loop: changes.loop ?? before.loop,
        pan: changes.pan ?? before.pan,
        gainDb: changes.gainDb ?? before.gainDb,
        fadeCurve: changes.fadeCurve ?? before.fadeCurve,
      };
      await save(runtime, projectId, cut, {
        ...cut,
        sounds: cut.sounds.map((placement) => (placement.id === placementId ? next : placement)),
      });
      return next;
    },
  });

  const removeSound = defineCommand({
    id: 'movie.edit.sound.remove',
    title: 'Remove placed sound',
    description: 'Takes a sound off the audio lane. The sound itself stays where it came from.',
    effect: 'destructive',
    input: z.object({ projectId: ProjectId, sceneId: SceneId, placementId: z.string() }),
    output: z.object({ placementId: z.string(), removed: z.boolean() }),
    handler: async ({ runtime }, { projectId, sceneId, placementId }) => {
      const { cut } = await open(runtime, 'movie.edit.sound.remove', projectId, sceneId);
      const sounds = cut.sounds.filter((placement) => placement.id !== placementId);
      if (sounds.length === cut.sounds.length) return { placementId, removed: false };
      await save(runtime, projectId, cut, { ...cut, sounds });
      return { placementId, removed: true };
    },
  });

  const LineFields = {
    text: z.string().min(1).max(4000).optional(),
    delivery: z.string().max(500).optional(),
    startSeconds: z.number().min(0).max(36000).optional(),
    trimStartSeconds: z.number().min(0).max(600).optional(),
    volume: z.number().min(0).max(1).optional(),
    fadeInSeconds: z.number().min(0).max(60).optional(),
    fadeOutSeconds: z.number().min(0).max(60).optional(),
  };

  const lineAdd = defineCommand({
    id: 'movie.edit.line.add',
    title: 'Add line to a character lane',
    description:
      'Adds a line of text to the lane of a character that has its own lane (characters with ownLane, for example a narrator; set it with movie.character.update). The line belongs to no shot: it is placed in time on that lane. Record it with movie.edit.line.record.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      characterId: z.string().describe('A character with its own lane, from movie.character.list.'),
      text: z.string().min(1).max(4000),
      delivery: z.string().max(500).default(''),
      startSeconds: z.number().min(0).max(36000).default(0),
      volume: z.number().min(0).max(1).default(1),
    }),
    output: CutLine,
    handler: async ({ runtime }, { projectId, sceneId, characterId, ...fields }) => {
      const id = 'movie.edit.line.add';
      const { cut } = await open(runtime, id, projectId, sceneId);
      const lane = (await ownLaneCharacters(runtime.store, projectId)).find(
        (character) => character.id === characterId,
      );
      if (lane === undefined) {
        throw new CommandError(
          'invalid_input',
          id,
          `"${characterId}" is not a character with its own lane. Set ownLane on the character first.`,
        );
      }
      const line = CutLine.parse({ id: runtime.newId(), characterId, ...fields });
      await save(runtime, projectId, cut, { ...cut, lines: [...cut.lines, line] });
      return line;
    },
  });

  function lineIn(cut: SceneCut, commandId: string, lineId: string): CutLine {
    const line = cut.lines.find((candidate) => candidate.id === lineId);
    if (line === undefined) {
      throw new CommandError('invalid_input', commandId, `No line "${lineId}" in this scene.`);
    }
    return line;
  }

  const lineUpdate = defineCommand({
    id: 'movie.edit.line.update',
    title: 'Change line',
    description:
      'Changes the words, delivery, start, trim, volume or fades of a line on a character lane. Fields left out stay as they are. After changing the words the recording is out of date: record it again.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      lineId: z.string().describe('The id of a line from movie.edit.get.'),
      ...LineFields,
    }),
    output: CutLine,
    handler: async ({ runtime }, { projectId, sceneId, lineId, ...changes }) => {
      const { cut } = await open(runtime, 'movie.edit.line.update', projectId, sceneId);
      const before = lineIn(cut, 'movie.edit.line.update', lineId);
      const next: CutLine = {
        ...before,
        text: changes.text ?? before.text,
        delivery: changes.delivery ?? before.delivery,
        startSeconds: changes.startSeconds ?? before.startSeconds,
        trimStartSeconds: changes.trimStartSeconds ?? before.trimStartSeconds,
        volume: changes.volume ?? before.volume,
        fadeInSeconds: changes.fadeInSeconds ?? before.fadeInSeconds,
        fadeOutSeconds: changes.fadeOutSeconds ?? before.fadeOutSeconds,
      };
      await save(runtime, projectId, cut, {
        ...cut,
        lines: cut.lines.map((line) => (line.id === lineId ? next : line)),
      });
      return next;
    },
  });

  const lineRecord = defineCommand({
    id: 'movie.edit.line.record',
    title: 'Record line',
    description:
      'Speaks a line in the voice of its character, with its delivery, and keeps the recording on the line. It replaces an earlier recording. Costs a cent or less at the speech model (setting speech.model). Earlier recordings stay stored so that undo still works.',
    effect: 'spend',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      lineId: z.string(),
      model: z
        .string()
        .min(1)
        .optional()
        .describe('A speech model from models.list. Defaults to the setting speech.model.'),
    }),
    output: LineView,
    handler: async ({ runtime }, { projectId, sceneId, lineId, model: chosen }) => {
      const id = 'movie.edit.line.record';
      const { cut } = await open(runtime, id, projectId, sceneId);
      const line = lineIn(cut, id, lineId);
      const model = chosen ?? (await runtime.store.get(`settings/${SPEECH_MODEL_SETTING}`));
      if (typeof model !== 'string' || model === '') {
        throw new CommandError(
          'invalid_input',
          id,
          `No speech model is chosen. Set the setting "${SPEECH_MODEL_SETTING}" or pass a model.`,
        );
      }
      const stored = await runtime.store.get(`${characterPrefix(projectId)}${line.characterId}`);
      if (stored === undefined) {
        throw new CommandError('invalid_input', id, 'The character of this line was deleted.');
      }
      const direction = voiceDirection(Character.parse(stored), line.delivery);
      let spoken;
      try {
        spoken = await provider.generateSpeech({
          model,
          text: line.text.trim(),
          instructions: direction,
        });
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        throw new CommandError('handler_failed', id, `No line was recorded: ${error.message}`, {
          cause: error,
        });
      }
      const take = {
        blobKey: `${linePrefix(projectId, sceneId)}${runtime.newId()}`,
        mediaType: spoken.audio.mediaType,
        line: line.text,
        direction,
        model,
        durationSeconds: mp3DurationSeconds(spoken.audio.bytes),
        costUsd: spoken.costUsd,
        createdAt: runtime.now().toISOString(),
      };
      await runtime.blobs.put(take.blobKey, spoken.audio);
      // The cut may have changed while the voice was made.
      const latest = (await open(runtime, id, projectId, sceneId)).cut;
      const current = lineIn(latest, id, lineId);
      const next: CutLine = { ...current, take };
      await save(runtime, projectId, latest, {
        ...latest,
        lines: latest.lines.map((candidate) => (candidate.id === lineId ? next : candidate)),
      });
      return lineView(next);
    },
  });

  const lineRemove = defineCommand({
    id: 'movie.edit.line.remove',
    title: 'Remove line',
    description: 'Takes a line off its lane. Undo brings it back.',
    effect: 'destructive',
    input: z.object({ projectId: ProjectId, sceneId: SceneId, lineId: z.string() }),
    output: z.object({ lineId: z.string(), removed: z.boolean() }),
    handler: async ({ runtime }, { projectId, sceneId, lineId }) => {
      const { cut } = await open(runtime, 'movie.edit.line.remove', projectId, sceneId);
      const lines = cut.lines.filter((line) => line.id !== lineId);
      if (lines.length === cut.lines.length) return { lineId, removed: false };
      await save(runtime, projectId, cut, { ...cut, lines });
      return { lineId, removed: true };
    },
  });

  /** Moves one step along the history of a scene's cut, in either direction. */
  async function step(
    runtime: CoreRuntime,
    commandId: string,
    projectId: string,
    sceneId: string,
    direction: 'undo' | 'redo',
  ): Promise<boolean> {
    await requireScene(runtime.store, commandId, projectId, sceneId);
    const cut = await readCut(runtime.store, projectId, sceneId);
    const key = editHistoryKey(projectId, sceneId);
    const stored = await runtime.store.get(key);
    const history = stored === undefined ? CutHistory.parse({}) : CutHistory.parse(stored);
    const from = direction === 'undo' ? history.undo : history.redo;
    const target = from.at(-1);
    if (target === undefined) return false;
    const rest = from.slice(0, -1);
    const other = [...(direction === 'undo' ? history.redo : history.undo), cut];
    await runtime.store.batch([
      { type: 'put', key: editKey(projectId, sceneId), value: target },
      {
        type: 'put',
        key,
        value: direction === 'undo' ? { undo: rest, redo: other } : { undo: other, redo: rest },
      },
    ]);
    return true;
  }

  const stepInput = z.object({ projectId: ProjectId, sceneId: SceneId });
  const stepOutput = z.object({ done: z.boolean() });
  const undo = defineCommand({
    id: 'movie.edit.undo',
    title: 'Undo edit',
    description:
      'Undoes the last change to the cut of a scene, picture or sound. done is false when there is nothing to undo.',
    effect: 'write',
    input: stepInput,
    output: stepOutput,
    handler: async ({ runtime }, { projectId, sceneId }) => ({
      done: await step(runtime, 'movie.edit.undo', projectId, sceneId, 'undo'),
    }),
  });
  const redo = defineCommand({
    id: 'movie.edit.redo',
    title: 'Redo edit',
    description: 'Redoes a change that was undone. done is false when there is nothing to redo.',
    effect: 'write',
    input: stepInput,
    output: stepOutput,
    handler: async ({ runtime }, { projectId, sceneId }) => ({
      done: await step(runtime, 'movie.edit.redo', projectId, sceneId, 'redo'),
    }),
  });

  const film = defineCommand({
    id: 'movie.edit.film',
    title: 'Overview of the film',
    description:
      'Returns the whole film at a glance: per scene how many items are ready, what is missing, and the running time; and the totals with the money spent on clips, dialogue and sounds so far. Use it to decide what to make next. It reads no media, so it stays small however long the film is.',
    effect: 'read',
    input: z.object({ projectId: ProjectId }),
    output: z.object({
      totalSeconds: z.number(),
      totalCostUsd: z.number(),
      items: z.number(),
      readyItems: z.number(),
      scenes: z.array(
        z.object({
          sceneId: z.string(),
          position: z.number(),
          heading: z.string(),
          items: z.number(),
          readyItems: z.number(),
          durationSeconds: z.number(),
          missing: z.array(z.object({ itemId: z.string(), index: z.number(), state: ItemState })),
        }),
      ),
    }),
    handler: async ({ runtime }, { projectId }) => {
      await requireProject(runtime.store, 'movie.edit.film', projectId, MODE_ID);
      const scenes = (await runtime.store.list(movieSceneKey(projectId, '')))
        .map((entry) => Scene.parse(entry.value))
        .sort((a, b) => a.position - b.position);
      let cost = 0;
      const summaries = [];
      for (const scene of scenes) {
        const cut = await readCut(runtime.store, projectId, scene.id);
        const laid = await layOut(
          runtime.store,
          projectId,
          await itemsOf(runtime.store, projectId, cut),
        );
        for (const shot of await readShots(runtime.store, projectId, scene.id)) {
          cost += (shot.clip?.costUsd ?? 0) + (shot.dialogue?.costUsd ?? 0);
        }
        for (const entry of await runtime.store.list(soundPrefix(projectId, scene.id))) {
          cost += Sound.parse(entry.value).take?.costUsd ?? 0;
        }
        for (const line of cut.lines) cost += line.take?.costUsd ?? 0;
        summaries.push({
          sceneId: scene.id,
          position: scene.position,
          heading: scene.heading,
          items: laid.items.length,
          readyItems: laid.items.filter((entry) => entry.state === 'ready').length,
          durationSeconds: laid.totalSeconds,
          missing: laid.items
            .filter((entry) => entry.state !== 'ready')
            .map((entry) => ({ itemId: entry.itemId, index: entry.index, state: entry.state })),
        });
      }
      return {
        totalSeconds: round(summaries.reduce((sum, scene) => sum + scene.durationSeconds, 0)),
        totalCostUsd: Math.round(cost * 1000) / 1000,
        items: summaries.reduce((sum, scene) => sum + scene.items, 0),
        readyItems: summaries.reduce((sum, scene) => sum + scene.readyItems, 0),
        scenes: summaries,
      };
    },
  });

  return [
    get,
    add,
    addTitle,
    setItem,
    move,
    duplicate,
    remove,
    split,
    detach,
    undo,
    redo,
    place,
    updateSound,
    removeSound,
    lineAdd,
    lineUpdate,
    lineRecord,
    lineRemove,
    film,
  ];
}
