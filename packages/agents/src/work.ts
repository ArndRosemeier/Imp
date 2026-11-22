import {
  CommandError,
  defineCommand,
  type Actor,
  type Command,
  type CommandRegistry,
  type KeyValueStore,
  type WriteOperation,
} from '@imp/core';
import { z } from 'zod';
import { ConversationSchema } from './commands.js';
import {
  allConversationPrefixes,
  conversationPrefix,
  currentConversationProject,
} from './conversations.js';
import { readCrewMember } from './crew.js';
import type { CrewMember } from './crew.js';
import type { Role } from './role.js';
import type { AgentStep } from './run.js';

/**
 * The work board: one record per agent run, kept while it goes on and for a
 * while after, so that anyone (the person or another agent) can see who is
 * working on what right now, what they touched, and what it costs.
 */
export const WORK_PREFIX = 'work/';
/** How many finished runs are kept on the board. */
export const KEPT_FINISHED_WORK = 60;

/** Something a run works on: a scene, a shot, a character, a place. */
export const WorkSubject = z.object({
  /** What kind of thing, from the name of the id field: "scene" for sceneId. */
  kind: z.string(),
  id: z.string(),
  /** Its name for people, such as "Scene 3", or null when nothing better than the id is known. */
  label: z.string().nullable(),
});
export type WorkSubject = z.infer<typeof WorkSubject>;

export const WorkStatus = z.enum([
  'working',
  'completed',
  'awaiting-approval',
  'step-limit',
  'budget-exhausted',
  'cancelled',
  'failed',
]);
export type WorkStatus = z.infer<typeof WorkStatus>;

const WorkNow = z.discriminatedUnion('kind', [
  /** Waiting for the model to answer. */
  z.object({
    kind: z.literal('thinking'),
    at: z.iso.datetime(),
    /** The command it ran just before, whose result it is thinking over. */
    after: z
      .object({ title: z.string(), subjects: z.array(WorkSubject) })
      .nullable()
      .default(null),
  }),
  z.object({
    kind: z.literal('command'),
    at: z.iso.datetime(),
    commandId: z.string(),
    /** The command's title, such as "Update a scene". */
    title: z.string(),
    stage: z.string().nullable(),
    subjects: z.array(WorkSubject),
  }),
]);

export const WorkEntry = z.object({
  id: z.string(),
  memberId: z.string(),
  memberName: z.string(),
  roleId: z.string(),
  roleName: z.string(),
  projectId: z.string().nullable(),
  /** What the agent was asked to do, or null when it went on where it stopped. */
  task: z.string().nullable(),
  /** Who gave the task: the person, or another agent. */
  askedBy: z.object({
    kind: z.enum(['user', 'agent', 'system']),
    id: z.string(),
    name: z.string().nullable(),
  }),
  /** The run of the agent that gave this task, so delegation shows as a tree. */
  parentId: z.string().nullable(),
  status: WorkStatus,
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  steps: z.number().int().nonnegative(),
  maxSteps: z.number().int().positive(),
  costUsd: z.number().nonnegative(),
  budgetUsd: z.number().nonnegative(),
  /** What it is doing at this moment, or null once it stopped. */
  now: WorkNow.nullable(),
  /** The stages it has worked in, in the order it first did. */
  stages: z.array(z.string()),
  /** What it changed or made, newest last. Reads are left out. */
  subjects: z.array(WorkSubject),
  /** How many commands it ran. */
  commands: z.number().int().nonnegative(),
  /** Its closing words, once it finished. */
  summary: z.string().nullable(),
  error: z.string().nullable(),
});
export type WorkEntry = z.infer<typeof WorkEntry>;

/**
 * What a mode adds to the board: in which stage a command belongs, and the
 * names of the things it works on.
 */
export interface WorkDescriber {
  stageOf(commandId: string): string | undefined;
  label?(
    store: KeyValueStore,
    /** The run's project, or null for a run outside any project. */
    projectId: string | null,
    subjects: readonly WorkSubject[],
    input: Readonly<Record<string, unknown>>,
  ): Promise<readonly WorkSubject[]>;
}

/** Keys sort by start time, so a listing returns the board oldest first. */
export const workKey = (entry: Pick<WorkEntry, 'startedAt' | 'id'>): string =>
  `${WORK_PREFIX}${entry.startedAt.replaceAll(':', '-')}_${entry.id}`;

const IGNORED_IDS = new Set(['member', 'project', 'work', 'view', 'state', 'image', 'take']);
const MAX_SUBJECTS = 16;

/** The things a command input names by id: `sceneId: "s1"` is the scene s1. */
export function subjectsOfInput(input: unknown): WorkSubject[] {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return [];
  const found: WorkSubject[] = [];
  for (const [key, value] of Object.entries(input)) {
    const single = /^([a-z][a-zA-Z]*)Id$/.exec(key);
    const many = /^([a-z][a-zA-Z]*)Ids$/.exec(key);
    const kind = single?.[1] ?? many?.[1];
    if (kind === undefined || IGNORED_IDS.has(kind)) continue;
    const ids = single !== null ? [value] : Array.isArray(value) ? value : [];
    for (const id of ids) {
      if (typeof id === 'string' && id.length > 0) found.push({ kind, id, label: null });
    }
  }
  return found;
}

const sameSubject = (a: WorkSubject, b: WorkSubject): boolean => a.kind === b.kind && a.id === b.id;

/** Adds what is new at the end, moving what was there already, and keeps the latest few. */
export function mergeSubjects(
  earlier: readonly WorkSubject[],
  added: readonly WorkSubject[],
): WorkSubject[] {
  const kept = earlier.filter((subject) => !added.some((next) => sameSubject(subject, next)));
  return [...kept, ...added].slice(-MAX_SUBJECTS);
}

const stored = (entry: WorkEntry) => z.json().parse(JSON.parse(JSON.stringify(entry)));

async function writeWork(store: KeyValueStore, entry: WorkEntry): Promise<void> {
  await store.batch([{ type: 'put', key: workKey(entry), value: stored(entry) }]);
}

export async function readWork(store: KeyValueStore): Promise<WorkEntry[]> {
  return (await store.list(WORK_PREFIX)).flatMap((item) => {
    const parsed = WorkEntry.safeParse(item.value);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Drops the oldest finished runs beyond what the board keeps. */
async function pruneWork(store: KeyValueStore): Promise<void> {
  const finished = (await store.list(WORK_PREFIX)).filter(
    (item) => WorkEntry.safeParse(item.value).data?.status !== 'working',
  );
  const extra = finished.length - KEPT_FINISHED_WORK;
  if (extra <= 0) return;
  await store.batch(
    finished.slice(0, extra).map((item) => ({ type: 'delete' as const, key: item.key })),
  );
}

/**
 * Runs left marked as working when the host stopped are not going on any
 * more. Called when a host starts and after a backup was loaded.
 */
export async function releaseInterruptedWork(store: KeyValueStore, at: string): Promise<void> {
  const operations: WriteOperation[] = [];
  for (const item of await store.list(WORK_PREFIX)) {
    const parsed = WorkEntry.safeParse(item.value);
    if (!parsed.success || parsed.data.status !== 'working') continue;
    operations.push({
      type: 'put',
      key: item.key,
      value: stored({ ...parsed.data, status: 'cancelled', now: null, endedAt: at, updatedAt: at }),
    });
  }
  if (operations.length > 0) await store.batch(operations);
}

export interface WorkTrackerOptions {
  readonly store: KeyValueStore;
  readonly registry: CommandRegistry;
  readonly describer: WorkDescriber | undefined;
  readonly now: () => string;
  readonly newId: () => string;
}

/** Keeps one run's record on the board up to date while the agent works. */
export interface WorkTracker {
  readonly id: string;
  step(step: AgentStep): Promise<void>;
  /** Files the run under another project, when it opened one itself and moved there. */
  moveTo(projectId: string | null): Promise<void>;
  finish(result: {
    status: Exclude<WorkStatus, 'working'>;
    summary: string | null;
    error: string | null;
    /** Left out, what the last step reported is kept. */
    costUsd?: number;
    steps?: number;
  }): Promise<void>;
}

/** The run each working agent is on, so a task it gives another agent is filed under it. */
const runningWork = new WeakMap<KeyValueStore, Map<string, string>>();

export async function startWork(
  options: WorkTrackerOptions,
  run: {
    member: CrewMember;
    role: Role;
    projectId: string | null;
    task: string | null;
    actor: Actor;
    maxSteps: number;
  },
): Promise<WorkTracker> {
  const { store, registry, describer } = options;
  const running = runningWork.get(store) ?? new Map<string, string>();
  runningWork.set(store, running);
  /**
   * The asking agent's run going on now, else its latest one in this project:
   * a task it asked for that the person approved later still belongs there.
   */
  const parentOf = async (agentId: string): Promise<string | null> =>
    running.get(agentId) ??
    (await readWork(store))
      .filter((entry) => entry.memberId === agentId && entry.projectId === run.projectId)
      .at(-1)?.id ??
    null;
  const askedByName =
    run.actor.kind === 'agent' ? ((await readCrewMember(store, run.actor.id))?.name ?? null) : null;
  const at = options.now();
  let entry: WorkEntry = {
    id: options.newId(),
    memberId: run.member.id,
    memberName: run.member.name,
    roleId: run.role.id,
    roleName: run.role.name,
    projectId: run.projectId,
    task: run.task,
    askedBy: { kind: run.actor.kind, id: run.actor.id, name: askedByName },
    parentId: run.actor.kind === 'agent' ? await parentOf(run.actor.id) : null,
    status: 'working',
    startedAt: at,
    updatedAt: at,
    endedAt: null,
    steps: 0,
    maxSteps: run.maxSteps,
    costUsd: 0,
    budgetUsd: run.member.budgetUsdPerRun,
    now: null,
    stages: [],
    subjects: [],
    commands: 0,
    summary: null,
    error: null,
  };
  running.set(run.member.id, entry.id);
  await pruneWork(store);
  await writeWork(store, entry);

  async function labelled(subjects: WorkSubject[], input: unknown): Promise<WorkSubject[]> {
    if (subjects.length === 0 || describer?.label === undefined) {
      return subjects;
    }
    try {
      return [
        ...(await describer.label(
          store,
          entry.projectId,
          subjects,
          (input ?? {}) as Record<string, unknown>,
        )),
      ];
    } catch {
      // A name that cannot be found is no reason to stop the agent.
      return subjects;
    }
  }

  return {
    id: entry.id,
    async step(step) {
      const at = options.now();
      if (step.kind === 'thinking') {
        entry = {
          ...entry,
          steps: step.steps,
          costUsd: step.costUsd,
          updatedAt: at,
          now: {
            kind: 'thinking',
            at,
            after:
              entry.now?.kind === 'command'
                ? { title: entry.now.title, subjects: entry.now.subjects }
                : entry.now?.kind === 'thinking'
                  ? entry.now.after
                  : null,
          },
        };
      } else {
        const command = registry.has(step.commandId) ? registry.get(step.commandId) : undefined;
        const stage = describer?.stageOf(step.commandId) ?? null;
        const subjects = await labelled(subjectsOfInput(step.input), step.input);
        const changes = command !== undefined && command.effect !== 'read';
        entry = {
          ...entry,
          steps: step.steps,
          costUsd: step.costUsd,
          updatedAt: at,
          commands: entry.commands + 1,
          now: {
            kind: 'command',
            at,
            commandId: step.commandId,
            title: command?.title ?? step.commandId,
            stage,
            subjects,
          },
          stages:
            stage === null || entry.stages.includes(stage)
              ? entry.stages
              : [...entry.stages, stage],
          subjects: changes ? mergeSubjects(entry.subjects, subjects) : entry.subjects,
        };
      }
      await writeWork(store, entry);
    },
    async moveTo(projectId) {
      if (projectId === entry.projectId) return;
      entry = { ...entry, projectId, updatedAt: options.now() };
      await writeWork(store, entry);
    },
    async finish(result) {
      const at = options.now();
      if (running.get(run.member.id) === entry.id) running.delete(run.member.id);
      entry = {
        ...entry,
        status: result.status,
        summary: result.summary,
        error: result.error,
        costUsd: result.costUsd ?? entry.costUsd,
        steps: result.steps ?? entry.steps,
        now: null,
        updatedAt: at,
        endedAt: at,
      };
      await writeWork(store, entry);
    },
  };
}

const OUTLINE_CHARS = 200;
const clip = (text: string | null): string | null =>
  text === null || text.length <= OUTLINE_CHARS ? text : `${text.slice(0, OUTLINE_CHARS - 1)}…`;

/** A run as the list shows it: long texts are cut, crew.work.get has them whole. */
const outline = (entry: WorkEntry): WorkEntry => ({
  ...entry,
  task: clip(entry.task),
  summary: clip(entry.summary),
});

const WaitingSchema = z.object({
  memberId: z.string(),
  memberName: z.string(),
  /** The commands it asked to run and the person has not decided on yet. */
  commandIds: z.array(z.string()),
});

export const WorkBoardSchema = z.object({
  projectId: z.string().nullable(),
  /** Runs going on now, oldest first. */
  working: z.array(WorkEntry),
  /** Agents waiting for the person to approve something. */
  waiting: z.array(WaitingSchema),
  /** Finished runs, newest first. */
  recent: z.array(WorkEntry),
  /** What the runs going on have cost so far, and what the listed finished ones cost. */
  workingUsd: z.number(),
  recentUsd: z.number(),
});
export type WorkBoard = z.infer<typeof WorkBoardSchema>;

/** Reading the board is a command, so agents see the same board as the person. */
export function createWorkCommands(): readonly Command[] {
  const list = defineCommand({
    id: 'crew.work.list',
    title: 'See who is working on what',
    description:
      'The crew work board: which agents are working right now, on which task, in which stage and on which scenes, shots or characters, what each run has cost so far, who is waiting for an approval, and the latest finished runs. Long tasks and summaries are cut; crew.work.get has them whole.',
    effect: 'read',
    input: z.object({
      scope: z
        .enum(['project', 'all'])
        .default('project')
        .describe('"project" for the open project only, "all" for every project.'),
      limit: z.number().int().positive().max(KEPT_FINISHED_WORK).default(12),
    }),
    output: WorkBoardSchema,
    handler: async ({ runtime }, input) => {
      const { store } = runtime;
      const projectId = await currentConversationProject(store);
      const shown = (await readWork(store)).filter(
        (entry) => input.scope === 'all' || entry.projectId === projectId,
      );
      const working = shown.filter((entry) => entry.status === 'working').map(outline);
      const recent = shown
        .filter((entry) => entry.status !== 'working')
        .reverse()
        .slice(0, input.limit)
        .map(outline);
      const waiting: z.infer<typeof WaitingSchema>[] = [];
      const prefixes =
        input.scope === 'all'
          ? await allConversationPrefixes(store)
          : [conversationPrefix(projectId)];
      for (const prefix of prefixes) {
        for (const item of await store.list(prefix)) {
          const parsed = ConversationSchema.safeParse(item.value);
          if (!parsed.success || parsed.data.pendingApprovals.length === 0) continue;
          const member = await readCrewMember(store, parsed.data.memberId);
          if (member === undefined) continue;
          waiting.push({
            memberId: member.id,
            memberName: member.name,
            commandIds: parsed.data.pendingApprovals.map((pending) => pending.commandId),
          });
        }
      }
      const sum = (entries: readonly WorkEntry[]): number =>
        entries.reduce((total, entry) => total + entry.costUsd, 0);
      return {
        projectId,
        working,
        waiting,
        recent,
        workingUsd: sum(working),
        recentUsd: sum(recent),
      };
    },
  });

  const get = defineCommand({
    id: 'crew.work.get',
    title: 'Read one run on the work board',
    description:
      'One run from crew.work.list, with its whole task and closing summary, every thing it changed and what it is doing now.',
    effect: 'read',
    input: z.object({ workId: z.string().describe('The id of a run from crew.work.list.') }),
    output: WorkEntry,
    handler: async ({ runtime }, input) => {
      const found = (await readWork(runtime.store)).find((entry) => entry.id === input.workId);
      if (found === undefined) {
        throw new CommandError(
          'invalid_input',
          'crew.work.get',
          `No run "${input.workId}" on the board.`,
        );
      }
      return found;
    },
  });

  return [list, get];
}
