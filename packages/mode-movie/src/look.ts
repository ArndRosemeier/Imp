import {
  CommandError,
  defineCommand,
  requireProject,
  type Command,
  type CoreRuntime,
} from '@imp/core';
import type { MediaInput } from '@imp/providers';
import { z } from 'zod';
import { filmLookKey, shotPrefix } from './commands.js';
import {
  commitCut,
  itemsOf,
  laidOut,
  openCut,
  readCut,
  readFilmLook,
  requireScene,
  type LaidItem,
} from './edit.js';
import {
  FilmLook,
  Grade,
  gradeMatrix,
  gradeStats,
  LOOK_PRESETS,
  LookPreset,
  matchGrade,
  type ColorStats,
} from './grade.js';
import { sourceTime } from './piece-time.js';
import { MODE_ID, Shot, type CutItem, type SceneCut } from './schema.js';

/**
 * The look of the film and the colour of its shots: one grade laid over the
 * whole film, and matching one shot's colour to another's. A piece's own grade
 * is set with movie.edit.item.set.
 */

const ProjectId = z.string().describe('The id of a movie project from project.list.');
const SceneId = z.string().describe('The id of a scene from movie.scene.list.');

/**
 * Reads how the colours of a clip lie at times within it, from small frames,
 * to match shots to each other. Undefined for a time it could not decode. The
 * browser does it with WebCodecs, the local server with ffmpeg.
 */
export type ColorSampler = (
  video: MediaInput,
  atSeconds: readonly number[],
) => Promise<readonly (ColorStats | undefined)[]>;

/** The average of several frames' colours. */
function averageStats(all: readonly ColorStats[]): ColorStats | undefined {
  if (all.length === 0) return undefined;
  const mean = (pick: (stats: ColorStats) => number): number =>
    all.reduce((sum, stats) => sum + pick(stats), 0) / all.length;
  return {
    mean: [mean((s) => s.mean[0]), mean((s) => s.mean[1]), mean((s) => s.mean[2])],
    luma: mean((s) => s.luma),
    lumaSpread: mean((s) => s.lumaSpread),
    chroma: mean((s) => s.chroma),
  };
}

/** The colours of a piece as filmed, from a few moments of it, before any grade. */
async function pieceStats(
  runtime: CoreRuntime,
  sample: ColorSampler,
  projectId: string,
  item: LaidItem,
): Promise<ColorStats | undefined> {
  const stored = await runtime.store.get(`${shotPrefix(projectId, item.sceneId)}${item.shotId}`);
  const clip = stored === undefined ? null : Shot.parse(stored).clip;
  if (clip?.status !== 'ready' || clip.blobKey === null) return undefined;
  const video = await runtime.blobs.get(clip.blobKey);
  if (video === undefined) return undefined;
  const moving = Math.max(0.04, item.movingSeconds);
  const times = [0.25, 0.5, 0.75].map((share) => sourceTime(item, moving * share));
  const found: readonly (ColorStats | undefined)[] = await sample(video, times).catch(() => []);
  const read: ColorStats[] = [];
  for (const stats of found) if (stats !== undefined) read.push(stats);
  return averageStats(read);
}

export function createLookCommands(options: { colorSampler?: ColorSampler }): readonly Command[] {
  const get = defineCommand({
    id: 'movie.edit.look.get',
    title: 'Film look',
    description:
      'Returns the look of the whole film: one grade (exposure, contrast, temperature, tint, saturation) laid over every shot after its own grade, the preset it began from, and the presets there are.',
    effect: 'read',
    input: z.object({ projectId: ProjectId }),
    output: z.object({
      look: FilmLook,
      presets: z.array(LookPreset),
      /** Whether this host can read the colours of clips, for movie.edit.grade.match. */
      canMatch: z.boolean(),
    }),
    handler: async ({ runtime }, { projectId }) => {
      await requireProject(runtime.store, 'movie.edit.look.get', projectId, MODE_ID);
      return {
        look: await readFilmLook(runtime.store, projectId),
        presets: LookPreset.options,
        canMatch: options.colorSampler !== undefined,
      };
    },
  });

  const set = defineCommand({
    id: 'movie.edit.look.set',
    title: 'Set film look',
    description:
      'Sets the look of the whole film, laid over every shot: a preset (none, warm, cool, bleach-bypass, noir for black and white, golden, night), and or the grade fields to change from it. The look gives the film one feel; grade single shots with movie.edit.item.set to make them agree first. Keep it subtle unless the film asks for a strong style.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      preset: LookPreset.optional().describe('Starts the look from this preset.'),
      exposure: z.number().min(-3).max(3).optional(),
      contrast: z.number().min(-1).max(1).optional(),
      temperature: z.number().min(-1).max(1).optional(),
      tint: z.number().min(-1).max(1).optional(),
      saturation: z.number().min(-1).max(1).optional(),
    }),
    output: z.object({ look: FilmLook }),
    handler: async ({ runtime }, { projectId, preset, ...fields }) => {
      await requireProject(runtime.store, 'movie.edit.look.set', projectId, MODE_ID);
      const before = await readFilmLook(runtime.store, projectId);
      const base = preset === undefined ? before : { ...LOOK_PRESETS[preset], preset };
      const changed = Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined),
      );
      const look = FilmLook.parse({
        ...base,
        ...changed,
        // A preset changed by hand is no longer that preset.
        preset: Object.keys(changed).length > 0 && preset === undefined ? null : base.preset,
      });
      await runtime.store.batch([{ type: 'put', key: filmLookKey(projectId), value: look }]);
      return { look };
    },
  });

  const match = defineCommand({
    id: 'movie.edit.grade.match',
    title: 'Match shot colour',
    description:
      "Grades a shot so that its colour comes near a reference shot's: brightness, contrast, white balance and how colourful it is, read from a few frames of each. The reference keeps its own grade and may be in another scene (toSceneId). The result is a starting point: look at it, and adjust with movie.edit.item.set where the light differs in kind. Match the shots of a scene to its best-looking shot, and the first shots of scenes in one place to each other.",
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      sceneId: SceneId,
      itemId: z.string().describe('The shot to grade, an item id from movie.edit.get.'),
      toItemId: z.string().describe('The reference shot, an item id.'),
      toSceneId: SceneId.optional().describe('The scene of the reference, when it is another.'),
    }),
    output: z.object({ item: z.object({ id: z.string(), grade: Grade }) }),
    handler: async ({ runtime, actor }, input) => {
      const id = 'movie.edit.grade.match';
      const sample = options.colorSampler;
      if (sample === undefined) {
        throw new CommandError(
          'handler_failed',
          id,
          'This host cannot read the colours of clips, so it cannot match them.',
        );
      }
      const { projectId, sceneId } = input;
      const at = { runtime, actor };
      const { cut, items } = await openCut(at, id, projectId, sceneId);
      const laid = await laidOut(runtime.store, projectId, items);
      const piece = (list: readonly LaidItem[], itemId: string, what: string): LaidItem => {
        const found = list.find((candidate) => candidate.itemId === itemId);
        if (found?.kind !== 'shot' || found.durationSeconds <= 0) {
          throw new CommandError(
            'invalid_input',
            id,
            `${what} "${itemId}" is not a shot with a clip in the cut.`,
          );
        }
        return found;
      };
      const target = piece(laid.items, input.itemId, 'The shot');
      let references = laid.items;
      if (input.toSceneId !== undefined && input.toSceneId !== sceneId) {
        await requireScene(runtime.store, id, projectId, input.toSceneId);
        const other: SceneCut = await readCut(runtime.store, projectId, input.toSceneId);
        references = (
          await laidOut(runtime.store, projectId, await itemsOf(runtime.store, projectId, other))
        ).items;
      }
      const reference = piece(references, input.toItemId, 'The reference');
      const [from, to] = await Promise.all([
        pieceStats(runtime, sample, projectId, target),
        pieceStats(runtime, sample, projectId, reference),
      ]);
      if (from === undefined || to === undefined) {
        throw new CommandError('handler_failed', id, 'The frames of the clips could not be read.');
      }
      const grade = matchGrade(from, gradeStats(to, gradeMatrix(reference.grade)));
      const after = items.map((candidate): CutItem =>
        candidate.id === target.itemId ? { ...candidate, grade } : candidate,
      );
      await commitCut(at, projectId, cut, { ...cut, items: after });
      return { item: { id: target.itemId, grade } };
    },
  });

  return [get, set, match];
}
