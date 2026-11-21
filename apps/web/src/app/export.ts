import type { ImpClient } from '@imp/host';
import { wrapLines } from '../host/title-lines.js';
import { blobKeys, CutPlayer, loadCut, type Look } from './cut-player.js';

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

function paint(g: CanvasRenderingContext2D, video: HTMLVideoElement, look: Look): void {
  g.globalAlpha = 1;
  g.fillStyle = '#000';
  g.fillRect(0, 0, WIDTH, HEIGHT);
  if (look.title !== '') {
    g.globalAlpha = look.brightness;
    g.fillStyle = '#fff';
    g.font = '600 56px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const lines = wrapLines(look.title, (line) => g.measureText(line).width < WIDTH * 0.8);
    const top = HEIGHT / 2 - ((lines.length - 1) * 70) / 2;
    lines.forEach((line, index) => {
      g.fillText(line, WIDTH / 2, top + index * 70);
    });
    g.globalAlpha = 1;
    return;
  }
  if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
    const scale = Math.min(WIDTH / video.videoWidth, HEIGHT / video.videoHeight);
    const w = video.videoWidth * scale;
    const h = video.videoHeight * scale;
    g.drawImage(video, (WIDTH - w) / 2, (HEIGHT - h) / 2, w, h);
  }
  if (look.brightness < 1) {
    g.fillStyle = `rgba(0, 0, 0, ${String(1 - look.brightness)})`;
    g.fillRect(0, 0, WIDTH, HEIGHT);
  }
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
  const video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'auto';
  const voice = new Audio();
  const audio = new AudioContext();
  await audio.resume();
  const destination = audio.createMediaStreamDestination();
  const routed = new WeakSet<HTMLMediaElement>();
  const tap = (element: HTMLMediaElement): void => {
    if (routed.has(element)) return;
    routed.add(element);
    audio.createMediaElementSource(element).connect(destination);
  };
  tap(video);
  tap(voice);

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

  let look: Look = { brightness: 0, title: '' };
  const drawing = setInterval(() => {
    paint(g, video, look);
  }, 1000 / FPS);
  let player: CutPlayer | undefined;
  try {
    recorder.start(1000);
    let before = 0;
    for (const [index, scene] of loaded.entries()) {
      if (signal.aborted) break;
      const offset = before;
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
        current.attach(video, voice);
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
