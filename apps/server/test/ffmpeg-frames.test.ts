import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasFfmpeg } from '../src/ffmpeg-audio.js';
import { createFfmpegColorSampler, createFfmpegFrameGrabber } from '../src/ffmpeg-frames.js';

const clip = {
  bytes: new Uint8Array(
    readFileSync(new URL('../../../packages/audio/test/fixtures/clip-silent.mp4', import.meta.url)),
  ),
  mediaType: 'video/mp4',
};

const installed = await hasFfmpeg();

describe('stills through ffmpeg', () => {
  it('gives no stills when ffmpeg fails', async () => {
    expect(await createFfmpegFrameGrabber('false')(clip, [0.1, 0.2], 64)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it.skipIf(!installed)('takes a JPEG still per time and none past the end', async () => {
    const [first, late] = await createFfmpegFrameGrabber()(clip, [0.1, 30], 64);
    expect(first?.mediaType).toBe('image/jpeg');
    expect(Array.from(first?.bytes.slice(0, 2) ?? [])).toEqual([0xff, 0xd8]);
    expect(late).toBeUndefined();
  });
});

describe('colours through ffmpeg', () => {
  it('reads no colours when ffmpeg fails or is missing', async () => {
    expect(await createFfmpegColorSampler('false')(clip, [0.1])).toEqual([undefined]);
    expect(await createFfmpegColorSampler('no-such-ffmpeg-here')(clip, [0.1])).toEqual([undefined]);
  });

  it.skipIf(!installed)('reads the colours of a frame, and none past the end', async () => {
    const [first, late] = await createFfmpegColorSampler()(clip, [0.1, 30]);
    expect(first?.luma).toBeGreaterThanOrEqual(0);
    expect(first?.luma).toBeLessThanOrEqual(1);
    expect(first?.mean).toHaveLength(3);
    expect(late).toBeUndefined();
  });
});
