import type { ExecutionResult } from '@imp/core';
import type { ModelInfo } from '@imp/providers';

/** A command as the interface sees it: what it is and what it takes, without its code. */
export interface CommandInfo {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly effect: 'read' | 'write' | 'spend' | 'destructive';
  /** The JSON Schema of its input, the same one an agent receives as tool parameters. */
  readonly input: unknown;
}

export interface ModeInfo {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly stages: readonly { readonly id: string; readonly name: string }[];
}

export interface StoredFile {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

/** What the interface can ask of the core, with what each answers. */
export interface Calls {
  /** Puts the stored state in order and describes what the core offers. Asked once, first. */
  start: {
    args: [];
    result: {
      commands: readonly CommandInfo[];
      modes: readonly ModeInfo[];
      /** Whether the core holds an OpenRouter key, which the interface may never have seen. */
      keyHeld: boolean;
    };
  };
  /** Runs a command as the user. */
  run: { args: [commandId: string, input: unknown]; result: ExecutionResult<unknown> };
  /** Reads a stored file. With `take`, an export is removed once read: it was only waiting to be saved. */
  blob: { args: [key: string, take?: boolean]; result: StoredFile | undefined };
  /**
   * Hands the core a file the person picked, in parts small enough for any
   * channel. The last part names its media type and answers with the key it
   * is stored under, for a command such as project.import to read.
   */
  upload: {
    args: [uploadId: string, part: Uint8Array, last: { mediaType: string } | null];
    result: { key: string } | null;
  };
  models: { args: []; result: readonly ModelInfo[] };
  verify: { args: []; result: undefined };
}

export type Request =
  | { [K in keyof Calls]: { call: number; op: K; args: Calls[K]['args'] } }[keyof Calls]
  /**
   * A new key for the core, or null to forget it. In the browser the page
   * keeps the key and hands it over on every start; the local server keeps it
   * itself, so the page sends it once and never holds it.
   */
  | { op: 'key'; key: string | null }
  | { op: 'subscribe'; subscription: number; prefix: string }
  | { op: 'unsubscribe'; subscription: number };

/** An error as it crosses: enough to show it and to branch on it. */
export interface WireError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly kind?: string;
  readonly details?: readonly string[];
}

export type Reply =
  | { call: number; ok: true; value: unknown }
  | { call: number; ok: false; error: WireError }
  | { changed: number };

export function toWireError(error: unknown): WireError {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  const extra = error as { code?: unknown; kind?: unknown; details?: unknown };
  return {
    name: error.name,
    message: error.message,
    ...(typeof extra.code === 'string' ? { code: extra.code } : {}),
    ...(typeof extra.kind === 'string' ? { kind: extra.kind } : {}),
    ...(Array.isArray(extra.details) ? { details: extra.details.map(String) } : {}),
  };
}

export function fromWireError(wire: WireError): Error {
  const { name, message, ...extra } = wire;
  return Object.assign(new Error(message), { name }, extra);
}
