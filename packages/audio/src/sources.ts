import type { BlobStore } from '@imp/core';
import type { AudioCodec } from './codec.js';
import { UnsupportedAudioError } from './codec.js';
import type { StereoPcm } from './pcm.js';
import { forEngine, frameCount, levels } from './pcm.js';
import type { Peaks } from './peaks.js';
import { computePeaks, decodePeaks, encodePeaks } from './peaks.js';
import { toSeconds } from './time.js';
import { applyEffects, effectsKey, type Effect } from './effects.js';
import { encodeWav } from './wav.js';

/** What is known about a stored sound once it was decoded. */
export interface SourceInfo {
  /** Frames at the engine rate. */
  readonly frames: number;
  readonly durationSeconds: number;
  /** The rate and channels of the file itself, before conversion. */
  readonly sourceSampleRate: number;
  readonly sourceChannels: number;
  /** The loudest sample and the average level, 0 to 1. */
  readonly peak: number;
  readonly rms: number;
}

export class MissingSourceError extends Error {
  constructor(readonly key: string) {
    super(`Nothing is stored under "${key}".`);
    this.name = 'MissingSourceError';
  }
}

/** FNV-1a over the bytes and their length: cheap, and enough to notice a replaced file. */
function fingerprint(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}-${bytes.length.toString(16)}`;
}

/** The kept facts are numbers, so their JSON is plain ASCII and needs no text codec from the host. */
function asciiBytes(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

function asciiText(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

interface Decoded {
  readonly hash: string;
  readonly pcm: StereoPcm;
}

/**
 * Stored sounds, decoded for the engine. What decoding learns (length, levels
 * and the waveform overview) is kept in the blob store beside the file, under
 * the file's own key, so it goes when the project goes; it is a cache and is
 * rebuilt whenever the file changes. Samples are kept only in memory, up to a
 * budget, because decoding again is fast and samples are about ten times the
 * size of the compressed file.
 */
export class AudioSources {
  readonly #decoded = new Map<string, Decoded>();
  #decodedBytes = 0;

  constructor(
    private readonly blobs: BlobStore,
    private readonly codec: AudioCodec,
    private readonly memoryBudgetBytes = 256 * 1024 * 1024,
  ) {}

  /** Length, levels and overview of a stored sound, decoding it only when nothing is cached. */
  async describe(key: string): Promise<{ info: SourceInfo; peaks: Peaks }> {
    const { bytes, mediaType } = await this.#read(key);
    const hash = fingerprint(bytes);
    const base = `${key}.audio/${hash}`;
    const [info, peaks] = await Promise.all([
      this.blobs.get(`${base}/info`),
      this.blobs.get(`${base}/peaks`),
    ]);
    if (info !== undefined && peaks !== undefined) {
      return {
        info: JSON.parse(asciiText(info.bytes)) as SourceInfo,
        peaks: decodePeaks(peaks.bytes),
      };
    }
    return this.#decode(key, bytes, mediaType, hash);
  }

  /**
   * The key of a stored sound with effects applied. The processed sound is
   * rendered once and kept beside the source as a float WAV, so every place
   * that plays the region (the editor, the Edit stage, exports) hears the
   * same thing without processing it again. Without effects it is the
   * source's own key.
   */
  async processedKey(key: string, effects: readonly Effect[]): Promise<string> {
    if (effects.length === 0) return key;
    const { bytes } = await this.#read(key);
    const processed = `${key}.audio/${fingerprint(bytes)}/fx/${fingerprint(asciiBytes(effectsKey(effects)))}.wav`;
    if ((await this.blobs.get(processed)) !== undefined) return processed;
    const pcm = applyEffects(await this.pcm(key), effects);
    await this.blobs.put(processed, {
      bytes: encodeWav(pcm, 'float32'),
      mediaType: 'audio/wav',
    });
    return processed;
  }

  /** The samples of a stored sound, stereo at the engine rate. */
  async pcm(key: string): Promise<StereoPcm> {
    const { bytes, mediaType } = await this.#read(key);
    const hash = fingerprint(bytes);
    const cached = this.#decoded.get(key);
    if (cached?.hash === hash) {
      // Most recently used goes to the end, so the oldest is dropped first.
      this.#decoded.delete(key);
      this.#decoded.set(key, cached);
      return cached.pcm;
    }
    await this.#decode(key, bytes, mediaType, hash);
    const decoded = this.#decoded.get(key);
    if (decoded === undefined) throw new Error(`Decoding "${key}" kept nothing.`);
    return decoded.pcm;
  }

  async #read(key: string): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const blob = await this.blobs.get(key);
    if (blob === undefined) throw new MissingSourceError(key);
    return blob;
  }

  async #decode(
    key: string,
    bytes: Uint8Array,
    mediaType: string,
    hash: string,
  ): Promise<{ info: SourceInfo; peaks: Peaks }> {
    const decoded = await this.codec.decode(bytes, mediaType);
    if (frameCount(decoded) === 0) {
      throw new UnsupportedAudioError('unknown', `"${key}" holds no sound.`);
    }
    const pcm = forEngine(decoded);
    const { peak, rms } = levels(pcm);
    const info: SourceInfo = {
      frames: frameCount(pcm),
      durationSeconds: toSeconds(frameCount(pcm)),
      sourceSampleRate: decoded.sampleRate,
      sourceChannels: decoded.channels.length,
      peak,
      rms,
    };
    const peaks = computePeaks(pcm);
    // Drop what was cached for an earlier version of the file.
    const base = `${key}.audio/${hash}`;
    for (const stale of await this.blobs.list(`${key}.audio/`)) {
      if (!stale.startsWith(`${base}/`)) await this.blobs.delete(stale);
    }
    const octets = 'application/octet-stream';
    await this.blobs.put(`${base}/peaks`, { bytes: encodePeaks(peaks), mediaType: octets });
    await this.blobs.put(`${base}/info`, {
      bytes: asciiBytes(JSON.stringify(info)),
      mediaType: 'application/json',
    });
    this.#remember(key, { hash, pcm });
    return { info, peaks };
  }

  #remember(key: string, decoded: Decoded): void {
    const size = (pcm: StereoPcm): number => frameCount(pcm) * 2 * 4;
    const previous = this.#decoded.get(key);
    if (previous !== undefined) {
      this.#decodedBytes -= size(previous.pcm);
      this.#decoded.delete(key);
    }
    this.#decoded.set(key, decoded);
    this.#decodedBytes += size(decoded.pcm);
    for (const [oldest, entry] of this.#decoded) {
      // The newest stays even when it alone is over the budget.
      if (this.#decodedBytes <= this.memoryBudgetBytes || oldest === key) break;
      this.#decoded.delete(oldest);
      this.#decodedBytes -= size(entry.pcm);
    }
  }
}
