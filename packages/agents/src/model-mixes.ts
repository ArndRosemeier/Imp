import {
  CommandError,
  defineCommand,
  type Command,
  type KeyValueStore,
  type WriteOperation,
} from '@imp/core';
import { z } from 'zod';
import { CrewMember } from './crew.js';

/** Where model mixes are kept, by id. Like saved crews, they belong to the workspace. */
export const MODEL_MIX_PREFIX = 'model-mixes/';
/** The mix last applied, so the stages can say which mix they are on and whether it was changed since. */
export const ACTIVE_MIX_SETTING = 'models.mix';
const SETTINGS_PREFIX = 'settings/';

/** One kind of model a mix holds: the setting that names it, and what to call it. */
export interface ModelSlot {
  readonly setting: string;
  readonly label: string;
}

export const ModelMix = z.object({
  id: z.string(),
  name: z.string().min(1),
  notes: z.string().default(''),
  /** Model ids by setting key, such as "video.model". A slot left out keeps what is set. */
  models: z.record(z.string(), z.string()),
  savedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ModelMix = z.infer<typeof ModelMix>;

async function readMixes(store: KeyValueStore): Promise<ModelMix[]> {
  return (await store.list(MODEL_MIX_PREFIX)).map((entry) => ModelMix.parse(entry.value));
}

async function requireMix(store: KeyValueStore, commandId: string, id: string): Promise<ModelMix> {
  const stored = await store.get(`${MODEL_MIX_PREFIX}${id}`);
  if (stored === undefined) {
    throw new CommandError('invalid_input', commandId, `No model mix "${id}".`, {
      details: [
        `id: model mixes are ${
          (await readMixes(store)).map((mix) => `${mix.id} (${mix.name})`).join(', ') || 'none'
        }`,
      ],
    });
  }
  return ModelMix.parse(stored);
}

/** The models set now, by setting key; unset slots are left out. */
async function currentModels(
  store: KeyValueStore,
  slots: readonly ModelSlot[],
): Promise<Record<string, string>> {
  const models: Record<string, string> = {};
  for (const slot of slots) {
    const value = await store.get(`${SETTINGS_PREFIX}${slot.setting}`);
    if (typeof value === 'string' && value !== '') models[slot.setting] = value;
  }
  return models;
}

/**
 * Model mixes: which model makes each kind of thing (agents, video, voices,
 * pictures, effects, music, transcripts), kept under a name so a whole set
 * can be swapped at once, such as a cheap draft mix and a final one.
 */
export function createModelMixCommands(slots: readonly ModelSlot[]): readonly Command[] {
  const known = new Set(slots.map((slot) => slot.setting));
  const slotList = slots.map((slot) => `${slot.setting} (${slot.label})`).join(', ');
  const Models = z
    .record(z.string(), z.string().min(1))
    .refine((models) => Object.keys(models).every((key) => known.has(key)), {
      message: `Keys must be model settings: ${slotList}.`,
    });

  const list = defineCommand({
    id: 'models.mix.list',
    title: 'List model mixes',
    description: `Returns the model mixes saved under a name, which mix was applied last (active), and whether the models set now still match it (changed). A mix names a model for some of: ${slotList}.`,
    effect: 'read',
    input: z.object({}),
    output: z.object({
      mixes: z.array(ModelMix),
      active: z.string().nullable(),
      changed: z.boolean(),
      current: z.record(z.string(), z.string()),
      slots: z.array(z.object({ setting: z.string(), label: z.string() })),
    }),
    handler: async ({ runtime }) => {
      const mixes = (await readMixes(runtime.store)).sort((a, b) => a.name.localeCompare(b.name));
      const activeId = await runtime.store.get(`${SETTINGS_PREFIX}${ACTIVE_MIX_SETTING}`);
      const active = mixes.find((mix) => mix.id === activeId) ?? null;
      const current = await currentModels(runtime.store, slots);
      const changed =
        active !== null &&
        Object.entries(active.models).some(([setting, model]) => current[setting] !== model);
      return {
        mixes,
        active: active?.id ?? null,
        changed,
        current,
        slots: slots.map(({ setting, label }) => ({ setting, label })),
      };
    },
  });

  const save = defineCommand({
    id: 'models.mix.save',
    title: 'Save model mix',
    description:
      'Saves a model mix under a name. Without models it keeps the models set now; with models (setting key to model id, ids from models.list) it keeps those. Pass the id of a mix to overwrite it. Saving does not change the models in use; models.mix.apply does.',
    effect: 'write',
    input: z.object({
      name: z.string().trim().min(1).optional().describe('Required for a new mix.'),
      id: z.string().optional().describe('A mix to overwrite, from models.mix.list.'),
      notes: z.string().optional().describe('What the mix is for, such as "cheap drafts".'),
      models: Models.optional(),
    }),
    output: ModelMix,
    handler: async ({ runtime }, input) => {
      const id = 'models.mix.save';
      const previous =
        input.id === undefined ? undefined : await requireMix(runtime.store, id, input.id);
      const name = input.name ?? previous?.name;
      if (name === undefined) throw new CommandError('invalid_input', id, 'Give the mix a name.');
      const models = input.models ?? (await currentModels(runtime.store, slots));
      if (Object.keys(models).length === 0) {
        throw new CommandError('invalid_input', id, 'No models are chosen yet to save.');
      }
      const now = runtime.now().toISOString();
      const mix: ModelMix = {
        id: previous?.id ?? runtime.newId(),
        name,
        notes: input.notes ?? previous?.notes ?? '',
        models,
        savedAt: previous?.savedAt ?? now,
        updatedAt: now,
      };
      const writes: WriteOperation[] = [
        { type: 'put', key: `${MODEL_MIX_PREFIX}${mix.id}`, value: mix },
      ];
      // Saving what is in use makes it the active mix.
      if (input.models === undefined) {
        writes.push({ type: 'put', key: `${SETTINGS_PREFIX}${ACTIVE_MIX_SETTING}`, value: mix.id });
      }
      await runtime.store.batch(writes);
      return mix;
    },
  });

  const apply = defineCommand({
    id: 'models.mix.apply',
    title: 'Use model mix',
    description:
      "Sets every model the mix names, at once, and makes it the active mix. The coordinator's own model changes too when the mix names one for agents. Slots the mix leaves out keep their model.",
    effect: 'write',
    input: z.object({ id: z.string() }),
    output: z.object({ applied: z.record(z.string(), z.string()) }),
    handler: async ({ runtime }, { id }) => {
      const mix = await requireMix(runtime.store, 'models.mix.apply', id);
      const writes: WriteOperation[] = Object.entries(mix.models)
        .filter(([setting]) => known.has(setting))
        .map(([setting, model]) => ({
          type: 'put' as const,
          key: `${SETTINGS_PREFIX}${setting}`,
          value: model,
        }));
      writes.push({ type: 'put', key: `${SETTINGS_PREFIX}${ACTIVE_MIX_SETTING}`, value: mix.id });
      const agents = mix.models['coordinator.model'];
      if (agents !== undefined) {
        const memberId = await runtime.store.get(`${SETTINGS_PREFIX}coordinator.member`);
        const stored =
          typeof memberId === 'string' ? await runtime.store.get(`crew/${memberId}`) : undefined;
        if (stored !== undefined) {
          const member = CrewMember.parse(stored);
          writes.push({
            type: 'put',
            key: `crew/${member.id}`,
            value: { ...member, model: agents },
          });
        }
      }
      await runtime.store.batch(writes);
      return { applied: mix.models };
    },
  });

  const remove = defineCommand({
    id: 'models.mix.delete',
    title: 'Delete model mix',
    description: 'Deletes a saved model mix. The models in use stay as they are.',
    effect: 'destructive',
    input: z.object({ id: z.string() }),
    output: z.object({ deleted: z.string() }),
    handler: async ({ runtime }, { id }) => {
      const mix = await requireMix(runtime.store, 'models.mix.delete', id);
      const writes: WriteOperation[] = [{ type: 'delete', key: `${MODEL_MIX_PREFIX}${mix.id}` }];
      if ((await runtime.store.get(`${SETTINGS_PREFIX}${ACTIVE_MIX_SETTING}`)) === mix.id) {
        writes.push({ type: 'delete', key: `${SETTINGS_PREFIX}${ACTIVE_MIX_SETTING}` });
      }
      await runtime.store.batch(writes);
      return { deleted: mix.id };
    },
  });

  return [list, save, apply, remove];
}
