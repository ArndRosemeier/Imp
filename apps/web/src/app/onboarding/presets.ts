import type { ModelInfo } from '@imp/providers';

/**
 * The model mixes offered on the first run. Each slot lists families in the
 * order they are preferred; the first one in the live catalog is used, so the
 * presets follow the catalog as models come and go, and a model id is never
 * guessed. They are saved as ordinary model mixes, so they can be switched
 * and changed later like any other.
 */
export interface StarterMix {
  readonly id: 'starter' | 'balanced' | 'best';
  readonly name: string;
  readonly notes: string;
  /** Model ids by setting key, only for slots the catalog could fill. */
  readonly models: Readonly<Record<string, string>>;
}

type Rule = readonly RegExp[];
type Plan = Readonly<Record<string, Rule>>;

const VOICES: Rule = [/^bytedance-seed\/seed-audio-/];
const WORDS: Rule = [/^elevenlabs\/scribe-v\d+$/, /^openai\/whisper-large-v3-turbo$/];

const PLANS: readonly { id: StarterMix['id']; name: string; notes: string; plan: Plan }[] = [
  {
    id: 'starter',
    name: 'Starter',
    notes: 'Cheap models for learning and drafts. A short film costs a few dollars.',
    plan: {
      'coordinator.model': [/^~anthropic\/claude-haiku-latest$/, /^~google\/gemini-flash-latest$/],
      'video.model': [/^google\/veo-[\d.]+-lite$/, /^bytedance\/seedance-\d+(\.\d+)?-mini$/],
      'images.model': [/^meta\/muse-image$/],
      'speech.model': VOICES,
      'sounds.model': VOICES,
      'music.model': [/^google\/lyria-[\d.]+-clip/],
      'transcription.model': WORDS,
    },
  },
  {
    id: 'balanced',
    name: 'Balanced',
    notes: 'Sharper clips and a stronger coordinator. Good for finished shorts.',
    plan: {
      'coordinator.model': [/^~anthropic\/claude-sonnet-latest$/, /^~google\/gemini-pro-latest$/],
      'video.model': [
        /^google\/veo-[\d.]+-fast$/,
        /^bytedance\/seedance-\d+(\.\d+)?-fast$/,
        /^google\/veo-[\d.]+-lite$/,
      ],
      'images.model': [/^meta\/muse-image$/],
      'speech.model': VOICES,
      'sounds.model': VOICES,
      'music.model': [/^google\/lyria-[\d.]+-pro/, /^google\/lyria-[\d.]+-clip/],
      'transcription.model': WORDS,
    },
  },
  {
    id: 'best',
    name: 'Best',
    notes: 'The strongest models for the final film. Clips cost several times more.',
    plan: {
      'coordinator.model': [
        /^~anthropic\/claude-opus-latest$/,
        /^~anthropic\/claude-sonnet-latest$/,
      ],
      'video.model': [/^google\/veo-[\d.]+$/, /^google\/veo-[\d.]+-fast$/],
      'images.model': [/^meta\/muse-image$/],
      'speech.model': VOICES,
      'sounds.model': VOICES,
      'music.model': [/^google\/lyria-[\d.]+-pro/],
      'transcription.model': WORDS,
    },
  },
];

/** Newest first: versions compare as numbers, so "2.10" comes after "2.9". */
function newestFirst(a: string, b: string): number {
  return b.localeCompare(a, 'en', { numeric: true });
}

function pick(models: readonly ModelInfo[], rule: Rule): string | undefined {
  for (const pattern of rule) {
    const found = models
      .map((model) => model.id)
      .filter((id) => pattern.test(id) && !id.includes(':'))
      .sort(newestFirst);
    if (found[0] !== undefined) return found[0];
  }
  return undefined;
}

export function starterMixes(models: readonly ModelInfo[]): StarterMix[] {
  return PLANS.map(({ id, name, notes, plan }) => {
    const chosen: Record<string, string> = {};
    for (const [setting, rule] of Object.entries(plan)) {
      const model = pick(models, rule);
      if (model !== undefined) chosen[setting] = model;
    }
    return { id, name, notes, models: chosen };
  });
}
