import {
  chosenModel,
  CommandError,
  defineCommand,
  projectPrefix,
  requireProject,
  type BlobStore,
  type Command,
  type KeyValueStore,
} from '@imp/core';
import { ProviderError, type GenerationProvider, type MediaInput } from '@imp/providers';
import { IMAGE_MODEL_SETTING } from '@imp/world';
import { z } from 'zod';
import { movieDevelopmentKey } from './commands.js';
import { Development, MODE_ID } from './schema.js';

/**
 * The visual style of a film, its look bible: the palette, the light, the
 * camera and the era in words, and a few pictures that show the look. Every
 * picture of the film (portraits, places, key frames) is drawn in it, and the
 * chosen look picture goes along as a reference where the model takes one,
 * which is what keeps hundreds of clips looking like one film.
 */
export const StyleImage = z.object({
  id: z.string(),
  blobKey: z.string(),
  mediaType: z.string(),
  /** What was asked for; empty for an imported picture. */
  prompt: z.string(),
  model: z.string(),
  costUsd: z.number().nullable().default(null),
  createdAt: z.iso.datetime(),
});
export type StyleImage = z.infer<typeof StyleImage>;

const STYLE_FIELDS = {
  palette: z
    .string()
    .describe('The colours of the film, for example "cold blues and sodium orange, no green".'),
  light: z
    .string()
    .describe('How it is lit, for example "low key, hard side light, deep shadows".'),
  camera: z
    .string()
    .describe(
      'The camera and the picture, for example "35mm film grain, anamorphic, shallow focus, handheld".',
    ),
  era: z
    .string()
    .describe(
      'When and where it looks set, for example "1970s Scottish coast, worn and practical".',
    ),
} as const;

export const FilmStyle = z.object({
  palette: STYLE_FIELDS.palette.default(''),
  light: STYLE_FIELDS.light.default(''),
  camera: STYLE_FIELDS.camera.default(''),
  era: STYLE_FIELDS.era.default(''),
  images: z.array(StyleImage).default([]),
  /** The look picture that goes along with every picture made for the film. */
  keyImageId: z.string().nullable().default(null),
});
export type FilmStyle = z.infer<typeof FilmStyle>;

export const styleKey = (projectId: string): string => `${projectPrefix(projectId)}movie/style`;

export async function readFilmStyle(store: KeyValueStore, projectId: string): Promise<FilmStyle> {
  const parsed = FilmStyle.safeParse(await store.get(styleKey(projectId)));
  return parsed.success ? parsed.data : FilmStyle.parse({});
}

/** The style in words, as one clause. Empty when nothing is written. */
export function styleWords(style: Pick<FilmStyle, 'palette' | 'light' | 'camera' | 'era'>): string {
  const clean = (text: string): string => text.trim().replace(/[.;]+$/, '');
  return [
    style.camera,
    style.palette === '' ? '' : `palette: ${clean(style.palette)}`,
    style.light === '' ? '' : `light: ${clean(style.light)}`,
    style.era === '' ? '' : `era: ${clean(style.era)}`,
  ]
    .map(clean)
    .filter((part) => part !== '')
    .join('; ');
}

/**
 * The visual style every picture of a film is drawn in: its look bible in
 * words, and the mood of its tone. A film whose look is not written yet keeps
 * its tone alone, as before there was a look bible.
 */
export async function visualStyleOf(store: KeyValueStore, projectId: string): Promise<string> {
  const stored = await store.get(movieDevelopmentKey(projectId));
  const tone = stored === undefined ? '' : Development.parse(stored).tone.trim();
  const words = styleWords(await readFilmStyle(store, projectId));
  if (words === '') return tone;
  return tone === '' ? words : `${words}. Mood: ${tone.replace(/[.]+$/, '')}`;
}

/** The chosen look picture, to go with a picture made for the film; undefined when there is none. */
export async function styleReference(
  store: KeyValueStore,
  blobs: BlobStore,
  projectId: string,
): Promise<MediaInput | undefined> {
  const style = await readFilmStyle(store, projectId);
  const image = style.images.find((candidate) => candidate.id === style.keyImageId);
  if (image === undefined) return undefined;
  const blob = await blobs.get(image.blobKey);
  return blob === undefined ? undefined : { bytes: blob.bytes, mediaType: blob.mediaType };
}

/** What is sent to the image model for a look picture. */
export function stylePrompt(words: string, tone: string, direction: string | undefined): string {
  return [
    'A still from the film that sets its look: one representative frame, cinematic, no text.',
    words === '' ? '' : `Look: ${words}.`,
    tone === '' ? '' : `Mood: ${tone}.`,
    direction ?? '',
  ]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ');
}

const ProjectId = z.string().describe('The id of a movie project from project.list.');

/** The commands of the look bible. They need a provider to paint look pictures. */
export function createStyleCommands(provider: GenerationProvider): readonly Command[] {
  const load = async (store: KeyValueStore, commandId: string, projectId: string) => {
    await requireProject(store, commandId, projectId, MODE_ID);
    return readFilmStyle(store, projectId);
  };
  const save = async (store: KeyValueStore, projectId: string, style: FilmStyle) => {
    await store.batch([{ type: 'put', key: styleKey(projectId), value: style }]);
  };

  const get = defineCommand({
    id: 'movie.style.get',
    title: 'Show the visual style',
    keywords: ['look bible', 'look', 'palette', 'lighting', 'camera', 'era', 'style guide'],
    description:
      'Returns the visual style of the film (its look bible): palette, light, camera and era in words, the look pictures and which one is chosen, and the style every picture is drawn in (words plus the mood of the tone).',
    effect: 'read',
    input: z.object({ projectId: ProjectId }),
    output: FilmStyle.extend({ drawnIn: z.string() }),
    handler: async ({ runtime }, { projectId }) => ({
      ...(await load(runtime.store, 'movie.style.get', projectId)),
      drawnIn: await visualStyleOf(runtime.store, projectId),
    }),
  });

  const update = defineCommand({
    id: 'movie.style.update',
    title: 'Change the visual style',
    keywords: ['look bible', 'look', 'palette', 'lighting', 'camera', 'era', 'style guide'],
    description:
      'Writes the visual style of the film: palette, light, camera and era, each in a few concrete words. Every picture made from now on is drawn in it. Fields left out stay as they are. Costs nothing.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      palette: STYLE_FIELDS.palette.optional(),
      light: STYLE_FIELDS.light.optional(),
      camera: STYLE_FIELDS.camera.optional(),
      era: STYLE_FIELDS.era.optional(),
    }),
    output: FilmStyle,
    handler: async ({ runtime }, { projectId, ...fields }) => {
      const current = await load(runtime.store, 'movie.style.update', projectId);
      const next = FilmStyle.parse({
        ...current,
        ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
      });
      await save(runtime.store, projectId, next);
      return next;
    },
  });

  const generate = defineCommand({
    id: 'movie.style.image.generate',
    title: 'Paint a look picture',
    keywords: ['look frame', 'mood board', 'reference picture', 'style frame'],
    description:
      'Paints a still that shows the look of the film from its visual style and tone: no particular scene, a representative frame. The first one becomes the chosen look picture, which goes with every portrait, place picture and key frame as a reference where the model takes one. Make the style words right first. Costs money at the image model.',
    effect: 'spend',
    input: z.object({
      projectId: ProjectId,
      direction: z
        .string()
        .optional()
        .describe('What this one should show or do differently, for example "a night exterior".'),
      model: z.string().min(1).optional(),
      aspectRatio: z
        .string()
        .regex(/^\d+:\d+$/)
        .default('16:9'),
    }),
    output: z.object({ image: StyleImage, costUsd: z.number().nullable() }),
    estimate: async ({ runtime }, input) => ({
      kind: 'image',
      model: await chosenModel(runtime.store, IMAGE_MODEL_SETTING, input.model),
    }),
    handler: async ({ runtime }, input) => {
      const id = 'movie.style.image.generate';
      await load(runtime.store, id, input.projectId);
      const model = input.model ?? (await runtime.store.get(`settings/${IMAGE_MODEL_SETTING}`));
      if (typeof model !== 'string' || model === '') {
        throw new CommandError(
          'invalid_input',
          id,
          `No image model is chosen. Set the setting "${IMAGE_MODEL_SETTING}" to an id from models.list with output "image", or pass a model.`,
        );
      }
      const before = await readFilmStyle(runtime.store, input.projectId);
      const words = styleWords(before);
      const stored = await runtime.store.get(movieDevelopmentKey(input.projectId));
      const tone = stored === undefined ? '' : Development.parse(stored).tone.trim();
      if (words === '' && tone === '') {
        throw new CommandError(
          'invalid_input',
          id,
          'The film has no visual style or tone in words yet. Write it first with movie.style.update.',
        );
      }
      const prompt = stylePrompt(words, tone, input.direction);
      let generated;
      try {
        generated = await provider.generateImage({ model, prompt, aspectRatio: input.aspectRatio });
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        throw new CommandError('handler_failed', id, `No picture was made: ${error.message}`, {
          cause: error,
        });
      }
      const [first] = generated.images;
      if (first === undefined) {
        throw new CommandError('handler_failed', id, 'The model returned no picture.');
      }
      const imageId = runtime.newId();
      const image: StyleImage = {
        id: imageId,
        blobKey: `${styleKey(input.projectId)}/images/${imageId}`,
        mediaType: first.mediaType,
        prompt,
        model,
        costUsd: generated.costUsd,
        createdAt: runtime.now().toISOString(),
      };
      await runtime.blobs.put(image.blobKey, { bytes: first.bytes, mediaType: first.mediaType });
      // Read again: painting takes seconds, and the style may have changed meanwhile.
      const latest = await readFilmStyle(runtime.store, input.projectId);
      await save(runtime.store, input.projectId, {
        ...latest,
        images: [...latest.images, image],
        keyImageId: latest.keyImageId ?? imageId,
      });
      return { image, costUsd: generated.costUsd };
    },
  });

  const fromFile = defineCommand({
    id: 'movie.style.image.fromFile',
    title: 'Use a picture for the look',
    keywords: ['reference picture', 'mood board', 'import look'],
    description:
      'Adds a stored picture to the look pictures of the film, for example a still or a painting imported into the library. With chosen true it becomes the look picture that goes with every picture made for the film. Costs nothing.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      blobKey: z.string().min(1).describe('The stored picture, such as a library asset.'),
      chosen: z.boolean().default(true),
    }),
    output: z.object({ image: StyleImage, keyImageId: z.string().nullable() }),
    handler: async ({ runtime }, input) => {
      const id = 'movie.style.image.fromFile';
      await load(runtime.store, id, input.projectId);
      const blob = await runtime.blobs.get(input.blobKey);
      if (blob === undefined) {
        throw new CommandError('invalid_input', id, `Nothing is stored under "${input.blobKey}".`);
      }
      if (!blob.mediaType.startsWith('image/')) {
        throw new CommandError('invalid_input', id, 'That file is not a picture.');
      }
      const imageId = runtime.newId();
      const image: StyleImage = {
        id: imageId,
        blobKey: `${styleKey(input.projectId)}/images/${imageId}`,
        mediaType: blob.mediaType,
        prompt: '',
        model: 'file',
        costUsd: null,
        createdAt: runtime.now().toISOString(),
      };
      await runtime.blobs.put(image.blobKey, blob);
      const latest = await readFilmStyle(runtime.store, input.projectId);
      const keyImageId = input.chosen ? imageId : (latest.keyImageId ?? imageId);
      await save(runtime.store, input.projectId, {
        ...latest,
        images: [...latest.images, image],
        keyImageId,
      });
      return { image, keyImageId };
    },
  });

  const select = defineCommand({
    id: 'movie.style.image.select',
    title: 'Choose the look picture',
    description:
      'Makes one of the look pictures the one that goes with every picture made for the film; null for none.',
    effect: 'write',
    input: z.object({ projectId: ProjectId, imageId: z.string().nullable() }),
    output: z.object({ keyImageId: z.string().nullable() }),
    handler: async ({ runtime }, { projectId, imageId }) => {
      const id = 'movie.style.image.select';
      const style = await load(runtime.store, id, projectId);
      if (imageId !== null && !style.images.some((image) => image.id === imageId)) {
        throw new CommandError('invalid_input', id, `No look picture "${imageId}".`);
      }
      await save(runtime.store, projectId, { ...style, keyImageId: imageId });
      return { keyImageId: imageId };
    },
  });

  const remove = defineCommand({
    id: 'movie.style.image.delete',
    title: 'Delete a look picture',
    description:
      'Removes a look picture. If it was the chosen one, the newest remaining picture takes its place.',
    effect: 'destructive',
    input: z.object({ projectId: ProjectId, imageId: z.string() }),
    output: z.object({ keyImageId: z.string().nullable() }),
    handler: async ({ runtime }, { projectId, imageId }) => {
      const id = 'movie.style.image.delete';
      const style = await load(runtime.store, id, projectId);
      const image = style.images.find((candidate) => candidate.id === imageId);
      if (image === undefined) {
        throw new CommandError('invalid_input', id, `No look picture "${imageId}".`);
      }
      const images = style.images.filter((candidate) => candidate.id !== imageId);
      const keyImageId =
        style.keyImageId === imageId ? (images.at(-1)?.id ?? null) : style.keyImageId;
      await save(runtime.store, projectId, { ...style, images, keyImageId });
      await runtime.blobs.delete(image.blobKey);
      return { keyImageId };
    },
  });

  return [get, update, generate, fromFile, select, remove];
}
