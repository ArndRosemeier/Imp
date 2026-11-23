/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call --
 * Commands run by id answer with untyped output; these tests read it loosely and assert on it.
 */
import { CommandRegistry, createProjectCommands } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { createFakeProvider } from '@imp/providers/testing';
import { describe, expect, it } from 'vitest';
import { createMovieMode, critic, filmEditor } from '../src/index.js';

const user = { kind: 'user', id: 'arnd' } as const;
const reader = { kind: 'agent', id: 'm1', role: 'critic' } as const;

async function setup() {
  const runtime = createTestRuntime();
  const mode = createMovieMode({ provider: createFakeProvider({}) });
  const registry = new CommandRegistry({ runtime }).register(
    ...createProjectCommands([{ mode: mode.id, ...mode.project }]),
    ...mode.commands,
  );
  const run = async (id: string, input: object, actor: typeof user | typeof reader = user) => {
    const result = await registry.executeById(id, input, { actor, approved: true });
    if (result.status !== 'ok') throw new Error(`${id}: ${result.status}`);
    return result.output as any;
  };
  const { id: projectId } = await run('project.create', { name: 'Keeper', mode: 'movie' });
  const scene = await run('movie.scene.create', { projectId, heading: 'EXT. LIGHTHOUSE - NIGHT' });
  return { run, projectId, sceneId: scene.id as string };
}

/**
 * A read-through of the script: notes on a scene while it is still words, left
 * by the critic or the person and marked done once the scene deals with them.
 */
describe('script notes', () => {
  it('are left on a scene, listed open first, and marked done', async () => {
    const { run, projectId, sceneId } = await setup();
    const note = await run(
      'movie.script.note.add',
      {
        projectId,
        sceneId,
        kind: 'problem',
        text: 'The scene does not turn.',
        quote: 'She waits.',
      },
      reader,
    );
    expect(note).toMatchObject({ status: 'open', by: 'critic', quote: 'She waits.' });
    await run('movie.script.note.add', { projectId, sceneId, kind: 'note', text: 'Lovely image.' });
    expect((await run('movie.script.note.list', { projectId, open: true })).notes).toHaveLength(2);

    await run('movie.script.note.set', { projectId, noteId: note.id, status: 'done' });
    const open = (await run('movie.script.note.list', { projectId, sceneId, open: true })).notes;
    expect(open.map((n: any) => n.by)).toEqual(['person']);

    await run('movie.script.note.remove', { projectId, noteId: note.id });
    expect((await run('movie.script.note.list', { projectId })).notes).toHaveLength(1);
    await expect(
      run('movie.script.note.add', { projectId, sceneId: 'nope', kind: 'note', text: 'x' }),
    ).rejects.toThrow();
  });

  it('are what the critic writes before there are clips', () => {
    expect(critic.scope.writes).toContain('movie.script.note.');
    expect(critic.needs?.map((need) => need.id)).toEqual(['scenes']);
  });
});

describe('finishing a film', () => {
  it('holds the look of the whole film and the credits for the fine cut', () => {
    const fineCut = filmEditor.needs?.find((need) => need.id === 'checkpoint:fine-cut');
    expect(fineCut?.byPerson).toBe(true);
    expect(fineCut?.before).toEqual(['movie.edit.look.set', 'movie.edit.credits.generate']);
  });

  it('keeps a shot marked as a key shot', async () => {
    const { run, projectId, sceneId } = await setup();
    const shot = await run('movie.shot.create', { projectId, sceneId, description: 'Wide.' });
    expect(shot.keyShot).toBe(false);
    const changed = await run('movie.shot.update', {
      projectId,
      sceneId,
      shotId: shot.id,
      keyShot: true,
    });
    expect(changed.keyShot).toBe(true);
    expect((await run('movie.shot.update', { projectId, sceneId, shotId: shot.id })).keyShot).toBe(
      true,
    );
  });
});
