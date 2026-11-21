import {
  coordinatorRole,
  createAgentCommands,
  createCrewCommands,
  createModelCommands,
  releaseInterruptedRuns,
  RoleCatalog,
  type Mode,
} from '@imp/agents';
import { createAudioCommands, createDefaultAudioCodec, type AudioCodec } from '@imp/audio';
import {
  activityCommands,
  CommandRegistry,
  mediaCommands,
  MemoryBlobStore,
  createProjectCommands,
  readProject,
  settingsCommands,
  type BlobStore,
  type CoreRuntime,
  type KeyValueStore,
} from '@imp/core';
import {
  createMovieMode,
  createSceneAudioLink,
  type FilmRenderer,
  type FrameImageEncoder,
} from '@imp/mode-movie';
import { createWorldCommands } from '@imp/world';
import { createOpenRouterProvider, type GenerationProvider, type HttpFetch } from '@imp/providers';
import type { SecretStore } from './secrets.js';

/** The assembled core of one host. The interface reaches it through `serveImp`. */
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
  /**
   * Re-encodes a picture as JPEG or PNG, which video models need for a start
   * frame. The browser host does it with its own decoders; without it, key
   * frames in other formats are used as guides only.
   */
  readonly frameImage?: FrameImageEncoder;
  /**
   * Decodes stored sound. Defaults to the decoders every host has; the browser
   * host wraps them to decode the sound of video clips (AAC) with WebCodecs.
   */
  readonly audioCodec?: AudioCodec;
  /** Renders films to video files. The browser host encodes with WebCodecs; without one, films cannot be exported. */
  readonly filmRenderer?: FilmRenderer;
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
  const codec = options.audioCodec ?? createDefaultAudioCodec();
  const modes: readonly Mode[] = [
    createMovieMode({
      provider,
      film: {
        codec,
        ...(options.filmRenderer === undefined ? {} : { renderer: options.filmRenderer }),
      },
      ...(options.frameImage === undefined ? {} : { frameImage: options.frameImage }),
    }),
  ];
  const roles = new RoleCatalog([coordinatorRole, ...modes.flatMap((mode) => mode.roles)]);
  const registry = new CommandRegistry({ runtime });
  registry.register(
    ...settingsCommands,
    ...activityCommands,
    ...createProjectCommands(modes.map((mode) => ({ mode: mode.id, ...mode.project }))),
    ...mediaCommands,
    ...createAudioCommands({
      codec,
      links: [createSceneAudioLink()],
    }),
    ...createWorldCommands({
      provider,
      // The world is drawn in the style the project's mode keeps.
      style: async (store, projectId) => {
        const project = await readProject(store, projectId);
        const mode = modes.find((candidate) => candidate.id === project?.mode);
        return (await mode?.visualStyle?.(store, projectId)) ?? '';
      },
    }),
    ...modes.flatMap((mode) => mode.commands),
    ...createModelCommands(provider),
    ...createCrewCommands(roles, {
      commandIds: () => registry.list().map((command) => command.id),
    }),
    ...createAgentCommands({ registry, provider, roles }),
  );
  let started: Promise<void> | undefined;
  return {
    registry,
    provider,
    roles,
    modes,
    store: options.store,
    blobs,
    secrets: options.secrets,
    // Once per core: a second interface that connects must not release runs the first one started.
    start: () => (started ??= releaseInterruptedRuns(options.store)),
  };
}
