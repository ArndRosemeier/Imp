import { z } from 'zod';
import { CommandError } from '../errors.js';
import type { CoreRuntime } from '../runtime.js';
import type { KeyValueStore } from '../storage/kv.js';

export const Project = z.object({
  id: z.string(),
  name: z.string().min(1),
  /** The working mode this project is made in, for example `movie`. */
  mode: z.string().regex(/^[a-z][a-z0-9-]*$/),
  createdAt: z.iso.datetime(),
  /** When it was last opened, for ordering the start screen. Null before it was opened. */
  openedAt: z.iso.datetime().nullable().default(null),
});
export type Project = z.infer<typeof Project>;

export const PROJECT_INDEX_PREFIX = 'project-index/';
/** The setting that says which project is open. */
export const CURRENT_PROJECT_SETTING = 'project.current';

/** Everything that belongs to a project lives under this prefix, so deleting it is one sweep. */
export function projectPrefix(projectId: string): string {
  return `projects/${projectId}/`;
}

export function projectIndexKey(projectId: string): string {
  return `${PROJECT_INDEX_PREFIX}${projectId}`;
}

export async function readProject(
  store: KeyValueStore,
  projectId: string,
): Promise<Project | undefined> {
  const value = await store.get(projectIndexKey(projectId));
  return value === undefined ? undefined : Project.parse(value);
}

export async function listProjects(store: KeyValueStore): Promise<Project[]> {
  return (await store.list(PROJECT_INDEX_PREFIX))
    .map((entry) => Project.parse(entry.value))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

/** Returns the project or fails the command, for handlers that need it to exist. */
export async function requireProject(
  store: KeyValueStore,
  commandId: string,
  projectId: string,
  mode?: string,
): Promise<Project> {
  const project = await readProject(store, projectId);
  if (project === undefined) {
    throw new CommandError('invalid_input', commandId, `No project "${projectId}".`);
  }
  if (mode !== undefined && project.mode !== mode) {
    throw new CommandError(
      'invalid_input',
      commandId,
      `"${project.name}" is a ${project.mode} project, not a ${mode} project.`,
    );
  }
  return project;
}

/** A name not yet taken: `base`, or `base (2)`, `base (3)` and so on. */
export function freeName(base: string, taken: Iterable<string>): string {
  const names = new Set([...taken].map((name) => name.trim().toLowerCase()));
  if (!names.has(base.trim().toLowerCase())) return base;
  const stem = base.replace(/ \(\d+\)$/, '');
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${String(n)})`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
}

/** Writes a new project's index entry, after its contents are in place. */
export async function addProject(
  runtime: CoreRuntime,
  fields: { id: string; name: string; mode: string },
): Promise<Project> {
  const project: Project = {
    ...fields,
    createdAt: runtime.now().toISOString(),
    openedAt: null,
  };
  await runtime.store.batch([{ type: 'put', key: projectIndexKey(project.id), value: project }]);
  return project;
}
