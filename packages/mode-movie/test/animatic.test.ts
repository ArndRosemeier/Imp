/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return --
 * Commands run by id answer with untyped output; these tests read it loosely and assert on it.
 */
import { CommandRegistry, createProjectCommands, settingsCommands } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { createFakeProvider } from '@imp/providers/testing';
import { createWorldCommands } from '@imp/world';
import { describe, expect, it } from 'vitest';
import { createMovieMode, planFilm } from '../src/index.js';

const user = { kind: 'user', id: 'arnd' } as const;

async function setup() {
  const runtime = createTestRuntime();
  const provider = createFakeProvider({});
  const mode = createMovieMode({ provider });
  const registry = new CommandRegistry({ runtime }).register(
    ...createProjectCommands([{ mode: mode.id, ...mode.project }]),
    ...settingsCommands,
    ...mode.commands,
    ...createWorldCommands({ provider }),
  );
  const run = async (id: string, input: object) => {
    const result = await registry.executeById(id, input, { actor: user, approved: true });
    if (result.status !== 'ok') throw new Error(`${id}: ${result.status}`);
    return result.output as any;
  };
  const { id: projectId } = await run('project.create', { name: 'Keeper', mode: 'movie' });
  await run('settings.set', { key: 'images.model', value: 'vendor/painter' });
  const scene = await run('movie.scene.create', { projectId, heading: 'INT. LAMP ROOM - DUSK' });
  const mara = await run('movie.character.create', { projectId, name: 'Mara' });
  const add = (fields: object) =>
    run('movie.shot.create', { projectId, sceneId: scene.id, ...fields });
  const paint = (shotId: string) =>
    run('movie.shot.frame.generate', { projectId, sceneId: scene.id, shotId });
  return { runtime, run, projectId, scene, mara, add, paint };
}

/**
 * The animatic: before any clip is paid for, a shot with a key frame plays in
 * the cut as that still, for as long as it is planned to hold, so the scene
 * can be judged with its timing as stills.
 */
describe('the animatic', () => {
  it('plays shots with a key frame and no clip as stills of their planned length', async () => {
    const { runtime, run, projectId, scene, mara, add, paint } = await setup();
    const look = await add({ description: 'Mara looks up.', lengthSeconds: 2 });
    const speaks = await add({
      description: 'Mara at the lamp.',
      speakerId: mara.id,
      line: 'It is out.',
      lengthSeconds: 3,
    });
    await add({ description: 'She turns away.', join: 'continues' });
    await add({ description: 'Nothing painted yet.', lengthSeconds: 2 });
    await paint(look.id);
    await paint(speaks.id);

    const cut = await run('movie.edit.get', { projectId, sceneId: scene.id });
    const [first, second, third, fourth] = cut.items;
    expect(first.still).toMatchObject({ line: '' });
    expect(first.durationSeconds).toBe(2);
    expect(first.placeholder).toBe(false);
    expect(first.state).toBe('no_clip');
    expect(second.still).toMatchObject({ line: 'It is out.', speakerId: mara.id });
    expect(second.durationSeconds).toBe(3);
    // A continuing shot with no frame of its own holds the still of the shot before.
    expect(third.still?.blobKey).toBe(second.still.blobKey);
    expect(third.durationSeconds).toBe(3);
    // A shot with nothing painted is not in the animatic.
    expect(fourth.still).toBeNull();
    expect(fourth.durationSeconds).toBe(0);
    expect(cut.totalSeconds).toBe(8);

    const plan = await planFilm(runtime, 'test', projectId, [scene.id]);
    expect(plan.pictures.map((picture) => picture.kind)).toEqual(['still', 'still', 'still']);
    expect(plan.durationSeconds).toBe(8);
    expect(plan.captions).toEqual([
      expect.objectContaining({ kind: 'caption', text: 'Mara: It is out.', startSeconds: 2 }),
    ]);
  });
});
