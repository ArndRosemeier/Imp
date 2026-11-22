import { CommandError, defineCommand, requireProject, type Command, chosenModel } from '@imp/core';
import { ProviderError, type GenerationProvider } from '@imp/providers';
import { z } from 'zod';
import { characterPrefix } from './commands.js';
import { Character, MODE_ID, VoiceSample } from './schema.js';

/** The setting that names the model voices are spoken with when a call does not say. */
export const SPEECH_MODEL_SETTING = 'speech.model';

const ProjectId = z.string().describe('The id of a movie project from project.list.');

/** The direction given to the speech model: who speaks, then how they sound. */
export function voiceDirection(character: Character, delivery?: string): string {
  return [
    `${character.name}${character.part === '' ? '' : `, ${character.part}`}.`,
    character.voice === '' ? character.description : character.voice,
    // Without this a line is read the same whatever happens in the scene.
    delivery === undefined || delivery.trim() === '' ? '' : `Delivery: ${delivery}`,
  ]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ');
}

/** The commands that record how a character sounds. They need a provider to speak. */
export function createCharacterVoiceCommands(provider: GenerationProvider): readonly Command[] {
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
    id: 'movie.character.voice.generate',
    title: 'Generate voice sample',
    description:
      "Records a line in the voice of a character, directed by the voice written for it, and keeps it as the character's voice sample, replacing an earlier one. Costs money at the speech model.",
    effect: 'spend',
    input: z.object({
      projectId: ProjectId,
      characterId: z.string(),
      line: z
        .string()
        .min(1)
        .max(400)
        .optional()
        .describe('What the character says, a sentence or two. Defaults to an introduction.'),
      delivery: z
        .string()
        .max(400)
        .optional()
        .describe(
          'How the line is said in its moment: emotion, intensity, pace, breath. For example "shouting over a storm, terrified, out of breath". Write the line itself the way it is spoken too; punctuation carries much of the emotion.',
        ),
      model: z
        .string()
        .min(1)
        .optional()
        .describe(
          `A model from models.list with output "speech". Defaults to the setting "${SPEECH_MODEL_SETTING}".`,
        ),
    }),
    output: z.object({ voiceSample: VoiceSample, costUsd: z.number().nullable() }),
    estimate: async ({ runtime }, input) => ({
      kind: 'speech',
      model: await chosenModel(runtime.store, SPEECH_MODEL_SETTING, input.model),
      characters: input.line?.length ?? 40,
    }),
    handler: async ({ runtime }, input) => {
      const id = 'movie.character.voice.generate';
      const { key, character } = await load(runtime.store, id, input.projectId, input.characterId);
      const model = input.model ?? (await runtime.store.get(`settings/${SPEECH_MODEL_SETTING}`));
      if (typeof model !== 'string' || model === '') {
        throw new CommandError(
          'invalid_input',
          id,
          `No speech model is chosen. Set the setting "${SPEECH_MODEL_SETTING}" to an id from models.list with output "speech", or pass a model.`,
        );
      }
      const line = input.line ?? `Hello. My name is ${character.name}.`;
      const direction = voiceDirection(character, input.delivery);

      let spoken;
      try {
        spoken = await provider.generateSpeech({ model, text: line, instructions: direction });
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        throw new CommandError('handler_failed', id, `No voice was recorded: ${error.message}`, {
          cause: error,
        });
      }

      const voiceSample: VoiceSample = {
        // A new key each time, so nothing that still plays the old one is cut off.
        blobKey: `${key}/voice/${runtime.newId()}`,
        mediaType: spoken.audio.mediaType,
        line,
        direction,
        model,
        createdAt: runtime.now().toISOString(),
      };
      await runtime.blobs.put(voiceSample.blobKey, spoken.audio);
      // Read again: speaking takes seconds, and the character may have been edited meanwhile.
      const latest = (await load(runtime.store, id, input.projectId, input.characterId)).character;
      await runtime.store.batch([{ type: 'put', key, value: { ...latest, voiceSample } }]);
      if (latest.voiceSample !== null) await runtime.blobs.delete(latest.voiceSample.blobKey);
      return { voiceSample, costUsd: spoken.costUsd };
    },
  });

  const remove = defineCommand({
    id: 'movie.character.voice.delete',
    title: 'Delete voice sample',
    description: 'Removes the voice sample of a character. The written voice stays.',
    effect: 'destructive',
    input: z.object({ projectId: ProjectId, characterId: z.string() }),
    output: z.object({ characterId: z.string(), deleted: z.boolean() }),
    handler: async ({ runtime }, { projectId, characterId }) => {
      const id = 'movie.character.voice.delete';
      const { key, character } = await load(runtime.store, id, projectId, characterId);
      if (character.voiceSample === null) return { characterId, deleted: false };
      await runtime.store.batch([{ type: 'put', key, value: { ...character, voiceSample: null } }]);
      await runtime.blobs.delete(character.voiceSample.blobKey);
      return { characterId, deleted: true };
    },
  });

  return [generate, remove];
}
