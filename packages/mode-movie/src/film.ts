import {
  AudioDoc,
  audioSourcesFor,
  MissingSourceError,
  renderDoc,
  toFrames,
  UnsupportedAudioError,
  type AudioCodec,
  type AudioSources,
  type SoundPlacement,
  type StereoPcm,
  type Track,
} from '@imp/audio';
import {
  CommandError,
  defineCommand,
  requireProject,
  type BlobStore,
  type Command,
  type CoreRuntime,
} from '@imp/core';
import { z } from 'zod';
import { filmExportPrefix, movieSceneKey, shotPrefix } from './commands.js';
import { itemsOf, laidOut, readCut, requireScene } from './edit.js';
import { createSceneAudioLink } from './scene-audio.js';
import { MODE_ID, Scene, Shot } from './schema.js';

/** What is on screen for a stretch of the film: a clip, or a title card on black. */
export type FilmPicture =
  | {
      readonly kind: 'clip';
      readonly startSeconds: number;
      readonly durationSeconds: number;
      readonly blobKey: string;
      /** Where in the clip the stretch starts (its trim). */
      readonly sourceStartSeconds: number;
      readonly fadeInSeconds: number;
      readonly fadeOutSeconds: number;
    }
  | {
      readonly kind: 'title';
      readonly startSeconds: number;
      readonly durationSeconds: number;
      readonly text: string;
      readonly fadeInSeconds: number;
      readonly fadeOutSeconds: number;
    };

/** The picture of a film, laid out in time, for a renderer to draw frame by frame. */
export interface FilmPlan {
  readonly durationSeconds: number;
  /** The frame size; null takes the size of the largest clip. */
  readonly height: number | null;
  /** Frames per second; null takes the rate most of the clips have. */
  readonly fps: number | null;
  readonly pictures: readonly FilmPicture[];
}

/** One render: the plan, and how the renderer reaches clips, sound and the file it writes. */
export interface FilmRenderJob {
  readonly plan: FilmPlan;
  /** The bytes of a stored clip. */
  readonly clip: (key: string) => Promise<Uint8Array | undefined>;
  /** The film's sound, mixed: stereo at 48 kHz, from a frame for a number of frames. */
  readonly mix: (
    startFrame: number,
    frames: number,
  ) => Promise<readonly [Float32Array, Float32Array]>;
  /** Writes bytes of the file at a position. Positions may go back (a header is filled in last). */
  readonly write: (data: Uint8Array, position: number) => Promise<void>;
  /** How far the render has come, in seconds of the film. */
  readonly progress: (seconds: number) => void;
  /** True once the render was cancelled; the renderer stops and throws. */
  readonly cancelled: () => boolean;
}

export interface FilmRendered {
  readonly mediaType: string;
  readonly extension: string;
  readonly videoCodec: string;
  readonly audioCodec: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
}

/**
 * Turns a plan into a video file. A host service: the browser host encodes
 * with WebCodecs in its worker, with no screen and faster than real time.
 */
export interface FilmRenderer {
  /** Why this host cannot render here, or null when it can. */
  readonly unavailable: () => string | null;
  readonly render: (job: FilmRenderJob) => Promise<FilmRendered>;
}

/** The size of the parts a film is stored in. */
export const PART_BYTES = 16 * 1024 * 1024;

/**
 * Writes a file of any length into the blob store as numbered parts, so that
 * no single stored value (and no buffer) holds a whole film. Writes may go
 * back to a part already stored, which is read, changed and stored again.
 */
export class PartWriter {
  readonly #open = new Map<number, Uint8Array>();
  readonly #stored = new Set<number>();
  #size = 0;

  constructor(
    private readonly blobs: BlobStore,
    private readonly keyOf: (index: number) => string,
    private readonly mediaType: string,
    private readonly partBytes = PART_BYTES,
  ) {}

  get size(): number {
    return this.#size;
  }

  async write(data: Uint8Array, position: number): Promise<void> {
    let offset = 0;
    while (offset < data.length) {
      const at = position + offset;
      const index = Math.floor(at / this.partBytes);
      const within = at - index * this.partBytes;
      const count = Math.min(data.length - offset, this.partBytes - within);
      const part = await this.#part(index);
      part.set(data.subarray(offset, offset + count), within);
      offset += count;
      this.#size = Math.max(this.#size, at + count);
    }
    // Every part wholly behind the furthest byte written is complete: store it and let it go.
    const head = Math.floor(this.#size / this.partBytes);
    for (const index of [...this.#open.keys()]) {
      if (index < head) await this.#flush(index);
    }
  }

  /** Stores what is still open and says how many parts the file has. */
  async finish(): Promise<{ parts: number; sizeBytes: number }> {
    for (const index of [...this.#open.keys()]) await this.#flush(index);
    return { parts: Math.ceil(this.#size / this.partBytes), sizeBytes: this.#size };
  }

  async #part(index: number): Promise<Uint8Array> {
    const open = this.#open.get(index);
    if (open !== undefined) return open;
    const part = new Uint8Array(this.partBytes);
    if (this.#stored.has(index)) {
      const stored = await this.blobs.get(this.keyOf(index));
      if (stored !== undefined) part.set(stored.bytes);
    }
    this.#open.set(index, part);
    return part;
  }

  async #flush(index: number): Promise<void> {
    const part = this.#open.get(index);
    if (part === undefined) return;
    const length = Math.min(this.partBytes, this.#size - index * this.partBytes);
    await this.blobs.put(this.keyOf(index), {
      bytes: part.slice(0, Math.max(0, length)),
      mediaType: this.mediaType,
    });
    this.#open.delete(index);
    this.#stored.add(index);
  }
}

const ProjectId = z.string().describe('The id of a movie project from project.list.');
const ExportId = z.string().describe('The id of a rendered film from movie.edit.export.list.');

const Status = z.enum(['rendering', 'ready', 'failed', 'cancelled']);
const NotReady = z.object({ sceneId: z.string(), index: z.number(), state: z.string() });

/** A rendered film (or one being rendered), as stored. Its file is in parts beside it. */
export const FilmExport = z.object({
  id: z.string(),
  label: z.string(),
  fileName: z.string(),
  sceneIds: z.array(z.string()),
  status: Status,
  /** Seconds of the film rendered so far, and its whole length. */
  progressSeconds: z.number(),
  durationSeconds: z.number(),
  mediaType: z.string().default('video/mp4'),
  videoCodec: z.string().default(''),
  audioCodec: z.string().default(''),
  width: z.number().default(0),
  height: z.number().default(0),
  fps: z.number().default(0),
  sizeBytes: z.number().default(0),
  /** How long the render has taken so far, in seconds of wall time. */
  renderSeconds: z.number().default(0),
  parts: z.number().default(0),
  /** Items that are in the film although not ready (dialogue missing, say), or left out. */
  notReady: z.array(NotReady).default([]),
  /** Sounds that could not be decoded and are silent in the film. */
  unheard: z.array(z.string()).default([]),
  error: z.string().default(''),
  by: z.string(),
  createdAt: z.string(),
  finishedAt: z.string().nullable().default(null),
});
export type FilmExport = z.infer<typeof FilmExport>;

const exportKey = (projectId: string, exportId: string): string =>
  `${filmExportPrefix(projectId)}${exportId}`;
/** Where part `index` of a rendered film's file is kept. */
export const filmPartKey = (projectId: string, exportId: string, index: number): string =>
  `${exportKey(projectId, exportId)}/part-${String(index).padStart(5, '0')}`;

/** One scene of the film: where it starts, its sound, and its pictures. */
interface PlannedScene {
  readonly sceneId: string;
  readonly startSeconds: number;
  readonly durationSeconds: number;
}

/** Lays the chosen scenes one after the other: the picture, and what is not ready. */
export async function planFilm(
  runtime: CoreRuntime,
  commandId: string,
  projectId: string,
  sceneIds: readonly string[],
): Promise<{
  pictures: FilmPicture[];
  scenes: PlannedScene[];
  durationSeconds: number;
  notReady: z.infer<typeof NotReady>[];
}> {
  const store = runtime.store;
  const shots = new Map(
    (await store.list(shotPrefix(projectId))).map((entry) => {
      const shot = Shot.parse(entry.value);
      return [shot.id, shot] as const;
    }),
  );
  const pictures: FilmPicture[] = [];
  const scenes: PlannedScene[] = [];
  const notReady: z.infer<typeof NotReady>[] = [];
  let at = 0;
  for (const sceneId of sceneIds) {
    await requireScene(store, commandId, projectId, sceneId);
    const cut = await readCut(store, projectId, sceneId);
    const laid = await laidOut(store, projectId, await itemsOf(store, projectId, cut));
    for (const item of laid.items) {
      if (item.state !== 'ready') {
        notReady.push({ sceneId, index: item.index, state: item.state });
      }
      if (item.durationSeconds <= 0) continue;
      const common = {
        startSeconds: at + item.startsAtSeconds,
        durationSeconds: item.durationSeconds,
        fadeInSeconds: item.fadeInSeconds,
        fadeOutSeconds: item.fadeOutSeconds,
      };
      if (item.kind === 'title') {
        pictures.push({ kind: 'title', text: item.text, ...common });
        continue;
      }
      const key = shots.get(item.shotId)?.clip?.blobKey;
      if (typeof key === 'string' && key !== '') {
        pictures.push({
          kind: 'clip',
          blobKey: key,
          sourceStartSeconds: item.trimStartSeconds,
          ...common,
        });
      }
    }
    scenes.push({ sceneId, startSeconds: at, durationSeconds: laid.totalSeconds });
    at += laid.totalSeconds;
  }
  return { pictures, scenes, durationSeconds: at, notReady };
}

/**
 * The film's sound, mixed scene by scene with the audio editor's engine, so
 * the export sounds as the scene sounds there (volumes, gain, fades, pan and
 * character lanes). Only the scene being rendered is kept decoded.
 */
class FilmMix {
  #scene: { index: number; doc: AudioDoc; decoded: Map<string, StereoPcm> } | undefined;
  readonly unheard = new Set<string>();
  readonly #link = createSceneAudioLink();

  constructor(
    private readonly runtime: CoreRuntime,
    private readonly projectId: string,
    private readonly scenes: readonly PlannedScene[],
    private readonly sources: AudioSources,
  ) {}

  async mix(startFrame: number, frames: number): Promise<[Float32Array, Float32Array]> {
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    const blockEnd = startFrame + frames;
    for (const [index, scene] of this.scenes.entries()) {
      const sceneStart = toFrames(scene.startSeconds);
      const sceneEnd = toFrames(scene.startSeconds + scene.durationSeconds);
      const from = Math.max(startFrame, sceneStart);
      const to = Math.min(blockEnd, sceneEnd);
      if (to <= from) continue;
      const { doc, decoded } = await this.#open(index, scene);
      const [sceneLeft, sceneRight] = renderDoc(
        doc,
        (region: SoundPlacement) => decoded.get(region.blobKey),
        from - sceneStart,
        to - from,
      );
      left.set(sceneLeft, from - startFrame);
      right.set(sceneRight, from - startFrame);
    }
    return [left, right];
  }

  async #open(index: number, scene: PlannedScene) {
    if (this.#scene?.index === index) return this.#scene;
    const lengthOf = (key: string) =>
      this.sources.describe(key).then(
        ({ info }) => info.durationSeconds,
        () => undefined,
      );
    const { name, tracks } = await this.#link.read(
      this.runtime,
      this.projectId,
      scene.sceneId,
      lengthOf,
    );
    const decoded = new Map<string, StereoPcm>();
    const regions = tracks.flatMap((track: Track) => track.regions);
    for (const region of regions) {
      const key = region.blobKey;
      if (key === '' || decoded.has(key)) continue;
      try {
        decoded.set(key, await this.sources.pcm(key));
      } catch (error) {
        if (!(error instanceof MissingSourceError || error instanceof UnsupportedAudioError)) {
          throw error;
        }
        this.unheard.add(region.label === '' ? region.id : region.label);
      }
    }
    const now = this.runtime.now().toISOString();
    const doc = AudioDoc.parse({ id: scene.sceneId, name, tracks, createdAt: now, updatedAt: now });
    this.#scene = { index, doc, decoded };
    return this.#scene;
  }
}

const RESOLUTIONS = { source: null, '720p': 720, '1080p': 1080, '2160p': 2160 } as const;

export interface FilmExportOptions {
  /** Decodes the stored sounds the mix plays. */
  readonly codec: AudioCodec;
  /** Encodes the film. Without one, this host cannot export and says so. */
  readonly renderer?: FilmRenderer;
}

const fileSafe = (text: string): string =>
  text
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'film';

/**
 * Renders a scene, several scenes or the whole film into a video file kept in
 * the project, offline: nothing is played, no screen is needed and it runs
 * faster than real time, so agents can export as well as people.
 */
export function createFilmExportCommands(options: FilmExportOptions): readonly Command[] {
  /** Renders running in this core, so that they can be cancelled and told from interrupted ones. */
  const running = new Map<string, { cancelled: boolean }>();

  const unavailable = (): string | null =>
    options.renderer === undefined
      ? 'This host cannot render films. Open Imp in a current Chrome, Edge or Safari (browser mode) to export.'
      : options.renderer.unavailable();

  /** A render that was running when the core stopped (a reload) is reported as failed. */
  const asSeen = (stored: FilmExport): FilmExport =>
    stored.status === 'rendering' && !running.has(stored.id)
      ? {
          ...stored,
          status: 'failed',
          error: 'The render was interrupted (Imp was closed or reloaded).',
        }
      : stored;

  async function readExport(
    runtime: CoreRuntime,
    commandId: string,
    projectId: string,
    id: string,
  ) {
    const stored = await runtime.store.get(exportKey(projectId, id));
    if (stored === undefined) {
      throw new CommandError('invalid_input', commandId, `No rendered film "${id}".`);
    }
    return asSeen(FilmExport.parse(stored));
  }

  async function removeParts(runtime: CoreRuntime, projectId: string, id: string) {
    for (const key of await runtime.blobs.list(`${exportKey(projectId, id)}/`)) {
      await runtime.blobs.delete(key);
    }
  }

  const exportFilm = defineCommand({
    id: 'movie.edit.export',
    title: 'Export the film',
    description:
      'Renders the cut of the whole film, or of the scenes you name, into one MP4 video file kept in the project: pictures with their trims and fades, title cards, and the sound mixed as in the audio editor (dialogue, clip sound, effects, music, character lanes, with volume, gain, fades and pan). It renders offline, faster than real time, and waits until the file is done (a few seconds to minutes). Returns the rendered film: its id, length, size, codecs, any items that were not ready, and sounds that could not be decoded. Check movie.edit.film first; items whose clip is missing take no time and are left out. The person downloads the file from the Edit screen. Only one film renders at a time.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneIds: z
        .array(z.string())
        .optional()
        .describe('Scene ids from movie.scene.list, in playing order. Defaults to every scene.'),
      resolution: z
        .enum(['source', '720p', '1080p', '2160p'])
        .default('source')
        .describe('Frame height. "source" (the default) takes the size of the largest clip.'),
      fps: z
        .union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)])
        .optional()
        .describe('Frames per second. Defaults to the rate most of the clips have.'),
      label: z
        .string()
        .max(60)
        .optional()
        .describe(
          'A short name for the file, like "rough-cut-2". Defaults to "film" or the scene.',
        ),
    }),
    output: FilmExport,
    handler: async ({ runtime, actor }, input) => {
      const id = 'movie.edit.export';
      const project = await requireProject(runtime.store, id, input.projectId, MODE_ID);
      const reason = unavailable();
      if (reason !== null || options.renderer === undefined) {
        throw new CommandError('invalid_input', id, reason ?? 'This host cannot render films.');
      }
      const busy = [...running.keys()][0];
      if (busy !== undefined) {
        throw new CommandError(
          'invalid_input',
          id,
          `A film is being rendered already ("${busy}"). Wait for it, or cancel it with movie.edit.export.cancel.`,
        );
      }
      const allScenes = (await runtime.store.list(movieSceneKey(input.projectId, '')))
        .map((entry) => Scene.parse(entry.value))
        .sort((a, b) => a.position - b.position);
      const sceneIds = input.sceneIds ?? allScenes.map((scene) => scene.id);
      if (sceneIds.length === 0) {
        throw new CommandError('invalid_input', id, 'The film has no scenes to export yet.');
      }
      const plan = await planFilm(runtime, id, input.projectId, sceneIds);
      if (plan.durationSeconds <= 0) {
        throw new CommandError(
          'invalid_input',
          id,
          'There is nothing in the cut to export yet: no item has a ready clip or is a title.',
        );
      }
      const single =
        sceneIds.length === 1 ? allScenes.find((scene) => scene.id === sceneIds[0]) : undefined;
      const whole =
        sceneIds.length === allScenes.length &&
        allScenes.every((scene, index) => scene.id === sceneIds[index]);
      const label =
        input.label ??
        (whole ? 'film' : single !== undefined ? `scene-${String(single.position)}` : 'scenes');
      const exportId = runtime.newId();
      const key = exportKey(input.projectId, exportId);
      let record: FilmExport = FilmExport.parse({
        id: exportId,
        label,
        fileName: `${fileSafe(project.name)}-${fileSafe(label)}.mp4`,
        sceneIds,
        status: 'rendering',
        progressSeconds: 0,
        durationSeconds: Math.round(plan.durationSeconds * 100) / 100,
        notReady: plan.notReady,
        by: actor.kind === 'agent' ? actor.role : 'you',
        createdAt: runtime.now().toISOString(),
      });
      await runtime.store.batch([{ type: 'put', key, value: record }]);
      const controller = { cancelled: false };
      running.set(exportId, controller);
      const writer = new PartWriter(
        runtime.blobs,
        (index) => filmPartKey(input.projectId, exportId, index),
        'video/mp4',
      );
      const mix = new FilmMix(
        runtime,
        input.projectId,
        plan.scenes,
        audioSourcesFor(runtime.blobs, options.codec),
      );
      let lastReport = 0;
      const started = runtime.now().getTime();
      const elapsed = () => Math.round((runtime.now().getTime() - started) / 100) / 10;
      const save = async (next: FilmExport) => {
        record = next;
        await runtime.store.batch([{ type: 'put', key, value: record }]);
      };
      try {
        const rendered = await options.renderer.render({
          plan: {
            durationSeconds: plan.durationSeconds,
            height: RESOLUTIONS[input.resolution],
            fps: input.fps ?? null,
            pictures: plan.pictures,
          },
          clip: async (blobKey) => (await runtime.blobs.get(blobKey))?.bytes,
          mix: (startFrame, frames) => mix.mix(startFrame, frames),
          write: (data, position) => writer.write(data, position),
          progress: (seconds) => {
            const now = runtime.now().getTime();
            if (now - lastReport < 1000) return;
            lastReport = now;
            void save({
              ...record,
              progressSeconds: Math.round(seconds * 10) / 10,
              renderSeconds: elapsed(),
            });
          },
          cancelled: () => controller.cancelled,
        });
        const file = await writer.finish();
        await save({
          ...record,
          status: 'ready',
          progressSeconds: record.durationSeconds,
          mediaType: rendered.mediaType,
          videoCodec: rendered.videoCodec,
          audioCodec: rendered.audioCodec,
          width: rendered.width,
          height: rendered.height,
          fps: rendered.fps,
          sizeBytes: file.sizeBytes,
          parts: file.parts,
          renderSeconds: elapsed(),
          unheard: [...mix.unheard],
          finishedAt: runtime.now().toISOString(),
        });
        return record;
      } catch (error) {
        await removeParts(runtime, input.projectId, exportId);
        const cancelled = controller.cancelled;
        const message = error instanceof Error ? error.message : String(error);
        await save({
          ...record,
          status: cancelled ? 'cancelled' : 'failed',
          error: cancelled ? '' : message,
          finishedAt: runtime.now().toISOString(),
        });
        throw new CommandError(
          'invalid_input',
          id,
          cancelled ? 'The export was cancelled.' : `The export failed: ${message}`,
          { cause: error },
        );
      } finally {
        running.delete(exportId);
      }
    },
  });

  const list = defineCommand({
    id: 'movie.edit.export.list',
    title: 'List rendered films',
    description:
      'Lists the films rendered with movie.edit.export, newest first, with their status (rendering with progress, ready, failed, cancelled), length, size and codecs, and whether this host can render at all.',
    effect: 'read',
    input: z.object({ projectId: ProjectId }),
    output: z.object({
      canRender: z.boolean(),
      reason: z.string(),
      exports: z.array(FilmExport),
    }),
    handler: async ({ runtime }, { projectId }) => {
      await requireProject(runtime.store, 'movie.edit.export.list', projectId, MODE_ID);
      const reason = unavailable();
      const exports = (await runtime.store.list(filmExportPrefix(projectId)))
        .map((entry) => asSeen(FilmExport.parse(entry.value)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { canRender: reason === null, reason: reason ?? '', exports };
    },
  });

  const cancel = defineCommand({
    id: 'movie.edit.export.cancel',
    title: 'Cancel a film render',
    description:
      'Stops a film that movie.edit.export is rendering. What was rendered is thrown away.',
    effect: 'write',
    input: z.object({ projectId: ProjectId, exportId: ExportId }),
    output: z.object({ cancelled: z.boolean() }),
    handler: async ({ runtime }, { projectId, exportId }) => {
      await readExport(runtime, 'movie.edit.export.cancel', projectId, exportId);
      const controller = running.get(exportId);
      if (controller !== undefined) controller.cancelled = true;
      return { cancelled: controller !== undefined };
    },
  });

  const remove = defineCommand({
    id: 'movie.edit.export.delete',
    title: 'Delete a rendered film',
    description:
      'Deletes a rendered film and its file from the project to free space. It can be rendered again from the cut at any time.',
    effect: 'destructive',
    input: z.object({ projectId: ProjectId, exportId: ExportId }),
    output: z.object({ deleted: z.boolean() }),
    handler: async ({ runtime }, { projectId, exportId }) => {
      const found = await readExport(runtime, 'movie.edit.export.delete', projectId, exportId);
      if (found.status === 'rendering') {
        throw new CommandError(
          'invalid_input',
          'movie.edit.export.delete',
          'This film is still rendering; cancel it first.',
        );
      }
      await removeParts(runtime, projectId, exportId);
      await runtime.store.batch([{ type: 'delete', key: exportKey(projectId, exportId) }]);
      return { deleted: true };
    },
  });

  return [exportFilm, list, cancel, remove];
}
