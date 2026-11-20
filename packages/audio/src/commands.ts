import { CommandError, defineCommand, type BlobStore, type Command } from '@imp/core';
import { z } from 'zod';
import type { AudioCodec } from './codec.js';
import { UnsupportedAudioError } from './codec.js';
import { createAudioDocCommands } from './doc-commands.js';
import { toDecibels } from './pcm.js';
import { waveform } from './peaks.js';
import { AudioSources, MissingSourceError } from './sources.js';
import { toFrames } from './time.js';

export interface AudioCommandOptions {
  readonly codec: AudioCodec;
}

/** Decibels rounded to a tenth, with silence as null (JSON has no infinity). */
function decibels(level: number): number | null {
  const value = toDecibels(level);
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * The commands of the audio engine. They work on any stored sound by its blob
 * key, whichever mode made it, so they belong to no mode.
 */
export function createAudioCommands(options: AudioCommandOptions): readonly Command[] {
  // One decoded-sound cache per store, shared by every command.
  const caches = new WeakMap<BlobStore, AudioSources>();
  const sourcesFor = (blobs: BlobStore): AudioSources => {
    let sources = caches.get(blobs);
    if (sources === undefined) {
      sources = new AudioSources(blobs, options.codec);
      caches.set(blobs, sources);
    }
    return sources;
  };
  const describe = async (blobs: BlobStore, id: string, key: string) => {
    try {
      return await sourcesFor(blobs).describe(key);
    } catch (error) {
      if (error instanceof MissingSourceError || error instanceof UnsupportedAudioError) {
        throw new CommandError('invalid_input', id, error.message, { cause: error });
      }
      throw error;
    }
  };

  const inspect = defineCommand({
    id: 'audio.inspect',
    title: 'Inspect a sound',
    description:
      'Measures a stored sound by its key (the blobKey of a sound take, dialogue or voice sample): how long it is, its sample rate and channels, and how loud it is (peak and average level in dB below full scale; 0 dB is the loudest possible, around -20 dB average is normal speech). Reads numbers only, so it costs little context. Use it to compare levels before mixing or to check a sound is not clipped.',
    effect: 'read',
    input: z.object({ key: z.string().min(1).describe('The blob key of the sound.') }),
    output: z.object({
      durationSeconds: z.number(),
      sampleRate: z.number(),
      channels: z.number(),
      peakDb: z.number().nullable().describe('The loudest sample; null for silence.'),
      rmsDb: z.number().nullable().describe('The average level; null for silence.'),
      clipped: z.boolean().describe('Whether samples reach full scale, which sounds distorted.'),
    }),
    handler: async ({ runtime }, { key }) => {
      const { info } = await describe(runtime.blobs, 'audio.inspect', key);
      return {
        durationSeconds: round(info.durationSeconds, 3),
        sampleRate: info.sourceSampleRate,
        channels: info.sourceChannels,
        peakDb: decibels(info.peak),
        rmsDb: decibels(info.rms),
        clipped: info.peak >= 0.999,
      };
    },
  });

  const shape = defineCommand({
    id: 'audio.waveform',
    title: 'Read a waveform',
    description:
      'Returns the outline of a stored sound between two times: for each of a number of equal slices, the lowest and highest sample (-1 to 1). Near zero is quiet; near -1 or 1 is loud. Use few slices (20 to 100) to see where sound and pauses are without listening.',
    effect: 'read',
    input: z.object({
      key: z.string().min(1).describe('The blob key of the sound.'),
      fromSeconds: z.number().min(0).default(0),
      toSeconds: z.number().positive().optional().describe('Defaults to the end of the sound.'),
      buckets: z.number().int().min(1).max(4000).default(50).describe('How many slices.'),
    }),
    output: z.object({
      fromSeconds: z.number(),
      toSeconds: z.number(),
      min: z.array(z.number()),
      max: z.array(z.number()),
    }),
    handler: async ({ runtime }, { key, fromSeconds, toSeconds, buckets }) => {
      const { info, peaks } = await describe(runtime.blobs, 'audio.waveform', key);
      const end = Math.min(toSeconds ?? info.durationSeconds, info.durationSeconds);
      if (end <= fromSeconds) {
        throw new CommandError(
          'invalid_input',
          'audio.waveform',
          `The sound is ${info.durationSeconds.toFixed(3)} seconds long; ask for a range inside it.`,
        );
      }
      const outline = waveform(peaks, toFrames(fromSeconds), toFrames(end), buckets);
      return {
        fromSeconds,
        toSeconds: round(end, 3),
        min: outline.min.map((value) => round(value, 3)),
        max: outline.max.map((value) => round(value, 3)),
      };
    },
  });

  return [
    inspect,
    shape,
    ...createAudioDocCommands({ sources: (runtime) => sourcesFor(runtime.blobs) }),
  ];
}
