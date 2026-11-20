import { z } from 'zod';
import { ArchiveError, decodeUtf8, encodeUtf8, readArchive, writeArchive } from '../archive.js';
import { defineCommand } from '../command.js';
import { CommandError } from '../errors.js';
import type { JsonValue } from '../json.js';
import {
  addProject,
  freeName,
  listProjects,
  Project,
  projectPrefix,
  requireProject,
} from '../projects/model.js';
import type { ModeProjectSupport } from '../projects/support.js';
import { createRewriter } from '../projects/tree.js';
import { assertValidKey } from '../storage/kv.js';

/** Where an export waits for the interface to save it. One per project, replaced each time. */
export const EXPORT_PREFIX = 'exports/';
/** Where the interface puts a file the person picked, for a command to read. */
export const UPLOAD_PREFIX = 'uploads/';

const MANIFEST = 'project.json';
const FILES = 'files/';
const FORMAT = 'imp-project';
const VERSION = 1;

/**
 * The table of contents of a project file. Records are kept as they are
 * stored, with keys relative to the project; keys inside them still name the
 * project they came from, `project.id`, and are moved on import.
 */
const Manifest = z.object({
  format: z.literal(FORMAT),
  version: z.number().int(),
  exportedAt: z.string(),
  project: z.object({
    id: z.string(),
    name: z.string().min(1),
    mode: z.string(),
    createdAt: z.string(),
  }),
  entries: z.array(z.object({ key: z.string(), value: z.json() })),
  files: z.array(z.object({ key: z.string(), mediaType: z.string(), sizeBytes: z.number() })),
});

/** A file name for `name` that every system accepts. */
export function fileNameFor(name: string): string {
  const safe = name
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return `${safe === '' ? 'project' : safe}.imp.zip`;
}

function checkRelativeKey(key: string, projectId: string): string {
  const full = `${projectPrefix(projectId)}${key}`;
  const segments = key.split('/');
  try {
    if (segments.some((segment) => segment === '.' || segment === '..')) throw new TypeError(key);
    assertValidKey(full);
  } catch {
    throw new CommandError(
      'invalid_input',
      'project.import',
      `The file holds a bad key: "${key}".`,
    );
  }
  return full;
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- typed commands are inferred from their definitions
export function createFileCommands(support: readonly ModeProjectSupport[]) {
  const exportProject = defineCommand({
    id: 'project.export',
    title: 'Export project',
    description:
      'Packs a project, files included, into one .imp.zip file, for a backup or to move it to another computer or between the browser and the local server. Returns the key of the file, which the app offers the person to save; project.import reads such a file back.',
    effect: 'write',
    input: z.object({ projectId: z.string().describe('The id of a project from project.list.') }),
    output: z.object({
      fileKey: z.string(),
      fileName: z.string(),
      sizeBytes: z.number(),
      records: z.number(),
      files: z.number(),
    }),
    handler: async ({ runtime }, { projectId }) => {
      const project = await requireProject(runtime.store, 'project.export', projectId);
      const prefix = projectPrefix(projectId);
      const entries = await runtime.store.list(prefix);
      const fileKeys = await runtime.blobs.list(prefix);
      const archived: { path: string; bytes: Uint8Array }[] = [];
      const files: z.infer<typeof Manifest>['files'] = [];
      for (const key of fileKeys) {
        const blob = await runtime.blobs.get(key);
        if (blob === undefined) continue;
        const relative = key.slice(prefix.length);
        files.push({ key: relative, mediaType: blob.mediaType, sizeBytes: blob.bytes.length });
        archived.push({ path: `${FILES}${relative}`, bytes: blob.bytes });
      }
      const manifest = {
        format: FORMAT,
        version: VERSION,
        exportedAt: runtime.now().toISOString(),
        project: {
          id: project.id,
          name: project.name,
          mode: project.mode,
          createdAt: project.createdAt,
        },
        entries: entries.map((entry) => ({
          key: entry.key.slice(prefix.length),
          value: entry.value,
        })),
        files,
      } satisfies Record<keyof z.infer<typeof Manifest>, unknown>;
      let bytes: Uint8Array;
      try {
        bytes = writeArchive(
          [{ path: MANIFEST, bytes: encodeUtf8(JSON.stringify(manifest, null, 1)) }, ...archived],
          runtime.now(),
        );
      } catch (error) {
        if (error instanceof ArchiveError) {
          throw new CommandError('invalid_input', 'project.export', error.message);
        }
        throw error;
      }
      const fileKey = `${EXPORT_PREFIX}${projectId}`;
      await runtime.blobs.put(fileKey, { bytes, mediaType: 'application/zip' });
      return {
        fileKey,
        fileName: fileNameFor(project.name),
        sizeBytes: bytes.length,
        records: entries.length,
        files: files.length,
      };
    },
  });

  const importProject = defineCommand({
    id: 'project.import',
    title: 'Import project',
    description:
      'Makes a new project from a file that project.export made, files included. The fileKey is where the app put the file the person picked. The project in the file is never merged into an existing one; it always becomes a new project.',
    effect: 'write',
    input: z.object({
      fileKey: z
        .string()
        .refine((key) => key.startsWith(UPLOAD_PREFIX) || key.startsWith(EXPORT_PREFIX), {
          message: 'Only a picked or exported file can be imported.',
        })
        .describe('Where the file is: under "uploads/" for one the person picked.'),
      name: z
        .string()
        .min(1)
        .optional()
        .describe('A name for the new project. Defaults to the one in the file.'),
    }),
    output: Project.extend({ records: z.number(), files: z.number() }),
    handler: async ({ runtime }, input) => {
      const fail = (message: string): never => {
        throw new CommandError('invalid_input', 'project.import', message);
      };
      try {
        const stored = await runtime.blobs.get(input.fileKey);
        if (stored === undefined) return fail(`No file is stored under "${input.fileKey}".`);
        let archive: ReturnType<typeof readArchive>;
        try {
          archive = readArchive(stored.bytes);
        } catch (error) {
          return fail(error instanceof ArchiveError ? error.message : 'The file cannot be read.');
        }
        const byPath = new Map(archive.map((entry) => [entry.path, entry.bytes]));
        const text = byPath.get(MANIFEST);
        if (text === undefined) return fail('This is not an Imp project file.');
        let raw: unknown;
        try {
          raw = JSON.parse(decodeUtf8(text));
        } catch {
          return fail('The project file is damaged: its table of contents is not readable.');
        }
        const parsed = Manifest.safeParse(raw);
        if (!parsed.success) return fail('This is not an Imp project file, or it is damaged.');
        const manifest = parsed.data;
        if (manifest.version > VERSION) {
          return fail('This file was made by a newer Imp. Update Imp to open it.');
        }
        if (support.length > 0 && !support.some((mode) => mode.mode === manifest.project.mode)) {
          return fail(
            `The project was made in the "${manifest.project.mode}" mode, which this Imp does not have.`,
          );
        }

        const id = runtime.newId();
        const rewrite = createRewriter({
          fromPrefix: projectPrefix(manifest.project.id),
          toPrefix: projectPrefix(id),
        });
        const writes = manifest.entries.map((entry) => ({
          type: 'put' as const,
          key: checkRelativeKey(entry.key, id),
          value: rewrite.value(entry.value as JsonValue),
        }));
        const files = manifest.files.map((file) => {
          const bytes = byPath.get(`${FILES}${file.key}`);
          if (bytes === undefined)
            return fail(`The file "${file.key}" is missing from the archive.`);
          return { key: checkRelativeKey(file.key, id), bytes, mediaType: file.mediaType };
        });
        for (const file of files) {
          await runtime.blobs.put(file.key, { bytes: file.bytes, mediaType: file.mediaType });
        }
        await runtime.store.batch(writes);
        const taken = (await listProjects(runtime.store)).map((project) => project.name);
        const project = await addProject(runtime, {
          id,
          name: input.name ?? freeName(manifest.project.name, taken),
          mode: manifest.project.mode,
        });
        return { ...project, records: writes.length, files: files.length };
      } finally {
        if (input.fileKey.startsWith(UPLOAD_PREFIX)) await runtime.blobs.delete(input.fileKey);
      }
    },
  });

  return { exportProject, importProject };
}
