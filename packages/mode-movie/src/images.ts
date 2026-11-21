import { CommandError, defineCommand, requireProject, type Command } from '@imp/core';
import { ProviderError, type GenerationProvider } from '@imp/providers';
import { z } from 'zod';
import { characterPrefix, movieDevelopmentKey } from './commands.js';
import { Character, CharacterImage, Development, MODE_ID } from './schema.js';

import { IMAGE_MODEL_SETTING } from '@imp/world';

/** The setting that names the model images are made with; the world draws with the same one. */
export { IMAGE_MODEL_SETTING };

const ProjectId = z.string().describe('The id of a movie project from project.list.');

/** What is sent to the image model when the caller gives no prompt of their own. */
export function portraitPrompt(
  character: Character,
  tone: string,
  direction: string | undefined,
): string {
  return [
    `Character portrait of ${character.name}${character.part === '' ? '' : `, ${character.part}`}.`,
    character.appearance === '' ? character.description : character.appearance,
    tone === '' ? '' : `Visual style: ${tone}`,
    direction ?? '',
  ]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ');
}

/** The commands that make and manage pictures of characters. They need a provider to generate. */
export function createCharacterImageCommands(provider: GenerationProvider): readonly Command[] {
  async function load(
    store: Parameters<typeof requireProject>[0],
    commandId: string,
    projectId: string,
    characterId: string,
  ) {
    await requireProject(store, commandId, projectId, MODE_ID);
    const key = `${characterPrefix(projectId)}${characterId}`;
    const stored = await store.get(key);
    if (stored === undefined) {
      throw new CommandError('invalid_input', commandId, `No character "${characterId}".`);
    }
    return { key, character: Character.parse(stored) };
  }

  const generate = defineCommand({
    id: 'movie.character.image.generate',
    title: 'Generate character image',
    description:
      'Makes a picture of a character from its appearance and the tone of the film, and adds it to the character. The first image becomes the portrait. Costs money at the image model.',
    effect: 'spend',
    input: z.object({
      projectId: ProjectId,
      characterId: z.string(),
      direction: z
        .string()
        .optional()
        .describe(
          'What should differ in this image, for example "in profile, at night, in the rain".',
        ),
      prompt: z
        .string()
        .min(1)
        .optional()
        .describe('The whole prompt, replacing the one built from the character. Rarely needed.'),
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
        .default('3:4'),
    }),
    output: z.object({ image: CharacterImage, costUsd: z.number().nullable() }),
    handler: async ({ runtime }, input) => {
      const id = 'movie.character.image.generate';
      const { key, character } = await load(runtime.store, id, input.projectId, input.characterId);
      const model = input.model ?? (await runtime.store.get(`settings/${IMAGE_MODEL_SETTING}`));
      if (typeof model !== 'string' || model === '') {
        throw new CommandError(
          'invalid_input',
          id,
          `No image model is chosen. Set the setting "${IMAGE_MODEL_SETTING}" to an id from models.list with output "image", or pass a model.`,
        );
      }
      const development = await runtime.store.get(movieDevelopmentKey(input.projectId));
      const tone = development === undefined ? '' : Development.parse(development).tone;
      const prompt = input.prompt ?? portraitPrompt(character, tone, input.direction);

      let generated;
      try {
        generated = await provider.generateImage({
          model,
          prompt,
          aspectRatio: input.aspectRatio,
        });
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        throw new CommandError('handler_failed', id, `No image was made: ${error.message}`, {
          cause: error,
        });
      }
      const [first] = generated.images;
      if (first === undefined) {
        throw new CommandError('handler_failed', id, 'The model returned no image.');
      }

      const image: CharacterImage = {
        id: runtime.newId(),
        blobKey: '',
        mediaType: first.mediaType,
        prompt,
        model,
        createdAt: runtime.now().toISOString(),
      };
      const stored = { ...image, blobKey: `${key}/images/${image.id}` };
      await runtime.blobs.put(stored.blobKey, { bytes: first.bytes, mediaType: first.mediaType });
      // Read again: generating takes seconds, and the character may have been edited meanwhile.
      const latest = (await load(runtime.store, id, input.projectId, input.characterId)).character;
      await runtime.store.batch([
        {
          type: 'put',
          key,
          value: {
            ...latest,
            images: [...latest.images, stored],
            portraitId: latest.portraitId ?? stored.id,
          },
        },
      ]);
      return { image: stored, costUsd: generated.costUsd };
    },
  });

  const select = defineCommand({
    id: 'movie.character.image.select',
    title: 'Choose portrait',
    description: 'Makes one of the images of a character its portrait.',
    effect: 'write',
    input: z.object({ projectId: ProjectId, characterId: z.string(), imageId: z.string() }),
    output: z.object({ characterId: z.string(), portraitId: z.string() }),
    handler: async ({ runtime }, { projectId, characterId, imageId }) => {
      const id = 'movie.character.image.select';
      const { key, character } = await load(runtime.store, id, projectId, characterId);
      if (!character.images.some((image) => image.id === imageId)) {
        throw new CommandError('invalid_input', id, `No image "${imageId}".`);
      }
      await runtime.store.batch([
        { type: 'put', key, value: { ...character, portraitId: imageId } },
      ]);
      return { characterId, portraitId: imageId };
    },
  });

  const remove = defineCommand({
    id: 'movie.character.image.delete',
    title: 'Delete character image',
    description:
      'Removes one image of a character. If it was the portrait, the newest remaining image takes its place.',
    effect: 'destructive',
    input: z.object({ projectId: ProjectId, characterId: z.string(), imageId: z.string() }),
    output: z.object({ characterId: z.string(), portraitId: z.string().nullable() }),
    handler: async ({ runtime }, { projectId, characterId, imageId }) => {
      const id = 'movie.character.image.delete';
      const { key, character } = await load(runtime.store, id, projectId, characterId);
      const image = character.images.find((candidate) => candidate.id === imageId);
      if (image === undefined) {
        throw new CommandError('invalid_input', id, `No image "${imageId}".`);
      }
      const images = character.images.filter((candidate) => candidate.id !== imageId);
      const portraitId =
        character.portraitId === imageId ? (images.at(-1)?.id ?? null) : character.portraitId;
      await runtime.store.batch([
        { type: 'put', key, value: { ...character, images, portraitId } },
      ]);
      await runtime.blobs.delete(image.blobKey);
      return { characterId, portraitId };
    },
  });

  const fromFile = defineCommand({
    id: 'movie.character.image.fromFile',
    title: 'Use a picture of a character',
    description:
      'Adds a stored picture to the images of a character, for example a photo or drawing imported into the library, or a picture from another project. With portrait true it becomes the portrait that guides every clip and frame of the character. Costs nothing.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      characterId: z.string(),
      blobKey: z
        .string()
        .min(1)
        .describe('The stored picture, for example the blobKey of a library asset.'),
      portrait: z.boolean().default(true),
    }),
    output: z.object({ image: CharacterImage, portraitId: z.string().nullable() }),
    handler: async ({ runtime }, input) => {
      const id = 'movie.character.image.fromFile';
      const { key } = await load(runtime.store, id, input.projectId, input.characterId);
      const blob = await runtime.blobs.get(input.blobKey);
      if (blob === undefined) {
        throw new CommandError('invalid_input', id, `Nothing is stored under "${input.blobKey}".`);
      }
      if (!blob.mediaType.startsWith('image/')) {
        throw new CommandError('invalid_input', id, 'That file is not a picture.');
      }
      const imageId = runtime.newId();
      const image: CharacterImage = {
        id: imageId,
        blobKey: `${key}/images/${imageId}`,
        mediaType: blob.mediaType,
        prompt: '',
        model: 'file',
        createdAt: runtime.now().toISOString(),
      };
      await runtime.blobs.put(image.blobKey, blob);
      const latest = (await load(runtime.store, id, input.projectId, input.characterId)).character;
      const portraitId = input.portrait ? imageId : (latest.portraitId ?? imageId);
      await runtime.store.batch([
        { type: 'put', key, value: { ...latest, images: [...latest.images, image], portraitId } },
      ]);
      return { image, portraitId };
    },
  });

  return [generate, select, remove, fromFile];
}
