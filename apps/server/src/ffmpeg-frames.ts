import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FrameGrabber } from '@imp/host';

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
