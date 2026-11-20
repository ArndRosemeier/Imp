import type { ImpClient } from '@imp/host';
import { Shot, Sound } from '@imp/mode-movie';
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
});
export type Cut = z.infer<typeof Cut>;

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
  if (placement.source === 'sound') {
    return source.sounds.find((sound) => sound.id === placement.soundId)?.take?.blobKey;
  }
  const shot = source.shots.find((candidate) => candidate.id === placement.shotId);
  return placement.source === 'clip' ? (shot?.clip?.blobKey ?? undefined) : shot?.dialogue?.blobKey;
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
  ].filter((key): key is string => typeof key === 'string');
}

export interface Look {
  brightness: number;
  title: string;
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

  constructor(
    media: Media,
    private readonly notify: {
      at: (seconds: number) => void;
      playing: (playing: boolean) => void;
      look: (look: Look) => void;
      /** The cut played to its end (it then rewinds). */
      ended?: () => void;
    },
    /** Called with each sound element the player makes, so a recording can route it. */
    private readonly tap?: (element: HTMLAudioElement) => void,
  ) {
    this.media = media;
  }

  attach(video: HTMLVideoElement | null, voice: HTMLAudioElement | null): void {
    if (video !== null) this.video = video;
    if (voice !== null) this.voice = voice;
  }

  get isPlaying(): boolean {
    return this.#timer !== undefined;
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
      this.notify.look({ brightness: 0, title: '' });
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
        this.notify.look({ brightness, title: item.text });
      } else {
        this.notify.look({ brightness, title: '' });
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
      ...cut.lines.map((line) => ({ placement: linePlacement(line), key: line.take?.blobKey })),
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
        this.tap?.(player);
        this.#players.set(placement.id, player);
      }
      player.loop = placement.loop;
      const since = t - placement.startSeconds;
      if (since < 0) {
        player.pause();
        continue;
      }
      const length = placement.loop
        ? cut.totalSeconds - placement.startSeconds
        : player.duration - placement.trimStartSeconds;
      if (Number.isFinite(length) && since > length) {
        player.pause();
        continue;
      }
      const up = placement.fadeInSeconds > 0 ? Math.min(1, since / placement.fadeInSeconds) : 1;
      const down =
        placement.fadeOutSeconds > 0 && Number.isFinite(length)
          ? Math.min(1, (length - since) / placement.fadeOutSeconds)
          : 1;
      player.volume = Math.max(0, Math.min(1, placement.volume * up * down));
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
  }
}

/** Everything needed to play one scene's cut: the cut, the shots it uses and the sounds. */
export async function loadCut(
  imp: ImpClient,
  projectId: string,
  sceneId: string,
): Promise<{ cut: Cut; shots: Shot[]; sounds: Sound[] }> {
  const cut = Cut.parse(await runCommand(imp, 'movie.edit.get', { projectId, sceneId }));
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
  return { cut, shots, sounds };
}
