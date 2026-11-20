import type { JsonValue } from '../json.js';
import type { CoreRuntime } from '../runtime.js';
import type { WriteOperation } from '../storage/kv.js';

/**
 * Builds a function that moves values from one place to another: every
 * string that starts with `fromPrefix` (a store or blob key) is moved under
 * `toPrefix`, and every id in `ids` is replaced, whole strings as well as
 * single path segments of moved keys. Ids are unique random strings, so a
 * whole-string match is never an accident.
 */
export function createRewriter(options: {
  readonly fromPrefix: string;
  readonly toPrefix: string;
  readonly ids?: ReadonlyMap<string, string>;
}): { key: (key: string) => string; value: (value: JsonValue) => JsonValue } {
  const ids = options.ids ?? new Map<string, string>();
  const string = (text: string): string => {
    const id = ids.get(text);
    if (id !== undefined) return id;
    if (!text.startsWith(options.fromPrefix)) return text;
    const rest = text.slice(options.fromPrefix.length);
    return (
      options.toPrefix +
      (ids.size === 0
        ? rest
        : rest
            .split('/')
            .map((segment) => ids.get(segment) ?? segment)
            .join('/'))
    );
  };
  const value = (input: JsonValue): JsonValue => {
    if (typeof input === 'string') return string(input);
    if (Array.isArray(input)) return input.map(value);
    if (typeof input === 'object' && input !== null) {
      return Object.fromEntries(
        Object.entries(input as Record<string, JsonValue>).map(([k, v]) => [k, value(v)]),
      );
    }
    return input;
  };
  return { key: string, value };
}

/**
 * Copies every record and file under `fromPrefix` to `toPrefix`, moving keys
 * inside the records along. Records are written in one batch, after the files,
 * so the copy shows up whole or not at all.
 */
export async function copyTree(
  runtime: CoreRuntime,
  fromPrefix: string,
  toPrefix: string,
): Promise<{ entries: number; files: number }> {
  const rewrite = createRewriter({ fromPrefix, toPrefix });
  const entries = await runtime.store.list(fromPrefix);
  const files = await runtime.blobs.list(fromPrefix);
  for (const key of files) {
    const blob = await runtime.blobs.get(key);
    if (blob !== undefined) await runtime.blobs.put(rewrite.key(key), blob);
  }
  await runtime.store.batch(
    entries.map((entry) => ({
      type: 'put' as const,
      key: rewrite.key(entry.key),
      value: rewrite.value(entry.value),
    })),
  );
  return { entries: entries.length, files: files.length };
}

/** Removes every record and file under `prefix`, plus `extra` operations in the same batch. */
export async function removeTree(
  runtime: CoreRuntime,
  prefix: string,
  extra: readonly WriteOperation[] = [],
): Promise<number> {
  const entries = await runtime.store.list(prefix);
  await runtime.store.batch([
    ...entries.map((entry) => ({ type: 'delete' as const, key: entry.key })),
    ...extra,
  ]);
  const files = await runtime.blobs.list(prefix);
  for (const key of files) await runtime.blobs.delete(key);
  return entries.length + files.length;
}
