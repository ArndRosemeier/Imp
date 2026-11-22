import { z } from 'zod';
import type { JsonValue } from '../json.js';
import type { CoreRuntime } from '../runtime.js';

/**
 * What a working mode adds to project management. The core copies, exports
 * and duplicates projects without knowing what is in them; for templates, the
 * progress on the start screen and copying single resources between projects
 * it asks the mode.
 */
export interface ProjectSupport {
  /** Starting points the mode ships with. Users save their own besides. */
  readonly templates?: readonly ProjectTemplate[];
  /** How far a project has come, stage by stage, for the start screen. */
  readonly summarize?: (runtime: CoreRuntime, projectId: string) => Promise<ProjectSummary>;
  /** What can be copied from one project into another, and how. */
  readonly resources?: ResourceCopier;
  /** The guided way to a first finished piece, step by step, and which steps a project has done. */
  readonly path?: GuidedPath;
}

/** One step of the guided way to a first film (or whatever a mode makes). */
export const PathStep = z.object({
  id: z.string(),
  title: z.string().describe('What to do, as an instruction: "Cast a character".'),
  body: z.string().describe('Why and how, in a sentence or two, with the price when it costs.'),
  stage: z.string().describe('The stage where it is done.'),
  ask: z.string().describe('What to tell the coordinator to have it done for you.'),
});
export type PathStep = z.infer<typeof PathStep>;

export interface GuidedPath {
  readonly steps: readonly PathStep[];
  /** The ids of the steps a project has done. */
  readonly done: (runtime: CoreRuntime, projectId: string) => Promise<ReadonlySet<string>>;
}

/** `ProjectSupport` together with the mode it belongs to. */
export interface ModeProjectSupport extends ProjectSupport {
  readonly mode: string;
}

export interface ProjectTemplate {
  /** Unique across modes, for example `movie.short-film`. */
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  /** A finished example to open and take apart, offered to newcomers, rather than a structure to fill. */
  readonly sample?: boolean;
  /**
   * The records a new project starts with, keys relative to the project's
   * prefix. `newId` gives fresh ids, so two projects from one template never
   * share them.
   */
  readonly build: (newId: () => string) => readonly { key: string; value: JsonValue }[];
}

export const StageProgress = z.object({
  id: z.string(),
  name: z.string(),
  done: z.number().int().min(0),
  total: z.number().int().min(0),
  /** One short line, for example "4 of 6 clips ready". */
  note: z.string(),
});
export type StageProgress = z.infer<typeof StageProgress>;

export const ProjectSummary = z.object({
  /** A line that says what the project is, for example its logline. Empty when there is none. */
  headline: z.string(),
  stages: z.array(StageProgress),
  /** Images that stand for the project, by blob key: a few portraits, for example. */
  posterKeys: z.array(z.string()),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

/** One thing in a project that can be copied on its own. */
export const ResourceItem = z.object({
  kind: z.string(),
  id: z.string(),
  name: z.string(),
  /** A second line: what it is or how far it is, for picking. */
  detail: z.string(),
  /** For kinds that live inside a scene (or another container): its id. */
  parentId: z.string().nullable(),
});
export type ResourceItem = z.infer<typeof ResourceItem>;

export const ResourceKindInfo = z.object({
  id: z.string(),
  label: z.string(),
  plural: z.string(),
  /** Whether a copy needs a place in the target, such as a scene for a shot. */
  needsParent: z.boolean(),
  /** The kind of the parent, for example "scene". */
  parentKind: z.string().nullable(),
});
export type ResourceKindInfo = z.infer<typeof ResourceKindInfo>;

/**
 * What to do when a copied thing meets one that is already in the target.
 * - `overwrite`: the copy replaces it, and keeps its place and id
 * - `keepBoth`: the copy is added beside it, under a new id
 * - `skip`: the target keeps its own; whatever else is copied that needs it uses that one
 */
export const CollisionChoice = z.enum(['overwrite', 'keepBoth', 'skip']);
export type CollisionChoice = z.infer<typeof CollisionChoice>;

export const Collision = z.object({
  targetId: z.string(),
  targetName: z.string(),
  /** Why the two count as the same: the same id (one came from the other), or the same name. */
  match: z.enum(['id', 'name', 'singleton']),
  choices: z.array(CollisionChoice).min(1),
});
export type Collision = z.infer<typeof Collision>;

export const PlannedItem = z.object({
  kind: z.string(),
  id: z.string(),
  name: z.string(),
  /** Picked by whoever asked, or brought along because something picked needs it. */
  reason: z.enum(['picked', 'needed']),
  /** For `needed`: the name of what needs it. */
  neededBy: z.string().nullable(),
  collision: Collision.nullable(),
});
export type PlannedItem = z.infer<typeof PlannedItem>;

export const CopyOutcome = z.object({
  kind: z.string(),
  id: z.string(),
  name: z.string(),
  /** The id it has in the target; for `skipped`, the one it was matched to. */
  targetId: z.string(),
  outcome: z.enum(['copied', 'overwritten', 'keptBoth', 'skipped']),
});
export type CopyOutcome = z.infer<typeof CopyOutcome>;

export interface CopySpec {
  readonly fromProjectId: string;
  readonly toProjectId: string;
  readonly picks: readonly { readonly kind: string; readonly id: string }[];
  /** Where things that need a parent go, for example the scene that takes copied shots. */
  readonly parentId: string | null;
}

/** The key decisions are filed under: one per planned item. */
export function itemKey(item: { readonly kind: string; readonly id: string }): string {
  return `${item.kind}:${item.id}`;
}

/**
 * Copies a mode's resources between two of its projects. Planning finds what
 * comes along and what collides; applying copies with a choice made for every
 * collision. The core decides who makes those choices: always a person.
 */
export interface ResourceCopier {
  readonly kinds: readonly ResourceKindInfo[];
  list(runtime: CoreRuntime, projectId: string): Promise<ResourceItem[]>;
  plan(runtime: CoreRuntime, spec: CopySpec): Promise<PlannedItem[]>;
  apply(
    runtime: CoreRuntime,
    spec: CopySpec,
    plan: readonly PlannedItem[],
    choices: ReadonlyMap<string, CollisionChoice>,
  ): Promise<CopyOutcome[]>;
}
