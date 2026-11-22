import { describe, expect, it } from 'vitest';
import {
  describeVideoModel,
  fitDuration,
  fitResolution,
  mp3DurationSeconds,
  type ModelInfo,
  type VideoAbilities,
} from '../src/index.js';

const model = (
  video?: Partial<VideoAbilities>,
  output: ModelInfo['outputModalities'] = ['video'],
) =>
  ({
    id: 'vendor/clips',
    name: 'Clips',
    inputModalities: ['text'],
    outputModalities: output,
    contextLength: null,
    supportsTools: false,
    pricing: { promptUsdPerToken: null, completionUsdPerToken: null },
    ...(video === undefined
      ? {}
      : {
          video: {
            durationsSeconds: [4, 6, 8],
            resolutions: ['720p', '1080p'],
            aspectRatios: ['16:9', '9:16'],
            frameImages: ['first_frame', 'last_frame'],
            nativeAudio: true,
            ...video,
          },
        }),
  }) satisfies ModelInfo;

describe('describeVideoModel', () => {
  it('lists what a model can do, and accepts it', () => {
    expect(describeVideoModel(model({}))).toEqual({
      fits: true,
      problem: null,
      notes: ['4, 6, 8 s', 'own sound', 'start picture'],
    });
    expect(
      describeVideoModel(
        model({ durationsSeconds: [4, 5, 6, 7, 8], nativeAudio: false, frameImages: [] }),
      ).notes,
    ).toEqual(['4–8 s', 'no sound']);
    expect(describeVideoModel(model({ durationsSeconds: [5], nativeAudio: null })).notes).toEqual([
      '5 s',
      'start picture',
    ]);
  });

  it('turns away a model that makes no sound', () => {
    expect(describeVideoModel(model({ nativeAudio: false }))).toMatchObject({
      fits: false,
      problem: expect.stringContaining('no sound') as string,
    });
  });

  it('gives a model that says nothing the benefit of the doubt', () => {
    expect(describeVideoModel(model())).toEqual({ fits: true, problem: null, notes: [] });
  });

  it('turns away what makes no video, works on existing footage or cannot make 16:9', () => {
    expect(describeVideoModel(model(undefined, ['text']))).toMatchObject({ fits: false });
    expect(describeVideoModel(model({ durationsSeconds: [] }))).toMatchObject({
      fits: false,
      problem: expect.stringContaining('photo or an existing video') as string,
    });
    expect(describeVideoModel(model({ aspectRatios: ['9:16', '1:1'] }))).toMatchObject({
      fits: false,
      problem: 'It cannot make 16:9 pictures.',
    });
    // No shapes listed means it does not say, not that it makes none.
    expect(describeVideoModel(model({ aspectRatios: [] })).fits).toBe(true);
  });
});

describe('fitDuration and fitResolution', () => {
  const video = model({}).video;
  it('asks for the shortest length that is long enough, else the longest', () => {
    expect(fitDuration(video, 4)).toBe(4);
    expect(fitDuration(video, 5)).toBe(6);
    expect(fitDuration(video, 20)).toBe(8);
    expect(fitDuration(undefined, 5)).toBe(5);
    expect(fitDuration(model({ durationsSeconds: [] }).video, 5)).toBe(5);
  });

  it('keeps the resolution when it is made, else takes the nearest, the lower on a tie', () => {
    expect(fitResolution(video, '720p')).toBe('720p');
    expect(fitResolution(video, '480p')).toBe('720p');
    expect(fitResolution(video, '4K')).toBe('1080p');
    expect(fitResolution(model({ resolutions: ['480p', '768p'] }).video, '720p')).toBe('768p');
    expect(fitResolution(model({ resolutions: ['480p', '1080p'] }).video, '720p')).toBe('480p');
    expect(fitResolution(model({ resolutions: ['1080p', '2K'] }).video, '4K')).toBe('2K');
    expect(fitResolution(undefined, '720p')).toBe('720p');
    expect(fitResolution(model({ resolutions: [] }).video, '720p')).toBe('720p');
    expect(fitResolution(model({ resolutions: ['hd', 'sd'] }).video, '720p')).toBe('hd');
    expect(fitResolution(model({ resolutions: ['hd'] }).video, 'big')).toBe('hd');
  });
});

describe('mp3DurationSeconds', () => {
  const frame = (header: number[], length: number) => {
    const bytes = new Uint8Array(length);
    bytes.set(header);
    return bytes;
  };
  const join = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((part) => [...part]));

  it('adds up the frames, after a tag and between stray bytes', () => {
    // MPEG 1 layer III, 128 kbit/s, 44.1 kHz: 417 bytes and 1152 samples a frame.
    const loud = frame([0xff, 0xfb, 0x90, 0x00], 417);
    const tag = frame([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 3], 13);
    const stray = new Uint8Array([0, 0, 0]);
    const expected = (10 * 1152) / 44100;
    expect(mp3DurationSeconds(join(tag, ...Array<Uint8Array>(10).fill(loud)))).toBeCloseTo(
      expected,
      6,
    );
    expect(mp3DurationSeconds(join(stray, ...Array<Uint8Array>(10).fill(loud)))).toBeCloseTo(
      expected,
      6,
    );
    // A padded frame is one byte longer.
    expect(mp3DurationSeconds(join(frame([0xff, 0xfb, 0x92, 0x00], 418), loud))).toBeCloseTo(
      (2 * 1152) / 44100,
      6,
    );
  });

  it('knows the shorter frames of MPEG 2', () => {
    // 64 kbit/s, 22.05 kHz: 208 bytes and 576 samples a frame.
    const quiet = frame([0xff, 0xf3, 0x80, 0x00], 208);
    expect(mp3DurationSeconds(join(quiet, quiet, quiet))).toBeCloseTo((3 * 576) / 22050, 6);
  });

  it('says nothing about bytes that are not MP3', () => {
    expect(mp3DurationSeconds(new Uint8Array())).toBeNull();
    expect(mp3DurationSeconds(new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 5]))).toBeNull();
    // Layer II, free bitrate and reserved sample rate are not speech from this service.
    expect(mp3DurationSeconds(new Uint8Array([0xff, 0xfd, 0x90, 0x00]))).toBeNull();
    expect(mp3DurationSeconds(new Uint8Array([0xff, 0xfb, 0x00, 0x00]))).toBeNull();
    expect(mp3DurationSeconds(new Uint8Array([0xff, 0xfb, 0x9c, 0x00]))).toBeNull();
  });
});
