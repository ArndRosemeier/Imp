import {
  CommandError,
  defineCommand,
  type Command,
  type CoreRuntime,
  chosenModel,
} from '@imp/core';
import { ProviderError, type GenerationProvider, type MediaInput } from '@imp/providers';
import { IMAGE_MODEL_SETTING } from '@imp/world';
import { z } from 'zod';
import { KeyFrame, type Character, type Shot } from './schema.js';
import { readFilmStyle, visualStyleOf } from './style.js';
import {
  describeSetting,
  loadShot,
  readCast,
  readSetting,
  readShots,
  settingGuides,
  type ShotSetting,
} from './shots.js';
import type { FrameGrabber } from './edit-review.js';
import { chosenEndFrame, lastFrameOf, shotBefore } from './joins.js';

/**
 * Turns a picture into JPEG or PNG, or undefined when it cannot. Video models
 * take only those as a start frame; image models often answer in WebP.
 */
export type FrameImageEncoder = (image: MediaInput) => Promise<MediaInput | undefined>;

const FRAME_TYPES = new Set(['image/jpeg', 'image/png']);

/** The picture as a video model takes it for a start frame, or undefined when it cannot be. */
export async function asStartFrame(
  image: MediaInput,
  encode: FrameImageEncoder | undefined,
): Promise<MediaInput | undefined> {
  if (FRAME_TYPES.has(image.mediaType)) return image;
  try {
    const encoded = await encode?.(image);
    return encoded !== undefined && FRAME_TYPES.has(encoded.mediaType) ? encoded : undefined;
  } catch {
    // A picture the host cannot decode stays a guide; the clip is still made.
    return undefined;
  }
}

/** A painted frame as a picture, or undefined when there is none. */
async function pictureOf(
  runtime: CoreRuntime,
  frame: KeyFrame | undefined,
): Promise<MediaInput | undefined> {
  return frame === undefined ? undefined : runtime.blobs.get(frame.blobKey);
}

/** At most this many pictures guide a key frame: the place, then the people, then the objects. */
export const MAX_FRAME_REFERENCES = 6;

const At = {
  projectId: z.string().describe('The id of a movie project from project.list.'),
  sceneId: z.string().describe('The id of a scene from movie.scene.list.'),
  shotId: z.string(),
};

const clause = (text: string): string => text.trim().replace(/[.!?]+$/, '');

/** Which frame of a shot is painted, and what it must agree with. */
export interface FrameKind {
  /** The first frame, which the clip starts on, or the last, which it lands on. */
  readonly end: boolean;
  /** A first frame of a cut on action: the same instant as the last frame of the shot before. */
  readonly matchBefore?: boolean;
  /** A last frame painted to follow on from the first frame of the same shot. */
  readonly followsStart?: boolean;
}

/**
 * What is sent to the image model for the first or last frame of a shot. It
 * is a still: the moment the shot opens or ends on, without the words spoken,
 * so that no text ends up in the picture.
 */
export function framePrompt(
  shot: Shot,
  cast: readonly Character[],
  tone: string,
  setting: ShotSetting,
  /** What each reference picture shows, in the order they are sent. */
  guides: readonly string[],
  direction?: string,
  kind: FrameKind = { end: false },
): string {
  const { where, things } = describeSetting(setting);
  const moment =
    shot.performance.trim() === ''
      ? ''
      : kind.end
        ? `The moment it ends on: ${clause(shot.performance)}. Show the last instant, once the action is done.`
        : `The moment it opens on: ${clause(shot.performance)}. Show the first instant of it.`;
  return [
    kind.end
      ? 'The last frame of a film shot: one still, photographed, as the camera sees it.'
      : 'The first frame of a film shot: one still, photographed, as the camera sees it.',
    `${clause(shot.description)}.`,
    where,
    ...cast.map((character) =>
      character.appearance === '' ? '' : `${character.name}: ${clause(character.appearance)}.`,
    ),
    ...things.map((thing) => `${thing}.`),
    moment,
    kind.matchBefore === true
      ? "This shot cuts on action from the shot before: show the very instant its last frame shows, the bodies in the same pose and mid-movement, the same light, seen from this shot's camera."
      : '',
    kind.followsStart === true
      ? 'It is the same shot as its first frame: keep the camera, the lens and the light unless the description says the camera moves; only what happens in the shot has changed.'
      : '',
    guides.length === 0
      ? ''
      : `The reference images show, in order: ${guides.join('; ')}. Keep the place, the faces, the clothing and the objects exactly as they look there; frame them as described here.`,
    tone === '' ? '' : `Visual style: ${clause(tone)}.`,
    direction === undefined || direction.trim() === '' ? '' : `${clause(direction)}.`,
    'No text, captions or watermarks.',
  ]
    .filter((part) => part !== '')
    .join('\n');
}

/** The commands that paint, choose and remove the key frames of shots. */
export function createFrameCommands(
  provider: GenerationProvider,
  frameImage?: FrameImageEncoder,
  frameGrabber?: FrameGrabber,
): readonly Command[] {
  const generate = defineCommand({
    id: 'movie.shot.frame.generate',
    title: 'Paint key frame',
    description:
      'Paints the first frame of a shot as a still, from its description, the view of its location, its characters, its objects and the film\'s tone, guided by their key pictures and portraits where the image model takes them (the result names them). The first frame becomes the chosen one; a clip then starts exactly on it, which keeps places and faces the same from shot to shot, and it costs a cent where a clip costs far more, so look at it before making the clip. A shot that cuts on action (join "action") is painted to match the last frame of the shot before, its end frame or the end of its clip, so one of those must exist. A shot that continues the one before starts on that clip and needs no first frame. With end true it paints the last frame instead, the moment the shot lands on, drawn to agree with its first frame: the clip then ends on it where the model takes an end picture. Paint one where it matters where a shot ends, such as before a cut on action. Costs money at the image model.',
    effect: 'spend',
    input: z.object({
      ...At,
      direction: z
        .string()
        .optional()
        .describe('What should differ from the last one, for example "closer, Mara on the left".'),
      end: z
        .boolean()
        .default(false)
        .describe('Paint the last frame, which the clip lands on, instead of the first.'),
      model: z
        .string()
        .min(1)
        .optional()
        .describe(
          `An image model id from models.list. Defaults to the setting "${IMAGE_MODEL_SETTING}".`,
        ),
      aspectRatio: z
        .string()
        .regex(/^\d+:\d+$/)
        .default('16:9')
        .describe('Match the clip it will start: 16:9 unless the clip is made otherwise.'),
    }),
    output: z.object({ frame: KeyFrame }),
    estimate: async ({ runtime }, input) => ({
      kind: 'image',
      model: await chosenModel(runtime.store, IMAGE_MODEL_SETTING, input.model),
    }),
    handler: async ({ runtime }, input) => {
      const id = 'movie.shot.frame.generate';
      const { key, shot } = await loadShot(runtime.store, id, input);
      if (shot.description.trim() === '') {
        throw new CommandError('invalid_input', id, 'Describe what the shot shows first.');
      }
      const model = input.model ?? (await runtime.store.get(`settings/${IMAGE_MODEL_SETTING}`));
      if (typeof model !== 'string' || model === '') {
        throw new CommandError(
          'invalid_input',
          id,
          `No image model is chosen. Set the setting "${IMAGE_MODEL_SETTING}" to an id from models.list with output "image", or pass a model.`,
        );
      }
      const cast = (await readCast(runtime.store, input.projectId, shot)).filter(
        (character) => !character.voiceOnly,
      );
      const setting = await readSetting(runtime.store, input.projectId, shot);
      // The film's look in words, and its chosen look picture as the last reference.
      const tone = await visualStyleOf(runtime.store, input.projectId);
      const filmStyle = await readFilmStyle(runtime.store, input.projectId);
      const lookImage = filmStyle.images.find((image) => image.id === filmStyle.keyImageId);

      // The place first: it sets the composition. Then the people, then the objects.
      const world = settingGuides(setting);
      const place = world.find((guide) => guide.kind === 'location');
      const objects = world.filter((guide) => guide.kind === 'object');
      const portraits = cast.flatMap((character) => {
        const portrait = character.images.find((image) => image.id === character.portraitId);
        return portrait === undefined ? [] : [{ blobKey: portrait.blobKey, name: character.name }];
      });
      const candidates = [
        ...(place === undefined
          ? []
          : [{ blobKey: place.image.blobKey, name: `${place.name} (the place)` }]),
        ...portraits,
        ...objects.map((guide) => ({ blobKey: guide.image.blobKey, name: guide.name })),
        ...(lookImage === undefined
          ? []
          : [
              {
                blobKey: lookImage.blobKey,
                name: 'the look of the film (take only its colours, light and texture)',
              },
            ]),
      ];
      // What the frame must agree with goes first: the start of this shot for its end,
      // the end of the shot before for a cut on action.
      const before = shotBefore(
        await readShots(runtime.store, input.projectId, input.sceneId),
        shot,
      );
      const leads: { picture: MediaInput; name: string }[] = [];
      let kind: FrameKind = { end: input.end };
      if (input.end) {
        const start =
          shot.join === 'continues'
            ? await lastFrameOf(runtime, frameGrabber, before?.clip ?? null)
            : await pictureOf(
                runtime,
                shot.frames.find((frame) => frame.id === shot.frameId),
              );
        if (start !== undefined) {
          leads.push({ picture: start, name: 'the first frame of this shot' });
          kind = { end: true, followsStart: true };
        }
      } else if (shot.join === 'continues') {
        throw new CommandError(
          'invalid_input',
          id,
          `Shot ${String(shot.position)} continues the shot before, so its clip starts on the last frame of that clip and needs no first frame. Paint its end frame (end: true) to say where it lands, or change its join.`,
        );
      } else if (shot.join === 'action') {
        const ending =
          before === undefined
            ? undefined
            : ((await pictureOf(runtime, chosenEndFrame(before))) ??
              (await lastFrameOf(runtime, frameGrabber, before.clip)));
        if (ending === undefined) {
          throw new CommandError(
            'invalid_input',
            id,
            before === undefined
              ? `Shot ${String(shot.position)} is the first of its scene, so it cannot cut on action. Set its join to "cut".`
              : `Shot ${String(shot.position)} cuts on action from shot ${String(before.position)}, so its first frame matches where that shot ends. Paint the end frame of shot ${String(before.position)} or make its clip first.`,
          );
        }
        leads.push({ picture: ending, name: 'the last frame of the shot before' });
        kind = { end: false, matchBefore: true };
      }
      const references: MediaInput[] = leads.map((lead) => lead.picture);
      const guides: string[] = leads.map((lead) => lead.name);
      for (const candidate of candidates) {
        if (references.length >= MAX_FRAME_REFERENCES) break;
        const blob = await runtime.blobs.get(candidate.blobKey);
        if (blob === undefined) continue;
        references.push(blob);
        guides.push(candidate.name);
      }

      let used = guides;
      let generated;
      try {
        const request = { model, aspectRatio: input.aspectRatio };
        try {
          generated = await provider.generateImage(
            references.length === 0
              ? {
                  ...request,
                  prompt: framePrompt(shot, cast, tone, setting, [], input.direction, kind),
                }
              : {
                  ...request,
                  prompt: framePrompt(shot, cast, tone, setting, guides, input.direction, kind),
                  references,
                },
          );
        } catch (error) {
          if (
            !(error instanceof ProviderError) ||
            error.kind !== 'bad_request' ||
            references.length === 0
          ) {
            throw error;
          }
          used = [];
          generated = await provider.generateImage({
            ...request,
            prompt: framePrompt(shot, cast, tone, setting, [], input.direction, kind),
          });
        }
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        throw new CommandError('handler_failed', id, `No frame was painted: ${error.message}`, {
          cause: error,
        });
      }
      const [first] = generated.images;
      if (first === undefined) {
        throw new CommandError('handler_failed', id, 'The model returned no picture.');
      }
      // Kept as a video model takes it, so the clip can start on it later wherever it is made.
      const stored = (await asStartFrame(first, frameImage)) ?? first;
      const frameId = runtime.newId();
      const frame: KeyFrame = {
        id: frameId,
        blobKey: `${key}/frames/${frameId}`,
        mediaType: stored.mediaType,
        prompt: framePrompt(shot, cast, tone, setting, used, input.direction, kind),
        model,
        guides: used,
        costUsd: generated.costUsd,
        createdAt: runtime.now().toISOString(),
      };
      await runtime.blobs.put(frame.blobKey, { bytes: stored.bytes, mediaType: stored.mediaType });
      // Read again: painting takes seconds, and the shot may have changed meanwhile.
      const latest = (await loadShot(runtime.store, id, input)).shot;
      await runtime.store.batch([
        {
          type: 'put',
          key,
          value: input.end
            ? {
                ...latest,
                endFrames: [...latest.endFrames, frame],
                endFrameId: latest.endFrameId ?? frameId,
              }
            : {
                ...latest,
                frames: [...latest.frames, frame],
                frameId: latest.frameId ?? frameId,
              },
        },
      ]);
      return { frame };
    },
  });

  const select = defineCommand({
    id: 'movie.shot.frame.select',
    title: 'Choose key frame',
    description:
      'Makes one of the key frames of a shot the one its clip starts on, or none (frameId null) to make the clip from words and guides alone. With end true, the end frame it lands on, or none to leave its end to the model.',
    effect: 'write',
    input: z.object({
      ...At,
      frameId: z.string().nullable(),
      end: z
        .boolean()
        .default(false)
        .describe('The end frames, which the clip lands on, instead of the first frames.'),
    }),
    output: z.object({ frameId: z.string().nullable() }),
    handler: async ({ runtime }, input) => {
      const id = 'movie.shot.frame.select';
      const { key, shot } = await loadShot(runtime.store, id, input);
      const frames = input.end ? shot.endFrames : shot.frames;
      if (input.frameId !== null && !frames.some((frame) => frame.id === input.frameId)) {
        throw new CommandError(
          'invalid_input',
          id,
          `No ${input.end ? 'end' : 'key'} frame "${input.frameId}".`,
        );
      }
      const value = input.end
        ? { ...shot, endFrameId: input.frameId }
        : { ...shot, frameId: input.frameId };
      await runtime.store.batch([{ type: 'put', key, value }]);
      return { frameId: input.frameId };
    },
  });

  const remove = defineCommand({
    id: 'movie.shot.frame.delete',
    title: 'Delete key frame',
    description:
      'Removes one key frame of a shot, or with end true one of its end frames. If it was the chosen one, the newest remaining frame takes its place.',
    effect: 'destructive',
    input: z.object({
      ...At,
      frameId: z.string(),
      end: z
        .boolean()
        .default(false)
        .describe('The end frames, which the clip lands on, instead of the first frames.'),
    }),
    output: z.object({ frameId: z.string().nullable() }),
    handler: async ({ runtime }, input) => {
      const id = 'movie.shot.frame.delete';
      const { key, shot } = await loadShot(runtime.store, id, input);
      const all = input.end ? shot.endFrames : shot.frames;
      const chosen = input.end ? shot.endFrameId : shot.frameId;
      const frame = all.find((candidate) => candidate.id === input.frameId);
      if (frame === undefined) {
        throw new CommandError(
          'invalid_input',
          id,
          `No ${input.end ? 'end' : 'key'} frame "${input.frameId}".`,
        );
      }
      const frames = all.filter((candidate) => candidate.id !== frame.id);
      const frameId = chosen === frame.id ? (frames.at(-1)?.id ?? null) : chosen;
      const value = input.end
        ? { ...shot, endFrames: frames, endFrameId: frameId }
        : { ...shot, frames, frameId };
      await runtime.store.batch([{ type: 'put', key, value }]);
      await runtime.blobs.delete(frame.blobKey);
      return { frameId };
    },
  });

  const fromFile = defineCommand({
    id: 'movie.shot.frame.fromFile',
    title: 'Use a picture as key frame',
    description:
      "Makes a stored picture a key frame of a shot, so its clip can start on it: an imported picture from the library, a portrait, a view of a place, another shot's frame. With choose true (the default) it becomes the frame the clip starts on. Costs nothing.",
    effect: 'write',
    input: z.object({
      ...At,
      blobKey: z
        .string()
        .min(1)
        .describe('The stored picture, for example the blobKey of a library asset.'),
      choose: z.boolean().default(true),
      end: z
        .boolean()
        .default(false)
        .describe('Make it an end frame, which the clip lands on, instead of a first frame.'),
    }),
    output: z.object({ frame: KeyFrame }),
    handler: async ({ runtime }, input) => {
      const id = 'movie.shot.frame.fromFile';
      const { key } = await loadShot(runtime.store, id, input);
      const blob = await runtime.blobs.get(input.blobKey);
      if (blob === undefined) {
        throw new CommandError('invalid_input', id, `Nothing is stored under "${input.blobKey}".`);
      }
      if (!blob.mediaType.startsWith('image/')) {
        throw new CommandError('invalid_input', id, 'That file is not a picture.');
      }
      const stored = (await asStartFrame(blob, frameImage)) ?? blob;
      const frameId = runtime.newId();
      const frame: KeyFrame = {
        id: frameId,
        blobKey: `${key}/frames/${frameId}`,
        mediaType: stored.mediaType,
        prompt: '',
        model: 'file',
        guides: [],
        costUsd: null,
        createdAt: runtime.now().toISOString(),
      };
      await runtime.blobs.put(frame.blobKey, { bytes: stored.bytes, mediaType: stored.mediaType });
      const latest = (await loadShot(runtime.store, id, input)).shot;
      await runtime.store.batch([
        {
          type: 'put',
          key,
          value: input.end
            ? {
                ...latest,
                endFrames: [...latest.endFrames, frame],
                endFrameId: input.choose ? frameId : (latest.endFrameId ?? frameId),
              }
            : {
                ...latest,
                frames: [...latest.frames, frame],
                frameId: input.choose ? frameId : (latest.frameId ?? frameId),
              },
        },
      ]);
      return { frame };
    },
  });

  return [generate, select, remove, fromFile];
}
