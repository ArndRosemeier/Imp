import { CommandRegistry, projectCommands, settingsCommands, type Actor } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { describe, expect, it } from 'vitest';
import {
  createAudioCommands,
  createDefaultAudioCodec,
  decodeWav,
  encodeWav,
  placeWords,
  SoundPlacement,
  wordSpan,
  type Transcriber,
  type Transcript,
} from '../src/index.js';

const tone = (seconds: number) =>
  encodeWav(
    {
      sampleRate: 48_000,
      channels: [
        Float32Array.from(
          { length: Math.round(48_000 * seconds) },
          (_, i) => 0.2 * Math.sin(i / 9),
        ),
      ],
    },
    'float32',
  );

/** "The lamp has not failed tonight", one word a second from 0.5 s. */
const WORDS = ['The', 'lamp', 'has', 'not', 'failed', 'tonight'].map((text, i) => ({
  text,
  startSeconds: 0.5 + i,
  endSeconds: 1.1 + i,
}));

interface RegionText {
  trackId: string;
  regionId: string;
  transcribed: boolean;
  text: string;
  words: { index: number; text: string; startSeconds: number; endSeconds: number }[];
}

async function setup(transcribe?: Transcriber) {
  const runtime = createTestRuntime();
  const registry = new CommandRegistry({ runtime }).register(
    ...projectCommands,
    ...settingsCommands,
    ...createAudioCommands({
      codec: createDefaultAudioCodec(),
      ...(transcribe === undefined ? {} : { transcribe }),
    }),
  );
  const you: Actor = { kind: 'user', id: 'u' };
  const run = async (id: string, input: unknown) =>
    ((await registry.executeById(id, input, { actor: you })) as { output: Record<string, unknown> })
      .output;
  const projectId = ((await run('project.create', { name: 'P', mode: 'movie' })) as { id: string })
    .id;
  const created = (await run('audio.doc.create', { projectId, name: 'Dialogue' })) as {
    document: { id: string; tracks: { id: string }[] };
  };
  const docId = created.document.id;
  const trackId = created.document.tracks[0]?.id ?? '';
  await runtime.blobs.put('takes/line', { bytes: tone(7), mediaType: 'audio/wav' });
  await run('audio.region.insert', {
    projectId,
    docId,
    trackId,
    key: 'takes/line',
    startSeconds: 2,
  });
  return { runtime, run, projectId, docId, trackId };
}

describe('dialogue by its words', () => {
  it('writes a file down once, reads its words in document time, and cuts words out cleanly', async () => {
    const heard: { model: string; mediaType: string; rate: number; language?: string }[] = [];
    const transcribe: Transcriber = (request) => {
      heard.push({
        model: request.model,
        mediaType: request.audio.mediaType,
        rate: decodeWav(request.audio.bytes).sampleRate,
        ...(request.language === undefined ? {} : { language: request.language }),
      });
      return Promise.resolve({
        text: WORDS.map((word) => word.text).join(' '),
        words: WORDS,
        language: 'en',
        costUsd: 0.0002,
      });
    };
    const { run, projectId, docId, trackId } = await setup(transcribe);

    const before = (await run('audio.transcript.get', { projectId, docId })) as {
      regions: RegionText[];
    };
    expect(before.regions[0]).toMatchObject({ transcribed: false, text: '', words: [] });
    await expect(run('audio.transcribe', { projectId, docId })).rejects.toThrow(
      /No transcription model/,
    );
    await run('settings.set', { key: 'transcription.model', value: 'ears/one' });

    const first = (await run('audio.transcribe', { projectId, docId, language: 'en' })) as {
      written: number;
      kept: number;
      costUsd: number | null;
      regions: RegionText[];
    };
    expect(heard).toEqual([
      { model: 'ears/one', mediaType: 'audio/wav', rate: 16_000, language: 'en' },
    ]);
    expect(first).toMatchObject({ written: 1, kept: 0, costUsd: 0.0002 });
    expect(first.regions[0]?.text).toBe('The lamp has not failed tonight');
    // The region starts at 2 s, so "lamp" (1.5 s in the file) is at 3.5 s.
    expect(first.regions[0]?.words[1]).toEqual({
      index: 1,
      text: 'lamp',
      startSeconds: 3.5,
      endSeconds: 4.1,
    });

    // Kept: no second call.
    const again = (await run('audio.transcribe', { projectId, docId })) as { kept: number };
    expect(again.kept).toBe(1);
    expect(heard).toHaveLength(1);

    const regionId = first.regions[0]?.regionId ?? '';
    // "has not" out, cut in the middle of the pauses around them.
    const cut = (await run('audio.words.delete', {
      projectId,
      docId,
      regionId,
      fromWord: 2,
      toWord: 3,
    })) as { removedText: string; fromSeconds: number; toSeconds: number };
    expect(cut).toMatchObject({ removedText: 'has not', fromSeconds: 4.3, toSeconds: 6.3 });
    const after = (await run('audio.transcript.get', {
      projectId,
      docId,
      trackIds: [trackId],
    })) as {
      regions: RegionText[];
    };
    // Split in two; each part finds its own words in the one transcript.
    expect(after.regions.map((region) => region.text)).toEqual(['The lamp', 'failed tonight']);
    expect(after.regions[1]?.words[0]?.startSeconds).toBe(4.5);

    // Silencing keeps time: "tonight" stays where it is.
    const second = after.regions[1]?.regionId ?? '';
    await run('audio.words.delete', {
      projectId,
      docId,
      regionId: second,
      fromWord: 0,
      toWord: 0,
      keepTime: true,
    });
    const silenced = (await run('audio.transcript.get', { projectId, docId })) as {
      regions: RegionText[];
    };
    expect(silenced.regions.map((region) => region.text)).toEqual(['The lamp', 'tonight']);
    expect(silenced.regions[1]?.words[0]?.startSeconds).toBe(5.5);
    // One undo step each.
    await run('audio.history.undo', { projectId, docId });
    await run('audio.history.undo', { projectId, docId });
    const back = (await run('audio.transcript.get', { projectId, docId })) as {
      regions: RegionText[];
    };
    expect(back.regions.map((region) => region.text)).toEqual(['The lamp has not failed tonight']);

    // Another model writes it down again.
    await run('audio.transcribe', { projectId, docId, model: 'ears/two', regionIds: [regionId] });
    expect(heard.map((call) => call.model)).toEqual(['ears/one', 'ears/two']);
  });

  it('says why it cannot write down or cut', async () => {
    const plain = await setup();
    await expect(
      plain.run('audio.transcribe', { projectId: plain.projectId, docId: plain.docId, model: 'm' }),
    ).rejects.toThrow(/Nothing here can write sound down/);

    const failing = await setup(() => Promise.reject(new Error('No credit')));
    await expect(
      failing.run('audio.transcribe', {
        projectId: failing.projectId,
        docId: failing.docId,
        model: 'm',
      }),
    ).rejects.toThrow(/Nothing was written down: No credit/);

    const textOnly = await setup(() =>
      Promise.resolve({ text: 'Hello', words: [], language: null, costUsd: null }),
    );
    await expect(
      textOnly.run('audio.transcribe', {
        projectId: textOnly.projectId,
        docId: textOnly.docId,
        model: 'm',
      }),
    ).rejects.toThrow(/without word times/);

    const { run, projectId, docId } = await setup(() =>
      Promise.resolve({ text: '', words: WORDS, language: null, costUsd: null }),
    );
    const listed = (await run('audio.transcript.get', { projectId, docId })) as {
      regions: RegionText[];
    };
    const regionId = listed.regions[0]?.regionId ?? '';
    await expect(
      run('audio.words.delete', { projectId, docId, regionId, fromWord: 0, toWord: 0 }),
    ).rejects.toThrow(/not written down yet/);
    await run('audio.transcribe', { projectId, docId, model: 'm' });
    await expect(
      run('audio.words.delete', { projectId, docId, regionId, fromWord: 3, toWord: 9 }),
    ).rejects.toThrow(/Choose words from 0 to 5/);
    await expect(
      run('audio.transcript.get', { projectId, docId, trackIds: ['nope'] }),
    ).rejects.toThrow(/No track/);
  });

  it('places words of trimmed and looping regions, and spans words at region edges', () => {
    const transcript: Transcript = {
      model: 'm',
      language: null,
      text: '',
      durationSeconds: 7,
      words: WORDS,
      createdAt: new Date(0).toISOString(),
    };
    const region = SoundPlacement.parse({
      id: 'r',
      soundId: '',
      startSeconds: 10,
      trimStartSeconds: 1.9,
      durationSeconds: 2,
      volume: 1,
      fadeInSeconds: 0,
      fadeOutSeconds: 0,
      loop: false,
    });
    // "lamp" (1.5 to 2.1) is mostly cut off by the trim; "has" and "not" play.
    const words = placeWords(region, transcript);
    const bounds = { startSeconds: 10, endSeconds: 12 };
    expect(words.map((word) => word.text)).toEqual(['has', 'not']);
    expect(wordSpan(words, 0, 0, bounds)).toEqual({ fromSeconds: 10, toSeconds: 11.4 });
    expect(wordSpan(words, 1, 1, bounds)).toEqual({ fromSeconds: 11.4, toSeconds: 12 });
    expect(() => wordSpan(words, 1, 0, bounds)).toThrow(RangeError);

    const looping = { ...region, trimStartSeconds: 0, durationSeconds: 16, loop: true };
    expect(placeWords(looping, transcript).map((word) => word.text)).toEqual([
      ...WORDS.map((word) => word.text),
      ...WORDS.map((word) => word.text),
      'The',
      'lamp',
    ]);
  });
});
