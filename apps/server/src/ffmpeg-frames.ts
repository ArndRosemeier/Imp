import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { colorStats, type ColorSampler, type FrameGrabber } from '@imp/host';

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

/**
 * Takes stills from a clip with the ffmpeg installed on this computer, one
 * JPEG per time, scaled to the width asked for. A time ffmpeg cannot reach,
 * such as one past the end, gives no still.
 */
export function createFfmpegFrameGrabber(command = 'ffmpeg'): FrameGrabber {
  return async (video, atSeconds, width) => {
    const folder = await mkdtemp(join(tmpdir(), 'imp-stills-'));
    try {
      // A file, not a pipe: the index of many clips sits at the end.
      const input = join(folder, 'clip');
      await writeFile(input, video.bytes);
      const stills = [];
      for (const [index, seconds] of atSeconds.entries()) {
        const output = join(folder, `${String(index)}.jpg`);
        const result = await run(command, [
          '-nostdin',
          '-v',
          'error',
          '-ss',
          seconds.toFixed(3),
          '-i',
          input,
          '-frames:v',
          '1',
          '-vf',
          `scale=${String(width)}:-2`,
          '-q:v',
          '4',
          '-y',
          output,
        ]);
        const bytes = result.code === 0 ? await readFile(output).catch(() => undefined) : undefined;
        stills.push(
          bytes === undefined || bytes.length === 0
            ? undefined
            : { bytes: new Uint8Array(bytes), mediaType: 'image/jpeg' },
        );
      }
      return stills;
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  };
}

/** Runs ffmpeg and gives what it wrote to its output. */
function capture(command: string, args: readonly string[]): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve(code === 0 ? Buffer.concat(chunks) : undefined);
    });
  });
}

/** How small a frame is read to judge its colours. */
const SAMPLE_WIDTH = 64;
const SAMPLE_HEIGHT = 36;

/**
 * Reads how the colours of a clip lie at times within it with ffmpeg, from
 * small frames as raw RGB, so that one shot can be graded to match another.
 */
export function createFfmpegColorSampler(command = 'ffmpeg'): ColorSampler {
  return async (video, atSeconds) => {
    const folder = await mkdtemp(join(tmpdir(), 'imp-colours-'));
    try {
      const input = join(folder, 'clip');
      await writeFile(input, video.bytes);
      const found = [];
      for (const seconds of atSeconds) {
        const pixels = await capture(command, [
          '-nostdin',
          '-v',
          'error',
          '-ss',
          seconds.toFixed(3),
          '-i',
          input,
          '-frames:v',
          '1',
          '-vf',
          `scale=${String(SAMPLE_WIDTH)}:${String(SAMPLE_HEIGHT)}`,
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          'pipe:1',
        ]).catch(() => undefined);
        found.push(
          pixels === undefined || pixels.length < SAMPLE_WIDTH * SAMPLE_HEIGHT * 3
            ? undefined
            : colorStats(pixels, 3),
        );
      }
      return found;
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  };
}
