import {
  CommandError,
  defineCommand,
  type Command,
  type CommandContext,
  type CoreRuntime,
} from '@imp/core';
import { z } from 'zod';
import { docDuration, regionDuration, type AudioDoc, type Track } from './doc.js';
import { measureLoudness } from './dsp/loudness.js';
import { Effect, EffectError, type EffectKind } from './effects.js';
import { UnsupportedAudioError } from './codec.js';
import type { SoundPlacement } from './placement.js';
import { MissingSourceError, type AudioSources } from './sources.js';

/** What the effect commands borrow from the document commands, so every edit goes the same way. */
export interface EffectCommandHelpers {
  readonly sources: (runtime: CoreRuntime) => AudioSources;
  load(runtime: CoreRuntime, id: string, projectId: string, docId: string): Promise<AudioDoc>;
  change(
    context: CommandContext,
    id: string,
    projectId: string,
    docId: string,
    label: string,
    edit: (doc: AudioDoc) => AudioDoc,
  ): Promise<AudioDoc>;
  regionOf(doc: AudioDoc, id: string, regionId: string): { track: Track; region: SoundPlacement };
  trackOf(doc: AudioDoc, id: string, trackId: string): Track;
  mixRange(
    runtime: CoreRuntime,
    doc: AudioDoc,
    from: number,
    to: number,
  ): Promise<{ channels: Float32Array[]; unheard: string[] }>;
  checkRange(id: string, from: number, to: number): void;
  readonly outline: z.ZodType;
  done(doc: AudioDoc): unknown;
}

const ProjectId = z.string().min(1).describe('The id of a project from project.list.');
const DocId = z.string().min(1).describe('The id of an audio document from audio.doc.list.');

const target = {
  projectId: ProjectId,
  docId: DocId,
  regionIds: z.array(z.string().min(1)).min(1).optional().describe('The regions to change.'),
  trackId: z.string().min(1).optional().describe('Or a track, for all its regions.'),
};

const round2 = (value: number): number => Math.round(value * 100) / 100;
const finite = (value: number): number | null => (Number.isFinite(value) ? round2(value) : null);

/** The settings of each kind, without the kind itself. */
const settingsOf = (kind: EffectKind): z.ZodRawShape => {
  const option = Effect.options.find((candidate) => candidate.shape.kind.value === kind);
  if (option === undefined) throw new Error(`No effect "${kind}".`);
  return Object.fromEntries(Object.entries(option.shape).filter(([key]) => key !== 'kind'));
};

/**
 * Puts an effect in place of the one of its kind, or adds it: noise
 * reduction first, since it must hear the noise as it was recorded, and
 * everything else at the end.
 */
function placeEffect(chain: readonly Effect[], effect: Effect): Effect[] {
  const at = chain.findIndex((existing) => existing.kind === effect.kind);
  if (at !== -1) return chain.map((existing, i) => (i === at ? effect : existing));
  return effect.kind === 'denoise' ? [effect, ...chain] : [...chain, effect];
}

export function createEffectCommands(helpers: EffectCommandHelpers): readonly Command[] {
  const regionsIn = (
    doc: AudioDoc,
    id: string,
    regionIds?: string[],
    trackId?: string,
  ): string[] => {
    const chosen =
      regionIds ??
      (trackId === undefined
        ? undefined
        : helpers.trackOf(doc, id, trackId).regions.map((r) => r.id));
    if (chosen === undefined || chosen.length === 0) {
      throw new CommandError('invalid_input', id, 'Name regionIds, or a trackId that has regions.');
    }
    for (const regionId of chosen) {
      const { region } = helpers.regionOf(doc, id, regionId);
      if (region.blobKey === '') {
        throw new CommandError(
          'invalid_input',
          id,
          `Region "${regionId}" has no sound to process.`,
        );
      }
    }
    return chosen;
  };

  /**
   * Sets new chains on regions. Each chain is rendered first, so a chain that
   * cannot work (a noise stretch outside the sound, a clip that cannot be
   * decoded here) is refused before anything changes, and the processed
   * sound is ready to play when the command returns.
   */
  async function setChains(
    context: CommandContext,
    id: string,
    projectId: string,
    docId: string,
    label: string,
    chains: ReadonlyMap<string, Effect[]>,
  ) {
    const doc = await helpers.load(context.runtime, id, projectId, docId);
    const sources = helpers.sources(context.runtime);
    for (const [regionId, chain] of chains) {
      const { region } = helpers.regionOf(doc, id, regionId);
      try {
        await sources.processedKey(region.blobKey, chain);
      } catch (error) {
        if (
          error instanceof EffectError ||
          error instanceof MissingSourceError ||
          error instanceof UnsupportedAudioError
        ) {
          const name = region.label === '' ? regionId : region.label;
          throw new CommandError('invalid_input', id, `${name}: ${error.message}`, {
            cause: error,
          });
        }
        throw error;
      }
    }
    return helpers.done(
      await helpers.change(context, id, projectId, docId, label, (current) => ({
        ...current,
        tracks: current.tracks.map((track) => ({
          ...track,
          regions: track.regions.map((region) => {
            const chain = chains.get(region.id);
            return chain === undefined ? region : { ...region, effects: chain };
          }),
        })),
      })),
    );
  }

  /** One command per effect kind: add it to regions, or adjust the one they have. */
  const kindCommand = (
    kind: Exclude<EffectKind, 'denoise'>,
    title: string,
    description: string,
  ): Command => {
    const shape = settingsOf(kind);
    const id = `audio.fx.${kind}`;
    const Input = z.object({ ...target, ...shape });
    const Target = z.object(target);
    return defineCommand({
      id,
      title,
      description: `${description} Adds it at the end of each region's effects, or adjusts the one already there in its place. Works on the region's whole source; listen or use audio.analyze to check the result, and audio.fx.remove to take it off.`,
      effect: 'write',
      input: Input,
      output: helpers.outline,
      handler: async (context, input) => {
        const { projectId, docId, regionIds, trackId } = Target.parse(input);
        const settings = Object.fromEntries(
          Object.entries(input as Record<string, unknown>).filter(([key]) => !(key in target)),
        );
        const doc = await helpers.load(context.runtime, id, projectId, docId);
        const effect = Effect.parse({ ...settings, kind });
        const chains = new Map(
          regionsIn(doc, id, regionIds, trackId).map((regionId) => [
            regionId,
            placeEffect(helpers.regionOf(doc, id, regionId).region.effects, effect),
          ]),
        );
        return setChains(context, id, projectId, docId, title, chains);
      },
    });
  };

  const eq = kindCommand(
    'eq',
    'Equalize',
    'Shapes the tone of regions with up to 8 bands. Typical: highpass at 80 to 100 Hz on dialogue to remove rumble and handling noise; a bell cut of 3 to 6 dB at a boxy 300 to 500 Hz; a gentle bell boost around 3 kHz for clarity; lowpass around 8 to 12 kHz to soften hiss.',
  );
  const compressor = kindCommand(
    'compressor',
    'Compress',
    'Evens out the level of regions: sound above the threshold is turned down by the ratio. Dialogue: threshold -20 dB, ratio 3, attack 10 ms, release 150 ms, with makeup gain to win the level back.',
  );
  const limiter = kindCommand(
    'limiter',
    'Limit',
    'Keeps every peak of regions under a ceiling (default -1 dBFS) without clipping; use it last.',
  );
  const loudness = kindCommand(
    'loudness',
    'Set loudness',
    'Raises or lowers regions to an integrated loudness (LUFS), with true peaks kept under a ceiling: -23 LUFS for broadcast (EBU R 128), -16 for online video, -14 for streaming music. Each region is set on its own, so lines recorded at different levels match.',
  );

  const denoise = defineCommand({
    id: 'audio.fx.denoise',
    title: 'Reduce noise',
    description:
      'Reduces steady noise (hiss, hum, room tone, wind) in a region. Name a stretch of the timeline inside the region where only the noise can be heard (at least 50 ms; half a second or more is better): the noise is learned from it and turned down everywhere. Use audio.waveform to find a quiet stretch. reductionDb: 12 gentle, 18 normal, 24 strong; sensitivityDb above 6 removes more but may dull quiet speech. Adjusts the existing noise reduction in place.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      docId: DocId,
      regionId: z.string().min(1),
      noiseFromSeconds: z
        .number()
        .min(0)
        .describe('Timeline seconds where the noise alone starts.'),
      noiseToSeconds: z.number().positive().describe('Timeline seconds where it ends.'),
      reductionDb: z.number().min(0).max(48).default(18),
      sensitivityDb: z.number().min(0).max(24).default(6),
    }),
    output: helpers.outline,
    handler: async (context, input) => {
      const id = 'audio.fx.denoise';
      const doc = await helpers.load(context.runtime, id, input.projectId, input.docId);
      const [regionId] = regionsIn(doc, id, [input.regionId]);
      const { region } = helpers.regionOf(doc, id, regionId ?? input.regionId);
      const end = region.startSeconds + regionDuration(region);
      if (input.noiseFromSeconds < region.startSeconds || input.noiseToSeconds > end + 1e-6) {
        throw new CommandError(
          'invalid_input',
          id,
          `The noise stretch must lie inside the region, from ${region.startSeconds.toFixed(3)} to ${end.toFixed(3)} seconds.`,
        );
      }
      helpers.checkRange(id, input.noiseFromSeconds, input.noiseToSeconds);
      // Stored in seconds of the source, so moving or trimming the region keeps it.
      const offset = region.trimStartSeconds - region.startSeconds;
      const effect = Effect.parse({
        kind: 'denoise',
        noiseFromSeconds: input.noiseFromSeconds + offset,
        noiseToSeconds: input.noiseToSeconds + offset,
        reductionDb: input.reductionDb,
        sensitivityDb: input.sensitivityDb,
      });
      return setChains(
        context,
        id,
        input.projectId,
        input.docId,
        'Reduce noise',
        new Map([[region.id, placeEffect(region.effects, effect)]]),
      );
    },
  });

  const set = defineCommand({
    id: 'audio.fx.set',
    title: 'Set effects',
    description:
      "Replaces the whole effect chain of regions with the one given, in order. Use it to reorder effects or copy one region's chain to others (read it from audio.doc.get). An empty list removes every effect.",
    effect: 'write',
    input: z.object({ ...target, effects: z.array(Effect).max(12) }),
    output: helpers.outline,
    handler: async (context, { projectId, docId, regionIds, trackId, effects }) => {
      const doc = await helpers.load(context.runtime, 'audio.fx.set', projectId, docId);
      const chains = new Map(
        regionsIn(doc, 'audio.fx.set', regionIds, trackId).map((regionId) => [regionId, effects]),
      );
      return setChains(context, 'audio.fx.set', projectId, docId, 'Set effects', chains);
    },
  });

  const remove = defineCommand({
    id: 'audio.fx.remove',
    title: 'Remove effects',
    description: 'Takes effects off regions: those of one kind, or all of them.',
    effect: 'write',
    input: z.object({
      ...target,
      kind: z
        .enum(['eq', 'compressor', 'limiter', 'denoise', 'loudness'])
        .optional()
        .describe('Leave out to remove every effect.'),
    }),
    output: helpers.outline,
    handler: async (context, { projectId, docId, regionIds, trackId, kind }) => {
      const doc = await helpers.load(context.runtime, 'audio.fx.remove', projectId, docId);
      const chains = new Map(
        regionsIn(doc, 'audio.fx.remove', regionIds, trackId).map((regionId) => [
          regionId,
          kind === undefined
            ? []
            : helpers
                .regionOf(doc, 'audio.fx.remove', regionId)
                .region.effects.filter((effect) => effect.kind !== kind),
        ]),
      );
      return setChains(context, 'audio.fx.remove', projectId, docId, 'Remove effects', chains);
    },
  });

  const analyze = defineCommand({
    id: 'audio.analyze',
    title: 'Measure loudness',
    description:
      'Measures an audio document as it plays (or one region of it, or a stretch): integrated loudness in LUFS, the loudest 3 seconds, the loudness range, true peak and sample peak. Reads numbers only. Targets: -23 LUFS broadcast, -16 online video, -14 streaming music; true peak at most -1 dBTP. Dialogue should sit near the target, music under it.',
    effect: 'read',
    input: z.object({
      projectId: ProjectId,
      docId: DocId,
      regionId: z.string().min(1).optional().describe('Measure only this region, as it plays.'),
      fromSeconds: z.number().min(0).optional(),
      toSeconds: z.number().positive().optional(),
    }),
    output: z.object({
      fromSeconds: z.number(),
      toSeconds: z.number(),
      integratedLufs: z.number().nullable().describe('Null when it is silent.'),
      shortTermMaxLufs: z.number().nullable(),
      rangeLu: z.number(),
      truePeakDb: z.number().nullable(),
      samplePeakDb: z.number().nullable(),
      unheard: z.array(z.string()),
    }),
    handler: async ({ runtime }, input) => {
      const id = 'audio.analyze';
      let doc = await helpers.load(runtime, id, input.projectId, input.docId);
      let from = input.fromSeconds ?? 0;
      let to = input.toSeconds ?? docDuration(doc);
      if (input.regionId !== undefined) {
        const { track, region } = helpers.regionOf(doc, id, input.regionId);
        doc = {
          ...doc,
          tracks: [{ ...track, mute: false, solo: false, regions: [region] }],
        };
        from = input.fromSeconds ?? region.startSeconds;
        to = input.toSeconds ?? region.startSeconds + regionDuration(region);
      }
      // Long enough for a whole film reel; longer takes too long to measure in one go.
      to = Math.min(to, from + 30 * 60);
      helpers.checkRange(id, from, to);
      const { channels, unheard } = await helpers.mixRange(runtime, doc, from, to);
      const report = measureLoudness(channels);
      return {
        fromSeconds: round2(from),
        toSeconds: round2(to),
        integratedLufs: finite(report.integratedLufs),
        shortTermMaxLufs: finite(report.shortTermMaxLufs),
        rangeLu: round2(report.rangeLu),
        truePeakDb: finite(report.truePeakDb),
        samplePeakDb: finite(report.samplePeakDb),
        unheard,
      };
    },
  });

  const processed = defineCommand({
    id: 'audio.fx.processed',
    title: 'Get processed sound',
    description:
      'Returns the key of a stored sound with effects applied, rendering it once if needed. Players use it to play a region as it sounds; agents rarely need it.',
    effect: 'read',
    input: z.object({ key: z.string().min(1), effects: z.array(Effect).max(12) }),
    output: z.object({ key: z.string() }),
    handler: async ({ runtime }, { key, effects }) => {
      try {
        return { key: await helpers.sources(runtime).processedKey(key, effects) };
      } catch (error) {
        if (
          error instanceof EffectError ||
          error instanceof MissingSourceError ||
          error instanceof UnsupportedAudioError
        ) {
          throw new CommandError('invalid_input', 'audio.fx.processed', error.message, {
            cause: error,
          });
        }
        throw error;
      }
    },
  });

  return [eq, compressor, limiter, denoise, loudness, set, remove, analyze, processed];
}
