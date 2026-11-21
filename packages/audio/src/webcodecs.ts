import { readMp4Audio, type Mp4AudioTrack } from './mp4.js';
import type { Pcm } from './pcm.js';

/** Decodes the sound of an MP4 or MOV clip. A host service, since AAC needs a native decoder. */
export type Mp4AudioDecoder = (bytes: Uint8Array) => Promise<Pcm>;

// The parts of WebCodecs used here, so the package needs no DOM types.
interface AudioDataLike {
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  copyTo(destination: Float32Array, options: { planeIndex: number; format: 'f32-planar' }): void;
  close(): void;
}

interface AudioDecoderLike {
  configure(config: {
    codec: string;
    sampleRate: number;
    numberOfChannels: number;
    description: Uint8Array;
  }): void;
  decode(chunk: unknown): void;
  flush(): Promise<void>;
  close(): void;
  readonly state: string;
}

export interface WebCodecsLike {
  readonly AudioDecoder: new (init: {
    output: (data: AudioDataLike) => void;
    error: (error: Error) => void;
  }) => AudioDecoderLike;
  readonly EncodedAudioChunk: new (init: {
    type: 'key' | 'delta';
    timestamp: number;
    data: Uint8Array;
  }) => unknown;
}

/** WebCodecs where the host has it: browsers, in the page and in dedicated workers. */
export function webCodecs(scope: object = globalThis): WebCodecsLike | undefined {
  const candidate = scope as Partial<WebCodecsLike>;
  return typeof candidate.AudioDecoder === 'function' &&
    typeof candidate.EncodedAudioChunk === 'function'
    ? (candidate as WebCodecsLike)
    : undefined;
}

/**
 * Applies what the clip's edit list says to decoded sound: drops the
 * encoder's priming, adds a leading pause, and stops where the clip says
 * its sound ends. Decoders that read the file themselves (ffmpeg) already do.
 */
export function placeMp4Sound(track: Mp4AudioTrack, decoded: Pcm): Pcm {
  const rate = decoded.sampleRate;
  const skip = Math.round(track.skipSeconds * rate);
  const delay = Math.round(track.delaySeconds * rate);
  return {
    sampleRate: rate,
    channels: decoded.channels.map((channel) => {
      const available = Math.max(0, channel.length - skip);
      const length =
        track.durationSeconds === undefined
          ? available
          : Math.min(available, Math.round(track.durationSeconds * rate));
      const out = new Float32Array(delay + length);
      out.set(channel.subarray(skip, skip + length), delay);
      return out;
    }),
  };
}

/** Joins decoded pieces into one array per channel. */
function join(pieces: readonly Float32Array[][], channels: number): Float32Array[] {
  const total = pieces.reduce((sum, piece) => sum + (piece[0]?.length ?? 0), 0);
  return Array.from({ length: channels }, (_, c) => {
    const out = new Float32Array(total);
    let at = 0;
    for (const piece of pieces) {
      const part = piece[c] ?? piece[0] ?? new Float32Array(0);
      out.set(part, at);
      at += piece[0]?.length ?? 0;
    }
    return out;
  });
}

/** Decodes clip sound with WebCodecs. */
export function createWebCodecsMp4Decoder(codecs: WebCodecsLike): Mp4AudioDecoder {
  return async (bytes) => {
    const track = readMp4Audio(bytes);
    const pieces: Float32Array[][] = [];
    let sampleRate = track.sampleRate;
    let channels = track.channels;
    let failure: Error | undefined;
    const decoder = new codecs.AudioDecoder({
      output: (data) => {
        try {
          sampleRate = data.sampleRate;
          channels = data.numberOfChannels;
          const piece: Float32Array[] = [];
          for (let c = 0; c < data.numberOfChannels; c++) {
            const plane = new Float32Array(data.numberOfFrames);
            data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
            piece.push(plane);
          }
          pieces.push(piece);
        } finally {
          data.close();
        }
      },
      error: (error) => {
        failure = error;
      },
    });
    try {
      decoder.configure({
        codec: track.codec,
        sampleRate: track.sampleRate,
        numberOfChannels: track.channels,
        description: track.description,
      });
      // AAC frames hold 1024 samples each; timestamps only need to be increasing.
      const frameMicros = (1024 / track.sampleRate) * 1_000_000;
      track.frames.forEach((data, i) => {
        decoder.decode(
          new codecs.EncodedAudioChunk({
            type: 'key',
            timestamp: Math.round(i * frameMicros),
            data,
          }),
        );
      });
      await decoder.flush();
    } finally {
      if (decoder.state !== 'closed') decoder.close();
    }
    if (failure !== undefined) throw failure;
    return placeMp4Sound(track, { sampleRate, channels: join(pieces, channels) });
  };
}
