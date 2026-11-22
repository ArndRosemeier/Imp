import { ArchiveError, crc32, decodeUtf8, encodeUtf8 } from './archive.js';

/**
 * A ZIP archive written and read piece by piece, for files too large to hold
 * in memory at once, such as everything Imp keeps. Entries are stored, not
 * compressed (media is compressed already). ZIP64 records are written only
 * where a size, an offset or the number of entries needs them, so a small
 * archive is a plain ZIP any program opens, and a large one is one that
 * current programs (Windows Explorer, macOS Archive Utility, 7-Zip, unzip) open.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
const ZIP64_END = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA = 0x0001;
const UTF8_FLAG = 0x0800;
const MAX_32 = 0xffffffff;
const MAX_16 = 0xffff;

function setUint64(view: DataView, at: number, value: number): void {
  view.setUint32(at, value % 0x1_0000_0000, true);
  view.setUint32(at + 4, Math.floor(value / 0x1_0000_0000), true);
}

function getUint64(view: DataView, at: number): number {
  return view.getUint32(at, true) + view.getUint32(at + 4, true) * 0x1_0000_0000;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Where a streamed archive goes: each call hands over the next bytes of the file, in order. */
export type ArchiveSink = (bytes: Uint8Array) => Promise<void>;

interface Written {
  readonly name: Uint8Array;
  readonly crc: number;
  readonly size: number;
  readonly offset: number;
}

/** Writes a ZIP file entry by entry; nothing but the table of contents is kept in memory. */
export class ArchiveStreamWriter {
  readonly #sink: ArchiveSink;
  readonly #stamp: { time: number; date: number };
  readonly #written: Written[] = [];
  readonly #paths = new Set<string>();
  readonly #limit: number;
  #at = 0;
  #finished = false;

  /**
   * `zip64From` is the size, offset or count from which ZIP64 records are
   * written: where ZIP requires them unless given. Tests pass 0 to write them
   * for every entry, as they are for files of more than 4 GB.
   */
  constructor(sink: ArchiveSink, modified = new Date(), zip64From = MAX_32) {
    this.#sink = sink;
    this.#stamp = dosDateTime(modified);
    this.#limit = zip64From;
  }

  /** Bytes handed to the sink so far. */
  get size(): number {
    return this.#at;
  }

  async #emit(bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return;
    await this.#sink(bytes);
    this.#at += bytes.length;
  }

  async add(path: string, bytes: Uint8Array): Promise<void> {
    if (this.#finished) throw new ArchiveError('The archive is already finished.');
    if (this.#paths.has(path)) throw new ArchiveError(`"${path}" is in the archive twice.`);
    this.#paths.add(path);
    const name = encodeUtf8(path);
    const crc = crc32(bytes);
    const big = bytes.length >= this.#limit;
    const header = new Uint8Array(30 + name.length + (big ? 20 : 0));
    const view = new DataView(header.buffer);
    view.setUint32(0, LOCAL_HEADER, true);
    view.setUint16(4, big ? 45 : 20, true);
    view.setUint16(6, UTF8_FLAG, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, this.#stamp.time, true);
    view.setUint16(12, this.#stamp.date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, big ? MAX_32 : bytes.length, true);
    view.setUint32(22, big ? MAX_32 : bytes.length, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, big ? 20 : 0, true);
    header.set(name, 30);
    if (big) {
      const extra = 30 + name.length;
      view.setUint16(extra, ZIP64_EXTRA, true);
      view.setUint16(extra + 2, 16, true);
      setUint64(view, extra + 4, bytes.length);
      setUint64(view, extra + 12, bytes.length);
    }
    const offset = this.#at;
    await this.#emit(header);
    await this.#emit(bytes);
    this.#written.push({ name, crc, size: bytes.length, offset });
  }

  /** Writes the table of contents. Returns the size of the whole file. */
  async finish(): Promise<number> {
    if (this.#finished) throw new ArchiveError('The archive is already finished.');
    this.#finished = true;
    const parts: Uint8Array[] = [];
    let centralSize = 0;
    for (const entry of this.#written) {
      const bigSize = entry.size >= this.#limit;
      const bigOffset = entry.offset >= this.#limit;
      const extraLength = (bigSize ? 16 : 0) + (bigOffset ? 8 : 0);
      const record = new Uint8Array(
        46 + entry.name.length + (extraLength > 0 ? 4 + extraLength : 0),
      );
      const view = new DataView(record.buffer);
      const zip64 = extraLength > 0;
      view.setUint32(0, CENTRAL_HEADER, true);
      view.setUint16(4, zip64 ? 45 : 20, true);
      view.setUint16(6, zip64 ? 45 : 20, true);
      view.setUint16(8, UTF8_FLAG, true);
      view.setUint16(10, 0, true);
      view.setUint16(12, this.#stamp.time, true);
      view.setUint16(14, this.#stamp.date, true);
      view.setUint32(16, entry.crc, true);
      view.setUint32(20, bigSize ? MAX_32 : entry.size, true);
      view.setUint32(24, bigSize ? MAX_32 : entry.size, true);
      view.setUint16(28, entry.name.length, true);
      view.setUint16(30, zip64 ? 4 + extraLength : 0, true);
      view.setUint32(42, bigOffset ? MAX_32 : entry.offset, true);
      record.set(entry.name, 46);
      if (zip64) {
        let at = 46 + entry.name.length;
        view.setUint16(at, ZIP64_EXTRA, true);
        view.setUint16(at + 2, extraLength, true);
        at += 4;
        if (bigSize) {
          setUint64(view, at, entry.size);
          setUint64(view, at + 8, entry.size);
          at += 16;
        }
        if (bigOffset) setUint64(view, at, entry.offset);
      }
      parts.push(record);
      centralSize += record.length;
    }
    const centralStart = this.#at;
    const count = this.#written.length;
    const zip64End =
      count >= Math.min(MAX_16, this.#limit) ||
      centralStart >= this.#limit ||
      centralSize >= this.#limit;
    if (zip64End) {
      const end = new Uint8Array(56 + 20);
      const view = new DataView(end.buffer);
      view.setUint32(0, ZIP64_END, true);
      setUint64(view, 4, 44);
      view.setUint16(12, 45, true);
      view.setUint16(14, 45, true);
      setUint64(view, 24, count);
      setUint64(view, 32, count);
      setUint64(view, 40, centralSize);
      setUint64(view, 48, centralStart);
      view.setUint32(56, ZIP64_LOCATOR, true);
      setUint64(view, 64, centralStart + centralSize);
      view.setUint32(72, 1, true);
      parts.push(end);
    }
    const end = new Uint8Array(22);
    const view = new DataView(end.buffer);
    view.setUint32(0, END_OF_DIRECTORY, true);
    view.setUint16(8, zip64End ? MAX_16 : count, true);
    view.setUint16(10, zip64End ? MAX_16 : count, true);
    view.setUint32(12, zip64End ? MAX_32 : centralSize, true);
    view.setUint32(16, zip64End ? MAX_32 : centralStart, true);
    parts.push(end);
    // The table of contents goes out in pieces of about a megabyte.
    let pending: Uint8Array[] = [];
    let pendingSize = 0;
    const flush = async (): Promise<void> => {
      if (pendingSize === 0) return;
      const joined = new Uint8Array(pendingSize);
      let at = 0;
      for (const piece of pending) {
        joined.set(piece, at);
        at += piece.length;
      }
      pending = [];
      pendingSize = 0;
      await this.#emit(joined);
    };
    for (const part of parts) {
      pending.push(part);
      pendingSize += part.length;
      if (pendingSize >= 1024 * 1024) await flush();
    }
    await flush();
    return this.#at;
  }
}

/** A file read by ranges: what a large archive is read from, a piece at a time. */
export interface ArchiveSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** One file in an archive, as its table of contents describes it. */
export interface ArchiveDirectoryEntry {
  readonly path: string;
  readonly method: number;
  readonly crc: number;
  readonly size: number;
  readonly packedSize: number;
  readonly headerOffset: number;
}

/** Reads the table of contents of a ZIP file, ZIP64 included. */
export async function readArchiveDirectory(
  source: ArchiveSource,
): Promise<ArchiveDirectoryEntry[]> {
  const tailLength = Math.min(source.size, 22 + MAX_16 + 20);
  if (tailLength < 22) throw new ArchiveError('This is not a ZIP file.');
  const tailStart = source.size - tailLength;
  const tail = await source.read(tailStart, tailLength);
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let end = -1;
  for (let at = tail.length - 22; at >= 0; at -= 1) {
    if (tailView.getUint32(at, true) === END_OF_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new ArchiveError('This is not a ZIP file.');
  let count = tailView.getUint16(end + 10, true);
  let centralSize = tailView.getUint32(end + 12, true);
  let centralStart = tailView.getUint32(end + 16, true);
  if (
    (count === MAX_16 || centralSize === MAX_32 || centralStart === MAX_32) &&
    end >= 20 &&
    tailView.getUint32(end - 20, true) === ZIP64_LOCATOR
  ) {
    const zip64At = getUint64(tailView, end - 20 + 8);
    const record = await source.read(zip64At, 56);
    const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
    if (record.length < 56 || view.getUint32(0, true) !== ZIP64_END) {
      throw new ArchiveError('The archive is damaged: its large-file table is broken.');
    }
    count = getUint64(view, 32);
    centralSize = getUint64(view, 40);
    centralStart = getUint64(view, 48);
  }
  if (centralStart + centralSize > source.size) {
    throw new ArchiveError('The archive is cut short: its table of contents is missing.');
  }
  const central = await source.read(centralStart, centralSize);
  const view = new DataView(central.buffer, central.byteOffset, central.byteLength);
  const entries: ArchiveDirectoryEntry[] = [];
  let at = 0;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > central.length || view.getUint32(at, true) !== CENTRAL_HEADER) {
      throw new ArchiveError('The archive is damaged: its table of contents is broken.');
    }
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    let packedSize = view.getUint32(at + 20, true);
    let size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    let headerOffset = view.getUint32(at + 42, true);
    const path = decodeUtf8(central.subarray(at + 46, at + 46 + nameLength));
    // ZIP64 fields come in a fixed order, each only when its short field is full.
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = view.getUint16(extra, true);
      const length = view.getUint16(extra + 2, true);
      if (id === ZIP64_EXTRA) {
        let field = extra + 4;
        if (size === MAX_32) {
          size = getUint64(view, field);
          field += 8;
        }
        if (packedSize === MAX_32) {
          packedSize = getUint64(view, field);
          field += 8;
        }
        if (headerOffset === MAX_32) headerOffset = getUint64(view, field);
      }
      extra += 4 + length;
    }
    at = extraEnd + commentLength;
    if (!path.endsWith('/')) entries.push({ path, method, crc, size, packedSize, headerOffset });
  }
  return entries;
}

/** Reads one file out of an archive and checks it against its checksum. */
export async function readArchiveFile(
  source: ArchiveSource,
  entry: ArchiveDirectoryEntry,
): Promise<Uint8Array> {
  if (entry.method !== 0) {
    throw new ArchiveError(
      'This archive was packed again by another program. Use the file exactly as Imp saved it.',
    );
  }
  const header = await source.read(entry.headerOffset, 30);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (header.length < 30 || view.getUint32(0, true) !== LOCAL_HEADER) {
    throw new ArchiveError(`The archive is damaged at "${entry.path}".`);
  }
  const start = entry.headerOffset + 30 + view.getUint16(26, true) + view.getUint16(28, true);
  if (start + entry.packedSize > source.size) {
    throw new ArchiveError(`The archive is cut short at "${entry.path}".`);
  }
  const bytes = await source.read(start, entry.packedSize);
  if (crc32(bytes) !== entry.crc)
    throw new ArchiveError(`"${entry.path}" in the archive is damaged.`);
  return bytes;
}

/** An archive held in memory, as a source. */
export function bytesSource(bytes: Uint8Array): ArchiveSource {
  return {
    size: bytes.length,
    read: (offset, length) =>
      Promise.resolve(bytes.subarray(offset, Math.min(bytes.length, offset + length))),
  };
}
