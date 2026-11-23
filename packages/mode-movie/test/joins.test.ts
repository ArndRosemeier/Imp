/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return --
 * Commands run by id answer with untyped output; these tests read it loosely and assert on it.
 */
import { CommandRegistry, createProjectCommands, settingsCommands } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { createFakeProvider } from '@imp/providers/testing';
import { createWorldCommands } from '@imp/world';
import { describe, expect, it } from 'vitest';
import { createMovieMode, type FrameGrabber } from '../src/index.js';

const user = { kind: 'user', id: 'arnd' } as const;
const editor = { kind: 'agent', id: 'ed', role: 'film-editor' } as const;

/** The last frame of a clip: a picture that says which clip it came from. */
const grabbed: { video: number; at: readonly number[] }[] = [];
const grab: FrameGrabber = (video, atSeconds) => {
  grabbed.push({ video: video.bytes[0] ?? -1, at: atSeconds });
  return Promise.resolve(
    atSeconds.map(() => ({
      bytes: new Uint8Array([200, video.bytes[0] ?? 0]),
      mediaType: 'image/jpeg',
    })),
  );
};

async function setup() {
  const runtime = createTestRuntime();
  const provider = createFakeProvider({});
  const mode = createMovieMode({
    provider,
    frameGrabber: grab,
    // Painted frames come back as WebP; video models take PNG.
    frameImage: (image) => Promise.resolve({ bytes: image.bytes, mediaType: 'image/png' }),
  });
  const registry = new CommandRegistry({ runtime }).register(
    ...createProjectCommands([{ mode: mode.id, ...mode.project }]),
    ...settingsCommands,
    ...mode.commands,
    ...createWorldCommands({ provider }),
  );
  /** A call that may be refused: the refusal comes back as a failure with its message. */
  const attempt = async (
    id: string,
    input: object,
    actor: typeof user | typeof editor = user,
  ): Promise<{ status: string } & Record<string, any>> => {
    try {
      return await registry.executeById(id, input, { actor, approved: true });
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
  };
  const run = async (id: string, input: object, actor: typeof user | typeof editor = user) => {
    const result = await registry.executeById(id, input, { actor, approved: true });
    if (result.status !== 'ok') throw new Error(`${id}: ${result.status}`);
    return result.output as any;
  };
  const { id: projectId } = await run('project.create', { name: 'Keeper', mode: 'movie' });
  await run('settings.set', { key: 'video.model', value: 'vendor/clips' });
  await run('settings.set', { key: 'images.model', value: 'vendor/painter' });
  const scene = await run('movie.scene.create', { projectId, heading: 'INT. LAMP ROOM - DUSK' });
  const at = (shotId: string) => ({ projectId, sceneId: scene.id, shotId });
  const add = (fields: object) =>
    run('movie.shot.create', { projectId, sceneId: scene.id, ...fields });
  const ready = async (shotId: string) => {
    await run('movie.shot.clip.check', at(shotId));
    return (await run('movie.shot.clip.check', at(shotId))).clip;
  };
  return { run, attempt, provider, projectId, scene, at, add, ready };
}

const message = (result: { status: string } & Record<string, any>): string =>
  JSON.stringify(result);

describe('shots that join', () => {
  it('chains a continuing shot to the clip before and matches a cut on action', async () => {
    const { run, attempt, provider, projectId, scene, at, add, ready } = await setup();
    const walk = await add({
      description: 'Mara walks to the window.',
      performance: 'Three slow steps, then her hand on the glass.',
      lengthSeconds: 3,
    });
    const turn = await add({
      description: 'Mara at the window.',
      performance: 'She turns her head toward the door.',
      join: 'continues',
      cutReason: 'the same take, the action goes on',
      lengthSeconds: 3,
    });
    const face = await add({
      description: 'Close on Mara.',
      performance: 'Her eyes find the door.',
      join: 'action',
      cutReason: 'on her turn',
    });

    // A continuing shot waits for the clip it carries on from, before anything is spent.
    const early = await attempt('movie.shot.clip.generate', at(turn.id));
    expect(early.status).not.toBe('ok');
    expect(message(early)).toContain('Make the clip of shot 1 first');
    expect(provider.videoRequests).toHaveLength(0);
    // It needs no key frame of its own, and a cut on action needs the end of the shot before.
    expect(message(await attempt('movie.shot.frame.generate', at(turn.id)))).toContain(
      'needs no first frame',
    );
    expect(message(await attempt('movie.shot.frame.generate', at(face.id)))).toContain(
      'Paint the end frame of shot 2 or make its clip first',
    );

    // The first shot: a key frame, and an end frame drawn to agree with it.
    await run('movie.shot.frame.generate', at(walk.id));
    const { frame: ending } = await run('movie.shot.frame.generate', { ...at(walk.id), end: true });
    expect(ending.guides[0]).toBe('the first frame of this shot');
    expect(ending.prompt).toContain('The last frame of a film shot');
    expect(ending.prompt).toContain('keep the camera');
    const painted = await run('movie.shot.get', at(walk.id));
    expect(painted.endFrameId).toBe(ending.id);
    expect(painted.frames).toHaveLength(1);

    const started = await run('movie.shot.clip.generate', at(walk.id));
    expect(started.clip).toMatchObject({ endFrameId: ending.id, continuesFrom: null });
    expect(provider.videoRequests[0]?.firstFrame).toBeDefined();
    expect(provider.videoRequests[0]?.lastFrame?.mediaType).toBe('image/png');
    const walked = await ready(walk.id);
    expect(walked.status).toBe('ready');

    // Now the continuing shot starts on the last frame of that clip.
    const carried = await run('movie.shot.clip.generate', at(turn.id));
    expect(provider.videoRequests[1]?.firstFrame).toEqual({
      bytes: new Uint8Array([200, 1]),
      mediaType: 'image/jpeg',
    });
    expect(provider.videoRequests[1]?.lastFrame).toBeUndefined();
    expect(carried.clip.continuesFrom).toEqual({ shotId: walk.id, clipKey: walked.blobKey });
    expect(grabbed.at(-1)?.at[0]).toBeCloseTo(4.95);

    // While it is being made, the cut on action still has nothing to match; then it has.
    expect(message(await attempt('movie.shot.frame.generate', at(face.id)))).toContain(
      'make its clip first',
    );
    await ready(turn.id);
    const { frame: matched } = await run('movie.shot.frame.generate', at(face.id));
    expect(matched.guides[0]).toBe('the last frame of the shot before');
    expect(matched.prompt).toContain('cuts on action');

    // The first cut never trims across a join that carries on frame to frame.
    const { pieces } = await run('movie.edit.assemble', { projectId, sceneId: scene.id }, editor);
    expect(pieces[0]).toMatchObject({ trimStartSeconds: 2, trimEndSeconds: 0 });
    expect(pieces[1]).toMatchObject({ trimStartSeconds: 0, trimEndSeconds: 2 });
    const { text } = await run('movie.edit.edl', { projectId, sceneId: scene.id }, editor);
    expect(text).toContain('carries on frame to frame, cut: the same take, the action goes on');

    // A new clip of the first shot leaves the continuing one out of step.
    await run('movie.shot.clip.generate', at(walk.id));
    await ready(walk.id);
    const cut: { items: { outOfStep: boolean }[] } = await run('movie.edit.get', {
      projectId,
      sceneId: scene.id,
    });
    expect(cut.items.map((item) => item.outOfStep)).toEqual([false, true, false]);
    expect((await run('movie.edit.edl', { projectId, sceneId: scene.id })).text).toContain(
      'OUT OF STEP',
    );
  });

  it('chooses, deletes and imports end frames apart from key frames', async () => {
    const { run, at, add, provider } = await setup();
    const shot = await add({ description: 'The beam turns.' });
    const { frame: first } = await run('movie.shot.frame.generate', { ...at(shot.id), end: true });
    const { frame: second } = await run('movie.shot.frame.generate', {
      ...at(shot.id),
      end: true,
      direction: 'darker',
    });
    // Without a first frame there is nothing for the end to agree with.
    expect(first.guides).toEqual([]);
    expect(
      await run('movie.shot.frame.select', { ...at(shot.id), frameId: second.id, end: true }),
    ).toEqual({ frameId: second.id });
    const missing = await run('movie.shot.frame.select', { ...at(shot.id), frameId: null });
    expect(missing).toEqual({ frameId: null });
    expect(
      await run('movie.shot.frame.delete', { ...at(shot.id), frameId: second.id, end: true }),
    ).toEqual({ frameId: first.id });
    const imported = await run('movie.shot.frame.fromFile', {
      ...at(shot.id),
      blobKey: first.blobKey,
      end: true,
    });
    const after = await run('movie.shot.get', at(shot.id));
    expect(after.endFrameId).toBe(imported.frame.id);
    expect(after.frames).toEqual([]);

    // Switched off, the clip leaves its end to the model.
    await run('movie.shot.clip.generate', { ...at(shot.id), endFrame: false });
    expect(provider.videoRequests[0]?.lastFrame).toBeUndefined();
    await run('movie.shot.clip.generate', at(shot.id));
    expect(provider.videoRequests[1]?.lastFrame).toBeDefined();
  });

  it('refuses a first shot that continues or cuts on action', async () => {
    const { attempt, at, add } = await setup();
    const shot = await add({ description: 'The sea.', join: 'continues' });
    expect(message(await attempt('movie.shot.clip.generate', at(shot.id)))).toContain(
      'first of its scene',
    );
    const other = await add({ description: 'Gulls.' });
    await attempt('movie.shot.update', { ...at(shot.id), join: 'action' });
    expect(message(await attempt('movie.shot.frame.generate', at(shot.id)))).toContain(
      'cannot cut on action',
    );
    expect(other.join).toBe('cut');
  });
});
