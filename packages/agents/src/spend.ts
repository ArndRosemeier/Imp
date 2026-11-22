import {
  CostRequest,
  defineCommand,
  type Command,
  type CommandRegistry,
  type CoreRuntime,
  type KeyValueStore,
} from '@imp/core';
import type { GenerationProvider, ModelInfo, VideoPricing } from '@imp/providers';
import { z } from 'zod';

/**
 * Where every paid call is written down, one entry per call. Kept apart from
 * projects so a project's export carries no bill, and so that a deleted
 * project's spending still counts in the total.
 */
export const SPEND_PREFIX = 'spend/';

export const SpendKind = CostRequest.shape.kind;
export type SpendKind = z.infer<typeof SpendKind>;

export const SpendEntry = z.object({
  id: z.string(),
  at: z.string().describe('When it was spent, as an ISO time.'),
  kind: SpendKind,
  model: z.string(),
  usd: z.number().nonnegative(),
  /** True when the provider did not say what it cost and the amount is Imp's estimate. */
  estimated: z.boolean(),
  /** The project open at the time, or null. */
  projectId: z.string().nullable(),
  /** How much was made, so later estimates can learn from it: seconds, characters, count. */
  seconds: z.number().optional(),
  characters: z.number().optional(),
  count: z.number().optional(),
});
export type SpendEntry = z.infer<typeof SpendEntry>;

/**
 * What a call usually costs when nothing better is known: no price in the
 * catalog and nothing spent on that model yet. Measured on OpenRouter in
 * November 2026 with the cheaper models; the estimate says it is rough.
 */
const TYPICAL: Readonly<Record<SpendKind, { usd: number; per: 'count' | 'second' | 'char' }>> = {
  chat: { usd: 0.005, per: 'count' },
  image: { usd: 0.012, per: 'count' },
  speech: { usd: 0.0003, per: 'char' },
  sound: { usd: 0.015, per: 'count' },
  music: { usd: 0.05, per: 'count' },
  video: { usd: 0.05, per: 'second' },
  transcription: { usd: 0.0001, per: 'second' },
};

interface Amount {
  readonly count?: number | undefined;
  readonly seconds?: number | undefined;
  readonly characters?: number | undefined;
}

function unitsOf(kind: SpendKind, request: Amount): number {
  const per = TYPICAL[kind].per;
  if (per === 'second') return request.seconds ?? (kind === 'video' ? 4 : 60);
  if (per === 'char') return Math.max(1, request.characters ?? 60);
  return request.count ?? 1;
}

const SIZES: Readonly<Record<string, readonly [number, number]>> = {
  '360p': [640, 360],
  '480p': [854, 480],
  '540p': [960, 540],
  '720p': [1280, 720],
  '768p': [1366, 768],
  '1080p': [1920, 1080],
  '2k': [2560, 1440],
  '4k': [3840, 2160],
};

function heightOf(resolution: string | null): number {
  if (resolution === null) return 720;
  const size = SIZES[resolution.toLowerCase()];
  if (size !== undefined) return size[1];
  const number = Number.parseInt(resolution, 10);
  return Number.isFinite(number) ? number : 720;
}

/**
 * The line of a price list that fits a clip best. A model makes the size
 * asked for or the next one up, so the smallest listed size at least as
 * large is used, else the largest; a line without a size stands for the
 * model's usual size, taken as 1080p. A line for the same sound wins over
 * one that does not say.
 */
function bestLine<T extends { resolution: string | null; audio: boolean | null }>(
  lines: readonly T[],
  resolution: string,
  audio: boolean,
): T | undefined {
  const exact = lines.filter((line) => line.audio === audio);
  const either = lines.filter((line) => line.audio === null);
  const pool = exact.length > 0 ? exact : either.length > 0 ? either : lines;
  const want = heightOf(resolution);
  const height = (line: T): number => (line.resolution === null ? 1080 : heightOf(line.resolution));
  const sorted = [...pool].sort((a, b) => height(a) - height(b));
  return sorted.find((line) => height(line) >= want) ?? sorted.at(-1);
}

/** A clip's price from the model's price list, or undefined when the list says nothing usable. */
export function priceVideo(
  pricing: VideoPricing,
  seconds: number,
  resolution: string,
  audio: boolean,
): number | undefined {
  let usd: number | undefined;
  const second = bestLine(pricing.perSecond, resolution, audio);
  if (second !== undefined) {
    usd = second.usd * seconds;
  } else {
    const token = bestLine(pricing.perToken, resolution, audio);
    if (token !== undefined) {
      const [width, height] = SIZES[resolution.toLowerCase()] ?? [1280, 720];
      usd = token.usd * ((width * height * 24) / 1024) * seconds;
    }
  }
  if (usd === undefined) return undefined;
  return Math.max(usd, pricing.minimumUsd ?? 0);
}

export const Estimate = z.object({
  usd: z.number().nonnegative().nullable().describe('The expected cost in US dollars, or null.'),
  maxUsd: z
    .number()
    .nonnegative()
    .optional()
    .describe('The most it can cost, where that is known, such as an agent run budget.'),
  basis: z
    .enum(['price list', 'your history', 'typical', 'budget', 'unknown'])
    .describe(
      'Where the number comes from: the provider price list, what this model cost you before, a rough typical price, the budget limit, or nothing.',
    ),
  model: z.string().nullable(),
  kind: SpendKind,
});
export type Estimate = z.infer<typeof Estimate>;

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

async function readEntries(store: KeyValueStore): Promise<SpendEntry[]> {
  const entries: SpendEntry[] = [];
  for (const { value } of await store.list(SPEND_PREFIX)) {
    const parsed = SpendEntry.safeParse(value);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** What one unit (a picture, a second, a character) cost on this model before, from real prices only. */
function learnedRate(entries: readonly SpendEntry[], kind: SpendKind, model: string) {
  const rates = entries
    .filter((entry) => entry.kind === kind && entry.model === model && !entry.estimated)
    .slice(-20)
    .map((entry) => entry.usd / unitsOf(kind, entry));
  return median(rates);
}

/**
 * Prices work before it is done. A clip is priced from the model's own price
 * list; anything else from what the same model cost you before; and failing
 * both, from a rough typical price, which says so.
 */
export async function priceRequest(
  request: CostRequest,
  options: {
    readonly store: KeyValueStore;
    readonly models: () => Promise<readonly ModelInfo[]>;
  },
): Promise<Estimate> {
  const { kind, model } = request;
  const base = { model, kind };
  if (request.maxUsd !== undefined && kind === 'chat') {
    const entries = await readEntries(options.store);
    // A run is many calls, so the typical run is not known from single calls; the budget caps it.
    const recent = entries.filter((entry) => entry.kind === 'chat' && entry.model === model);
    const typical = median(recent.slice(-40).map((entry) => entry.usd));
    return {
      ...base,
      usd: typical === undefined ? null : Math.min(request.maxUsd, typical * 6),
      maxUsd: request.maxUsd,
      basis: 'budget',
    };
  }
  if (model === null) return { ...base, usd: null, basis: 'unknown' };
  const units = unitsOf(kind, request);
  if (kind === 'video') {
    try {
      const info = (await options.models()).find((candidate) => candidate.id === model);
      const pricing = info?.video?.pricing;
      if (pricing !== undefined) {
        const usd = priceVideo(
          pricing,
          request.seconds ?? 4,
          request.resolution ?? '720p',
          request.audio ?? false,
        );
        if (usd !== undefined) return { ...base, usd, basis: 'price list' };
      }
    } catch {
      // Without the catalog, history and typical prices still give an idea.
    }
  }
  const rate = learnedRate(await readEntries(options.store), kind, model);
  if (rate !== undefined) return { ...base, usd: rate * units, basis: 'your history' };
  return { ...base, usd: TYPICAL[kind].usd * units, basis: 'typical' };
}

/** One paid call, as the provider wrapper sees it. A null price is filled in with an estimate. */
export interface PaidCall extends Amount {
  readonly kind: SpendKind;
  readonly model: string;
  readonly usd: number | null;
}

/** Writes down what a call cost, and in which project. */
export interface SpendLedger {
  record(call: PaidCall): Promise<void>;
}

export function createSpendLedger(runtime: CoreRuntime): SpendLedger {
  return {
    async record(call) {
      const project = await runtime.store.get('settings/project.current');
      const at = runtime.now().toISOString();
      const id = runtime.newId();
      const value = {
        id,
        at,
        kind: call.kind,
        model: call.model,
        usd: call.usd ?? TYPICAL[call.kind].usd * unitsOf(call.kind, call),
        estimated: call.usd === null,
        projectId: typeof project === 'string' ? project : null,
        ...(call.count === undefined ? {} : { count: call.count }),
        ...(call.seconds === undefined ? {} : { seconds: call.seconds }),
        ...(call.characters === undefined ? {} : { characters: call.characters }),
      };
      // Time first, so the entries list in the order they were spent.
      await runtime.store.batch([{ type: 'put', key: `${SPEND_PREFIX}${at}-${id}`, value }]);
    },
  };
}

/**
 * The same provider, writing every paid call into the ledger. Nothing that
 * generates needs to know about it, so a new kind of generation is counted
 * as soon as it goes through the provider. A failed ledger write never fails
 * the generation it describes.
 */
export function withSpendLedger(
  provider: GenerationProvider,
  ledger: SpendLedger,
): GenerationProvider {
  const quietly = (entry: PaidCall): void => {
    ledger.record(entry).catch(() => undefined);
  };
  const videos = new Map<string, { model: string; seconds?: number }>();
  const counted = new Set<string>();
  return {
    id: provider.id,
    listModels: (call) => provider.listModels(call),
    verifyCredentials: (call) => provider.verifyCredentials(call),
    downloadVideo: (jobId, call) => provider.downloadVideo(jobId, call),
    async chat(request, call) {
      const response = await provider.chat(request, call);
      quietly({
        kind: 'chat',
        model: response.model || request.model,
        usd: response.usage.costUsd,
      });
      return response;
    },
    async generateImage(request, call) {
      const response = await provider.generateImage(request, call);
      quietly({
        kind: 'image',
        model: request.model,
        usd: response.costUsd,
        count: Math.max(1, response.images.length),
      });
      return response;
    },
    async generateSpeech(request, call) {
      const response = await provider.generateSpeech(request, call);
      quietly({
        kind: 'speech',
        model: request.model,
        usd: response.costUsd,
        characters: request.text.length,
      });
      return response;
    },
    async generateSound(request, call) {
      const response = await provider.generateSound(request, call);
      quietly({
        kind: request.kind === 'music' ? 'music' : 'sound',
        model: request.model,
        usd: response.costUsd,
        count: 1,
      });
      return response;
    },
    async transcribe(request, call) {
      const response = await provider.transcribe(request, call);
      const last = response.words.at(-1);
      quietly({
        kind: 'transcription',
        model: request.model,
        usd: response.costUsd,
        ...(last === undefined ? {} : { seconds: Math.max(1, last.endSeconds) }),
      });
      return response;
    },
    async startVideo(request, call) {
      const job = await provider.startVideo(request, call);
      videos.set(job.id, {
        model: request.model,
        ...(request.durationSeconds === undefined ? {} : { seconds: request.durationSeconds }),
      });
      return job;
    },
    async checkVideo(jobId, call) {
      const job = await provider.checkVideo(jobId, call);
      // A clip is paid once it is done; it is looked at many times before that.
      if (job.status === 'completed' && !counted.has(jobId)) {
        counted.add(jobId);
        const started = videos.get(jobId);
        quietly({
          kind: 'video',
          model: started?.model ?? 'unknown',
          usd: job.costUsd,
          ...(started?.seconds === undefined ? {} : { seconds: started.seconds }),
        });
      }
      return job;
    },
  };
}

const Totals = z.object({
  usd: z.number(),
  calls: z.number().int(),
});

function total(entries: readonly SpendEntry[]): z.infer<typeof Totals> {
  return {
    usd: entries.reduce((sum, entry) => sum + entry.usd, 0),
    calls: entries.length,
  };
}

/**
 * What was spent, and what something would cost before it is done. Every
 * command that spends says what it is about to make (`estimate`), so one
 * command prices any of them: for the button a person is about to press, the
 * approval card of an agent's request, or an agent planning its work.
 */
export function createSpendCommands(options: {
  readonly registry: CommandRegistry;
  readonly provider: GenerationProvider;
}): readonly Command[] {
  let catalog: { at: number; models: Promise<readonly ModelInfo[]> } | undefined;
  // Prices change rarely and the catalog is large, so it is read at most every ten minutes.
  const models = (): Promise<readonly ModelInfo[]> => {
    const now = Date.now();
    if (catalog === undefined || now - catalog.at > 600_000) {
      const loading = options.provider.listModels();
      loading.catch(() => {
        catalog = undefined;
      });
      catalog = { at: now, models: loading };
    }
    return catalog.models;
  };

  const estimate = defineCommand({
    id: 'spend.estimate',
    title: 'Estimate the cost',
    description:
      'Says what running a command that spends money would cost, before running it: give the command id and the input you would run it with. The answer says where the number comes from (the price list, what the model cost before, or a rough typical price). Commands that do not spend cost nothing.',
    effect: 'read',
    input: z.object({
      commandId: z.string().describe('A command id, for example "movie.shot.clip.generate".'),
      input: z.json().describe('The input you would run it with.'),
    }),
    output: z.object({ estimate: Estimate.nullable() }),
    handler: async (context, { commandId, input }) => {
      const command = options.registry.get(commandId);
      if (command.effect !== 'spend' || command.estimate === undefined) {
        return { estimate: null };
      }
      let request: CostRequest | null;
      try {
        request = await command.estimate(context, input);
      } catch {
        // The input names something that does not exist yet; running it would fail too.
        request = null;
      }
      if (request === null) return { estimate: null };
      return {
        estimate: await priceRequest(CostRequest.parse(request), {
          store: context.runtime.store,
          models,
        }),
      };
    },
  });

  const summary = defineCommand({
    id: 'spend.summary',
    title: 'Show spending',
    description:
      'Returns what has been spent at the provider: today, in a project (the open one unless another is given), and in all, broken down by kind of generation, with the latest calls. Amounts the provider did not report are estimates and are counted in "estimatedUsd".',
    effect: 'read',
    input: z.object({
      projectId: z.string().optional().describe('Defaults to the open project.'),
      latest: z.number().int().min(0).max(100).default(12),
    }),
    output: z.object({
      today: Totals,
      project: Totals.extend({ projectId: z.string().nullable() }),
      all: Totals,
      estimatedUsd: z.number(),
      byKind: z.array(z.object({ kind: SpendKind, usd: z.number(), calls: z.number().int() })),
      latest: z.array(SpendEntry),
    }),
    handler: async ({ runtime }, input) => {
      const entries = await readEntries(runtime.store);
      const open = await runtime.store.get('settings/project.current');
      const projectId = input.projectId ?? (typeof open === 'string' ? open : null);
      const now = runtime.now();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const kinds = new Map<SpendKind, { usd: number; calls: number }>();
      for (const entry of entries) {
        const sum = kinds.get(entry.kind) ?? { usd: 0, calls: 0 };
        kinds.set(entry.kind, { usd: sum.usd + entry.usd, calls: sum.calls + 1 });
      }
      return {
        today: total(entries.filter((entry) => entry.at >= midnight)),
        project: {
          projectId,
          ...total(entries.filter((entry) => projectId !== null && entry.projectId === projectId)),
        },
        all: total(entries),
        estimatedUsd: entries
          .filter((entry) => entry.estimated)
          .reduce((sum, entry) => sum + entry.usd, 0),
        byKind: [...kinds.entries()]
          .map(([kind, sum]) => ({ kind, ...sum }))
          .sort((a, b) => b.usd - a.usd),
        latest: entries.slice(-input.latest).reverse(),
      };
    },
  });

  return [estimate, summary];
}
