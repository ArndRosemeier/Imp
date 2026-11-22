import {
  CommandError,
  decodeUtf8,
  defineCommand,
  encodeUtf8,
  requireProject,
  type Command,
  chosenModel,
} from '@imp/core';
import { z } from 'zod';
import { UnsupportedAudioError } from './codec.js';
import { deleteRange, docDuration, regionEnd, silenceRange, type AudioDoc } from './doc.js';
import type { EffectCommandHelpers } from './fx-commands.js';
import { resample } from './pcm.js';
import { MissingSourceError } from './sources.js';
import { placeWords, Transcript, wordSpan, type PlacedWord } from './transcript.js';
import { encodeWav } from './wav.js';

/** The setting that names the model sound is written down with when a call does not say. */
export const TRANSCRIPTION_MODEL_SETTING = 'transcription.model';

/** What a transcription model gives back. The host connects this to its provider. */
export type Transcriber = (request: {
  model: string;
  audio: { bytes: Uint8Array; mediaType: string };
  language?: string;
}) => Promise<{
  text: string;
  words: readonly { text: string; startSeconds: number; endSeconds: number }[];
  language: string | null;
  costUsd: number | null;
}>;

/** Longer files go to the model in pieces too big for one request. */
const MAX_SECONDS = 600;
/** Speech needs no more: 16 kHz mono is what transcription models listen at. */
const SPEECH_RATE = 16_000;

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

const Word = z.object({
  index: z.number().int(),
  text: z.string(),
  startSeconds: z.number(),
  endSeconds: z.number(),
});
const RegionText = z.object({
  trackId: z.string(),
  regionId: z.string(),
  label: z.string(),
  transcribed: z.boolean().describe('False until audio.transcribe has written it down.'),
  text: z.string(),
  words: z.array(Word).describe('In document time, numbered from 0 within the region.'),
});
type RegionText = z.infer<typeof RegionText>;

/**
 * Editing dialogue by its words: sound is written down once per file, with a
 * time for every word, and words can then be found, cut or silenced as text.
 */
export function createTranscriptCommands(
  helpers: EffectCommandHelpers,
  transcribe: Transcriber | undefined,
): readonly Command[] {
  const transcriptKey = async (
    sources: ReturnType<EffectCommandHelpers['sources']>,
    key: string,
  ): Promise<string> => `${await sources.cacheFolder(key)}/transcript.json`;

  async function readTranscript(
    sources: ReturnType<EffectCommandHelpers['sources']>,
    blobs: Parameters<EffectCommandHelpers['sources']>[0]['blobs'],
    key: string,
  ): Promise<Transcript | undefined> {
    if (key === '') return undefined;
    let stored;
    try {
      stored = await blobs.get(await transcriptKey(sources, key));
    } catch (error) {
      if (error instanceof MissingSourceError) return undefined;
      throw error;
    }
    if (stored === undefined) return undefined;
    const parsed = Transcript.safeParse(JSON.parse(decodeUtf8(stored.bytes)));
    return parsed.success ? parsed.data : undefined;
  }

  async function regionTexts(
    runtime: Parameters<EffectCommandHelpers['sources']>[0],
    doc: AudioDoc,
    trackIds?: readonly string[],
  ): Promise<RegionText[]> {
    const sources = helpers.sources(runtime);
    const cache = new Map<string, Transcript | undefined>();
    const texts: RegionText[] = [];
    for (const track of doc.tracks) {
      if (trackIds !== undefined && !trackIds.includes(track.id)) continue;
      for (const region of [...track.regions].sort((a, b) => a.startSeconds - b.startSeconds)) {
        if (!cache.has(region.blobKey)) {
          cache.set(region.blobKey, await readTranscript(sources, runtime.blobs, region.blobKey));
        }
        const transcript = cache.get(region.blobKey);
        const words = transcript === undefined ? [] : placeWords(region, transcript);
        texts.push({
          trackId: track.id,
          regionId: region.id,
          label: region.label,
          transcribed: transcript !== undefined,
          text: words.map((word) => word.text).join(' '),
          words: words.map((word, index) => ({
            index,
            text: word.text,
            startSeconds: round3(word.startSeconds),
            endSeconds: round3(word.endSeconds),
          })),
        });
      }
    }
    return texts;
  }

  const ProjectId = z.string().min(1).describe('The id of a project from project.list.');
  const DocId = z.string().min(1).describe('The id of an audio document from audio.doc.list.');

  const write = defineCommand({
    id: 'audio.transcribe',
    title: 'Write down what is said',
    description: `Writes down what is said in the regions of an audio document, word by word with times, so dialogue can be edited by its words (audio.transcript.get, audio.words.delete). Each file is written down once and kept; regions cut from it later find their words without a new call. Costs a little money at the transcription model (well under a cent a minute for most).`,
    effect: 'spend',
    input: z.object({
      projectId: ProjectId,
      docId: DocId,
      regionIds: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe('The regions to write down; every region of the document when left out.'),
      model: z
        .string()
        .min(1)
        .optional()
        .describe(
          `A model from models.list with output "transcription" that gives word times. Defaults to the setting "${TRANSCRIPTION_MODEL_SETTING}". Passing one writes the files down again with it.`,
        ),
      language: z
        .string()
        .regex(/^[a-z]{2}$/)
        .optional()
        .describe('An ISO 639-1 code such as "en"; detected when left out.'),
    }),
    output: z.object({
      written: z.number().int().describe('Files sent to the model.'),
      kept: z.number().int().describe('Files already written down.'),
      costUsd: z.number().nullable(),
      regions: z.array(RegionText),
    }),
    estimate: async ({ runtime }, input) => {
      const doc = await helpers.load(runtime, 'audio.transcribe', input.projectId, input.docId);
      const seconds = docDuration(doc);
      return {
        kind: 'transcription',
        model: await chosenModel(runtime.store, TRANSCRIPTION_MODEL_SETTING, input.model),
        ...(seconds > 0 ? { seconds } : {}),
      };
    },
    handler: async ({ runtime }, input) => {
      const id = 'audio.transcribe';
      await requireProject(runtime.store, id, input.projectId);
      const doc = await helpers.load(runtime, id, input.projectId, input.docId);
      if (transcribe === undefined) {
        throw new CommandError('handler_failed', id, 'Nothing here can write sound down.');
      }
      const chosen =
        input.regionIds === undefined
          ? doc.tracks.flatMap((track) => track.regions)
          : input.regionIds.map((regionId) => helpers.regionOf(doc, id, regionId).region);
      const model =
        input.model ?? (await runtime.store.get(`settings/${TRANSCRIPTION_MODEL_SETTING}`));
      if (typeof model !== 'string' || model === '') {
        throw new CommandError(
          'invalid_input',
          id,
          `No transcription model is chosen. Set the setting "${TRANSCRIPTION_MODEL_SETTING}" to an id from models.list with output "transcription", or pass a model.`,
        );
      }
      const sources = helpers.sources(runtime);
      const keys = [...new Set(chosen.map((region) => region.blobKey))].filter((key) => key !== '');
      let written = 0;
      let kept = 0;
      let costUsd: number | null = null;
      for (const key of keys) {
        const existing = await readTranscript(sources, runtime.blobs, key);
        if (existing !== undefined && (input.model === undefined || existing.model === model)) {
          kept++;
          continue;
        }
        let pcm;
        try {
          pcm = await sources.pcm(key);
        } catch (error) {
          if (error instanceof MissingSourceError || error instanceof UnsupportedAudioError) {
            throw new CommandError('invalid_input', id, error.message, { cause: error });
          }
          throw error;
        }
        const [left, right] = pcm.channels;
        const durationSeconds = left.length / pcm.sampleRate;
        if (durationSeconds > MAX_SECONDS) {
          throw new CommandError(
            'invalid_input',
            id,
            `"${key}" is ${String(Math.round(durationSeconds))} seconds long; split it into regions of at most ${String(MAX_SECONDS)} seconds of their own files first.`,
          );
        }
        if (durationSeconds === 0) continue;
        const mono = Float32Array.from(left, (sample, i) => (sample + (right[i] ?? sample)) / 2);
        const speech = resample({ sampleRate: pcm.sampleRate, channels: [mono] }, SPEECH_RATE);
        let heard;
        try {
          heard = await transcribe({
            model,
            audio: { bytes: encodeWav(speech, 'int16'), mediaType: 'audio/wav' },
            ...(input.language === undefined ? {} : { language: input.language }),
          });
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          throw new CommandError(
            'handler_failed',
            id,
            `Nothing was written down: ${error.message}`,
            { cause: error },
          );
        }
        const transcript: Transcript = {
          model,
          language: heard.language,
          text: heard.text,
          durationSeconds,
          words: heard.words.map((word) => ({
            text: word.text,
            startSeconds: Math.max(0, word.startSeconds),
            endSeconds: Math.max(0, word.startSeconds, word.endSeconds),
          })),
          createdAt: runtime.now().toISOString(),
        };
        if (transcript.words.length === 0 && transcript.text !== '') {
          throw new CommandError(
            'invalid_input',
            id,
            `The model "${model}" writes text without word times, which editing by words needs. Choose another from models.list with output "transcription".`,
          );
        }
        await runtime.blobs.put(await transcriptKey(sources, key), {
          bytes: encodeUtf8(JSON.stringify(transcript)),
          mediaType: 'application/json',
        });
        written++;
        if (heard.costUsd !== null) costUsd = (costUsd ?? 0) + heard.costUsd;
      }
      const wanted = new Set(chosen.map((region) => region.id));
      return {
        written,
        kept,
        costUsd,
        regions: (await regionTexts(runtime, doc)).filter((text) => wanted.has(text.regionId)),
      };
    },
  });

  const read = defineCommand({
    id: 'audio.transcript.get',
    title: 'Read what is said',
    description:
      'Returns the words each region of an audio document says, as text and word by word with times in the document, numbered within each region. Regions not yet written down say so; use audio.transcribe for them. To remove words, pass their numbers to audio.words.delete; to move them, cut their times with audio.edit.cut and paste with audio.edit.paste.',
    effect: 'read',
    input: z.object({
      projectId: ProjectId,
      docId: DocId,
      trackIds: z.array(z.string().min(1)).min(1).optional().describe('All tracks when left out.'),
    }),
    output: z.object({ regions: z.array(RegionText) }),
    handler: async ({ runtime }, input) => {
      const id = 'audio.transcript.get';
      const doc = await helpers.load(runtime, id, input.projectId, input.docId);
      for (const trackId of input.trackIds ?? []) helpers.trackOf(doc, id, trackId);
      return { regions: await regionTexts(runtime, doc, input.trackIds) };
    },
  });

  const remove = defineCommand({
    id: 'audio.words.delete',
    title: 'Delete words',
    description:
      'Removes words from a region by their numbers in audio.transcript.get, cut in the pauses around them so the speech either side sounds natural. Closes the gap on that track (later sound on it moves earlier), or leaves silence with "keepTime". One step to undo. Read the transcript again afterwards: numbers and region ids change.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      docId: DocId,
      regionId: z.string().min(1),
      fromWord: z.number().int().min(0),
      toWord: z
        .number()
        .int()
        .min(0)
        .describe('The last word removed; the same as fromWord for one.'),
      keepTime: z
        .boolean()
        .default(false)
        .describe('Leave silence where the words were, so nothing after them moves.'),
    }),
    output: helpers.outline.extend({
      removedText: z.string(),
      fromSeconds: z.number(),
      toSeconds: z.number(),
    }),
    handler: async (context, input) => {
      const id = 'audio.words.delete';
      const { runtime } = context;
      const doc = await helpers.load(runtime, id, input.projectId, input.docId);
      const { track, region } = helpers.regionOf(doc, id, input.regionId);
      const transcript = await readTranscript(
        helpers.sources(runtime),
        runtime.blobs,
        region.blobKey,
      );
      if (transcript === undefined) {
        throw new CommandError(
          'invalid_input',
          id,
          'This region is not written down yet. Use audio.transcribe first.',
        );
      }
      const words: PlacedWord[] = placeWords(region, transcript);
      let span: { fromSeconds: number; toSeconds: number };
      try {
        span = wordSpan(words, input.fromWord, input.toWord, {
          startSeconds: region.startSeconds,
          endSeconds: regionEnd(region),
        });
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        throw new CommandError('invalid_input', id, error.message, { cause: error });
      }
      const edit = input.keepTime ? silenceRange : deleteRange;
      const changed = await helpers.change(
        context,
        id,
        input.projectId,
        input.docId,
        input.keepTime ? 'Silence words' : 'Delete words',
        (current) => ({
          ...current,
          tracks: current.tracks.map((candidate) =>
            candidate.id === track.id
              ? {
                  ...candidate,
                  regions: edit(candidate.regions, span.fromSeconds, span.toSeconds, runtime.newId),
                }
              : candidate,
          ),
        }),
      );
      return {
        document: helpers.document(changed),
        removedText: words
          .slice(input.fromWord, input.toWord + 1)
          .map((word) => word.text)
          .join(' '),
        fromSeconds: round3(span.fromSeconds),
        toSeconds: round3(span.toSeconds),
      };
    },
  });

  return [write, read, remove];
}
