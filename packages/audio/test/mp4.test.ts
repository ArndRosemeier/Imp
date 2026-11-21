import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createDefaultAudioCodec,
  createWebCodecsMp4Decoder,
  Mp4Error,
  placeMp4Sound,
  readMp4Audio,
  UnsupportedAudioError,
  webCodecs,
  type Mp4AudioTrack,
  type WebCodecsLike,
} from '../src/index.js';

const fixture = (file: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${file}`, import.meta.url)));

const bytesIn = (track: Mp4AudioTrack): number =>
  track.frames.reduce((sum, frame) => sum + frame.length, 0);

const mp4Failure = (bytes: Uint8Array): Mp4Error => {
  try {
    readMp4Audio(bytes);
  } catch (error) {
    if (error instanceof Mp4Error) return error;
    throw error;
  }
  throw new Error('The file was read.');
};

// Frame counts and byte totals are what ffprobe reports for each fixture.
describe('reading the sound track of a clip', () => {
  it('reads an AAC sound file', () => {
    const track = readMp4Audio(fixture('sine-440-stereo-48k.m4a'));
    expect(track.codec).toBe('mp4a.40.2');
    expect(track.sampleRate).toBe(48000);
    expect(track.channels).toBe(2);
    expect(track.description.length).toBeGreaterThanOrEqual(2);
    expect(track.frames).toHaveLength(48);
    expect(bytesIn(track)).toBe(8094);
    expect(track.skipSeconds).toBeCloseTo(1024 / 48000, 6);
    expect(track.delaySeconds).toBe(0);
    expect(track.durationSeconds).toBeCloseTo(1, 3);
  });

  it('finds the sound beside the picture in a video clip', () => {
    const track = readMp4Audio(fixture('clip-sine-440-mono-48k.mp4'));
    expect(track.channels).toBe(1);
    expect(track.frames).toHaveLength(25);
    expect(bytesIn(track)).toBe(4348);
    expect(track.durationSeconds).toBeCloseTo(0.5, 2);
  });

  it('reads QuickTime files', () => {
    const track = readMp4Audio(fixture('clip-sine-440-stereo-44k.mov'));
    expect(track.sampleRate).toBe(44100);
    expect(track.channels).toBe(2);
    expect(track.frames).toHaveLength(23);
    expect(bytesIn(track)).toBe(8472);
  });

  it('says when a clip has no sound', () => {
    expect(mp4Failure(fixture('clip-silent.mp4')).reason).toBe('no-sound');
  });

  it('says when a file is damaged or not laid out as expected', () => {
    const whole = fixture('clip-sine-440-mono-48k.mp4');
    expect(mp4Failure(whole.subarray(0, whole.length - 100)).reason).toBe('malformed');
    const box = (type: string, size = 16): Uint8Array => {
      const bytes = new Uint8Array(size);
      new DataView(bytes.buffer).setUint32(0, size);
      bytes.set(new TextEncoder().encode(type), 4);
      return bytes;
    };
    expect(mp4Failure(box('ftyp')).reason).toBe('malformed');
    const fragmented = new Uint8Array([...box('ftyp'), ...box('moof')]);
    expect(mp4Failure(fragmented).reason).toBe('unsupported');
    // A box that claims to be bigger than the file.
    const liar = box('ftyp');
    new DataView(liar.buffer).setUint32(0, 400);
    expect(mp4Failure(liar).reason).toBe('malformed');
  });
});

describe('placing decoded clip sound', () => {
  const track = (over: Partial<Mp4AudioTrack>): Mp4AudioTrack => ({
    codec: 'mp4a.40.2',
    sampleRate: 10,
    channels: 1,
    description: new Uint8Array(2),
    frames: [],
    timescale: 10,
    skipSeconds: 0.2,
    delaySeconds: 0.1,
    durationSeconds: 0.5,
    ...over,
  });
  const decoded = { sampleRate: 10, channels: [Float32Array.from({ length: 10 }, (_, i) => i)] };

  it('drops the priming, adds the pause, and stops where the clip ends', () => {
    expect(Array.from(placeMp4Sound(track({}), decoded).channels[0] ?? [])).toEqual([
      0, 2, 3, 4, 5, 6,
    ]);
  });

  it('keeps everything after the priming when the clip gives no length', () => {
    const placed = placeMp4Sound(track({ durationSeconds: undefined, delaySeconds: 0 }), decoded);
    expect(placed.channels[0]).toHaveLength(8);
  });
});

/** WebCodecs as the browser has it, decoding each frame to 1024 samples of its own index. */
function fakeWebCodecs(options: { fail?: boolean; channels?: number } = {}): {
  codecs: WebCodecsLike;
  configured: unknown[];
} {
  const configured: unknown[] = [];
  class EncodedAudioChunk {
    constructor(readonly init: { timestamp: number; data: Uint8Array }) {}
  }
  class AudioDecoder {
    state = 'unconfigured';
    #index = 0;
    constructor(
      readonly init: {
        output: (data: {
          numberOfFrames: number;
          numberOfChannels: number;
          sampleRate: number;
          copyTo(destination: Float32Array, options: { planeIndex: number }): void;
          close(): void;
        }) => void;
        error: (error: Error) => void;
      },
    ) {}
    configure(config: unknown): void {
      configured.push(config);
      this.state = 'configured';
    }
    decode(chunk: unknown): void {
      expect(chunk).toBeInstanceOf(EncodedAudioChunk);
      const value = this.#index++;
      const channels = options.channels ?? 2;
      this.init.output({
        numberOfFrames: 1024,
        numberOfChannels: channels,
        sampleRate: 48000,
        copyTo: (destination, { planeIndex }) => destination.fill(value + planeIndex / 10),
        close: () => undefined,
      });
    }
    flush(): Promise<void> {
      if (options.fail === true) this.init.error(new Error('The decoder broke.'));
      return Promise.resolve();
    }
    close(): void {
      this.state = 'closed';
    }
  }
  const codecs = webCodecs({ AudioDecoder, EncodedAudioChunk });
  if (codecs === undefined) throw new Error('The fake was not taken for WebCodecs.');
  return {
    codecs,
    configured,
  };
}

describe('decoding clip sound with WebCodecs', () => {
  it('is found only where the host has it', () => {
    expect(webCodecs({})).toBeUndefined();
    expect(fakeWebCodecs().codecs).toBeDefined();
  });

  it('configures the decoder from the clip and joins what it returns', async () => {
    const { codecs, configured } = fakeWebCodecs();
    const pcm = await createWebCodecsMp4Decoder(codecs)(fixture('sine-440-stereo-48k.m4a'));
    expect(configured[0]).toMatchObject({
      codec: 'mp4a.40.2',
      sampleRate: 48000,
      numberOfChannels: 2,
    });
    expect(pcm.sampleRate).toBe(48000);
    expect(pcm.channels).toHaveLength(2);
    // One second, after the 1024 priming samples of frame 0 are dropped.
    expect(pcm.channels[0]).toHaveLength(48000);
    expect(pcm.channels[0]?.[0]).toBe(1);
    expect(pcm.channels[1]?.[0]).toBeCloseTo(1.1, 5);
  });

  it('passes on what the decoder reports as broken', async () => {
    const { codecs } = fakeWebCodecs({ fail: true });
    await expect(
      createWebCodecsMp4Decoder(codecs)(fixture('sine-440-stereo-48k.m4a')),
    ).rejects.toThrow('The decoder broke.');
  });
});

describe('the default codec with a clip decoder', () => {
  const clip = fixture('clip-sine-440-mono-48k.mp4');

  it('says what is needed when the host has no clip decoder', async () => {
    const error = await createDefaultAudioCodec()
      .decode(clip, 'video/mp4')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnsupportedAudioError);
    expect((error as Error).message).toMatch(/WebCodecs|ffmpeg/);
  });

  it('hands clips to the host decoder', async () => {
    const { codecs } = fakeWebCodecs({ channels: 1 });
    const codec = createDefaultAudioCodec({ mp4: createWebCodecsMp4Decoder(codecs) });
    const pcm = await codec.decode(clip, 'video/mp4');
    expect(pcm.channels).toHaveLength(1);
    expect(pcm.channels[0]?.length).toBeCloseTo(24000, -2);
  });

  it('reports clip failures as sound it cannot decode', async () => {
    const silent = createDefaultAudioCodec({
      mp4: (bytes) => Promise.resolve(readMp4Audio(bytes) as never),
    });
    await expect(silent.decode(fixture('clip-silent.mp4'), 'video/mp4')).rejects.toThrow(
      /no sound track/,
    );
    const broken = createDefaultAudioCodec({ mp4: () => Promise.reject(new Error('boom')) });
    const error = await broken.decode(clip, 'video/mp4').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnsupportedAudioError);
    expect((error as Error).message).toContain('boom');
    const odd = createDefaultAudioCodec({
      mp4: () => Promise.reject(new UnsupportedAudioError('mp4', 'odd')),
    });
    await expect(odd.decode(clip, 'video/mp4')).rejects.toThrow('odd');
  });
});
