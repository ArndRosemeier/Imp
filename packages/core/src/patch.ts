import { z } from 'zod';

type Patched<T extends z.ZodRawShape> = {
  [K in keyof T]: z.ZodOptional<T[K] extends z.ZodDefault<infer Inner> ? Inner : T[K]>;
};

/**
 * The input of an update: every field optional and without its default, so
 * that a field left out stays as it was. zod's own partial() keeps defaults,
 * which would quietly reset every defaulted field on every update.
 */
export function patchOf<T extends z.ZodRawShape>(schema: z.ZodObject<T>): z.ZodObject<Patched<T>> {
  return z.object(
    Object.fromEntries(
      Object.entries(schema.shape as Record<string, z.ZodType>).map(([name, field]) => {
        const bare: z.ZodType =
          field instanceof z.ZodDefault ? (field.unwrap() as z.ZodType) : field;
        return [name, bare.optional()];
      }),
    ),
  ) as unknown as z.ZodObject<Patched<T>>;
}
