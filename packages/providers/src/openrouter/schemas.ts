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

export const ErrorResponse = z.object({
  error: z.object({ message: z.string() }),
});
