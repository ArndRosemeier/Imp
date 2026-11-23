import { CommandRegistry, defineCommand, settingsCommands } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { parseVideoPricing, type ModelInfo } from '@imp/providers';
import { createFakeProvider } from '@imp/providers/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createSpendAllowance,
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

    // A kind of work is priced without a command, on the model set for it.
    await run('settings.set', { key: 'video.model', value: 'vendor/clips' });
    const quoted = (await run('spend.quote', {
      kind: 'video',
      seconds: 4,
      resolution: '720p',
      audio: true,
    })) as Priced;
    expect(quoted.estimate).toMatchObject({ basis: 'price list' });
    expect(quoted.estimate?.usd).toBeCloseTo(0.2);

    // Commands that do not spend, and inputs that do not fit, cost nothing to ask about.
    expect(await run('spend.estimate', { commandId: 'settings.get', input: { key: 'a' } })).toEqual(
      { estimate: null },
    );
    expect(await run('spend.estimate', { commandId: 'media.paint', input: {} })).toEqual({
      estimate: null,
    });
  });
});

describe('spending without asking', () => {
  const agent = { kind: 'agent', id: 'casting', role: 'casting-director' } as const;
  const wipe = defineCommand({
    id: 'media.wipe',
    title: 'Wipe',
    description: 'A stand-in for deleting.',
    effect: 'destructive',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    handler: () => Promise.resolve({ ok: true }),
  });

  function allowanceSetup() {
    const runtime = createTestRuntime();
    const fake = createFakeProvider({ models: [clips] });
    const provider = withSpendLedger(fake, createSpendLedger(runtime));
    const registry = new CommandRegistry({ runtime, autoApprove: createSpendAllowance(provider) });
    registry.register(
      ...settingsCommands,
      paint,
      film,
      wipe,
      ...createSpendCommands({ registry, provider }),
    );
    const asAgent = (id: string, input: unknown) =>
      registry.executeById(id, input, { actor: agent }).then((result) => result.status);
    const asUser = (id: string, input: unknown) =>
      registry.executeById(id, input, { actor: user }).then((result) => result.status);
    return { runtime, registry, provider, asAgent, asUser };
  }

  it('lets an agent spend within the budget unasked, but asks for deleting', async () => {
    const { asAgent, asUser } = allowanceSetup();
    expect(await asAgent('media.paint', { prompt: 'a dragon' })).toBe('ok');
    // 4 seconds at 5 cents: 20 cents, within the dollar.
    expect(await asAgent('media.film', { seconds: 4, audio: true })).toBe('ok');
    expect(await asAgent('media.wipe', {})).toBe('needs-approval');
    // A step limit, when set, asks for anything above it.
    expect(await asUser('spend.allowance.set', { step: 0.05 })).toBe('ok');
    expect(await asAgent('media.film', { seconds: 4, audio: true })).toBe('needs-approval');
    expect(await asAgent('media.paint', { prompt: 'a dragon' })).toBe('ok');
    // 24 seconds is $1.20: over the budget.
    expect(await asUser('spend.allowance.set', { step: 0 })).toBe('ok');
    expect(await asAgent('media.film', { seconds: 24, audio: true })).toBe('needs-approval');
  });

  it('asks again once the project has used its allowance', async () => {
    const { runtime, provider, asAgent } = allowanceSetup();
    await runtime.store.batch([{ type: 'put', key: 'settings/project.current', value: 'p1' }]);
    await provider.generateImage({ model: 'vendor/painter', prompt: 'x' });
    expect(await asAgent('media.paint', { prompt: 'again' })).toBe('ok');
    await runtime.store.batch([
      { type: 'put', key: 'settings/spend.allowance.project', value: 0.015 },
    ]);
    expect(await asAgent('media.paint', { prompt: 'once more' })).toBe('needs-approval');
    // Another project has its own allowance.
    await runtime.store.batch([{ type: 'put', key: 'settings/project.current', value: 'p2' }]);
    expect(await asAgent('media.paint', { prompt: 'elsewhere' })).toBe('ok');
  });

  it('always asks when the person sets it to 0, or the price is unknown', async () => {
    const { asAgent, asUser } = allowanceSetup();
    expect(await asUser('spend.allowance.set', { project: 0 })).toBe('ok');
    expect(await asAgent('media.paint', { prompt: 'a dragon' })).toBe('needs-approval');
    expect(await asUser('spend.allowance.set', { project: 1 })).toBe('ok');
    expect(await asAgent('media.paint', { prompt: 'a dragon' })).toBe('ok');
  });

  it('is changed by an agent only once the person approves, even with budget left', async () => {
    const { registry, asAgent, asUser } = allowanceSetup();
    expect(await asAgent('spend.allowance.set', { project: 100 })).toBe('needs-approval');
    expect(
      await registry.executeById(
        'spend.allowance.set',
        { project: 3 },
        { actor: agent, approved: true },
      ),
    ).toMatchObject({ status: 'ok', output: { project: 3 } });
    // Not around the approval through the raw setting either; the refusal says what to use.
    await expect(
      registry.executeById(
        'settings.set',
        { key: 'spend.allowance.step', value: 100 },
        { actor: agent },
      ),
    ).rejects.toThrow(/Use spend\.allowance\.set/);
    expect(await asUser('spend.allowance.set', { step: 0.1, project: 2 })).toBe('ok');
    const shown = await registry.executeById('spend.allowance.get', {}, { actor: agent });
    expect(shown).toMatchObject({
      status: 'ok',
      output: { step: 0.1, project: 2, projectSpentUsd: 0, projectLeftUsd: 2 },
    });
  });

  it('refuses a step that cannot run instead of asking, whatever the budget', async () => {
    // Arnd's live run (2026-11-23): no picture model was chosen, so portraits had no price and
    // went to approval, where approving them would only have failed.
    const { runtime, registry, asAgent, asUser } = allowanceSetup();
    const draw = defineCommand({
      id: 'media.draw',
      title: 'Draw',
      description: 'A stand-in for a generation that uses the chosen picture model.',
      effect: 'spend',
      input: z.object({ model: z.string().optional() }),
      output: z.object({ ok: z.boolean() }),
      estimate: async ({ runtime: { store } }, input) => {
        const chosen = await store.get('settings/images.model');
        return {
          kind: 'image',
          model: input.model ?? (typeof chosen === 'string' ? chosen : null),
        };
      },
      handler: () => Promise.resolve({ ok: true }),
    });
    registry.register(draw);
    await expect(asAgent('media.draw', {})).rejects.toThrow(
      /No image model is chosen.*"images\.model"/,
    );
    // Also with no budget, where everything else is put to the person.
    expect(await asUser('spend.allowance.set', { project: 0 })).toBe('ok');
    await expect(asAgent('media.draw', {})).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await asAgent('media.draw', { model: 'vendor/painter' })).toBe('needs-approval');
    // Once a model is chosen, it runs within the budget unasked.
    expect(await asUser('spend.allowance.set', { project: 1 })).toBe('ok');
    await runtime.store.batch([
      { type: 'put', key: 'settings/images.model', value: 'vendor/painter' },
    ]);
    expect(await asAgent('media.draw', {})).toBe('ok');
    // Input that does not fit is refused at once as well, not asked about.
    await expect(asAgent('media.paint', { prompt: 7 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});
