import { CommandRegistry, defineCommand, settingsCommands } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { parseVideoPricing, type ModelInfo } from '@imp/providers';
import { createFakeProvider } from '@imp/providers/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createSpendCommands,
  createSpendLedger,
  priceVideo,
  withSpendLedger,
} from '../src/index.js';

const user = { kind: 'user', id: 'arnd' } as const;

interface Summary {
  project: { calls: number };
  all: { calls: number };
  today: { calls: number };
  estimatedUsd: number;
  byKind: { kind: string }[];
  latest: { kind: string; projectId: string | null }[];
}
interface Priced {
  estimate: { basis: string; kind: string; usd: number | null } | null;
}

const clips: ModelInfo = {
  id: 'vendor/clips',
  name: 'Clips',
  inputModalities: ['text'],
  outputModalities: ['video'],
  contextLength: null,
  supportsTools: false,
  pricing: { promptUsdPerToken: null, completionUsdPerToken: null },
  video: {
    durationsSeconds: [4, 8],
    resolutions: ['720p'],
    aspectRatios: ['16:9'],
    frameImages: [],
    nativeAudio: true,
    pricing: {
      perSecond: [
        { resolution: '720p', audio: true, usd: 0.05 },
        { resolution: '720p', audio: false, usd: 0.03 },
        { resolution: null, audio: true, usd: 0.08 },
      ],
      perToken: [],
    },
  },
};

/** A command that spends, as the mode's generation commands do, and says what it would make. */
const paint = defineCommand({
  id: 'media.paint',
  title: 'Paint',
  description: 'A stand-in for a generation that costs money.',
  effect: 'spend',
  input: z.object({ prompt: z.string(), model: z.string().optional() }),
  output: z.object({ ok: z.boolean() }),
  estimate: (_context, input) =>
    Promise.resolve({ kind: 'image', model: input.model ?? 'vendor/painter' }),
  handler: () => Promise.resolve({ ok: true }),
});
const film = defineCommand({
  id: 'media.film',
  title: 'Film',
  description: 'A stand-in for making a clip that costs money.',
  effect: 'spend',
  input: z.object({ seconds: z.number(), audio: z.boolean() }),
  output: z.object({ ok: z.boolean() }),
  estimate: (_context, input) =>
    Promise.resolve({
      kind: 'video',
      model: 'vendor/clips',
      seconds: input.seconds,
      resolution: '720p',
      audio: input.audio,
    }),
  handler: () => Promise.resolve({ ok: true }),
});

function setup() {
  const runtime = createTestRuntime();
  const fake = createFakeProvider({ models: [clips], videoPendingChecks: 1 });
  const provider = withSpendLedger(fake, createSpendLedger(runtime));
  const registry = new CommandRegistry({ runtime });
  registry.register(
    ...settingsCommands,
    paint,
    film,
    ...createSpendCommands({ registry, provider }),
  );
  const run = async (id: string, input: unknown): Promise<unknown> => {
    const result = await registry.executeById(id, input, { actor: user });
    if (result.status !== 'ok') throw new Error(`${id}: ${result.status}`);
    return result.output;
  };
  return { runtime, provider, run };
}

describe('video prices', () => {
  it('read the price list: per second by size and sound, cents, tokens, a minimum', () => {
    const pricing = parseVideoPricing({
      cents_per_video_output_second_480p: '2',
      cents_per_video_output_second_720p: '3',
      cents_per_image_input: '1',
      long_duration_seconds_720p: '9',
      minimum_cents_per_generation: '56',
    });
    expect(pricing?.perSecond).toEqual([
      { resolution: '480p', audio: null, usd: 0.02 },
      { resolution: '720p', audio: null, usd: 0.03 },
    ]);
    expect(pricing?.minimumUsd).toBe(0.56);
    expect(parseVideoPricing({ prompt: '0' })).toBeUndefined();
  });

  it('price a clip by its length, size and sound', () => {
    const pricing = clips.video?.pricing;
    if (pricing === undefined) throw new Error('No price list.');
    expect(priceVideo(pricing, 4, '720p', true)).toBeCloseTo(0.2);
    expect(priceVideo(pricing, 4, '720p', false)).toBeCloseTo(0.12);
    // No 1080p line: the nearest size is used.
    expect(priceVideo(pricing, 8, '1080p', false)).toBeCloseTo(0.24);
    // Priced per video token: about width × height × 24 ÷ 1024 tokens a second.
    const tokens = parseVideoPricing({ video_tokens: '0.0000035' });
    if (tokens === undefined) throw new Error('No price list.');
    expect(priceVideo(tokens, 4, '480p', false)).toBeCloseTo(0.1345, 3);
    const minimum = parseVideoPricing({
      cents_per_second_output: '28',
      minimum_cents_per_generation: '56',
    });
    if (minimum === undefined) throw new Error('No price list.');
    expect(priceVideo(minimum, 1, '720p', false)).toBeCloseTo(0.56);
  });
});

describe('spending', () => {
  it('writes down every paid call, in the project that was open', async () => {
    const { provider, run } = setup();
    await run('settings.set', { key: 'project.current', value: 'p1' });
    await provider.generateImage({ model: 'vendor/painter', prompt: 'a lighthouse' });
    // The fake speech model does not say what it cost: the amount is estimated.
    await provider.generateSpeech({ model: 'vendor/speaker', text: 'Hello there, keeper.' });
    const job = await provider.startVideo({
      model: 'vendor/clips',
      prompt: 'waves',
      audio: true,
      durationSeconds: 4,
    });
    await provider.checkVideo(job.id);
    await provider.checkVideo(job.id);
    await provider.checkVideo(job.id);
    await run('settings.set', { key: 'project.current', value: 'p2' });
    await provider.generateImage({ model: 'vendor/painter', prompt: 'a boat' });

    const summary = (await run('spend.summary', { projectId: 'p1' })) as Summary;
    expect(summary.project.calls).toBe(3);
    // A clip is counted once, when it is done, however often it is looked at.
    expect(summary.all.calls).toBe(4);
    expect(summary.estimatedUsd).toBeGreaterThan(0);
    expect(summary.byKind.map((entry) => entry.kind)).toContain('video');
    expect(summary.latest[0]).toMatchObject({ kind: 'image', projectId: 'p2' });
    expect(summary.today.calls).toBe(4);
  });

  it('prices a command before it runs: price list, history, or a rough typical price', async () => {
    const { provider, run } = setup();
    expect(
      await run('spend.estimate', { commandId: 'media.film', input: { seconds: 4, audio: true } }),
    ).toMatchObject({
      estimate: { basis: 'price list', model: 'vendor/clips' },
    });
    const first = (await run('spend.estimate', {
      commandId: 'media.paint',
      input: { prompt: 'x' },
    })) as Priced;
    expect(first.estimate).toMatchObject({ basis: 'typical', kind: 'image' });

    // Once the model has cost something, its real price is used.
    await provider.generateImage({ model: 'vendor/painter', prompt: 'a lighthouse' });
    const second = (await run('spend.estimate', {
      commandId: 'media.paint',
      input: { prompt: 'x' },
    })) as Priced;
    expect(second.estimate).toMatchObject({ basis: 'your history', usd: 0.01 });

    // Commands that do not spend, and inputs that do not fit, cost nothing to ask about.
    expect(await run('spend.estimate', { commandId: 'settings.get', input: { key: 'a' } })).toEqual(
      { estimate: null },
    );
    expect(await run('spend.estimate', { commandId: 'media.paint', input: {} })).toEqual({
      estimate: null,
    });
  });
});
