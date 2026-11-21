import { z } from 'zod';
import { projectPrefix } from '../projects/model.js';
import type { CoreRuntime } from '../runtime.js';
import type { LibrarySource, SourceAsset } from './model.js';

/** The library's own source: files the person brought in and texts written straight into it. */
export const OWN_SOURCE = 'library';

export const libraryPrefix = (projectId: string): string => `${projectPrefix(projectId)}library/`;
export const itemKey = (projectId: string, itemId: string): string =>
  `${libraryPrefix(projectId)}items/${itemId}`;
/** Imported files are ordinary blobs under the project, so every command that takes a key reads them. */
export const fileKey = (projectId: string, itemId: string): string =>
  `${libraryPrefix(projectId)}files/${itemId}`;
export const metaKey = (projectId: string, assetId: string): string =>
  `${libraryPrefix(projectId)}meta/${assetId}`;

/** The most words one text may hold, so one asset cannot fill a model's context or the store. */
export const MAX_TEXT_LENGTH = 1_000_000;

/** A file brought into the library, or a text written there. */
export const LibraryItem = z.object({
  id: z.string(),
  name: z.string().min(1).max(200),
  modality: z.string(),
  /** "imported" for a file, "note" for a text written in the library. */
  kind: z.enum(['imported', 'note']),
  mediaType: z.string().nullable(),
  blobKey: z.string().nullable(),
  text: z.string().max(MAX_TEXT_LENGTH).nullable(),
  /** The name of the file it came from; empty for a note. */
  fileName: z.string(),
  sizeBytes: z.number().int().min(0),
  /** Measured by whoever could, such as the app's player; null until then. */
  durationSeconds: z.number().nullable().default(null),
  createdAt: z.iso.datetime(),
});
export type LibraryItem = z.infer<typeof LibraryItem>;

export const ownAssetId = (itemId: string): string => `${OWN_SOURCE}:${itemId}`;

export function itemAsset(item: LibraryItem): SourceAsset {
  return {
    id: ownAssetId(item.id),
    modality: item.modality,
    kind: item.kind === 'note' ? 'note' : `imported-${item.modality}`,
    title: item.name,
    context: item.fileName === '' ? '' : item.fileName,
    origin: item.kind === 'note' ? 'written' : 'imported',
    blobKey: item.blobKey,
    mediaType: item.mediaType,
    text: item.text,
    durationSeconds: item.durationSeconds,
    createdAt: item.createdAt,
    open: null,
    refs: { itemId: item.id },
    deletable: true,
  };
}

export async function readItems(runtime: CoreRuntime, projectId: string): Promise<LibraryItem[]> {
  return (await runtime.store.list(`${libraryPrefix(projectId)}items/`)).map((entry) =>
    LibraryItem.parse(entry.value),
  );
}

export const ownSource: LibrarySource = {
  id: OWN_SOURCE,
  kinds: [
    { id: 'imported-image', modality: 'image', label: 'Imported picture', plural: 'Imported' },
    { id: 'imported-sound', modality: 'sound', label: 'Imported sound', plural: 'Imported' },
    { id: 'imported-video', modality: 'video', label: 'Imported clip', plural: 'Imported' },
    { id: 'imported-text', modality: 'text', label: 'Imported text', plural: 'Imported' },
    { id: 'note', modality: 'text', label: 'Note', plural: 'Notes' },
  ],
  list: async (runtime, projectId) => (await readItems(runtime, projectId)).map(itemAsset),
};
