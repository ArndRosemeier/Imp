import { inputSchemaOf } from '@imp/core';
import type { Imp } from './imp.js';
import type { Port } from './port.js';
import { toWireError, type Calls, type Reply, type Request } from './protocol.js';
import { createMemorySecretStore, type SecretStore } from './secrets.js';

const USER = { kind: 'user', id: 'local' } as const;

/**
 * Answers the interface on one port. `open` builds the core around the secrets
 * it is given; it runs once, on the first request, so that listening starts at
 * once and nothing sent early is lost.
 */
export function serveImp(
  open: (secrets: SecretStore) => Promise<Imp> | Imp,
  port: Port,
  /** Shared when several interfaces reach one core, as with the local server. */
  secrets: SecretStore = createMemorySecretStore(),
): () => void {
  let opened: Promise<Imp> | undefined;
  const core = (): Promise<Imp> => (opened ??= Promise.resolve(open(secrets)));
  const subscriptions = new Map<number, () => void>();
  const send = (reply: Reply): void => {
    port.postMessage(reply);
  };

  const handlers: {
    [K in keyof Calls]: (...args: Calls[K]['args']) => Promise<Calls[K]['result']>;
  } = {
    start: async () => {
      const imp = await core();
      await imp.start();
      return {
        commands: imp.registry.list().map((command) => ({
          id: command.id,
          title: command.title,
          description: command.description,
          effect: command.effect,
          input: inputSchemaOf(command),
        })),
        modes: imp.modes.map(({ id, name, summary, stages }) => ({
          id,
          name,
          summary,
          stages: stages.map((stage) => ({ id: stage.id, name: stage.name })),
        })),
      };
    },
    run: async (commandId, input) =>
      (await core()).registry.executeById(commandId, input, { actor: USER }),
    blob: async (key) => {
      const blob = await (await core()).blobs.get(key);
      return blob === undefined ? undefined : { bytes: blob.bytes, mediaType: blob.mediaType };
    },
    models: async () => (await core()).provider.listModels(),
    verify: async () => {
      await (await core()).provider.verifyCredentials();
      return undefined;
    },
  };

  port.onmessage = ({ data }) => {
    const request = data as Request;
    if (request.op === 'key') {
      if (request.key === null) secrets.clearKey();
      else secrets.setKey(request.key);
    } else if (request.op === 'subscribe') {
      const { subscription, prefix } = request;
      // Registered at once, so an unsubscribe that follows closely finds it.
      let stop: (() => void) | undefined;
      let stopped = false;
      subscriptions.set(subscription, () => {
        stopped = true;
        stop?.();
      });
      void core().then((imp) => {
        if (stopped) return;
        stop = imp.store.subscribe(prefix, () => {
          send({ changed: subscription });
        });
      });
    } else if (request.op === 'unsubscribe') {
      subscriptions.get(request.subscription)?.();
      subscriptions.delete(request.subscription);
    } else {
      const { call } = request;
      const handler = handlers[request.op] as (...args: unknown[]) => Promise<unknown>;
      handler(...request.args).then(
        (value) => {
          send({ call, ok: true, value });
        },
        (error: unknown) => {
          send({ call, ok: false, error: toWireError(error) });
        },
      );
    }
  };

  // For when the other end goes away: stop telling it of changes.
  return () => {
    port.onmessage = null;
    for (const stop of subscriptions.values()) stop();
    subscriptions.clear();
  };
}
