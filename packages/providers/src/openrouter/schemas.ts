import { z } from 'zod';

/** Only the fields Imp reads. Unknown fields are ignored so API additions do not break parsing. */
export const ModelsResponse = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      context_length: z.number().nullish(),
      architecture: z
        .object({
          input_modalities: z.array(z.string()).nullish(),
          output_modalities: z.array(z.string()).nullish(),
        })
        .nullish(),
      pricing: z
        .object({ prompt: z.string().nullish(), completion: z.string().nullish() })
        .nullish(),
      supported_parameters: z.array(z.string()).nullish(),
    }),
  ),
});

export const ChatCompletionResponse = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .nullish(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().nullish(),
      completion_tokens: z.number().nullish(),
      prompt_tokens_details: z.object({ cached_tokens: z.number().nullish() }).nullish(),
      cost: z.number().nullish(),
    })
    .nullish(),
});

export const ImageGenerationResponse = z.object({
  data: z
    .array(
      z.object({
        b64_json: z.string().nullish(),
        media_type: z.string().nullish(),
      }),
    )
    .min(1),
  usage: z.object({ cost: z.number().nullish() }).nullish(),
});

export const ErrorResponse = z.object({
  error: z.object({ message: z.string() }),
});

/** One event of a streamed chat completion that carries audio. */
export const AudioStreamChunk = z.object({
  choices: z
    .array(
      z.object({
        delta: z.object({ audio: z.object({ data: z.string().nullish() }).nullish() }).nullish(),
      }),
    )
    .nullish(),
  usage: z.object({ cost: z.number().nullish() }).nullish(),
});

/** A video job, as returned when it is started and each time it is looked at. */
export const VideoJobResponse = z.object({
  id: z.string().min(1),
  status: z.string(),
  progress: z.number().nullish(),
  error: z.union([z.string(), z.object({ message: z.string() })]).nullish(),
  usage: z.object({ cost: z.number().nullish() }).nullish(),
});
