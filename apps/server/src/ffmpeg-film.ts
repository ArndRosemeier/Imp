import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseFormat, drawText, drawTexts } from '@imp/host/film';
import {
  applyMatrix,
  placePicture,
  shadeAt,
  sourceTime,
  transitionShare,
  zoomAt,
  type FilmPicture,
  type FilmRenderer,
  type FilmRenderJob,
  type FilmRendered,
} from '@imp/mode-movie';
import { FontBook, FrameTextCanvas, type Frame } from './text-canvas.js';

/**
 * Renders films on the local server: ffmpeg decodes the clips and encodes the
 * film, and every frame in between is put together here, the way the browser
 * puts it together on a canvas (fades, dips, dissolves, wipes, punch-ins,
 * grades and the text lane), so a film comes out the same from either host.
 */

/** The engine's sound: 48 kHz stereo, as @imp/audio mixes it. */
const RATE = 48_000;
const AUDIO_BLOCK = RATE / 2;

class Cancelled extends Error {
  constructor() {
    super('The render was cancelled.');
  }
}

/** Runs a command to its end and gives what it wrote on stderr. */
function run(
  command: string,
  args: readonly string[],
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stderr });
    });
  });
}

/** What ffmpeg says about the picture of a clip: its size as shown and its frame rate. */
export interface ClipInfo {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
}

/** Reads the first video stream from ffmpeg's description of a file; undefined when there is none. */
export function parseClipInfo(stderr: string): ClipInfo | undefined {
  const line = stderr.split('\n').find((candidate) => /Stream #.*Video:/.test(candidate));
  if (line === undefined) return undefined;
  const size = /\b(\d{2,5})x(\d{2,5})\b/.exec(line);
  if (size === null) return undefined;
  const rate = /([\d.]+) fps/.exec(line) ?? /([\d.]+) tbr/.exec(line);
  let width = Number(size[1]);
  let height = Number(size[2]);
  // A phone clip filmed upright is stored on its side and turned when shown; ffmpeg turns it too.
  const rotation = /rotation of (-?[\d.]+)/.exec(stderr);
  if (rotation !== null && Math.abs(Number(rotation[1])) % 180 === 90)
    [width, height] = [height, width];
  return { width, height, fps: rate === null ? 30 : Number(rate[1]) || 30 };
}

/**
 * Raw frames from a child's output, one at a time. The child is paused while
 * a few frames wait, so a long clip never piles up in memory.
 */
class FrameReader {
  readonly #chunks: Buffer[] = [];
  #buffered = 0;
  #ended = false;
  #wake: (() => void) | undefined;

  constructor(
    private readonly child: ChildProcess,
    private readonly frameBytes: number,
  ) {
    const out = child.stdout;
    if (out === null) throw new Error('ffmpeg gave no output.');
    out.on('data', (chunk: Buffer) => {
      this.#chunks.push(chunk);
      this.#buffered += chunk.length;
      if (this.#buffered > frameBytes * 3) out.pause();
      this.#wake?.();
    });
    out.on('end', () => {
      this.#ended = true;
      this.#wake?.();
    });
    child.on('error', () => {
      this.#ended = true;
      this.#wake?.();
    });
  }

  /** The next frame, or undefined at the end of the clip. */
  async next(): Promise<Uint8Array | undefined> {
    while (this.#buffered < this.frameBytes && !this.#ended) {
      this.child.stdout?.resume();
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
    }
    if (this.#buffered < this.frameBytes) return undefined;
    const frame = new Uint8Array(this.frameBytes);
    let filled = 0;
    while (filled < this.frameBytes) {
      const chunk = this.#chunks[0];
      if (chunk === undefined) break;
      const take = Math.min(chunk.length, this.frameBytes - filled);
      frame.set(chunk.subarray(0, take), filled);
      filled += take;
      if (take === chunk.length) this.#chunks.shift();
      else this.#chunks[0] = chunk.subarray(take);
    }
    this.#buffered -= this.frameBytes;
    if (this.#buffered <= this.frameBytes * 3) this.child.stdout?.resume();
    return frame;
  }

  stop(): void {
    this.child.stdout?.destroy();
    this.child.kill('SIGKILL');
  }
}

/**
 * The frames of a clip at the times a picture shows, in order. Times that only
 * rise (or hold) are read from one forward pass; times that only fall (a
 * reversed piece) from one pass ffmpeg plays backwards. Each time gets the
 * frame of the clip that is on screen at it.
 */
class ClipFrames {
  #reader: FrameReader | undefined;
  #index = -1;
  #current: Uint8Array | undefined;
  readonly #start: number;
  readonly #backwards: boolean;

  constructor(
    command: string,
    file: string,
    readonly info: ClipInfo,
    private readonly times: readonly number[],
  ) {
    const first = times[0] ?? 0;
    const last = times[times.length - 1] ?? first;
    this.#backwards = last < first;
    const low = Math.max(0, Math.min(...times));
    const high = Math.max(...times);
    this.#start = this.#backwards ? high : low;
    const frameSeconds = 1 / info.fps;
    const args = [
      '-nostdin',
      '-v',
      'error',
      '-ss',
      low.toFixed(4),
      '-t',
      // Backwards, the pass must end on the frame shown at the latest time, which then comes first.
      (high - low + frameSeconds * (this.#backwards ? 0.5 : 2)).toFixed(4),
      '-i',
      file,
      '-an',
      ...(this.#backwards ? ['-vf', 'reverse'] : []),
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      'pipe:1',
    ];
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    this.#reader = new FrameReader(child, info.width * info.height * 4);
  }

  /** The frame for the next time of the picture. */
  async next(time: number): Promise<Uint8Array | undefined> {
    const offset = this.#backwards ? this.#start - time : time - this.#start;
    const wanted = Math.max(0, Math.floor(offset * this.info.fps + 1e-6));
    while (this.#index < wanted && this.#reader !== undefined) {
      const frame = await this.#reader.next();
      if (frame === undefined) {
        // The clip ended: its last frame stays on screen.
        this.#reader = undefined;
        break;
      }
      this.#current = frame;
      this.#index++;
    }
    return this.#current;
  }

  close(): void {
    this.#reader?.stop();
    this.#reader = undefined;
  }
}

/** Draws a picture into a frame, scaled smoothly, clipped to the frame. */
export function drawPicture(
  into: Frame,
  picture: Uint8Array,
  pictureWidth: number,
  pictureHeight: number,
  at: { x: number; y: number; width: number; height: number },
): void {
  const { data, width, height } = into;
  const x0 = Math.max(0, Math.floor(at.x));
  const y0 = Math.max(0, Math.floor(at.y));
  const x1 = Math.min(width, Math.ceil(at.x + at.width));
  const y1 = Math.min(height, Math.ceil(at.y + at.height));
  const sx = pictureWidth / at.width;
  const sy = pictureHeight / at.height;
  const maxX = pictureWidth - 1;
  const maxY = pictureHeight - 1;
  for (let y = y0; y < y1; y++) {
    const fy = Math.min(maxY, Math.max(0, (y + 0.5 - at.y) * sy - 0.5));
    const row0 = Math.floor(fy);
    const row1 = Math.min(maxY, row0 + 1);
    const wy = fy - row0;
    let target = (y * width + x0) * 4;
    for (let x = x0; x < x1; x++, target += 4) {
      const fx = Math.min(maxX, Math.max(0, (x + 0.5 - at.x) * sx - 0.5));
      const col0 = Math.floor(fx);
      const col1 = Math.min(maxX, col0 + 1);
      const wx = fx - col0;
      const a = (row0 * pictureWidth + col0) * 4;
      const b = (row0 * pictureWidth + col1) * 4;
      const c = (row1 * pictureWidth + col0) * 4;
      const d = (row1 * pictureWidth + col1) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const top = (picture[a + channel] ?? 0) * (1 - wx) + (picture[b + channel] ?? 0) * wx;
        const bottom = (picture[c + channel] ?? 0) * (1 - wx) + (picture[d + channel] ?? 0) * wx;
        data[target + channel] = top * (1 - wy) + bottom * wy;
      }
      data[target + 3] = 255;
    }
  }
}

function fill(frame: Frame, r: number, g: number, b: number, alpha: number): void {
  const { data } = frame;
  if (alpha >= 1) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
    return;
  }
  const keep = 1 - alpha;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (data[i] ?? 0) * keep + r * alpha;
    data[i + 1] = (data[i + 1] ?? 0) * keep + g * alpha;
    data[i + 2] = (data[i + 2] ?? 0) * keep + b * alpha;
  }
}

/** Lays one frame over another: all of it at a share (a dissolve), or its left part (a wipe). */
function lay(onto: Frame, from: Frame, share: number, wipe: boolean): void {
  const { data, width, height } = onto;
  const source = from.data;
  if (wipe && share < 1) {
    const edge = Math.round(width * share);
    for (let y = 0; y < height; y++) {
      const start = y * width * 4;
      data.set(source.subarray(start, start + edge * 4), start);
    }
    return;
  }
  if (share >= 1) {
    data.set(source);
    return;
  }
  const keep = 1 - share;
  for (let i = 0; i < data.length; i++) data[i] = (data[i] ?? 0) * keep + (source[i] ?? 0) * share;
}

/** Writes to a stream, waiting while it is full. */
function writeTo(child: ChildProcess, bytes: Uint8Array): Promise<void> {
  const input = child.stdin;
  if (input === null) return Promise.reject(new Error('ffmpeg took no input.'));
  return new Promise((resolve, reject) => {
    const done = (error?: Error | null): void => {
      if (error) reject(error);
    };
    if (input.write(bytes, done)) resolve();
    else input.once('drain', resolve);
  });
}

export interface FfmpegFilmOptions {
  /** The ffmpeg to run, or a function that says which one now, or null while there is none. */
  readonly command?: string | (() => string | null);
  /** Whether ffmpeg is installed; the renderer says how to get it when not. Default true. */
  readonly installed?: boolean;
  /** Reads one of the font files Imp ships, by name. */
  readonly font: (file: string) => Uint8Array | undefined;
}

/** The video encoder this ffmpeg has: H.264 by x264 where it can, MPEG-4 Part 2 otherwise. */
async function videoEncoder(command: string): Promise<{ args: string[]; codec: string }> {
  const { stderr, code } = await run(command, ['-hide_banner', '-h', 'encoder=libx264']);
  return code === 0 && !stderr.includes('Unknown encoder')
    ? {
        args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p'],
        codec: 'avc',
      }
    : { args: ['-c:v', 'mpeg4', '-q:v', '2', '-pix_fmt', 'yuv420p'], codec: 'mpeg4' };
}

export function createFfmpegFilmRenderer(options: FfmpegFilmOptions): FilmRenderer {
  const current = (): string | null =>
    options.installed === false
      ? null
      : typeof options.command === 'function'
        ? options.command()
        : (options.command ?? 'ffmpeg');
  const book = new FontBook(options.font);
  const missing =
    'Imp on this computer renders films with ffmpeg, which it does not have yet. Download it under Settings, Where Imp runs (or with system.ffmpeg.install), or install it from https://ffmpeg.org/. Until then the Edit screen records films in the browser instead.';

  async function render(job: FilmRenderJob): Promise<FilmRendered> {
    const command = current();
    if (command === null) throw new Error(missing);
    const { plan } = job;
    const pictures = [...plan.pictures].sort((a, b) => a.startSeconds - b.startSeconds);
    const folder = await mkdtemp(join(tmpdir(), 'imp-film-'));
    const check = (): void => {
      if (job.cancelled()) throw new Cancelled();
    };
    try {
      // The clips as files (ffmpeg seeks in files, not pipes), and what each one is.
      const clips = new Map<string, { file: string; info: ClipInfo }>();
      const probed: { width: number; height: number; fps: number; seconds: number }[] = [];
      for (const key of new Set(pictures.flatMap((p) => (p.kind === 'clip' ? [p.blobKey] : [])))) {
        const bytes = await job.clip(key);
        if (bytes === undefined) continue;
        const file = join(folder, `clip-${String(clips.size)}`);
        await writeFile(file, bytes);
        const info = parseClipInfo((await run(command, ['-hide_banner', '-i', file])).stderr);
        if (info === undefined) continue;
        clips.set(key, { file, info });
        probed.push({
          ...info,
          seconds: pictures
            .filter((p) => p.kind === 'clip' && p.blobKey === key)
            .reduce((sum, p) => sum + p.durationSeconds, 0),
        });
      }
      const { width, height, fps } = chooseFormat(probed, plan.height, plan.fps);

      // The sound first, whole, as a raw file the encoder reads beside the picture.
      const soundFile = join(folder, 'sound.f32');
      const totalSamples = Math.round(plan.durationSeconds * RATE);
      const sound = await open(soundFile, 'w');
      try {
        for (let done = 0; done < totalSamples; done += AUDIO_BLOCK) {
          check();
          const count = Math.min(AUDIO_BLOCK, totalSamples - done);
          const [left, right] = await job.mix(done, count);
          const interleaved = new Float32Array(count * 2);
          for (let i = 0; i < count; i++) {
            interleaved[i * 2] = left[i] ?? 0;
            interleaved[i * 2 + 1] = right[i] ?? 0;
          }
          await sound.write(new Uint8Array(interleaved.buffer));
        }
      } finally {
        await sound.close();
      }

      const video = await videoEncoder(command);
      const outFile = join(folder, 'film.mp4');
      const encoder = spawn(
        command,
        [
          '-nostdin',
          '-v',
          'error',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgba',
          '-s',
          `${String(width)}x${String(height)}`,
          '-r',
          String(fps),
          '-i',
          'pipe:0',
          '-f',
          'f32le',
          '-ar',
          String(RATE),
          '-ac',
          '2',
          '-i',
          soundFile,
          '-map',
          '0:v',
          '-map',
          '1:a',
          ...video.args,
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-movflags',
          '+faststart',
          '-y',
          outFile,
        ],
        { stdio: ['pipe', 'ignore', 'pipe'] },
      );
      let encoderError = '';
      encoder.stderr.on('data', (chunk: Buffer) => {
        encoderError += chunk.toString();
      });
      const encoded = new Promise<number | null>((resolve, reject) => {
        encoder.on('error', reject);
        encoder.on('close', resolve);
      });

      const frame: Frame = { width, height, data: new Uint8ClampedArray(width * height * 4) };
      const scratch: Frame = { width, height, data: new Uint8ClampedArray(width * height * 4) };
      const onFrame = new FrameTextCanvas(frame, book);
      const onScratch = new FrameTextCanvas(scratch, book);
      const texts = plan.texts ?? [];
      const totalFrames = Math.max(1, Math.round(plan.durationSeconds * fps));

      interface Layer {
        readonly picture: FilmPicture;
        readonly end: number;
        readonly frames?: ClipFrames;
      }
      const openLayer = (picture: FilmPicture, first: number, end: number): Layer => {
        if (picture.kind === 'title') return { picture, end };
        const clip = clips.get(picture.blobKey);
        if (clip === undefined) return { picture, end };
        const timing = picture.timing ?? {
          sourceSeconds: picture.sourceStartSeconds + picture.durationSeconds,
          trimStartSeconds: picture.sourceStartSeconds,
          trimEndSeconds: 0,
          speed: 1,
          reverse: false,
          holdSeconds: 0,
        };
        const times = Array.from({ length: Math.max(1, end - first) }, (_, i) =>
          sourceTime(timing, (first + i) / fps - picture.startSeconds),
        );
        return { picture, end, frames: new ClipFrames(command, clip.file, clip.info, times) };
      };

      const paint = async (on: Layer, t: number): Promise<void> => {
        const { picture } = on;
        const since = t - picture.startSeconds;
        fill(scratch, 0, 0, 0, 1);
        if (picture.kind === 'title') {
          drawText(
            onScratch,
            {
              kind: 'title',
              text: picture.text,
              style: { ...picture.style, enter: 'cut', exit: 'cut', roll: false },
              startSeconds: 0,
              durationSeconds: picture.durationSeconds,
              x: null,
              y: null,
            },
            0,
            width,
            height,
          );
        } else if (on.frames !== undefined) {
          const timing = picture.timing;
          const sourceAt =
            timing === undefined
              ? picture.sourceStartSeconds + Math.max(0, since)
              : sourceTime(timing, since);
          const pixels = await on.frames.next(sourceAt);
          if (pixels !== undefined) {
            const punch = picture.punch ?? { zoom: 1, zoomTo: null, focusX: 0.5, focusY: 0.5 };
            const zoom = zoomAt(
              punch,
              picture.durationSeconds > 0 ? since / picture.durationSeconds : 0,
            );
            const { info } = on.frames;
            const at = placePicture(
              width,
              height,
              info.width,
              info.height,
              zoom,
              punch.focusX,
              punch.focusY,
            );
            drawPicture(scratch, pixels, info.width, info.height, at);
            if (picture.matrix !== undefined) applyMatrix(scratch.data, picture.matrix);
          }
        }
        const shade = shadeAt(
          {
            fadeInSeconds: picture.fadeInSeconds,
            fadeOutSeconds: picture.fadeOutSeconds,
            dipIn: picture.dipIn ?? null,
            dipOut: picture.dipOut ?? null,
          },
          since,
          picture.durationSeconds,
        );
        if (shade.black > 0) fill(scratch, 0, 0, 0, shade.black);
        if (shade.white > 0) fill(scratch, 255, 255, 255, shade.white);
      };

      const layers: Layer[] = [];
      try {
        let next = 0;
        for (let index = 0; index < totalFrames; index++) {
          while (next < pictures.length) {
            const picture = pictures[next];
            if (picture === undefined) break;
            const first = Math.round(picture.startSeconds * fps);
            if (first > index) break;
            next++;
            const end = Math.min(
              totalFrames,
              Math.round((picture.startSeconds + picture.durationSeconds) * fps),
            );
            if (end > index) layers.push(openLayer(picture, index, end));
          }
          const t = index / fps;
          fill(frame, 0, 0, 0, 1);
          for (const on of layers) {
            await paint(on, t);
            const into = on.picture.transitionIn;
            const share =
              into === undefined ? 1 : transitionShare(into.seconds, t - on.picture.startSeconds);
            lay(frame, scratch, share, into?.kind === 'wipe');
          }
          // The text lane lies over everything, fades to black included.
          drawTexts(onFrame, texts, t, width, height);
          // A copy: the pipe may still hold the bytes while the next frame is drawn.
          await writeTo(encoder, new Uint8Array(frame.data));
          job.progress((index + 1) / fps);
          check();
          for (const on of layers.filter((candidate) => candidate.end <= index + 1)) {
            on.frames?.close();
            layers.splice(layers.indexOf(on), 1);
          }
        }
        encoder.stdin.end();
        const code = await encoded;
        if (code !== 0)
          throw new Error(`ffmpeg could not encode the film: ${encoderError.trim().slice(-300)}`);
      } catch (error) {
        for (const on of layers) on.frames?.close();
        encoder.kill('SIGKILL');
        throw error;
      }

      // The finished file, into the store in pieces.
      let position = 0;
      for await (const chunk of createReadStream(outFile, { highWaterMark: 4 * 1024 * 1024 })) {
        const bytes = chunk as Buffer;
        await job.write(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), position);
        position += bytes.byteLength;
      }
      return {
        mediaType: 'video/mp4',
        extension: 'mp4',
        videoCodec: video.codec,
        audioCodec: 'aac',
        width,
        height,
        fps,
      };
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  return {
    unavailable: () => (current() === null ? missing : null),
    render,
  };
}
