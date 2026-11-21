/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return --
 * Commands run by id answer with untyped output; these tests read it loosely and assert on it.
 */
import { describe, expect, it } from 'vitest';
import {
  CommandRegistry,
  createLibraryCommands,
  createProjectCommands,
  detectModality,
  projectPrefix,
  type LibrarySource,
} from '../src/index.js';
import { encodeUtf8 } from '../src/archive.js';
import { createTestRuntime } from '../src/testing.js';

const user = { kind: 'user', id: 'arnd' } as const;
const agent = { kind: 'agent', id: 'a', role: 'sound-editor' } as const;

/** A source that lists "boards" kept under `boards/<id>`, each a picture with a file, plus a hologram modality. */
const boards: LibrarySource = {
  id: 'boards',
  modalities: [{ id: 'hologram', label: 'Holograms', singular: 'Hologram' }],
  kinds: [
    { id: 'board', modality: 'image', label: 'Board', plural: 'Boards' },
    { id: 'holo', modality: 'hologram', label: 'Holo', plural: 'Holos' },
  ],
  list: async (runtime, projectId) =>
    (await runtime.store.list(`${projectPrefix(projectId)}boards/`)).map((entry) => {
      const board = entry.value as { id: string; name: string; at: string };
      return {
        id: `boards:board:${board.id}`,
        modality: 'image',
        kind: 'board',
        title: board.name,
        context: 'Mood',
        origin: 'generated' as const,
        blobKey: `${projectPrefix(projectId)}boards/${board.id}/file`,
        mediaType: 'image/png',
        createdAt: board.at,
        open: { view: 'design', focus: { boardId: board.id } },
      };
    }),
};

function setup() {
  const runtime = createTestRuntime();
  const registry = new CommandRegistry({ runtime }).register(
    ...createProjectCommands([]),
    ...createLibraryCommands([boards]),
  );
  const run = async (id: string, input: unknown, actor: typeof user | typeof agent = user) => {
    const result = await registry.executeById(id, input, { actor });
    if (result.status !== 'ok') throw new Error(`${id}: ${result.status}`);
    return result.output as any;
  };
  const project = async (name: string) =>
    (await run('project.create', { name, mode: 'movie' })) as { id: string };
  const upload = async (key: string, text: string | Uint8Array, mediaType: string) => {
    await runtime.blobs.put(key, {
      bytes: typeof text === 'string' ? encodeUtf8(text) : text,
      mediaType,
    });
  };
  const board = async (projectId: string, id: string, name: string, at: string) => {
    await runtime.store.batch([
      { type: 'put', key: `${projectPrefix(projectId)}boards/${id}`, value: { id, name, at } },
    ]);
    await runtime.blobs.put(`${projectPrefix(projectId)}boards/${id}/file`, {
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: 'image/png',
    });
  };
  return { runtime, run, project, upload, board };
}

describe('detectModality', () => {
  it('tells pictures, sounds, clips and texts from their type, and from the name when the type says nothing', () => {
    expect(detectModality('image/webp', 'a.webp')).toEqual({
      modality: 'image',
      mediaType: 'image/webp',
    });
    expect(detectModality('audio/mpeg', 'door.mp3')?.modality).toBe('sound');
    expect(detectModality('video/mp4', 'take.mp4')?.modality).toBe('video');
    expect(detectModality('video/mp4', 'voice.m4a')).toEqual({
      modality: 'sound',
      mediaType: 'audio/mp4',
    });
    expect(detectModality('', 'film.srt')).toEqual({
      modality: 'text',
      mediaType: 'application/x-subrip',
    });
    expect(detectModality('application/octet-stream', 'scene.fountain')?.modality).toBe('text');
    expect(detectModality('text/plain; charset=utf-8', 'x')?.mediaType).toBe('text/plain');
    expect(detectModality('application/octet-stream', 'thing.bin')).toBeNull();
  });
});

describe('the library', () => {
  it('lists the assets of every source together, newest first, with counts', async () => {
    const { run, project, board } = setup();
    const { id } = await project('Lighthouse');
    await board(id, 'b1', 'Storm mood', '2026-01-01T00:00:01.000Z');
    await board(id, 'b2', 'Calm mood', '2026-01-01T00:00:03.000Z');
    await run('library.text.create', { projectId: id, name: 'Research', text: 'Fresnel lenses' });

    const listed = await run('library.list', { projectId: id });
    expect(listed.total).toBe(3);
    expect(listed.assets.map((asset: any) => asset.title)).toEqual([
      'Calm mood',
      'Storm mood',
      'Research',
    ]);
    expect(listed.assets[0]).toMatchObject({
      modality: 'image',
      kindLabel: 'Board',
      modalityLabel: 'Picture',
      tags: [],
      favorite: false,
      open: { view: 'design', focus: { boardId: 'b2' } },
    });
    expect(listed.facets.modalities).toEqual([
      { id: 'image', label: 'Pictures', count: 2 },
      { id: 'sound', label: 'Sounds', count: 0 },
      { id: 'video', label: 'Clips', count: 0 },
      { id: 'text', label: 'Texts', count: 1 },
    ]);
    expect(listed.facets.kinds).toContainEqual({
      id: 'note',
      label: 'Notes',
      modality: 'text',
      count: 1,
    });

    const byName = await run('library.list', { projectId: id, sort: 'name' });
    expect(byName.assets.map((asset: any) => asset.title)).toEqual([
      'Calm mood',
      'Research',
      'Storm mood',
    ]);
  });

  it('searches every word across titles, text, tags and notes, and filters', async () => {
    const { run, project, board } = setup();
    const { id } = await project('Lighthouse');
    await board(id, 'b1', 'Storm mood', '2026-01-01T00:00:01.000Z');
    await board(id, 'b2', 'Calm mood', '2026-01-01T00:00:02.000Z');
    await run('library.text.create', {
      projectId: id,
      name: 'Notes',
      text: 'The storm never ends.',
    });
    await run('library.update', {
      projectId: id,
      assetId: 'boards:board:b2',
      tags: ['act two', 'act two', ' '],
      favorite: true,
    });

    const storm = await run('library.list', { projectId: id, query: 'STORM' });
    expect(storm.total).toBe(2);
    const both = await run('library.list', { projectId: id, query: 'storm mood' });
    expect(both.assets.map((a: any) => a.title)).toEqual(['Storm mood']);
    const tagged = await run('library.list', { projectId: id, query: 'act' });
    expect(tagged.assets.map((a: any) => a.title)).toEqual(['Calm mood']);
    expect((await run('library.list', { projectId: id, tag: 'act two' })).total).toBe(1);
    expect((await run('library.list', { projectId: id, favorite: true })).total).toBe(1);
    expect((await run('library.list', { projectId: id, modality: 'text' })).total).toBe(1);
    expect((await run('library.list', { projectId: id, origin: 'written' })).total).toBe(1);
    const pictures = await run('library.list', { projectId: id, modality: 'image' });
    // Kinds are counted within the chosen modality; modalities across all.
    expect(pictures.facets.kinds).toEqual([
      { id: 'board', label: 'Boards', modality: 'image', count: 2 },
    ]);
    expect(pictures.facets.tags).toEqual([{ id: 'act two', label: 'act two', count: 1 }]);
    const page = await run('library.list', { projectId: id, limit: 1, offset: 1 });
    expect(page).toMatchObject({ total: 3 });
    expect(page.assets).toHaveLength(1);
  });

  it('imports pictures, sounds, clips and texts the person picked, and removes the upload', async () => {
    const { run, project, upload, runtime } = setup();
    const { id } = await project('Lighthouse');
    await upload('uploads/u1', new Uint8Array([9, 9]), 'audio/mpeg');
    const sound = await run('library.import', {
      projectId: id,
      fileKey: 'uploads/u1',
      fileName: 'Door slam.mp3',
      tags: ['foley'],
    });
    expect(sound).toMatchObject({
      modality: 'sound',
      kind: 'imported-sound',
      title: 'Door slam',
      context: 'Door slam.mp3',
      origin: 'imported',
      mediaType: 'audio/mpeg',
      tags: ['foley'],
      deletable: true,
    });
    expect(sound.blobKey.startsWith(`${projectPrefix(id)}library/files/`)).toBe(true);
    expect((await runtime.blobs.get(sound.blobKey))?.bytes).toEqual(new Uint8Array([9, 9]));
    expect(await runtime.blobs.get('uploads/u1')).toBeUndefined();

    await upload('uploads/u2', '﻿1\n00:00:01,000 --> 00:00:02,000\nHello', '');
    const subtitles = await run('library.import', {
      projectId: id,
      fileKey: 'uploads/u2',
      fileName: 'film.srt',
      name: 'English subtitles',
    });
    expect(subtitles).toMatchObject({
      modality: 'text',
      title: 'English subtitles',
      blobKey: null,
    });
    expect(subtitles.text.startsWith('1\n00:00:01')).toBe(true);

    await upload('uploads/u3', new Uint8Array([0]), 'application/octet-stream');
    await expect(
      run('library.import', { projectId: id, fileKey: 'uploads/u3', fileName: 'x.bin' }),
    ).rejects.toThrow(/not a picture, sound, video or text/);
    await expect(
      run('library.import', { projectId: id, fileKey: 'elsewhere/u3' }),
    ).rejects.toThrow();
  });

  it('shortens long texts in the list and gives them whole with library.get', async () => {
    const { run, project } = setup();
    const { id } = await project('Lighthouse');
    const long = 'word '.repeat(200);
    const note = await run('library.text.create', { projectId: id, name: 'Long', text: long });
    const [listed] = (await run('library.list', { projectId: id })).assets;
    expect(listed.textTruncated).toBe(true);
    expect(listed.text.length).toBeLessThan(260);
    expect((await run('library.get', { projectId: id, assetId: note.id })).text).toBe(long);
    await expect(run('library.get', { projectId: id, assetId: 'nope:x' })).rejects.toThrow(
      /No asset/,
    );
  });

  it('renames and rewrites only its own items, but tags and stars anything', async () => {
    const { run, project, board } = setup();
    const { id } = await project('Lighthouse');
    await board(id, 'b1', 'Storm mood', '2026-01-01T00:00:01.000Z');
    const note = await run('library.text.create', { projectId: id, name: 'Draft', text: 'one' });
    const changed = await run('library.update', {
      projectId: id,
      assetId: note.id,
      name: 'Final',
      text: 'two',
      notes: 'Use in act 3',
    });
    expect(changed).toMatchObject({ title: 'Final', text: 'two', notes: 'Use in act 3' });
    await expect(
      run('library.update', { projectId: id, assetId: 'boards:board:b1', name: 'X' }),
    ).rejects.toThrow(/design stage/);
    const starred = await run('library.update', {
      projectId: id,
      assetId: 'boards:board:b1',
      favorite: true,
    });
    expect(starred.favorite).toBe(true);
    // Clearing everything leaves no record behind.
    await run('library.update', { projectId: id, assetId: 'boards:board:b1', favorite: false });
    expect((await run('library.get', { projectId: id, assetId: 'boards:board:b1' })).favorite).toBe(
      false,
    );
  });

  it('deletes only what was imported or written there, and agents must ask first', async () => {
    const { run, project, board, upload, runtime } = setup();
    const { id } = await project('Lighthouse');
    await board(id, 'b1', 'Storm mood', '2026-01-01T00:00:01.000Z');
    await upload('uploads/u1', new Uint8Array([1]), 'image/png');
    const picture = await run('library.import', {
      projectId: id,
      fileKey: 'uploads/u1',
      fileName: 'ref.png',
    });
    await expect(
      run('library.delete', { projectId: id, assetId: picture.id }, agent),
    ).rejects.toThrow(/needs-approval/);
    await run('library.delete', { projectId: id, assetId: picture.id });
    expect(await runtime.blobs.get(picture.blobKey)).toBeUndefined();
    expect((await run('library.list', { projectId: id })).total).toBe(1);
    await expect(
      run('library.delete', { projectId: id, assetId: 'boards:board:b1' }),
    ).rejects.toThrow(/Delete it where it was made/);
  });

  it('copies assets into another project as files of its own', async () => {
    const { run, project, board, runtime } = setup();
    const { id: from } = await project('Lighthouse');
    const { id: to } = await project('Sequel');
    await board(from, 'b1', 'Storm mood', '2026-01-01T00:00:01.000Z');
    await run('library.update', { projectId: from, assetId: 'boards:board:b1', tags: ['mood'] });
    const note = await run('library.text.create', {
      projectId: from,
      name: 'Research',
      text: 'lenses',
    });
    const { copied } = await run('library.copy', {
      projectId: from,
      assetIds: ['boards:board:b1', note.id],
      toProjectId: to,
    });
    expect(copied).toHaveLength(2);
    expect(copied[0]).toMatchObject({
      title: 'Storm mood',
      modality: 'image',
      origin: 'imported',
      tags: ['mood'],
    });
    expect((await runtime.blobs.get(copied[0].blobKey))?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(copied[1]).toMatchObject({ title: 'Research', text: 'lenses', origin: 'written' });
    await expect(
      run('library.copy', { projectId: from, assetIds: [note.id], toProjectId: from }),
    ).rejects.toThrow(/another project/);
  });

  it('carries imported files along when a project is duplicated or exported', async () => {
    const { run, project, upload, runtime } = setup();
    const { id } = await project('Lighthouse');
    await upload('uploads/u1', new Uint8Array([7]), 'audio/wav');
    await run('library.import', { projectId: id, fileKey: 'uploads/u1', fileName: 'wind.wav' });
    const copy = await run('project.duplicate', { projectId: id });
    const [asset] = (await run('library.list', { projectId: copy.id })).assets;
    expect(asset.blobKey.startsWith(projectPrefix(copy.id))).toBe(true);
    expect((await runtime.blobs.get(asset.blobKey))?.bytes).toEqual(new Uint8Array([7]));
  });

  it('refuses two sources with one name', () => {
    expect(() => createLibraryCommands([boards, boards])).toThrow(/Two library sources/);
  });
});
