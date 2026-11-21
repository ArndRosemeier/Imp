import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { placeMp4Sound, readMp4Audio, type Mp4AudioDecoder } from '@imp/audio';

interface Run {
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
}

function run(command: string, args: readonly string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout: Buffer.concat(out), stderr });
    });
  });
}

/** Whether ffmpeg can be started on this computer. */
export async function hasFfmpeg(command = 'ffmpeg'): Promise<boolean> {
  try {
    return (await run(command, ['-version'])).code === 0;
  } catch {
    return false;
  }
}

/** Splits interleaved 32-bit float samples into one array per channel. */
export function deinterleave(bytes: Buffer, channels: number): Float32Array[] {
  const frames = Math.floor(bytes.length / 4 / channels);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const planes = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      (planes[c] as Float32Array)[i] = view.getFloat32((i * channels + c) * 4, true);
    }
  }
  return planes;
}

/**
 * Decodes clip sound with the ffmpeg installed on this computer. The clip is
 * read first, so a clip without sound fails the same way it does in the
 * browser. ffmpeg drops the encoder priming itself; the end padding and a
 * leading pause are applied here, as in the browser.
 */
export function createFfmpegMp4Decoder(command = 'ffmpeg'): Mp4AudioDecoder {
  return async (bytes) => {
    const track = readMp4Audio(bytes);
    // A file, not a pipe: the index of many clips sits at the end.
    const folder = await mkdtemp(join(tmpdir(), 'imp-clip-'));
    try {
      const input = join(folder, 'clip.mp4');
      await writeFile(input, bytes);
      const channels = Math.max(1, track.channels);
      const result = await run(command, [
        '-nostdin',
        '-v',
        'error',
        '-i',
        input,
        '-map',
        '0:a:0',
        '-ac',
        String(channels),
        '-ar',
        String(track.sampleRate),
        '-f',
        'f32le',
        'pipe:1',
      ]);
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `ffmpeg stopped with code ${String(result.code)}.`);
      }
      return placeMp4Sound(
        { ...track, skipSeconds: 0 },
        { sampleRate: track.sampleRate, channels: deinterleave(result.stdout, channels) },
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  };
}
