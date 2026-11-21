import { CommandError, defineCommand, type Command } from '@imp/core';
import { ProviderError, type GenerationProvider, type MediaInput } from '@imp/providers';
import { IMAGE_MODEL_SETTING } from '@imp/world';
import { z } from 'zod';
import { movieDevelopmentKey } from './commands.js';
import { Development, KeyFrame, type Character, type Shot } from './schema.js';
import {
  describeSetting,
  loadShot,
  readCast,
  readSetting,
  settingGuides,
  type ShotSetting,
} from './shots.js';

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

/** At most this many pictures guide a key frame: the place, then the people, then the objects. */
export const MAX_FRAME_REFERENCES = 6;

const At = {
  projectId: z.string().describe('The id of a movie project from project.list.'),
  sceneId: z.string().describe('The id of a scene from movie.scene.list.'),
  shotId: z.string(),
};

const clause = (text: string): string => text.trim().replace(/[.!?]+$/, '');

/**
 * What is sent to the image model for the first frame of a shot. It is a
 * still: the moment the shot opens on, without the words spoken, so that no
 * text ends up in the picture.
 */
export function framePrompt(
  shot: Shot,
  cast: readonly Character[],
  tone: string,
  setting: ShotSetting,
  /** What each reference picture shows, in the order they are sent. */
  guides: readonly string[],
  direction?: string,
): string {
  const { where, things } = describeSetting(setting);
  return [
    'The first frame of a film shot: one still, photographed, as the camera sees it.',
    `${clause(shot.description)}.`,
    where,
    ...cast.map((character) =>
      character.appearance === '' ? '' : `${character.name}: ${clause(character.appearance)}.`,
    ),
    ...things.map((thing) => `${thing}.`),
    shot.performance.trim() === ''
      ? ''
      : `The moment it opens on: ${clause(shot.performance)}. Show the first instant of it.`,
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
): readonly Command[] {
  const generate = defineCommand({
    id: 'movie.shot.frame.generate',
    title: 'Paint key frame',
    description:
      "Paints the first frame of a shot as a still, from its description, the view of its location, its characters, its objects and the film's tone, guided by their key pictures and portraits where the image model takes them (the result names them). The first frame becomes the chosen one; a clip then starts exactly on it, which keeps places and faces the same from shot to shot, and it costs a cent where a clip costs far more, so look at it before making the clip. Costs money at the image model.",
    effect: 'spend',
    input: z.object({
      ...At,
      direction: z
        .string()
        .optional()
        .describe('What should differ from the last one, for example "closer, Mara on the left".'),
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
      const development = await runtime.store.get(movieDevelopmentKey(input.projectId));
      const tone = development === undefined ? '' : Development.parse(development).tone;

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
      ];
      const references: MediaInput[] = [];
      const guides: string[] = [];
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
              ? { ...request, prompt: framePrompt(shot, cast, tone, setting, [], input.direction) }
              : {
                  ...request,
                  prompt: framePrompt(shot, cast, tone, setting, guides, input.direction),
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
            prompt: framePrompt(shot, cast, tone, setting, [], input.direction),
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
        prompt: framePrompt(shot, cast, tone, setting, used, input.direction),
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
          value: {
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
      'Makes one of the key frames of a shot the one its clip starts on, or none (frameId null) to make the clip from words and guides alone.',
    effect: 'write',
    input: z.object({ ...At, frameId: z.string().nullable() }),
    output: z.object({ frameId: z.string().nullable() }),
    handler: async ({ runtime }, input) => {
      const id = 'movie.shot.frame.select';
      const { key, shot } = await loadShot(runtime.store, id, input);
      if (input.frameId !== null && !shot.frames.some((frame) => frame.id === input.frameId)) {
        throw new CommandError('invalid_input', id, `No key frame "${input.frameId}".`);
      }
      await runtime.store.batch([{ type: 'put', key, value: { ...shot, frameId: input.frameId } }]);
      return { frameId: input.frameId };
    },
  });

  const remove = defineCommand({
    id: 'movie.shot.frame.delete',
    title: 'Delete key frame',
    description:
      'Removes one key frame of a shot. If it was the chosen one, the newest remaining frame takes its place.',
    effect: 'destructive',
    input: z.object({ ...At, frameId: z.string() }),
    output: z.object({ frameId: z.string().nullable() }),
    handler: async ({ runtime }, input) => {
      const id = 'movie.shot.frame.delete';
      const { key, shot } = await loadShot(runtime.store, id, input);
      const frame = shot.frames.find((candidate) => candidate.id === input.frameId);
      if (frame === undefined) {
        throw new CommandError('invalid_input', id, `No key frame "${input.frameId}".`);
      }
      const frames = shot.frames.filter((candidate) => candidate.id !== frame.id);
      const frameId = shot.frameId === frame.id ? (frames.at(-1)?.id ?? null) : shot.frameId;
      await runtime.store.batch([{ type: 'put', key, value: { ...shot, frames, frameId } }]);
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
          value: {
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
