import { coordinatorRole, createAgentCommands, createCrewCommands, RoleCatalog } from '@imp/agents';
import {
  activityCommands,
  CommandRegistry,
  settingsCommands,
  type CoreRuntime,
  type KeyValueStore,
} from '@imp/core';
import { createOpenRouterProvider, type GenerationProvider, type HttpFetch } from '@imp/providers';
import type { SecretStore } from './secrets.js';

/** Everything the UI needs from the running core. The UI talks to nothing else. */
export interface Imp {
  readonly registry: CommandRegistry;
  readonly provider: GenerationProvider;
  readonly roles: RoleCatalog;
  readonly store: KeyValueStore;
  readonly secrets: SecretStore;
}

const browserFetch: HttpFetch = (url, request) =>
  fetch(url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    ...(request.signal instanceof AbortSignal ? { signal: request.signal } : {}),
  });

export interface ImpOptions {
  readonly store: KeyValueStore;
  readonly secrets: SecretStore;
  /** Replaces the OpenRouter provider. Tests pass a scripted one. */
  readonly provider?: GenerationProvider;
}

/** Assembles the core for the browser host. */
export function createImp(options: ImpOptions): Imp {
  const runtime: CoreRuntime = {
    store: options.store,
    now: () => new Date(),
    newId: () => crypto.randomUUID(),
  };
  const roles = new RoleCatalog([coordinatorRole]);
  const provider =
    options.provider ??
    createOpenRouterProvider({
      fetch: browserFetch,
      appName: 'Imp',
      apiKey: () => options.secrets.getKey() ?? '',
    });
  const registry = new CommandRegistry({ runtime });
  registry.register(
    ...settingsCommands,
    ...activityCommands,
    ...createCrewCommands(roles),
    ...createAgentCommands({ registry, provider, roles }),
  );
  return { registry, provider, roles, store: options.store, secrets: options.secrets };
}
