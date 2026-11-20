/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument --
 * Commands run by id answer with untyped output; these tests read it loosely and assert on it.
 */
import { describe, expect, it } from 'vitest';
import {
  ArchiveError,
  CommandRegistry,
  createProjectCommands,
  crc32,
  itemKey,
  projectPrefix,
  readArchive,
  writeArchive,
  type CollisionChoice,
  type CopyOutcome,
  type ModeProjectSupport,
  type PlannedItem,
  type ResourceCopier,
} from '../src/index.js';
import { decodeUtf8, encodeUtf8 } from '../src/archive.js';
import { createTestRuntime } from '../src/testing.js';

const user = { kind: 'user', id: 'arnd' } as const;
const agent = { kind: 'agent', id: 'a', role: 'casting-director' } as const;
type Actor = typeof user | typeof agent;

/**
 * A mode whose resources are "notes" kept under `notes/<id>`, with files
 * under the same key. A note can need another note.
 */
const notes: ResourceCopier = {
  kinds: [
    { id: 'board', label: 'Board', plural: 'Boards', needsParent: false, parentKind: null },
    { id: 'note', label: 'Note', plural: 'Notes', needsParent: false, parentKind: null },
    { id: 'pin', label: 'Pin', plural: 'Pins', needsParent: true, parentKind: 'board' },
    { id: 'tack', label: 'Tack', plural: 'Tacks', needsParent: true, parentKind: 'nothing' },
  ],
  async list(runtime, projectId) {
    return (await runtime.store.list(`${projectPrefix(projectId)}notes/`)).map((entry) => {
      const note = entry.value as { id: string; name: string };
      return { kind: 'note', id: note.id, name: note.name, detail: '', parentId: null };
    });
  },
  async plan(runtime, spec) {
    const planned: PlannedItem[] = [];
    const queue = [...spec.picks.map((p) => ({ ...p, by: null as string | null }))];
    while (queue.length > 0) {
      const pick = queue.shift();
      if (pick === undefined || planned.some((p) => p.id === pick.id)) continue;
      const note = (await runtime.store.get(
        `${projectPrefix(spec.fromProjectId)}notes/${pick.id}`,
      )) as {
        id: string;
        name: string;
        needs?: string;
      };
      const there = (await runtime.store.list(`${projectPrefix(spec.toProjectId)}notes/`)).map(
        (entry) => entry.value as { id: string; name: string },
      );
      const match = there.find((t) => t.id === note.id || t.name === note.name);
      planned.push({
        kind: 'note',
        id: note.id,
        name: note.name,
        reason: pick.by === null ? 'picked' : 'needed',
        neededBy: pick.by,
        collision:
          match === undefined
            ? null
            : {
                targetId: match.id,
                targetName: match.name,
                match: match.id === note.id ? 'id' : 'name',
                choices: ['overwrite', 'keepBoth', 'skip'],
              },
      });
      if (note.needs !== undefined) queue.push({ kind: 'note', id: note.needs, by: note.name });
    }
    return planned;
  },
  async apply(runtime, spec, plan, choices) {
    const outcomes: CopyOutcome[] = [];
    for (const item of plan) {
      const choice: CollisionChoice | null =
        item.collision === null ? null : (choices.get(itemKey(item)) ?? 'skip');
      const targetId =
        choice === 'keepBoth' ? runtime.newId() : (item.collision?.targetId ?? item.id);
      if (choice !== 'skip') {
        const note = await runtime.store.get(
          `${projectPrefix(spec.fromProjectId)}notes/${item.id}`,
        );
        await runtime.store.batch([
          {
            type: 'put',
            key: `${projectPrefix(spec.toProjectId)}notes/${targetId}`,
            value: { ...(note as object), id: targetId },
          },
        ]);
      }
      outcomes.push({
        kind: item.kind,
        id: item.id,
        name: item.name,
        targetId,
        outcome:
          choice === null
            ? 'copied'
            : choice === 'skip'
              ? 'skipped'
              : choice === 'overwrite'
                ? 'overwritten'
                : 'keptBoth',
      });
    }
    return outcomes;
  },
};

const support: ModeProjectSupport[] = [
  {
    mode: 'movie',
    templates: [
      {
        id: 'movie.starter',
        name: 'Starter',
        summary: 'One note to begin with.',
        build: (newId) => {
          const id = newId();
          return [{ key: `notes/${id}`, value: { id, name: 'First note' } }];
        },
      },
    ],
    summarize: async (runtime, projectId) => {
      const count = (await runtime.store.list(`${projectPrefix(projectId)}notes/`)).length;
      return {
        headline: 'Notes',
        posterKeys: [],
        stages: [
          { id: 'write', name: 'Write', done: count, total: 2, note: `${String(count)} notes` },
          { id: 'empty', name: 'Empty', done: 0, total: 0, note: '' },
        ],
      };
    },
    resources: notes,
  },
  { mode: 'plain' },
];

function setup() {
  const runtime = createTestRuntime();
  const registry = new CommandRegistry({ runtime }).register(...createProjectCommands(support));
  const run = async (id: string, input: unknown, actor: Actor = user): Promise<any> => {
    const result = await registry.executeById(id, input, { actor });
    if (result.status !== 'ok') throw new Error(`${id}: ${result.status}`);
    return result.output;
  };
  const create = async (name: string, extra: Record<string, unknown> = {}) =>
    (await run('project.create', { name, mode: 'movie', ...extra })) as {
      id: string;
      name: string;
    };
  const note = async (projectId: string, id: string, name: string, needs?: string) => {
    await runtime.store.batch([
      {
        type: 'put',
        key: `${projectPrefix(projectId)}notes/${id}`,
        value: {
          id,
          name,
          file: `${projectPrefix(projectId)}notes/${id}/file`,
          ...(needs === undefined ? {} : { needs }),
        },
      },
    ]);
  };
  return { runtime, registry, run, create, note };
}

describe('the project archive', () => {
  it('round-trips files with any names and contents, and checks them', () => {
    const entries = [
      { path: 'project.json', bytes: encodeUtf8('{"a":"Ünïcødé ✓ 🎬"}') },
      { path: 'files/movie/x', bytes: new Uint8Array([0, 1, 2, 255]) },
      { path: 'files/empty', bytes: new Uint8Array() },
    ];
    const packed = writeArchive(entries, new Date(2026, 10, 20, 12, 30, 10));
    const unpacked = readArchive(packed);
    expect(unpacked.map((e) => e.path)).toEqual(entries.map((e) => e.path));
    expect(decodeUtf8(unpacked[0]?.bytes ?? new Uint8Array())).toBe('{"a":"Ünïcødé ✓ 🎬"}');
    expect([...(unpacked[1]?.bytes ?? [])]).toEqual([0, 1, 2, 255]);
    expect(crc32(encodeUtf8('123456789'))).toBe(0xcbf43926);

    const damaged = packed.slice();
    damaged[45] = (damaged[45] ?? 0) ^ 0xff;
    expect(() => readArchive(damaged)).toThrow(ArchiveError);
    expect(() => readArchive(new Uint8Array(100))).toThrow(/not a ZIP/);
    expect(() => readArchive(packed.slice(0, packed.length - 30))).toThrow(ArchiveError);
    const deflated = packed.slice();
    const deflatedView = new DataView(deflated.buffer);
    deflatedView.setUint16(deflatedView.getUint32(packed.length - 6, true) + 10, 8, true);
    expect(() => readArchive(deflated)).toThrow(/packed again/);
  });
});

describe('project management', () => {
  it('opens a project, notes when, and orders the overview by it with progress', async () => {
    const { run, create, note } = setup();
    const first = await create('First');
    const second = await create('Second');
    await note(first.id, 'n1', 'One');
    await run('project.open', { projectId: first.id });
    const overview = await run('project.overview', {});
    expect(overview.currentProjectId).toBe(first.id);
    expect(overview.projects.map((p: { name: string }) => p.name)).toEqual(['First', 'Second']);
    expect(overview.projects[0]).toMatchObject({ progress: 0.25, summary: { headline: 'Notes' } });
    expect(overview.projects[0].openedAt).not.toBeNull();
    const plain = await run('project.create', { name: 'Plain', mode: 'plain' });
    const again = await run('project.overview', {});
    expect(again.projects.find((p: { id: string }) => p.id === plain.id)).toMatchObject({
      summary: null,
      progress: 0,
    });
    expect(second.id).toBeDefined();
  });

  it('duplicates a project with its files, moving keys inside the records', async () => {
    const { run, runtime, create, note } = setup();
    const source = await create('Keeper');
    await note(source.id, 'n1', 'One');
    await runtime.blobs.put(`${projectPrefix(source.id)}notes/n1/file`, {
      bytes: new Uint8Array([7]),
      mediaType: 'image/png',
    });
    const copy = await run('project.duplicate', { projectId: source.id });
    expect(copy).toMatchObject({ name: 'Keeper (2)', mode: 'movie' });
    expect(await runtime.store.get(`${projectPrefix(copy.id)}notes/n1`)).toEqual({
      id: 'n1',
      name: 'One',
      file: `${projectPrefix(copy.id)}notes/n1/file`,
    });
    expect((await runtime.blobs.get(`${projectPrefix(copy.id)}notes/n1/file`))?.bytes).toEqual(
      new Uint8Array([7]),
    );
    const third = await run('project.duplicate', { projectId: source.id, name: 'Named' });
    expect(third.name).toBe('Named');
    const fourth = await run('project.duplicate', { projectId: source.id });
    expect(fourth.name).toBe('Keeper (3)');
  });

  it('exports to a file and imports it back as a new project, files and keys included', async () => {
    const { run, runtime, create, note } = setup();
    const source = await create('Lighthouse: the "Keeper"');
    await note(source.id, 'n1', 'One');
    await runtime.blobs.put(`${projectPrefix(source.id)}notes/n1/file`, {
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: 'video/mp4',
    });
    const exported = await run('project.export', { projectId: source.id });
    expect(exported).toMatchObject({
      fileKey: `exports/${source.id}`,
      fileName: 'Lighthouse-the-Keeper.imp.zip',
      records: 1,
      files: 1,
    });
    // As if picked on another computer.
    const file = await runtime.blobs.get(exported.fileKey);
    await runtime.blobs.put('uploads/picked-1', file ?? { bytes: new Uint8Array(), mediaType: '' });
    const imported = await run('project.import', { fileKey: 'uploads/picked-1' });
    expect(imported).toMatchObject({
      name: 'Lighthouse: the "Keeper" (2)',
      mode: 'movie',
      records: 1,
      files: 1,
    });
    expect(await runtime.store.get(`${projectPrefix(imported.id)}notes/n1`)).toMatchObject({
      file: `${projectPrefix(imported.id)}notes/n1/file`,
    });
    expect((await runtime.blobs.get(`${projectPrefix(imported.id)}notes/n1/file`))?.mediaType).toBe(
      'video/mp4',
    );
    expect(await runtime.blobs.get('uploads/picked-1')).toBeUndefined();

    const named = await run('project.import', { fileKey: exported.fileKey, name: 'Again' });
    expect(named.name).toBe('Again');
    // Deleting the project removes its waiting export too.
    await run('project.delete', { projectId: source.id });
    expect(await runtime.blobs.get(exported.fileKey)).toBeUndefined();
  });

  it('refuses files that are not project files, damaged or from an unknown mode', async () => {
    const { run, runtime, create } = setup();
    const put = async (bytes: Uint8Array) => {
      await runtime.blobs.put('uploads/bad', { bytes, mediaType: 'application/zip' });
    };
    const manifest = (value: unknown) =>
      writeArchive([{ path: 'project.json', bytes: encodeUtf8(JSON.stringify(value)) }]);
    const valid = {
      format: 'imp-project',
      version: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      project: { id: 'p', name: 'P', mode: 'movie', createdAt: '2026-01-01T00:00:00.000Z' },
      entries: [],
      files: [],
    };
    const cases: [Uint8Array | null, RegExp][] = [
      [null, /No file is stored/],
      [new Uint8Array(30), /not a ZIP/],
      [writeArchive([{ path: 'other.txt', bytes: new Uint8Array() }]), /not an Imp project/],
      [writeArchive([{ path: 'project.json', bytes: encodeUtf8('{nope') }]), /not readable/],
      [manifest({ format: 'other' }), /not an Imp project file, or it is damaged/],
      [manifest({ ...valid, version: 9 }), /newer Imp/],
      [manifest({ ...valid, project: { ...valid.project, mode: 'opera' } }), /"opera" mode/],
      [manifest({ ...valid, entries: [{ key: '../escape', value: 1 }] }), /bad key/],
      [manifest({ ...valid, entries: [{ key: 'a//b', value: 1 }] }), /bad key/],
      [manifest({ ...valid, files: [{ key: 'gone', mediaType: 'x', sizeBytes: 1 }] }), /missing/],
    ];
    for (const [bytes, error] of cases) {
      if (bytes !== null) await put(bytes);
      await expect(run('project.import', { fileKey: 'uploads/bad' })).rejects.toThrow(error);
    }
    await expect(run('project.import', { fileKey: 'settings/x' })).rejects.toThrow(/Invalid input/);
    expect((await run('project.list', {})).projects).toHaveLength(0);
    await create('Still works');
  });

  it('starts projects from shipped and saved templates, and deletes saved ones', async () => {
    const { run, runtime, create, note } = setup();
    const listed = await run('project.template.list', {});
    expect(listed.templates).toEqual([
      expect.objectContaining({ id: 'movie.starter', builtIn: true, mode: 'movie' }),
    ]);
    const started = await create('From starter', { templateId: 'movie.starter' });
    const startedNotes = await runtime.store.list(`${projectPrefix(started.id)}notes/`);
    expect(startedNotes.map((e) => e.value)).toEqual([
      { id: expect.any(String), name: 'First note' },
    ]);

    const source = await create('Source');
    await note(source.id, 'n9', 'Cast list');
    await runtime.blobs.put(`${projectPrefix(source.id)}notes/n9/file`, {
      bytes: new Uint8Array([9]),
      mediaType: 'image/png',
    });
    const saved = await run('project.template.save', {
      projectId: source.id,
      name: 'My cast',
      summary: 'The usual people.',
    });
    expect(saved).toMatchObject({ builtIn: false, sourceProjectName: 'Source', mode: 'movie' });
    // Changing the project afterwards leaves the template alone.
    await note(source.id, 'n10', 'Later');
    const fromSaved = await create('Sequel', { templateId: saved.id });
    const sequelNotes = await runtime.store.list(`${projectPrefix(fromSaved.id)}notes/`);
    expect(sequelNotes.map((e) => e.value)).toEqual([
      { id: 'n9', name: 'Cast list', file: `${projectPrefix(fromSaved.id)}notes/n9/file` },
    ]);
    expect(await runtime.blobs.get(`${projectPrefix(fromSaved.id)}notes/n9/file`)).toBeDefined();
    expect((await run('project.template.list', { mode: 'movie' })).templates).toHaveLength(2);
    expect((await run('project.template.list', { mode: 'plain' })).templates).toHaveLength(0);

    await expect(create('Wrong', { templateId: 'nope' })).rejects.toThrow(/No template/);
    await expect(
      run('project.create', { name: 'X', mode: 'plain', templateId: 'movie.starter' }),
    ).rejects.toThrow(/for movie projects/);
    await expect(
      run('project.create', { name: 'X', mode: 'plain', templateId: saved.id }),
    ).rejects.toThrow(/for movie projects/);
    await expect(run('project.template.delete', { templateId: 'movie.starter' })).rejects.toThrow(
      /cannot be deleted/,
    );
    expect(
      await run('project.template.delete', { templateId: saved.id }, agent).catch(() => 'asked'),
    ).toBe('asked');
    await run('project.template.delete', { templateId: saved.id });
    await expect(run('project.template.delete', { templateId: saved.id })).rejects.toThrow(
      /No template/,
    );
    expect(await runtime.blobs.list('templates/')).toEqual([]);
    expect(await runtime.store.list('templates/')).toEqual([]);
  });
});

describe('copying resources between projects', () => {
  it('copies at once when nothing collides, with what the picks need', async () => {
    const { run, create, note, runtime } = setup();
    const from = await create('From');
    const to = await create('To');
    await note(from.id, 'a', 'Alpha', 'b');
    await note(from.id, 'b', 'Beta');
    const listed = await run('project.resources.list', { projectId: from.id });
    expect(listed.items.map((i: { id: string }) => i.id)).toEqual(['a', 'b']);
    const copied = await run(
      'project.resources.copy',
      { fromProjectId: from.id, toProjectId: to.id, items: [{ kind: 'note', id: 'a' }] },
      agent,
    );
    expect(copied).toEqual({
      status: 'copied',
      outcomes: [
        { kind: 'note', id: 'a', name: 'Alpha', targetId: 'a', outcome: 'copied' },
        { kind: 'note', id: 'b', name: 'Beta', targetId: 'b', outcome: 'copied' },
      ],
    });
    expect(await runtime.store.list(`${projectPrefix(to.id)}notes/`)).toHaveLength(2);
  });

  it('puts collisions to the person, even when an agent asks, and only the person answers', async () => {
    const { run, create, note, runtime } = setup();
    const from = await create('From');
    const to = await create('To');
    await note(from.id, 'a', 'Alpha', 'b');
    await note(from.id, 'b', 'Beta');
    await note(from.id, 'c', 'Gamma');
    await note(to.id, 'x', 'Alpha');
    await note(to.id, 'b', 'Old beta');
    const asked = await run(
      'project.resources.copy',
      {
        fromProjectId: from.id,
        toProjectId: to.id,
        items: [
          { kind: 'note', id: 'a' },
          { kind: 'note', id: 'c' },
        ],
        suggestion: 'keepBoth',
        note: 'For the sequel.',
      },
      agent,
    );
    expect(asked).toMatchObject({
      status: 'waiting-for-person',
      collisions: [{ id: 'a' }, { id: 'b' }],
    });
    expect(asked.message).toMatch(/2 of these are already in "To"/);
    // Nothing was copied yet.
    expect(await runtime.store.get(`${projectPrefix(to.id)}notes/c`)).toBeUndefined();

    const pending = await run('project.resources.request.list', {}, agent);
    expect(pending.requests).toEqual([
      expect.objectContaining({
        id: asked.requestId,
        requestedBy: agent,
        suggestion: 'keepBoth',
        note: 'For the sequel.',
        status: 'pending',
        fromName: 'From',
        toName: 'To',
      }),
    ]);
    await expect(
      run(
        'project.resources.request.resolve',
        { requestId: asked.requestId, choices: { 'note:a': 'overwrite', 'note:b': 'skip' } },
        agent,
      ),
    ).rejects.toThrow(/Only the person decides/);
    await expect(
      run('project.resources.request.resolve', {
        requestId: asked.requestId,
        choices: { 'note:a': 'overwrite' },
      }),
    ).rejects.toThrow(/Still to decide: Beta/);

    const done = await run('project.resources.request.resolve', {
      requestId: asked.requestId,
      choices: { 'note:a': 'keepBoth', 'note:b': 'skip' },
    });
    expect(done.status).toBe('done');
    expect(done.outcomes.map((o: { outcome: string }) => o.outcome)).toEqual([
      'keptBoth',
      'copied',
      'skipped',
    ]);
    expect(await runtime.store.get(`${projectPrefix(to.id)}notes/b`)).toMatchObject({
      name: 'Old beta',
    });
    const looked = await run(
      'project.resources.request.get',
      { requestId: asked.requestId },
      agent,
    );
    expect(looked.status).toBe('done');
    expect((await run('project.resources.request.list', {})).requests).toEqual([]);
    expect(
      (await run('project.resources.request.list', { pendingOnly: false })).requests,
    ).toHaveLength(1);
    await expect(
      run('project.resources.request.resolve', { requestId: asked.requestId, cancel: true }),
    ).rejects.toThrow(/done already/);
    await expect(run('project.resources.request.get', { requestId: 'nope' })).rejects.toThrow(
      /No copy request/,
    );
  });

  it('cancels, and keeps only the recent finished requests', async () => {
    const { run, create, note } = setup();
    const from = await create('From');
    const to = await create('To');
    await note(from.id, 'a', 'Alpha');
    await note(to.id, 'a', 'Alpha');
    const ids: string[] = [];
    for (let n = 0; n < 22; n += 1) {
      const asked = await run('project.resources.copy', {
        fromProjectId: from.id,
        toProjectId: to.id,
        items: [{ kind: 'note', id: 'a' }],
      });
      ids.push(asked.requestId);
      const cancelled = await run('project.resources.request.resolve', {
        requestId: asked.requestId,
        cancel: true,
      });
      expect(cancelled.status).toBe('cancelled');
    }
    const all = (await run('project.resources.request.list', { pendingOnly: false })).requests;
    expect(all).toHaveLength(20);
    expect(all.map((r: { id: string }) => r.id)).not.toContain(ids[0]);
  });

  it('refuses copies that cannot be made', async () => {
    const { run, create } = setup();
    const a = await create('A');
    const b = await create('B');
    const plain = await run('project.create', { name: 'Plain', mode: 'plain' });
    const plain2 = await run('project.create', { name: 'Plain 2', mode: 'plain' });
    const copy = (input: Record<string, unknown>) =>
      run('project.resources.copy', {
        fromProjectId: a.id,
        toProjectId: b.id,
        items: [{ kind: 'note', id: 'x' }],
        ...input,
      });
    await expect(copy({ toProjectId: a.id })).rejects.toThrow(/two different projects/);
    await expect(copy({ toProjectId: plain.id })).rejects.toThrow(/one mode/);
    await expect(copy({ fromProjectId: plain.id, toProjectId: plain2.id })).rejects.toThrow(
      /nothing that can be copied/,
    );
    await expect(copy({ items: [{ kind: 'film', id: 'x' }] })).rejects.toThrow(
      /Kinds: board, note, pin, tack/,
    );
    await expect(copy({ items: [{ kind: 'pin', id: 'x' }] })).rejects.toThrow(/needs a board/);
    await expect(copy({ items: [{ kind: 'tack', id: 'x' }] })).rejects.toThrow(/needs a place/);
    expect(await run('project.resources.list', { projectId: plain.id })).toEqual({
      kinds: [],
      items: [],
    });
  });
});
