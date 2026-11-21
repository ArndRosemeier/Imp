import {
  CommandError,
  defineCommand,
  MediaAttachment,
  requireProject,
  type Command,
  type CoreRuntime,
  type KeyValueStore,
} from '@imp/core';
import type { MediaInput } from '@imp/providers';
import { z } from 'zod';
import { editDraftKey, movieSceneKey, shotPrefix } from './commands.js';
import {
  applyChanges,
  diffCut,
  mirror,
  type CutChange,
  type CutParts,
  type FieldChange,
} from './drafts.js';
import {
  drafting,
  itemsOf,
  partsOf,
  readCut,
  readDraft,
  requireScene,
  save,
  viewOf,
  CutView,
  type Acting,
} from './edit.js';
import { placedMarkers, type PlacedMarker } from './markers.js';
import { sourceTime } from './piece-time.js';
import { CutRequest, MODE_ID, Scene, Shot, type CutDraft, type SceneCut } from './schema.js';

/**
 * Reviewing what agents propose for a cut, asking for work on one stretch of
 * a scene, and reading a cut as text. Drafts themselves are written by the
 * editing commands in edit.ts whenever an agent runs them.
 */

const ProjectId = z.string().describe('The id of a movie project from project.list.');
const SceneId = z.string().describe('The id of a scene from movie.scene.list.');
const Version = z
  .enum(['cut', 'draft'])
  .optional()
  .describe(
    'The cut as it stands, or the changes agents propose. Defaults to the draft for an agent while one exists, the cut otherwise.',
  );

/** Changes this close to a requested range still count as inside it. */
const RANGE_MARGIN_SECONDS = 0.5;

const round = (seconds: number): number => Math.round(seconds * 100) / 100;

/** A time as an editor reads it: 1:04.25. */
export function timecode(seconds: number): string {
  const hundredths = Math.max(0, Math.round(seconds * 100));
  const minutes = Math.floor(hundredths / 6000);
  const rest = (hundredths % 6000) / 100;
  return `${String(minutes)}:${rest.toFixed(2).padStart(5, '0')}`;
}

/** Whether something lies in a stretch; a margin lets what touches its edges count too. */
const overlaps = (start: number, length: number, from: number, to: number, margin = 0): boolean =>
  length <= 0
    ? start >= from - margin && start <= to + margin
    : start < to + margin && start + length > from - margin;

async function headingOf(store: KeyValueStore, projectId: string, sceneId: string) {
  const scene = await requireScene(store, 'movie.edit.edl', projectId, sceneId);
  return { position: scene.position, heading: scene.heading };
}

/** The version of a scene's cut a reader asked for, or the one it sees by default. */
async function pick(
  at: Acting,
  commandId: string,
  projectId: string,
  sceneId: string,
  version: 'cut' | 'draft' | undefined,
): Promise<{ cut: SceneCut; version: 'cut' | 'draft' }> {
  const { store } = at.runtime;
  await requireScene(store, commandId, projectId, sceneId);
  const draft = await readDraft(store, projectId, sceneId);
  const wantsDraft = version === 'draft' || (version === undefined && (await drafting(at)));
  if (draft !== undefined && wantsDraft) return { cut: draft.cut, version: 'draft' };
  return { cut: await readCut(store, projectId, sceneId), version: 'cut' };
}

async function look(at: Acting, projectId: string, sceneId: string, cut: SceneCut) {
  return viewOf(
    at.runtime.store,
    projectId,
    sceneId,
    cut,
    await itemsOf(at.runtime.store, projectId, cut),
  );
}

/** The markers of a scene as lines of an edit decision list, with their film time if asked. */
function markersText(markers: readonly PlacedMarker[], film: boolean): string {
  if (markers.length === 0) return '';
  const lines = markers.map(
    (marker) =>
      `  ${timecode(marker.atSeconds)}${film ? ` (film ${timecode(marker.filmSeconds)})` : ''} ${marker.kind}${marker.done ? ' (done)' : ''} by ${marker.by}: ${marker.text.replace(/\s+/g, ' ')} [marker ${marker.id}]`,
  );
  return `\n\nMARKERS\n${lines.join('\n')}`;
}

const pieceName = (item: { kind: 'shot' | 'title'; label: string }): string => {
  const words = item.label.trim().replace(/\s+/g, ' ');
  const short = words.length > 48 ? `${words.slice(0, 47)}…` : words;
  return item.kind === 'title' ? `title card "${short}"` : `shot "${short || 'untitled'}"`;
};

/**
 * A cut written out as an edit decision list: every piece of picture with its
 * time on the scene timeline and the stretch of its clip it uses, every line
 * that is heard, every sound on the audio lane. One read gives an agent the
 * whole scene, or a stretch of it, without media.
 */
export function edlText(
  view: CutView,
  scene: { position: number; heading: string },
  range?: { from: number; to: number },
): string {
  const within = (start: number, length: number): boolean =>
    range === undefined || overlaps(start, length, range.from, range.to);
  const lines: string[] = [];
  lines.push(
    `SCENE ${String(scene.position)} · ${scene.heading || 'Untitled'} · ${timecode(view.totalSeconds)}${
      range === undefined ? '' : ` · showing ${timecode(range.from)}-${timecode(range.to)}`
    }`,
  );
  lines.push('', 'PICTURE (start-end, piece, clip in-out, notes) [item id]');
  for (const item of view.items) {
    if (item.durationSeconds <= 0 || !within(item.startsAtSeconds, item.durationSeconds)) continue;
    const end = item.startsAtSeconds + item.durationSeconds;
    const notes: string[] = [];
    if (item.kind === 'shot') {
      notes.push(
        `clip ${item.trimStartSeconds.toFixed(2)}-${(item.sourceSeconds - item.trimEndSeconds).toFixed(2)} of ${item.sourceSeconds.toFixed(2)}`,
      );
      if (item.speed !== 1) notes.push(`speed ${String(item.speed)}x`);
      if (item.reverse) notes.push('reversed');
      if (item.holdSeconds > 0) notes.push(`holds last frame ${item.holdSeconds.toFixed(1)}`);
      if (item.zoom !== 1 || item.zoomTo !== null) {
        notes.push(
          `zoom ${item.zoom.toFixed(2)}${item.zoomTo === null ? '' : ` to ${item.zoomTo.toFixed(2)}`} on ${item.focusX.toFixed(2)},${item.focusY.toFixed(2)}`,
        );
      }
      if (!item.ownSound) notes.push('own sound silent');
      else {
        if (item.dialogueVolume < 1) notes.push(`dialogue ${item.dialogueVolume.toFixed(2)}`);
        if (item.hasClipAudio) notes.push(`clip sound ${item.clipAudioVolume.toFixed(2)}`);
      }
    }
    if (item.transition !== 'cut' && item.index > 1) {
      notes.push(
        `${item.transition} in ${item.transitionSeconds.toFixed(1)}${item.overlapSeconds > 0 ? ` (overlaps ${item.overlapSeconds.toFixed(2)})` : ''}`,
      );
    }
    if (item.fadeInSeconds > 0) notes.push(`fade in ${item.fadeInSeconds.toFixed(1)}`);
    if (item.fadeOutSeconds > 0) notes.push(`fade out ${item.fadeOutSeconds.toFixed(1)}`);
    lines.push(
      `${String(item.index).padStart(3, '0')}  ${timecode(item.startsAtSeconds)}-${timecode(end)}  ${pieceName(item)}  ${notes.join(', ')} [${item.itemId}]`,
    );
  }
  const spoken = view.spoken.filter((line) => within(line.startsAtSeconds, line.durationSeconds));
  if (spoken.length > 0) {
    lines.push('', 'SPOKEN');
    for (const line of spoken) {
      lines.push(
        `${timecode(line.startsAtSeconds)}-${timecode(line.startsAtSeconds + line.durationSeconds)}  ${line.who.toUpperCase()}: "${line.text}"${line.recorded ? '' : ' (not recorded)'} [${line.source} ${line.id}]`,
      );
    }
  }
  const sounds = view.sounds.filter((sound) =>
    within(
      sound.startSeconds,
      sound.loop ? Number.POSITIVE_INFINITY : (sound.durationSeconds ?? 0),
    ),
  );
  if (sounds.length > 0) {
    lines.push('', 'AUDIO LANE');
    for (const sound of sounds) {
      const notes = [`volume ${sound.volume.toFixed(2)}`];
      if (sound.loop) notes.push('loops to the end');
      if (sound.fadeInSeconds > 0) notes.push(`fade in ${sound.fadeInSeconds.toFixed(1)}`);
      if (sound.fadeOutSeconds > 0) notes.push(`fade out ${sound.fadeOutSeconds.toFixed(1)}`);
      if (!sound.recorded) notes.push('not recorded');
      lines.push(
        `${timecode(sound.startSeconds)}  ${sound.name} (${sound.kind})  ${notes.join(', ')} [${sound.id}]`,
      );
    }
  }
  const texts = view.texts.filter((text) => within(text.startSeconds, text.durationSeconds));
  if (texts.length > 0) {
    lines.push('', 'TEXT LANE (start-end, kind, style, words) [text id]');
    for (const text of texts) {
      const notes: string[] = [];
      if (text.follows !== null) notes.push(`follows ${text.follows}`);
      if (text.orphaned) notes.push('NOT SHOWN: what it follows is gone');
      lines.push(
        `${timecode(text.startSeconds)}-${timecode(text.startSeconds + text.durationSeconds)}  ${text.kind} (${text.styleId})  "${text.text.replace(/\n/g, ' / ')}"${notes.length > 0 ? `  ${notes.join(', ')}` : ''} [${text.id}]`,
      );
    }
  }
  const waiting = view.items.filter((item) => item.durationSeconds <= 0);
  if (waiting.length > 0 && range === undefined) {
    lines.push('', 'NOT IN THE FILM YET');
    for (const item of waiting) {
      lines.push(
        `${String(item.index).padStart(3, '0')}  ${pieceName(item)}: ${item.state} [${item.itemId}]`,
      );
    }
  }
  return lines.join('\n');
}

const FIELD_NAMES: Record<string, string> = {
  trimStartSeconds: 'trim start',
  trimEndSeconds: 'trim end',
  dialogueVolume: 'dialogue volume',
  clipAudioVolume: 'clip sound volume',
  fadeInSeconds: 'fade in',
  fadeOutSeconds: 'fade out',
  titleSeconds: 'length',
  durationSeconds: 'length',
  speed: 'speed',
  reverse: 'reversed',
  holdSeconds: 'held frame',
  zoom: 'zoom',
  zoomTo: 'zoom at the end',
  focusX: 'zoom across',
  focusY: 'zoom down',
  transition: 'transition',
  transitionSeconds: 'transition length',
  startSeconds: 'start',
  gainDb: 'gain (dB)',
  fadeCurve: 'fade shape',
  take: 'recording',
  text: 'words',
  styleId: 'style',
  anchor: 'timing',
  x: 'place across',
  y: 'place down',
};

function valueText(value: unknown): string {
  if (typeof value === 'number') return String(Math.round(value * 100) / 100);
  if (typeof value === 'string') return `"${value.length > 40 ? `${value.slice(0, 39)}…` : value}"`;
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (value === null || value === undefined) return 'none';
  return 'changed';
}

const fieldText = (field: FieldChange): string => {
  const name = FIELD_NAMES[field.name] ?? field.name;
  const after = valueText(field.after);
  return after === 'changed' ? `${name} changed` : `${name} ${valueText(field.before)} → ${after}`;
};

const ChangeView = z.object({
  id: z.string().describe('Pass to movie.edit.draft.keep or movie.edit.draft.reject.'),
  part: z.enum(['item', 'sound', 'line', 'text']),
  kind: z.enum(['added', 'removed', 'changed', 'moved']),
  elementId: z.string(),
  summary: z.string(),
  fields: z.array(z.object({ name: z.string(), before: z.unknown(), after: z.unknown() })),
  /** Where on the scene timeline: in the draft, or in the cut for something removed. */
  startsAtSeconds: z.number(),
  durationSeconds: z.number(),
  /** The person changed the same piece since the draft began; keeping replaces their change. */
  conflict: z.boolean(),
  /** Outside the stretch that was asked for. */
  outside: z.boolean(),
});
type ChangeView = z.infer<typeof ChangeView>;

interface Placed {
  readonly summary: string;
  readonly start: number;
  readonly length: number;
  readonly conflict: boolean;
}

interface Sides {
  readonly views: { readonly draft: CutView; readonly base: CutView };
  readonly parts: { readonly base: CutParts; readonly live: CutParts; readonly draft: CutParts };
}

const sameAs = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Whether the person changed a piece since the draft began. */
function changedMeanwhile<T extends { id: string }>(
  base: readonly T[],
  live: readonly T[],
  id: string,
): boolean {
  const before = base.find((candidate) => candidate.id === id);
  return (
    before !== undefined &&
    !sameAs(
      before,
      live.find((candidate) => candidate.id === id),
    )
  );
}

function placeItem(change: CutChange, view: CutView, sides: Sides, details: string): Placed {
  const item = view.items.find((candidate) => candidate.itemId === change.elementId);
  const name = item === undefined ? 'a piece' : pieceName(item);
  const start = item?.startsAtSeconds ?? 0;
  const { base, live } = sides.parts;
  const conflict =
    change.kind === 'added'
      ? live.items.some((candidate) => candidate.id === change.elementId)
      : changedMeanwhile(base.items, live.items, change.elementId);
  const summary =
    change.kind === 'added'
      ? `Added ${name} at ${timecode(start)}`
      : change.kind === 'removed'
        ? `Removed ${name} from ${timecode(start)}`
        : change.kind === 'moved'
          ? `Moved ${name} to place ${String(item?.index ?? 0)}, ${timecode(start)}`
          : `Changed ${name}: ${details}`;
  return { summary, start, length: item?.durationSeconds ?? 0, conflict };
}

function placeSound(change: CutChange, view: CutView, sides: Sides, details: string): Placed {
  const placement = view.sounds.find((candidate) => candidate.id === change.elementId);
  const name = placement?.name ?? 'a sound';
  const start = placement?.startSeconds ?? 0;
  const summary =
    change.kind === 'added'
      ? `Placed ${name} at ${timecode(start)}`
      : change.kind === 'removed'
        ? `Took ${name} off the audio lane`
        : `Changed ${name}: ${details}`;
  return {
    summary,
    start,
    length: placement?.durationSeconds ?? 0,
    conflict: changedMeanwhile(sides.parts.base.sounds, sides.parts.live.sounds, change.elementId),
  };
}

function placeLine(change: CutChange, view: CutView, sides: Sides, details: string): Placed {
  const line = view.lines.find((candidate) => candidate.id === change.elementId);
  const who = view.lanes.find((lane) => lane.characterId === line?.characterId)?.name ?? 'a';
  const words = line === undefined ? '' : ` "${line.text.slice(0, 40)}"`;
  const start = line?.startSeconds ?? 0;
  const summary =
    change.kind === 'added'
      ? `Added a line of ${who}${words} at ${timecode(start)}`
      : change.kind === 'removed'
        ? `Removed the line of ${who}${words}`
        : `Changed the line of ${who}${words}: ${details}`;
  return {
    summary,
    start,
    length: line?.durationSeconds ?? 0,
    conflict: changedMeanwhile(sides.parts.base.lines, sides.parts.live.lines, change.elementId),
  };
}

const TEXT_KINDS: Record<string, string> = {
  title: 'title',
  'lower-third': 'lower third',
  subtitle: 'subtitle',
  caption: 'caption',
  credits: 'credits',
};

function placeTextChange(change: CutChange, view: CutView, sides: Sides, details: string): Placed {
  const text = view.texts.find((candidate) => candidate.id === change.elementId);
  const kind = text === undefined ? 'text' : (TEXT_KINDS[text.kind] ?? 'text');
  const words = text === undefined ? '' : ` "${text.text.replace(/\s+/g, ' ').slice(0, 40)}"`;
  const start = text?.startSeconds ?? 0;
  const summary =
    change.kind === 'added'
      ? `Added the ${kind}${words} at ${timecode(start)}`
      : change.kind === 'removed'
        ? `Removed the ${kind}${words}`
        : `Changed the ${kind}${words}: ${details}`;
  return {
    summary,
    start,
    length: text?.durationSeconds ?? 0,
    conflict: changedMeanwhile(sides.parts.base.texts, sides.parts.live.texts, change.elementId),
  };
}

const PLACERS = {
  item: placeItem,
  sound: placeSound,
  line: placeLine,
  text: placeTextChange,
} as const;

/** Explains each change in words and places it on the timeline. */
function describeChanges(
  changes: readonly CutChange[],
  sides: Sides,
  request: CutRequest | null,
): ChangeView[] {
  return changes.map((change) => {
    const view = change.kind === 'removed' ? sides.views.base : sides.views.draft;
    const details = change.fields.map(fieldText).join(', ');
    const place = PLACERS[change.part];
    const { summary, start, length, conflict } = place(change, view, sides, details);
    const from = request?.fromSeconds ?? null;
    const to = request?.toSeconds ?? null;
    const outside =
      from !== null && to !== null && !overlaps(start, length, from, to, RANGE_MARGIN_SECONDS);
    return {
      id: change.id,
      part: change.part,
      kind: change.kind,
      elementId: change.elementId,
      summary,
      fields: change.fields.map((field) => ({ ...field })),
      startsAtSeconds: round(start),
      durationSeconds: round(length),
      conflict,
      outside,
    };
  });
}

function chosen(
  commandId: string,
  all: readonly CutChange[],
  ids: readonly string[] | undefined,
): CutChange[] {
  if (ids === undefined) return [...all];
  const unknown = ids.filter((id) => !all.some((change) => change.id === id));
  if (unknown.length > 0) {
    throw new CommandError(
      'invalid_input',
      commandId,
      `No proposed change "${unknown.join('", "')}". Read them with movie.edit.draft.get.`,
    );
  }
  return all.filter((change) => ids.includes(change.id));
}

const withParts = (cut: SceneCut, parts: CutParts): SceneCut => ({
  ...cut,
  items: [...parts.items],
  sounds: [...parts.sounds],
  lines: [...parts.lines],
  texts: [...parts.texts],
});

/**
 * Takes stills out of a video clip at times within it, as small JPEG
 * pictures, so that an agent can see a cut it cannot watch. Undefined for a
 * time it could not decode. The browser does it with WebCodecs, the local
 * server with ffmpeg.
 */
export type FrameGrabber = (
  video: MediaInput,
  atSeconds: readonly number[],
  width: number,
) => Promise<readonly (MediaInput | undefined)[]>;

/** How wide stills are: enough to judge framing, faces and light, small enough to send many. */
const STILL_WIDTH = 384;
/** The most stills one read returns, so that a long stretch cannot flood the context. */
const MAX_STILLS = 15;

const Still = z.object({
  itemId: z.string(),
  index: z.number().describe('The place of the item in the cut, from 1.'),
  sceneSeconds: z.number().describe('Where the still is on the scene timeline.'),
  clipSeconds: z.number().describe('Where the still is in the clip.'),
  key: z.string(),
});
type Still = z.infer<typeof Still>;

/** Seconds into a clip that show a piece: its first and last moments, and evenly between. */
export function stillTimes(from: number, to: number, count: number): number[] {
  const first = from + 0.04;
  const last = Math.max(first, to - 0.1);
  if (count <= 1 || last - first < 0.2) return [round(first)];
  return Array.from({ length: count }, (_, step) =>
    round(first + ((last - first) * step) / (count - 1)),
  );
}

/**
 * Stills of the pieces of a cut, read from the clips and kept beside them so
 * that the next read is free. Title cards have none; their words are in the
 * cut already.
 */
async function stillsOf(
  runtime: CoreRuntime,
  grab: FrameGrabber,
  projectId: string,
  items: CutView['items'],
  perItem: number,
): Promise<{ stills: Still[]; failed: number }> {
  const pieces = items.filter((item) => item.kind === 'shot' && item.durationSeconds > 0);
  const each = Math.max(1, Math.min(perItem, Math.floor(MAX_STILLS / Math.max(1, pieces.length))));
  const stills: Still[] = [];
  let failed = 0;
  for (const item of pieces.slice(0, MAX_STILLS)) {
    const stored = await runtime.store.get(`${shotPrefix(projectId, item.sceneId)}${item.shotId}`);
    const clip = stored === undefined ? null : Shot.parse(stored).clip;
    if (clip?.status !== 'ready' || clip.blobKey === null) continue;
    // Moments of the piece as it plays, read at the times of the clip they show.
    const moments = stillTimes(0, item.durationSeconds, each);
    const clipAt = new Map(moments.map((moment) => [moment, round(sourceTime(item, moment))]));
    const times = [...new Set(clipAt.values())];
    const keyAt = (seconds: number): string =>
      `${clip.blobKey ?? ''}.stills/${String(STILL_WIDTH)}/${seconds.toFixed(2)}`;
    const missing = [];
    for (const seconds of times) {
      if ((await runtime.blobs.list(keyAt(seconds))).length === 0) missing.push(seconds);
    }
    if (missing.length > 0) {
      const video = await runtime.blobs.get(clip.blobKey);
      const grabbed =
        video === undefined ? [] : await grab(video, missing, STILL_WIDTH).catch(() => []);
      for (const [at, seconds] of missing.entries()) {
        const picture = grabbed[at];
        if (picture !== undefined) await runtime.blobs.put(keyAt(seconds), picture);
      }
    }
    for (const [moment, seconds] of clipAt) {
      if ((await runtime.blobs.list(keyAt(seconds))).length === 0) {
        failed++;
        continue;
      }
      stills.push({
        itemId: item.itemId,
        index: item.index,
        sceneSeconds: round(item.startsAtSeconds + moment),
        clipSeconds: seconds,
        key: keyAt(seconds),
      });
    }
  }
  return { stills, failed };
}

async function attach(runtime: CoreRuntime, stills: readonly Still[]): Promise<MediaAttachment[]> {
  const attachments: MediaAttachment[] = [];
  for (const still of stills) {
    const blob = await runtime.blobs.get(still.key);
    if (blob !== undefined) {
      attachments.push({ key: still.key, mediaType: blob.mediaType, sizeBytes: blob.bytes.length });
    }
  }
  return attachments;
}

export function createReviewCommands(
  options: {
    /** Takes stills from clips for agents to look at; without it, reads come without pictures. */
    readonly frameGrabber?: FrameGrabber;
  } = {},
): readonly Command[] {
  const { frameGrabber } = options;

  async function requireDraft(
    store: KeyValueStore,
    commandId: string,
    projectId: string,
    sceneId: string,
  ): Promise<CutDraft> {
    await requireScene(store, commandId, projectId, sceneId);
    const draft = await readDraft(store, projectId, sceneId);
    if (draft === undefined) {
      throw new CommandError('invalid_input', commandId, 'No changes are proposed for this scene.');
    }
    return draft;
  }

  /** Writes what is left of a draft, or removes it when nothing is left. */
  async function store(
    kv: KeyValueStore,
    projectId: string,
    draft: CutDraft,
  ): Promise<{ remaining: number }> {
    const remaining = diffCut(partsOf(draft.base), partsOf(draft.cut)).length;
    const key = editDraftKey(projectId, draft.sceneId);
    await kv.batch([
      remaining === 0 ? { type: 'delete', key } : { type: 'put', key, value: draft },
    ]);
    return { remaining };
  }

  const draftGet = defineCommand({
    id: 'movie.edit.draft.get',
    title: 'Read proposed changes',
    description:
      'Lists the changes agents propose to the cut of a scene, like tracked changes: each with an id, what it does in words, where it is on the timeline, whether the person changed the same piece meanwhile (conflict) and whether it lies outside the stretch that was asked for. exists is false when nothing is proposed.',
    effect: 'read',
    input: z.object({ projectId: ProjectId, sceneId: SceneId }),
    output: z.object({
      exists: z.boolean(),
      sceneId: z.string(),
      authors: z.array(z.object({ id: z.string(), role: z.string() })),
      request: CutRequest.nullable(),
      createdAt: z.string().nullable(),
      updatedAt: z.string().nullable(),
      /** The cut changed since the draft began; kept changes are laid onto the cut as it is now. */
      cutChanged: z.boolean(),
      changes: z.array(ChangeView),
    }),
    handler: async ({ runtime, actor }, { projectId, sceneId }) => {
      const at = { runtime, actor };
      await requireScene(runtime.store, 'movie.edit.draft.get', projectId, sceneId);
      const draft = await readDraft(runtime.store, projectId, sceneId);
      if (draft === undefined) {
        return {
          exists: false,
          sceneId,
          authors: [],
          request: null,
          createdAt: null,
          updatedAt: null,
          cutChanged: false,
          changes: [],
        };
      }
      const live = await readCut(runtime.store, projectId, sceneId);
      const liveParts: CutParts = {
        ...partsOf(live),
        items: await itemsOf(runtime.store, projectId, live),
      };
      const parts = { base: partsOf(draft.base), live: liveParts, draft: partsOf(draft.cut) };
      const changes = diffCut(parts.base, parts.draft);
      return {
        exists: true,
        sceneId,
        authors: draft.authors,
        request: draft.request,
        createdAt: draft.createdAt,
        updatedAt: draft.updatedAt,
        cutChanged: diffCut(parts.base, liveParts).length > 0,
        changes: describeChanges(
          changes,
          {
            views: {
              draft: await look(at, projectId, sceneId, draft.cut),
              base: await look(at, projectId, sceneId, draft.base),
            },
            parts,
          },
          draft.request,
        ),
      };
    },
  });

  const keep = defineCommand({
    id: 'movie.edit.draft.keep',
    title: 'Keep proposed changes',
    description:
      'Takes proposed changes into the cut of a scene: all of them, or the ones named by id from movie.edit.draft.get. They land on the cut as it is now, so edits made meanwhile stay unless the same piece was changed. Keeping is one step that movie.edit.undo takes back. The rest stay proposed. An agent cannot keep a draft it worked on itself; the person, or another agent on their word, keeps it.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      changeIds: z
        .array(z.string())
        .min(1)
        .optional()
        .describe('The changes to keep. Leave out to keep all.'),
    }),
    output: z.object({ kept: z.number(), remaining: z.number() }),
    handler: async ({ runtime, actor }, { projectId, sceneId, changeIds }) => {
      const id = 'movie.edit.draft.keep';
      const draft = await requireDraft(runtime.store, id, projectId, sceneId);
      if (actor.kind === 'agent' && draft.authors.some((author) => author.id === actor.id)) {
        throw new CommandError(
          'invalid_input',
          id,
          'You cannot keep changes you proposed yourself. Say that they are ready; the person keeps or discards them.',
        );
      }
      const live = await readCut(runtime.store, projectId, sceneId);
      const liveParts: CutParts = {
        ...partsOf(live),
        items: await itemsOf(runtime.store, projectId, live),
      };
      const draftParts = partsOf(draft.cut);
      const picked = chosen(id, diffCut(partsOf(draft.base), draftParts), changeIds);
      if (picked.length > 0) {
        await save(
          runtime,
          projectId,
          live,
          withParts(live, applyChanges(liveParts, draftParts, picked)),
        );
      }
      const { remaining } = await store(runtime.store, projectId, {
        ...draft,
        base: withParts(draft.base, applyChanges(partsOf(draft.base), draftParts, picked)),
        updatedAt: runtime.now().toISOString(),
      });
      return { kept: picked.length, remaining };
    },
  });

  const reject = defineCommand({
    id: 'movie.edit.draft.reject',
    title: 'Reject proposed changes',
    description:
      'Takes single proposed changes, named by id from movie.edit.draft.get, back out of the draft so that the cut keeps its own version of those pieces. The others stay proposed. An agent can take back its own proposals this way, and undo it with movie.edit.undo.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      changeIds: z.array(z.string()).min(1),
    }),
    output: z.object({ rejected: z.number(), remaining: z.number() }),
    handler: async ({ runtime }, { projectId, sceneId, changeIds }) => {
      const id = 'movie.edit.draft.reject';
      const draft = await requireDraft(runtime.store, id, projectId, sceneId);
      const baseParts = partsOf(draft.base);
      const picked = chosen(id, diffCut(baseParts, partsOf(draft.cut)), changeIds);
      const next = applyChanges(partsOf(draft.cut), baseParts, picked.map(mirror));
      const { remaining } = await store(runtime.store, projectId, {
        ...draft,
        cut: withParts(draft.cut, next),
        undo: [...draft.undo, draft.cut],
        redo: [],
        updatedAt: runtime.now().toISOString(),
      });
      return { rejected: picked.length, remaining };
    },
  });

  const discard = defineCommand({
    id: 'movie.edit.draft.discard',
    title: 'Discard all proposed changes',
    description:
      'Throws away everything agents propose for the cut of a scene, and the request it answered. The cut stays as it is. This cannot be undone.',
    effect: 'destructive',
    input: z.object({ projectId: ProjectId, sceneId: SceneId }),
    output: z.object({ discarded: z.number() }),
    handler: async ({ runtime }, { projectId, sceneId }) => {
      const id = 'movie.edit.draft.discard';
      await requireScene(runtime.store, id, projectId, sceneId);
      const draft = await readDraft(runtime.store, projectId, sceneId);
      if (draft === undefined) return { discarded: 0 };
      await runtime.store.batch([{ type: 'delete', key: editDraftKey(projectId, sceneId) }]);
      return { discarded: diffCut(partsOf(draft.base), partsOf(draft.cut)).length };
    },
  });

  const request = defineCommand({
    id: 'movie.edit.request',
    title: 'Ask for changes to a stretch',
    description:
      'Starts a request for an agent to rework part of a scene: the instruction in the words of the person ("this drags", "make the argument tenser") and the stretch it is about, as a time range on the scene timeline, as items, or the whole scene when both are left out. The request is kept with the draft so that the proposal can be judged against it. Returns context to hand to the Film Editor with crew.ask, together with the instruction as the task.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      instruction: z.string().min(1).max(4000),
      fromSeconds: z.number().min(0).optional(),
      toSeconds: z.number().min(0).optional(),
      itemIds: z.array(z.string()).max(200).optional(),
    }),
    output: z.object({ request: CutRequest, context: z.string() }),
    handler: async ({ runtime, actor }, input) => {
      const id = 'movie.edit.request';
      const { store: kv } = runtime;
      const { projectId, sceneId } = input;
      const scene = await requireScene(kv, id, projectId, sceneId);
      const live = await readCut(kv, projectId, sceneId);
      const view = await look({ runtime, actor }, projectId, sceneId, live);
      const picked = view.items.filter((item) => input.itemIds?.includes(item.itemId));
      if (input.itemIds !== undefined && picked.length !== input.itemIds.length) {
        throw new CommandError('invalid_input', id, 'Some of those items are not in this cut.');
      }
      let from = input.fromSeconds ?? null;
      let to = input.toSeconds ?? null;
      if (picked.length > 0) {
        from = Math.min(...picked.map((item) => item.startsAtSeconds));
        to = Math.max(...picked.map((item) => item.startsAtSeconds + item.durationSeconds));
      }
      if ((from === null) !== (to === null)) {
        throw new CommandError('invalid_input', id, 'Give both fromSeconds and toSeconds.');
      }
      if (from !== null && to !== null && to <= from) {
        throw new CommandError('invalid_input', id, 'toSeconds must come after fromSeconds.');
      }
      const now = runtime.now().toISOString();
      const asked = CutRequest.parse({
        instruction: input.instruction,
        fromSeconds: from === null ? null : round(from),
        toSeconds: to === null ? null : round(to),
        itemIds: picked.map((item) => item.itemId),
        createdAt: now,
      });
      const existing = await readDraft(kv, projectId, sceneId);
      const explicit = withParts(live, {
        ...partsOf(live),
        items: await itemsOf(kv, projectId, live),
      });
      const draft: CutDraft = existing
        ? { ...existing, request: asked, updatedAt: now }
        : {
            sceneId,
            base: explicit,
            cut: explicit,
            undo: [],
            redo: [],
            authors: [],
            request: asked,
            createdAt: now,
            updatedAt: now,
          };
      await kv.batch([{ type: 'put', key: editDraftKey(projectId, sceneId), value: draft }]);
      const where =
        asked.fromSeconds === null || asked.toSeconds === null
          ? 'the whole scene'
          : `${timecode(asked.fromSeconds)}-${timecode(asked.toSeconds)} of the scene timeline${
              picked.length > 0
                ? `, items ${picked.map((item) => `${String(item.index)} [${item.itemId}]`).join(', ')}`
                : ''
            }`;
      const reading =
        asked.fromSeconds === null || asked.toSeconds === null
          ? `movie.edit.edl {"projectId":"${projectId}","sceneId":"${sceneId}"}`
          : `movie.edit.range {"projectId":"${projectId}","sceneId":"${sceneId}","fromSeconds":${String(asked.fromSeconds)},"toSeconds":${String(asked.toSeconds)}}`;
      return {
        request: asked,
        context: [
          `Edit request for scene ${String(scene.position)} "${scene.heading}" (projectId "${projectId}", sceneId "${sceneId}"): ${where}.`,
          `Read it first with ${reading}.`,
          'Change only that stretch and what joins it to its neighbours. Your edits become proposed changes that the person reviews; finish with a short account of what you changed and why, by time.',
        ].join(' '),
      };
    },
  });

  const range = defineCommand({
    id: 'movie.edit.range',
    title: 'Read a stretch of a cut',
    description:
      'Returns what lies in a stretch of a scene timeline: the pieces of picture that overlap it, the lines heard in it with who says them and when, the sounds on the audio lane, and the stretch written out as an edit decision list. Use it to work on part of a scene without reading all of it.',
    effect: 'read',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      fromSeconds: z.number().min(0),
      toSeconds: z.number().min(0),
      version: Version,
      stills: z
        .boolean()
        .default(true)
        .describe(
          'Show stills of the pieces of picture: the first and last moment of each, and the middle. Seen only by models that take images.',
        ),
    }),
    output: z.object({
      version: z.enum(['cut', 'draft']),
      fromSeconds: z.number(),
      toSeconds: z.number(),
      items: CutView.shape.items,
      spoken: CutView.shape.spoken,
      sounds: CutView.shape.sounds,
      edl: z.string(),
      stills: z.array(Still),
      attachments: z.array(MediaAttachment),
    }),
    handler: async ({ runtime, actor }, input) => {
      const id = 'movie.edit.range';
      if (input.toSeconds <= input.fromSeconds) {
        throw new CommandError('invalid_input', id, 'toSeconds must come after fromSeconds.');
      }
      const at = { runtime, actor };
      const { cut, version } = await pick(at, id, input.projectId, input.sceneId, input.version);
      const view = await look(at, input.projectId, input.sceneId, cut);
      const { fromSeconds: from, toSeconds: to } = input;
      const items = view.items.filter(
        (item) =>
          item.durationSeconds > 0 &&
          overlaps(item.startsAtSeconds, item.durationSeconds, from, to),
      );
      const { stills } =
        input.stills && frameGrabber !== undefined
          ? await stillsOf(runtime, frameGrabber, input.projectId, items, 3)
          : { stills: [] };
      return {
        version,
        fromSeconds: from,
        toSeconds: to,
        items,
        stills,
        attachments: await attach(runtime, stills),
        spoken: view.spoken.filter((line) =>
          overlaps(line.startsAtSeconds, line.durationSeconds, from, to),
        ),
        sounds: view.sounds.filter((sound) =>
          overlaps(
            sound.startSeconds,
            sound.loop ? Number.POSITIVE_INFINITY : (sound.durationSeconds ?? 0),
            from,
            to,
          ),
        ),
        edl: edlText(view, await headingOf(runtime.store, input.projectId, input.sceneId), {
          from,
          to,
        }),
      };
    },
  });

  const edl = defineCommand({
    id: 'movie.edit.edl',
    title: 'Read cut as text',
    description:
      'Writes the cut of a scene out as an edit decision list: one line per piece of picture with its time and the stretch of its clip, then every line heard with who says it and when, then the audio lane, with the ids to act on. The cheapest way to read and reason about a whole scene.',
    effect: 'read',
    input: z.object({ projectId: ProjectId, sceneId: SceneId, version: Version }),
    output: z.object({ version: z.enum(['cut', 'draft']), text: z.string() }),
    handler: async ({ runtime, actor }, { projectId, sceneId, version: asked }) => {
      const at = { runtime, actor };
      const { cut, version } = await pick(at, 'movie.edit.edl', projectId, sceneId, asked);
      return {
        version,
        text:
          edlText(
            await look(at, projectId, sceneId, cut),
            await headingOf(runtime.store, projectId, sceneId),
          ) + markersText(await placedMarkers(runtime.store, projectId, sceneId), false),
      };
    },
  });

  const filmEdl = defineCommand({
    id: 'movie.edit.film.edl',
    title: 'Read whole film as text',
    description:
      'Writes the whole film out as text, scene by scene: where each scene starts in the film and how long it lasts, then its edit decision list (times in it are from the start of the scene), then every marker with its film time. Give fromScene and toScene (scene positions) to read part of a long film. The way to reason about the film as one piece; read one scene with movie.edit.edl to work on it.',
    effect: 'read',
    input: z.object({
      projectId: ProjectId,
      fromScene: z.number().int().min(1).optional().describe('The first scene, by position.'),
      toScene: z.number().int().min(1).optional().describe('The last scene, by position.'),
    }),
    output: z.object({
      totalSeconds: z.number(),
      scenes: z.number(),
      text: z.string(),
    }),
    handler: async ({ runtime, actor }, { projectId, fromScene, toScene }) => {
      const id = 'movie.edit.film.edl';
      await requireProject(runtime.store, id, projectId, MODE_ID);
      const at = { runtime, actor };
      const scenes = (await runtime.store.list(movieSceneKey(projectId, '')))
        .map((entry) => Scene.parse(entry.value))
        .sort((a, b) => a.position - b.position);
      const markers = await placedMarkers(runtime.store, projectId);
      const parts: string[] = [];
      let filmAt = 0;
      let shown = 0;
      for (const scene of scenes) {
        const cut = await readCut(runtime.store, projectId, scene.id);
        const view = await look(at, projectId, scene.id, cut);
        const wanted =
          (fromScene === undefined || scene.position >= fromScene) &&
          (toScene === undefined || scene.position <= toScene);
        if (wanted) {
          shown++;
          parts.push(
            `== Film ${timecode(filmAt)} to ${timecode(filmAt + view.totalSeconds)} ==\n` +
              edlText(view, scene) +
              markersText(
                markers.filter((marker) => marker.sceneId === scene.id),
                true,
              ),
          );
        }
        filmAt += view.totalSeconds;
      }
      const head = `FILM · ${String(scenes.length)} scenes · ${timecode(filmAt)}`;
      return {
        totalSeconds: Math.round(filmAt * 1000) / 1000,
        scenes: shown,
        text: [head, ...parts].join('\n\n'),
      };
    },
  });

  const frames = defineCommand({
    id: 'movie.edit.frames',
    title: 'Look at stills of a cut',
    description:
      'Shows stills of the pieces of picture in a scene, taken from the clips as they are trimmed: the first and last moment of each piece and evenly between, up to 15 at once. Pick pieces by itemIds or a time range, or leave both out for the whole scene. Use it to judge continuity, framing and light across cuts. Seen only by models that take images.',
    effect: 'read',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      itemIds: z.array(z.string()).min(1).max(30).optional(),
      fromSeconds: z.number().min(0).optional(),
      toSeconds: z.number().min(0).optional(),
      perItem: z.number().int().min(1).max(5).default(3),
      version: Version,
    }),
    output: z.object({
      version: z.enum(['cut', 'draft']),
      stills: z.array(Still),
      /** Why some or all stills are missing, when they are. */
      note: z.string(),
      attachments: z.array(MediaAttachment),
    }),
    handler: async ({ runtime, actor }, input) => {
      const id = 'movie.edit.frames';
      const at = { runtime, actor };
      const { cut, version } = await pick(at, id, input.projectId, input.sceneId, input.version);
      const view = await look(at, input.projectId, input.sceneId, cut);
      const from = input.fromSeconds ?? 0;
      const to = input.toSeconds ?? Number.POSITIVE_INFINITY;
      const items = view.items.filter(
        (item) =>
          (input.itemIds === undefined || input.itemIds.includes(item.itemId)) &&
          overlaps(item.startsAtSeconds, item.durationSeconds, from, to),
      );
      if (frameGrabber === undefined) {
        return {
          version,
          stills: [],
          note: 'Stills cannot be taken here: this host has no video decoder.',
          attachments: [],
        };
      }
      const { stills, failed } = await stillsOf(
        runtime,
        frameGrabber,
        input.projectId,
        items,
        input.perItem,
      );
      const note =
        items.length === 0
          ? 'No piece of picture lies there.'
          : failed > 0
            ? `${String(failed)} stills could not be read from their clips.`
            : stills.length === 0
              ? 'Those pieces have no ready clips to take stills from.'
              : '';
      return { version, stills, note, attachments: await attach(runtime, stills) };
    },
  });

  return [draftGet, keep, reject, discard, request, range, edl, filmEdl, frames];
}
