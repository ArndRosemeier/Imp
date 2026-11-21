import { CommandRegistry, projectCommands } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { createFakeProvider } from '@imp/providers/testing';
import { describe, expect, it } from 'vitest';
import { createMovieMode, critic, planFilm, slateText } from '../src/index.js';

const user = { kind: 'user', id: 'arnd' } as const;
const editor = { kind: 'agent', id: 'fe', role: 'film-editor' } as const;
type Who = typeof user | typeof editor;

const clip = (blobKey: string) => ({
  status: 'ready',
  jobId: 'j',
  blobKey,
  mediaType: 'video/mp4',
  prompt: '',
  model: 'm',
  progress: null,
  error: null,
  durationSeconds: 4,
  silent: true,
  costUsd: null,
  createdAt: new Date(0).toISOString(),
});

async function setup() {
  const runtime = createTestRuntime();
  const mode = createMovieMode({ provider: createFakeProvider({}) });
  const registry = new CommandRegistry({ runtime }).register(...projectCommands, ...mode.commands);
  let projectId = '';
  const run = async (
    id: string,
    input: Record<string, unknown>,
    actor: Who = user,
  ): Promise<Record<string, unknown>> => {
    const result = await registry.executeById(id, { projectId, ...input }, { actor });
    if (result.status !== 'ok') throw new Error(`${id}: ${JSON.stringify(result)}`);
    return result.output as Record<string, unknown>;
  };
  projectId = ((await run('project.create', { name: 'Storm', mode: 'movie' })) as { id: string })
    .id;
  const sceneId = ((await run('movie.scene.create', { heading: 'INT. LAMP' })) as { id: string })
    .id;
  const base = `projects/${projectId}/movie/`;
  const shot = (id: string, position: number) => ({
    id,
    sceneId,
    position,
    description: `Shot ${id}`,
    characterIds: [],
    performance: '',
    speakerId: null,
    line: '',
    delivery: '',
    clip: clip(`clip/${id}`),
  });
  await runtime.store.batch([
    { type: 'put', key: `${base}shots/${sceneId}/a`, value: shot('a', 1) },
    { type: 'put', key: `${base}shots/${sceneId}/b`, value: shot('b', 2) },
  ]);
  const edit = (id: string, input: Record<string, unknown>, actor: Who = user) =>
    run(`movie.edit.${id}`, { sceneId, ...input }, actor);
  return { runtime, mode, run, edit, sceneId, projectId: () => projectId, base };
}

interface CutItemView {
  itemId: string;
  shotId: string;
  label: string;
  placeholder: boolean;
  pickupReason: string | null;
  durationSeconds: number;
  ownSound: boolean;
}
interface Listed {
  pickups: {
    shotId: string;
    reason: string;
    status: string;
    requestedBy: string;
    inCut: { index: number }[];
  }[];
}

describe('pickup shots', () => {
  it('stand in the cut as a slate until their clip arrives, then take its place', async () => {
    const { runtime, run, edit, sceneId, base, projectId } = await setup();
    const asked = (await edit('pickup.request', {
      toIndex: 1,
      description: 'Close on Mara, listening',
      reason: 'covers the jump in her answer',
      seconds: 2.5,
    })) as { shot: { id: string; position: number; pickup: unknown }; item: { id: string } };
    expect(asked.shot.position).toBe(3);
    expect(asked.shot.pickup).toMatchObject({
      reason: 'covers the jump in her answer',
      seconds: 2.5,
      requestedBy: 'person',
    });
    const cut = (await edit('get', {})) as { items: CutItemView[]; totalSeconds: number };
    expect(cut.items.map((item) => item.shotId)).toEqual(['a', asked.shot.id, 'b']);
    expect(cut.items[1]).toMatchObject({
      itemId: asked.item.id,
      placeholder: true,
      pickupReason: 'covers the jump in her answer',
      durationSeconds: 2.5,
      ownSound: false,
    });
    expect(cut.totalSeconds).toBe(10.5);
    const edl = (await edit('edl', {})) as { text: string };
    expect(edl.text).toContain('PICKUP TO COME, slate until its clip is ready: covers the jump');

    // The film keeps its timing: the slate is drawn like a card.
    const plan = await planFilm(runtime, 'test', projectId(), [sceneId]);
    const slate = plan.pictures[1];
    expect(slate).toMatchObject({ kind: 'title', startSeconds: 4, durationSeconds: 2.5 });
    expect(slate !== undefined && 'text' in slate ? slate.text : '').toBe(
      'Pickup shot to come\nClose on Mara, listening',
    );
    expect(plan.notReady).toEqual([{ sceneId, index: 2, state: 'no_clip' }]);

    const listed = (await run('movie.edit.pickup.list', {})) as unknown as Listed;
    expect(listed.pickups).toMatchObject([
      { shotId: asked.shot.id, status: 'requested', inCut: [{ index: 2 }] },
    ]);

    // The clip arrives: it plays at its own length and the pickup is done.
    const stored = (await runtime.store.get(`${base}shots/${sceneId}/${asked.shot.id}`)) as object;
    await runtime.store.batch([
      {
        type: 'put',
        key: `${base}shots/${sceneId}/${asked.shot.id}`,
        value: { ...stored, clip: { ...clip('clip/new'), status: 'pending', blobKey: null } },
      },
    ]);
    expect(
      ((await run('movie.edit.pickup.list', { open: true })) as unknown as Listed).pickups[0]
        ?.status,
    ).toBe('making');
    // While it is being made, it still stands as its slate.
    expect(((await edit('get', {})) as { totalSeconds: number }).totalSeconds).toBe(10.5);
    await runtime.store.batch([
      {
        type: 'put',
        key: `${base}shots/${sceneId}/${asked.shot.id}`,
        value: { ...stored, clip: clip('clip/new') },
      },
    ]);
    const after = (await edit('get', {})) as { items: CutItemView[]; totalSeconds: number };
    expect(after.items[1]).toMatchObject({ placeholder: false, durationSeconds: 4 });
    expect(after.totalSeconds).toBe(12);
    expect(
      ((await run('movie.edit.pickup.list', { open: true })) as unknown as Listed).pickups,
    ).toEqual([]);
    expect(
      ((await run('movie.edit.pickup.list', { sceneId })) as unknown as Listed).pickups[0]?.status,
    ).toBe('ready');
  });

  it('undo takes the slate out of a cut that still followed the shots', async () => {
    const { run, edit } = await setup();
    const asked = (await edit('pickup.request', {
      description: 'Insert: the lamp flickers',
      reason: 'a breath before the storm',
    })) as { shot: { id: string } };
    expect(((await edit('get', {})) as { items: CutItemView[] }).items).toHaveLength(3);
    await edit('undo', {});
    const cut = (await edit('get', {})) as { items: CutItemView[] };
    // The cut it had, not the shots in order, which would now hold the pickup at the end.
    expect(cut.items.map((item) => item.shotId)).toEqual(['a', 'b']);
    // The shot stays asked for, and is no longer in the cut.
    expect((await run('movie.edit.pickup.list', {})) as unknown as Listed).toMatchObject({
      pickups: [{ shotId: asked.shot.id, inCut: [] }],
    });
  });

  it('are a proposal when an agent asks, with the shot made at once', async () => {
    const { run, edit } = await setup();
    const asked = (await edit(
      'pickup.request',
      { toIndex: 0, description: 'Wide of the lighthouse', reason: 'establish the place' },
      editor,
    )) as { shot: { id: string } };
    // The person's cut is unchanged until they keep the proposal.
    expect(
      ((await edit('get', {})) as { items: CutItemView[] }).items.map((item) => item.shotId),
    ).toEqual(['a', 'b']);
    const draft = (await edit('get', {}, editor)) as { items: CutItemView[] };
    expect(draft.items.map((item) => item.shotId)).toEqual([asked.shot.id, 'a', 'b']);
    const listed = (await run('movie.edit.pickup.list', {})) as unknown as Listed;
    expect(listed.pickups[0]).toMatchObject({ requestedBy: 'film-editor', inCut: [] });
    await expect(edit('pickup.request', { description: 'x', reason: '' })).rejects.toThrow(
      /Invalid input/,
    );
  });

  it('write a short slate', () => {
    expect(slateText('')).toBe('Pickup shot to come');
    expect(slateText('  Close   on   Tom ')).toBe('Pickup shot to come\nClose on Tom');
    const long = slateText('word '.repeat(40));
    expect(long.split('\n')[1]?.length).toBeLessThanOrEqual(90);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('the critic', () => {
  it('may read the film and write markers, and nothing else', async () => {
    const { mode } = await setup();
    expect(mode.roles.map((role) => role.id)).toContain('critic');
    const prefixes = critic.scope.prefixes ?? [];
    const effects = critic.scope.effects ?? [];
    const reachable = mode.commands.filter(
      (command) =>
        prefixes.some((prefix) => command.id.startsWith(prefix)) &&
        effects.includes(command.effect),
    );
    const writes = reachable.filter((command) => command.effect !== 'read');
    expect(writes.map((command) => command.id).sort()).toEqual([
      'movie.edit.marker.add',
      'movie.edit.marker.remove',
      'movie.edit.marker.set',
    ]);
    for (const id of ['movie.edit.edl', 'movie.edit.frames', 'movie.edit.film.edl', 'media.view']) {
      expect(prefixes.some((prefix) => id.startsWith(prefix))).toBe(true);
    }
    expect(reachable.map((command) => command.id)).toContain('movie.edit.marker.list');
  });
});
