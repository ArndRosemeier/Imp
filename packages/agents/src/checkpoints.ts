import {
  CommandError,
  defineCommand,
  projectPrefix,
  readProject,
  type Command,
  type KeyValueStore,
} from '@imp/core';
import { z } from 'zod';
import { currentConversationProject } from './conversations.js';
import type { Need } from './role.js';

/**
 * A point in a mode's workflow where the crew stops and the person looks at
 * what was made before the next, more expensive, stage starts: for a film,
 * the treatment, the storyboard and the first cut. Only the person signs one
 * off; an agent can ask for it, which puts it in front of them.
 */
export interface Checkpoint {
  /** Lower-case and dashed: `treatment`, `storyboard`. */
  readonly id: string;
  readonly name: string;
  /** What is looked at and what waits for it, for people and agents. */
  readonly description: string;
  /** The stage where it is signed off. */
  readonly stage: string;
  /**
   * Signed off one item at a time, such as each scene of a film, so that
   * a long piece moves on part by part. Left out, once for the project.
   */
  readonly per?: { readonly name: string; readonly plural: string };
  /**
   * The one checkpoint the crew still stops at when the person lets it work
   * on its own except at the most important point (working style "main").
   */
  readonly main?: boolean;
}

/**
 * How much the crew does on its own in a project:
 * - `each`: it stops at every checkpoint for the person (the default)
 * - `main`: it stops only at the main checkpoint, such as the storyboard
 * - `none`: it works through to the end; spending still keeps to the budget
 */
export const WorkingStyle = z.enum(['each', 'main', 'none']);
export type WorkingStyle = z.infer<typeof WorkingStyle>;

const Signed = z.object({
  /** When the whole checkpoint was signed off, for one that is signed off once. */
  at: z.iso.datetime().nullable().default(null),
  /** When each item was signed off, for one that is signed off per item. */
  items: z.record(z.string(), z.iso.datetime()).default({}),
});

const Stored = z.object({
  style: WorkingStyle.default('each'),
  signed: z.record(z.string(), Signed).default({}),
});
type Stored = z.infer<typeof Stored>;

/** Where a project keeps its working style and sign-offs. It is copied along with the project. */
export const checkpointsKey = (projectId: string): string =>
  `${projectPrefix(projectId)}checkpoints`;

async function readStored(store: KeyValueStore, projectId: string): Promise<Stored> {
  const parsed = Stored.safeParse(await store.get(checkpointsKey(projectId)));
  return parsed.success ? parsed.data : Stored.parse({});
}

/** The working style of a project. */
export async function readWorkingStyle(
  store: KeyValueStore,
  projectId: string,
): Promise<WorkingStyle> {
  return (await readStored(store, projectId)).style;
}

/** Whether the crew stops at a checkpoint in a project, given its working style. */
export function stopsAt(style: WorkingStyle, checkpoint: Checkpoint): boolean {
  return style === 'each' || (style === 'main' && checkpoint.main === true);
}

/**
 * Whether the crew may go past a checkpoint: it is signed off, or the working
 * style lets the crew go on without it. For a checkpoint signed off per item,
 * `itemId` names the item; without one, any signed-off item counts.
 */
export async function checkpointPassed(
  store: KeyValueStore,
  projectId: string,
  checkpoint: Checkpoint,
  itemId?: string | null,
): Promise<boolean> {
  const stored = await readStored(store, projectId);
  if (!stopsAt(stored.style, checkpoint)) return true;
  const signed = stored.signed[checkpoint.id];
  if (signed === undefined) return false;
  if (checkpoint.per === undefined) return signed.at !== null;
  if (itemId === undefined || itemId === null) return Object.keys(signed.items).length > 0;
  return signed.items[itemId] !== undefined;
}

/**
 * A need that a checkpoint is signed off: the role cannot run `before` until
 * the person has looked. `itemOf` reads the item, such as the scene, from a
 * command's input. Only the person provides it, so it cannot be waived.
 */
export function checkpointNeed(
  checkpoint: Checkpoint,
  before: readonly string[],
  itemOf?: (input: unknown) => string | null,
): Need {
  const per = checkpoint.per === undefined ? '' : ` of this ${checkpoint.per.name}`;
  return {
    id: `checkpoint:${checkpoint.id}`,
    name: `The person's sign-off of the ${checkpoint.name.toLowerCase()}${per}`,
    description: `${checkpoint.description} Only the person signs it off (project.checkpoint.approve asks them); nobody makes it.`,
    byPerson: true,
    before,
    check: async (store, projectId, input) =>
      checkpointPassed(
        store,
        projectId,
        checkpoint,
        input === undefined || itemOf === undefined ? undefined : itemOf(input),
      ),
  };
}

/** Reads a string field, such as `sceneId`, from a command's input. */
export const inputField =
  (field: string) =>
  (input: unknown): string | null => {
    if (typeof input !== 'object' || input === null) return null;
    const value = (input as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : null;
  };

const CheckpointState = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  stage: z.string(),
  per: z
    .string()
    .nullable()
    .describe('What it is signed off for one at a time, such as "scene"; null when once.'),
  main: z.boolean(),
  stops: z
    .boolean()
    .describe('Whether the crew stops here in this project, given the working style.'),
  signedAt: z.string().nullable().describe('When it was signed off as a whole.'),
  items: z
    .array(z.object({ itemId: z.string(), signedAt: z.string() }))
    .describe('The items signed off, for one signed off per item.'),
});

const ProjectInput = z
  .string()
  .optional()
  .describe('The id of a project from project.list. Left out, the open project.');

/**
 * Commands for checkpoints and the working style. Each mode lists its
 * checkpoints; a project uses those of its mode.
 */
export function createCheckpointCommands(
  modes: readonly { readonly mode: string; readonly checkpoints: readonly Checkpoint[] }[],
): readonly Command[] {
  async function resolve(
    store: KeyValueStore,
    commandId: string,
    projectId: string | undefined,
  ): Promise<{ projectId: string; checkpoints: readonly Checkpoint[] }> {
    const id = projectId ?? (await currentConversationProject(store));
    if (id === null) throw new CommandError('invalid_input', commandId, 'Open a project first.');
    const project = await readProject(store, id);
    if (project === undefined) {
      throw new CommandError('invalid_input', commandId, `No project "${id}".`);
    }
    return {
      projectId: id,
      checkpoints: modes.find((entry) => entry.mode === project.mode)?.checkpoints ?? [],
    };
  }

  function find(
    commandId: string,
    checkpoints: readonly Checkpoint[],
    checkpointId: string,
  ): Checkpoint {
    const checkpoint = checkpoints.find((candidate) => candidate.id === checkpointId);
    if (checkpoint === undefined) {
      throw new CommandError('invalid_input', commandId, `No checkpoint "${checkpointId}".`, {
        details: [`checkpointId: one of ${checkpoints.map(({ id }) => id).join(', ') || 'none'}`],
      });
    }
    return checkpoint;
  }

  function stateOf(stored: Stored, checkpoint: Checkpoint): z.input<typeof CheckpointState> {
    const signed = stored.signed[checkpoint.id];
    return {
      id: checkpoint.id,
      name: checkpoint.name,
      description: checkpoint.description,
      stage: checkpoint.stage,
      per: checkpoint.per?.name ?? null,
      main: checkpoint.main === true,
      stops: stopsAt(stored.style, checkpoint),
      signedAt: signed?.at ?? null,
      items: Object.entries(signed?.items ?? {}).map(([itemId, signedAt]) => ({
        itemId,
        signedAt,
      })),
    };
  }

  const Output = z.object({
    projectId: z.string(),
    style: WorkingStyle,
    checkpoints: z.array(CheckpointState),
  });

  const list = defineCommand({
    id: 'project.checkpoint.list',
    keywords: ['sign off', 'approve', 'review', 'gate', 'working style', 'on its own', 'autonomy'],
    title: 'Show the checkpoints',
    description:
      'Returns the checkpoints of a project, where the crew stops for the person to look before the next stage (for a film: the treatment, the storyboard of each scene and the first cut of each scene), which are signed off, and the working style: "each" (the crew stops at every checkpoint, the default), "main" (only at the main one) or "none" (it works through). Work that waits for a checkpoint cannot be done by an agent until the person signs it off.',
    effect: 'read',
    input: z.object({ projectId: ProjectInput }),
    output: Output,
    handler: async ({ runtime }, input) => {
      const { projectId, checkpoints } = await resolve(
        runtime.store,
        'project.checkpoint.list',
        input.projectId,
      );
      const stored = await readStored(runtime.store, projectId);
      return {
        projectId,
        style: stored.style,
        checkpoints: checkpoints.map((checkpoint) => stateOf(stored, checkpoint)),
      };
    },
  });

  const write = async (
    store: KeyValueStore,
    projectId: string,
    change: (stored: Stored) => Stored,
  ): Promise<Stored> => {
    const next = change(await readStored(store, projectId));
    await store.batch([{ type: 'put', key: checkpointsKey(projectId), value: next }]);
    return next;
  };

  const ItemsInput = z
    .array(z.string().min(1))
    .optional()
    .describe(
      'For a checkpoint signed off per item: the items, such as scene ids from movie.scene.list.',
    );

  const approve = defineCommand({
    id: 'project.checkpoint.approve',
    keywords: ['sign off', 'approve', 'looks good', 'go ahead', 'storyboard', 'treatment'],
    title: 'Sign off a checkpoint',
    description:
      'Signs off a checkpoint, so that the work waiting for it can start: the person has looked and says go on. For one signed off per item, name the items (itemIds). When an agent runs it, it is always put to the person, who decides; ask for it once the work is ready to look at, and say what they are signing off.',
    // Counted as spending, so that an agent's sign-off always goes to the person: what waits
    // for a checkpoint is the expensive part. It has no estimate, so no budget lets it through.
    effect: 'spend',
    input: z.object({
      projectId: ProjectInput,
      checkpointId: z.string().min(1).describe('A checkpoint id from project.checkpoint.list.'),
      itemIds: ItemsInput,
    }),
    output: Output,
    handler: async ({ runtime }, input) => {
      const { projectId, checkpoints } = await resolve(
        runtime.store,
        'project.checkpoint.approve',
        input.projectId,
      );
      const checkpoint = find('project.checkpoint.approve', checkpoints, input.checkpointId);
      const items = input.itemIds ?? [];
      if (checkpoint.per !== undefined && items.length === 0) {
        throw new CommandError(
          'invalid_input',
          'project.checkpoint.approve',
          `The ${checkpoint.name.toLowerCase()} is signed off per ${checkpoint.per.name}: name the ${checkpoint.per.plural} (itemIds).`,
        );
      }
      const at = runtime.now().toISOString();
      const stored = await write(runtime.store, projectId, (current) => {
        const signed = Signed.parse(current.signed[checkpoint.id] ?? {});
        const next =
          checkpoint.per === undefined
            ? { ...signed, at }
            : {
                ...signed,
                items: { ...signed.items, ...Object.fromEntries(items.map((id) => [id, at])) },
              };
        return { ...current, signed: { ...current.signed, [checkpoint.id]: next } };
      });
      return {
        projectId,
        style: stored.style,
        checkpoints: checkpoints.map((entry) => stateOf(stored, entry)),
      };
    },
  });

  const reopen = defineCommand({
    id: 'project.checkpoint.reopen',
    keywords: ['undo sign off', 'not yet', 'change again'],
    title: 'Reopen a checkpoint',
    description:
      'Takes back a sign-off, so that the work waiting for it waits again, for example when the treatment is to be changed. For one signed off per item, name the items (itemIds); left out, all of them.',
    effect: 'write',
    input: z.object({
      projectId: ProjectInput,
      checkpointId: z.string().min(1),
      itemIds: ItemsInput,
    }),
    output: Output,
    handler: async ({ runtime }, input) => {
      const { projectId, checkpoints } = await resolve(
        runtime.store,
        'project.checkpoint.reopen',
        input.projectId,
      );
      const checkpoint = find('project.checkpoint.reopen', checkpoints, input.checkpointId);
      const stored = await write(runtime.store, projectId, (current) => {
        const signed = Signed.parse(current.signed[checkpoint.id] ?? {});
        const items =
          input.itemIds === undefined
            ? {}
            : Object.fromEntries(
                Object.entries(signed.items).filter(([id]) => input.itemIds?.includes(id) !== true),
              );
        const next = { at: checkpoint.per === undefined ? null : signed.at, items };
        return { ...current, signed: { ...current.signed, [checkpoint.id]: next } };
      });
      return {
        projectId,
        style: stored.style,
        checkpoints: checkpoints.map((entry) => stateOf(stored, entry)),
      };
    },
  });

  const style = defineCommand({
    id: 'project.checkpoint.style',
    keywords: ['working style', 'on its own', 'autonomous', 'automatic', 'make it all', 'ask me'],
    title: 'Set the working style',
    description:
      'Sets how much the crew does on its own in a project: "each" stops at every checkpoint for the person (the default), "main" only at the main one (for a film, the storyboard), "none" works through to the end. Spending still keeps to the budget. When an agent runs it, it is always put to the person.',
    // An agent that could let itself past every checkpoint would need no sign-off at all.
    effect: 'spend',
    input: z.object({ projectId: ProjectInput, style: WorkingStyle }),
    output: Output,
    handler: async ({ runtime }, input) => {
      const { projectId, checkpoints } = await resolve(
        runtime.store,
        'project.checkpoint.style',
        input.projectId,
      );
      const stored = await write(runtime.store, projectId, (current) => ({
        ...current,
        style: input.style,
      }));
      return {
        projectId,
        style: stored.style,
        checkpoints: checkpoints.map((entry) => stateOf(stored, entry)),
      };
    },
  });

  return [list, approve, reopen, style];
}
