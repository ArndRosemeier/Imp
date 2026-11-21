/**
 * Reads the sound track out of an MP4 or MOV file (what video models return)
 * without decoding it: the codec setup and the coded frames, in order. A host
 * then decodes the frames with what it has, WebCodecs in the browser or
 * ffmpeg on the local server, since no permissively licensed AAC decoder
 * exists in WebAssembly.
 */

/** The coded sound of a clip, ready for a decoder. */
export interface Mp4AudioTrack {
  /** The WebCodecs codec string, for example "mp4a.40.2" for AAC-LC. */
  readonly codec: string;
  readonly sampleRate: number;
  readonly channels: number;
  /** The decoder setup (the AudioSpecificConfig for AAC). */
  readonly description: Uint8Array;
  /** Coded frames, in decoding order. Views into the file, not copies. */
  readonly frames: readonly Uint8Array[];
  /** The track's clock: ticks per second. */
  readonly timescale: number;
  /** Encoder priming to drop from the start of the decoded sound, in seconds. */
  readonly skipSeconds: number;
  /** Silence the clip plays before its sound starts, in seconds. */
  readonly delaySeconds: number;
  /** How long the clip says its sound lasts, in seconds, when it says. */
  readonly durationSeconds: number | undefined;
}

/** Why a file has no readable sound track. */
export class Mp4Error extends Error {
  constructor(
    readonly reason: 'malformed' | 'no-sound' | 'unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'Mp4Error';
  }
}

interface Box {
  readonly type: string;
  /** Where the box's content starts, after its header. */
  readonly start: number;
  readonly end: number;
}

class Reader {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  need(at: number, size: number): void {
    if (at < 0 || at + size > this.bytes.length) {
      throw new Mp4Error('malformed', 'The clip file is cut short or damaged.');
    }
  }

  u8(at: number): number {
    this.need(at, 1);
    return this.view.getUint8(at);
  }

  u16(at: number): number {
    this.need(at, 2);
    return this.view.getUint16(at);
  }

  u32(at: number): number {
    this.need(at, 4);
    return this.view.getUint32(at);
  }

  i32(at: number): number {
    this.need(at, 4);
    return this.view.getInt32(at);
  }

  u64(at: number): number {
    this.need(at, 8);
    return Number(this.view.getBigUint64(at));
  }

  i64(at: number): number {
    this.need(at, 8);
    return Number(this.view.getBigInt64(at));
  }

  type(at: number): string {
    this.need(at, 4);
    return String.fromCharCode(...this.bytes.subarray(at, at + 4));
  }

  /** The boxes laid one after another between two offsets. */
  boxes(start: number, end: number): Box[] {
    const found: Box[] = [];
    let at = start;
    while (at + 8 <= end) {
      let size = this.u32(at);
      const type = this.type(at + 4);
      let header = 8;
      if (size === 1) {
        size = this.u64(at + 8);
        header = 16;
      } else if (size === 0) {
        size = end - at;
      }
      if (size < header || at + size > end) {
        throw new Mp4Error('malformed', `The clip file has a damaged "${type}" box.`);
      }
      found.push({ type, start: at + header, end: at + size });
      at += size;
    }
    return found;
  }

  child(parent: Box, type: string): Box | undefined {
    return this.boxes(parent.start, parent.end).find((box) => box.type === type);
  }

  path(parent: Box, ...types: string[]): Box | undefined {
    let box: Box | undefined = parent;
    for (const type of types) {
      if (box === undefined) return undefined;
      box = this.child(box, type);
    }
    return box;
  }
}

function require<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Mp4Error('malformed', `The clip's sound track has no ${what}.`);
  }
  return value;
}

/** An MPEG-4 descriptor's tag, size and where its content starts. */
function descriptor(reader: Reader, at: number): { tag: number; start: number; end: number } {
  const tag = reader.u8(at);
  let size = 0;
  let cursor = at + 1;
  for (let i = 0; i < 4; i++) {
    const byte = reader.u8(cursor++);
    size = (size << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
  }
  return { tag, start: cursor, end: cursor + size };
}

/** The AudioSpecificConfig and object type from an "esds" box. */
function readEsds(reader: Reader, esds: Box): { objectType: number; config: Uint8Array } {
  const es = descriptor(reader, esds.start + 4);
  if (es.tag !== 0x03) throw new Mp4Error('malformed', 'The clip has a damaged sound setup.');
  const flags = reader.u8(es.start + 2);
  let at = es.start + 3;
  if ((flags & 0x80) !== 0) at += 2;
  if ((flags & 0x40) !== 0) at += 1 + reader.u8(at);
  if ((flags & 0x20) !== 0) at += 2;
  const config = descriptor(reader, at);
  if (config.tag !== 0x04) throw new Mp4Error('malformed', 'The clip has a damaged sound setup.');
  const objectType = reader.u8(config.start);
  const specific = descriptor(reader, config.start + 13);
  if (specific.tag !== 0x05 || specific.end > config.end) {
    return { objectType, config: new Uint8Array(0) };
  }
  reader.need(specific.start, specific.end - specific.start);
  return { objectType, config: reader.bytes.subarray(specific.start, specific.end) };
}

/** The AAC audio object type in a config: 2 is AAC-LC, 5 HE-AAC, 29 HE-AAC v2. */
function audioObjectType(config: Uint8Array): number {
  const first = config[0] ?? 0;
  const type = first >> 3;
  if (type !== 31) return type;
  return 32 + (((first & 0x07) << 3) | ((config[1] ?? 0) >> 5));
}

function soundTrack(reader: Reader, moov: Box): Box {
  for (const trak of reader.boxes(moov.start, moov.end)) {
    if (trak.type !== 'trak') continue;
    const hdlr = reader.path(trak, 'mdia', 'hdlr');
    if (hdlr !== undefined && reader.type(hdlr.start + 8) === 'soun') return trak;
  }
  throw new Mp4Error('no-sound', 'This clip has no sound track.');
}

function readMdhd(reader: Reader, mdhd: Box): { timescale: number; duration: number } {
  const version = reader.u8(mdhd.start);
  return version === 1
    ? { timescale: reader.u32(mdhd.start + 20), duration: reader.u64(mdhd.start + 24) }
    : { timescale: reader.u32(mdhd.start + 12), duration: reader.u32(mdhd.start + 16) };
}

function movieTimescale(reader: Reader, moov: Box): number {
  const mvhd = require(reader.child(moov, 'mvhd'), 'movie header');
  const version = reader.u8(mvhd.start);
  return reader.u32(mvhd.start + (version === 1 ? 20 : 12));
}

/** Leading silence (in movie ticks) and priming to skip (in track ticks), from the edit list. */
function readEdits(reader: Reader, trak: Box): { delay: number; skip: number } {
  const elst = reader.path(trak, 'edts', 'elst');
  if (elst === undefined) return { delay: 0, skip: 0 };
  const version = reader.u8(elst.start);
  const count = reader.u32(elst.start + 4);
  const size = version === 1 ? 20 : 12;
  let delay = 0;
  for (let i = 0; i < count; i++) {
    const at = elst.start + 8 + i * size;
    const duration = version === 1 ? reader.u64(at) : reader.u32(at);
    const mediaTime = version === 1 ? reader.i64(at + 8) : reader.i32(at + 4);
    // An empty edit is a pause before the track; the first real edit says where it starts.
    if (mediaTime === -1) delay += duration;
    else return { delay, skip: mediaTime };
  }
  return { delay, skip: 0 };
}

function sampleSizes(reader: Reader, stbl: Box): number[] {
  const stsz = require(reader.child(stbl, 'stsz'), 'frame sizes');
  const fixed = reader.u32(stsz.start + 4);
  const count = reader.u32(stsz.start + 8);
  reader.need(stsz.start + 12, fixed === 0 ? count * 4 : 0);
  const sizes = new Array<number>(count);
  for (let i = 0; i < count; i++)
    sizes[i] = fixed === 0 ? reader.u32(stsz.start + 12 + i * 4) : fixed;
  return sizes;
}

function chunkOffsets(reader: Reader, stbl: Box): number[] {
  const stco = reader.child(stbl, 'stco');
  const co64 = reader.child(stbl, 'co64');
  const box = require(stco ?? co64, 'frame positions');
  const count = reader.u32(box.start + 4);
  const wide = stco === undefined;
  reader.need(box.start + 8, count * (wide ? 8 : 4));
  const offsets = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    offsets[i] = wide ? reader.u64(box.start + 8 + i * 8) : reader.u32(box.start + 8 + i * 4);
  }
  return offsets;
}

/** Cuts the coded frames out of the file, chunk by chunk. */
function frames(reader: Reader, stbl: Box): Uint8Array[] {
  const sizes = sampleSizes(reader, stbl);
  const offsets = chunkOffsets(reader, stbl);
  const stsc = require(reader.child(stbl, 'stsc'), 'chunk table');
  const runs = reader.u32(stsc.start + 4);
  const result: Uint8Array[] = [];
  let sample = 0;
  for (let run = 0; run < runs; run++) {
    const at = stsc.start + 8 + run * 12;
    const firstChunk = reader.u32(at) - 1;
    const perChunk = reader.u32(at + 4);
    const nextFirst = run + 1 < runs ? reader.u32(at + 12) - 1 : offsets.length;
    for (let chunk = firstChunk; chunk < nextFirst && chunk < offsets.length; chunk++) {
      let offset = offsets[chunk] ?? 0;
      for (let i = 0; i < perChunk && sample < sizes.length; i++) {
        const size = sizes[sample++] ?? 0;
        reader.need(offset, size);
        result.push(reader.bytes.subarray(offset, offset + size));
        offset += size;
      }
    }
  }
  return result;
}

/** Finds and reads the first sound track of an MP4 or MOV file. */
export function readMp4Audio(bytes: Uint8Array): Mp4AudioTrack {
  const reader = new Reader(bytes);
  const top = reader.boxes(0, bytes.length);
  const moov = top.find((box) => box.type === 'moov');
  if (moov === undefined) {
    throw top.some((box) => box.type === 'moof')
      ? new Mp4Error('unsupported', 'Fragmented clips are not read yet.')
      : new Mp4Error('malformed', 'The clip file has no index ("moov").');
  }
  const trak = soundTrack(reader, moov);
  const mdia = require(reader.child(trak, 'mdia'), 'media box');
  const { timescale, duration } = readMdhd(reader, require(reader.child(mdia, 'mdhd'), 'clock'));
  const stbl = require(reader.path(mdia, 'minf', 'stbl'), 'frame table');
  const stsd = require(reader.child(stbl, 'stsd'), 'format');
  const entry = require(reader.boxes(stsd.start + 8, stsd.end)[0], 'format');
  if (entry.type !== 'mp4a') {
    throw new Mp4Error(
      'unsupported',
      `The clip's sound is in a format Imp cannot read ("${entry.type}").`,
    );
  }
  // The sound sample entry: QuickTime versions 1 and 2 add fields before the children.
  const version = reader.u16(entry.start + 8);
  const channels = reader.u16(entry.start + 16);
  const sampleRate = reader.u32(entry.start + 24) >>> 16;
  const childrenAt = entry.start + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
  const children = reader.boxes(childrenAt, entry.end);
  // QuickTime files tuck the decoder setup inside a "wave" box.
  const wave = children.find((box) => box.type === 'wave');
  const esds =
    children.find((box) => box.type === 'esds') ??
    (wave === undefined ? undefined : reader.child(wave, 'esds'));
  const { objectType, config } = readEsds(reader, require(esds, 'decoder setup'));
  if (objectType !== 0x40 || config.length === 0) {
    throw new Mp4Error(
      'unsupported',
      "The clip's sound is not AAC, which is all Imp reads in clips.",
    );
  }
  const edits = readEdits(reader, trak);
  const scale = timescale > 0 ? timescale : sampleRate;
  return {
    codec: `mp4a.40.${String(audioObjectType(config))}`,
    sampleRate,
    channels,
    description: config,
    frames: frames(reader, stbl),
    timescale: scale,
    skipSeconds: edits.skip / scale,
    delaySeconds: edits.delay === 0 ? 0 : edits.delay / movieTimescale(reader, moov),
    durationSeconds: duration > edits.skip ? (duration - edits.skip) / scale : undefined,
  };
}
