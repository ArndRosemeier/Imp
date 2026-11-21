import { z } from 'zod';
import { decodeUtf8 } from '../archive.js';
import { defineCommand, type Command } from '../command.js';
import { UPLOAD_PREFIX } from '../commands/project-files.js';
import { CommandError } from '../errors.js';
import type { JsonValue } from '../json.js';
import { requireProject } from '../projects/model.js';
import type { CoreRuntime } from '../runtime.js';
import {
  BUILT_IN_MODALITIES,
  detectModality,
  LibraryAsset,
  LibraryMeta,
  ModalityId,
  Origin,
  SourceAsset,
  type LibraryKindInfo,
  type LibraryModalityInfo,
  type LibrarySource,
} from './model.js';
import {
  fileKey,
  itemKey,
  LibraryItem,
  MAX_TEXT_LENGTH,
  metaKey,
  OWN_SOURCE,
  ownAssetId,
  ownSource,
} from './own.js';

const ProjectId = z.string().describe('The id of a project from project.list.');
const AssetId = z
  .string()
  .min(3)
  .describe('The id of an asset from library.list, for example "movie:portrait:…".');

/** How much of a text library.list shows; library.get gives the whole of it. */
const EXCERPT_LENGTH = 240;
/** Imported texts larger than this are refused: they would not fit any model's context. */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

export const ListedAsset = LibraryAsset.extend({
  /** True when `text` is only the start; library.get returns all of it. */
  textTruncated: z.boolean(),
});
export type ListedAsset = z.infer<typeof ListedAsset>;

const Facet = z.object({ id: z.string(), label: z.string(), count: z.number().int() });
const KindFacet = Facet.extend({ modality: z.string() });

const normalize = (text: string): string =>
  text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

const cleanTags = (tags: readonly string[]): string[] => [
  ...new Set(tags.map((tag) => tag.trim().replace(/\s+/g, ' ')).filter((tag) => tag !== '')),
];

/**
 * The commands of the library. `sources` are everything that brings assets:
 * the modes, the world, the audio editor. The library's own imports are
 * always among them.
 */
export function createLibraryCommands(sources: readonly LibrarySource[]): readonly Command[] {
  const all = [ownSource, ...sources.filter((source) => source.id !== OWN_SOURCE)];
  const ids = new Set<string>();
  for (const source of all) {
    if (ids.has(source.id)) throw new TypeError(`Two library sources are named "${source.id}".`);
    ids.add(source.id);
  }
  const modalities = new Map<string, LibraryModalityInfo>(
    [...BUILT_IN_MODALITIES, ...all.flatMap((source) => source.modalities ?? [])].map((info) => [
      info.id,
      info,
    ]),
  );
  const kinds = new Map<string, LibraryKindInfo>(
    all.flatMap((source) => source.kinds).map((info) => [info.id, info]),
  );
  const modalityLabel = (id: string): string => modalities.get(id)?.singular ?? id;
  const kindLabel = (id: string): string => kinds.get(id)?.label ?? id;

  async function readMeta(
    runtime: CoreRuntime,
    projectId: string,
  ): Promise<Map<string, LibraryMeta>> {
    const prefix = metaKey(projectId, '');
    return new Map(
      (await runtime.store.list(prefix)).map((entry) => [
        entry.key.slice(prefix.length),
        LibraryMeta.parse(entry.value),
      ]),
    );
  }

  async function collect(runtime: CoreRuntime, projectId: string): Promise<LibraryAsset[]> {
    const meta = await readMeta(runtime, projectId);
    const lists = await Promise.all(all.map((source) => source.list(runtime, projectId)));
    return lists.flat().map((raw) => {
      const asset = SourceAsset.parse(raw);
      return LibraryAsset.parse({
        ...asset,
        kindLabel: kindLabel(asset.kind),
        modalityLabel: modalityLabel(asset.modality),
        ...LibraryMeta.parse(meta.get(asset.id) ?? {}),
      });
    });
  }

  async function findAsset(
    runtime: CoreRuntime,
    commandId: string,
    projectId: string,
    assetId: string,
  ): Promise<LibraryAsset> {
    await requireProject(runtime.store, commandId, projectId);
    const asset = (await collect(runtime, projectId)).find((candidate) => candidate.id === assetId);
    if (asset === undefined) {
      throw new CommandError(
        'invalid_input',
        commandId,
        `No asset "${assetId}" in that project. Ids come from library.list.`,
      );
    }
    return asset;
  }

  const list = defineCommand({
    id: 'library.list',
    title: 'Browse the library',
    description:
      'Lists the assets of a project in one place: pictures (portraits, key frames, views of locations and objects), sounds (dialogue, effects, music, voices, recordings), clips and texts (scenes, notes, subtitles), generated, written or imported, with counts by modality, kind and tag. Search with words and filter by modality, kind, tag, origin or favorites. Texts are cut short; library.get returns one whole. Each asset has the blobKey to use it elsewhere: a sound with audio.region.insert, any medium with media.view.',
    effect: 'read',
    input: z.object({
      projectId: ProjectId,
      query: z
        .string()
        .max(200)
        .default('')
        .describe('Words that must all appear in the title, place, kind, tags, notes or text.'),
      modality: ModalityId.optional(),
      kind: z.string().optional().describe('A kind id from the facets, such as "portrait".'),
      tag: z.string().optional(),
      origin: Origin.optional(),
      favorite: z.boolean().optional().describe('True for starred assets only.'),
      sort: z.enum(['newest', 'oldest', 'name']).default('newest'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(60),
    }),
    output: z.object({
      assets: z.array(ListedAsset),
      /** How many match, of which `assets` is the page from `offset`. */
      total: z.number().int(),
      facets: z.object({
        modalities: z.array(Facet),
        kinds: z.array(KindFacet),
        tags: z.array(Facet),
      }),
    }),
    handler: async ({ runtime }, input) => {
      await requireProject(runtime.store, 'library.list', input.projectId);
      const everything = await collect(runtime, input.projectId);
      const words = normalize(input.query)
        .split(/\s+/)
        .filter((word) => word !== '');
      const found = everything.filter((asset) => {
        if (words.length === 0) return true;
        const haystack = normalize(
          [
            asset.title,
            asset.context,
            asset.kindLabel,
            asset.modalityLabel,
            asset.tags.join(' '),
            asset.notes,
            asset.text ?? '',
          ].join('\n'),
        );
        return words.every((word) => haystack.includes(word));
      });

      const count = (values: readonly string[]): Map<string, number> => {
        const counts = new Map<string, number>();
        for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
        return counts;
      };
      const byModality = count(found.map((asset) => asset.modality));
      const inModality =
        input.modality === undefined
          ? found
          : found.filter((asset) => asset.modality === input.modality);
      const byKind = count(inModality.map((asset) => asset.kind));
      const byTag = count(found.flatMap((asset) => asset.tags));
      const facets = {
        modalities: [...modalities.values()]
          .filter(
            (info) => byModality.has(info.id) || BUILT_IN_MODALITIES.some((b) => b.id === info.id),
          )
          .map((info) => ({ id: info.id, label: info.label, count: byModality.get(info.id) ?? 0 })),
        kinds: [...byKind].map(([id, total]) => ({
          id,
          label: kinds.get(id)?.plural ?? id,
          modality: kinds.get(id)?.modality ?? '',
          count: total,
        })),
        tags: [...byTag]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([tag, total]) => ({ id: tag, label: tag, count: total })),
      };

      const matching = inModality.filter(
        (asset) =>
          (input.kind === undefined || asset.kind === input.kind) &&
          (input.tag === undefined || asset.tags.includes(input.tag)) &&
          (input.origin === undefined || asset.origin === input.origin) &&
          (input.favorite !== true || asset.favorite),
      );
      const sorted = [...matching].sort((a, b) => {
        if (input.sort === 'name') return a.title.localeCompare(b.title);
        const order = (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
        return input.sort === 'oldest' ? order : -order;
      });
      const page = sorted.slice(input.offset, input.offset + input.limit).map((asset) => {
        const text = asset.text;
        const long = text !== null && text.length > EXCERPT_LENGTH;
        return {
          ...asset,
          text: long ? `${text.slice(0, EXCERPT_LENGTH - 1)}…` : text,
          textTruncated: long,
        };
      });
      return { assets: page, total: matching.length, facets };
    },
  });

  const get = defineCommand({
    id: 'library.get',
    title: 'Get asset',
    description:
      'Returns one asset of the library whole, with all of its text. Look at or listen to its file with media.view and its blobKey.',
    effect: 'read',
    input: z.object({ projectId: ProjectId, assetId: AssetId }),
    output: LibraryAsset,
    handler: async ({ runtime }, { projectId, assetId }) =>
      findAsset(runtime, 'library.get', projectId, assetId),
  });

  const save = async (
    runtime: CoreRuntime,
    projectId: string,
    item: LibraryItem,
  ): Promise<void> => {
    await runtime.store.batch([
      { type: 'put', key: itemKey(projectId, item.id), value: item as unknown as JsonValue },
    ]);
  };
  const putMeta = async (
    runtime: CoreRuntime,
    projectId: string,
    assetId: string,
    meta: LibraryMeta,
  ): Promise<void> => {
    const empty = meta.tags.length === 0 && !meta.favorite && meta.notes === '';
    await runtime.store.batch([
      empty
        ? { type: 'delete', key: metaKey(projectId, assetId) }
        : { type: 'put', key: metaKey(projectId, assetId), value: meta as unknown as JsonValue },
    ]);
  };

  const importFile = defineCommand({
    id: 'library.import',
    title: 'Import file',
    description:
      'Brings a file the person picked into the library of a project: a picture, a sound, a video or a text (plain text, Markdown, subtitles, Fountain). Its kind is told from its type and name. The file must be under "uploads/", where the app puts what the person picks.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      fileKey: z
        .string()
        .refine((key) => key.startsWith(UPLOAD_PREFIX), { message: 'Must be under "uploads/".' })
        .describe('Where the picked file is.'),
      fileName: z.string().max(260).default('').describe('The name the file had on disk.'),
      name: z.string().max(200).optional().describe('A name to show. Defaults to the file name.'),
      tags: z.array(z.string().max(40)).max(30).default([]),
    }),
    output: LibraryAsset,
    handler: async ({ runtime }, input) => {
      const id = 'library.import';
      await requireProject(runtime.store, id, input.projectId);
      const blob = await runtime.blobs.get(input.fileKey);
      if (blob === undefined) {
        throw new CommandError('invalid_input', id, `Nothing is stored under "${input.fileKey}".`);
      }
      const detected = detectModality(blob.mediaType, input.fileName);
      if (detected === null) {
        throw new CommandError(
          'invalid_input',
          id,
          `"${input.fileName || blob.mediaType || 'This file'}" is not a picture, sound, video or text the library knows.`,
        );
      }
      const itemId = runtime.newId();
      const baseName = input.fileName.replace(/\.[A-Za-z0-9]+$/, '').trim();
      const name = (input.name ?? '').trim() || baseName || `Imported ${detected.modality}`;
      let item: LibraryItem;
      if (detected.modality === 'text') {
        if (blob.bytes.length > MAX_TEXT_BYTES) {
          throw new CommandError('invalid_input', id, 'This text is larger than 4 MB.');
        }
        const text = decodeUtf8(blob.bytes).replace(/^\uFEFF/, '');
        if (text.length > MAX_TEXT_LENGTH) {
          throw new CommandError('invalid_input', id, 'This text is too long for the library.');
        }
        item = {
          id: itemId,
          name: name.slice(0, 200),
          modality: 'text',
          kind: 'imported',
          mediaType: detected.mediaType,
          blobKey: null,
          text,
          fileName: input.fileName,
          sizeBytes: blob.bytes.length,
          durationSeconds: null,
          createdAt: runtime.now().toISOString(),
        };
      } else {
        const key = fileKey(input.projectId, itemId);
        await runtime.blobs.put(key, { bytes: blob.bytes, mediaType: detected.mediaType });
        item = {
          id: itemId,
          name: name.slice(0, 200),
          modality: detected.modality,
          kind: 'imported',
          mediaType: detected.mediaType,
          blobKey: key,
          text: null,
          fileName: input.fileName,
          sizeBytes: blob.bytes.length,
          durationSeconds: null,
          createdAt: runtime.now().toISOString(),
        };
      }
      await save(runtime, input.projectId, item);
      const tags = cleanTags(input.tags);
      if (tags.length > 0) {
        await putMeta(runtime, input.projectId, ownAssetId(itemId), LibraryMeta.parse({ tags }));
      }
      await runtime.blobs.delete(input.fileKey);
      return findAsset(runtime, id, input.projectId, ownAssetId(itemId));
    },
  });

  const writeText = defineCommand({
    id: 'library.text.create',
    title: 'Write text',
    description:
      'Keeps a text in the library of a project: notes, research, a draft, subtitles, a shot list. Use library.update to change it later.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      name: z.string().min(1).max(200),
      text: z.string().max(MAX_TEXT_LENGTH),
      tags: z.array(z.string().max(40)).max(30).default([]),
    }),
    output: LibraryAsset,
    handler: async ({ runtime }, input) => {
      const id = 'library.text.create';
      await requireProject(runtime.store, id, input.projectId);
      const itemId = runtime.newId();
      await save(runtime, input.projectId, {
        id: itemId,
        name: input.name.trim() || 'Untitled text',
        modality: 'text',
        kind: 'note',
        mediaType: 'text/plain',
        blobKey: null,
        text: input.text,
        fileName: '',
        sizeBytes: 0,
        durationSeconds: null,
        createdAt: runtime.now().toISOString(),
      });
      const tags = cleanTags(input.tags);
      if (tags.length > 0) {
        await putMeta(runtime, input.projectId, ownAssetId(itemId), LibraryMeta.parse({ tags }));
      }
      return findAsset(runtime, id, input.projectId, ownAssetId(itemId));
    },
  });

  const update = defineCommand({
    id: 'library.update',
    title: 'Change asset',
    description:
      'Tags, stars or annotates any asset of the library. The name and the text can be changed only for what was imported or written in the library; everything else is renamed where it was made. Fields left out stay as they are; tags replace the earlier ones.',
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      assetId: AssetId,
      name: z.string().min(1).max(200).optional(),
      text: z.string().max(MAX_TEXT_LENGTH).optional(),
      tags: z.array(z.string().max(40)).max(30).optional(),
      favorite: z.boolean().optional(),
      notes: z.string().max(2000).optional(),
      durationSeconds: z
        .number()
        .positive()
        .optional()
        .describe('The measured length of an imported sound or clip.'),
    }),
    output: LibraryAsset,
    handler: async ({ runtime }, input) => {
      const id = 'library.update';
      const asset = await findAsset(runtime, id, input.projectId, input.assetId);
      const own = asset.id.startsWith(`${OWN_SOURCE}:`);
      if (
        !own &&
        (input.name !== undefined ||
          input.text !== undefined ||
          input.durationSeconds !== undefined)
      ) {
        throw new CommandError(
          'invalid_input',
          id,
          `"${asset.title}" belongs to ${asset.open === null ? 'its source' : `the ${asset.open.view} stage`}; change its name or words there. Tags, the star and notes can be set here.`,
        );
      }
      if (own) {
        const itemId = asset.refs['itemId'] ?? '';
        const stored = LibraryItem.parse(await runtime.store.get(itemKey(input.projectId, itemId)));
        if (input.text !== undefined && stored.modality !== 'text') {
          throw new CommandError('invalid_input', id, 'Only a text has words to change.');
        }
        if (
          input.name !== undefined ||
          input.text !== undefined ||
          input.durationSeconds !== undefined
        ) {
          await save(runtime, input.projectId, {
            ...stored,
            name:
              input.name === undefined || input.name.trim() === ''
                ? stored.name
                : input.name.trim(),
            text: input.text ?? stored.text,
            durationSeconds: input.durationSeconds ?? stored.durationSeconds,
          });
        }
      }
      if (input.tags !== undefined || input.favorite !== undefined || input.notes !== undefined) {
        await putMeta(runtime, input.projectId, asset.id, {
          tags: input.tags === undefined ? asset.tags : cleanTags(input.tags),
          favorite: input.favorite ?? asset.favorite,
          notes: input.notes ?? asset.notes,
        });
      }
      return findAsset(runtime, id, input.projectId, input.assetId);
    },
  });

  const remove = defineCommand({
    id: 'library.delete',
    title: 'Delete asset',
    description:
      'Removes something that was imported or written in the library, with its file. Generated assets are removed where they were made, for example a sound with movie.sound.delete.',
    effect: 'destructive',
    input: z.object({ projectId: ProjectId, assetId: AssetId }),
    output: z.object({ assetId: z.string() }),
    handler: async ({ runtime }, { projectId, assetId }) => {
      const id = 'library.delete';
      const asset = await findAsset(runtime, id, projectId, assetId);
      if (!asset.deletable || !asset.id.startsWith(`${OWN_SOURCE}:`)) {
        throw new CommandError(
          'invalid_input',
          id,
          `"${asset.title}" was not imported or written in the library. Delete it where it was made${asset.open === null ? '' : ` (the ${asset.open.view} stage)`}.`,
        );
      }
      const itemId = asset.refs['itemId'] ?? '';
      await runtime.store.batch([
        { type: 'delete', key: itemKey(projectId, itemId) },
        { type: 'delete', key: metaKey(projectId, asset.id) },
      ]);
      if (asset.blobKey !== null) await runtime.blobs.delete(asset.blobKey);
      return { assetId };
    },
  });

  const copy = defineCommand({
    id: 'library.copy',
    title: 'Copy to another project',
    description:
      "Copies assets into the library of another project, as files of its own with their tags and notes: a portrait, a sound, a clip or a text. Copying a whole character, scene or location with everything that belongs to it is project.resources.copy's job instead.",
    effect: 'write',
    input: z.object({
      projectId: ProjectId,
      assetIds: z.array(AssetId).min(1).max(200),
      toProjectId: z.string().describe('The project to copy into.'),
    }),
    output: z.object({ copied: z.array(LibraryAsset) }),
    handler: async ({ runtime }, { projectId, assetIds, toProjectId }) => {
      const id = 'library.copy';
      await requireProject(runtime.store, id, projectId);
      await requireProject(runtime.store, id, toProjectId);
      if (toProjectId === projectId) {
        throw new CommandError('invalid_input', id, 'Pick another project to copy into.');
      }
      const everything = await collect(runtime, projectId);
      const chosen = assetIds.map((assetId) => {
        const asset = everything.find((candidate) => candidate.id === assetId);
        if (asset === undefined) {
          throw new CommandError('invalid_input', id, `No asset "${assetId}" in that project.`);
        }
        if (asset.blobKey === null && asset.text === null) {
          throw new CommandError(
            'invalid_input',
            id,
            `"${asset.title}" has nothing made yet to copy.`,
          );
        }
        return asset;
      });
      const copiedIds: string[] = [];
      for (const asset of chosen) {
        const itemId = runtime.newId();
        let blobKey: string | null = null;
        let sizeBytes = 0;
        if (asset.blobKey !== null) {
          const blob = await runtime.blobs.get(asset.blobKey);
          if (blob === undefined) {
            throw new CommandError('invalid_input', id, `The file of "${asset.title}" is missing.`);
          }
          blobKey = fileKey(toProjectId, itemId);
          sizeBytes = blob.bytes.length;
          await runtime.blobs.put(blobKey, blob);
        }
        await save(runtime, toProjectId, {
          id: itemId,
          name: (asset.title.trim() || asset.kindLabel).slice(0, 200),
          modality: asset.modality,
          kind: asset.blobKey === null ? 'note' : 'imported',
          mediaType: asset.mediaType,
          blobKey,
          text: asset.blobKey === null ? asset.text : null,
          fileName: asset.context,
          sizeBytes,
          durationSeconds: asset.durationSeconds,
          createdAt: runtime.now().toISOString(),
        });
        if (asset.tags.length > 0 || asset.favorite || asset.notes !== '') {
          await putMeta(runtime, toProjectId, ownAssetId(itemId), {
            tags: asset.tags,
            favorite: asset.favorite,
            notes: asset.notes,
          });
        }
        copiedIds.push(ownAssetId(itemId));
      }
      const target = await collect(runtime, toProjectId);
      return { copied: copiedIds.flatMap((assetId) => target.filter((a) => a.id === assetId)) };
    },
  });

  return [list, get, importFile, writeText, update, remove, copy];
}
