import { z } from 'zod';
import { defineCommand } from '../command.js';
import { CommandError } from '../errors.js';
import type { KeyValueStore } from '../storage/kv.js';

export const Project = z.object({
  id: z.string(),
  name: z.string().min(1),
  /** The working mode this project is made in, for example `movie`. */
  mode: z.string().regex(/^[a-z][a-z0-9-]*$/),
  createdAt: z.iso.datetime(),
});
export type Project = z.infer<typeof Project>;

const INDEX_PREFIX = 'project-index/';

/** Everything that belongs to a project lives under this prefix, so deleting it is one sweep. */
export function projectPrefix(projectId: string): string {
  return `projects/${projectId}/`;
}

export async function readProject(
  store: KeyValueStore,
  projectId: string,
): Promise<Project | undefined> {
  const value = await store.get(`${INDEX_PREFIX}${projectId}`);
  return value === undefined ? undefined : Project.parse(value);
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

export const projectCreate = defineCommand({
  id: 'project.create',
  title: 'Create project',
  description: 'Starts a new project in the given working mode and returns it.',
  effect: 'write',
  input: z.object({
    name: z.string().min(1).describe('What the project is called.'),
    mode: Project.shape.mode.describe('The working mode, for example "movie".'),
  }),
  output: Project,
  handler: async ({ runtime }, input) => {
    const project: Project = {
      id: runtime.newId(),
      name: input.name,
      mode: input.mode,
      createdAt: runtime.now().toISOString(),
    };
    await runtime.store.batch([
      { type: 'put', key: `${INDEX_PREFIX}${project.id}`, value: project },
    ]);
    return project;
  },
});

export const projectList = defineCommand({
  id: 'project.list',
  title: 'List projects',
  description: 'Returns every project with its id, name and working mode, oldest first.',
  effect: 'read',
  input: z.object({}),
  output: z.object({ projects: z.array(Project) }),
  handler: async ({ runtime }) => ({
    projects: (await runtime.store.list(INDEX_PREFIX))
      .map((entry) => Project.parse(entry.value))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)),
  }),
});

export const projectRename = defineCommand({
  id: 'project.rename',
  title: 'Rename project',
  description: 'Changes the name of a project.',
  effect: 'write',
  input: z.object({ projectId: z.string(), name: z.string().min(1) }),
  output: Project,
  handler: async ({ runtime }, { projectId, name }) => {
    const project = { ...(await requireProject(runtime.store, 'project.rename', projectId)), name };
    await runtime.store.batch([
      { type: 'put', key: `${INDEX_PREFIX}${projectId}`, value: project },
    ]);
    return project;
  },
});

export const projectDelete = defineCommand({
  id: 'project.delete',
  title: 'Delete project',
  description: 'Removes a project and everything in it, files included. This cannot be undone.',
  effect: 'destructive',
  input: z.object({ projectId: z.string() }),
  output: z.object({ projectId: z.string(), removedEntries: z.number() }),
  handler: async ({ runtime }, { projectId }) => {
    await requireProject(runtime.store, 'project.delete', projectId);
    const contents = await runtime.store.list(projectPrefix(projectId));
    await runtime.store.batch([
      ...contents.map((entry) => ({ type: 'delete' as const, key: entry.key })),
      { type: 'delete', key: `${INDEX_PREFIX}${projectId}` },
    ]);
    const files = await runtime.blobs.list(projectPrefix(projectId));
    for (const key of files) {
      await runtime.blobs.delete(key);
    }
    return { projectId, removedEntries: contents.length + files.length };
  },
});

export const projectCommands = [projectCreate, projectList, projectRename, projectDelete] as const;
