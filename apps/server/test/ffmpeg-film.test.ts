import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TEXT_STYLES, type FilmPlan } from '@imp/mode-movie';
import { afterAll, describe, expect, it } from 'vitest';
import { hasFfmpeg } from '../src/ffmpeg-audio.js';
import { createFfmpegFilmRenderer, drawPicture, parseClipInfo } from '../src/ffmpeg-film.js';

const require = createRequire(import.meta.url);
const font = (file: string): Uint8Array | undefined => {
  const pkg = file.startsWith('inter')
    ? '@fontsource/inter'
    : file.startsWith('instrument')
      ? '@fontsource/instrument-serif'
      : '@fontsource/courier-prime';
  try {
    return new Uint8Array(readFileSync(require.resolve(`${pkg}/files/${file}`)));
  } catch {
    return undefined;
  }
};

const installed = await hasFfmpeg();
const folder = mkdtempSync(join(tmpdir(), 'imp-film-test-'));
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** A clip of one colour, made by ffmpeg itself. */
function colourClip(name: string, colour: string, seconds: number): Uint8Array {
  const file = join(folder, `${name}.mp4`);
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=${colour}:s=320x180:r=24:d=${String(seconds)}`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-y',
    file,
  ]);
  return new Uint8Array(readFileSync(file));
}

/** The colour in the middle of the film at a time, read back with ffmpeg. */
function colourAt(file: string, seconds: number): [number, number, number] {
  const pixels = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-ss',
    seconds.toFixed(3),
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    'crop=8:8:(iw-8)/2:(ih-8)/2,scale=1:1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    'pipe:1',
  ]);
  return [pixels[0] ?? 0, pixels[1] ?? 0, pixels[2] ?? 0];
}

/** The brightest value in a band across the middle of the film at a time. */
function brightestAt(file: string, seconds: number): number {
  const pixels = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-ss',
    seconds.toFixed(3),
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    'crop=iw:20:0:(ih-20)/2',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    'pipe:1',
  ]);
  return Math.max(...pixels);
}

describe('clip descriptions from ffmpeg', () => {
  it('reads the size and rate of the first video stream, turned when the clip is', () => {
    const text = [
      '  Stream #0:0[0x1](und): Video: h264 (High), yuv420p(progressive), 1280x720 [SAR 1:1 DAR 16:9], 1210 kb/s, 23.98 fps, 24 tbr',
    ].join('\n');
    expect(parseClipInfo(text)).toEqual({ width: 1280, height: 720, fps: 23.98 });
    expect(parseClipInfo(`${text}\n      displaymatrix: rotation of -90.00 degrees`)).toEqual({
      width: 720,
      height: 1280,
      fps: 23.98,
    });
    expect(parseClipInfo('  Stream #0:0: Audio: aac')).toBeUndefined();
  });
});

describe('drawing a picture into a frame', () => {
  it('scales it smoothly and leaves what lies outside', () => {
    const frame = { width: 4, height: 2, data: new Uint8ClampedArray(4 * 2 * 4) };
    const picture = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]);
    drawPicture(frame, picture, 2, 1, { x: 0, y: 0, width: 4, height: 2 });
    expect(frame.data[0]).toBe(255);
    expect(frame.data[2]).toBe(0);
    expect(frame.data[3 * 4 + 2]).toBe(255);
  });
});

describe('rendering a film with ffmpeg', () => {
  it('says how to get ffmpeg when it is missing', () => {
    const renderer = createFfmpegFilmRenderer({ installed: false, font });
    expect(renderer.unavailable()).toMatch(/ffmpeg/);
  });

  it.skipIf(!installed)(
    'cuts, dissolves, fades and lays texts over the picture, with the sound',
    async () => {
      const red = colourClip('red', 'red', 2);
      const blue = colourClip('blue', 'blue', 2);
      const title = DEFAULT_TEXT_STYLES.find((style) => style.id === 'title');
      if (title === undefined) throw new Error('no title style');
      const plan: FilmPlan = {
        durationSeconds: 4,
        height: null,
        fps: null,
        pictures: [
          {
            kind: 'clip',
            startSeconds: 0,
            durationSeconds: 2,
            blobKey: 'red',
            sourceStartSeconds: 0,
            fadeInSeconds: 0,
            fadeOutSeconds: 0,
          },
          {
            kind: 'clip',
            startSeconds: 1.5,
            durationSeconds: 2,
            blobKey: 'blue',
            sourceStartSeconds: 0,
            fadeInSeconds: 0,
            fadeOutSeconds: 1,
            transitionIn: { kind: 'dissolve', seconds: 0.5 },
          },
        ],
        texts: [
          {
            startSeconds: 0,
            durationSeconds: 1,
            kind: 'title',
            text: 'Storm',
            style: { ...title, enter: 'cut', exit: 'cut' },
            x: null,
            y: null,
          },
        ],
      };
      const written: Buffer[] = [];
      let progress = 0;
      const rendered = await createFfmpegFilmRenderer({ installed: true, font }).render({
        plan,
        clip: (key) => Promise.resolve(key === 'red' ? red : key === 'blue' ? blue : undefined),
        mix: (_start, frames) => {
          const tone = new Float32Array(frames).map((_, i) => Math.sin(i / 10) * 0.2);
          return Promise.resolve([tone, tone] as const);
        },
        write: (data, position) => {
          written.push(Buffer.from(data));
          expect(position).toBe(written.slice(0, -1).reduce((sum, part) => sum + part.length, 0));
          return Promise.resolve();
        },
        progress: (seconds) => {
          progress = seconds;
        },
        cancelled: () => false,
      });
      expect(rendered).toMatchObject({ width: 320, height: 180, fps: 24, videoCodec: 'avc' });
      expect(progress).toBeCloseTo(4, 1);
      const file = join(folder, 'film.mp4');
      writeFileSync(file, Buffer.concat(written));
      const streams = execFileSync('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type',
        '-of',
        'csv=p=0',
        file,
      ]).toString();
      expect(streams).toContain('video');
      expect(streams).toContain('audio');
      // The title lies over the red clip at first: white letters in the middle.
      const [tr, tg, tb] = colourAt(file, 0.5);
      expect(tr).toBeGreaterThan(200);
      expect(tg + tb).toBeGreaterThan(150);
      // Red on its own, then halfway through the dissolve, then blue, then faded down to black.
      expect(colourAt(file, 1.2)[0]).toBeGreaterThan(200);
      const middle = colourAt(file, 1.75);
      expect(middle[0]).toBeGreaterThan(70);
      expect(middle[2]).toBeGreaterThan(70);
      expect(colourAt(file, 2.4)[2]).toBeGreaterThan(200);
      expect(colourAt(file, 2.4)[0]).toBeLessThan(40);
      const end = colourAt(file, 3.9);
      expect(Math.max(...end)).toBeLessThan(30);
    },
    60_000,
  );

  it.skipIf(!installed)(
    'shows stills, such as the key frames of an animatic, at the size of the picture',
    async () => {
      const png = join(folder, 'green.png');
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=green:s=640x360',
        '-frames:v',
        '1',
        '-y',
        png,
      ]);
      const green = new Uint8Array(readFileSync(png));
      const written: Buffer[] = [];
      const rendered = await createFfmpegFilmRenderer({ installed: true, font }).render({
        plan: {
          durationSeconds: 2,
          height: null,
          fps: null,
          pictures: [
            {
              kind: 'still',
              startSeconds: 0,
              durationSeconds: 2,
              blobKey: 'green',
              fadeInSeconds: 0,
              fadeOutSeconds: 0,
            },
          ],
        },
        clip: (key) => Promise.resolve(key === 'green' ? green : undefined),
        mix: (_start, frames) =>
          Promise.resolve([new Float32Array(frames), new Float32Array(frames)] as const),
        write: (data) => {
          written.push(Buffer.from(data));
          return Promise.resolve();
        },
        progress: () => undefined,
        cancelled: () => false,
      });
      expect(rendered).toMatchObject({ width: 640, height: 360 });
      const file = join(folder, 'still.mp4');
      writeFileSync(file, Buffer.concat(written));
      const [r, g, b] = colourAt(file, 1);
      expect(g).toBeGreaterThan(90);
      expect(r + b).toBeLessThan(60);
    },
    60_000,
  );

  it.skipIf(!installed)(
    'plays pieces backwards, wipes, punches in, grades, dips and shows title cards',
    async () => {
      // Red for its first second, blue for its second.
      const file = join(folder, 'red-blue.mp4');
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=320x180:r=24:d=1',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=320x180:r=24:d=1',
        '-filter_complex',
        '[0:v][1:v]concat=n=2:v=1[v]',
        '-map',
        '[v]',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-y',
        file,
      ]);
      const redBlue = new Uint8Array(readFileSync(file));
      const title = DEFAULT_TEXT_STYLES.find((style) => style.id === 'title');
      if (title === undefined) throw new Error('no title style');
      const plan: FilmPlan = {
        durationSeconds: 7,
        height: 180,
        fps: 24,
        pictures: [
          {
            // Backwards: blue first, then red.
            kind: 'clip',
            startSeconds: 0,
            durationSeconds: 2,
            blobKey: 'red-blue',
            sourceStartSeconds: 0,
            fadeInSeconds: 0,
            fadeOutSeconds: 0,
            timing: {
              sourceSeconds: 2,
              trimStartSeconds: 0,
              trimEndSeconds: 0,
              speed: 1,
              reverse: true,
              holdSeconds: 0,
            },
          },
          {
            // Wiped in from the left, punched in, graded to grey, dipping to white at its end.
            kind: 'clip',
            startSeconds: 1.5,
            durationSeconds: 2.5,
            blobKey: 'red-blue',
            sourceStartSeconds: 0,
            fadeInSeconds: 0,
            fadeOutSeconds: 0,
            transitionIn: { kind: 'wipe', seconds: 1 },
            dipOut: { color: 'white', seconds: 1 },
            punch: { zoom: 2, zoomTo: 2.5, focusX: 0.5, focusY: 0.5 },
            matrix: [
              0.33, 0.33, 0.33, 0, 0, 0.33, 0.33, 0.33, 0, 0, 0.33, 0.33, 0.33, 0, 0, 0, 0, 0, 1, 0,
            ],
          },
          {
            kind: 'title',
            startSeconds: 4,
            durationSeconds: 2,
            text: 'The End',
            style: title,
            fadeInSeconds: 0,
            fadeOutSeconds: 0,
          },
          {
            // A clip that is gone shows black rather than stopping the film.
            kind: 'clip',
            startSeconds: 6,
            durationSeconds: 1,
            blobKey: 'missing',
            sourceStartSeconds: 0,
            fadeInSeconds: 0,
            fadeOutSeconds: 0,
          },
        ],
      };
      const written: Buffer[] = [];
      await createFfmpegFilmRenderer({ installed: true, font }).render({
        plan,
        clip: (key) => Promise.resolve(key === 'red-blue' ? redBlue : undefined),
        mix: (_start, frames) =>
          Promise.resolve([new Float32Array(frames), new Float32Array(frames)] as const),
        write: (data) => {
          written.push(Buffer.from(data));
          return Promise.resolve();
        },
        progress: () => undefined,
        cancelled: () => false,
      });
      const film = join(folder, 'second.mp4');
      writeFileSync(film, Buffer.concat(written));
      const first = colourAt(film, 0.3);
      expect(first[2]).toBeGreaterThan(200);
      expect(first[0]).toBeLessThan(40);
      expect(colourAt(film, 1.3)[0]).toBeGreaterThan(200);
      // After the wipe: grey, from the grade.
      const grey = colourAt(film, 2.7);
      expect(Math.abs(grey[0] - grey[2])).toBeLessThan(30);
      expect(grey[0]).toBeGreaterThan(40);
      // Into the white dip.
      expect(Math.min(...colourAt(film, 3.95))).toBeGreaterThan(150);
      // The title card: light letters in the middle of black.
      expect(brightestAt(film, 5)).toBeGreaterThan(150);
      expect(Math.max(...colourAt(film, 6.5))).toBeLessThan(20);
    },
    60_000,
  );

  it.skipIf(!installed)('stops when the render is cancelled', async () => {
    const red = colourClip('red2', 'red', 2);
    await expect(
      createFfmpegFilmRenderer({ installed: true, font }).render({
        plan: {
          durationSeconds: 2,
          height: null,
          fps: null,
          pictures: [
            {
              kind: 'clip',
              startSeconds: 0,
              durationSeconds: 2,
              blobKey: 'red',
              sourceStartSeconds: 0,
              fadeInSeconds: 0,
              fadeOutSeconds: 0,
            },
          ],
        },
        clip: () => Promise.resolve(red),
        mix: (_start, frames) =>
          Promise.resolve([new Float32Array(frames), new Float32Array(frames)] as const),
        write: () => Promise.resolve(),
        progress: () => undefined,
        cancelled: () => true,
      }),
    ).rejects.toThrow(/cancelled/);
  });
});
