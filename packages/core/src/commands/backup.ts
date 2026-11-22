import { z } from 'zod';
import { ArchiveError, decodeUtf8, encodeUtf8 } from '../archive.js';
import { defineCommand, type Command } from '../command.js';
import { CommandError } from '../errors.js';
import { listProjects } from '../projects/model.js';
import type { CoreRuntime } from '../runtime.js';
import type { BlobStore } from '../storage/blob.js';
import { assertValidKey, type KeyValueStore, type WriteOperation } from '../storage/kv.js';
import {
  ArchiveStreamWriter,
  readArchiveDirectory,
  readArchiveFile,
  type ArchiveDirectoryEntry,
  type ArchiveSource,
} from '../zip-stream.js';
import { EXPORT_PREFIX, UPLOAD_PREFIX } from './project-files.js';

/**
 * Save all and Load all: everything Imp keeps, in one ZIP file, and back.
 *
 * Everything means every record and every file in the store: projects with
 * their media and rendered films, the library, saved crews, model mixes,
 * custom roles, conversations, settings and help choices. The OpenRouter key
 * is never in it: neither host keeps the key in the store (the browser keeps
 * it encrypted beside it, the local server in its own file), so it cannot
 * end up in a backup.
 *
 * The file is written and read in parts, so a workspace of many gigabytes
 * never has to fit in memory at once.
 */

/** Records about saving and loading. They describe this copy of Imp and are never in a backup. */
export const BACKUP_PREFIX = 'backup/';
export const BACKUP_PENDING_KEY = `${BACKUP_PREFIX}pending`;
export const BACKUP_PROGRESS_KEY = `${BACKUP_PREFIX}progress`;
export const BACKUP_LAST_SAVED_KEY = `${BACKUP_PREFIX}last-saved`;
export const BACKUP_RESTORED_KEY = `${BACKUP_PREFIX}restored`;
/** Where a finished backup waits, in parts, for the interface to save it. */
export const BACKUP_EXPORT_BASE = `${EXPORT_PREFIX}backup`;

/** Bytes per stored part. Small enough for any channel and any storage, large enough to be few. */
export const BACKUP_PART_BYTES = 16 * 1024 * 1024;

const MANIFEST = 'imp-backup.json';
const STORE_FILE = 'store.json';
const FILES = 'files/';
const FORMAT = 'imp-backup';
const VERSION = 1;

/** The key of part `index` of a file stored in parts under `base`. */
export function partKey(base: string, index: number): string {
  return `${base}/part-${String(index).padStart(6, '0')}`;
}

/** Interface preferences kept by the page (layout, theme), carried along as plain strings. */
const InterfacePrefs = z
  .record(z.string(), z.string())
  .describe('Preferences the page keeps itself, such as the theme and panel widths.');

const Manifest = z.object({
  format: z.literal(FORMAT),
  version: z.number().int(),
  savedAt: z.string(),
  appVersion: z.string(),
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
  records: z.number().int(),
  files: z.array(z.object({ key: z.string(), mediaType: z.string(), sizeBytes: z.number() })),
  interface: InterfacePrefs.optional(),
});
type Manifest = z.infer<typeof Manifest>;

const StoreFile = z.array(z.object({ key: z.string(), value: z.json() }));

export const BackupPending = z.object({
  parts: z.array(z.string()),
  fileName: z.string(),
  sizeBytes: z.number(),
  savedAt: z.string(),
  projects: z.number(),
  records: z.number(),
  files: z.number(),
});
export type BackupPending = z.infer<typeof BackupPending>;

export const BackupProgress = z.object({
  action: z.enum(['save', 'load']),
  phase: z
    .string()
    .describe('What is happening, for people: "Packing files", "Checking the file".'),
  doneBytes: z.number(),
  totalBytes: z.number(),
});
export type BackupProgress = z.infer<typeof BackupProgress>;

export const BackupSaved = z.object({
  savedAt: z.string(),
  fileName: z.string(),
  sizeBytes: z.number(),
});

export const BackupRestored = z.object({
  restoredAt: z.string(),
  savedAt: z.string().describe('When the backup that was loaded had been saved.'),
  projects: z.number(),
  interface: InterfacePrefs.optional(),
});
export type BackupRestored = z.infer<typeof BackupRestored>;

/** Store records that never go into a backup, and are left alone by a load. */
function keptOut(key: string): boolean {
  return key.startsWith(BACKUP_PREFIX);
}

/** Files that never go into a backup: exports waiting to be saved, and picked files on their way in. */
function fileKeptOut(key: string): boolean {
  return key.startsWith(EXPORT_PREFIX) || key.startsWith(UPLOAD_PREFIX);
}

function backupFileName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `imp-backup-${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
}

/** Collects a stream into stored parts of a fixed size. */
class PartSink {
  readonly keys: string[] = [];
  #buffer = new Uint8Array(BACKUP_PART_BYTES);
  #filled = 0;

  constructor(
    private readonly blobs: BlobStore,
    private readonly base: string,
  ) {}

  readonly write = async (bytes: Uint8Array): Promise<void> => {
    let offset = 0;
    while (offset < bytes.length) {
      const count = Math.min(bytes.length - offset, BACKUP_PART_BYTES - this.#filled);
      this.#buffer.set(bytes.subarray(offset, offset + count), this.#filled);
      this.#filled += count;
      offset += count;
      if (this.#filled === BACKUP_PART_BYTES) await this.#flush();
    }
  };

  async #flush(): Promise<void> {
    if (this.#filled === 0) return;
    const key = partKey(this.base, this.keys.length);
    await this.blobs.put(key, {
      bytes: this.#buffer.subarray(0, this.#filled),
      mediaType: 'application/zip',
    });
    this.keys.push(key);
    this.#buffer = new Uint8Array(BACKUP_PART_BYTES);
    this.#filled = 0;
  }

  async finish(): Promise<string[]> {
    await this.#flush();
    return this.keys;
  }
}

/**
 * A file stored in parts, read by ranges. Every part but the last has the
 * size of the first, which is how both the interface and Save all store them.
 */
async function partsSource(blobs: BlobStore, keys: readonly string[]): Promise<ArchiveSource> {
  if (keys.length === 0) throw new ArchiveError('The file is empty.');
  const cache = new Map<number, Uint8Array>();
  const part = async (index: number): Promise<Uint8Array> => {
    const held = cache.get(index);
    if (held !== undefined) return held;
    const key = keys[index];
    const blob = key === undefined ? undefined : await blobs.get(key);
    if (blob === undefined) throw new ArchiveError('Part of the file is missing.');
    // A few parts at most: reading goes forward, with a look back to the table of contents.
    if (cache.size >= 3) cache.delete(cache.keys().next().value ?? -1);
    cache.set(index, blob.bytes);
    return blob.bytes;
  };
  const first = await part(0);
  const partSize = first.length;
  const last = await part(keys.length - 1);
  if (keys.length > 1 && partSize === 0) throw new ArchiveError('The file is damaged.');
  const size = (keys.length - 1) * partSize + last.length;
  return {
    size,
    read: async (offset, length) => {
      const end = Math.min(size, offset + length);
      if (end <= offset) return new Uint8Array(0);
      const firstIndex = Math.floor(offset / partSize);
      const lastIndex = Math.floor((end - 1) / partSize);
      if (firstIndex === lastIndex) {
        const bytes = await part(firstIndex);
        const start = offset - firstIndex * partSize;
        return bytes.subarray(start, start + (end - offset));
      }
      const out = new Uint8Array(end - offset);
      for (let index = firstIndex; index <= lastIndex; index += 1) {
        const bytes = await part(index);
        const partStart = index * partSize;
        const from = Math.max(offset, partStart) - partStart;
        const to = Math.min(end, partStart + bytes.length) - partStart;
        out.set(bytes.subarray(from, to), partStart + from - offset);
      }
      return out;
    },
  };
}

/** Writes progress for the interface at most twice a second. */
function progressReporter(runtime: CoreRuntime, action: BackupProgress['action']) {
  let last = 0;
  return {
    report: async (phase: string, doneBytes: number, totalBytes: number, force = false) => {
      const now = runtime.now().getTime();
      if (!force && now - last < 500) return;
      last = now;
      const value: BackupProgress = { action, phase, doneBytes, totalBytes };
      await runtime.store.batch([{ type: 'put', key: BACKUP_PROGRESS_KEY, value }]);
    },
    clear: () => runtime.store.batch([{ type: 'delete', key: BACKUP_PROGRESS_KEY }]),
  };
}

async function removePending(store: KeyValueStore, blobs: BlobStore): Promise<void> {
  const parts = await blobs.list(`${BACKUP_EXPORT_BASE}/`);
  for (const key of parts) await blobs.delete(key);
  await store.batch([{ type: 'delete', key: BACKUP_PENDING_KEY }]);
}

/** Where a picked file is: one stored file, or parts under the key. */
async function pickedParts(blobs: BlobStore, fileKey: string): Promise<string[]> {
  const parts = await blobs.list(`${fileKey}/part-`);
  if (parts.length > 0) return [...parts];
  return (await blobs.get(fileKey)) === undefined ? [] : [fileKey];
}

export interface BackupOptions {
  /** This build's version, written into each backup. */
  readonly appVersion: string;
  /**
   * Called after a load has replaced everything, to put what was loaded in
   * order as a restart would: an agent that was running when the backup was
   * saved is not running now.
   */
  readonly afterLoad?: (store: KeyValueStore) => Promise<void>;
}

export function createBackupCommands(options: BackupOptions): readonly Command[] {
  const status = defineCommand({
    id: 'backup.status',
    title: 'Backup status',
    description:
      'Says when everything was last saved with backup.save, whether a saved file is still waiting for the person to keep it, what is being saved or loaded right now, and when a backup was last loaded.',
    effect: 'read',
    input: z.object({}),
    output: z.object({
      lastSaved: BackupSaved.nullable(),
      pending: BackupPending.nullable(),
      progress: BackupProgress.nullable(),
      lastLoaded: BackupRestored.nullable(),
    }),
    handler: async ({ runtime }) => {
      const read = async <T extends z.ZodType>(key: string, schema: T) => {
        const parsed = schema.safeParse(await runtime.store.get(key));
        return parsed.success ? parsed.data : null;
      };
      return {
        lastSaved: await read(BACKUP_LAST_SAVED_KEY, BackupSaved),
        pending: await read(BACKUP_PENDING_KEY, BackupPending),
        progress: await read(BACKUP_PROGRESS_KEY, BackupProgress),
        lastLoaded: await read(BACKUP_RESTORED_KEY, BackupRestored),
      };
    },
  });

  const save = defineCommand({
    id: 'backup.save',
    title: 'Save all',
    description:
      'Saves everything in Imp into one .zip file: all projects with their media and films, the library, saved crews, model mixes, custom roles, conversations, settings and help choices. The OpenRouter key is never included. The app then offers the person to keep the file on their computer (it waits until they do, or until backup.discard); backup.load reads such a file back. Large workspaces take a while.',
    effect: 'write',
    input: z.object({
      interface: InterfacePrefs.optional(),
    }),
    output: BackupPending,
    handler: async ({ runtime }, input) => {
      const progress = progressReporter(runtime, 'save');
      const now = runtime.now();
      await removePending(runtime.store, runtime.blobs);
      const sink = new PartSink(runtime.blobs, BACKUP_EXPORT_BASE);
      try {
        const records = (await runtime.store.list('')).filter((entry) => !keptOut(entry.key));
        const fileKeys = (await runtime.blobs.list('')).filter((key) => !fileKeptOut(key));
        const projects = (await listProjects(runtime.store)).map(({ id, name }) => ({ id, name }));
        const writer = new ArchiveStreamWriter(sink.write, now);
        const storeBytes = encodeUtf8(JSON.stringify(records));
        // The manifest goes last: it lists every file with its size, known only once read.
        await writer.add(STORE_FILE, storeBytes);
        const files: Manifest['files'] = [];
        let done = 0;
        await progress.report('Packing files', 0, fileKeys.length, true);
        for (const key of fileKeys) {
          const blob = await runtime.blobs.get(key);
          done += 1;
          if (blob === undefined) continue;
          await writer.add(`${FILES}${key}`, blob.bytes);
          files.push({ key, mediaType: blob.mediaType, sizeBytes: blob.bytes.length });
          await progress.report('Packing files', done, fileKeys.length);
        }
        const manifest: Manifest = {
          format: FORMAT,
          version: VERSION,
          savedAt: now.toISOString(),
          appVersion: options.appVersion,
          projects,
          records: records.length,
          files,
          ...(input.interface === undefined ? {} : { interface: input.interface }),
        };
        await writer.add(MANIFEST, encodeUtf8(JSON.stringify(manifest, null, 1)));
        const sizeBytes = await writer.finish();
        const parts = await sink.finish();
        const pending: BackupPending = {
          parts,
          fileName: backupFileName(now),
          sizeBytes,
          savedAt: now.toISOString(),
          projects: projects.length,
          records: records.length,
          files: files.length,
        };
        await runtime.store.batch([
          { type: 'put', key: BACKUP_PENDING_KEY, value: pending },
          {
            type: 'put',
            key: BACKUP_LAST_SAVED_KEY,
            value: { savedAt: pending.savedAt, fileName: pending.fileName, sizeBytes },
          },
        ]);
        return pending;
      } catch (error) {
        for (const key of sink.keys) await runtime.blobs.delete(key);
        if (error instanceof ArchiveError) {
          throw new CommandError('invalid_input', 'backup.save', error.message);
        }
        throw error;
      } finally {
        await progress.clear();
      }
    },
  });

  const discard = defineCommand({
    id: 'backup.discard',
    title: 'Discard saved backup file',
    description:
      'Removes a file made by backup.save that is still waiting to be kept, for example once the person has kept it or does not want it. Nothing else changes.',
    effect: 'write',
    input: z.object({}),
    output: z.object({ discarded: z.boolean() }),
    handler: async ({ runtime }) => {
      const had = (await runtime.store.get(BACKUP_PENDING_KEY)) !== undefined;
      await removePending(runtime.store, runtime.blobs);
      return { discarded: had };
    },
  });

  const load = defineCommand({
    id: 'backup.load',
    title: 'Load all',
    description:
      'Replaces everything in Imp with what a file from backup.save holds: projects, library, crews, model mixes, roles, conversations, settings. What is in Imp now and not in the file is gone afterwards, so suggest backup.save first. The OpenRouter key stays as it is. The fileKey is where the app put the file the person picked. The whole file is checked before anything changes; a damaged file changes nothing.',
    effect: 'destructive',
    input: z.object({
      fileKey: z
        .string()
        .refine((key) => key.startsWith(UPLOAD_PREFIX) || key.startsWith(EXPORT_PREFIX), {
          message: 'Only a picked or saved file can be loaded.',
        })
        .describe('Where the file is: under "uploads/" for one the person picked.'),
    }),
    output: z.object({
      savedAt: z.string(),
      appVersion: z.string(),
      projects: z.number(),
      records: z.number(),
      files: z.number(),
      interface: InterfacePrefs.optional(),
    }),
    handler: async ({ runtime }, input) => {
      const fail = (message: string): never => {
        throw new CommandError('invalid_input', 'backup.load', message);
      };
      const progress = progressReporter(runtime, 'load');
      const picked = await pickedParts(runtime.blobs, input.fileKey);
      const written: string[] = [];
      let switched = false;
      try {
        if (picked.length === 0) return fail(`No file is stored under "${input.fileKey}".`);
        let source: ArchiveSource;
        let directory: ArchiveDirectoryEntry[];
        try {
          source = await partsSource(runtime.blobs, picked);
          directory = await readArchiveDirectory(source);
        } catch (error) {
          return fail(error instanceof ArchiveError ? error.message : 'The file cannot be read.');
        }
        const byPath = new Map(directory.map((entry) => [entry.path, entry]));
        const readJson = async (path: string): Promise<unknown> => {
          const entry = byPath.get(path);
          if (entry === undefined) {
            return fail(
              byPath.has('project.json')
                ? 'This is a single project file. Bring it in with Import on the Projects screen.'
                : 'This is not a file from Save all.',
            );
          }
          try {
            return JSON.parse(decodeUtf8(await readArchiveFile(source, entry))) as unknown;
          } catch (error) {
            return fail(
              error instanceof ArchiveError ? error.message : `The file is damaged at "${path}".`,
            );
          }
        };
        const parsed = Manifest.safeParse(await readJson(MANIFEST));
        if (!parsed.success) {
          return fail(
            byPath.has('project.json')
              ? 'This is a single project file. Bring it in with Import on the Projects screen.'
              : 'This is not a file from Save all, or it is damaged.',
          );
        }
        const manifest = parsed.data;
        if (manifest.version > VERSION) {
          return fail('This file was saved by a newer Imp. Update Imp to load it.');
        }
        const storeParsed = StoreFile.safeParse(await readJson(STORE_FILE));
        if (!storeParsed.success) return fail('The file is damaged: its records cannot be read.');
        const records = storeParsed.data.filter((entry) => !keptOut(entry.key));
        const checkKey = (key: string): void => {
          try {
            if (key.split('/').some((s) => s === '.' || s === '..')) throw new TypeError(key);
            assertValidKey(key);
          } catch {
            fail(`The file holds a bad key: "${key}".`);
          }
        };
        for (const entry of records) checkKey(entry.key);
        const files = manifest.files.filter((file) => !fileKeptOut(file.key));
        const fileEntries = files.map((file) => {
          checkKey(file.key);
          const entry = byPath.get(`${FILES}${file.key}`);
          if (entry === undefined) return fail(`"${file.key}" is missing from the file.`);
          return { file, entry };
        });

        // First every file is read and checked, so a damaged backup changes nothing.
        const totalBytes = fileEntries.reduce((sum, { entry }) => sum + entry.size, 0);
        let doneBytes = 0;
        await progress.report('Checking the file', 0, totalBytes, true);
        for (const { entry } of fileEntries) {
          try {
            await readArchiveFile(source, entry);
          } catch (error) {
            return fail(error instanceof ArchiveError ? error.message : 'The file is damaged.');
          }
          doneBytes += entry.size;
          await progress.report('Checking the file', doneBytes, totalBytes);
        }

        // Then the files are written beside what is there, the records switched in one step,
        // and only then what the backup does not have is removed. A failure before the switch
        // leaves everything as it was.
        const before = new Set(await runtime.blobs.list(''));
        doneBytes = 0;
        await progress.report('Restoring files', 0, totalBytes, true);
        for (const { file, entry } of fileEntries) {
          const bytes = (await readArchiveFile(source, entry)).slice();
          if (!before.has(file.key)) written.push(file.key);
          await runtime.blobs.put(file.key, { bytes, mediaType: file.mediaType });
          doneBytes += entry.size;
          await progress.report('Restoring files', doneBytes, totalBytes);
        }
        await progress.report('Restoring records', totalBytes, totalBytes, true);
        const restored = {
          restoredAt: runtime.now().toISOString(),
          savedAt: manifest.savedAt,
          projects: manifest.projects.length,
          ...(manifest.interface === undefined ? {} : { interface: manifest.interface }),
        } satisfies BackupRestored;
        const current = await runtime.store.list('');
        const operations: WriteOperation[] = [
          ...current
            .filter((entry) => !keptOut(entry.key))
            .map((entry) => ({ type: 'delete' as const, key: entry.key })),
          ...records.map((entry) => ({
            type: 'put' as const,
            key: entry.key,
            value: entry.value,
          })),
          { type: 'put', key: BACKUP_RESTORED_KEY, value: restored },
        ];
        await runtime.store.batch(operations);
        switched = true;
        const keep = new Set(files.map((file) => file.key));
        for (const key of before) {
          if (!keep.has(key) && !fileKeptOut(key)) await runtime.blobs.delete(key);
        }
        await removePending(runtime.store, runtime.blobs);
        await options.afterLoad?.(runtime.store);
        return {
          savedAt: manifest.savedAt,
          appVersion: manifest.appVersion,
          projects: manifest.projects.length,
          records: records.length,
          files: files.length,
          ...(manifest.interface === undefined ? {} : { interface: manifest.interface }),
        };
      } catch (error) {
        if (!switched) {
          for (const key of written) await runtime.blobs.delete(key).catch(() => undefined);
        }
        throw error;
      } finally {
        await progress.clear();
        if (input.fileKey.startsWith(UPLOAD_PREFIX)) {
          for (const key of picked) await runtime.blobs.delete(key);
        }
      }
    },
  });

  return [status, save, discard, load];
}
