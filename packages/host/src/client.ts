import type { ExecutionResult } from '@imp/core';
import type { ModelInfo } from '@imp/providers';
import type { Port } from './port.js';
import {
  fromWireError,
  type Calls,
  type CommandInfo,
  type ModeInfo,
  type Reply,
  type Request,
  type StoredFile,
} from './protocol.js';
import type { KeyAccess, SecretStore } from './secrets.js';

/**
 * Everything the interface needs from the running core. The interface talks to
 * nothing else, and all of it crosses a message channel, so the core can run
 * in a worker or, later, in a local server.
 */
export interface ImpClient {
  /** Starts the core. Everything else is used after it resolved. */
  start(): Promise<void>;
  /** Every registered command. */
  readonly commands: readonly CommandInfo[];
  /** The working modes this build ships with. */
  readonly modes: readonly ModeInfo[];
  /** Runs a command as the user. */
  run(commandId: string, input: unknown): Promise<ExecutionResult<unknown>>;
  /** Calls `listener` after each change to the store under `prefix`. */
  subscribe(prefix: string, listener: () => void): () => void;
  /** Reads a stored file. `take` removes an export once it is read. */
  blob(key: string, take?: boolean): Promise<StoredFile | undefined>;
  /** Stores a file the person picked and returns its key, for project.import and the like. */
  upload(bytes: Uint8Array, mediaType: string): Promise<string>;
  /**
   * Stores a large file the person picked part by part, reading it a piece at
   * a time, so it never has to be in memory whole. Returns its key, for
   * backup.load. `progress` hears how many bytes have gone over.
   */
  uploadFile(file: Blob, progress?: (sentBytes: number) => void): Promise<string>;
  listModels(): Promise<readonly ModelInfo[]>;
  /** Resolves when the stored key is accepted. */
  verifyCredentials(): Promise<void>;
  /**
   * The OpenRouter key: whether the core has one, and giving or forgetting
   * it. Known after start.
   */
  readonly secrets: KeyAccess;
}

/**
 * Where the key is kept. `page`: by the page, in `store`, and handed to the
 * core on every start (the core in a worker keeps nothing). `core`: by the
 * core itself (the local server), so the page only passes a new key on and
 * never holds it; a key an older version left in the page is moved over
 * once with `leftover` and then forgotten here.
 */
export type KeyKeeping =
  | { readonly by: 'page'; readonly store: SecretStore }
  | {
      readonly by: 'core';
      readonly leftover?: { readonly key: string | null; readonly forget: () => void };
    };

/** Bytes per upload part: base64 makes 4 MiB about 5.3 MB, under the local server's 8 MB. */
const UPLOAD_PART = 4 * 1024 * 1024;

function newUploadId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function connectImp(
  port: Port,
  keeping: SecretStore | KeyKeeping,
  /** Rejects when the other end is lost, for example a worker that failed to load. */
  lost?: Promise<never>,
): ImpClient {
  let lastId = 0;
  const waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const listeners = new Map<number, () => void>();
  const post = (request: Request): void => {
    port.postMessage(request);
  };

  port.onmessage = ({ data }) => {
    const reply = data as Reply;
    if ('changed' in reply) {
      listeners.get(reply.changed)?.();
      return;
    }
    const call = waiting.get(reply.call);
    waiting.delete(reply.call);
    if (reply.ok) call?.resolve(reply.value);
    else call?.reject(fromWireError(reply.error));
  };

  const ask = <K extends keyof Calls>(
    op: K,
    ...args: Calls[K]['args']
  ): Promise<Calls[K]['result']> =>
    new Promise((resolve, reject) => {
      const call = (lastId += 1);
      waiting.set(call, { resolve: resolve as (value: unknown) => void, reject });
      post({ call, op, args } as Request);
    });

  const keys: KeyKeeping = 'by' in keeping ? keeping : { by: 'page', store: keeping };
  const stored = keys.by === 'page' ? keys.store : null;
  let described: { commands: readonly CommandInfo[]; modes: readonly ModeInfo[] } = {
    commands: [],
    modes: [],
  };
  let keyHeld = (stored?.getKey() ?? null) !== null;
  // Messages keep their order, so the core has the key before anything that needs it.
  if (stored !== null) post({ op: 'key', key: stored.getKey() });

  return {
    start: async () => {
      const asked = ask('start');
      const reply = await (lost === undefined ? asked : Promise.race([asked, lost]));
      described = { commands: reply.commands, modes: reply.modes };
      keyHeld = reply.keyHeld;
      if (keys.by === 'core' && keys.leftover !== undefined) {
        const { key, forget } = keys.leftover;
        // A key from before the core kept its own: hand it over unless the core has one.
        if (!keyHeld && key !== null && key !== '') {
          post({ op: 'key', key });
          keyHeld = true;
        }
        forget();
      }
    },
    get commands() {
      return described.commands;
    },
    get modes() {
      return described.modes;
    },
    run: (commandId, input) => ask('run', commandId, input),
    blob: (key, take) => ask('blob', key, take),
    upload: async (bytes, mediaType) => {
      const uploadId = newUploadId();
      // Parts stay well under what the local server takes in one message.
      for (let at = 0; at + UPLOAD_PART < bytes.length; at += UPLOAD_PART) {
        await ask('upload', uploadId, bytes.slice(at, at + UPLOAD_PART), null);
      }
      const lastStart = Math.max(0, Math.floor((bytes.length - 1) / UPLOAD_PART) * UPLOAD_PART);
      const done = await ask('upload', uploadId, bytes.slice(lastStart), { mediaType });
      if (done === null) throw new Error('The file did not arrive.');
      return done.key;
    },
    uploadFile: async (file, progress) => {
      const uploadId = newUploadId();
      const mediaType = file.type === '' ? 'application/octet-stream' : file.type;
      const parts = Math.max(1, Math.ceil(file.size / UPLOAD_PART));
      for (let index = 0; index < parts; index += 1) {
        const start = index * UPLOAD_PART;
        const bytes = new Uint8Array(
          await file.slice(start, Math.min(file.size, start + UPLOAD_PART)).arrayBuffer(),
        );
        const last = index === parts - 1;
        const done = await ask('uploadPart', uploadId, index, bytes, last ? { mediaType } : null);
        progress?.(start + bytes.length);
        if (last) {
          if (done === null) throw new Error('The file did not arrive.');
          return done.key;
        }
      }
      throw new Error('The file did not arrive.');
    },
    listModels: () => ask('models'),
    verifyCredentials: async () => {
      await ask('verify');
    },
    subscribe: (prefix, listener) => {
      const subscription = (lastId += 1);
      listeners.set(subscription, listener);
      post({ op: 'subscribe', subscription, prefix });
      return () => {
        listeners.delete(subscription);
        post({ op: 'unsubscribe', subscription });
      };
    },
    secrets: {
      hasKey: () => keyHeld,
      setKey: (key) => {
        stored?.setKey(key);
        keyHeld = true;
        post({ op: 'key', key });
      },
      clearKey: () => {
        stored?.clearKey();
        keyHeld = false;
        post({ op: 'key', key: null });
      },
    },
  };
}
