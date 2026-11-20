import { z } from 'zod';
import { Actor } from '../actor.js';
import { defineCommand } from '../command.js';
import { CommandError } from '../errors.js';
import { requireProject } from '../projects/model.js';
import {
  CollisionChoice,
  CopyOutcome,
  itemKey,
  PlannedItem,
  ResourceItem,
  ResourceKindInfo,
  type CopySpec,
  type ModeProjectSupport,
  type ResourceCopier,
} from '../projects/support.js';
import type { CoreRuntime } from '../runtime.js';

/** Copies that wait for a person to say what to do about collisions. */
export const COPY_REQUEST_PREFIX = 'copy-requests/';
/** How many finished requests are kept, so an agent can still look up how its copy ended. */
const KEEP_FINISHED = 20;

export const CopyRequest = z.object({
  id: z.string(),
  mode: z.string(),
  fromProjectId: z.string(),
  fromName: z.string(),
  toProjectId: z.string(),
  toName: z.string(),
  picks: z.array(z.object({ kind: z.string(), id: z.string() })),
  parentId: z.string().nullable(),
  requestedBy: Actor,
  requestedAt: z.iso.datetime(),
  /** What whoever asked would choose, shown to the person as the preselection. */
  suggestion: CollisionChoice.nullable(),
  /** Why the copy is wanted, in the words of whoever asked. */
  note: z.string(),
  status: z.enum(['pending', 'done', 'cancelled']),
  plan: z.array(PlannedItem),
  outcomes: z.array(CopyOutcome).nullable(),
  resolvedAt: z.iso.datetime().nullable(),
});
export type CopyRequest = z.infer<typeof CopyRequest>;

const requestKey = (id: string): string => `${COPY_REQUEST_PREFIX}${id}`;

async function readRequest(runtime: CoreRuntime, commandId: string, id: string) {
  const stored = await runtime.store.get(requestKey(id));
  if (stored === undefined) {
    throw new CommandError('invalid_input', commandId, `No copy request "${id}".`);
  }
  return CopyRequest.parse(stored);
}

async function pruneFinished(runtime: CoreRuntime): Promise<void> {
  const finished = (await runtime.store.list(COPY_REQUEST_PREFIX))
    .map((entry) => CopyRequest.parse(entry.value))
    .filter((request) => request.status !== 'pending')
    .sort((a, b) => ((a.resolvedAt ?? '') < (b.resolvedAt ?? '') ? 1 : -1));
  const stale = finished.slice(KEEP_FINISHED);
  if (stale.length > 0) {
    await runtime.store.batch(
      stale.map((r) => ({ type: 'delete' as const, key: requestKey(r.id) })),
    );
  }
}

const Picks = z
  .array(z.object({ kind: z.string(), id: z.string() }))
  .min(1)
  .describe('What to copy, as kind and id pairs from project.resources.list.');

/**
 * Copying single resources between projects. Whoever asks for a copy, a
 * person or an agent, never decides what happens when something of the same
 * id or name is already in the target: the copy then waits as a request, the
 * app puts the question to the person, and only a person can answer it.
 */
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- typed commands are inferred from their definitions
export function createCopyCommands(support: readonly ModeProjectSupport[]) {
  async function copierFor(
    runtime: CoreRuntime,
    commandId: string,
    fromProjectId: string,
    toProjectId: string,
  ) {
    const from = await requireProject(runtime.store, commandId, fromProjectId);
    const to = await requireProject(runtime.store, commandId, toProjectId);
    if (from.id === to.id) {
      throw new CommandError('invalid_input', commandId, 'Pick two different projects.');
    }
    if (from.mode !== to.mode) {
      throw new CommandError(
        'invalid_input',
        commandId,
        `"${from.name}" is a ${from.mode} project and "${to.name}" a ${to.mode} project; resources copy only between projects of one mode.`,
      );
    }
    const copier = support.find((mode) => mode.mode === from.mode)?.resources;
    if (copier === undefined) {
      throw new CommandError(
        'invalid_input',
        commandId,
        `The ${from.mode} mode has nothing that can be copied on its own.`,
      );
    }
    return { from, to, copier };
  }

  function checkPicks(copier: ResourceCopier, spec: CopySpec, commandId: string): void {
    for (const pick of spec.picks) {
      const kind = copier.kinds.find((k) => k.id === pick.kind);
      if (kind === undefined) {
        throw new CommandError(
          'invalid_input',
          commandId,
          `"${pick.kind}" is not something that can be copied. Kinds: ${copier.kinds.map((k) => k.id).join(', ')}.`,
        );
      }
      if (kind.needsParent && spec.parentId === null) {
        throw new CommandError(
          'invalid_input',
          commandId,
          `A ${kind.label.toLowerCase()} needs a ${copier.kinds.find((k) => k.id === kind.parentKind)?.label.toLowerCase() ?? 'place'} in the target: give parentId.`,
        );
      }
    }
  }

  const list = defineCommand({
    id: 'project.resources.list',
    title: 'List copyable resources',
    description:
      'Returns what in a project can be copied into another project of the same mode, such as characters, scenes, shots and sounds, with their kinds and ids for project.resources.copy.',
    effect: 'read',
    input: z.object({ projectId: z.string().describe('The id of a project from project.list.') }),
    output: z.object({ kinds: z.array(ResourceKindInfo), items: z.array(ResourceItem) }),
    handler: async ({ runtime }, { projectId }) => {
      const project = await requireProject(runtime.store, 'project.resources.list', projectId);
      const copier = support.find((mode) => mode.mode === project.mode)?.resources;
      if (copier === undefined) return { kinds: [], items: [] };
      return { kinds: [...copier.kinds], items: await copier.list(runtime, projectId) };
    },
  });

  const copy = defineCommand({
    id: 'project.resources.copy',
    title: 'Copy resources between projects',
    description:
      'Copies resources from one project into another of the same mode, files included. What they need comes along: the characters in a copied scene\'s shots, for example. If something of the same id or name is already in the target, nothing is copied yet and the person is asked what to do (overwrite, keep both or skip); the result then says "waiting-for-person", and project.resources.request.get tells later how it ended. You cannot answer that question yourself.',
    effect: 'write',
    input: z.object({
      fromProjectId: z.string(),
      toProjectId: z.string(),
      items: Picks,
      parentId: z
        .string()
        .optional()
        .describe(
          'For kinds that live in a parent, such as shots and sounds in a scene: the id of the parent in the target.',
        ),
      suggestion: CollisionChoice.optional().describe(
        'What you would do about collisions; the person sees it preselected and decides.',
      ),
      note: z
        .string()
        .max(500)
        .default('')
        .describe('Why the copy is wanted, shown to the person.'),
    }),
    output: z.discriminatedUnion('status', [
      z.object({ status: z.literal('copied'), outcomes: z.array(CopyOutcome) }),
      z.object({
        status: z.literal('waiting-for-person'),
        requestId: z.string(),
        collisions: z.array(PlannedItem),
        message: z.string(),
      }),
    ]),
    handler: async ({ runtime, actor }, input) => {
      const commandId = 'project.resources.copy';
      const { from, to, copier } = await copierFor(
        runtime,
        commandId,
        input.fromProjectId,
        input.toProjectId,
      );
      const spec: CopySpec = {
        fromProjectId: from.id,
        toProjectId: to.id,
        picks: input.items,
        parentId: input.parentId ?? null,
      };
      checkPicks(copier, spec, commandId);
      const plan = await copier.plan(runtime, spec);
      const collisions = plan.filter((item) => item.collision !== null);
      if (collisions.length === 0) {
        return {
          status: 'copied' as const,
          outcomes: await copier.apply(runtime, spec, plan, new Map()),
        };
      }
      const request: CopyRequest = {
        id: runtime.newId(),
        mode: from.mode,
        fromProjectId: from.id,
        fromName: from.name,
        toProjectId: to.id,
        toName: to.name,
        picks: [...spec.picks],
        parentId: spec.parentId,
        requestedBy: actor,
        requestedAt: runtime.now().toISOString(),
        suggestion: input.suggestion ?? null,
        note: input.note,
        status: 'pending',
        plan,
        outcomes: null,
        resolvedAt: null,
      };
      await runtime.store.batch([{ type: 'put', key: requestKey(request.id), value: request }]);
      return {
        status: 'waiting-for-person' as const,
        requestId: request.id,
        collisions,
        message: `${String(collisions.length)} of these are already in "${to.name}". The person is being asked what to do; nothing was copied yet.`,
      };
    },
  });

  const requests = defineCommand({
    id: 'project.resources.request.list',
    title: 'List copy requests',
    description:
      'Returns copies that wait for the person to decide about collisions, oldest first, and the recently finished ones.',
    effect: 'read',
    input: z.object({ pendingOnly: z.boolean().default(true) }),
    output: z.object({ requests: z.array(CopyRequest) }),
    handler: async ({ runtime }, { pendingOnly }) => ({
      requests: (await runtime.store.list(COPY_REQUEST_PREFIX))
        .map((entry) => CopyRequest.parse(entry.value))
        .filter((request) => !pendingOnly || request.status === 'pending')
        .sort((a, b) => (a.requestedAt < b.requestedAt ? -1 : 1)),
    }),
  });

  const get = defineCommand({
    id: 'project.resources.request.get',
    title: 'Look at a copy request',
    description:
      'Returns a copy request: whether the person has decided yet, and once done what was copied, overwritten, kept twice or skipped.',
    effect: 'read',
    input: z.object({ requestId: z.string() }),
    output: CopyRequest,
    handler: async ({ runtime }, { requestId }) =>
      readRequest(runtime, 'project.resources.request.get', requestId),
  });

  const resolve = defineCommand({
    id: 'project.resources.request.resolve',
    title: 'Decide a copy request',
    description:
      'Answers a waiting copy: a choice for each collision, or cancel. Only the person can run this; agents are refused.',
    effect: 'write',
    input: z.object({
      requestId: z.string(),
      choices: z
        .record(z.string(), CollisionChoice)
        .default({})
        .describe('A choice per collision, keyed "<kind>:<id>".'),
      cancel: z.boolean().default(false),
    }),
    output: CopyRequest,
    handler: async ({ runtime, actor }, input) => {
      const commandId = 'project.resources.request.resolve';
      if (actor.kind !== 'user') {
        throw new CommandError(
          'denied',
          commandId,
          'Only the person decides what happens to collisions in a copy. Tell them it is waiting.',
        );
      }
      const request = await readRequest(runtime, commandId, input.requestId);
      if (request.status !== 'pending') {
        throw new CommandError(
          'invalid_input',
          commandId,
          `This copy was ${request.status} already.`,
        );
      }
      const finish = async (next: CopyRequest): Promise<CopyRequest> => {
        await runtime.store.batch([{ type: 'put', key: requestKey(next.id), value: next }]);
        await pruneFinished(runtime);
        return next;
      };
      const resolvedAt = runtime.now().toISOString();
      if (input.cancel) return finish({ ...request, status: 'cancelled', resolvedAt });

      const { copier } = await copierFor(
        runtime,
        commandId,
        request.fromProjectId,
        request.toProjectId,
      );
      const spec: CopySpec = {
        fromProjectId: request.fromProjectId,
        toProjectId: request.toProjectId,
        picks: request.picks,
        parentId: request.parentId,
      };
      // Either project may have changed while the question waited: plan again.
      const plan = await copier.plan(runtime, spec);
      const choices = new Map<string, CollisionChoice>();
      const open: string[] = [];
      for (const item of plan) {
        if (item.collision === null) continue;
        const choice = input.choices[itemKey(item)];
        if (choice === undefined || !item.collision.choices.includes(choice)) open.push(item.name);
        else choices.set(itemKey(item), choice);
      }
      if (open.length > 0) {
        await runtime.store.batch([
          { type: 'put', key: requestKey(request.id), value: { ...request, plan } },
        ]);
        throw new CommandError('invalid_input', commandId, `Still to decide: ${open.join(', ')}.`);
      }
      const outcomes = await copier.apply(runtime, spec, plan, choices);
      return finish({ ...request, plan, status: 'done', outcomes, resolvedAt });
    },
  });

  return {
    listResources: list,
    copyResources: copy,
    listCopyRequests: requests,
    getCopyRequest: get,
    resolveCopyRequest: resolve,
  };
}
