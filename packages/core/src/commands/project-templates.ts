import { z } from 'zod';
import { defineCommand } from '../command.js';
import { CommandError } from '../errors.js';
import { projectPrefix, requireProject } from '../projects/model.js';
import type { ModeProjectSupport } from '../projects/support.js';
import { copyTree, removeTree } from '../projects/tree.js';
import type { CoreRuntime } from '../runtime.js';

const TEMPLATE_INDEX_PREFIX = 'template-index/';
/** A saved template's records and files, kept like a project's, under its own prefix. */
export const templatePrefix = (templateId: string): string => `templates/${templateId}/`;

export const Template = z.object({
  id: z.string(),
  name: z.string().min(1),
  summary: z.string(),
  mode: z.string(),
  /** Shipped with a mode, or saved by someone from a project. Shipped ones cannot be deleted. */
  builtIn: z.boolean(),
  /** A finished example to open and take apart, rather than a structure to fill. */
  sample: z.boolean().default(false),
  /** For saved ones: when, and from which project. */
  createdAt: z.iso.datetime().nullable(),
  sourceProjectName: z.string().nullable(),
});
export type Template = z.infer<typeof Template>;

async function savedTemplates(runtime: CoreRuntime): Promise<Template[]> {
  return (await runtime.store.list(TEMPLATE_INDEX_PREFIX)).map((entry) =>
    Template.parse(entry.value),
  );
}

/**
 * Fills the new project `projectId` from a template: a shipped one builds its
 * records, a saved one is copied with its files.
 */
export async function instantiateTemplate(
  runtime: CoreRuntime,
  support: readonly ModeProjectSupport[],
  templateId: string,
  mode: string,
  projectId: string,
): Promise<void> {
  const fail = (message: string): never => {
    throw new CommandError('invalid_input', 'project.create', message);
  };
  const shipped = support
    .flatMap((candidate) => (candidate.templates ?? []).map((t) => ({ mode: candidate.mode, t })))
    .find(({ t }) => t.id === templateId);
  if (shipped !== undefined) {
    if (shipped.mode !== mode)
      fail(`The template "${shipped.t.name}" is for ${shipped.mode} projects.`);
    const prefix = projectPrefix(projectId);
    await runtime.store.batch(
      shipped.t.build(runtime.newId).map(({ key, value }) => ({
        type: 'put' as const,
        key: `${prefix}${key}`,
        value,
      })),
    );
    return;
  }
  const stored = await runtime.store.get(`${TEMPLATE_INDEX_PREFIX}${templateId}`);
  if (stored === undefined) fail(`No template "${templateId}". See project.template.list.`);
  const saved = Template.parse(stored);
  if (saved.mode !== mode) fail(`The template "${saved.name}" is for ${saved.mode} projects.`);
  await copyTree(runtime, templatePrefix(templateId), projectPrefix(projectId));
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- typed commands are inferred from their definitions
export function createTemplateCommands(support: readonly ModeProjectSupport[]) {
  const shipped = (): Template[] =>
    support.flatMap((mode) =>
      (mode.templates ?? []).map((template) => ({
        id: template.id,
        name: template.name,
        summary: template.summary,
        mode: mode.mode,
        builtIn: true,
        sample: template.sample ?? false,
        createdAt: null,
        sourceProjectName: null,
      })),
    );

  const listTemplates = defineCommand({
    id: 'project.template.list',
    title: 'List project templates',
    description:
      'Returns the templates a new project can start from: the ones each mode ships with, then the ones saved from projects. Pass a templateId to project.create to use one.',
    effect: 'read',
    input: z.object({ mode: z.string().optional().describe('Only templates for this mode.') }),
    output: z.object({ templates: z.array(Template) }),
    handler: async ({ runtime }, { mode }) => {
      const saved = (await savedTemplates(runtime)).sort((a, b) =>
        (a.createdAt ?? '') < (b.createdAt ?? '') ? -1 : 1,
      );
      return {
        templates: [...shipped(), ...saved].filter((t) => mode === undefined || t.mode === mode),
      };
    },
  });

  const saveTemplate = defineCommand({
    id: 'project.template.save',
    title: 'Save project as template',
    description:
      'Saves a copy of a project, files included, as a template that new projects can start from. Later changes to the project do not change the template.',
    effect: 'write',
    input: z.object({
      projectId: z.string().describe('The id of a project from project.list.'),
      name: z.string().min(1).max(80).describe('What the template is called.'),
      summary: z.string().max(400).default('').describe('What a project made from it starts with.'),
    }),
    output: Template,
    handler: async ({ runtime }, input) => {
      const project = await requireProject(runtime.store, 'project.template.save', input.projectId);
      const id = runtime.newId();
      await copyTree(runtime, projectPrefix(project.id), templatePrefix(id));
      const template: Template = {
        id,
        name: input.name,
        summary: input.summary,
        mode: project.mode,
        builtIn: false,
        createdAt: runtime.now().toISOString(),
        sourceProjectName: project.name,
      };
      await runtime.store.batch([
        { type: 'put', key: `${TEMPLATE_INDEX_PREFIX}${id}`, value: template },
      ]);
      return template;
    },
  });

  const deleteTemplate = defineCommand({
    id: 'project.template.delete',
    title: 'Delete project template',
    description:
      'Removes a saved template and its files. Projects made from it stay as they are. Shipped templates cannot be deleted.',
    effect: 'destructive',
    input: z.object({ templateId: z.string() }),
    output: z.object({ templateId: z.string() }),
    handler: async ({ runtime }, { templateId }) => {
      if (shipped().some((t) => t.id === templateId)) {
        throw new CommandError(
          'invalid_input',
          'project.template.delete',
          'Templates that come with a mode cannot be deleted.',
        );
      }
      if ((await runtime.store.get(`${TEMPLATE_INDEX_PREFIX}${templateId}`)) === undefined) {
        throw new CommandError(
          'invalid_input',
          'project.template.delete',
          `No template "${templateId}".`,
        );
      }
      await removeTree(runtime, templatePrefix(templateId), [
        { type: 'delete', key: `${TEMPLATE_INDEX_PREFIX}${templateId}` },
      ]);
      return { templateId };
    },
  });

  return { listTemplates, saveTemplate, deleteTemplate };
}
