import type { ImpClient } from '@imp/host';
import { Shot, Sound, TextView } from '@imp/mode-movie';
import { z } from 'zod';
import { runCommand } from './context.js';

export const ItemState = z.enum([
  'ready',
  'no_clip',
  'clip_pending',
  'clip_failed',
  'dialogue_missing',
  'dialogue_outdated',
  'shot_missing',
]);
export const ITEM_STATE_TEXT: Record<z.infer<typeof ItemState>, string> = {
  ready: 'Ready',
  no_clip: 'No clip yet',
  clip_pending: 'Clip being made',
  clip_failed: 'Clip failed',
  dialogue_missing: 'Dialogue not recorded',
  dialogue_outdated: 'Dialogue is of an earlier line',
  shot_missing: 'Shot was deleted',
};

export const Film = z.object({
  totalSeconds: z.number(),
  totalCostUsd: z.number(),
  items: z.number(),
  readyItems: z.number(),
  scenes: z.array(
    z.object({
      sceneId: z.string(),
      position: z.number(),
      heading: z.string(),
      items: z.number(),
      readyItems: z.number(),
      durationSeconds: z.number(),
      missing: z.array(z.object({ itemId: z.string(), index: z.number(), state: ItemState })),
    }),
  ),
});

export const Item = z.object({
  itemId: z.string(),
  kind: z.enum(['shot', 'title']),
  index: z.number(),
  sceneId: z.string(),
  shotId: z.string(),
  label: z.string(),
  state: ItemState,
  trimStartSeconds: z.number(),
  trimEndSeconds: z.number(),
  dialogueVolume: z.number(),
  clipAudioVolume: z.number(),
  hasClipAudio: z.boolean(),
  fadeInSeconds: z.number(),
  fadeOutSeconds: z.number(),
  text: z.string(),
  startsAtSeconds: z.number(),
  durationSeconds: z.number(),
  sourceSeconds: z.number(),
});
export type Item = z.infer<typeof Item>;

export const Placement = z.object({
  id: z.string(),
  source: z.enum(['sound', 'clip', 'dialogue']),
  soundId: z.string(),
  sceneId: z.string(),
  shotId: z.string(),
  trimStartSeconds: z.number(),
  startSeconds: z.number(),
  volume: z.number(),
  fadeInSeconds: z.number(),
  fadeOutSeconds: z.number(),
  loop: z.boolean(),
  durationSeconds: z.number().nullable().default(null),
  pan: z.number().default(0),
  gainDb: z.number().default(0),
  fadeCurve: z.enum(['linear', 'smooth']).default('linear'),
  /** Processing set in the audio editor; played from a processed copy (playKey). */
  effects: z.array(z.unknown()).default([]),
  /** The processed copy of the sound, when it has effects; filled in by loadCut. */
  playKey: z.string().nullable().default(null),
  name: z.string(),
  kind: z.enum(['effect', 'music', 'clip', 'dialogue']),
  recorded: z.boolean(),
});
export type Placement = z.infer<typeof Placement>;

export const Line = z.object({
  id: z.string(),
  characterId: z.string(),
  text: z.string(),
  delivery: z.string(),
  startSeconds: z.number(),
  trimStartSeconds: z.number(),
  volume: z.number(),
  fadeInSeconds: z.number(),
  fadeOutSeconds: z.number(),
  recorded: z.boolean(),
  outdated: z.boolean(),
  durationSeconds: z.number(),
  take: z.object({ blobKey: z.string() }).nullable(),
  effects: z.array(z.unknown()).default([]),
  playKey: z.string().nullable().default(null),
});
export type Line = z.infer<typeof Line>;

export const Lane = z.object({ characterId: z.string(), name: z.string(), voiceOnly: z.boolean() });

export const Cut = z.object({
  totalSeconds: z.number(),
  canUndo: z.boolean(),
  canRedo: z.boolean(),
  items: z.array(Item),
  unplaced: z.array(
    z.object({ shotId: z.string(), position: z.number(), description: z.string() }),
  ),
  sounds: z.array(Placement),
  lanes: z.array(Lane),
  lines: z.array(Line),
  /** The text lane, each text at the time it shows. */
  texts: z.array(TextView).default([]),
  /** Which version this is: the cut itself, or what agents propose. */
  version: z.enum(['cut', 'draft']).default('cut'),
  /** What agents propose for the scene, when they proposed anything. */
  draft: z
    .object({
      changes: z.number(),
      authors: z.array(z.object({ id: z.string(), role: z.string() })),
      request: z
        .object({
          instruction: z.string(),
          fromSeconds: z.number().nullable(),
          toSeconds: z.number().nullable(),
        })
        .nullable(),
      updatedAt: z.string(),
    })
    .nullable()
    .default(null),
});
export type Cut = z.infer<typeof Cut>;

/** One change agents propose, as movie.edit.draft.get lists it. */
export const Change = z.object({
  id: z.string(),
  part: z.enum(['item', 'sound', 'line', 'text']),
  kind: z.enum(['added', 'removed', 'changed', 'moved']),
  elementId: z.string(),
  summary: z.string(),
  startsAtSeconds: z.number(),
  durationSeconds: z.number(),
  conflict: z.boolean(),
  outside: z.boolean(),
});
export type Change = z.infer<typeof Change>;

export const Proposal = z.object({
  exists: z.boolean(),
  authors: z.array(z.object({ id: z.string(), role: z.string() })),
  request: z
    .object({
      instruction: z.string(),
      fromSeconds: z.number().nullable(),
      toSeconds: z.number().nullable(),
    })
    .nullable(),
  cutChanged: z.boolean(),
  changes: z.array(Change),
});
export type Proposal = z.infer<typeof Proposal>;

export const Shots = z.object({ shots: z.array(Shot) });
export const Sounds = z.object({ sounds: z.array(Sound) });
export const Scenes = z.object({
  scenes: z.array(z.object({ id: z.string(), position: z.number(), heading: z.string() })),
});

/** How a length reads on a clock: 1:05. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, '0')}`;
}

/** The brightness of a picture at a time: faded up from black and down to black at its edges. */
export function fadeLevel(
  fadeIn: number,
  fadeOut: number,
  sinceStart: number,
  untilEnd: number,
): number {
  const up = fadeIn > 0 ? Math.min(1, sinceStart / fadeIn) : 1;
  const down = fadeOut > 0 ? Math.min(1, untilEnd / fadeOut) : 1;
  return Math.max(0, Math.min(1, up * down));
}
export interface Source {
  shots: readonly Shot[];
  sounds: readonly Sound[];
}

/** Where the media of a placement is stored, if there is any. */
export function placementKey(placement: Placement, source: Source): string | undefined {
  if (placement.playKey !== null) return placement.playKey;
  if (placement.source === 'sound') {
    return source.sounds.find((sound) => sound.id === placement.soundId)?.take?.blobKey;
  }
  const shot = source.shots.find((candidate) => candidate.id === placement.shotId);
  return placement.source === 'clip' ? (shot?.clip?.blobKey ?? undefined) : shot?.dialogue?.blobKey;
}

/** Decibels to a gain factor: the formula of dbToGain in @imp/audio. */
const dbToGain = (db: number): number => 10 ** (db / 20);

/** The gain of the fades, as fadeGain in @imp/audio computes it for the audio editor. */
export function fadeGain(
  offset: number,
  length: number,
  fadeIn: number,
  fadeOut: number,
  curve: 'linear' | 'smooth',
): number {
  const shape = (x: number): number => (curve === 'linear' ? x : 0.5 - 0.5 * Math.cos(Math.PI * x));
  const rise = fadeIn > 0 ? Math.min(1, offset / fadeIn) : 1;
  const fall = fadeOut > 0 ? Math.min(1, (length - offset) / fadeOut) : 1;
  return shape(Math.max(0, rise)) * shape(Math.max(0, fall));
}

/** Left and right gains of a pan from -1 to 1: a balance, so 0 leaves both sides as they are (panGains in @imp/audio). */
export function panGains(pan: number): readonly [number, number] {
  return [pan > 0 ? 1 - pan : 1, pan < 0 ? 1 + pan : 1];
}

/** A graph sounds are routed through: a recording's, or the page's own. */
export interface AudioOutput {
  context: AudioContext;
  destination: AudioNode;
}

interface Route {
  level: GainNode;
  left: GainNode;
  right: GainNode;
}

/** A line of a character lane plays like a placed sound. */
function linePlacement(line: Line): Placement {
  return {
    id: line.id,
    source: 'sound',
    soundId: '',
    sceneId: '',
    shotId: '',
    trimStartSeconds: line.trimStartSeconds,
    startSeconds: line.startSeconds,
    volume: line.volume,
    fadeInSeconds: line.fadeInSeconds,
    fadeOutSeconds: line.fadeOutSeconds,
    loop: false,
    durationSeconds: null,
    pan: 0,
    gainDb: 0,
    fadeCurve: 'linear',
    effects: line.effects,
    playKey: line.playKey,
    name: '',
    kind: 'dialogue',
    recorded: line.recorded,
  };
}

/** Every stored file a cut needs to play: clips, dialogue, sounds and lane lines. */
export function blobKeys(source: Source, cut: Cut): string[] {
  return [
    ...source.shots.flatMap((shot) => [shot.clip?.blobKey, shot.dialogue?.blobKey]),
    ...source.sounds.map((sound) => sound.take?.blobKey),
    ...cut.lines.map((line) => line.take?.blobKey),
    ...cut.sounds.map((placement) => placement.playKey),
    ...cut.lines.map((line) => line.playKey),
  ].filter((key): key is string => typeof key === 'string');
}

export interface Look {
  brightness: number;
  /** The words of the title card on screen, if one is. */
  title: string;
  /** A title card is on screen (black, with its words if it has any), not a clip. */
  card: boolean;
}

export interface Media {
  cut: Cut;
  source: Source;
  urls: ReadonlyMap<string, string>;
}

/**
 * Plays the cut: the items one after the other with their dialogue and the
 * clip sounds that were left on them, and the audio lane at its times. One
 * clock drives everything, so nothing is rendered and the cut can be watched
 * as it is edited. It owns the media elements; the page only shows its state.
 */
export class CutPlayer {
  video: HTMLVideoElement | null = null;
  voice: HTMLAudioElement | null = null;
  media: Media;
  #players = new Map<string, HTMLAudioElement>();
  #startedAt = 0;
  #offset = 0;
  #itemId = '';
  #timer: ReturnType<typeof setInterval> | undefined;
  #routes = new Map<HTMLAudioElement, Route>();
  #own: AudioOutput | undefined;

  constructor(
    media: Media,
    private readonly notify: {
      at: (seconds: number) => void;
      playing: (playing: boolean) => void;
      look: (look: Look) => void;
      /** The cut played to its end (it then rewinds). */
      ended?: () => void;
    },
    /**
     * Where every sound of the audio lane is sent through an audio graph, as a
     * recording needs. Without it a sound is routed only when it is panned, to
     * the page's own output.
     */
    private readonly output?: AudioOutput,
  ) {
    this.media = media;
  }

  /**
   * The graph of a sound: its level, then a balance of left and right. The
   * sound is first made stereo, so a mono file is panned too.
   */
  #route(player: HTMLAudioElement, pan: number): Route | undefined {
    const known = this.#routes.get(player);
    if (known !== undefined) return known;
    if (this.output === undefined && pan === 0) return undefined;
    if (
      this.output === undefined &&
      this.#own === undefined &&
      typeof AudioContext !== 'undefined'
    ) {
      const context = new AudioContext();
      this.#own = { context, destination: context.destination };
    }
    const target = this.output ?? this.#own;
    if (target === undefined) return undefined;
    const { context, destination } = target;
    const level = context.createGain();
    level.channelCount = 2;
    level.channelCountMode = 'explicit';
    level.channelInterpretation = 'speakers';
    const split = context.createChannelSplitter(2);
    const merge = context.createChannelMerger(2);
    const left = context.createGain();
    const right = context.createGain();
    context.createMediaElementSource(player).connect(level);
    level.connect(split);
    split.connect(left, 0);
    split.connect(right, 1);
    left.connect(merge, 0, 0);
    right.connect(merge, 0, 1);
    merge.connect(destination);
    if (context.state === 'suspended') void context.resume();
    const route = { level, left, right };
    this.#routes.set(player, route);
    return route;
  }

  attach(video: HTMLVideoElement | null, voice: HTMLAudioElement | null): void {
    if (video !== null) this.video = video;
    if (voice !== null) this.voice = voice;
  }

  get isPlaying(): boolean {
    return this.#timer !== undefined;
  }

  /** Where the cut is now, to the millisecond, for drawing between the player's ticks. */
  get now(): number {
    const t = this.isPlaying
      ? this.#offset + (performance.now() - this.#startedAt) / 1000
      : this.#offset;
    return Math.min(t, this.media.cut.totalSeconds);
  }

  /** What is at a time in the cut: the frame, the dialogue and the audio lane. */
  #apply(t: number, play: boolean): void {
    const { cut, source, urls } = this.media;
    const item = cut.items.find(
      (candidate) =>
        candidate.durationSeconds > 0 &&
        t >= candidate.startsAtSeconds &&
        t < candidate.startsAtSeconds + candidate.durationSeconds,
    );
    const screen = this.video;
    if (item === undefined || screen === null) {
      screen?.pause();
      this.voice?.pause();
      this.notify.look({ brightness: 0, title: '', card: false });
    } else {
      const since = t - item.startsAtSeconds;
      const brightness = fadeLevel(
        item.fadeInSeconds,
        item.fadeOutSeconds,
        since,
        item.durationSeconds - since,
      );
      if (item.kind === 'title') {
        screen.pause();
        this.voice?.pause();
        this.notify.look({ brightness, title: item.text, card: true });
      } else {
        this.notify.look({ brightness, title: '', card: false });
        const shot = source.shots.find((candidate) => candidate.id === item.shotId);
        const into = since + item.trimStartSeconds;
        const fresh = this.#itemId !== item.itemId;
        const file = urls.get(shot?.clip?.blobKey ?? '');
        if (file !== undefined) {
          if (fresh || screen.src !== file) screen.src = file;
          if (fresh || !play || Math.abs(screen.currentTime - into) > 0.4)
            screen.currentTime = into;
          screen.muted = shot?.clip?.silent === true || item.clipAudioVolume === 0;
          screen.volume = item.clipAudioVolume;
          if (play) void screen.play();
          else screen.pause();
        }
        const dialogue = urls.get(shot?.dialogue?.blobKey ?? '');
        const speaker = this.voice;
        if (speaker !== null && dialogue !== undefined && shot?.clip?.silent === true) {
          if (fresh || speaker.src !== dialogue) speaker.src = dialogue;
          if (fresh || !play) speaker.currentTime = into;
          speaker.volume = item.dialogueVolume;
          if (play) void speaker.play();
          else speaker.pause();
        } else {
          speaker?.pause();
        }
        this.#itemId = item.itemId;
      }
    }
    const lane = [
      ...cut.sounds.map((placement) => ({ placement, key: placementKey(placement, source) })),
      ...cut.lines.map((line) => ({
        placement: linePlacement(line),
        key: line.playKey ?? line.take?.blobKey,
      })),
    ];
    for (const { placement, key } of lane) {
      let player = this.#players.get(placement.id);
      if (!play) {
        player?.pause();
        continue;
      }
      const file = urls.get(key ?? '');
      if (file === undefined) continue;
      if (player === undefined) {
        player = new Audio(file);
        this.#route(player, placement.pan);
        this.#players.set(placement.id, player);
      }
      player.loop = placement.loop;
      const since = t - placement.startSeconds;
      if (since < 0) {
        player.pause();
        continue;
      }
      const natural = placement.loop
        ? cut.totalSeconds - placement.startSeconds
        : player.duration - placement.trimStartSeconds;
      const length =
        placement.durationSeconds === null ? natural : Math.min(placement.durationSeconds, natural);
      if (Number.isFinite(length) && since > length) {
        player.pause();
        continue;
      }
      // Fades, gain and pan as the audio editor mixes them.
      const fades = fadeGain(
        since,
        length,
        placement.fadeInSeconds,
        placement.fadeOutSeconds,
        placement.fadeCurve,
      );
      const level = Math.max(0, Math.min(1, placement.volume * dbToGain(placement.gainDb) * fades));
      const route = this.#route(player, placement.pan);
      if (route === undefined) {
        player.volume = level;
      } else {
        const [toLeft, toRight] = panGains(placement.pan);
        player.volume = 1;
        route.level.gain.value = level;
        route.left.gain.value = toLeft;
        route.right.gain.value = toRight;
      }
      if (player.paused) {
        const into = since + placement.trimStartSeconds;
        player.currentTime = placement.loop && player.duration > 0 ? into % player.duration : into;
        void player.play();
      }
    }
  }

  /** The cut or its media changed: show what is at the playhead now. */
  update(media: Media): void {
    this.media = media;
    if (!this.isPlaying) this.#apply(this.#offset, false);
  }

  play(): void {
    if (this.isPlaying) return;
    this.#startedAt = performance.now();
    this.notify.playing(true);
    this.#timer = setInterval(() => {
      const t = this.#offset + (performance.now() - this.#startedAt) / 1000;
      if (t >= this.media.cut.totalSeconds) {
        this.notify.ended?.();
        this.pause();
        this.seek(0);
        return;
      }
      this.notify.at(t);
      this.#apply(t, true);
    }, 100);
  }

  pause(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#offset += (performance.now() - this.#startedAt) / 1000;
    this.video?.pause();
    this.voice?.pause();
    for (const player of this.#players.values()) player.pause();
    this.notify.playing(false);
  }

  seek(seconds: number): void {
    const target = Math.max(0, Math.min(seconds, this.media.cut.totalSeconds));
    this.#offset = target;
    this.#startedAt = performance.now();
    this.#itemId = '';
    for (const player of this.#players.values()) player.pause();
    this.notify.at(target);
    this.#apply(target, this.isPlaying);
  }

  dispose(): void {
    this.pause();
    this.video = null;
    this.voice = null;
    this.#players.clear();
    this.#routes.clear();
    void this.#own?.context.close();
    this.#own = undefined;
  }
}

/** Everything needed to play one scene's cut: the cut, the shots it uses and the sounds. */
export async function loadCut(
  imp: ImpClient,
  projectId: string,
  sceneId: string,
  version: 'cut' | 'draft' = 'cut',
): Promise<{ cut: Cut; shots: Shot[]; sounds: Sound[] }> {
  const cut = Cut.parse(await runCommand(imp, 'movie.edit.get', { projectId, sceneId, version }));
  const sceneIds = [
    ...new Set([
      sceneId,
      ...cut.items.map((item) => item.sceneId),
      ...cut.sounds.map((placement) => placement.sceneId),
    ]),
  ].filter((id) => id !== '');
  const shots = (
    await Promise.all(
      sceneIds.map(async (id) =>
        Shots.parse(
          await runCommand(imp, 'movie.shot.list', { projectId, sceneId: id, full: true }),
        ).shots.filter((shot) => shot.sceneId === id),
      ),
    )
  ).flat();
  const sounds = Sounds.parse(
    await runCommand(imp, 'movie.sound.list', { projectId, sceneId, full: true }),
  ).sounds;
  return { cut: await withProcessedSound(imp, cut, { shots, sounds }), shots, sounds };
}

/** The processed copy of a sound with effects, or null to play it as recorded. */
async function processedKey(
  imp: ImpClient,
  key: string | undefined,
  effects: readonly unknown[],
): Promise<string | null> {
  if (key === undefined || effects.length === 0) return null;
  try {
    const output = await runCommand(imp, 'audio.fx.processed', { key, effects });
    return z.object({ key: z.string() }).parse(output).key;
  } catch {
    // A sound that cannot be processed here (such as clip sound without a decoder) plays as recorded.
    return null;
  }
}

/**
 * Points sounds with effects at their processed copies, so the Edit stage and
 * the film export hear what the audio editor plays. Each copy is rendered once.
 */
export async function withProcessedSound(imp: ImpClient, cut: Cut, source: Source): Promise<Cut> {
  const sounds = await Promise.all(
    cut.sounds.map(async (placement) => ({
      ...placement,
      playKey: await processedKey(
        imp,
        placementKey({ ...placement, playKey: null }, source),
        placement.effects,
      ),
    })),
  );
  const lines = await Promise.all(
    cut.lines.map(async (line) => ({
      ...line,
      playKey: await processedKey(imp, line.take?.blobKey, line.effects),
    })),
  );
  return { ...cut, sounds, lines };
}
