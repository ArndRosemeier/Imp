import { z } from 'zod';
import { defineCommand, type Command } from '../command.js';
import { copyTree, removeTree } from '../projects/tree.js';
import { PathStep, ProjectSummary, type ModeProjectSupport } from '../projects/support.js';
import {
  addProject,
  CURRENT_PROJECT_SETTING,
  freeName,
  listProjects,
  Project,
  projectIndexKey,
  projectPrefix,
  requireProject,
} from '../projects/model.js';
import { createCopyCommands } from './project-copy.js';
import { createFileCommands, EXPORT_PREFIX } from './project-files.js';
import { createTemplateCommands, instantiateTemplate } from './project-templates.js';

const ProjectId = z.string().describe('The id of a project from project.list.');

/**
 * Every project command. Modes add templates, progress and resource copying
 * through `support`; without it the commands still create, copy, export and
 * import whole projects.
 */
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- typed commands are inferred from their definitions
export function createProjectCommandSet(support: readonly ModeProjectSupport[] = []) {
  const modeOf = (mode: string): ModeProjectSupport | undefined =>
    support.find((candidate) => candidate.mode === mode);

  const create = defineCommand({
    id: 'project.create',
    title: 'Create project',
    description:
      'Starts a new project in the given working mode and returns it. Give a templateId from project.template.list to start from a template instead of empty.',
    effect: 'write',
    input: z.object({
      name: z.string().min(1).describe('What the project is called.'),
      mode: Project.shape.mode.describe('The working mode, for example "movie".'),
      templateId: z
        .string()
        .optional()
        .describe('A template to start from, from project.template.list. Leave out for empty.'),
    }),
    output: Project,
    handler: async ({ runtime }, input) => {
      const id = runtime.newId();
      if (input.templateId !== undefined) {
        await instantiateTemplate(runtime, support, input.templateId, input.mode, id);
      }
      return addProject(runtime, { id, name: input.name, mode: input.mode });
    },
  });

  const list = defineCommand({
    id: 'project.list',
    title: 'List projects',
    description:
      'Returns every project with its id, name and working mode, oldest first. project.overview adds how far each has come.',
    effect: 'read',
    input: z.object({}),
    output: z.object({ projects: z.array(Project) }),
    handler: async ({ runtime }) => ({ projects: await listProjects(runtime.store) }),
  });

  const open = defineCommand({
    id: 'project.open',
    title: 'Open project',
    description:
      'Opens a project in the app, so that the person sees it, and notes when it was opened. The open project is the setting "project.current".',
    effect: 'write',
    input: z.object({ projectId: ProjectId }),
    output: Project,
    handler: async ({ runtime }, { projectId }) => {
      const project: Project = {
        ...(await requireProject(runtime.store, 'project.open', projectId)),
        openedAt: runtime.now().toISOString(),
      };
      await runtime.store.batch([
        { type: 'put', key: projectIndexKey(projectId), value: project },
        { type: 'put', key: `settings/${CURRENT_PROJECT_SETTING}`, value: projectId },
      ]);
      return project;
    },
  });

  const rename = defineCommand({
    id: 'project.rename',
    title: 'Rename project',
    description: 'Changes the name of a project.',
    effect: 'write',
    input: z.object({ projectId: ProjectId, name: z.string().min(1) }),
    output: Project,
    handler: async ({ runtime }, { projectId, name }) => {
      const project = {
        ...(await requireProject(runtime.store, 'project.rename', projectId)),
        name,
      };
      await runtime.store.batch([{ type: 'put', key: projectIndexKey(projectId), value: project }]);
      return project;
    },
  });

  const remove = defineCommand({
    id: 'project.delete',
    title: 'Delete project',
    description: 'Removes a project and everything in it, files included. This cannot be undone.',
    effect: 'destructive',
    input: z.object({ projectId: ProjectId }),
    output: z.object({ projectId: z.string(), removedEntries: z.number() }),
    handler: async ({ runtime }, { projectId }) => {
      await requireProject(runtime.store, 'project.delete', projectId);
      const removedEntries = await removeTree(runtime, projectPrefix(projectId), [
        { type: 'delete', key: projectIndexKey(projectId) },
      ]);
      await runtime.blobs.delete(`${EXPORT_PREFIX}${projectId}`);
      return { projectId, removedEntries };
    },
  });

  const duplicate = defineCommand({
    id: 'project.duplicate',
    title: 'Duplicate project',
    description:
      'Makes a complete copy of a project, files included, as a new project. The original stays as it is. Returns the copy.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      name: z
        .string()
        .min(1)
        .optional()
        .describe('The name of the copy. Defaults to "<name> (2)".'),
    }),
    output: Project,
    handler: async ({ runtime }, input) => {
      const source = await requireProject(runtime.store, 'project.duplicate', input.projectId);
      const id = runtime.newId();
      await copyTree(runtime, projectPrefix(source.id), projectPrefix(id));
      const taken = (await listProjects(runtime.store)).map((project) => project.name);
      return addProject(runtime, {
        id,
        name: input.name ?? freeName(source.name, taken),
        mode: source.mode,
      });
    },
  });

  const OverviewEntry = Project.extend({
    summary: ProjectSummary.nullable(),
    /** 0 to 1: the share of the stages done, on average. */
    progress: z.number().min(0).max(1),
  });
  const overview = defineCommand({
    id: 'project.overview',
    title: 'Overview of projects',
    description:
      'Returns every project with how far it has come, stage by stage, most recently opened first. This is what the start screen shows.',
    effect: 'read',
    input: z.object({}),
    output: z.object({ projects: z.array(OverviewEntry), currentProjectId: z.string().nullable() }),
    handler: async ({ runtime }) => {
      const projects = await listProjects(runtime.store);
      const entries = [];
      for (const project of projects) {
        const summarize = modeOf(project.mode)?.summarize;
        const summary = summarize === undefined ? null : await summarize(runtime, project.id);
        const stages = summary?.stages ?? [];
        const progress =
          stages.length === 0
            ? 0
            : stages.reduce((sum, s) => sum + (s.total === 0 ? 0 : s.done / s.total), 0) /
              stages.length;
        entries.push({ ...project, summary, progress });
      }
      const recent = (p: Project): string => p.openedAt ?? p.createdAt;
      entries.sort((a, b) => (recent(a) < recent(b) ? 1 : recent(a) > recent(b) ? -1 : 0));
      const current = await runtime.store.get(`settings/${CURRENT_PROJECT_SETTING}`);
      return {
        projects: entries,
        currentProjectId: typeof current === 'string' ? current : null,
      };
    },
  });

  const path = defineCommand({
    id: 'project.path',
    title: 'Guided path',
    description:
      'Returns the guided way to a first film for a project: the steps in order, which are done, and the next one. Use it to tell a newcomer what to do next, or to do that step for them.',
    effect: 'read',
    input: z.object({
      projectId: ProjectId.optional().describe('Leave out for the open project.'),
    }),
    output: z.object({
      projectId: z.string().nullable(),
      steps: z.array(PathStep.extend({ done: z.boolean() })),
      next: z.string().nullable().describe('The first step not done yet, or null when all are.'),
    }),
    handler: async ({ runtime }, input) => {
      const current = await runtime.store.get(`settings/${CURRENT_PROJECT_SETTING}`);
      const projectId = input.projectId ?? (typeof current === 'string' ? current : null);
      if (projectId === null) return { projectId: null, steps: [], next: null };
      const project = await requireProject(runtime.store, 'project.path', projectId);
      const guided = modeOf(project.mode)?.path;
      if (guided === undefined) return { projectId, steps: [], next: null };
      const done = await guided.done(runtime, projectId);
      const steps = guided.steps.map((step) => ({ ...step, done: done.has(step.id) }));
      return { projectId, steps, next: steps.find((step) => !step.done)?.id ?? null };
    },
  });

  return {
    create,
    list,
    open,
    rename,
    remove,
    duplicate,
    overview,
    path,
    ...createFileCommands(support),
    ...createTemplateCommands(support),
    ...createCopyCommands(support),
  };
}

/** Every project command as a list, ready to register. */
export function createProjectCommands(support: readonly ModeProjectSupport[] = []): Command[] {
  return Object.values(createProjectCommandSet(support));
}

const basic = createProjectCommandSet();
export const projectCreate = basic.create;
export const projectList = basic.list;
export const projectOpen = basic.open;
export const projectRename = basic.rename;
export const projectDelete = basic.remove;
export const projectDuplicate = basic.duplicate;
/** The project commands without any mode's support. */
export const projectCommands: readonly Command[] = Object.values(basic);
