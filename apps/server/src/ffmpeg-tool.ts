import { createHash } from 'node:crypto';
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { UnsupportedAudioError, type Mp4AudioDecoder } from '@imp/audio';
import type { ColorSampler, FrameGrabber } from '@imp/host';
import { createFfmpegMp4Decoder, hasFfmpeg } from './ffmpeg-audio.js';
import { createFfmpegColorSampler, createFfmpegFrameGrabber } from './ffmpeg-frames.js';

/**
 * The ffmpeg builds Imp offers to download, from the ffmpeg-static project's
 * release b6.1.1 (FFmpeg 6.1.1, static, GPL). Each file's SHA-256 is fixed
 * here, so a changed or corrupted download is refused rather than run.
 */
export const FFMPEG_RELEASE = 'b6.1.1';
const FFMPEG_BASE = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_RELEASE}/`;

export interface FfmpegBuild {
  readonly file: string;
  readonly sha256: string;
  /** Download size in bytes, to show before downloading. */
  readonly bytes: number;
}

export const FFMPEG_BUILDS: Readonly<Record<string, FfmpegBuild>> = {
  'linux-x64': {
    file: 'ffmpeg-linux-x64.gz',
    sha256: 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
    bytes: 29_354_986,
  },
  'linux-arm64': {
    file: 'ffmpeg-linux-arm64.gz',
    sha256: '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0',
    bytes: 25_568_691,
  },
  'darwin-x64': {
    file: 'ffmpeg-darwin-x64.gz',
    sha256: '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
    bytes: 25_296_431,
  },
  'darwin-arm64': {
    file: 'ffmpeg-darwin-arm64.gz',
    sha256: '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa',
    bytes: 19_246_198,
  },
  'win32-x64': {
    file: 'ffmpeg-win32-x64.gz',
    sha256: '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
    bytes: 29_581_307,
  },
};

export interface FfmpegStatus {
  /** Whether Imp can use ffmpeg now. */
  readonly available: boolean;
  /** `system`: the ffmpeg installed on this computer; `downloaded`: the one Imp fetched. */
  readonly source: 'system' | 'downloaded' | null;
  /** Whether a build exists for this computer, so it can be downloaded. */
  readonly canDownload: boolean;
  /** Download size in bytes, when one can be downloaded. */
  readonly downloadBytes: number | null;
  /** While downloading: how far it got. */
  readonly downloading: { readonly receivedBytes: number; readonly totalBytes: number } | null;
  /** Why the last download failed, if it did. */
  readonly error: string | null;
}

/** Fetches a URL and hands over its body as it arrives. */
export type Download = (
  url: string,
) => Promise<{ ok: boolean; status: number; body: AsyncIterable<Uint8Array> | null }>;

export interface FfmpegToolOptions {
  /** The folder the downloaded ffmpeg goes in. */
  readonly folder: string;
  readonly platform?: string;
  readonly arch?: string;
  readonly download?: Download;
  /** Whether a command runs as ffmpeg; replaced in tests. */
  readonly works?: (command: string) => Promise<boolean>;
  readonly builds?: Readonly<Record<string, FfmpegBuild>>;
}

export interface FfmpegTool {
  /** The ffmpeg to run, or null while there is none. */
  command(): string | null;
  status(): FfmpegStatus;
  /** Downloads ffmpeg for this computer, checks it and starts using it; `progress` hears how far it got. */
  install(progress?: (status: FfmpegStatus) => void): Promise<FfmpegStatus>;
}

const nodeDownload: Download = async (url) => {
  const response = await fetch(url, { redirect: 'follow' });
  return {
    ok: response.ok,
    status: response.status,
    body: response.body as AsyncIterable<Uint8Array> | null,
  };
};

/**
 * ffmpeg for the local server: the one installed on this computer if there
 * is one, otherwise one Imp downloads into its data folder when the person
 * (or an agent) asks. Nothing needs it to start; without it films are
 * recorded in the browser and clip sound stays silent.
 */
export async function openFfmpegTool(options: FfmpegToolOptions): Promise<FfmpegTool> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const works = options.works ?? hasFfmpeg;
  const download = options.download ?? nodeDownload;
  const build = (options.builds ?? FFMPEG_BUILDS)[`${platform}-${arch}`];
  const target = join(options.folder, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

  let command: string | null = null;
  let source: FfmpegStatus['source'] = null;
  if (await works('ffmpeg')) {
    command = 'ffmpeg';
    source = 'system';
  } else if ((await exists(target)) && (await works(target))) {
    command = target;
    source = 'downloaded';
  }
  let downloading: FfmpegStatus['downloading'] = null;
  let error: string | null = null;
  let installing: Promise<FfmpegStatus> | undefined;

  const status = (): FfmpegStatus => ({
    available: command !== null,
    source,
    canDownload: build !== undefined,
    downloadBytes: build?.bytes ?? null,
    downloading,
    error,
  });

  async function fetchAndCheck(chosen: FfmpegBuild, tell: () => void): Promise<void> {
    const response = await download(`${FFMPEG_BASE}${chosen.file}`);
    if (!response.ok || response.body === null) {
      throw new Error(`The download failed (HTTP ${String(response.status)}).`);
    }
    const hash = createHash('sha256');
    const parts: Uint8Array[] = [];
    let received = 0;
    let lastTold = 0;
    for await (const part of response.body) {
      hash.update(part);
      parts.push(part);
      received += part.length;
      if (received > chosen.bytes * 2) throw new Error('The download is larger than expected.');
      downloading = { receivedBytes: received, totalBytes: chosen.bytes };
      // Told about every megabyte, not every packet.
      if (received - lastTold >= 1 << 20) {
        lastTold = received;
        tell();
      }
    }
    if (hash.digest('hex') !== chosen.sha256) {
      throw new Error('The download does not match the expected file, so it was not used.');
    }
    const binary = gunzipSync(Buffer.concat(parts));
    await mkdir(options.folder, { recursive: true });
    const partial = `${target}.part`;
    await writeFile(partial, binary, { mode: 0o755 });
    await chmod(partial, 0o755);
    if (!(await works(partial))) {
      await rm(partial, { force: true });
      throw new Error('The downloaded ffmpeg does not run on this computer.');
    }
    await rename(partial, target);
  }

  async function install(progress?: (status: FfmpegStatus) => void): Promise<FfmpegStatus> {
    const tell = (): void => {
      progress?.(status());
    };
    if (command !== null) return status();
    if (build === undefined) {
      throw new Error(
        `No ffmpeg download exists for this computer (${platform} ${arch}). Install it from https://ffmpeg.org/ and start Imp again.`,
      );
    }
    error = null;
    downloading = { receivedBytes: 0, totalBytes: build.bytes };
    tell();
    try {
      await fetchAndCheck(build, tell);
      command = target;
      source = 'downloaded';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      throw cause instanceof Error ? cause : new Error(error);
    } finally {
      downloading = null;
    }
    return status();
  }

  return {
    command: () => command,
    status,
    // One download at a time; a second ask waits for the first.
    install: (progress) =>
      (installing ??= install(progress).finally(() => {
        installing = undefined;
      })),
  };
}

const MISSING =
  'Imp on this computer has no ffmpeg yet. Download it under Settings, Where Imp runs (or with system.ffmpeg.install).';

/**
 * The services that need ffmpeg, each using whichever ffmpeg there is when
 * it is called, so that one downloaded while Imp runs is used at once.
 */
export function ffmpegServices(tool: Pick<FfmpegTool, 'command'>): {
  mp4Audio: Mp4AudioDecoder;
  frameGrabber: FrameGrabber;
  colorSampler: ColorSampler;
} {
  const need = (): string => {
    const command = tool.command();
    if (command === null) throw new Error(MISSING);
    return command;
  };
  return {
    mp4Audio: (bytes) => {
      const command = tool.command();
      // The same failure as a host without a decoder: the clip plays silent and says why.
      if (command === null) return Promise.reject(new UnsupportedAudioError('mp4', MISSING));
      return createFfmpegMp4Decoder(command)(bytes);
    },
    frameGrabber: async (video, atSeconds, width) =>
      createFfmpegFrameGrabber(need())(video, atSeconds, width),
    colorSampler: async (video, atSeconds) => createFfmpegColorSampler(need())(video, atSeconds),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
