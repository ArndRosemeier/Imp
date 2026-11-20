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
import type { SecretStore } from './secrets.js';

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
  blob(key: string): Promise<StoredFile | undefined>;
  listModels(): Promise<readonly ModelInfo[]>;
  /** Resolves when the stored key is accepted. */
  verifyCredentials(): Promise<void>;
  /** The key is kept on this side and handed to the core. */
  readonly secrets: SecretStore;
}

export function connectImp(
  port: Port,
  stored: SecretStore,
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

  let described: { commands: readonly CommandInfo[]; modes: readonly ModeInfo[] } = {
    commands: [],
    modes: [],
  };
  // Messages keep their order, so the core has the key before anything that needs it.
  post({ op: 'key', key: stored.getKey() });

  return {
    start: async () => {
      const asked = ask('start');
      described = await (lost === undefined ? asked : Promise.race([asked, lost]));
    },
    get commands() {
      return described.commands;
    },
    get modes() {
      return described.modes;
    },
    run: (commandId, input) => ask('run', commandId, input),
    blob: (key) => ask('blob', key),
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
      getKey: () => stored.getKey(),
      setKey: (key) => {
        stored.setKey(key);
        post({ op: 'key', key });
      },
      clearKey: () => {
        stored.clearKey();
        post({ op: 'key', key: null });
      },
    },
  };
}
