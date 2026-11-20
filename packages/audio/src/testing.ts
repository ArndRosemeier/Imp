import { describe, expect, it } from 'vitest';
import type { AudioCodec } from './codec.js';
import { UnsupportedAudioError } from './codec.js';
import type { Pcm } from './pcm.js';
import { frameCount, levels } from './pcm.js';

/** A known test file: a steady sine tone, and what decoding it must give. */
export interface AudioFixture {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationSeconds: number;
  /** The tone's frequency in hertz. */
  readonly frequency: number;
  /** The tone's peak level, 0 to 1. */
  readonly peak: number;
}

/** The pitch of a steady tone, from how often it crosses zero going up. */
export function measureFrequency(pcm: Pcm): number {
  const channel = pcm.channels[0] ?? new Float32Array(0);
  // Skip the edges, where encoders pad and fade.
  const from = Math.floor(channel.length * 0.2);
  const to = Math.floor(channel.length * 0.8);
  let first = -1;
  let last = -1;
  let crossings = 0;
  for (let i = from + 1; i < to; i++) {
    if ((channel[i - 1] ?? 0) < 0 && (channel[i] ?? 0) >= 0) {
      if (first < 0) first = i;
      last = i;
      crossings += 1;
    }
  }
  return crossings < 2 ? 0 : ((crossings - 1) * pcm.sampleRate) / (last - first);
}

/**
 * The contract every audio codec must pass, in every host it runs in. Call it
 * with a factory and the fixtures the codec claims to read.
 */
export function describeAudioCodecContract(
  name: string,
  createCodec: () => AudioCodec,
  fixtures: readonly AudioFixture[],
): void {
  describe(`${name} (AudioCodec contract)`, () => {
    for (const fixture of fixtures) {
      it(`decodes ${fixture.name}`, async () => {
        const pcm = await createCodec().decode(fixture.bytes, fixture.mediaType);
        expect(pcm.sampleRate).toBe(fixture.sampleRate);
        // Some decoders return mono as two equal channels; the engine plays stereo either way.
        expect([fixture.channels, 2]).toContain(pcm.channels.length);
        const seconds = frameCount(pcm) / pcm.sampleRate;
        // Lossy encoders add up to a few dozen milliseconds of padding.
        expect(Math.abs(seconds - fixture.durationSeconds)).toBeLessThan(0.08);
        expect(measureFrequency(pcm)).toBeCloseTo(fixture.frequency, -1);
        expect(levels(pcm).peak).toBeGreaterThan(fixture.peak * 0.8);
        expect(levels(pcm).peak).toBeLessThan(fixture.peak * 1.25);
      });
    }

    it('refuses bytes that are no sound format', async () => {
      const junk = Uint8Array.from('This is not audio at all, just text.', (char) =>
        char.charCodeAt(0),
      );
      await expect(createCodec().decode(junk, 'audio/mpeg')).rejects.toBeInstanceOf(
        UnsupportedAudioError,
      );
    });
  });
}
