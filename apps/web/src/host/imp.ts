import {
  coordinatorRole,
  createAgentCommands,
  createCrewCommands,
  createModelCommands,
  releaseInterruptedRuns,
  RoleCatalog,
  type Mode,
} from '@imp/agents';
import {
  activityCommands,
  CommandRegistry,
  mediaCommands,
  MemoryBlobStore,
  projectCommands,
  settingsCommands,
  type BlobStore,
  type CoreRuntime,
  type KeyValueStore,
} from '@imp/core';
import { createMovieMode } from '@imp/mode-movie';
import { createOpenRouterProvider, type GenerationProvider, type HttpFetch } from '@imp/providers';
import type { SecretStore } from './secrets.js';

/** Everything the UI needs from the running core. The UI talks to nothing else. */
export interface Imp {
  readonly registry: CommandRegistry;
  readonly provider: GenerationProvider;
  readonly roles: RoleCatalog;
  /** The working modes this build ships with. */
  readonly modes: readonly Mode[];
  readonly store: KeyValueStore;
  readonly blobs: BlobStore;
  readonly secrets: SecretStore;
  /** Puts the stored state in order after a restart. Called once before the UI reads anything. */
  start(): Promise<void>;
}

const browserFetch: HttpFetch = async (url, request) => {
  const response = await fetch(url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    ...(request.signal instanceof AbortSignal ? { signal: request.signal } : {}),
  });
  return {
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get('content-type'),
    text: () => response.text(),
    bytes: async () => new Uint8Array(await response.arrayBuffer()),
  };
};

export interface ImpOptions {
  readonly store: KeyValueStore;
  /** Where images and other files go. Defaults to memory, which a reload empties. */
  readonly blobs?: BlobStore;
  readonly secrets: SecretStore;
  /** Replaces the OpenRouter provider. Tests pass a scripted one. */
  readonly provider?: GenerationProvider;
}

/** Assembles the core for the browser host. */
export function createImp(options: ImpOptions): Imp {
  const blobs = options.blobs ?? new MemoryBlobStore();
  const runtime: CoreRuntime = {
    store: options.store,
    blobs,
    now: () => new Date(),
    newId: () => crypto.randomUUID(),
  };
  const provider =
    options.provider ??
    createOpenRouterProvider({
      fetch: browserFetch,
      appName: 'Imp',
      apiKey: () => options.secrets.getKey() ?? '',
    });
  // Adding a working mode to the app is adding it to this list.
  const modes: readonly Mode[] = [createMovieMode({ provider })];
  const roles = new RoleCatalog([coordinatorRole, ...modes.flatMap((mode) => mode.roles)]);
  const registry = new CommandRegistry({ runtime });
  registry.register(
    ...settingsCommands,
    ...activityCommands,
    ...projectCommands,
    ...mediaCommands,
    ...modes.flatMap((mode) => mode.commands),
    ...createModelCommands(provider),
    ...createCrewCommands(roles, {
      commandIds: () => registry.list().map((command) => command.id),
    }),
    ...createAgentCommands({ registry, provider, roles }),
  );
  return {
    registry,
    provider,
    roles,
    modes,
    store: options.store,
    blobs,
    secrets: options.secrets,
    start: () => releaseInterruptedRuns(options.store),
  };
}
