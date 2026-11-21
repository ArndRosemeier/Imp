/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions --
 * Commands run by id answer with untyped output; these tests read it loosely and assert on it.
 */
import { CommandRegistry, createProjectCommands, projectPrefix, settingsCommands } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { createFakeProvider } from '@imp/providers/testing';
import { createWorldCommands } from '@imp/world';
import { describe, expect, it } from 'vitest';
import { createMovieMode, stillTimes, timecode, type FrameGrabber } from '../src/index.js';

const user = { kind: 'user', id: 'arnd' } as const;
const editor = { kind: 'agent', id: 'ed', role: 'film-editor' } as const;
const coordinator = { kind: 'agent', id: 'co', role: 'coordinator' } as const;
type Actor = typeof user | typeof editor | typeof coordinator;

/** A scene of three ready shots of four seconds; the second has a line of Mara's over a silent clip. */
async function setup(frameGrabber?: FrameGrabber) {
  const runtime = createTestRuntime();
  const provider = createFakeProvider({});
  const mode = createMovieMode(
    frameGrabber === undefined ? { provider } : { provider, frameGrabber },
  );
  const registry = new CommandRegistry({ runtime }).register(
    ...createProjectCommands([{ mode: mode.id, ...mode.project }]),
    ...settingsCommands,
    ...mode.commands,
    ...createWorldCommands({ provider }),
  );
  const run = async (id: string, input: object, actor: Actor = user): Promise<any> => {
    const result = await registry.executeById(id, input, { actor, approved: true });
    if (result.status !== 'ok') throw new Error(`${id}: ${result.status}`);
    return result.output;
  };
  const { id: projectId } = await run('project.create', { name: 'Keeper', mode: 'movie' });
  const p = { projectId };
  const mara = await run('movie.character.create', { ...p, name: 'Mara', part: 'lead' });
  const scene = await run('movie.scene.create', { ...p, heading: 'INT. LAMP ROOM - NIGHT' });
  const shots = [];
  for (const description of ['Stairs.', 'Mara at the lamp.', 'The beam turns.']) {
    shots.push(await run('movie.shot.create', { ...p, sceneId: scene.id, description }));
  }
  const speaking = shots[1];
  await run('movie.shot.update', {
    ...p,
    sceneId: scene.id,
    shotId: speaking.id,
    speakerId: mara.id,
    line: 'Hold the light!',
  });
  for (const [index, shot] of shots.entries()) {
    const key = `${projectPrefix(projectId)}movie/shots/${scene.id}/${shot.id}`;
    const stored = (await runtime.store.get(key)) as Record<string, unknown>;
    const silent = index === 1;
    await runtime.blobs.put(`${key}/clip`, {
      bytes: new Uint8Array([index]),
      mediaType: 'video/mp4',
    });
    await runtime.store.batch([
      {
        type: 'put',
        key,
        value: {
          ...stored,
          clip: {
            status: 'ready',
            jobId: 'j',
            blobKey: `${key}/clip`,
            mediaType: 'video/mp4',
            prompt: 'p',
            model: 'm',
            portraits: 0,
            progress: null,
            error: null,
            durationSeconds: 4,
            silent,
            costUsd: 0.1,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          dialogue: silent
            ? {
                blobKey: `${key}/dialogue`,
                mediaType: 'audio/mpeg',
                line: 'Hold the light!',
                direction: '',
                model: 'm',
                durationSeconds: 1.5,
                costUsd: 0,
                createdAt: '2026-01-01T00:00:00.000Z',
              }
            : null,
        },
      },
    ]);
  }
  const at = { projectId, sceneId: scene.id };
  const cut = async (actor: Actor = user, version?: 'cut' | 'draft') =>
    run('movie.edit.get', { ...at, ...(version === undefined ? {} : { version }) }, actor);
  return { runtime, registry, run, at, cut, shots, mara, scene, projectId };
}

describe('agent drafts', () => {
  it('keeps an agent’s edits apart from the cut until the person keeps them', async () => {
    const { run, at, cut, shots } = await setup();
    const first = shots[0].id;
    await run('movie.edit.item.set', { ...at, itemId: first, trimStartSeconds: 1 }, editor);

    const seen = await cut();
    expect(seen.version).toBe('cut');
    expect(seen.items[0].trimStartSeconds).toBe(0);
    expect(seen.draft).toMatchObject({
      changes: 1,
      authors: [editor].map(({ id, role }) => ({ id, role })),
    });
    const proposed = await cut(editor);
    expect(proposed.version).toBe('draft');
    expect(proposed.items[0].trimStartSeconds).toBe(1);
    expect(proposed.canUndo).toBe(true);
    expect((await cut(user, 'draft')).items[0].trimStartSeconds).toBe(1);

    // The agent steps through its own work only.
    expect(await run('movie.edit.undo', at, editor)).toEqual({ done: true });
    expect((await cut(editor)).items[0].trimStartSeconds).toBe(0);
    expect(await run('movie.edit.redo', at, editor)).toEqual({ done: true });
    expect((await cut(editor)).items[0].trimStartSeconds).toBe(1);
    expect(await run('movie.edit.redo', at, editor)).toEqual({ done: false });

    const kept = await run('movie.edit.draft.keep', at);
    expect(kept).toEqual({ kept: 1, remaining: 0 });
    const after = await cut();
    expect(after.items[0].trimStartSeconds).toBe(1);
    expect(after.draft).toBeNull();
    // Keeping was one step of the person's undo.
    await run('movie.edit.undo', at);
    expect((await cut()).items[0].trimStartSeconds).toBe(0);
  });

  it('describes changes, flags conflicts, and keeps or rejects them one by one', async () => {
    const { run, at, cut, shots } = await setup();
    await run('movie.edit.item.remove', { ...at, itemId: shots[2].id }, editor);
    await run('movie.edit.title.add', { ...at, text: 'Lisbon, 1974', toIndex: 0 }, editor);
    await run('movie.edit.item.set', { ...at, itemId: shots[1].id, fadeOutSeconds: 1 }, editor);
    // The person goes on editing the cut meanwhile.
    await run('movie.edit.item.set', { ...at, itemId: shots[1].id, dialogueVolume: 0.5 });
    await run('movie.edit.item.set', { ...at, itemId: shots[0].id, fadeInSeconds: 2 });

    const draft = await run('movie.edit.draft.get', at);
    expect(draft.exists).toBe(true);
    expect(draft.cutChanged).toBe(true);
    const summaries = draft.changes.map((change: any) => change.summary);
    expect(summaries).toEqual([
      expect.stringMatching(/^Added title card "Lisbon, 1974" at 0:00\.00$/),
      expect.stringMatching(/^Changed shot "Mara at the lamp\.": fade out 0 → 1$/),
      expect.stringMatching(/^Removed shot "The beam turns\." from 0:08\.00$/),
    ]);
    const changed = draft.changes.find((change: any) => change.kind === 'changed');
    expect(changed.conflict).toBe(true);
    expect(draft.changes.find((change: any) => change.kind === 'added').conflict).toBe(false);

    // Nobody keeps their own proposal; another agent may, on the person's word.
    await expect(run('movie.edit.draft.keep', at, editor)).rejects.toThrow(/yourself/);
    await expect(run('movie.edit.draft.keep', { ...at, changeIds: ['nope'] })).rejects.toThrow(
      /No proposed change "nope"/,
    );
    const title = draft.changes[0].id;
    expect(await run('movie.edit.draft.keep', { ...at, changeIds: [title] }, coordinator)).toEqual({
      kept: 1,
      remaining: 2,
    });
    let live = await cut();
    expect(live.items.map((item: any) => item.kind)).toEqual(['title', 'shot', 'shot', 'shot']);
    // The person's own edits survive.
    expect(live.items[1].fadeInSeconds).toBe(2);
    expect(live.items[2].dialogueVolume).toBe(0.5);

    expect(await run('movie.edit.draft.reject', { ...at, changeIds: [changed.id] })).toEqual({
      rejected: 1,
      remaining: 1,
    });
    expect(
      (await cut(editor)).items.find((item: any) => item.itemId === shots[1].id).fadeOutSeconds,
    ).toBe(0);
    const removal = (await run('movie.edit.draft.get', at)).changes[0];
    expect(removal.kind).toBe('removed');
    expect(await run('movie.edit.draft.keep', { ...at, changeIds: [removal.id] })).toEqual({
      kept: 1,
      remaining: 0,
    });
    live = await cut();
    expect(live.items).toHaveLength(3);
    expect(live.draft).toBeNull();
    expect((await run('movie.edit.draft.get', at)).exists).toBe(false);
  });

  it('lets an agent take back its own proposals and the person discard the rest', async () => {
    const { run, at, cut, shots, mara, projectId } = await setup();
    await run('movie.character.update', { projectId, characterId: mara.id, ownLane: true });
    await run('movie.edit.line.add', { ...at, characterId: mara.id, text: 'Years ago.' }, editor);
    await run(
      'movie.edit.sound.place',
      { ...at, source: 'dialogue', shotId: shots[1].id, startSeconds: 2 },
      editor,
    );
    await run('movie.edit.item.move', { ...at, itemId: shots[0].id, toIndex: 2 }, editor);
    const draft = await run('movie.edit.draft.get', at);
    expect(draft.changes.map((change: any) => change.summary)).toEqual([
      expect.stringMatching(/^Moved shot "Stairs\." to place 3, 0:08\.00$/),
      expect.stringMatching(/^Placed Dialogue of shot 2 at 0:02\.00$/),
      expect.stringMatching(/^Added a line of Mara "Years ago\." at 0:00\.00$/),
    ]);
    const moved = draft.changes[0].id;
    expect(await run('movie.edit.draft.reject', { ...at, changeIds: [moved] }, editor)).toEqual({
      rejected: 1,
      remaining: 2,
    });
    expect((await cut(editor)).items.map((item: any) => item.itemId)).toEqual(
      shots.map((s) => s.id),
    );
    // The rejection is a step of the agent's own undo.
    await run('movie.edit.undo', at, editor);
    expect((await cut(editor)).items[2].itemId).toBe(shots[0].id);

    // Discarding needs the person's approval when an agent asks, and cannot be undone.
    const asked = await (async () => {
      const { registry } = await setup();
      return registry.executeById('movie.edit.draft.discard', at, { actor: editor });
    })();
    expect(asked.status).toBe('needs-approval');
    expect(await run('movie.edit.draft.discard', at)).toEqual({ discarded: 3 });
    expect(await run('movie.edit.draft.discard', at)).toEqual({ discarded: 0 });
    expect((await cut()).draft).toBeNull();
    await expect(run('movie.edit.draft.reject', { ...at, changeIds: ['x'] })).rejects.toThrow(
      /No changes are proposed/,
    );
  });

  it('lets agents edit the cut directly when the setting says so', async () => {
    const { run, at, cut, shots } = await setup();
    await run('settings.set', { key: 'edit.agent-drafts', value: false });
    await run('movie.edit.item.set', { ...at, itemId: shots[0].id, trimEndSeconds: 1 }, editor);
    const seen = await cut();
    expect(seen.items[0].trimEndSeconds).toBe(1);
    expect(seen.draft).toBeNull();
    expect((await cut(editor)).canUndo).toBe(true);
    await run('movie.edit.undo', at, editor);
    expect((await cut()).items[0].trimEndSeconds).toBe(0);
  });

  it('gives an agent with no draft nothing of the person’s to undo', async () => {
    const { run, at, cut } = await setup();
    await run('movie.edit.title.add', { ...at, text: 'Hello' });
    const seen = await cut(editor);
    expect(seen.version).toBe('cut');
    expect(seen.canUndo).toBe(false);
    expect(await run('movie.edit.undo', at, editor)).toEqual({ done: false });
    expect((await cut()).items).toHaveLength(4);
  });
});

describe('range requests', () => {
  it('stores what was asked about which stretch, and marks changes outside it', async () => {
    const { run, at, shots } = await setup();
    const asked = await run('movie.edit.request', {
      ...at,
      instruction: 'This drags.',
      itemIds: [shots[1].id],
    });
    expect(asked.request).toMatchObject({
      instruction: 'This drags.',
      fromSeconds: 4,
      toSeconds: 8,
      itemIds: [shots[1].id],
    });
    expect(asked.context).toContain('0:04.00-0:08.00 of the scene timeline, items 2');
    expect(asked.context).toContain('movie.edit.range');
    let draft = await run('movie.edit.draft.get', at);
    expect(draft).toMatchObject({ exists: true, changes: [], authors: [] });

    await run('movie.edit.item.set', { ...at, itemId: shots[1].id, trimEndSeconds: 1 }, editor);
    await run('movie.edit.title.add', { ...at, text: 'The End' }, editor);
    draft = await run('movie.edit.draft.get', at);
    expect(draft.request.instruction).toBe('This drags.');
    expect(draft.changes.map((change: any) => change.outside)).toEqual([false, true]);

    // A new request on the same draft replaces the question and keeps the work.
    const whole = await run('movie.edit.request', { ...at, instruction: 'Tighter overall.' });
    expect(whole.request).toMatchObject({ fromSeconds: null, toSeconds: null, itemIds: [] });
    expect(whole.context).toContain('the whole scene');
    expect(whole.context).toContain('movie.edit.edl');
    draft = await run('movie.edit.draft.get', at);
    expect(draft.changes.map((change: any) => change.outside)).toEqual([false, false]);
  });

  it('refuses ranges that make no sense', async () => {
    const { run, at } = await setup();
    await expect(
      run('movie.edit.request', { ...at, instruction: 'x', fromSeconds: 2 }),
    ).rejects.toThrow(/both/);
    await expect(
      run('movie.edit.request', { ...at, instruction: 'x', fromSeconds: 3, toSeconds: 2 }),
    ).rejects.toThrow(/after/);
    await expect(
      run('movie.edit.request', { ...at, instruction: 'x', itemIds: ['ghost'] }),
    ).rejects.toThrow(/not in this cut/);
    await expect(run('movie.edit.range', { ...at, fromSeconds: 3, toSeconds: 3 })).rejects.toThrow(
      /after/,
    );
  });
});

describe('what agents read', () => {
  it('times every spoken line and writes the cut out as an edit decision list', async () => {
    const { run, at, cut, shots, mara, projectId } = await setup();
    await run('movie.character.update', { projectId, characterId: mara.id, ownLane: true });
    await run('movie.edit.line.add', {
      ...at,
      characterId: mara.id,
      text: 'Years ago.',
      startSeconds: 9,
    });
    await run('movie.edit.item.set', {
      ...at,
      itemId: shots[1].id,
      trimStartSeconds: 0.5,
      fadeInSeconds: 0.5,
    });
    const wind = await run('movie.sound.create', {
      projectId,
      sceneId: at.sceneId,
      kind: 'effect',
      name: 'Wind',
      description: 'Howling wind.',
    });
    await run('movie.edit.sound.place', { ...at, soundId: wind.id, loop: true, volume: 0.4 });
    await run('movie.edit.sound.place', {
      ...at,
      source: 'dialogue',
      shotId: shots[1].id,
      startSeconds: 10,
      trimStartSeconds: 0.5,
    });
    await run('movie.edit.sound.place', {
      ...at,
      source: 'clip',
      shotId: shots[0].id,
      startSeconds: 1,
    });

    const seen = await cut();
    expect(seen.spoken).toEqual([
      expect.objectContaining({
        source: 'shot',
        who: 'Mara',
        text: 'Hold the light!',
        startsAtSeconds: 4,
        durationSeconds: 1,
        recorded: true,
      }),
      expect.objectContaining({
        source: 'lane',
        who: 'Mara',
        text: 'Years ago.',
        startsAtSeconds: 9,
        durationSeconds: 0,
        recorded: false,
      }),
      expect.objectContaining({
        source: 'placement',
        who: 'Mara',
        startsAtSeconds: 10,
        durationSeconds: 1,
      }),
    ]);

    const { text } = await run('movie.edit.edl', at);
    expect(text).toContain('SCENE 1 · INT. LAMP ROOM - NIGHT · 0:11.50');
    expect(text).toContain(
      `002  0:04.00-0:07.50  shot "Mara at the lamp."  clip 0.50-4.00 of 4.00, fade in 0.5 [${shots[1].id}]`,
    );
    expect(text).toContain(
      `001  0:00.00-0:04.00  shot "Stairs."  clip 0.00-4.00 of 4.00, clip sound 1.00 [${shots[0].id}]`,
    );
    expect(text).toContain('0:04.00-0:05.00  MARA: "Hold the light!" [shot');
    expect(text).toContain('MARA: "Years ago." (not recorded)');
    expect(text).toContain('Wind (effect)  volume 0.40, loops to the end');

    const range = await run('movie.edit.range', { ...at, fromSeconds: 4.5, toSeconds: 6 });
    expect(range.version).toBe('cut');
    expect(range.items.map((item: any) => item.itemId)).toEqual([shots[1].id]);
    expect(range.spoken.map((line: any) => line.source)).toEqual(['shot']);
    expect(range.sounds.map((sound: any) => sound.name)).toEqual(['Wind']);
    expect(range.edl).toContain('showing 0:04.50-0:06.00');
    expect(range.edl).not.toContain('Stairs');
    expect(range.edl).not.toContain('NOT IN THE FILM YET');
  });

  it('lists the pieces that are not in the film yet, and reads the draft on request', async () => {
    const { run, at, runtime, projectId, shots } = await setup();
    const key = `${projectPrefix(projectId)}movie/shots/${at.sceneId}/${shots[2].id}`;
    const stored = (await runtime.store.get(key)) as Record<string, unknown>;
    await runtime.store.batch([{ type: 'put', key, value: { ...stored, clip: null } }]);
    await run(
      'movie.edit.title.add',
      { ...at, text: 'A very long title that goes on and on and on past the end' },
      editor,
    );
    const live = (await run('movie.edit.edl', at)).text;
    expect(live).toContain(
      `NOT IN THE FILM YET\n003  shot "The beam turns.": no_clip [${shots[2].id}]`,
    );
    expect(live).not.toContain('title card');
    const proposed = await run('movie.edit.edl', { ...at, version: 'draft' });
    expect(proposed.version).toBe('draft');
    expect(proposed.text).toContain(
      'title card "A very long title that goes on and on and on pa…"',
    );
    expect(timecode(65.255)).toBe('1:05.26');
    expect(timecode(-1)).toBe('0:00.00');
  });
});

describe('stills for agents', () => {
  /** A grabber that answers with a picture naming the time, and none past its reach. */
  function fakeGrabber(reach = 3.9) {
    const calls: number[][] = [];
    const grab: FrameGrabber = (_video, atSeconds, width) => {
      calls.push([...atSeconds]);
      return Promise.resolve(
        atSeconds.map((seconds) =>
          seconds > reach
            ? undefined
            : {
                bytes: Uint8Array.from(`${String(width)}@${String(seconds)}`, (c) =>
                  c.charCodeAt(0),
                ),
                mediaType: 'image/jpeg',
              },
        ),
      );
    };
    return { grab, calls };
  }

  it('spreads stills over a piece', () => {
    expect(stillTimes(0, 4, 3)).toEqual([0.04, 1.97, 3.9]);
    expect(stillTimes(1, 1.1, 3)).toEqual([1.04]);
    expect(stillTimes(0, 4, 1)).toEqual([0.04]);
  });

  it('takes stills of the trimmed pieces, keeps them, and shows them to the agent', async () => {
    const { grab, calls } = fakeGrabber();
    const { run, at, shots, runtime } = await setup(grab);
    await run('movie.edit.item.set', { ...at, itemId: shots[1].id, trimStartSeconds: 1 });
    await run('movie.edit.title.add', { ...at, text: 'End' });
    const read = await run('movie.edit.frames', { ...at, perItem: 2 }, editor);
    expect(read.version).toBe('cut');
    expect(read.note).toBe('');
    expect(
      read.stills.map((still: any) => [still.index, still.clipSeconds, still.sceneSeconds]),
    ).toEqual([
      [1, 0.04, 0.04],
      [1, 3.9, 3.9],
      [2, 1.04, 4.04],
      [2, 3.9, 6.9],
      [3, 0.04, 7.04],
      [3, 3.9, 10.9],
    ]);
    expect(read.attachments).toHaveLength(6);
    expect(read.attachments[0]).toMatchObject({ mediaType: 'image/jpeg', key: read.stills[0].key });
    expect(
      String.fromCharCode(...((await runtime.blobs.get(read.stills[2].key))?.bytes ?? [])),
    ).toBe('384@1.04');
    expect(calls).toHaveLength(3);

    // A second look costs no decoding.
    await run('movie.edit.frames', { ...at, perItem: 2 });
    expect(calls).toHaveLength(3);

    const one = await run('movie.edit.frames', { ...at, itemIds: [shots[0].id], perItem: 3 });
    expect(one.stills.map((still: any) => still.clipSeconds)).toEqual([0.04, 1.97, 3.9]);
    const range = await run('movie.edit.range', { ...at, fromSeconds: 4.5, toSeconds: 5 });
    expect(range.stills.map((still: any) => still.index)).toEqual([2, 2, 2]);
    expect(range.attachments).toHaveLength(3);
    const blind = await run('movie.edit.range', {
      ...at,
      fromSeconds: 4.5,
      toSeconds: 5,
      stills: false,
    });
    expect(blind.attachments).toEqual([]);
  });

  it('says why stills are missing', async () => {
    const { grab } = fakeGrabber(3.8);
    const { run, at, shots } = await setup(grab);
    expect((await run('movie.edit.frames', { ...at, fromSeconds: 30, toSeconds: 40 })).note).toBe(
      'No piece of picture lies there.',
    );
    // Stills past the grabber's reach fail and are counted.
    const late = await run('movie.edit.frames', { ...at, itemIds: [shots[0].id], perItem: 5 });
    expect(late.stills).toHaveLength(4);
    expect(late.note).toBe('1 stills could not be read from their clips.');

    const { run: runBare, at: bare } = await setup();
    const none = await runBare('movie.edit.frames', bare);
    expect(none).toMatchObject({ stills: [], attachments: [] });
    expect(none.note).toMatch(/no video decoder/);
  });

  it('has nothing to show for pieces without a ready clip, and survives a failing decoder', async () => {
    const { run, at, runtime, projectId, shots } = await setup(() =>
      Promise.reject(new Error('broken')),
    );
    const key = `${projectPrefix(projectId)}movie/shots/${at.sceneId}/${shots[0].id}`;
    const stored = (await runtime.store.get(key)) as Record<string, unknown>;
    await runtime.store.batch([{ type: 'put', key, value: { ...stored, clip: null } }]);
    const broken = await run('movie.edit.frames', { ...at, itemIds: [shots[1].id], perItem: 1 });
    expect(broken.note).toBe('1 stills could not be read from their clips.');
    await runtime.blobs.delete(`${key.replace(shots[0].id, shots[2].id)}/clip`);
    const gone = await run('movie.edit.frames', { ...at, itemIds: [shots[2].id], perItem: 1 });
    expect(gone.note).toBe('1 stills could not be read from their clips.');
  });
});
