import type { Pcm } from './pcm.js';
import { decodeWav, isWav } from './wav.js';

/** The containers and codecs Imp can meet: what generation models return, and video clips. */
export type AudioFormat = 'wav' | 'mp3' | 'flac' | 'vorbis' | 'opus' | 'mp4';

/** A file that cannot be decoded: an unknown format, or one this codec does not handle. */
export class UnsupportedAudioError extends Error {
  constructor(
    readonly format: AudioFormat | 'unknown',
    message: string,
  ) {
    super(message);
    this.name = 'UnsupportedAudioError';
  }
}

/**
 * Turns stored files into samples. A host service: the default below runs in
 * the browser worker and on Node alike, and a host may wrap it to add a format
 * it can decode natively (for example AAC in video clips through WebCodecs).
 */
export interface AudioCodec {
  decode(bytes: Uint8Array, mediaType: string): Promise<Pcm>;
}

function startsWith(bytes: Uint8Array, at: number, ascii: string): boolean {
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[at + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * What a file is, read from its first bytes. Stored media types are only a
 * hint: providers do not always say what they sent.
 */
export function sniffAudioFormat(bytes: Uint8Array): AudioFormat | undefined {
  if (isWav(bytes)) return 'wav';
  if (startsWith(bytes, 0, 'fLaC')) return 'flac';
  if (startsWith(bytes, 0, 'OggS')) {
    // The first page carries the codec's identification header.
    if (startsWith(bytes, 28, 'OpusHead')) return 'opus';
    if (startsWith(bytes, 29, 'vorbis')) return 'vorbis';
    if (startsWith(bytes, 28, 'fLaC') || startsWith(bytes, 29, 'FLAC')) return 'flac';
    return undefined;
  }
  if (startsWith(bytes, 4, 'ftyp')) return 'mp4';
  if (startsWith(bytes, 0, 'ID3')) return 'mp3';
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return 'mp3';
  return undefined;
}

interface DecodedByLibrary {
  readonly channelData: Float32Array[];
  readonly sampleRate: number;
}

function fromLibrary(result: DecodedByLibrary, format: AudioFormat): Pcm {
  if (result.channelData.length === 0 || result.sampleRate <= 0) {
    throw new UnsupportedAudioError(format, `The ${format} file holds no sound.`);
  }
  return { sampleRate: result.sampleRate, channels: result.channelData };
}

/**
 * The decoders that work in every host: WAV in TypeScript, MP3, FLAC, Vorbis
 * and Opus in WebAssembly, each loaded only when first needed. All are under
 * permissive licences. AAC is left out on purpose: the only WebAssembly AAC
 * decoder is under the GPL.
 */
export function createDefaultAudioCodec(): AudioCodec {
  return {
    async decode(bytes) {
      const format = sniffAudioFormat(bytes);
      switch (format) {
        case 'wav':
          return decodeWav(bytes);
        case 'mp3':
          return fromLibrary(await (await import('@audio/decode-mp3')).default(bytes), format);
        case 'flac':
          return fromLibrary(await (await import('@audio/decode-flac')).default(bytes), format);
        case 'vorbis':
          return fromLibrary(await (await import('@audio/decode-vorbis')).default(bytes), format);
        case 'opus':
          return fromLibrary(await (await import('@audio/decode-opus')).default(bytes), format);
        case 'mp4':
          throw new UnsupportedAudioError(
            'mp4',
            'The sound inside video clips (AAC) cannot be decoded here yet.',
          );
        case undefined:
          throw new UnsupportedAudioError('unknown', 'This file is not a sound format Imp knows.');
      }
    },
  };
}
