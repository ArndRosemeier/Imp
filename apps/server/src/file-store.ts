import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  assertValidKey,
  type BlobStore,
  type JsonValue,
  type KeyValueEntry,
  type KeyValueListener,
  type KeyValueStore,
  type StoredBlob,
  type Unsubscribe,
  type WriteOperation,
} from '@imp/core';

/** A journal is rewritten at start-up once it holds this many more lines than keys. */
const COMPACT_ABOVE = 1000;

/**
 * The key-value store of the local server: one journal file. Every batch is
 * one appended line, so a batch is written whole or, if the process dies
 * mid-write, is a torn last line that the next start ignores. Everything is
 * read into memory at start-up, which the size of this data allows, and the
 * journal is rewritten then when it has grown far beyond what it holds.
 */
export class FileKeyValueStore implements KeyValueStore {
  readonly #path: string;
  readonly #data: Map<string, string>;
  readonly #subscriptions = new Set<{ prefix: string; listener: KeyValueListener }>();
  /** Writes happen one after another, in the order they were asked for. */
  #last: Promise<void> = Promise.resolve();

  private constructor(path: string, data: Map<string, string>) {
    this.#path = path;
    this.#data = data;
  }

  static async open(path: string): Promise<FileKeyValueStore> {
    await mkdir(dirname(path), { recursive: true });
    let text = '';
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    }
    const data = new Map<string, string>();
    const lines = text.split('\n').filter((line) => line !== '');
    for (const line of lines) {
      let operations: WriteOperation[];
      try {
        operations = JSON.parse(line) as WriteOperation[];
      } catch {
        // A torn line can only be the last one: the write that was cut off.
        break;
      }
      for (const operation of operations) {
        if (operation.type === 'put') data.set(operation.key, JSON.stringify(operation.value));
        else data.delete(operation.key);
      }
    }
    if (lines.length > data.size + COMPACT_ABOVE || !text.endsWith('\n')) {
      const compact = [...data].map(
        ([key, value]) => `[{"type":"put","key":${JSON.stringify(key)},"value":${value}}]\n`,
      );
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, compact.join(''));
      await rename(temporary, path);
    }
    return new FileKeyValueStore(path, data);
  }

  get(key: string): Promise<JsonValue | undefined> {
    const text = this.#data.get(key);
    return Promise.resolve(text === undefined ? undefined : (JSON.parse(text) as JsonValue));
  }

  list(prefix: string): Promise<readonly KeyValueEntry[]> {
    const entries: KeyValueEntry[] = [];
    for (const [key, text] of this.#data) {
      if (key.startsWith(prefix)) entries.push({ key, value: JSON.parse(text) as JsonValue });
    }
    entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return Promise.resolve(entries);
  }

  batch(operations: readonly WriteOperation[]): Promise<void> {
    const written = this.#last.then(async () => {
      // Validate and serialise everything first, so a bad operation leaves the store untouched.
      const prepared = operations.map((operation) => {
        assertValidKey(operation.key);
        return operation.type === 'put'
          ? { key: operation.key, text: JSON.stringify(operation.value) }
          : { key: operation.key, text: undefined };
      });
      if (prepared.length === 0) return;
      await appendFile(this.#path, `${JSON.stringify(operations)}\n`);
      for (const { key, text } of prepared) {
        if (text === undefined) this.#data.delete(key);
        else this.#data.set(key, text);
      }
      for (const { prefix, listener } of this.#subscriptions) {
        const changes = operations.filter((operation) => operation.key.startsWith(prefix));
        if (changes.length > 0) listener(changes);
      }
    });
    // A failed write must not block the ones after it.
    this.#last = written.catch(() => undefined);
    return written;
  }

  subscribe(prefix: string, listener: KeyValueListener): Unsubscribe {
    const subscription = { prefix, listener };
    this.#subscriptions.add(subscription);
    return () => {
      this.#subscriptions.delete(subscription);
    };
  }
}

/**
 * The media of the local server: one file per blob in a folder, named by the
 * hash of its key so that no key can leave the folder or collide with
 * another, and a journal that says which keys exist and what they are.
 */
export class FileBlobStore implements BlobStore {
  readonly #folder: string;
  readonly #index: FileKeyValueStore;

  private constructor(folder: string, index: FileKeyValueStore) {
    this.#folder = folder;
    this.#index = index;
  }

  static async open(folder: string): Promise<FileBlobStore> {
    await mkdir(folder, { recursive: true });
    return new FileBlobStore(folder, await FileKeyValueStore.open(join(folder, 'index.jsonl')));
  }

  #file(key: string): string {
    return join(this.#folder, `${createHash('sha256').update(key).digest('hex')}.bin`);
  }

  async get(key: string): Promise<StoredBlob | undefined> {
    const mediaType = await this.#index.get(key);
    if (typeof mediaType !== 'string') return undefined;
    try {
      return { bytes: new Uint8Array(await readFile(this.#file(key))), mediaType };
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async put(key: string, blob: StoredBlob): Promise<void> {
    assertValidKey(key);
    // Written beside and moved into place, so a reader never sees half a file.
    const temporary = `${this.#file(key)}.${randomUUID()}.tmp`;
    await writeFile(temporary, blob.bytes);
    await rename(temporary, this.#file(key));
    await this.#index.batch([{ type: 'put', key, value: blob.mediaType }]);
  }

  async delete(key: string): Promise<void> {
    if ((await this.#index.get(key)) === undefined) return;
    await this.#index.batch([{ type: 'delete', key }]);
    await rm(this.#file(key), { force: true });
  }

  async list(prefix: string): Promise<readonly string[]> {
    return (await this.#index.list(prefix)).map((entry) => entry.key);
  }
}
