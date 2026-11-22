import { EXPORT_PREFIX, inputSchemaOf, partKey, UPLOAD_PREFIX } from '@imp/core';
import type { Imp } from './imp.js';
import type { Port } from './port.js';
import { toWireError, type Calls, type Reply, type Request } from './protocol.js';
import { createMemorySecretStore, type SecretStore } from './secrets.js';

const USER = { kind: 'user', id: 'local' } as const;
const UPLOAD_ID = /^[A-Za-z0-9-]{8,64}$/;

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
  /** Parts of files on their way in, by upload. */
  const uploads = new Map<string, Uint8Array[]>();
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
        keyHeld: secrets.getKey() !== null,
      };
    },
    run: async (commandId, input) =>
      (await core()).registry.executeById(commandId, input, { actor: USER }),
    blob: async (key, take = false) => {
      const imp = await core();
      const blob = await imp.blobs.get(key);
      if (take && key.startsWith(EXPORT_PREFIX)) await imp.blobs.delete(key);
      return blob === undefined ? undefined : { bytes: blob.bytes, mediaType: blob.mediaType };
    },
    upload: async (uploadId, part, last) => {
      if (!UPLOAD_ID.test(uploadId)) throw new Error('Not an upload id.');
      const parts = uploads.get(uploadId) ?? [];
      parts.push(part);
      if (last === null) {
        uploads.set(uploadId, parts);
        return null;
      }
      uploads.delete(uploadId);
      const bytes = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
      let at = 0;
      for (const p of parts) {
        bytes.set(p, at);
        at += p.length;
      }
      const key = `${UPLOAD_PREFIX}${uploadId}`;
      await (await core()).blobs.put(key, { bytes, mediaType: last.mediaType });
      return { key };
    },
    uploadPart: async (uploadId, index, part, last) => {
      if (!UPLOAD_ID.test(uploadId)) throw new Error('Not an upload id.');
      if (!Number.isInteger(index) || index < 0 || index > 999_999) throw new Error('Not a part.');
      const base = `${UPLOAD_PREFIX}${uploadId}`;
      const mediaType = last?.mediaType ?? 'application/octet-stream';
      await (await core()).blobs.put(partKey(base, index), { bytes: part, mediaType });
      return last === null ? null : { key: base };
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
    uploads.clear();
    for (const stop of subscriptions.values()) stop();
    subscriptions.clear();
  };
}
