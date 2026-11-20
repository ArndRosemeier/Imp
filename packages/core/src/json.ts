/** A value that survives a round trip through JSON, which is all a store may hold. */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
