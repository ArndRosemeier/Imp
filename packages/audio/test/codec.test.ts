import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createDefaultAudioCodec,
  decodeWav,
  encodeWav,
  sniffAudioFormat,
  UnsupportedAudioError,
} from '../src/index.js';
import { describeAudioCodecContract, measureFrequency, type AudioFixture } from '../src/testing.js';

const fixture = (file: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${file}`, import.meta.url)));

/** A sine tone made in code, so the WAV path needs no file. */
function tone(sampleRate: number, channels: number, seconds: number, frequency: number) {
  const frames = Math.round(sampleRate * seconds);
  return {
    sampleRate,
    channels: Array.from({ length: channels }, () =>
      Float32Array.from(
        { length: frames },
        (_, i) => 0.125 * Math.sin((2 * Math.PI * frequency * i) / sampleRate),
      ),
    ),
  };
}

// Every fixture is a 440 Hz sine at 1/8 of full scale, one second long, made with ffmpeg.
// Its stereo files spread the tone on both sides 3 dB lower.
const STEREO_PEAK = 0.125 * Math.SQRT1_2;
const fixtures: AudioFixture[] = [
  {
    name: 'MP3, mono, 24 kHz',
    bytes: fixture('sine-440-mono-24k.mp3'),
    mediaType: 'audio/mpeg',
    sampleRate: 24000,
    channels: 1,
    durationSeconds: 1,
    frequency: 440,
    peak: 0.125,
  },
  {
    name: 'FLAC, stereo, 44.1 kHz',
    bytes: fixture('sine-440-stereo-44k.flac'),
    mediaType: 'audio/flac',
    sampleRate: 44100,
    channels: 2,
    durationSeconds: 1,
    frequency: 440,
    peak: STEREO_PEAK,
  },
  {
    name: 'Ogg Vorbis, stereo, 44.1 kHz',
    bytes: fixture('sine-440-stereo-44k.ogg'),
    mediaType: 'audio/ogg',
    sampleRate: 44100,
    channels: 2,
    durationSeconds: 1,
    frequency: 440,
    peak: STEREO_PEAK,
  },
  {
    name: 'Ogg Opus, mono, 48 kHz',
    bytes: fixture('sine-440-mono-48k.opus'),
    mediaType: 'audio/ogg',
    sampleRate: 48000,
    channels: 1,
    durationSeconds: 1,
    frequency: 440,
    peak: 0.125,
  },
  {
    name: 'WAV, stereo, 16 bit',
    bytes: encodeWav(tone(22050, 2, 1, 440)),
    mediaType: 'audio/wav',
    sampleRate: 22050,
    channels: 2,
    durationSeconds: 1,
    frequency: 440,
    peak: 0.125,
  },
];

describeAudioCodecContract('default codec on Node', createDefaultAudioCodec, fixtures);

describe('sniffAudioFormat', () => {
  it('names each format from its first bytes, whatever the media type says', () => {
    expect(sniffAudioFormat(fixture('sine-440-mono-24k.mp3'))).toBe('mp3');
    expect(sniffAudioFormat(fixture('sine-440-stereo-44k.flac'))).toBe('flac');
    expect(sniffAudioFormat(fixture('sine-440-stereo-44k.ogg'))).toBe('vorbis');
    expect(sniffAudioFormat(fixture('sine-440-mono-48k.opus'))).toBe('opus');
    expect(sniffAudioFormat(fixture('sine-440-stereo-48k.m4a'))).toBe('mp4');
    expect(sniffAudioFormat(encodeWav(tone(8000, 1, 0.01, 440)))).toBe('wav');
    expect(sniffAudioFormat(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))).toBe('mp3');
    expect(sniffAudioFormat(new TextEncoder().encode('OggS'.padEnd(40, '\0')))).toBeUndefined();
    expect(sniffAudioFormat(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});

describe('default codec', () => {
  it('says plainly that the sound of video clips needs a host decoder', async () => {
    const error = await createDefaultAudioCodec()
      .decode(fixture('sine-440-stereo-48k.m4a'), 'video/mp4')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnsupportedAudioError);
    expect((error as UnsupportedAudioError).format).toBe('mp4');
  });
});

describe('WAV', () => {
  it('keeps every detail through a float round trip', () => {
    const original = tone(48000, 2, 0.05, 1000);
    const back = decodeWav(encodeWav(original, 'float32'));
    expect(back.sampleRate).toBe(48000);
    expect(back.channels[1]).toEqual(original.channels[1]);
  });

  it('keeps 16 bit samples within one step', () => {
    const original = tone(48000, 1, 0.05, 1000);
    const back = decodeWav(encodeWav(original));
    const error = Math.max(
      ...Array.from(original.channels[0] ?? [], (value, i) =>
        Math.abs(value - (back.channels[0]?.[i] ?? 0)),
      ),
    );
    expect(error).toBeLessThan(1 / 32768);
    expect(measureFrequency(back)).toBeCloseTo(1000, -1);
  });

  function handmade(format: number, bits: number, samples: number[], extensible = false) {
    const width = bits / 8;
    const fmtSize = extensible ? 40 : 16;
    const bytes = new Uint8Array(12 + 8 + fmtSize + 8 + 8 + samples.length * width);
    const view = new DataView(bytes.buffer);
    const put = (at: number, text: string) => {
      for (let i = 0; i < 4; i++) view.setUint8(at + i, text.charCodeAt(i));
    };
    put(0, 'RIFF');
    put(8, 'WAVE');
    put(12, 'fmt ');
    view.setUint32(16, fmtSize, true);
    view.setUint16(20, extensible ? 0xfffe : format, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true);
    view.setUint16(34, bits, true);
    if (extensible) view.setUint16(20 + 8 + 24 - 8, format, true);
    let at = 20 + fmtSize;
    // An unknown chunk before the data must be skipped.
    put(at, 'LIST');
    view.setUint32(at + 4, 0, true);
    at += 8;
    put(at, 'data');
    view.setUint32(at + 4, samples.length * width, true);
    at += 8;
    for (const sample of samples) {
      if (bits === 8) view.setUint8(at, Math.round(sample * 128 + 128));
      if (bits === 24) {
        const value = Math.round(sample * 8388607);
        view.setUint8(at, value & 0xff);
        view.setUint8(at + 1, (value >> 8) & 0xff);
        view.setInt8(at + 2, value >> 16);
      }
      if (bits === 32 && format === 1) view.setInt32(at, Math.round(sample * 2147483647), true);
      if (bits === 64) view.setFloat64(at, sample, true);
      at += width;
    }
    return bytes;
  }

  it('reads 8, 24 and 32 bit integers and 64 bit floats', () => {
    for (const [format, bits] of [
      [1, 8],
      [1, 24],
      [1, 32],
      [3, 64],
    ] as const) {
      const pcm = decodeWav(handmade(format, bits, [0.5, -0.5]));
      expect(pcm.channels[0]?.[0]).toBeCloseTo(0.5, 2);
      expect(pcm.channels[0]?.[1]).toBeCloseTo(-0.5, 2);
    }
  });

  it('reads the extensible header and refuses what it cannot read', () => {
    expect(decodeWav(handmade(1, 24, [0.25], true)).channels[0]?.[0]).toBeCloseTo(0.25, 3);
    expect(() => decodeWav(handmade(2, 16, [0]))).toThrow(/not supported/);
    expect(() => decodeWav(new Uint8Array(4))).toThrow(/Not a WAV/);
  });
});
