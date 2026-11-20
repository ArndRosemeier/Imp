import { defineCommand, type Command } from '@imp/core';
import {
  describeVideoModel,
  MODALITIES,
  type GenerationProvider,
  type ModelInfo,
} from '@imp/providers';
import { z } from 'zod';

const MAX_MODELS = 25;

const perMillion = (perToken: number | null): number | null =>
  perToken === null ? null : Number((perToken * 1_000_000).toPrecision(6));

/** What a model costs for comparing: output weighs most in agent work, unknown sorts last. */
function price(model: ModelInfo): number {
  const { promptUsdPerToken, completionUsdPerToken } = model.pricing;
  return promptUsdPerToken === null || completionUsdPerToken === null
    ? Number.POSITIVE_INFINITY
    : promptUsdPerToken + completionUsdPerToken;
}

/**
 * Looking up models is a command, so that choosing one, for an agent or for
 * image generation, is something the coordinator can do during setup.
 */
export function createModelCommands(provider: GenerationProvider): readonly Command[] {
  const list = defineCommand({
    id: 'models.list',
    title: 'List models',
    description:
      'Returns models from the live catalog that produce the given kind of output, with their prices in US dollars per million tokens. Ids starting with "~" always point at the newest model of a family; prefer them. Narrow the list with a search text, or sort by price to find cheap ones. Models that cost nothing are rate limited and often fail; choose one only when the user asks for a free model.',
    effect: 'read',
    input: z.object({
      output: z.enum(MODALITIES).default('text').describe('What the model must produce.'),
      search: z.string().optional().describe('Part of a model id or name, for example "muse".'),
      tools: z
        .boolean()
        .default(false)
        .describe('Only models that can call tools, which an agent needs.'),
      all: z
        .boolean()
        .default(false)
        .describe(
          'For video: also list models that cannot make clips from a description, such as editors and avatar makers. They come with the reason. By default they are left out.',
        ),
      sort: z
        .enum(['family', 'price'])
        .default('family')
        .describe(
          '"family" puts the "~" aliases first. "price" puts the cheapest first; models without a known price come last.',
        ),
    }),
    output: z.object({
      models: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          /** Null when the catalog gives no price per token, as for most image models. */
          inputUsdPerMillion: z.number().nullable(),
          outputUsdPerMillion: z.number().nullable(),
          /** For video models: what each can do, for example its lengths and whether it makes sound. */
          abilities: z.array(z.string()).optional(),
          /** For video models that cannot make clips from a description: why. */
          unsuitable: z.string().optional(),
        }),
      ),
      /** How many matched in all; the list is cut to keep it short. */
      total: z.number(),
    }),
    handler: async (_context, input) => {
      const search = input.search?.trim().toLowerCase() ?? '';
      const matches = (await provider.listModels())
        .filter(
          (model) =>
            model.outputModalities.includes(input.output) &&
            (input.output !== 'video' || input.all || describeVideoModel(model).fits) &&
            (!input.tools || model.supportsTools) &&
            (search === '' ||
              model.id.toLowerCase().includes(search) ||
              model.name.toLowerCase().includes(search)),
        )
        .sort(
          (a, b) =>
            (input.sort === 'price' ? price(a) - price(b) : 0) ||
            Number(b.id.startsWith('~')) - Number(a.id.startsWith('~')) ||
            (a.id < b.id ? -1 : 1),
        );
      return {
        models: matches.slice(0, MAX_MODELS).map((model) => {
          const video = input.output === 'video' ? describeVideoModel(model) : undefined;
          return {
            id: model.id,
            name: model.name,
            inputUsdPerMillion: perMillion(model.pricing.promptUsdPerToken),
            outputUsdPerMillion: perMillion(model.pricing.completionUsdPerToken),
            ...(video === undefined || video.notes.length === 0
              ? {}
              : { abilities: [...video.notes] }),
            ...(video?.problem === null || video?.problem === undefined
              ? {}
              : { unsuitable: video.problem }),
          };
        }),
        total: matches.length,
      };
    },
  });
  return [list];
}
