/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call --
 * Commands run by id answer with untyped output; these tests read it loosely and assert on it.
 */
import { describe, expect, it } from 'vitest';
import {
  ArchiveStreamWriter,
  BACKUP_PART_BYTES,
  bytesSource,
  CommandRegistry,
  createBackupCommands,
  createProjectCommands,
  partKey,
  projectPrefix,
  readArchiveDirectory,
  readArchiveFile,
  writeArchive,
  type KeyValueStore,
} from '../src/index.js';
import { decodeUtf8, encodeUtf8 } from '../src/archive.js';
import { createTestRuntime } from '../src/testing.js';

const user = { kind: 'user', id: 'arnd' } as const;
const agent = { kind: 'agent', id: 'a', role: 'coordinator' } as const;

function setup(afterLoad?: (store: KeyValueStore) => Promise<void>) {
  const runtime = createTestRuntime();
  const registry = new CommandRegistry({ runtime }).register(
    ...createProjectCommands([]),
    ...createBackupCommands({ appVersion: '0.123', ...(afterLoad ? { afterLoad } : {}) }),
  );
  const run = async (id: string, input: unknown, actor: typeof user | typeof agent = user) => {
    const result = await registry.executeById(id, input, { actor });
    if (result.status !== 'ok') throw new Error(`${id}: ${result.status}`);
    return result.output as any;
  };
  /** The waiting backup, joined into one file, as the interface saves it. */
  const savedFile = async (pending: { parts: string[] }): Promise<Uint8Array> => {
    const parts = await Promise.all(pending.parts.map((key) => runtime.blobs.get(key)));
    const size = parts.reduce((sum, part) => sum + (part?.bytes.length ?? 0), 0);
    const out = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      out.set(part?.bytes ?? new Uint8Array(), at);
      at += part?.bytes.length ?? 0;
    }
    return out;
  };
  /** Puts a file where the interface puts one the person picked, in parts of `partBytes`. */
  const pick = async (file: Uint8Array, partBytes = 4 * 1024 * 1024): Promise<string> => {
    const base = 'uploads/picked-backup';
    for (let index = 0; index * partBytes < Math.max(1, file.length); index += 1) {
      await runtime.blobs.put(partKey(base, index), {
        bytes: file.slice(index * partBytes, (index + 1) * partBytes),
        mediaType: 'application/zip',
      });
    }
    return base;
  };
  return { runtime, run, savedFile, pick };
}

describe('the streamed archive', () => {
  it('writes a ZIP that the in-memory reader and the streamed reader both read back', async () => {
    const chunks: Uint8Array[] = [];
    const writer = new ArchiveStreamWriter((bytes) => {
      chunks.push(bytes.slice());
      return Promise.resolve();
    });
    await writer.add('a.txt', encodeUtf8('hello'));
    await writer.add('dir/ü.bin', new Uint8Array([0, 1, 2, 255]));
    await writer.add('empty', new Uint8Array());
    await expect(writer.add('a.txt', new Uint8Array())).rejects.toThrow(/twice/);
    const size = await writer.finish();
    const file = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      file.set(chunk, at);
      at += chunk.length;
    }
    const directory = await readArchiveDirectory(bytesSource(file));
    expect(directory.map((entry) => entry.path)).toEqual(['a.txt', 'dir/ü.bin', 'empty']);
    const second = directory[1];
    if (second === undefined) throw new Error('missing');
    expect(await readArchiveFile(bytesSource(file), second)).toEqual(
      new Uint8Array([0, 1, 2, 255]),
    );
    // The same bytes as the in-memory writer makes for the same entries.
    const same = writeArchive(
      [
        { path: 'a.txt', bytes: encodeUtf8('hello') },
        { path: 'dir/ü.bin', bytes: new Uint8Array([0, 1, 2, 255]) },
        { path: 'empty', bytes: new Uint8Array() },
      ],
      new Date(0),
    );
    expect((await readArchiveDirectory(bytesSource(same))).length).toBe(3);
  });

  it('switches to ZIP64 records past 65535 entries', async () => {
    const chunks: Uint8Array[] = [];
    const writer = new ArchiveStreamWriter((bytes) => {
      chunks.push(bytes.slice());
      return Promise.resolve();
    });
    const count = 65_600;
    for (let index = 0; index < count; index += 1) {
      await writer.add(`f${String(index)}`, new Uint8Array([index & 255]));
    }
    const size = await writer.finish();
    const file = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      file.set(chunk, at);
      at += chunk.length;
    }
    const view = new DataView(file.buffer);
    // ZIP64 end of directory, its locator, then the classic record with full fields.
    expect(view.getUint32(size - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(size - 22 + 10, true)).toBe(0xffff);
    expect(view.getUint32(size - 42, true)).toBe(0x07064b50);
    const directory = await readArchiveDirectory(bytesSource(file));
    expect(directory.length).toBe(count);
    const last = directory[count - 1];
    if (last === undefined) throw new Error('missing');
    expect(await readArchiveFile(bytesSource(file), last)).toEqual(
      new Uint8Array([(count - 1) & 255]),
    );
  });

  it('notices a damaged entry', async () => {
    const file = writeArchive([{ path: 'x', bytes: encodeUtf8('original') }]);
    file[31] = file[31] === 0 ? 1 : 0; // In the stored bytes after the 30-byte header and name "x".
    const [entry] = await readArchiveDirectory(bytesSource(file));
    if (entry === undefined) throw new Error('missing');
    await expect(readArchiveFile(bytesSource(file), entry)).rejects.toThrow(/damaged/);
  });
});

describe('Save all and Load all', () => {
  it('saves every record and file except exports, uploads and its own records, and loads them back', async () => {
    const { runtime, run, savedFile, pick } = setup();
    const project = await run('project.create', { name: 'Lighthouse', mode: 'movie' });
    await runtime.store.batch([
      { type: 'put', key: 'settings/help.enabled', value: false },
      { type: 'put', key: 'saved-crews/c1', value: { id: 'c1', name: 'Night crew' } },
      { type: 'put', key: 'model-mixes/m1', value: { id: 'm1', name: 'Cheap' } },
      { type: 'put', key: `${projectPrefix(project.id)}scenes/s1`, value: { id: 's1' } },
    ]);
    await runtime.blobs.put(`${projectPrefix(project.id)}clips/c1`, {
      bytes: new Uint8Array([9, 8, 7]),
      mediaType: 'video/mp4',
    });
    await runtime.blobs.put('library/sounds/rain', {
      bytes: new Uint8Array([1]),
      mediaType: 'audio/mpeg',
    });
    await runtime.blobs.put('exports/other', { bytes: new Uint8Array([5]), mediaType: 'x/y' });
    await runtime.blobs.put('uploads/left', { bytes: new Uint8Array([5]), mediaType: 'x/y' });

    const pending = await run('backup.save', { interface: { 'imp.theme': 'light' } });
    expect(pending).toMatchObject({ projects: 1, files: 2, fileName: /^imp-backup-.*\.zip$/ });
    const file = await savedFile(pending);
    const directory = await readArchiveDirectory(bytesSource(file));
    expect(directory.map((entry) => entry.path).sort()).toEqual([
      'files/library/sounds/rain',
      `files/${projectPrefix(project.id)}clips/c1`,
      'imp-backup.json',
      'store.json',
    ]);
    const storeEntry = directory.find((entry) => entry.path === 'store.json');
    if (storeEntry === undefined) throw new Error('missing');
    const saved = JSON.parse(decodeUtf8(await readArchiveFile(bytesSource(file), storeEntry)));
    expect(saved.some((entry: { key: string }) => entry.key.startsWith('backup/'))).toBe(false);
    expect((await run('backup.status', {})).lastSaved).toMatchObject({ sizeBytes: file.length });

    // Things change after the save; loading puts everything back as it was saved.
    await run('project.create', { name: 'Later', mode: 'movie' });
    await runtime.store.batch([{ type: 'put', key: 'settings/help.enabled', value: true }]);
    await runtime.blobs.put('library/sounds/new', {
      bytes: new Uint8Array([2]),
      mediaType: 'audio/mpeg',
    });
    await runtime.blobs.put(`${projectPrefix(project.id)}clips/c1`, {
      bytes: new Uint8Array([0]),
      mediaType: 'video/mp4',
    });

    const fileKey = await pick(file, 1000);
    const loaded = await run('backup.load', { fileKey });
    expect(loaded).toMatchObject({
      appVersion: '0.123',
      projects: 1,
      files: 2,
      interface: { 'imp.theme': 'light' },
    });
    expect((await run('project.list', {})).projects.map((p: any) => p.name)).toEqual([
      'Lighthouse',
    ]);
    expect(await runtime.store.get('settings/help.enabled')).toBe(false);
    expect(await runtime.store.get('saved-crews/c1')).toEqual({ id: 'c1', name: 'Night crew' });
    expect(await runtime.blobs.get('library/sounds/new')).toBeUndefined();
    expect((await runtime.blobs.get(`${projectPrefix(project.id)}clips/c1`))?.bytes).toEqual(
      new Uint8Array([9, 8, 7]),
    );
    // The picked file and the waiting backup are cleaned away; the person's other exports stay.
    expect(await runtime.blobs.list('uploads/picked-backup')).toEqual([]);
    expect(await runtime.blobs.list('exports/backup/')).toEqual([]);
    expect(await runtime.blobs.get('exports/other')).toBeDefined();
    const status = await run('backup.status', {});
    expect(status.pending).toBeNull();
    expect(status.lastLoaded).toMatchObject({ projects: 1, savedAt: pending.savedAt });
    expect(await runtime.store.get('backup/restored')).toMatchObject({
      interface: { 'imp.theme': 'light' },
    });
  });

  it('stores large backups in parts and reads files across part boundaries', async () => {
    const { runtime, run, savedFile, pick } = setup();
    const big = new Uint8Array(BACKUP_PART_BYTES + 12_345).map((_, i) => (i * 31) & 255);
    await runtime.blobs.put('library/video/big', { bytes: big, mediaType: 'video/mp4' });
    const pending = await run('backup.save', {});
    expect(pending.parts.length).toBe(2);
    const file = await savedFile(pending);
    await runtime.blobs.delete('library/video/big');
    await run('backup.load', { fileKey: await pick(file, 3 * 1024 * 1024 + 7) });
    expect((await runtime.blobs.get('library/video/big'))?.bytes).toEqual(big);
  });

  it('changes nothing when the file is damaged, and says what is wrong', async () => {
    const { runtime, run, savedFile, pick } = setup();
    await runtime.blobs.put('library/a', { bytes: encodeUtf8('aaaa'), mediaType: 'text/plain' });
    await runtime.blobs.put('library/b', { bytes: encodeUtf8('bbbb'), mediaType: 'text/plain' });
    const file = await savedFile(await run('backup.save', {}));
    await runtime.blobs.put('library/a', { bytes: encodeUtf8('now'), mediaType: 'text/plain' });
    await runtime.store.batch([{ type: 'put', key: 'settings/x', value: 1 }]);
    // Damage the second file's bytes.
    const directory = await readArchiveDirectory(bytesSource(file));
    const b = directory.find((entry) => entry.path === 'files/library/b');
    if (b === undefined) throw new Error('missing');
    const damaged = file.slice();
    const at = b.headerOffset + 30 + 'files/library/b'.length;
    damaged[at] = (damaged[at] ?? 0) ^ 0xff;
    await expect(run('backup.load', { fileKey: await pick(damaged) })).rejects.toThrow(
      /library\/b.*damaged/,
    );
    expect(decodeUtf8((await runtime.blobs.get('library/a'))?.bytes ?? new Uint8Array())).toBe(
      'now',
    );
    expect(await runtime.store.get('settings/x')).toBe(1);
    expect(await runtime.blobs.list('uploads/')).toEqual([]);
  });

  it('refuses a project file and anything that is not a backup', async () => {
    const { runtime, run, pick } = setup();
    const project = writeArchive([{ path: 'project.json', bytes: encodeUtf8('{}') }]);
    await expect(run('backup.load', { fileKey: await pick(project) })).rejects.toThrow(
      /single project file/,
    );
    await runtime.blobs.put('uploads/junk', { bytes: encodeUtf8('nope'), mediaType: 'x/y' });
    await expect(run('backup.load', { fileKey: 'uploads/junk' })).rejects.toThrow(/not a ZIP/);
    await expect(run('backup.load', { fileKey: 'settings/x' })).rejects.toThrow(/Invalid input/);
    await expect(run('backup.load', { fileKey: 'uploads/none' })).rejects.toThrow(/No file/);
  });

  it('asks a person before an agent may load, and puts loaded state in order afterwards', async () => {
    const seen: string[] = [];
    const { run, savedFile, pick, runtime } = setup(async (store) => {
      seen.push(JSON.stringify(await store.get('settings/x')));
    });
    await runtime.store.batch([{ type: 'put', key: 'settings/x', value: 'saved' }]);
    const file = await savedFile(await run('backup.save', {}, agent));
    const fileKey = await pick(file);
    await expect(run('backup.load', { fileKey }, agent)).rejects.toThrow(/needs-approval/);
    await run('backup.load', { fileKey });
    expect(seen).toEqual(['"saved"']);
  });

  it('discards a waiting backup', async () => {
    const { run, runtime } = setup();
    await run('backup.save', {});
    expect((await runtime.blobs.list('exports/backup/')).length).toBe(1);
    expect(await run('backup.discard', {})).toEqual({ discarded: true });
    expect(await runtime.blobs.list('exports/backup/')).toEqual([]);
    expect(await run('backup.discard', {})).toEqual({ discarded: false });
  });
});
