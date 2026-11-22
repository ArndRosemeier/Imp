import {
  CommandError,
  defineCommand,
  requireProject,
  type Actor,
  type Command,
  type CoreRuntime,
  type KeyValueStore,
  patchOf,
  chosenModel,
} from '@imp/core';
import { mp3DurationSeconds, ProviderError, type GenerationProvider } from '@imp/providers';
import { z } from 'zod';
import {
  characterPrefix,
  editDraftKey,
  editHistoryKey,
  editKey,
  filmLookKey,
  linePrefix,
  markerKey,
  movieSceneKey,
  shotPrefix,
  soundPrefix,
} from './commands.js';
import { diffCut, type CutParts } from './drafts.js';
import { SPEECH_MODEL_SETTING, voiceDirection } from './voice.js';
import {
  Character,
  CutDraft,
  CutHistory,
  CutRequest,
  CutItem,
  CutLine,
  MODE_ID,
  PLAIN_PIECE,
  Scene,
  SceneCut,
  Shot,
  dialogueOver,
  Sound,
  SoundPlacement,
  TextItem,
  TransitionKind,
} from './schema.js';
import { placeText } from './text-layout.js';
import { readingSpeed } from './text-markup.js';
import { FilmLook, Grade, NEUTRAL_LOOK } from './grade.js';
import { dipOf, overlapSeconds } from './transitions.js';
import { movingSeconds, pieceSeconds, playsOwnSound, splitTrims, zoomAt } from './piece-time.js';

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
  if (speaks && shot.dialogue === null && dialogueOver(shot.clip)) return 'dialogue_missing';
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

export const wholeShot = (shot: Shot): CutItem => ({
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
  ...PLAIN_PIECE,
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
  // First how long each piece is, then where it falls: a dissolve or wipe overlaps the one before.
  const pieces = [];
  for (const item of items) {
    const shot =
      item.kind === 'shot'
        ? await loadShot(store, projectId, item.sceneId, item.shotId)
        : undefined;
    const timing = {
      sourceSeconds: shot === undefined ? 0 : clipSeconds(shot),
      trimStartSeconds: item.trimStartSeconds,
      trimEndSeconds: item.trimEndSeconds,
      speed: item.speed,
      reverse: item.reverse,
      holdSeconds: item.holdSeconds,
    };
    const ready = item.kind === 'shot' && shot?.clip?.status === 'ready';
    // A pickup without its clip stands in as a slate of its planned length.
    const slate = item.kind === 'shot' && !ready ? (shot?.pickup?.seconds ?? 0) : 0;
    const duration =
      item.kind === 'title' ? item.titleSeconds : ready ? pieceSeconds(timing) : slate;
    pieces.push({ item, shot, timing, ready, duration: round(duration) });
  }
  let at = 0;
  let end = 0;
  let before = 0;
  const laid = [];
  for (const [index, { item, shot, timing, ready, duration }] of pieces.entries()) {
    const state: ItemState = item.kind === 'title' ? 'ready' : stateOf(shot);
    const overlap =
      index === 0 ? 0 : overlapSeconds(item.transition, item.transitionSeconds, before, duration);
    // The next piece that is seen decides how this one goes out.
    const next = pieces.slice(index + 1).find((candidate) => candidate.duration > 0);
    const startsAt = round(Math.max(0, at - overlap));
    laid.push({
      itemId: item.id,
      kind: item.kind,
      index: index + 1,
      sceneId: item.sceneId,
      shotId: item.shotId,
      label: item.kind === 'title' ? item.text : (shot?.description ?? ''),
      state,
      placeholder: item.kind === 'shot' && !ready && duration > 0,
      pickupReason: shot?.pickup?.reason ?? null,
      trimStartSeconds: item.trimStartSeconds,
      trimEndSeconds: item.trimEndSeconds,
      dialogueVolume: item.dialogueVolume,
      clipAudioVolume: item.clipAudioVolume,
      /** Whether the clip has a sound of its own that can be taken apart. */
      hasClipAudio: shot?.clip?.status === 'ready' && !shot.clip.silent,
      fadeInSeconds: item.fadeInSeconds,
      fadeOutSeconds: item.fadeOutSeconds,
      text: item.text,
      startsAtSeconds: startsAt,
      durationSeconds: duration,
      /** How long the clip is before trims, for a split point to be chosen within. */
      sourceSeconds: shot === undefined ? 0 : round(clipSeconds(shot)),
      speed: item.speed,
      reverse: item.reverse,
      holdSeconds: item.holdSeconds,
      zoom: item.zoom,
      zoomTo: item.zoomTo,
      focusX: item.focusX,
      focusY: item.focusY,
      movingSeconds: ready ? round(movingSeconds(timing)) : 0,
      ownSound: item.kind === 'shot' && ready && playsOwnSound(item),
      transition: item.transition,
      transitionSeconds: item.transitionSeconds,
      overlapSeconds: duration > 0 ? overlap : 0,
      dipIn: index === 0 ? null : dipOf(item.transition, item.transitionSeconds, duration),
      dipOut:
        next === undefined
          ? null
          : dipOf(next.item.transition, next.item.transitionSeconds, duration),
      grade: item.grade,
    });
    if (duration > 0) {
      at = startsAt + duration;
      end = Math.max(end, at);
      before = duration;
    }
  }
  return { items: laid, totalSeconds: round(end) };
}

/** The items of a cut laid out in time, with what each needs, for a film export. */
export async function laidOut(
  store: KeyValueStore,
  projectId: string,
  items: readonly CutItem[],
): Promise<Awaited<ReturnType<typeof layOut>>> {
  return layOut(store, projectId, items);
}

/** Where each item starts and how long it plays, for the audio editor. */
export async function itemTimes(
  store: KeyValueStore,
  projectId: string,
  items: readonly CutItem[],
): Promise<{
  items: {
    startsAtSeconds: number;
    durationSeconds: number;
    movingSeconds: number;
    ownSound: boolean;
    overlapSeconds: number;
  }[];
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

/** One piece of the cut as it is laid out in time. */
export const LaidItem = z.object({
  itemId: z.string(),
  kind: z.enum(['shot', 'title']),
  index: z.number(),
  sceneId: z.string(),
  shotId: z.string(),
  label: z.string(),
  state: ItemState,
  /** A pickup waiting for its clip, standing in the cut as a slate of its planned length. */
  placeholder: z.boolean(),
  /** Why the shot was asked for, when it is a pickup. */
  pickupReason: z.string().nullable(),
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
  speed: z.number(),
  reverse: z.boolean(),
  holdSeconds: z.number(),
  zoom: z.number(),
  zoomTo: z.number().nullable(),
  focusX: z.number(),
  focusY: z.number(),
  /** How long it moves before its last frame is held. */
  movingSeconds: z.number(),
  /** Whether its own sound (clip sound or recorded dialogue) plays: only at its own speed, forwards. */
  ownSound: z.boolean(),
  transition: TransitionKind,
  transitionSeconds: z.number(),
  /** How far it starts before the piece before it ends: the length of its dissolve or wipe. */
  overlapSeconds: z.number(),
  /** The dips to black or white at its edges, from its own transition and the next piece's. */
  dipIn: z.object({ color: z.enum(['black', 'white']), seconds: z.number() }).nullable(),
  dipOut: z.object({ color: z.enum(['black', 'white']), seconds: z.number() }).nullable(),
  /** Its colour grade, before the film's look. */
  grade: Grade,
});
export type LaidItem = z.infer<typeof LaidItem>;

/** A placed sound as the cut shows it: with a name, its kind and whether there is a recording. */
export const PlacedSound = SoundPlacement.extend({
  name: z.string(),
  kind: z.enum(['effect', 'music', 'clip', 'dialogue']),
  recorded: z.boolean(),
});

/** A line that is heard in the scene, with who says it and when. */
export const SpokenLine = z.object({
  /** Where it comes from: a shot of the cut, a placed dialogue recording, or a character lane. */
  source: z.enum(['shot', 'placement', 'lane']),
  /** The item, placement or line id, to act on it. */
  id: z.string(),
  who: z.string(),
  text: z.string(),
  startsAtSeconds: z.number(),
  durationSeconds: z.number(),
  /** False when nothing is recorded yet and the line is only written. */
  recorded: z.boolean(),
});
export type SpokenLine = z.infer<typeof SpokenLine>;

/** A text of the text lane as it falls in the cut. */
export const TextView = TextItem.extend({
  /** What it follows in time, in words, or null when it keeps its own time. */
  follows: z.string().nullable(),
  /** What it follows is gone from the cut: it is not shown in the film until moved or removed. */
  orphaned: z.boolean(),
  /**
   * For a subtitle, how many letters a second it asks the viewer to read;
   * above about 20 it is hard to follow. Null for other kinds.
   */
  lettersPerSecond: z.number().nullable().default(null),
});
export type TextView = z.infer<typeof TextView>;

/** Everything about a version of a scene's cut that a person or an agent reads. */
export const CutView = z.object({
  sceneId: z.string(),
  totalSeconds: z.number(),
  items: z.array(LaidItem),
  unplaced: z.array(
    z.object({ shotId: z.string(), position: z.number(), description: z.string() }),
  ),
  sounds: z.array(PlacedSound),
  lanes: z.array(z.object({ characterId: z.string(), name: z.string(), voiceOnly: z.boolean() })),
  lines: z.array(LineView),
  spoken: z.array(SpokenLine),
  /** The text lane, each text at the time it shows (an anchored text where its anchor is now). */
  texts: z.array(TextView),
  /** The film's look, laid over every piece after its own grade. */
  look: FilmLook,
});
export type CutView = z.infer<typeof CutView>;

/** The film's look: the grade over every piece. */
export async function readFilmLook(store: KeyValueStore, projectId: string): Promise<FilmLook> {
  const stored = await store.get(filmLookKey(projectId));
  return stored === undefined ? NEUTRAL_LOOK : FilmLook.parse(stored);
}

/** How many changes agents propose to a scene, by whom and on what request. */
export const DraftSummary = z.object({
  changes: z.number(),
  authors: z.array(z.object({ id: z.string(), role: z.string() })),
  request: CutRequest.nullable(),
  updatedAt: z.string(),
});

export function summarize(draft: CutDraft): z.infer<typeof DraftSummary> {
  return {
    changes: diffCut(partsOf(draft.base), partsOf(draft.cut)).length,
    authors: draft.authors,
    request: draft.request,
    updatedAt: draft.updatedAt,
  };
}

/** The tracked parts of a cut whose items are explicit. */
export const partsOf = (cut: SceneCut): CutParts => ({
  items: cut.items ?? [],
  sounds: cut.sounds,
  lines: cut.lines,
  texts: cut.texts,
});

/** Reads a version of a scene's cut the way the Edit screen and agents see it. */
export async function viewOf(
  store: KeyValueStore,
  projectId: string,
  sceneId: string,
  cut: SceneCut,
  items: readonly CutItem[],
): Promise<CutView> {
  const laid = await layOut(store, projectId, items);
  const sounds = (await store.list(soundPrefix(projectId, sceneId))).map((entry) =>
    Sound.parse(entry.value),
  );
  const shots = new Map<string, Shot | undefined>();
  const shotOf = async (shotSceneId: string, shotId: string) => {
    const key = `${shotSceneId}/${shotId}`;
    if (!shots.has(key)) shots.set(key, await loadShot(store, projectId, shotSceneId, shotId));
    return shots.get(key);
  };
  const characters = new Map(
    (await store.list(characterPrefix(projectId)))
      .map((entry) => Character.parse(entry.value))
      .map((character) => [character.id, character] as const),
  );
  const nameOf = (characterId: string | null): string =>
    characterId === null ? 'Someone' : (characters.get(characterId)?.name ?? 'Someone');
  const used = new Set(items.map((item) => item.shotId));
  const lane = [];
  const spoken: SpokenLine[] = [];
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
    const shot = await shotOf(placement.sceneId, placement.shotId);
    if (shot === undefined) continue;
    const recorded =
      placement.source === 'clip'
        ? shot.clip?.status === 'ready' && !shot.clip.silent
        : shot.dialogue !== null;
    lane.push({
      ...placement,
      name: `${placement.source === 'clip' ? 'Clip sound' : 'Dialogue'} of shot ${String(shot.position)}`,
      kind: placement.source,
      recorded,
    });
    const speaks = shot.speakerId !== null && shot.line.trim() !== '';
    if (speaks && placement.volume > 0) {
      const length =
        placement.durationSeconds ??
        (placement.source === 'dialogue'
          ? (shot.dialogue?.durationSeconds ?? 0)
          : clipSeconds(shot)) - placement.trimStartSeconds;
      spoken.push({
        source: 'placement',
        id: placement.id,
        who: nameOf(shot.speakerId),
        text: shot.line,
        startsAtSeconds: round(placement.startSeconds),
        durationSeconds: round(Math.max(0, length)),
        recorded,
      });
    }
  }
  // Lines spoken with their picture: recorded dialogue over a silent clip, or the clip's own voice.
  for (const [index, item] of items.entries()) {
    const at = laid.items[index];
    if (item.kind !== 'shot' || at === undefined || at.durationSeconds <= 0 || !at.ownSound) {
      continue;
    }
    const shot = await shotOf(item.sceneId, item.shotId);
    if (shot === undefined || shot.speakerId === null || shot.line.trim() === '') continue;
    const overDialogue = shot.clip !== null && dialogueOver(shot.clip);
    const volume = overDialogue ? item.dialogueVolume : item.clipAudioVolume;
    if (volume <= 0) continue;
    const recordedLength = shot.dialogue?.durationSeconds;
    const available =
      overDialogue && typeof recordedLength === 'number'
        ? recordedLength - item.trimStartSeconds
        : at.movingSeconds;
    spoken.push({
      source: 'shot',
      id: item.id,
      who: nameOf(shot.speakerId),
      text: shot.line,
      startsAtSeconds: at.startsAtSeconds,
      durationSeconds: round(Math.max(0, Math.min(at.movingSeconds, available))),
      recorded: overDialogue ? shot.dialogue !== null : true,
    });
  }
  for (const line of cut.lines) {
    if (line.volume <= 0) continue;
    spoken.push({
      source: 'lane',
      id: line.id,
      who: nameOf(line.characterId),
      text: line.text,
      startsAtSeconds: round(line.startSeconds),
      durationSeconds: round(
        Math.max(0, (line.take?.durationSeconds ?? 0) - line.trimStartSeconds),
      ),
      recorded: line.take !== null,
    });
  }
  spoken.sort((a, b) => a.startsAtSeconds - b.startsAtSeconds);
  return {
    sceneId,
    totalSeconds: laid.totalSeconds,
    items: laid.items,
    // Only once the cut is explicit: before that every shot is in it.
    unplaced:
      cut.items === null
        ? []
        : (await readShots(store, projectId, sceneId))
            .filter((shot) => !used.has(shot.id))
            .map((shot) => ({
              shotId: shot.id,
              position: shot.position,
              description: shot.description,
            })),
    sounds: lane,
    lanes: (await ownLaneCharacters(store, projectId)).map((character) => ({
      characterId: character.id,
      name: character.name,
      voiceOnly: character.voiceOnly,
    })),
    lines: cut.lines.map((line) => lineView(line)),
    spoken,
    texts: cut.texts
      .map((text) => {
        const placed = placeText(text, { items: laid.items, spoken });
        return {
          ...text,
          ...placed,
          lettersPerSecond:
            text.kind === 'subtitle' ? readingSpeed(text.text, placed.durationSeconds) : null,
        };
      })
      .sort((a, b) => a.startSeconds - b.startSeconds),
    look: await readFilmLook(store, projectId),
  };
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

const GradeInput = z
  .object({
    exposure: z.number().min(-3).max(3).optional(),
    contrast: z.number().min(-1).max(1).optional(),
    temperature: z.number().min(-1).max(1).optional(),
    tint: z.number().min(-1).max(1).optional(),
    saturation: z.number().min(-1).max(1).optional(),
  })
  .describe('The colour of the shot; fields left out stay as they are.');

/** An object without the fields that are undefined, so that a spread keeps what is there. */
const withoutUndefined = <T extends object>(value: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as Partial<T>;

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

/**
 * The setting that decides how agents edit: false lets them change the cut
 * directly; anything else, the default, makes their changes a draft that a
 * person keeps or discards.
 */
export const AGENT_DRAFTS_SETTING = 'edit.agent-drafts';

/** Who runs a command, and where. */
export interface Acting {
  readonly runtime: CoreRuntime;
  readonly actor: Actor;
}

/** Whether this actor's edits go into a draft rather than into the cut. */
export async function drafting(at: Acting): Promise<boolean> {
  if (at.actor.kind !== 'agent') return false;
  return (await at.runtime.store.get(`settings/${AGENT_DRAFTS_SETTING}`)) !== false;
}

/** The changes agents propose to a scene's cut, if there are any. */
export async function readDraft(
  store: KeyValueStore,
  projectId: string,
  sceneId: string,
): Promise<CutDraft | undefined> {
  const stored = await store.get(editDraftKey(projectId, sceneId));
  return stored === undefined ? undefined : CutDraft.parse(stored);
}

/**
 * The cut a command works on: the agent's draft while agents propose their
 * edits and one exists, the scene's cut otherwise.
 */
export async function openCut(
  at: Acting,
  commandId: string,
  projectId: string,
  sceneId: string,
): Promise<{ cut: SceneCut; items: CutItem[] }> {
  await requireScene(at.runtime.store, commandId, projectId, sceneId);
  const cut = await readCut(at.runtime.store, projectId, sceneId);
  if (await drafting(at)) {
    const draft = await readDraft(at.runtime.store, projectId, sceneId);
    if (draft !== undefined) return { cut: draft.cut, items: draft.cut.items ?? [] };
  }
  return { cut, items: await itemsOf(at.runtime.store, projectId, cut) };
}

/**
 * Writes a change: into the scene's cut, one step of undo, or for an agent
 * into its draft, which begins as a copy of the cut on its first change.
 */
export async function commitCut(
  at: Acting,
  projectId: string,
  before: SceneCut,
  after: SceneCut,
): Promise<void> {
  const { runtime, actor } = at;
  if (actor.kind !== 'agent' || !(await drafting(at))) {
    await save(runtime, projectId, before, after);
    return;
  }
  const { store } = runtime;
  const sceneId = after.sceneId;
  const explicit = async (cut: SceneCut): Promise<SceneCut> => ({
    ...cut,
    items: [...(await itemsOf(store, projectId, cut))],
  });
  const existing = await readDraft(store, projectId, sceneId);
  const now = runtime.now().toISOString();
  const author = { id: actor.id, role: actor.role };
  const start = existing ?? {
    sceneId,
    base: await explicit(before),
    cut: await explicit(before),
    undo: [],
    redo: [],
    authors: [],
    request: null,
    createdAt: now,
    updatedAt: now,
  };
  const draft: CutDraft = {
    ...start,
    cut: await explicit(after),
    undo: [...start.undo, await explicit(before)].slice(-HISTORY_LIMIT),
    redo: [],
    authors: start.authors.some((known) => known.id === author.id)
      ? start.authors
      : [...start.authors, author],
    updatedAt: now,
  };
  await store.batch([{ type: 'put', key: editDraftKey(projectId, sceneId), value: draft }]);
}

/** Where an item lies on the scene timeline, as layOut gives it. */
interface Laid {
  readonly startsAtSeconds: number;
  readonly durationSeconds: number;
  readonly movingSeconds: number;
  readonly ownSound: boolean;
}

/**
 * The sound an item plays with its picture, laid on the audio lane at the same
 * time and for the same length instead: the clip's own sound, or the recorded
 * dialogue over a silent clip. The item then plays its picture alone, so that
 * picture and sound can be cut apart (a J or L cut). Texts that followed the
 * line as the item spoke it follow it on the lane. Nothing changes for sound
 * that was already taken apart or is silenced.
 */
function takeApart(
  runtime: CoreRuntime,
  item: CutItem,
  laid: Laid,
  shot: Shot | undefined,
): { item: CutItem; sounds: SoundPlacement[]; voice: string | null } {
  if (
    item.kind !== 'shot' ||
    shot?.clip?.status !== 'ready' ||
    laid.movingSeconds <= 0 ||
    !laid.ownSound
  ) {
    return { item, sounds: [], voice: null };
  }
  const speaks = shot.speakerId !== null && shot.line.trim() !== '';
  const lay = (source: 'clip' | 'dialogue', volume: number, length: number): SoundPlacement =>
    SoundPlacement.parse({
      id: runtime.newId(),
      source,
      soundId: '',
      sceneId: item.sceneId,
      shotId: item.shotId,
      trimStartSeconds: item.trimStartSeconds,
      startSeconds: laid.startsAtSeconds,
      durationSeconds: round(Math.max(0.01, length)),
      volume,
      fadeInSeconds: 0,
      fadeOutSeconds: 0,
      loop: false,
    });
  let next = item;
  let clipSound: SoundPlacement | null = null;
  let spoken: SoundPlacement | null = null;
  if (!shot.clip.silent && item.clipAudioVolume > 0) {
    clipSound = lay('clip', item.clipAudioVolume, laid.movingSeconds);
    next = { ...next, clipAudioVolume: 0 };
  }
  if (dialogueOver(shot.clip) && shot.dialogue !== null && item.dialogueVolume > 0) {
    const heard = Math.min(
      laid.movingSeconds,
      (shot.dialogue.durationSeconds ?? laid.movingSeconds) - item.trimStartSeconds,
    );
    if (heard > 0) {
      spoken = lay('dialogue', item.dialogueVolume, heard);
      next = { ...next, dialogueVolume: 0 };
    }
  }
  const sounds = [clipSound, spoken].filter((sound) => sound !== null);
  // The line follows the recorded voice where there is one, else the clip's own.
  const voice = speaks ? ((spoken ?? clipSound)?.id ?? null) : null;
  return { item: next, sounds, voice };
}

/** Texts that followed the line an item spoke follow it where it was laid on the lane. */
function followVoice(texts: readonly TextItem[], itemId: string, voice: string | null): TextItem[] {
  if (voice === null) return [...texts];
  return texts.map((text) =>
    text.anchor?.on === 'shot' && text.anchor.id === itemId
      ? { ...text, anchor: { ...text.anchor, on: 'placement', id: voice } }
      : text,
  );
}

/** Where an item is split: two pieces that play on as the one did, the first ending where the second begins. */
function splitPiece(
  commandId: string,
  item: CutItem,
  sourceSeconds: number,
  atSeconds: number,
  newId: string,
): { first: CutItem; second: CutItem } {
  const timing = { ...item, sourceSeconds };
  const moving = movingSeconds(timing);
  if (atSeconds < SHORTEST_SECONDS || atSeconds > moving - SHORTEST_SECONDS) {
    throw new CommandError(
      'invalid_input',
      commandId,
      `Split between ${String(SHORTEST_SECONDS)} and ${String(round(moving - SHORTEST_SECONDS))} seconds; the item moves for ${String(round(moving))}${item.holdSeconds > 0 ? ' before its last frame is held' : ''}.`,
    );
  }
  const trims = splitTrims(timing, atSeconds);
  // A moving punch-in goes on across the split: the first half ends on the zoom the second starts on.
  const whole = pieceSeconds(timing);
  const middle =
    item.zoomTo === null
      ? null
      : round(zoomAt(item, whole > 0 ? atSeconds / whole : 0) * 1000) / 1000;
  return {
    first: {
      ...item,
      ...trims.first,
      holdSeconds: 0,
      fadeOutSeconds: 0,
      ...(middle === null ? {} : { zoomTo: middle }),
    },
    second: {
      ...item,
      ...trims.second,
      id: newId,
      fadeInSeconds: 0,
      transition: 'cut',
      ...(middle === null ? {} : { zoom: middle }),
    },
  };
}

const InsertAt = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('Where in the cut it goes, counted from 0. Defaults to the end.');

/** The commands that put the pieces of a film together. Nothing here spends money. */
export function createEditCommands(provider: GenerationProvider): readonly Command[] {
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
      'Returns the cut of a scene. Picture: its items in playing order, each with its start and length on the scene timeline and whether it is ready for the film or what is missing (no clip, clip pending or failed, dialogue missing or out of date), and the shots of the scene that are not in the cut. Sound: the audio lane of placed sounds, clip sounds that were taken apart and dialogue, each with its own start, volume and fades. spoken lists every line that is heard, who says it and when, in time order. Also whether undo or redo is possible, and whether agents proposed changes that wait for the person (draft). An agent reads its own draft, the person the cut; version picks one.',
    effect: 'read',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      version: z
        .enum(['cut', 'draft'])
        .optional()
        .describe(
          'Which version to read: the cut as it stands, or the changes agents propose. Defaults to the draft for an agent while one exists, the cut otherwise.',
        ),
    }),
    output: CutView.extend({
      canUndo: z.boolean(),
      canRedo: z.boolean(),
      version: z.enum(['cut', 'draft']),
      draft: DraftSummary.nullable(),
    }),
    handler: async ({ runtime, actor }, { projectId, sceneId, version }) => {
      const { store } = runtime;
      await requireScene(store, 'movie.edit.get', projectId, sceneId);
      const live = await readCut(store, projectId, sceneId);
      const draft = await readDraft(store, projectId, sceneId);
      const agentDraft = await drafting({ runtime, actor });
      const showDraft =
        draft !== undefined && (version === 'draft' || (version === undefined && agentDraft));
      const cut = showDraft ? draft.cut : live;
      const items = await itemsOf(store, projectId, cut);
      const stored = await store.get(editHistoryKey(projectId, sceneId));
      const history = stored === undefined ? CutHistory.parse({}) : CutHistory.parse(stored);
      // The steps an agent can take back are its own; the person's are the cut's.
      const steps =
        agentDraft && draft !== undefined
          ? { canUndo: draft.undo.length > 0, canRedo: draft.redo.length > 0 }
          : agentDraft
            ? { canUndo: false, canRedo: false }
            : { canUndo: history.undo.length > 0, canRedo: history.redo.length > 0 };
      return {
        ...(await viewOf(store, projectId, sceneId, cut, items)),
        ...steps,
        version: showDraft ? ('draft' as const) : ('cut' as const),
        draft: draft === undefined ? null : summarize(draft),
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
    handler: async ({ runtime, actor }, input) => {
      const id = 'movie.edit.item.add';
      const { cut, items } = await openCut({ runtime, actor }, id, input.projectId, input.sceneId);
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
      await commitCut(
        { runtime, actor },
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
    handler: async ({ runtime, actor }, input) => {
      const { cut, items } = await openCut(
        { runtime, actor },
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
        ...PLAIN_PIECE,
      };
      await commitCut(
        { runtime, actor },
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
      "Changes an item of the cut: seconds trimmed off its start and end (in seconds of the clip), the volume of its dialogue and of the clip's own sound (0 silences either), fades from and to black at its edges, and for a title card its words and length. Rescue tools for a shot: speed (0.5 slow motion, 2 double; off speed or reversed, its own sound and dialogue are silent, so lay sound on the audio lane), reverse, holdSeconds (freeze its last frame), and a punch-in: zoom (1 to 4) on focusX and focusY (shares of the frame), with zoomTo for a slow push in or pull out over the piece (null for none). A punch-in turns a wide into a closer shot or hides a flaw at the edge; keep it under about 1.5 or the picture softens. transition is how the item comes in after the one before: cut (the default), dissolve (one picture melts into the next, for time passing or a change of mood), dip-black or dip-white (a fade out and in, for a bigger break), or wipe; transitionSeconds is its length. A dissolve or wipe overlaps the two pieces, so the scene gets shorter by it; inside a scene most changes should stay cuts. grade sets the colour of a shot before the film's look: exposure in stops (-3 to 3), contrast, temperature (+ warmer), tint (+ magenta, - green) and saturation (-1 black and white), each -1 to 1 and 0 for none; only the fields given change. Use it to make shots of one scene agree; movie.edit.grade.match works one out from a reference shot. Fields left out stay as they are.",
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      itemId: ItemId,
      ...TrimFields,
      text: z.string().min(1).max(500).optional(),
      titleSeconds: z.number().min(0.5).max(60).optional(),
      speed: z.number().min(0.1).max(8).optional(),
      reverse: z.boolean().optional(),
      holdSeconds: z.number().min(0).max(30).optional(),
      zoom: z.number().min(1).max(4).optional(),
      zoomTo: z.number().min(1).max(4).nullable().optional(),
      focusX: z.number().min(0).max(1).optional(),
      focusY: z.number().min(0).max(1).optional(),
      transition: TransitionKind.optional(),
      transitionSeconds: z.number().min(0.1).max(5).optional(),
      grade: GradeInput.optional(),
    }),
    output: z.object({ item: CutItem }),
    handler: async ({ runtime, actor }, { projectId, sceneId, itemId, ...changes }) => {
      const id = 'movie.edit.item.set';
      const { cut, items } = await openCut({ runtime, actor }, id, projectId, sceneId);
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
        speed: changes.speed ?? before.speed,
        reverse: changes.reverse ?? before.reverse,
        holdSeconds: changes.holdSeconds ?? before.holdSeconds,
        zoom: changes.zoom ?? before.zoom,
        zoomTo: changes.zoomTo === undefined ? before.zoomTo : changes.zoomTo,
        focusX: changes.focusX ?? before.focusX,
        focusY: changes.focusY ?? before.focusY,
        transition: changes.transition ?? before.transition,
        transitionSeconds: changes.transitionSeconds ?? before.transitionSeconds,
        grade: Grade.parse({ ...before.grade, ...withoutUndefined(changes.grade ?? {}) }),
      };
      if (
        before.kind === 'title' &&
        (changes.speed !== undefined ||
          changes.reverse !== undefined ||
          changes.holdSeconds !== undefined ||
          changes.zoom !== undefined ||
          changes.zoomTo !== undefined ||
          changes.grade !== undefined)
      ) {
        throw new CommandError(
          'invalid_input',
          id,
          'A title card has no clip to slow, reverse, freeze, zoom or grade; change its length instead.',
        );
      }
      await commitCut(
        { runtime, actor },
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
    handler: async ({ runtime, actor }, { projectId, sceneId, itemId, toIndex }) => {
      const id = 'movie.edit.item.move';
      const { cut, items } = await openCut({ runtime, actor }, id, projectId, sceneId);
      const index = indexOfItem(items, id, itemId);
      const rest = items.filter((_, at) => at !== index);
      const to = Math.min(toIndex, rest.length);
      await commitCut(
        { runtime, actor },
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
    handler: async ({ runtime, actor }, input) => {
      const id = 'movie.edit.item.duplicate';
      const { cut, items } = await openCut({ runtime, actor }, id, input.projectId, input.sceneId);
      const index = indexOfItem(items, id, input.itemId);
      const copy: CutItem = { ...itemAt(items, index), id: runtime.newId() };
      const target = input.toSceneId ?? input.sceneId;
      if (target === input.sceneId) {
        await commitCut(
          { runtime, actor },
          input.projectId,
          cut,
          withItems(cut, insertedAt(items, input.toIndex ?? index + 1, copy)),
        );
      } else {
        const other = await openCut({ runtime, actor }, id, input.projectId, target);
        await commitCut(
          { runtime, actor },
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
    handler: async ({ runtime, actor }, { projectId, sceneId, itemId }) => {
      const id = 'movie.edit.item.remove';
      const { cut, items } = await openCut({ runtime, actor }, id, projectId, sceneId);
      indexOfItem(items, id, itemId);
      const rest = items.filter((item) => item.id !== itemId);
      await commitCut({ runtime, actor }, projectId, cut, withItems(cut, rest));
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
    handler: async ({ runtime, actor }, { projectId, sceneId, itemId, atSeconds }) => {
      const id = 'movie.edit.item.split';
      const { cut, items } = await openCut({ runtime, actor }, id, projectId, sceneId);
      const index = indexOfItem(items, id, itemId);
      const item = itemAt(items, index);
      if (item.kind !== 'shot') {
        throw new CommandError('invalid_input', id, 'A title card cannot be split.');
      }
      const shot = await loadShot(runtime.store, projectId, item.sceneId, item.shotId);
      if (shot === undefined || clipSeconds(shot) === 0) {
        throw new CommandError('invalid_input', id, 'This item has no clip to split yet.');
      }
      const { first, second } = splitPiece(id, item, clipSeconds(shot), atSeconds, runtime.newId());
      await commitCut(
        { runtime, actor },
        projectId,
        cut,
        withItems(cut, [...items.slice(0, index), first, second, ...items.slice(index + 1)]),
      );
      return { first, second };
    },
  });

  const freeze = defineCommand({
    id: 'movie.edit.item.freeze',
    title: 'Freeze frame',
    description:
      'Freezes the picture of an item at a moment for some seconds, then lets it play on: it splits the item at atSeconds (from the start of the item as it plays) and holds the last frame of the first half. The scene grows by the held seconds. To freeze on the very last frame instead, set holdSeconds with movie.edit.item.set. The held frame is silent; its own sound stops while it holds.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      itemId: ItemId,
      atSeconds: z.number().positive(),
      holdSeconds: z.number().min(0.2).max(30).describe('How long the frame stands still.'),
    }),
    output: z.object({ frozen: CutItem, after: CutItem }),
    handler: async ({ runtime, actor }, { projectId, sceneId, itemId, atSeconds, holdSeconds }) => {
      const id = 'movie.edit.item.freeze';
      const { cut, items } = await openCut({ runtime, actor }, id, projectId, sceneId);
      const index = indexOfItem(items, id, itemId);
      const item = itemAt(items, index);
      const shot =
        item.kind === 'shot'
          ? await loadShot(runtime.store, projectId, item.sceneId, item.shotId)
          : undefined;
      if (shot === undefined || clipSeconds(shot) === 0) {
        throw new CommandError('invalid_input', id, 'Only a shot with a clip can be frozen.');
      }
      const { first, second } = splitPiece(id, item, clipSeconds(shot), atSeconds, runtime.newId());
      const frozen: CutItem = { ...first, holdSeconds };
      await commitCut(
        { runtime, actor },
        projectId,
        cut,
        withItems(cut, [...items.slice(0, index), frozen, second, ...items.slice(index + 1)]),
      );
      return { frozen, after: second };
    },
  });

  const detach = defineCommand({
    id: 'movie.edit.audio.detach',
    title: 'Take clip sound apart',
    description:
      "Takes the sound of an item's clip off its picture and puts it in the audio lane at the same time and for the same length, so that picture and sound can be trimmed, moved, faded and mixed on their own, for example to keep ambience under the next shot. For a J or L cut, movie.edit.item.roll does this by itself. The picture goes on without that sound. Only clips with a sound of their own have one to take; clips made silent have none.",
    effect: 'write',
    input: z.object({ projectId: ProjectId, sceneId: SceneId, itemId: ItemId }),
    output: SoundPlacement,
    handler: async ({ runtime, actor }, { projectId, sceneId, itemId }) => {
      const id = 'movie.edit.audio.detach';
      const { cut, items } = await openCut({ runtime, actor }, id, projectId, sceneId);
      const index = indexOfItem(items, id, itemId);
      const item = itemAt(items, index);
      const laid = (await layOut(runtime.store, projectId, items)).items[index];
      const refuse = (): never => {
        throw new CommandError(
          'invalid_input',
          id,
          'This item has no sound of its own to take apart: it is a title, has no ready clip, its clip was made silent, it plays off speed or backwards, or its sound was taken apart already.',
        );
      };
      if (item.kind !== 'shot' || laid?.hasClipAudio !== true) return refuse();
      const shot = await loadShot(runtime.store, projectId, item.sceneId, item.shotId);
      const apart = takeApart(runtime, item, laid, shot);
      // Only the clip's own sound: a voice recorded over it stays with the picture.
      const placement = apart.sounds.find((sound) => sound.source === 'clip');
      if (placement === undefined) return refuse();
      const kept = { ...item, clipAudioVolume: 0 };
      await commitCut({ runtime, actor }, projectId, cut, {
        ...cut,
        items: items.map((candidate, at) => (at === index ? kept : candidate)),
        sounds: [...cut.sounds, placement],
        texts: followVoice(cut.texts, item.id, apart.voice === placement.id ? placement.id : null),
      });
      return placement;
    },
  });

  const roll = defineCommand({
    id: 'movie.edit.item.roll',
    title: 'Split edit',
    description:
      "Makes a J or L cut between an item and the next one: the picture changes before or after the sound does. An L cut lets the sound of this item run on under the start of the next picture (a reaction, a look away); a J cut lets the sound of the next item begin under the end of this picture (a line heard before we see who says it). It takes both items' sound apart onto the audio lane where it is not yet, then moves the picture cut by seconds, later for J and earlier for L, keeping picture and sound in sync and the scene as long as it was. The picture that comes into view must have been trimmed off: an L cut needs the next item to have that much trimmed off its start, a J cut needs this item to have that much trimmed off its end (movie.edit.item.set). Use 0.3 to 1.5 seconds for most cuts.",
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      itemId: ItemId.describe('The item before the cut. The next item is the one after it.'),
      type: z
        .enum(['j', 'l'])
        .describe('j: the next sound comes in early. l: this sound runs on late.'),
      seconds: z.number().positive().max(30).describe('How far apart picture and sound change.'),
    }),
    output: z.object({ first: CutItem, second: CutItem, sounds: z.array(SoundPlacement) }),
    handler: async ({ runtime, actor }, { projectId, sceneId, itemId, type, seconds }) => {
      const id = 'movie.edit.item.roll';
      const { cut, items } = await openCut({ runtime, actor }, id, projectId, sceneId);
      const index = indexOfItem(items, id, itemId);
      const a = itemAt(items, index);
      const b = items[index + 1];
      if (b === undefined) {
        throw new CommandError(
          'invalid_input',
          id,
          'This is the last item; there is no cut after it.',
        );
      }
      if (a.kind !== 'shot' || b.kind !== 'shot') {
        throw new CommandError(
          'invalid_input',
          id,
          'A split edit needs two shots; a title card has no sound to run on.',
        );
      }
      const laid = (await layOut(runtime.store, projectId, items)).items;
      const laidA = laid[index];
      const laidB = laid[index + 1];
      if (
        laidA === undefined ||
        laidB === undefined ||
        laidA.durationSeconds <= 0 ||
        laidB.durationSeconds <= 0
      ) {
        throw new CommandError('invalid_input', id, 'Both items need a ready clip first.');
      }
      const retimed = (item: CutItem): boolean => !playsOwnSound(item) || item.holdSeconds > 0;
      if (retimed(a) || retimed(b)) {
        throw new CommandError(
          'invalid_input',
          id,
          'A split edit needs both shots at their own speed, forwards and without a held frame, so that their sound can follow the picture.',
        );
      }
      const d = round(seconds);
      // The picture that comes into view has to be there: it was trimmed off before.
      const handle = type === 'l' ? b.trimStartSeconds : a.trimEndSeconds;
      if (handle + 0.001 < d) {
        throw new CommandError(
          'invalid_input',
          id,
          type === 'l'
            ? `An L cut of ${String(d)} s shows ${String(d)} s more of the start of the next shot, but only ${String(round(handle))} s of it was trimmed off. Trim more off its start first, or use at most ${String(round(handle))} s.`
            : `A J cut of ${String(d)} s shows ${String(d)} s more of the end of this shot, but only ${String(round(handle))} s of it was trimmed off. Trim more off its end first, or use at most ${String(round(handle))} s.`,
        );
      }
      const shrinking = type === 'l' ? laidA : laidB;
      if (shrinking.durationSeconds - d < SHORTEST_SECONDS) {
        throw new CommandError(
          'invalid_input',
          id,
          `That leaves ${type === 'l' ? 'this' : 'the next'} picture shorter than ${String(SHORTEST_SECONDS)} s. Use at most ${String(round(shrinking.durationSeconds - SHORTEST_SECONDS))} s.`,
        );
      }
      const apartA = takeApart(
        runtime,
        a,
        laidA,
        await loadShot(runtime.store, projectId, a.sceneId, a.shotId),
      );
      const apartB = takeApart(
        runtime,
        b,
        laidB,
        await loadShot(runtime.store, projectId, b.sceneId, b.shotId),
      );
      const shift = type === 'l' ? d : -d;
      const first: CutItem = {
        ...apartA.item,
        trimEndSeconds: round(Math.max(0, a.trimEndSeconds + shift)),
      };
      const second: CutItem = {
        ...apartB.item,
        trimStartSeconds: round(Math.max(0, b.trimStartSeconds - shift)),
      };
      const sounds = [...apartA.sounds, ...apartB.sounds];
      await commitCut({ runtime, actor }, projectId, cut, {
        ...cut,
        items: items.map((candidate, at) =>
          at === index ? first : at === index + 1 ? second : candidate,
        ),
        sounds: [...cut.sounds, ...sounds],
        texts: followVoice(followVoice(cut.texts, a.id, apartA.voice), b.id, apartB.voice),
      });
      return { first, second, sounds };
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
    handler: async ({ runtime, actor }, input) => {
      const id = 'movie.edit.sound.place';
      const { projectId, sceneId, soundId, shotId, shotSceneId, ...fields } = input;
      const { cut } = await openCut({ runtime, actor }, id, projectId, sceneId);
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
      await commitCut({ runtime, actor }, projectId, cut, {
        ...cut,
        sounds: [...cut.sounds, placement],
      });
      return placement;
    },
  });

  const updateSound = defineCommand({
    id: 'movie.edit.sound.update',
    title: 'Change placed sound',
    description:
      'Changes where, how loud and from where in the source a placed sound plays, and its pan (-1 left to 1 right, 0 is the middle), extra gain in dB and the shape of its fades. Fields left out stay as they are.',
    effect: 'write',
    input: patchOf(PlacementFields).extend({
      projectId: ProjectId,
      sceneId: SceneId,
      placementId: z.string().describe('The id of a placement from movie.edit.get.'),
    }),
    output: SoundPlacement,
    handler: async ({ runtime, actor }, { projectId, sceneId, placementId, ...changes }) => {
      const id = 'movie.edit.sound.update';
      const { cut } = await openCut({ runtime, actor }, id, projectId, sceneId);
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
      await commitCut({ runtime, actor }, projectId, cut, {
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
    handler: async ({ runtime, actor }, { projectId, sceneId, placementId }) => {
      const { cut } = await openCut(
        { runtime, actor },
        'movie.edit.sound.remove',
        projectId,
        sceneId,
      );
      const sounds = cut.sounds.filter((placement) => placement.id !== placementId);
      if (sounds.length === cut.sounds.length) return { placementId, removed: false };
      await commitCut({ runtime, actor }, projectId, cut, { ...cut, sounds });
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
    handler: async ({ runtime, actor }, { projectId, sceneId, characterId, ...fields }) => {
      const id = 'movie.edit.line.add';
      const { cut } = await openCut({ runtime, actor }, id, projectId, sceneId);
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
      await commitCut({ runtime, actor }, projectId, cut, { ...cut, lines: [...cut.lines, line] });
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
    handler: async ({ runtime, actor }, { projectId, sceneId, lineId, ...changes }) => {
      const { cut } = await openCut(
        { runtime, actor },
        'movie.edit.line.update',
        projectId,
        sceneId,
      );
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
      await commitCut({ runtime, actor }, projectId, cut, {
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
    estimate: async ({ runtime, actor }, { projectId, sceneId, lineId, model: chosen }) => {
      const { cut } = await openCut(
        { runtime, actor },
        'movie.edit.line.record',
        projectId,
        sceneId,
      );
      const text = cut.lines.find((line) => line.id === lineId)?.text ?? '';
      return {
        kind: 'speech',
        model: await chosenModel(runtime.store, SPEECH_MODEL_SETTING, chosen),
        characters: text.trim().length,
      };
    },
    handler: async ({ runtime, actor }, { projectId, sceneId, lineId, model: chosen }) => {
      const id = 'movie.edit.line.record';
      const { cut } = await openCut({ runtime, actor }, id, projectId, sceneId);
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
      const latest = (await openCut({ runtime, actor }, id, projectId, sceneId)).cut;
      const current = lineIn(latest, id, lineId);
      const next: CutLine = { ...current, take };
      await commitCut({ runtime, actor }, projectId, latest, {
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
    handler: async ({ runtime, actor }, { projectId, sceneId, lineId }) => {
      const { cut } = await openCut(
        { runtime, actor },
        'movie.edit.line.remove',
        projectId,
        sceneId,
      );
      const lines = cut.lines.filter((line) => line.id !== lineId);
      if (lines.length === cut.lines.length) return { lineId, removed: false };
      await commitCut({ runtime, actor }, projectId, cut, { ...cut, lines });
      return { lineId, removed: true };
    },
  });

  /** Moves one step along the history of a scene's cut, in either direction. */
  async function step(
    at: Acting,
    commandId: string,
    projectId: string,
    sceneId: string,
    direction: 'undo' | 'redo',
  ): Promise<boolean> {
    const { runtime } = at;
    await requireScene(runtime.store, commandId, projectId, sceneId);
    if (await drafting(at)) {
      // An agent steps through its own draft and never through the person's edits.
      const draft = await readDraft(runtime.store, projectId, sceneId);
      if (draft === undefined) return false;
      const from = direction === 'undo' ? draft.undo : draft.redo;
      const target = from.at(-1);
      if (target === undefined) return false;
      const rest = from.slice(0, -1);
      const other = [...(direction === 'undo' ? draft.redo : draft.undo), draft.cut];
      const next: CutDraft = {
        ...draft,
        cut: target,
        ...(direction === 'undo' ? { undo: rest, redo: other } : { undo: other, redo: rest }),
        updatedAt: runtime.now().toISOString(),
      };
      await runtime.store.batch([
        { type: 'put', key: editDraftKey(projectId, sceneId), value: next },
      ]);
      return true;
    }
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
    handler: async ({ runtime, actor }, { projectId, sceneId }) => ({
      done: await step({ runtime, actor }, 'movie.edit.undo', projectId, sceneId, 'undo'),
    }),
  });
  const redo = defineCommand({
    id: 'movie.edit.redo',
    title: 'Redo edit',
    description: 'Redoes a change that was undone. done is false when there is nothing to redo.',
    effect: 'write',
    input: stepInput,
    output: stepOutput,
    handler: async ({ runtime, actor }, { projectId, sceneId }) => ({
      done: await step({ runtime, actor }, 'movie.edit.redo', projectId, sceneId, 'redo'),
    }),
  });

  const film = defineCommand({
    id: 'movie.edit.film',
    title: 'Overview of the film',
    description:
      'Returns the whole film at a glance: per scene how many items are ready, what is missing, where it starts in the film, its running time and how many markers are still open; and the totals with the money spent on clips, dialogue and sounds so far. Use it to decide what to make next. It reads no media, so it stays small however long the film is.',
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
          /** Where the scene starts in the film. */
          startSeconds: z.number(),
          missing: z.array(z.object({ itemId: z.string(), index: z.number(), state: ItemState })),
          /** Markers not done yet. */
          openMarkers: z.number(),
        }),
      ),
      openMarkers: z.number(),
    }),
    handler: async ({ runtime }, { projectId }) => {
      await requireProject(runtime.store, 'movie.edit.film', projectId, MODE_ID);
      const scenes = (await runtime.store.list(movieSceneKey(projectId, '')))
        .map((entry) => Scene.parse(entry.value))
        .sort((a, b) => a.position - b.position);
      let cost = 0;
      let startSeconds = 0;
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
        const stored = await runtime.store.get(markerKey(projectId, scene.id));
        const openMarkers = Array.isArray(stored)
          ? stored.filter((marker) => (marker as { done?: unknown }).done !== true).length
          : 0;
        summaries.push({
          startSeconds: round(startSeconds),
          openMarkers,
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
        startSeconds += laid.totalSeconds;
      }
      return {
        totalSeconds: round(summaries.reduce((sum, scene) => sum + scene.durationSeconds, 0)),
        totalCostUsd: Math.round(cost * 1000) / 1000,
        items: summaries.reduce((sum, scene) => sum + scene.items, 0),
        readyItems: summaries.reduce((sum, scene) => sum + scene.readyItems, 0),
        openMarkers: summaries.reduce((sum, scene) => sum + scene.openMarkers, 0),
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
    roll,
    freeze,
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
