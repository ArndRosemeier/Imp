import { z } from 'zod';
import type { CoreRuntime } from '../runtime.js';

/**
 * The library: every asset of a project in one place, whatever made it and
 * whatever it is. Pictures, sounds, clips and texts are the modalities Imp
 * starts with; a new modality is a new string, declared by whoever brings it,
 * so the library never needs to change for one.
 */
export const BUILT_IN_MODALITIES = [
  { id: 'image', label: 'Pictures', singular: 'Picture' },
  { id: 'sound', label: 'Sounds', singular: 'Sound' },
  { id: 'video', label: 'Clips', singular: 'Clip' },
  { id: 'text', label: 'Texts', singular: 'Text' },
] as const satisfies readonly LibraryModalityInfo[];

export const ModalityId = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .describe('What the asset is: "image", "sound", "video", "text", or a later modality.');

export interface LibraryModalityInfo {
  readonly id: string;
  /** Plural, for filters: "Pictures". */
  readonly label: string;
  readonly singular: string;
}

/** One kind of asset a source brings, such as portraits or recorded dialogue. */
export interface LibraryKindInfo {
  /** Unique across sources, lower-case with dashes: "key-frame". */
  readonly id: string;
  readonly modality: string;
  readonly label: string;
  readonly plural: string;
}

/** Where an asset was born. */
export const Origin = z.enum(['generated', 'imported', 'written', 'edited']);
export type Origin = z.infer<typeof Origin>;

/** The place in the app where an asset is made and changed. */
export const OpenTarget = z.object({
  /** A stage or view id, such as "casting". */
  view: z.string(),
  /** What to show there, by id, for example `{ characterId }`. Views use what they understand. */
  focus: z.record(z.string(), z.string()).default({}),
});
export type OpenTarget = z.infer<typeof OpenTarget>;

/** What a source says about one of its assets. */
export const SourceAsset = z.object({
  /** Stable and unique in the project: the source id, a colon, then the source's own id. */
  id: z.string().regex(/^[a-z][a-z0-9-]*:[A-Za-z0-9._:-]+$/),
  modality: ModalityId,
  kind: z.string(),
  title: z.string(),
  /** Where it belongs, for example "Scene 3, INT. LAMP ROOM" or a character's name. */
  context: z.string().default(''),
  origin: Origin,
  /** The stored file, for media. Null for a text kept as words, or an asset with no file yet. */
  blobKey: z.string().nullable().default(null),
  mediaType: z.string().nullable().default(null),
  /** The words, for a text. */
  text: z.string().nullable().default(null),
  durationSeconds: z.number().nullable().default(null),
  createdAt: z.string().nullable().default(null),
  open: OpenTarget.nullable().default(null),
  /**
   * The ids that name the asset to the commands of its source, for example
   * `{ sceneId, soundId }`, so it can be placed or changed with them.
   */
  refs: z.record(z.string(), z.string()).default({}),
  /** Whether library.delete may remove it; otherwise it goes with its source's own command. */
  deletable: z.boolean().default(false),
});
export type SourceAsset = z.input<typeof SourceAsset>;

/** What the person (or an agent) adds to any asset: tags, a star and notes. */
export const LibraryMeta = z.object({
  tags: z.array(z.string().min(1).max(40)).max(30).default([]),
  favorite: z.boolean().default(false),
  notes: z.string().max(2000).default(''),
});
export type LibraryMeta = z.infer<typeof LibraryMeta>;

export const LibraryAsset = SourceAsset.extend({
  kindLabel: z.string(),
  modalityLabel: z.string(),
  ...LibraryMeta.shape,
});
export type LibraryAsset = z.infer<typeof LibraryAsset>;

/**
 * Something that brings assets into the library: a mode, the world, the audio
 * editor, the library's own imports. Sources read what they already keep; the
 * library stores nothing of theirs but tags and notes.
 */
export interface LibrarySource {
  /** Lower-case, unique: the prefix of every asset id it lists. */
  readonly id: string;
  /** Modalities it brings beyond the built-in ones. */
  readonly modalities?: readonly LibraryModalityInfo[];
  readonly kinds: readonly LibraryKindInfo[];
  /** Every asset of the project this source holds. */
  readonly list: (runtime: CoreRuntime, projectId: string) => Promise<readonly SourceAsset[]>;
}

const EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg'],
  sound: ['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'weba'],
  video: ['mp4', 'webm', 'mov', 'm4v', 'mkv'],
  text: ['txt', 'md', 'markdown', 'srt', 'vtt', 'fountain', 'json', 'csv', 'html', 'xml', 'fdx'],
};

const MEDIA_TYPE_OF: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  weba: 'audio/webm',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  fountain: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  xml: 'application/xml',
  fdx: 'application/xml',
};

const extensionOf = (fileName: string): string =>
  /\.([A-Za-z0-9]+)$/.exec(fileName)?.[1]?.toLowerCase() ?? '';

/**
 * What a picked file is, from its media type and, where the system did not
 * say or said only "binary", its file name. Null when it is none of the
 * built-in modalities.
 */
export function detectModality(
  mediaType: string,
  fileName: string,
): { modality: string; mediaType: string } | null {
  const type = mediaType.toLowerCase().split(';')[0]?.trim() ?? '';
  const extension = extensionOf(fileName);
  const byExtension = Object.entries(EXTENSIONS).find(([, list]) => list.includes(extension));
  const known = MEDIA_TYPE_OF[extension];
  if (type.startsWith('image/')) return { modality: 'image', mediaType: type };
  if (type.startsWith('audio/')) return { modality: 'sound', mediaType: type };
  // Some systems call an .m4a or .weba a video; its name says better.
  if (type.startsWith('video/')) {
    return byExtension?.[0] === 'sound' && known !== undefined
      ? { modality: 'sound', mediaType: known }
      : { modality: 'video', mediaType: type };
  }
  if (type.startsWith('text/')) return { modality: 'text', mediaType: type };
  if (byExtension !== undefined && known !== undefined) {
    return { modality: byExtension[0], mediaType: known };
  }
  if (['application/json', 'application/xml', 'application/x-subrip'].includes(type)) {
    return { modality: 'text', mediaType: type };
  }
  return null;
}
