import type { Pcm } from './pcm.js';
import { frameCount } from './pcm.js';

const PCM_FORMAT = 1;
const FLOAT_FORMAT = 3;
const EXTENSIBLE_FORMAT = 0xfffe;

function text(view: DataView, at: number): string {
  return String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3),
  );
}

/** Whether the bytes start like a WAV file. */
export function isWav(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return text(view, 0) === 'RIFF' && text(view, 8) === 'WAVE';
}

function readSample(view: DataView, at: number, format: number, bits: number): number {
  if (format === FLOAT_FORMAT) {
    return bits === 64 ? view.getFloat64(at, true) : view.getFloat32(at, true);
  }
  switch (bits) {
    case 8:
      return (view.getUint8(at) - 128) / 128;
    case 16:
      return view.getInt16(at, true) / 32768;
    case 24: {
      const value = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16);
      return value / 8388608;
    }
    default:
      return view.getInt32(at, true) / 2147483648;
  }
}

/** Reads an uncompressed WAV file: 8, 16, 24 or 32 bit integers, or 32 or 64 bit floats. */
export function decodeWav(bytes: Uint8Array): Pcm {
  if (!isWav(bytes)) throw new Error('Not a WAV file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: { at: number; size: number } | undefined;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = text(view, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // The extensible header names the real format in the first two bytes of its sub-format.
      if (format === EXTENSIBLE_FORMAT && size >= 26) format = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      // Streams written before their length was known say 0 or more than there is.
      data = { at: body, size: Math.min(size === 0 ? Infinity : size, bytes.length - body) };
      break;
    }
    // Chunks are padded to an even length.
    at = body + size + (size % 2);
  }
  const supported =
    (format === PCM_FORMAT && [8, 16, 24, 32].includes(bits)) ||
    (format === FLOAT_FORMAT && [32, 64].includes(bits));
  if (!supported || channels === 0 || sampleRate === 0 || data === undefined) {
    throw new Error(
      `This WAV file is not supported (format ${String(format)}, ${String(bits)} bit).`,
    );
  }
  const width = bits / 8;
  const frames = Math.floor(data.size / (width * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame++) {
    const base = data.at + frame * width * channels;
    out.forEach((channel, index) => {
      channel[frame] = readSample(view, base + index * width, format, bits);
    });
  }
  return { sampleRate, channels: out };
}

/** Writes a WAV file: 16 bit integers by default, or 32 bit floats, which keep every detail. */
export function encodeWav(pcm: Pcm, sampleFormat: 'int16' | 'float32' = 'int16'): Uint8Array {
  const frames = frameCount(pcm);
  const channels = pcm.channels.length;
  const width = sampleFormat === 'int16' ? 2 : 4;
  const dataSize = frames * channels * width;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const write = (at: number, value: string): void => {
    for (let i = 0; i < 4; i++) view.setUint8(at + i, value.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, sampleFormat === 'int16' ? PCM_FORMAT : FLOAT_FORMAT, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * channels * width, true);
  view.setUint16(32, channels * width, true);
  view.setUint16(34, width * 8, true);
  write(36, 'data');
  view.setUint32(40, dataSize, true);
  let at = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (const channel of pcm.channels) {
      const sample = channel[frame] ?? 0;
      if (sampleFormat === 'float32') {
        view.setFloat32(at, sample, true);
      } else {
        const clamped = Math.max(-1, Math.min(1, sample));
        view.setInt16(at, Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767), true);
      }
      at += width;
    }
  }
  return bytes;
}
