import { describe, expect, it } from 'vitest';
import {
  computePeaks,
  decodePeaks,
  encodePeaks,
  fadeGain,
  forEngine,
  frameCount,
  levels,
  panGains,
  placementSpan,
  renderBlock,
  resample,
  SAMPLE_RATE,
  snapSeconds,
  SoundPlacement,
  toDecibels,
  toFrames,
  toSeconds,
  toStereo,
  waveform,
  type StereoPcm,
} from '../src/index.js';
import { measureFrequency } from '../src/testing.js';

const sine = (rate: number, seconds: number, frequency: number, amplitude = 0.5): Float32Array =>
  Float32Array.from(
    { length: Math.round(rate * seconds) },
    (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / rate),
  );

/** A source that is 1 everywhere, so the mix shows the gains alone. */
const ones = (seconds: number): StereoPcm => {
  const frames = toFrames(seconds);
  return {
    sampleRate: SAMPLE_RATE,
    channels: [new Float32Array(frames).fill(1), new Float32Array(frames).fill(1)],
  };
};

const place = (fields: Partial<SoundPlacement> = {}): SoundPlacement =>
  SoundPlacement.parse({
    id: 'p',
    soundId: 's',
    startSeconds: 0,
    volume: 1,
    fadeInSeconds: 0,
    fadeOutSeconds: 0,
    loop: false,
    ...fields,
  });

describe('time', () => {
  it('snaps seconds to the sample grid and round-trips frames', () => {
    expect(toFrames(1)).toBe(48000);
    expect(toSeconds(24000)).toBe(0.5);
    expect(snapSeconds(0.1234567)).toBe(5926 / 48000);
    expect(snapSeconds(snapSeconds(0.1234567))).toBe(snapSeconds(0.1234567));
  });
});

describe('pcm', () => {
  it('resamples 44.1 kHz to 48 kHz keeping pitch, level and length', () => {
    const input = { sampleRate: 44100, channels: [sine(44100, 0.5, 1000)] };
    const output = resample(input, 48000);
    expect(output.sampleRate).toBe(48000);
    expect(frameCount(output)).toBe(24000);
    expect(measureFrequency(output)).toBeCloseTo(1000, 0);
    const middle = {
      sampleRate: 48000,
      channels: [output.channels[0]?.subarray(2000, 22000) ?? new Float32Array(0)],
    };
    expect(levels(middle).peak).toBeCloseTo(0.5, 2);
  });

  it('removes what a lower rate cannot hold when resampling down', () => {
    // 15 kHz is above the 12 kHz limit of a 24 kHz rate, so it must almost vanish.
    const output = resample({ sampleRate: 48000, channels: [sine(48000, 0.2, 15000)] }, 24000);
    const middle = {
      sampleRate: 24000,
      channels: [output.channels[0]?.subarray(500, 4300) ?? new Float32Array(0)],
    };
    expect(levels(middle).peak).toBeLessThan(0.02);
  });

  it('keeps a constant signal exactly constant and leaves a matching rate alone', () => {
    const flat = { sampleRate: 22050, channels: [new Float32Array(2205).fill(0.25)] };
    const up = resample(flat, 48000);
    expect(Math.max(...Array.from(up.channels[0] ?? [], (v) => Math.abs(v - 0.25)))).toBeLessThan(
      1e-6,
    );
    expect(resample(flat, 22050)).toBe(flat);
  });

  it('agrees between the tabulated filter and the point-by-point one for odd rates', () => {
    // 44 101 Hz shares no useful divisor with 48 kHz, so it takes the slow path.
    const odd = resample({ sampleRate: 44101, channels: [sine(44101, 0.05, 1000)] }, 48000);
    const usual = resample({ sampleRate: 44100, channels: [sine(44100, 0.05, 1000)] }, 48000);
    expect(frameCount(odd)).toBe(2400);
    const difference = Math.max(
      ...Array.from(odd.channels[0] ?? [], (value, i) =>
        Math.abs(value - (usual.channels[0]?.[i] ?? 0)),
      ).slice(200, 2200),
    );
    expect(difference).toBeLessThan(0.01);
  });

  it('makes stereo from mono and from more channels, and copes with none', () => {
    const mono = { sampleRate: 48000, channels: [new Float32Array([0.1, 0.2])] };
    const stereo = toStereo(mono);
    expect(Array.from(stereo.channels[1])).toEqual(Array.from(stereo.channels[0]));
    expect(stereo.channels[1]).not.toBe(stereo.channels[0]);
    const six = {
      sampleRate: 48000,
      channels: Array.from({ length: 6 }, (_, i) => new Float32Array([i])),
    };
    expect(toStereo(six).channels.map((c) => c[0])).toEqual([0, 1]);
    expect(frameCount(toStereo({ sampleRate: 48000, channels: [] }))).toBe(0);
    expect(forEngine(mono).sampleRate).toBe(SAMPLE_RATE);
  });

  it('measures levels in decibels', () => {
    expect(levels({ sampleRate: 1, channels: [new Float32Array([0.5, -1])] })).toEqual({
      peak: 1,
      rms: Math.sqrt(0.625),
    });
    expect(levels({ sampleRate: 1, channels: [] })).toEqual({ peak: 0, rms: 0 });
    expect(toDecibels(1)).toBe(0);
    expect(toDecibels(0.5)).toBeCloseTo(-6.02, 2);
    expect(toDecibels(0)).toBe(-Infinity);
  });
});

describe('peaks', () => {
  const pcm = { sampleRate: 48000, channels: [sine(48000, 3, 2), sine(48000, 3, 2, 0.25)] };
  const peaks = computePeaks(pcm);

  it('builds every level from the samples', () => {
    expect(peaks.frames).toBe(144000);
    expect(peaks.levels.map((level) => level.bucketFrames)).toEqual([256, 4096, 65536]);
    expect(peaks.levels[0]?.min.length).toBe(Math.ceil(144000 / 256));
    expect(peaks.levels[2]?.min.length).toBe(3);
    expect(Math.max(...(peaks.levels[2]?.max ?? []))).toBeCloseTo(0.5, 3);
  });

  it('draws a view of any width from the coarsest level fine enough', () => {
    const whole = waveform(peaks, 0, 144000, 3);
    expect(whole.max.every((value) => value > 0.49)).toBe(true);
    const close = waveform(peaks, 0, 12000, 10);
    expect(close.max).toHaveLength(10);
    // The first quarter second of a 2 Hz sine only rises.
    expect(close.min[0]).toBeGreaterThanOrEqual(-0.01);
    expect(waveform(peaks, 200000, 300000, 4)).toEqual({ min: [], max: [] });
    expect(waveform(peaks, 0, 100, 400).max).toHaveLength(400);
  });

  it('survives packing into bytes', () => {
    const back = decodePeaks(encodePeaks(peaks));
    expect(back.frames).toBe(peaks.frames);
    expect(back.levels.map((level) => level.bucketFrames)).toEqual([256, 4096, 65536]);
    expect(Array.from(back.levels[1]?.max ?? [])).toEqual(Array.from(peaks.levels[1]?.max ?? []));
  });
});

describe('renderer', () => {
  it('places a sound at its start, trimmed, at its volume', () => {
    const source = ones(1);
    const [left, right] = renderBlock(
      {
        placements: [place({ startSeconds: 0.5, trimStartSeconds: 0.75, volume: 0.5 })],
        source: () => source,
        endFrame: toFrames(2),
      },
      0,
      toFrames(2),
    );
    expect(left[toFrames(0.5) - 1]).toBe(0);
    expect(left[toFrames(0.5)]).toBe(0.5);
    expect(right[toFrames(0.75) - 1]).toBe(0.5);
    // A quarter second of source is left after the trim.
    expect(left[toFrames(0.75)]).toBe(0);
  });

  it('renders the same samples block by block as in one go', () => {
    const source = {
      sampleRate: SAMPLE_RATE,
      channels: [sine(48000, 1, 330), sine(48000, 1, 440)] as [Float32Array, Float32Array],
    };
    const input = {
      placements: [
        place({ startSeconds: 0.1, fadeInSeconds: 0.2, fadeOutSeconds: 0.3, pan: -0.4 }),
        place({ startSeconds: 0.3, volume: 0.25, loop: true }),
      ],
      source: () => source,
      endFrame: toFrames(1.5),
    };
    const [whole] = renderBlock(input, 0, toFrames(1.5));
    const parts = [0, 1, 2].map((i) => renderBlock(input, i * 24000, 24000)[0]);
    const joined = new Float32Array(toFrames(1.5));
    parts.forEach((part, i) => {
      joined.set(part, i * 24000);
    });
    expect(joined).toEqual(whole);
  });

  it('fades in and out with either curve', () => {
    expect(fadeGain(0, 100, 10, 10, 'linear')).toBe(0);
    expect(fadeGain(5, 100, 10, 10, 'linear')).toBe(0.5);
    expect(fadeGain(50, 100, 10, 10, 'linear')).toBe(1);
    expect(fadeGain(95, 100, 10, 10, 'linear')).toBe(0.5);
    expect(fadeGain(5, 100, 10, 0, 'smooth')).toBeCloseTo(0.5, 10);
    expect(fadeGain(2, 100, 10, 0, 'smooth')).toBeLessThan(0.2);
    expect(fadeGain(5, 10, 10, 10, 'linear')).toBe(0.25);
  });

  it('pans with the middle untouched', () => {
    expect(panGains(0)).toEqual([1, 1]);
    expect(panGains(1)).toEqual([0, 1]);
    expect(panGains(-0.5)).toEqual([1, 0.5]);
  });

  it('loops a placement to the end of the timeline or for its duration', () => {
    const source = ones(1);
    expect(placementSpan(place({ startSeconds: 1, loop: true }), source, toFrames(4))).toEqual({
      start: 48000,
      end: 192000,
      sourceStart: 0,
      sourceLength: 48000,
    });
    expect(
      placementSpan(place({ loop: true, durationSeconds: 2.5 }), source, toFrames(10))?.end,
    ).toBe(120000);
    expect(placementSpan(place({ durationSeconds: 2.5 }), source, toFrames(10))?.end).toBe(48000);
    expect(placementSpan(place({ durationSeconds: 0.25 }), source, toFrames(10))?.end).toBe(12000);
    expect(placementSpan(place({ trimStartSeconds: 2 }), source, toFrames(10))).toBeUndefined();
    expect(
      placementSpan(place({ startSeconds: 5, loop: true }), source, toFrames(4)),
    ).toBeUndefined();
    const [left] = renderBlock(
      { placements: [place({ loop: true })], source: () => source, endFrame: toFrames(3) },
      toFrames(2.5),
      10,
    );
    expect(left[9]).toBe(1);
  });

  it('skips silent, missing and out-of-block placements', () => {
    const [left] = renderBlock(
      {
        placements: [place({ volume: 0 }), place({ soundId: 'gone' }), place({ startSeconds: 5 })],
        source: (placement) => (placement.soundId === 'gone' ? undefined : ones(1)),
        endFrame: toFrames(10),
      },
      0,
      100,
    );
    expect(left.every((value) => value === 0)).toBe(true);
  });

  it('reads placements the Edit stage stored before the new fields existed', () => {
    const stored = {
      id: 'a',
      soundId: 'b',
      startSeconds: 1,
      volume: 0.4,
      fadeInSeconds: 0,
      fadeOutSeconds: 0,
      loop: false,
    };
    expect(SoundPlacement.parse(stored)).toMatchObject({
      durationSeconds: null,
      pan: 0,
      fadeCurve: 'linear',
      source: 'sound',
      trimStartSeconds: 0,
    });
  });
});
