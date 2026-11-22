import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FFMPEG_BUILDS,
  ffmpegServices,
  openFfmpegTool,
  type Download,
  type FfmpegBuild,
} from '../src/ffmpeg-tool.js';

let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'imp-ffmpeg-'));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

const program = Buffer.from('#!/bin/sh\necho ffmpeg version test\n'.repeat(60_000));
const packed = gzipSync(program);
const build: FfmpegBuild = {
  file: 'ffmpeg-linux-x64.gz',
  sha256: createHash('sha256').update(packed).digest('hex'),
  bytes: packed.length,
};

/** Serves the packed program in parts, as a download would arrive. */
function serving(bytes: Uint8Array, status = 200): Download & { urls: string[] } {
  const urls: string[] = [];
  const download = (url: string) => {
    urls.push(url);
    return Promise.resolve({
      ok: status === 200,
      status,
      body: (function* () {
        for (let at = 0; at < bytes.length; at += 256 * 1024) {
          yield bytes.subarray(at, at + 256 * 1024);
        }
      })() as unknown as AsyncIterable<Uint8Array>,
    });
  };
  return Object.assign(download, { urls });
}

describe('ffmpeg for the local server', () => {
  it('uses the ffmpeg installed on the computer when there is one', async () => {
    const tool = await openFfmpegTool({
      folder,
      works: (command) => Promise.resolve(command === 'ffmpeg'),
    });
    expect(tool.command()).toBe('ffmpeg');
    expect(tool.status()).toMatchObject({ available: true, source: 'system' });
    expect(await tool.install()).toMatchObject({ source: 'system' });
  });

  it('downloads, checks and starts using ffmpeg, telling how far it got', async () => {
    const download = serving(packed);
    const works = vi.fn((command: string) => Promise.resolve(command !== 'ffmpeg'));
    const tool = await openFfmpegTool({
      folder,
      platform: 'linux',
      arch: 'x64',
      download,
      works,
      builds: { 'linux-x64': build },
    });
    expect(tool.command()).toBeNull();
    expect(tool.status()).toMatchObject({
      available: false,
      canDownload: true,
      downloadBytes: build.bytes,
    });
    const progress = vi.fn();
    const [done, same] = await Promise.all([tool.install(progress), tool.install()]);
    expect(done).toMatchObject({ available: true, source: 'downloaded', downloading: null });
    expect(same).toBe(done);
    expect(download.urls).toEqual([
      'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-x64.gz',
    ]);
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        downloading: expect.objectContaining({ totalBytes: build.bytes }) as unknown,
      }),
    );
    const target = join(folder, 'ffmpeg');
    expect(tool.command()).toBe(target);
    expect(await readFile(target)).toEqual(program);
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o111).not.toBe(0);

    // After a restart the downloaded one is found again.
    const again = await openFfmpegTool({ folder, platform: 'linux', arch: 'x64', works });
    expect(again.status()).toMatchObject({ available: true, source: 'downloaded' });
  });

  it('refuses a download that is not the expected file', async () => {
    const tool = await openFfmpegTool({
      folder,
      platform: 'linux',
      arch: 'x64',
      download: serving(gzipSync(Buffer.from('something else'))),
      works: (command) => Promise.resolve(command !== 'ffmpeg'),
      builds: { 'linux-x64': build },
    });
    await expect(tool.install()).rejects.toThrow(/does not match/);
    expect(tool.status()).toMatchObject({
      available: false,
      error: expect.stringMatching(/match/) as unknown,
    });
    await expect(stat(join(folder, 'ffmpeg'))).rejects.toThrow();
  });

  it('says when the download failed or the program does not run', async () => {
    const failed = await openFfmpegTool({
      folder,
      platform: 'linux',
      arch: 'x64',
      download: serving(packed, 404),
      works: () => Promise.resolve(false),
      builds: { 'linux-x64': build },
    });
    await expect(failed.install()).rejects.toThrow(/HTTP 404/);

    const broken = await openFfmpegTool({
      folder,
      platform: 'linux',
      arch: 'x64',
      download: serving(packed),
      works: () => Promise.resolve(false),
      builds: { 'linux-x64': build },
    });
    await expect(broken.install()).rejects.toThrow(/does not run/);
    await expect(stat(join(folder, 'ffmpeg.part'))).rejects.toThrow();
  });

  it('stops a download that grows far past its size', async () => {
    const tool = await openFfmpegTool({
      folder,
      platform: 'linux',
      arch: 'x64',
      download: serving(Buffer.alloc(build.bytes * 3)),
      works: () => Promise.resolve(false),
      builds: { 'linux-x64': build },
    });
    await expect(tool.install()).rejects.toThrow(/larger than expected/);
  });

  it('says so when there is no build for this computer', async () => {
    const tool = await openFfmpegTool({
      folder,
      platform: 'freebsd',
      arch: 'x64',
      works: () => Promise.resolve(false),
    });
    expect(tool.status()).toMatchObject({ canDownload: false, downloadBytes: null });
    await expect(tool.install()).rejects.toThrow(/No ffmpeg download exists/);
  });

  it('offers a build for each common computer, each with a checksum', () => {
    expect(Object.keys(FFMPEG_BUILDS).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ]);
    for (const known of Object.values(FFMPEG_BUILDS))
      expect(known.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lets the services that need ffmpeg fail plainly while there is none', async () => {
    const services = ffmpegServices({ command: () => null });
    await expect(services.mp4Audio(new Uint8Array())).rejects.toMatchObject({
      name: 'UnsupportedAudioError',
    });
    const video = { bytes: new Uint8Array(), mediaType: 'video/mp4' };
    await expect(services.frameGrabber(video, [0], 64)).rejects.toThrow(/no ffmpeg/);
    await expect(services.colorSampler(video, [0])).rejects.toThrow(/no ffmpeg/);
  });
});
