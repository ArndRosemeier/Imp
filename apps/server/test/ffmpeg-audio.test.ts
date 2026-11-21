import { readFileSync } from 'node:fs';
import { createDefaultAudioCodec, UnsupportedAudioError } from '@imp/audio';
import { measureFrequency } from '@imp/audio/testing';
import { describe, expect, it } from 'vitest';
import { createFfmpegMp4Decoder, deinterleave, hasFfmpeg } from '../src/ffmpeg-audio.js';

const fixture = (file: string): Uint8Array =>
  new Uint8Array(
    readFileSync(new URL(`../../../packages/audio/test/fixtures/${file}`, import.meta.url)),
  );

const installed = await hasFfmpeg();

describe('clip sound through ffmpeg', () => {
  it('splits interleaved samples by channel', () => {
    const bytes = Buffer.from(new Float32Array([1, -1, 0.5, -0.5]).buffer);
    expect(deinterleave(bytes, 2).map((plane) => Array.from(plane))).toEqual([
      [1, 0.5],
      [-1, -0.5],
    ]);
  });

  it('knows when ffmpeg is missing or broken', async () => {
    expect(await hasFfmpeg('imp-no-such-command')).toBe(false);
    expect(await hasFfmpeg('false')).toBe(false);
    await expect(
      createFfmpegMp4Decoder('false')(fixture('clip-sine-440-mono-48k.mp4')),
    ).rejects.toThrow(/stopped with code 1/);
  });

  it('fails a clip without sound before starting ffmpeg', async () => {
    const codec = createDefaultAudioCodec({ mp4: createFfmpegMp4Decoder('imp-no-such-command') });
    const error = await codec
      .decode(fixture('clip-silent.mp4'), 'video/mp4')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnsupportedAudioError);
    expect((error as Error).message).toMatch(/no sound track/);
  });

  it.skipIf(!installed)('decodes the sound of a video clip', async () => {
    const codec = createDefaultAudioCodec({ mp4: createFfmpegMp4Decoder() });
    const pcm = await codec.decode(fixture('clip-sine-440-mono-48k.mp4'), 'video/mp4');
    expect(pcm.sampleRate).toBe(48000);
    expect(pcm.channels).toHaveLength(1);
    expect(pcm.channels[0]?.length).toBeCloseTo(24000, -2);
    expect(measureFrequency(pcm)).toBeCloseTo(440, -1);
  });

  it.skipIf(!installed)('decodes QuickTime clips in stereo', async () => {
    const pcm = await createFfmpegMp4Decoder()(fixture('clip-sine-440-stereo-44k.mov'));
    expect(pcm.sampleRate).toBe(44100);
    expect(pcm.channels).toHaveLength(2);
    expect(measureFrequency(pcm)).toBeCloseTo(440, -1);
  });
});
