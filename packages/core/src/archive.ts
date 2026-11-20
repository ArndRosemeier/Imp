/**
 * A minimal ZIP archive: what Imp needs to write a project to one file and
 * read it back, with nothing to install. Entries are written stored (media
 * is compressed already). Reading takes stored entries only, which is what
 * Imp writes; an archive packed again by another program is refused clearly.
 */

export interface ArchiveEntry {
  /** The path inside the archive, with forward slashes. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
const UTF8_FLAG = 0x0800;
const MAX_SIZE = 0xffffffff;
const MAX_ENTRIES = 0xffff;

/** UTF-8, by hand: the core runs where the platform's text codecs are not typed. */
export function encodeUtf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000)
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
  }
  return Uint8Array.from(bytes);
}

export function decodeUtf8(bytes: Uint8Array): string {
  let text = '';
  let at = 0;
  while (at < bytes.length) {
    const first = bytes[at] ?? 0;
    const length = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
    let code = length === 1 ? first : first & (0xff >> (length + 1));
    for (let k = 1; k < length; k += 1) code = (code << 6) | ((bytes[at + k] ?? 0) & 63);
    text += String.fromCodePoint(code);
    at += length;
  }
  return text;
}

let crcTable: Uint32Array | undefined;

/** The CRC-32 that ZIP uses, over all of `bytes`. */
export function crc32(bytes: Uint8Array): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** The DOS date and time ZIP keeps, for `date` in local time. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export class ArchiveError extends Error {
  override readonly name = 'ArchiveError';
}

/** Packs entries into one ZIP file. Throws when it would need ZIP64, above 4 GiB. */
export function writeArchive(entries: readonly ArchiveEntry[], modified = new Date()): Uint8Array {
  if (entries.length > MAX_ENTRIES) {
    throw new ArchiveError(`An archive holds at most ${String(MAX_ENTRIES)} files.`);
  }
  const stamp = dosDateTime(modified);
  const prepared = entries.map((entry) => ({
    name: encodeUtf8(entry.path),
    bytes: entry.bytes,
    crc: crc32(entry.bytes),
  }));
  const localSize = prepared.reduce((sum, e) => sum + 30 + e.name.length + e.bytes.length, 0);
  const centralSize = prepared.reduce((sum, e) => sum + 46 + e.name.length, 0);
  const total = localSize + centralSize + 22;
  if (total > MAX_SIZE) {
    throw new ArchiveError('The project is larger than 4 GB, which one file cannot hold yet.');
  }
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];
  for (const entry of prepared) {
    offsets.push(at);
    view.setUint32(at, LOCAL_HEADER, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, UTF8_FLAG, true);
    view.setUint16(at + 8, 0, true);
    view.setUint16(at + 10, stamp.time, true);
    view.setUint16(at + 12, stamp.date, true);
    view.setUint32(at + 14, entry.crc, true);
    view.setUint32(at + 18, entry.bytes.length, true);
    view.setUint32(at + 22, entry.bytes.length, true);
    view.setUint16(at + 26, entry.name.length, true);
    view.setUint16(at + 28, 0, true);
    out.set(entry.name, at + 30);
    out.set(entry.bytes, at + 30 + entry.name.length);
    at += 30 + entry.name.length + entry.bytes.length;
  }
  const centralStart = at;
  prepared.forEach((entry, index) => {
    view.setUint32(at, CENTRAL_HEADER, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 8, UTF8_FLAG, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, stamp.time, true);
    view.setUint16(at + 14, stamp.date, true);
    view.setUint32(at + 16, entry.crc, true);
    view.setUint32(at + 20, entry.bytes.length, true);
    view.setUint32(at + 24, entry.bytes.length, true);
    view.setUint16(at + 28, entry.name.length, true);
    // Extra field, comment, disk, internal and external attributes stay zero.
    view.setUint32(at + 42, offsets[index] ?? 0, true);
    out.set(entry.name, at + 46);
    at += 46 + entry.name.length;
  });
  view.setUint32(at, END_OF_DIRECTORY, true);
  view.setUint16(at + 8, prepared.length, true);
  view.setUint16(at + 10, prepared.length, true);
  view.setUint32(at + 12, at - centralStart, true);
  view.setUint32(at + 16, centralStart, true);
  return out;
}

/** Unpacks a ZIP file. Fails on anything damaged rather than returning part of it. */
export function readArchive(file: Uint8Array): ArchiveEntry[] {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let end = -1;
  for (let at = file.length - 22; at >= Math.max(0, file.length - 22 - 0xffff); at -= 1) {
    if (view.getUint32(at, true) === END_OF_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new ArchiveError('This is not a ZIP file.');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries: ArchiveEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > file.length || view.getUint32(at, true) !== CENTRAL_HEADER) {
      throw new ArchiveError('The archive is damaged: its table of contents is broken.');
    }
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const path = decodeUtf8(file.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (offset + 30 > file.length || view.getUint32(offset, true) !== LOCAL_HEADER) {
      throw new ArchiveError(`The archive is damaged at "${path}".`);
    }
    const start =
      offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    if (start + packedSize > file.length) {
      throw new ArchiveError(`The archive is cut short at "${path}".`);
    }
    if (path.endsWith('/')) continue;
    const packed = file.subarray(start, start + packedSize);
    if (method !== 0) {
      throw new ArchiveError(
        'This archive was packed again by another program. Import the file exactly as Imp exported it.',
      );
    }
    const bytes = packed.slice();
    if (crc32(bytes) !== crc) throw new ArchiveError(`"${path}" in the archive is damaged.`);
    entries.push({ path, bytes });
  }
  return entries;
}
