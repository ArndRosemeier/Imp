import type { ImpClient } from '@imp/host';
import { placePicture, TextStyle } from '@imp/mode-movie';
import { z } from 'zod';
import { drawLane, type LaneText } from '../host/text-draw.js';
import { loadTextFonts } from '../host/text-fonts.js';
import { wrapLines } from '../host/title-lines.js';
import { runCommand } from './context.js';
import { blobKeys, CutPlayer, HIDDEN, loadCut, type Look, type ScreenLook } from './cut-player.js';

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;

const FORMATS = [
  { mimeType: 'video/mp4;codecs=avc1.640028,mp4a.40.2', extension: 'mp4' },
  { mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', extension: 'mp4' },
  { mimeType: 'video/webm;codecs=vp9,opus', extension: 'webm' },
  { mimeType: 'video/webm', extension: 'webm' },
] as const;

export interface Format {
  mimeType: string;
  extension: 'mp4' | 'webm';
}

/** The best video format this browser can record, or null when it cannot record at all. */
export function recordingFormat(): Format | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return FORMATS.find((format) => MediaRecorder.isTypeSupported(format.mimeType)) ?? null;
}

export interface Progress {
  scene: number;
  scenes: number;
  seconds: number;
  totalSeconds: number;
}

export { wrapLines };

export interface Recording {
  blob: Blob;
  extension: 'mp4' | 'webm';
  seconds: number;
}

/** What lies over the picture: the texts of the scene being recorded, and the time in it. */
interface Overlay {
  texts: readonly LaneText[];
  styles: readonly TextStyle[];
  seconds: number;
}

/** Draws one screen of the editor's engine as the preview shows it: faded, wiped on and zoomed. */
function drawScreen(
  g: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  screen: ScreenLook,
): void {
  if (screen.opacity <= 0 || video.readyState < 2 || video.videoWidth <= 0) return;
  if (video.videoHeight <= 0) return;
  // Fitted whole and zoomed on its focus, as the offline export draws it.
  const at = placePicture(
    WIDTH,
    HEIGHT,
    video.videoWidth,
    video.videoHeight,
    screen.zoom?.scale ?? 1,
    screen.zoom?.focusX ?? 0.5,
    screen.zoom?.focusY ?? 0.5,
  );
  g.save();
  if (screen.wipe !== null) {
    g.beginPath();
    g.rect(0, 0, WIDTH * screen.wipe, HEIGHT);
    g.clip();
  }
  g.globalAlpha = Math.min(1, screen.opacity);
  g.drawImage(video, at.x, at.y, at.width, at.height);
  g.restore();
}

function paint(
  g: CanvasRenderingContext2D,
  videos: readonly [HTMLVideoElement, HTMLVideoElement],
  look: Look,
  overlay: Overlay,
): void {
  g.globalAlpha = 1;
  g.fillStyle = '#000';
  g.fillRect(0, 0, WIDTH, HEIGHT);
  if (!look.card) {
    const screens: readonly ScreenLook[] = look.screens ?? [
      {
        opacity: look.brightness,
        wipe: null,
        front: true,
        ...(look.zoom === undefined ? {} : { zoom: look.zoom }),
      },
      HIDDEN,
    ];
    // The screen behind first, then the one coming in over it.
    for (const slot of screens[0]?.front === true ? [1, 0] : [0, 1]) {
      const screen = screens[slot];
      const video = videos[slot];
      if (screen !== undefined && video !== undefined) drawScreen(g, video, screen);
    }
  }
  // A dip to white lies over the picture; the texts stay readable on it, as in the offline export.
  if ((look.white ?? 0) > 0) {
    g.globalAlpha = Math.min(1, look.white ?? 0);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, WIDTH, HEIGHT);
    g.globalAlpha = 1;
  }
  // The same drawing as the preview and the offline export.
  drawLane(g, {
    ...overlay,
    width: WIDTH,
    height: HEIGHT,
    card: look.card ? { title: look.title, brightness: look.brightness } : null,
  });
}

/**
 * Records the cuts of the given scenes, one after the other, into one video.
 * The editor's own engine plays them, in real time: every media element is
 * routed into one audio graph, the picture is drawn onto a canvas, and a
 * MediaRecorder captures both. Nothing is uploaded; the tab must stay visible
 * while it runs.
 */
export async function recordScenes(
  imp: ImpClient,
  projectId: string,
  sceneIds: readonly string[],
  onProgress: (progress: Progress) => void,
  signal: AbortSignal,
): Promise<Recording> {
  const format = recordingFormat();
  if (format === null) throw new Error('This browser cannot record video.');
  const loaded = (
    await Promise.all(sceneIds.map(async (sceneId) => loadCut(imp, projectId, sceneId)))
  ).filter((scene) => scene.cut.totalSeconds > 0);
  if (loaded.length === 0) throw new Error('There is nothing in the cut to export yet.');
  const totalSeconds = loaded.reduce((sum, scene) => sum + scene.cut.totalSeconds, 0);

  const made: string[] = [];
  const urls = new Map<string, string>();
  const keys = new Set(loaded.flatMap((scene) => blobKeys(scene, scene.cut)));
  for (const key of keys) {
    const blob = await imp.blob(key);
    if (blob === undefined) continue;
    const url = URL.createObjectURL(new Blob([blob.bytes.slice()], { type: blob.mediaType }));
    made.push(url);
    urls.set(key, url);
  }

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const g = canvas.getContext('2d');
  if (g === null) throw new Error('This browser cannot draw the picture for the video.');
  // Two screens and two voices, as in the preview, for pieces that dissolve or wipe into each other.
  const screen = (): HTMLVideoElement => {
    const element = document.createElement('video');
    element.playsInline = true;
    element.preload = 'auto';
    return element;
  };
  const videos = [screen(), screen()] as const;
  const voices = [new Audio(), new Audio()] as const;
  const audio = new AudioContext();
  await audio.resume();
  const destination = audio.createMediaStreamDestination();
  const routed = new WeakSet<HTMLMediaElement>();
  const tap = (element: HTMLMediaElement): void => {
    if (routed.has(element)) return;
    routed.add(element);
    audio.createMediaElementSource(element).connect(destination);
  };
  for (const element of [...videos, ...voices]) tap(element);

  const stream = canvas.captureStream(FPS);
  for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
  const recorder = new MediaRecorder(stream, {
    mimeType: format.mimeType,
    videoBitsPerSecond: 8_000_000,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => {
      resolve();
    };
  });

  await loadTextFonts();
  const { styles } = z
    .object({ styles: z.array(TextStyle) })
    .parse(await runCommand(imp, 'movie.edit.text.style.list', { projectId }));
  let look: Look = { brightness: 0, title: '', card: false };
  let overlay: Overlay = { texts: [], styles, seconds: 0 };
  const drawing = setInterval(() => {
    paint(g, videos, look, { ...overlay, seconds: player?.now ?? overlay.seconds });
  }, 1000 / FPS);
  let player: CutPlayer | undefined;
  try {
    recorder.start(1000);
    let before = 0;
    for (const [index, scene] of loaded.entries()) {
      if (signal.aborted) break;
      const offset = before;
      overlay = { texts: scene.cut.texts, styles, seconds: 0 };
      await new Promise<void>((resolve) => {
        const current = new CutPlayer(
          {
            cut: scene.cut,
            source: { shots: scene.shots, sounds: scene.sounds },
            urls,
          },
          {
            at: (seconds) => {
              onProgress({
                scene: index + 1,
                scenes: loaded.length,
                seconds: offset + seconds,
                totalSeconds,
              });
            },
            playing: () => undefined,
            look: (next) => {
              look = next;
            },
            ended: resolve,
          },
          { context: audio, destination },
        );
        player = current;
        current.attach(videos[0], voices[0]);
        current.attach(videos[1], voices[1], 1);
        signal.addEventListener('abort', () => {
          resolve();
        });
        current.seek(0);
        current.play();
      });
      player?.dispose();
      before += scene.cut.totalSeconds;
    }
  } finally {
    clearInterval(drawing);
    player?.dispose();
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    for (const track of stream.getTracks()) track.stop();
    await audio.close();
    for (const url of made) URL.revokeObjectURL(url);
  }
  if (signal.aborted) throw new Error('Export cancelled.');
  return {
    blob: new Blob(chunks, { type: format.mimeType.split(';')[0] ?? 'video/webm' }),
    extension: format.extension,
    seconds: totalSeconds,
  };
}

/** Hands a file to the browser's download. */
export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}
