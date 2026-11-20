import {
  coordinatorRole,
  createAgentCommands,
  createCrewCommands,
  releaseInterruptedRuns,
  RoleCatalog,
  type Mode,
} from '@imp/agents';
import {
  activityCommands,
  CommandRegistry,
  projectCommands,
  settingsCommands,
  type CoreRuntime,
  type KeyValueStore,
} from '@imp/core';
import { movieMode } from '@imp/mode-movie';
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
  readonly secrets: SecretStore;
  /** Puts the stored state in order after a restart. Called once before the UI reads anything. */
  start(): Promise<void>;
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

/** Adding a working mode to the app is adding it to this list. */
const MODES: readonly Mode[] = [movieMode];

/** Assembles the core for the browser host. */
export function createImp(options: ImpOptions): Imp {
  const runtime: CoreRuntime = {
    store: options.store,
    now: () => new Date(),
    newId: () => crypto.randomUUID(),
  };
  const roles = new RoleCatalog([coordinatorRole, ...MODES.flatMap((mode) => mode.roles)]);
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
    ...projectCommands,
    ...MODES.flatMap((mode) => mode.commands),
    ...createCrewCommands(roles, {
      commandIds: () => registry.list().map((command) => command.id),
    }),
    ...createAgentCommands({ registry, provider, roles }),
  );
  return {
    registry,
    provider,
    roles,
    modes: MODES,
    store: options.store,
    secrets: options.secrets,
    start: () => releaseInterruptedRuns(options.store),
  };
}
