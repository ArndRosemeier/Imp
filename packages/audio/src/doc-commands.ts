import {
  Actor,
  CommandError,
  defineCommand,
  projectPrefix,
  requireProject,
  type Command,
  type CommandContext,
  type CoreRuntime,
  type JsonValue,
} from '@imp/core';
import { z } from 'zod';
import {
  AudioDoc,
  copyRange,
  deleteRange,
  docDuration,
  insertSilence,
  Marker,
  pasteAt,
  regionDuration,
  regionEnd,
  renderDoc,
  silenceRange,
  splitRegion,
  Track,
} from './doc.js';
import type { StereoPcm } from './pcm.js';
import { toDecibels } from './pcm.js';
import { FadeCurve, SoundPlacement } from './placement.js';
import type { AudioSources } from './sources.js';
import { SAMPLE_RATE, snapSeconds, toFrames } from './time.js';
import { encodeWav } from './wav.js';

const ProjectId = z.string().min(1).describe('The id of a project from project.list.');
const DocId = z.string().min(1).describe('The id of an audio document from audio.doc.list.');
const Seconds = z.number().min(0);

const docPrefix = (projectId: string): string => `${projectPrefix(projectId)}audio/docs/`;
const docKey = (projectId: string, docId: string): string => `${docPrefix(projectId)}${docId}`;
const historyKey = (projectId: string, docId: string): string =>
  `${projectPrefix(projectId)}audio/history/${docId}`;
const clipboardKey = (projectId: string, actor: Actor): string =>
  `${projectPrefix(projectId)}audio/clipboard/${actor.kind}-${actor.id}`;
/** Where rendered files of a document go. Listening and exports are kept apart. */
export const audioRenderKey = (projectId: string, docId: string, name: string): string =>
  `${projectPrefix(projectId)}audio/renders/${docId}/${name}`;

/** One undoable step: the document as it was before, and who changed it. */
const HistoryEntry = z.object({
  label: z.string(),
  actor: Actor,
  at: z.string(),
  doc: AudioDoc,
});
const History = z.object({
  undo: z.array(HistoryEntry).default([]),
  redo: z.array(HistoryEntry).default([]),
});
type History = z.infer<typeof History>;
const HISTORY_LIMIT = 100;

const Clipboard = z.object({ seconds: z.number(), tracks: z.array(z.array(SoundPlacement)) });

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** The document as agents read it: everything that matters, nothing they cannot use. */
function outline(doc: AudioDoc) {
  return {
    id: doc.id,
    name: doc.name,
    durationSeconds: round3(docDuration(doc)),
    markers: doc.markers,
    tracks: doc.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      gainDb: track.gainDb,
      pan: track.pan,
      mute: track.mute,
      solo: track.solo,
      regions: track.regions.map((region) => ({
        id: region.id,
        label: region.label,
        key: region.blobKey,
        startSeconds: round3(region.startSeconds),
        endSeconds: round3(regionEnd(region)),
        trimStartSeconds: round3(region.trimStartSeconds),
        volume: region.volume,
        gainDb: region.gainDb,
        pan: region.pan,
        fadeInSeconds: region.fadeInSeconds,
        fadeOutSeconds: region.fadeOutSeconds,
        fadeCurve: region.fadeCurve,
      })),
    })),
  };
}

const RegionOutline = z.object({
  id: z.string(),
  label: z.string(),
  key: z.string(),
  startSeconds: z.number(),
  endSeconds: z.number(),
  trimStartSeconds: z.number(),
  volume: z.number(),
  gainDb: z.number(),
  pan: z.number(),
  fadeInSeconds: z.number(),
  fadeOutSeconds: z.number(),
  fadeCurve: FadeCurve,
});
const DocOutline = z.object({
  id: z.string(),
  name: z.string(),
  durationSeconds: z.number(),
  markers: z.array(Marker),
  tracks: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      gainDb: z.number(),
      pan: z.number(),
      mute: z.boolean(),
      solo: z.boolean(),
      regions: z.array(RegionOutline),
    }),
  ),
});

export interface AudioDocCommandOptions {
  /** The decoded-sound cache of a store. */
  readonly sources: (runtime: CoreRuntime) => AudioSources;
}

/** The commands that make and edit audio documents: the audio editor's whole ability. */
export function createAudioDocCommands(options: AudioDocCommandOptions): readonly Command[] {
  async function load(runtime: CoreRuntime, id: string, projectId: string, docId: string) {
    await requireProject(runtime.store, id, projectId);
    const stored = await runtime.store.get(docKey(projectId, docId));
    if (stored === undefined) {
      throw new CommandError('invalid_input', id, `No audio document "${docId}".`);
    }
    return AudioDoc.parse(stored);
  }

  async function history(runtime: CoreRuntime, projectId: string, docId: string) {
    return History.parse((await runtime.store.get(historyKey(projectId, docId))) ?? {});
  }

  /**
   * Applies one edit: reads the document, changes it, and stores it with the
   * step it replaced, in one batch. Every editing command goes through here,
   * so every change can be undone.
   */
  async function change(
    { runtime, actor }: CommandContext,
    id: string,
    projectId: string,
    docId: string,
    label: string,
    edit: (doc: AudioDoc) => AudioDoc | Promise<AudioDoc>,
  ): Promise<AudioDoc> {
    const before = await load(runtime, id, projectId, docId);
    const after = AudioDoc.parse({
      ...(await edit(AudioDoc.parse(before))),
      updatedAt: runtime.now().toISOString(),
    });
    const past = await history(runtime, projectId, docId);
    const entry = {
      label,
      actor,
      at: runtime.now().toISOString(),
      doc: before,
    };
    const next: History = { undo: [...past.undo, entry].slice(-HISTORY_LIMIT), redo: [] };
    await runtime.store.batch([
      { type: 'put', key: docKey(projectId, docId), value: after as unknown as JsonValue },
      { type: 'put', key: historyKey(projectId, docId), value: next as unknown as JsonValue },
    ]);
    return after;
  }

  const trackOf = (doc: AudioDoc, id: string, trackId: string): Track => {
    const track = doc.tracks.find((candidate) => candidate.id === trackId);
    if (track === undefined) throw new CommandError('invalid_input', id, `No track "${trackId}".`);
    return track;
  };

  const regionOf = (doc: AudioDoc, id: string, regionId: string) => {
    for (const track of doc.tracks) {
      const index = track.regions.findIndex((region) => region.id === regionId);
      const region = track.regions[index];
      if (region !== undefined) return { track, index, region };
    }
    throw new CommandError('invalid_input', id, `No region "${regionId}".`);
  };

  /** The tracks a range edit touches: those named, or all. */
  const tracksIn = (doc: AudioDoc, id: string, trackIds: readonly string[] | undefined) =>
    trackIds === undefined ? doc.tracks : trackIds.map((trackId) => trackOf(doc, id, trackId));

  const checkRange = (id: string, from: number, to: number): void => {
    if (to - from < 1 / SAMPLE_RATE) {
      throw new CommandError('invalid_input', id, 'The range must end after it starts.');
    }
  };

  const sourceLength = async (runtime: CoreRuntime, id: string, key: string): Promise<number> => {
    try {
      return (await options.sources(runtime).describe(key)).info.durationSeconds;
    } catch (error) {
      throw new CommandError('invalid_input', id, (error as Error).message, { cause: error });
    }
  };

  /** Decodes every file the document plays, so rendering can read samples synchronously. */
  async function decodeAll(runtime: CoreRuntime, doc: AudioDoc) {
    const decoded = new Map<string, StereoPcm>();
    for (const region of doc.tracks.flatMap((track) => track.regions)) {
      if (region.source === 'file' && region.blobKey !== '' && !decoded.has(region.blobKey)) {
        decoded.set(region.blobKey, await options.sources(runtime).pcm(region.blobKey));
      }
    }
    return (region: SoundPlacement) => decoded.get(region.blobKey);
  }

  async function renderRange(
    runtime: CoreRuntime,
    doc: AudioDoc,
    from: number,
    to: number,
  ): Promise<Uint8Array> {
    const source = await decodeAll(runtime, doc);
    const frames = Math.max(1, toFrames(to) - toFrames(from));
    const channels = renderDoc(doc, source, toFrames(from), frames);
    return encodeWav({ sampleRate: SAMPLE_RATE, channels });
  }

  const ok = z.object({ document: DocOutline });
  const done = (doc: AudioDoc) => ({ document: outline(doc) });

  const list = defineCommand({
    id: 'audio.doc.list',
    title: 'List audio documents',
    description:
      'Returns the audio documents of a project: id, name, length and how many tracks each has. Read one with audio.doc.get.',
    effect: 'read',
    input: z.object({ projectId: ProjectId }),
    output: z.object({
      documents: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          durationSeconds: z.number(),
          tracks: z.number(),
          updatedAt: z.string(),
        }),
      ),
    }),
    handler: async ({ runtime }, { projectId }) => {
      await requireProject(runtime.store, 'audio.doc.list', projectId);
      const entries = await runtime.store.list(docPrefix(projectId));
      return {
        documents: entries
          .map((entry) => AudioDoc.parse(entry.value))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((doc) => ({
            id: doc.id,
            name: doc.name,
            durationSeconds: round3(docDuration(doc)),
            tracks: doc.tracks.length,
            updatedAt: doc.updatedAt,
          })),
      };
    },
  });

  const get = defineCommand({
    id: 'audio.doc.get',
    title: 'Read an audio document',
    description:
      'Returns an audio document: its tracks (level, pan, mute, solo) and on each the regions with where they start and end in seconds, from where in their source they play, their volume, gain, pan and fades, plus the markers. Times are seconds from the start of the document.',
    effect: 'read',
    input: z.object({ projectId: ProjectId, docId: DocId }),
    output: ok,
    handler: async ({ runtime }, { projectId, docId }) =>
      done(await load(runtime, 'audio.doc.get', projectId, docId)),
  });

  const create = defineCommand({
    id: 'audio.doc.create',
    title: 'New audio document',
    description:
      'Makes an audio document to edit sound in. Pass stored sounds by key (the blobKey of a sound take, dialogue or voice sample) to start with each on its own track at the beginning, or none for an empty document with one track.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      name: z.string().min(1).max(120),
      sources: z
        .array(z.object({ key: z.string().min(1), label: z.string().max(120).default('') }))
        .max(16)
        .default([]),
    }),
    output: ok,
    handler: async ({ runtime }, { projectId, name, sources }) => {
      await requireProject(runtime.store, 'audio.doc.create', projectId);
      const tracks: Track[] = [];
      for (const [index, source] of sources.entries()) {
        const length = await sourceLength(runtime, 'audio.doc.create', source.key);
        tracks.push(
          Track.parse({
            id: runtime.newId(),
            name: source.label === '' ? `Track ${String(index + 1)}` : source.label,
            regions: [
              SoundPlacement.parse({
                id: runtime.newId(),
                source: 'file',
                blobKey: source.key,
                label: source.label,
                soundId: '',
                startSeconds: 0,
                durationSeconds: snapSeconds(length),
                volume: 1,
                fadeInSeconds: 0,
                fadeOutSeconds: 0,
                loop: false,
              }),
            ],
          }),
        );
      }
      if (tracks.length === 0) tracks.push(Track.parse({ id: runtime.newId(), name: 'Track 1' }));
      const now = runtime.now().toISOString();
      const doc = AudioDoc.parse({
        id: runtime.newId(),
        name,
        tracks,
        markers: [],
        createdAt: now,
        updatedAt: now,
      });
      await runtime.store.batch([
        { type: 'put', key: docKey(projectId, doc.id), value: doc as unknown as JsonValue },
      ]);
      return done(doc);
    },
  });

  const rename = defineCommand({
    id: 'audio.doc.rename',
    title: 'Rename audio document',
    description: 'Gives an audio document a new name.',
    effect: 'write',
    input: z.object({ projectId: ProjectId, docId: DocId, name: z.string().min(1).max(120) }),
    output: ok,
    handler: async (context, { projectId, docId, name }) =>
      done(
        await change(context, 'audio.doc.rename', projectId, docId, 'Rename', (doc) => ({
          ...doc,
          name,
        })),
      ),
  });

  const remove = defineCommand({
    id: 'audio.doc.delete',
    title: 'Delete audio document',
    description:
      'Deletes an audio document with its history and renders. The sounds it played stay where they are stored. Cannot be undone.',
    effect: 'destructive',
    input: z.object({ projectId: ProjectId, docId: DocId }),
    output: z.object({ deleted: z.string() }),
    handler: async ({ runtime }, { projectId, docId }) => {
      await load(runtime, 'audio.doc.delete', projectId, docId);
      await runtime.store.batch([
        { type: 'delete', key: docKey(projectId, docId) },
        { type: 'delete', key: historyKey(projectId, docId) },
      ]);
      for (const key of await runtime.blobs.list(audioRenderKey(projectId, docId, ''))) {
        await runtime.blobs.delete(key);
      }
      return { deleted: docId };
    },
  });

  const trackAdd = defineCommand({
    id: 'audio.track.add',
    title: 'Add track',
    description: 'Adds an empty track at the bottom of an audio document.',
    effect: 'write',
    input: z.object({ projectId: ProjectId, docId: DocId, name: z.string().min(1).max(80) }),
    output: ok,
    handler: async (context, { projectId, docId, name }) =>
      done(
        await change(context, 'audio.track.add', projectId, docId, 'Add track', (doc) => ({
          ...doc,
          tracks: [...doc.tracks, Track.parse({ id: context.runtime.newId(), name })],
        })),
      ),
  });

  const trackUpdate = defineCommand({
    id: 'audio.track.update',
    title: 'Change track',
    description:
      'Changes a track: its name, gain in dB (-60 to 24; 0 leaves it as it is), pan (-1 left to 1 right), mute or solo. When any track is soloed, only soloed tracks play. Fields left out stay as they are.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      docId: DocId,
      trackId: z.string().min(1),
      name: z.string().min(1).max(80).optional(),
      gainDb: z.number().min(-60).max(24).optional(),
      pan: z.number().min(-1).max(1).optional(),
      mute: z.boolean().optional(),
      solo: z.boolean().optional(),
    }),
    output: ok,
    handler: async (context, { projectId, docId, trackId, ...fields }) =>
      done(
        await change(context, 'audio.track.update', projectId, docId, 'Change track', (doc) => {
          trackOf(doc, 'audio.track.update', trackId);
          return {
            ...doc,
            tracks: doc.tracks.map((track) =>
              track.id === trackId ? { ...track, ...definedFields(fields) } : track,
            ),
          };
        }),
      ),
  });

  const trackRemove = defineCommand({
    id: 'audio.track.remove',
    title: 'Remove track',
    description: 'Removes a track and its regions from an audio document. Undo brings it back.',
    effect: 'write',
    input: z.object({ projectId: ProjectId, docId: DocId, trackId: z.string().min(1) }),
    output: ok,
    handler: async (context, { projectId, docId, trackId }) =>
      done(
        await change(context, 'audio.track.remove', projectId, docId, 'Remove track', (doc) => {
          trackOf(doc, 'audio.track.remove', trackId);
          return { ...doc, tracks: doc.tracks.filter((track) => track.id !== trackId) };
        }),
      ),
  });

  const regionInsert = defineCommand({
    id: 'audio.region.insert',
    title: 'Place sound',
    description:
      'Places a stored sound (by its blob key) on a track at a time. By default the whole sound plays from its start; trimStartSeconds skips into it and durationSeconds shortens it. It may overlap other regions; overlaps mix.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      docId: DocId,
      trackId: z.string().min(1),
      key: z.string().min(1).describe('The blob key of the sound.'),
      label: z.string().max(120).default(''),
      startSeconds: Seconds,
      trimStartSeconds: Seconds.default(0),
      durationSeconds: z.number().positive().optional(),
      volume: z.number().min(0).max(1).default(1),
    }),
    output: ok,
    handler: async (context, input) => {
      const length = await sourceLength(context.runtime, 'audio.region.insert', input.key);
      const available = length - input.trimStartSeconds;
      if (available <= 0) {
        throw new CommandError(
          'invalid_input',
          'audio.region.insert',
          `The sound is ${length.toFixed(3)} seconds long; trimStartSeconds must be less.`,
        );
      }
      return done(
        await change(
          context,
          'audio.region.insert',
          input.projectId,
          input.docId,
          'Place sound',
          (doc) => {
            trackOf(doc, 'audio.region.insert', input.trackId);
            const region = SoundPlacement.parse({
              id: context.runtime.newId(),
              source: 'file',
              blobKey: input.key,
              label: input.label,
              soundId: '',
              startSeconds: snapSeconds(input.startSeconds),
              trimStartSeconds: snapSeconds(input.trimStartSeconds),
              durationSeconds: snapSeconds(Math.min(input.durationSeconds ?? available, available)),
              volume: input.volume,
              fadeInSeconds: 0,
              fadeOutSeconds: 0,
              loop: false,
            });
            return {
              ...doc,
              tracks: doc.tracks.map((track) =>
                track.id === input.trackId
                  ? { ...track, regions: [...track.regions, region] }
                  : track,
              ),
            };
          },
        ),
      );
    },
  });

  const regionUpdate = defineCommand({
    id: 'audio.region.update',
    title: 'Change region',
    description:
      'Changes a region: where it starts, which track it is on (moving it), how far into its source it starts and how long it plays (trimming), its volume (0 to 1), gain in dB (to raise a quiet take), pan, fades and fade curve ("linear" or "smooth"). Fields left out stay as they are.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      docId: DocId,
      regionId: z.string().min(1),
      trackId: z.string().min(1).optional().describe('Moves the region to this track.'),
      label: z.string().max(120).optional(),
      startSeconds: Seconds.optional(),
      trimStartSeconds: Seconds.optional(),
      durationSeconds: z.number().positive().optional(),
      volume: z.number().min(0).max(1).optional(),
      gainDb: z.number().min(-60).max(24).optional(),
      pan: z.number().min(-1).max(1).optional(),
      fadeInSeconds: Seconds.optional(),
      fadeOutSeconds: Seconds.optional(),
      fadeCurve: FadeCurve.optional(),
    }),
    output: ok,
    handler: async (context, { projectId, docId, regionId, trackId, ...fields }) => {
      const doc = await load(context.runtime, 'audio.region.update', projectId, docId);
      const { region } = regionOf(doc, 'audio.region.update', regionId);
      const trim = fields.trimStartSeconds ?? region.trimStartSeconds;
      if (region.source === 'file' && region.blobKey !== '') {
        const length = await sourceLength(context.runtime, 'audio.region.update', region.blobKey);
        const duration = fields.durationSeconds ?? regionDuration(region);
        if (trim + duration > length + 1 / SAMPLE_RATE) {
          throw new CommandError(
            'invalid_input',
            'audio.region.update',
            `The source is ${length.toFixed(3)} seconds long; trim plus duration cannot pass its end.`,
          );
        }
      }
      return done(
        await change(
          context,
          'audio.region.update',
          projectId,
          docId,
          'Change region',
          (current) => {
            const found = regionOf(current, 'audio.region.update', regionId);
            const target =
              trackId === undefined
                ? found.track
                : trackOf(current, 'audio.region.update', trackId);
            const changed = SoundPlacement.parse({
              ...found.region,
              ...definedFields(fields),
              startSeconds: snapSeconds(fields.startSeconds ?? found.region.startSeconds),
              trimStartSeconds: snapSeconds(trim),
              durationSeconds: snapSeconds(fields.durationSeconds ?? regionDuration(found.region)),
            });
            return {
              ...current,
              tracks: current.tracks.map((track) => {
                const kept = track.regions.filter((r) => r.id !== regionId);
                return track.id === target.id
                  ? { ...track, regions: [...kept, changed] }
                  : { ...track, regions: kept };
              }),
            };
          },
        ),
      );
    },
  });

  const regionSplit = defineCommand({
    id: 'audio.region.split',
    title: 'Split region',
    description:
      'Splits a region in two at a time inside it, so each part can be moved, trimmed or removed alone.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      docId: DocId,
      regionId: z.string().min(1),
      atSeconds: Seconds,
    }),
    output: ok,
    handler: async (context, { projectId, docId, regionId, atSeconds }) =>
      done(
        await change(context, 'audio.region.split', projectId, docId, 'Split', (doc) => {
          const { track, index, region } = regionOf(doc, 'audio.region.split', regionId);
          const parts = splitRegion(region, atSeconds, context.runtime.newId);
          if (parts.length === 1) {
            throw new CommandError(
              'invalid_input',
              'audio.region.split',
              `The region plays from ${String(round3(region.startSeconds))} to ${String(round3(regionEnd(region)))} seconds; split inside that.`,
            );
          }
          const regions = [...track.regions];
          regions.splice(index, 1, ...parts);
          return {
            ...doc,
            tracks: doc.tracks.map((t) => (t.id === track.id ? { ...t, regions } : t)),
          };
        }),
      ),
  });

  const regionDuplicate = defineCommand({
    id: 'audio.region.duplicate',
    title: 'Duplicate region',
    description: 'Copies a region right after itself on the same track, or at startSeconds.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      docId: DocId,
      regionId: z.string().min(1),
      startSeconds: Seconds.optional(),
    }),
    output: ok,
    handler: async (context, { projectId, docId, regionId, startSeconds }) =>
      done(
        await change(context, 'audio.region.duplicate', projectId, docId, 'Duplicate', (doc) => {
          const { track, region } = regionOf(doc, 'audio.region.duplicate', regionId);
          const copy = {
            ...region,
            id: context.runtime.newId(),
            startSeconds: snapSeconds(startSeconds ?? regionEnd(region)),
          };
          return {
            ...doc,
            tracks: doc.tracks.map((t) =>
              t.id === track.id ? { ...t, regions: [...t.regions, copy] } : t,
            ),
          };
        }),
      ),
  });

  const regionRemove = defineCommand({
    id: 'audio.region.remove',
    title: 'Remove region',
    description: 'Takes a region off its track, leaving a gap. Undo brings it back.',
    effect: 'write',
    input: z.object({ projectId: ProjectId, docId: DocId, regionId: z.string().min(1) }),
    output: ok,
    handler: async (context, { projectId, docId, regionId }) =>
      done(
        await change(context, 'audio.region.remove', projectId, docId, 'Remove region', (doc) => {
          regionOf(doc, 'audio.region.remove', regionId);
          return {
            ...doc,
            tracks: doc.tracks.map((t) => ({
              ...t,
              regions: t.regions.filter((r) => r.id !== regionId),
            })),
          };
        }),
      ),
  });

  const Range = {
    projectId: ProjectId,
    docId: DocId,
    trackIds: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe('The tracks to edit; all when left out.'),
    fromSeconds: Seconds,
    toSeconds: Seconds,
  };

  /** Runs a range edit on each chosen track. */
  const rangeEdit =
    (
      id: string,
      label: string,
      edit: (
        regions: readonly SoundPlacement[],
        from: number,
        to: number,
        newId: () => string,
      ) => SoundPlacement[],
    ) =>
    async (
      context: CommandContext,
      input: {
        projectId: string;
        docId: string;
        trackIds?: string[] | undefined;
        fromSeconds: number;
        toSeconds: number;
      },
    ) => {
      checkRange(id, input.fromSeconds, input.toSeconds);
      return change(context, id, input.projectId, input.docId, label, (doc) => {
        const chosen = new Set(tracksIn(doc, id, input.trackIds).map((track) => track.id));
        return {
          ...doc,
          tracks: doc.tracks.map((track) =>
            chosen.has(track.id)
              ? {
                  ...track,
                  regions: edit(
                    track.regions,
                    input.fromSeconds,
                    input.toSeconds,
                    context.runtime.newId,
                  ),
                }
              : track,
          ),
        };
      });
    };

  async function copyToClipboard(
    { runtime, actor }: CommandContext,
    id: string,
    input: {
      projectId: string;
      docId: string;
      trackIds?: string[] | undefined;
      fromSeconds: number;
      toSeconds: number;
    },
  ) {
    checkRange(id, input.fromSeconds, input.toSeconds);
    const doc = await load(runtime, id, input.projectId, input.docId);
    const clip = {
      seconds: snapSeconds(input.toSeconds) - snapSeconds(input.fromSeconds),
      tracks: tracksIn(doc, id, input.trackIds).map((track) =>
        copyRange(track.regions, input.fromSeconds, input.toSeconds, runtime.newId),
      ),
    };
    await runtime.store.batch([
      {
        type: 'put',
        key: clipboardKey(input.projectId, actor),
        value: clip as unknown as JsonValue,
      },
    ]);
    return clip;
  }

  const ClipOut = z.object({ copiedSeconds: z.number(), tracks: z.number() });

  const editCopy = defineCommand({
    id: 'audio.edit.copy',
    title: 'Copy',
    description:
      'Copies what plays between two times on the chosen tracks (all by default) to your clipboard, for audio.edit.paste. Each person and agent has their own clipboard.',
    effect: 'write',
    input: z.object(Range),
    output: ClipOut,
    handler: async (context, input) => {
      const clip = await copyToClipboard(context, 'audio.edit.copy', input);
      return { copiedSeconds: round3(clip.seconds), tracks: clip.tracks.length };
    },
  });

  const deleteHandler = rangeEdit('audio.edit.delete', 'Delete', deleteRange);
  const editDelete = defineCommand({
    id: 'audio.edit.delete',
    title: 'Delete range',
    description:
      'Removes what plays between two times on the chosen tracks (all by default) and closes the gap: everything after moves earlier. To leave a gap instead, use audio.edit.silence.',
    effect: 'write',
    input: z.object(Range),
    output: ok,
    handler: async (context, input) => done(await deleteHandler(context, input)),
  });

  const editCut = defineCommand({
    id: 'audio.edit.cut',
    title: 'Cut',
    description:
      'Copies what plays between two times on the chosen tracks to your clipboard, then removes it and closes the gap.',
    effect: 'write',
    input: z.object(Range),
    output: ok,
    handler: async (context, input) => {
      await copyToClipboard(context, 'audio.edit.cut', input);
      return done(await rangeEdit('audio.edit.cut', 'Cut', deleteRange)(context, input));
    },
  });

  const silenceHandler = rangeEdit('audio.edit.silence', 'Silence', silenceRange);
  const editSilence = defineCommand({
    id: 'audio.edit.silence',
    title: 'Silence range',
    description:
      'Removes what plays between two times on the chosen tracks, leaving silence; nothing moves.',
    effect: 'write',
    input: z.object(Range),
    output: ok,
    handler: async (context, input) => done(await silenceHandler(context, input)),
  });

  const editInsertSilence = defineCommand({
    id: 'audio.edit.insertSilence',
    title: 'Insert silence',
    description:
      'Opens a gap of some seconds at a time on the chosen tracks (all by default): what plays from there on moves later, and a region across the time is split.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      docId: DocId,
      trackIds: Range.trackIds,
      atSeconds: Seconds,
      seconds: z.number().positive().max(3600),
    }),
    output: ok,
    handler: async (context, input) =>
      done(
        await change(
          context,
          'audio.edit.insertSilence',
          input.projectId,
          input.docId,
          'Insert silence',
          (doc) => {
            const chosen = new Set(
              tracksIn(doc, 'audio.edit.insertSilence', input.trackIds).map((t) => t.id),
            );
            return {
              ...doc,
              tracks: doc.tracks.map((track) =>
                chosen.has(track.id)
                  ? {
                      ...track,
                      regions: insertSilence(
                        track.regions,
                        input.atSeconds,
                        input.seconds,
                        context.runtime.newId,
                      ),
                    }
                  : track,
              ),
            };
          },
        ),
      ),
  });

  const editPaste = defineCommand({
    id: 'audio.edit.paste',
    title: 'Paste',
    description:
      'Pastes your clipboard at a time, starting at the given track and going down one track per copied track. What follows on those tracks moves later by the pasted length.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      docId: DocId,
      trackId: z.string().min(1),
      atSeconds: Seconds,
    }),
    output: ok,
    handler: async (context, { projectId, docId, trackId, atSeconds }) => {
      const stored = await context.runtime.store.get(clipboardKey(projectId, context.actor));
      if (stored === undefined) {
        throw new CommandError(
          'invalid_input',
          'audio.edit.paste',
          'Your clipboard is empty. Copy or cut first.',
        );
      }
      const clip = Clipboard.parse(stored);
      return done(
        await change(context, 'audio.edit.paste', projectId, docId, 'Paste', (doc) => {
          const first = doc.tracks.indexOf(trackOf(doc, 'audio.edit.paste', trackId));
          if (first + clip.tracks.length > doc.tracks.length) {
            throw new CommandError(
              'invalid_input',
              'audio.edit.paste',
              `The clipboard holds ${String(clip.tracks.length)} tracks; there are not enough tracks from this one down. Add tracks first.`,
            );
          }
          return {
            ...doc,
            tracks: doc.tracks.map((track, index) => {
              const pieces = clip.tracks[index - first];
              return pieces === undefined
                ? track
                : {
                    ...track,
                    regions: pasteAt(
                      track.regions,
                      pieces,
                      atSeconds,
                      clip.seconds,
                      context.runtime.newId,
                    ),
                  };
            }),
          };
        }),
      );
    },
  });

  const markerAdd = defineCommand({
    id: 'audio.marker.add',
    title: 'Add marker',
    description: 'Adds a named marker at a time, for a cue or a note.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      docId: DocId,
      atSeconds: Seconds,
      label: z.string().max(80),
    }),
    output: ok,
    handler: async (context, { projectId, docId, atSeconds, label }) =>
      done(
        await change(context, 'audio.marker.add', projectId, docId, 'Add marker', (doc) => ({
          ...doc,
          markers: [
            ...doc.markers,
            { id: context.runtime.newId(), atSeconds: snapSeconds(atSeconds), label },
          ].sort((a, b) => a.atSeconds - b.atSeconds),
        })),
      ),
  });

  const markerRemove = defineCommand({
    id: 'audio.marker.remove',
    title: 'Remove marker',
    description: 'Removes a marker from an audio document by its id.',
    effect: 'write',
    input: z.object({ projectId: ProjectId, docId: DocId, markerId: z.string().min(1) }),
    output: ok,
    handler: async (context, { projectId, docId, markerId }) =>
      done(
        await change(context, 'audio.marker.remove', projectId, docId, 'Remove marker', (doc) => {
          if (!doc.markers.some((marker) => marker.id === markerId)) {
            throw new CommandError(
              'invalid_input',
              'audio.marker.remove',
              `No marker "${markerId}".`,
            );
          }
          return { ...doc, markers: doc.markers.filter((marker) => marker.id !== markerId) };
        }),
      ),
  });

  const normalize = defineCommand({
    id: 'audio.normalize',
    title: 'Normalize',
    description:
      'Sets the gain of regions so that each one peaks at the same level (default -1 dB below full scale). Name regions, or a track for all its regions. Use it to even out lines recorded at different levels.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      docId: DocId,
      regionIds: z.array(z.string().min(1)).min(1).optional(),
      trackId: z.string().min(1).optional(),
      peakDb: z.number().min(-40).max(0).default(-1),
    }),
    output: ok,
    handler: async (context, { projectId, docId, regionIds, trackId, peakDb }) => {
      const doc = await load(context.runtime, 'audio.normalize', projectId, docId);
      const chosen =
        regionIds ??
        (trackId === undefined
          ? undefined
          : trackOf(doc, 'audio.normalize', trackId).regions.map((region) => region.id));
      if (chosen === undefined) {
        throw new CommandError('invalid_input', 'audio.normalize', 'Name regionIds or a trackId.');
      }
      const gains = new Map<string, number>();
      for (const regionId of chosen) {
        const { region } = regionOf(doc, 'audio.normalize', regionId);
        if (region.source !== 'file' || region.blobKey === '') continue;
        const pcm = await options.sources(context.runtime).pcm(region.blobKey);
        const from = toFrames(region.trimStartSeconds);
        const to = from + toFrames(regionDuration(region));
        let peak = 0;
        for (const channel of pcm.channels) {
          for (let i = from; i < to && i < channel.length; i++)
            peak = Math.max(peak, Math.abs(channel[i] ?? 0));
        }
        if (peak === 0 || region.volume === 0) continue;
        const gainDb = peakDb - toDecibels(peak * region.volume);
        gains.set(regionId, Math.round(Math.max(-60, Math.min(24, gainDb)) * 100) / 100);
      }
      return done(
        await change(context, 'audio.normalize', projectId, docId, 'Normalize', (current) => ({
          ...current,
          tracks: current.tracks.map((track) => ({
            ...track,
            regions: track.regions.map((region) => {
              const gainDb = gains.get(region.id);
              return gainDb === undefined ? region : { ...region, gainDb };
            }),
          })),
        })),
      );
    },
  });

  const HistoryOut = z.object({
    undo: z.array(z.object({ label: z.string(), actor: Actor, at: z.string() })),
    redo: z.array(z.object({ label: z.string(), actor: Actor, at: z.string() })),
  });

  const historyList = defineCommand({
    id: 'audio.history.list',
    title: 'Audio document history',
    description:
      'Lists the steps that can be undone and redone in an audio document, newest last, with who made each.',
    effect: 'read',
    input: z.object({ projectId: ProjectId, docId: DocId }),
    output: HistoryOut,
    handler: async ({ runtime }, { projectId, docId }) => {
      await load(runtime, 'audio.history.list', projectId, docId);
      const past = await history(runtime, projectId, docId);
      const strip = ({ label, actor, at }: z.infer<typeof HistoryEntry>) => ({ label, actor, at });
      return { undo: past.undo.map(strip), redo: past.redo.map(strip) };
    },
  });

  /** Moves steps from one stack to the other, keeping the document they replace. */
  async function travel(
    { runtime }: CommandContext,
    id: string,
    projectId: string,
    docId: string,
    direction: 'undo' | 'redo',
    wholeRun: boolean,
  ) {
    let doc = await load(runtime, id, projectId, docId);
    const past = await history(runtime, projectId, docId);
    const from = direction === 'undo' ? [...past.undo] : [...past.redo];
    const to = direction === 'undo' ? [...past.redo] : [...past.undo];
    const first = from.at(-1);
    if (first === undefined) {
      throw new CommandError('invalid_input', id, `There is nothing to ${direction}.`);
    }
    // A whole run is every step in a row by whoever made the newest one.
    const author = first.actor;
    let steps = 0;
    for (let entry = from.at(-1); entry !== undefined; entry = from.at(-1)) {
      if (steps > 0 && !(wholeRun && JSON.stringify(entry.actor) === JSON.stringify(author))) break;
      from.pop();
      to.push({ label: entry.label, actor: entry.actor, at: entry.at, doc });
      doc = entry.doc;
      steps += 1;
    }
    const next = direction === 'undo' ? { undo: from, redo: to } : { undo: to, redo: from };
    await runtime.store.batch([
      { type: 'put', key: docKey(projectId, docId), value: doc as unknown as JsonValue },
      { type: 'put', key: historyKey(projectId, docId), value: next as unknown as JsonValue },
    ]);
    return { steps, document: outline(doc) };
  }

  const TravelOut = z.object({ steps: z.number(), document: DocOutline });

  const undo = defineCommand({
    id: 'audio.history.undo',
    title: 'Undo audio edit',
    description:
      'Undoes the newest step in an audio document. With wholeRun, undoes every step in a row made by the same person or agent, for example a whole pass an agent made.',
    effect: 'write',
    input: z.object({ projectId: ProjectId, docId: DocId, wholeRun: z.boolean().default(false) }),
    output: TravelOut,
    handler: async (context, { projectId, docId, wholeRun }) =>
      travel(context, 'audio.history.undo', projectId, docId, 'undo', wholeRun),
  });

  const redo = defineCommand({
    id: 'audio.history.redo',
    title: 'Redo audio edit',
    description:
      'Redoes the newest undone step in an audio document, or with wholeRun all of a run.',
    effect: 'write',
    input: z.object({ projectId: ProjectId, docId: DocId, wholeRun: z.boolean().default(false) }),
    output: TravelOut,
    handler: async (context, { projectId, docId, wholeRun }) =>
      travel(context, 'audio.history.redo', projectId, docId, 'redo', wholeRun),
  });

  const RenderOut = z.object({
    key: z.string(),
    durationSeconds: z.number(),
    sizeBytes: z.number(),
  });

  const renderInput = z.object({
    projectId: ProjectId,
    docId: DocId,
    fromSeconds: Seconds.default(0),
    toSeconds: z.number().positive().optional().describe('Defaults to the end of the document.'),
  });

  async function renderFor(
    runtime: CoreRuntime,
    id: string,
    input: z.infer<typeof renderInput>,
    limitSeconds: number,
  ) {
    const doc = await load(runtime, id, input.projectId, input.docId);
    const end = Math.min(input.toSeconds ?? docDuration(doc), input.fromSeconds + limitSeconds);
    checkRange(id, input.fromSeconds, end);
    return { doc, end, bytes: await renderRange(runtime, doc, input.fromSeconds, end) };
  }

  const listen = defineCommand({
    id: 'audio.listen',
    title: 'Listen to audio',
    description:
      'Mixes a stretch of an audio document as it would export and hands it to you to listen to, if your model takes audio. Keep it short (a few seconds around what you changed, at most 30); compare before and after by listening, undoing and listening again. People use it to play the document.',
    effect: 'read',
    input: renderInput,
    output: RenderOut.extend({
      attachments: z.array(
        z.object({ key: z.string(), mediaType: z.string(), sizeBytes: z.number() }),
      ),
    }),
    handler: async ({ runtime, actor }, input) => {
      const limit = actor.kind === 'agent' ? 30 : 600;
      const { end, bytes } = await renderFor(runtime, 'audio.listen', input, limit);
      const key = audioRenderKey(input.projectId, input.docId, `listen-${actor.kind}.wav`);
      await runtime.blobs.put(key, { bytes, mediaType: 'audio/wav' });
      const result = {
        key,
        durationSeconds: round3(end - input.fromSeconds),
        sizeBytes: bytes.length,
      };
      return { ...result, attachments: [{ key, mediaType: 'audio/wav', sizeBytes: bytes.length }] };
    },
  });

  const exportCommand = defineCommand({
    id: 'audio.export',
    title: 'Export audio',
    description:
      'Mixes an audio document (or a stretch of it) to a WAV file at 48 kHz, 16 bit stereo, kept in the project. Returns its key; the file can be downloaded or used as a sound elsewhere.',
    effect: 'write',
    input: renderInput,
    output: RenderOut,
    handler: async ({ runtime }, input) => {
      const { end, bytes } = await renderFor(runtime, 'audio.export', input, 4 * 3600);
      const key = audioRenderKey(input.projectId, input.docId, `export-${runtime.newId()}.wav`);
      await runtime.blobs.put(key, { bytes, mediaType: 'audio/wav' });
      return { key, durationSeconds: round3(end - input.fromSeconds), sizeBytes: bytes.length };
    },
  });

  return [
    list,
    get,
    create,
    rename,
    remove,
    trackAdd,
    trackUpdate,
    trackRemove,
    regionInsert,
    regionUpdate,
    regionSplit,
    regionDuplicate,
    regionRemove,
    editCopy,
    editCut,
    editDelete,
    editSilence,
    editInsertSilence,
    editPaste,
    markerAdd,
    markerRemove,
    normalize,
    historyList,
    undo,
    redo,
    listen,
    exportCommand,
  ];
}

/** Drops fields that were left out, so a partial update only changes what was given. */
function definedFields<T extends Record<string, unknown>>(
  fields: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
