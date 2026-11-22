import {
  coordinatorRole,
  guideRole,
  createAgentCommands,
  createCrewCommands,
  createModelCommands,
  createModelMixCommands,
  createSavedCrewCommands,
  createSpendCommands,
  createSpendLedger,
  withSpendLedger,
  releaseInterruptedRuns,
  RoleCatalog,
  type Mode,
} from '@imp/agents';
import {
  audioLibrarySource,
  createAudioCommands,
  createDefaultAudioCodec,
  TRANSCRIPTION_MODEL_SETTING,
  type Mp4AudioDecoder,
} from '@imp/audio';
import {
  activityCommands,
  CommandRegistry,
  createBackupCommands,
  createHelpCommands,
  createSupportCommands,
  createLibraryCommands,
  mediaCommands,
  MemoryBlobStore,
  createProjectCommands,
  createReleaseCommands,
  readProject,
  settingsCommands,
  languageCommands,
  type BlobStore,
  type CoreRuntime,
  type KeyValueStore,
  type ReleaseNotes,
  UNKNOWN_RELEASE,
} from '@imp/core';
import {
  createMovieMode,
  createSceneAudioLink,
  EFFECT_MODEL_SETTING,
  IMAGE_MODEL_SETTING,
  MUSIC_MODEL_SETTING,
  SPEECH_MODEL_SETTING,
  VIDEO_MODEL_SETTING,
  type FilmRenderer,
  type ColorSampler,
  type FrameGrabber,
  type FrameImageEncoder,
} from '@imp/mode-movie';
import { createWorldCommands, worldLibrarySource } from '@imp/world';
import { createOpenRouterProvider, type GenerationProvider, type HttpFetch } from '@imp/providers';
import { guideTranslations, workspaceGuides } from './guide.js';
import type { SecretStore } from './secrets.js';
import { createFfmpegCommands, type FfmpegService } from './ffmpeg-commands.js';

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
   * Decodes the sound inside video clips (AAC), which needs a native decoder:
   * WebCodecs in the browser, ffmpeg on the local server. Without it, clip
   * sound plays as silence and is reported as unheard.
   */
  readonly mp4Audio?: Mp4AudioDecoder;
  /**
   * This build's version and what changed in each version, worked out from
   * the repository's history when the app was built. Defaults to version 0.000.
   */
  readonly release?: ReleaseNotes;
  /** Where this copy runs, for problem reports: "browser" or the local server and its system. */
  readonly runsOn?: string;
  /** Renders films to video files. The browser host encodes with WebCodecs; without one, films cannot be exported. */
  readonly filmRenderer?: FilmRenderer;
  /** Takes stills from clips so that agents can see a cut: mediabunny in the browser, ffmpeg on the server. */
  readonly frameGrabber?: FrameGrabber;
  /** Reads the colours of clips to match shots: mediabunny in the browser, ffmpeg on the server. */
  readonly colorSampler?: ColorSampler;
  /** The local server's ffmpeg, which it can download; the browser host has none. */
  readonly ffmpeg?: FfmpegService;
  /** Replaces the OpenRouter provider. Tests pass a scripted one. */
  readonly provider?: GenerationProvider;
}

export type { ColorSampler, FrameGrabber };

/** Assembles the core for the browser host. */
export function createImp(options: ImpOptions): Imp {
  const blobs = options.blobs ?? new MemoryBlobStore();
  const runtime: CoreRuntime = {
    store: options.store,
    blobs,
    now: () => new Date(),
    newId: () => crypto.randomUUID(),
  };
  // Every paid call goes through here and is written down, whichever command made it.
  const provider = withSpendLedger(
    options.provider ??
      createOpenRouterProvider({
        fetch: browserFetch,
        appName: 'Imp',
        apiKey: () => options.secrets.getKey() ?? '',
      }),
    createSpendLedger(runtime),
  );
  // Adding a working mode to the app is adding it to this list.
  const codec = createDefaultAudioCodec(
    options.mp4Audio === undefined ? {} : { mp4: options.mp4Audio },
  );
  const modes: readonly Mode[] = [
    createMovieMode({
      provider,
      film: {
        codec,
        ...(options.filmRenderer === undefined ? {} : { renderer: options.filmRenderer }),
      },
      ...(options.frameImage === undefined ? {} : { frameImage: options.frameImage }),
      ...(options.frameGrabber === undefined ? {} : { frameGrabber: options.frameGrabber }),
      ...(options.colorSampler === undefined ? {} : { colorSampler: options.colorSampler }),
    }),
  ];
  const roles = new RoleCatalog([
    coordinatorRole,
    guideRole,
    ...modes.flatMap((mode) => mode.roles),
  ]);
  const registry = new CommandRegistry({ runtime });
  registry.register(
    ...settingsCommands,
    ...languageCommands,
    ...createReleaseCommands(options.release ?? UNKNOWN_RELEASE),
    ...createSupportCommands({
      release: options.release ?? UNKNOWN_RELEASE,
      runsOn: options.runsOn ?? 'unknown',
    }),
    ...activityCommands,
    // The guide: Imp's pages about itself, and the stages' pages from each mode.
    ...createHelpCommands(
      [
        ...workspaceGuides,
        ...modes.flatMap((mode) => mode.stages.flatMap((stage) => stage.guide ?? [])),
      ],
      guideTranslations(modes),
    ),
    ...createProjectCommands(modes.map((mode) => ({ mode: mode.id, ...mode.project }))),
    ...mediaCommands,
    ...createLibraryCommands([
      ...modes.flatMap((mode) => mode.library ?? []),
      worldLibrarySource,
      audioLibrarySource,
    ]),
    ...createAudioCommands({
      codec,
      links: [createSceneAudioLink()],
      transcribe: (request) => provider.transcribe(request),
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
    ...createSavedCrewCommands(roles),
    ...createModelMixCommands([
      { setting: 'coordinator.model', label: 'Agents' },
      { setting: VIDEO_MODEL_SETTING, label: 'Video' },
      { setting: SPEECH_MODEL_SETTING, label: 'Voices' },
      { setting: IMAGE_MODEL_SETTING, label: 'Pictures' },
      { setting: EFFECT_MODEL_SETTING, label: 'Sound effects' },
      { setting: MUSIC_MODEL_SETTING, label: 'Music' },
      { setting: TRANSCRIPTION_MODEL_SETTING, label: 'Transcripts' },
    ]),
    ...(options.ffmpeg === undefined ? [] : createFfmpegCommands(options.ffmpeg)),
    ...createAgentCommands({ registry, provider, roles }),
    ...createSpendCommands({ registry, provider }),
    // Save all and Load all. The key is not in the store, so it is never in a backup.
    ...createBackupCommands({
      appVersion: (options.release ?? UNKNOWN_RELEASE).version,
      afterLoad: releaseInterruptedRuns,
    }),
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
