import { CommandRegistry, projectCommands } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { createFakeProvider } from '@imp/providers/testing';
import { createWorldCommands } from '@imp/world';
import { describe, expect, it } from 'vitest';
import { createMovieMode, movieStageOf, movieWork } from '../src/index.js';

const user = { kind: 'user', id: 'arnd' } as const;

describe('the movie on the work board', () => {
  it('puts each command in its stage', () => {
    expect(movieStageOf('movie.development.update')).toBe('development');
    expect(movieStageOf('movie.scene.update')).toBe('script');
    expect(movieStageOf('movie.character.image.generate')).toBe('casting');
    expect(movieStageOf('world.location.create')).toBe('design');
    expect(movieStageOf('movie.shot.clip.generate')).toBe('shots');
    expect(movieStageOf('movie.edit.pickup.request')).toBe('shots');
    expect(movieStageOf('movie.sound.generate')).toBe('sound');
    expect(movieStageOf('movie.edit.item.move')).toBe('edit');
    expect(movieStageOf('audio.region.cut')).toBe('audio');
    expect(movieStageOf('crew.ask')).toBeUndefined();
  });

  it('names scenes, shots, characters and places', async () => {
    const runtime = createTestRuntime();
    const provider = createFakeProvider({});
    const mode = createMovieMode({ provider });
    const registry = new CommandRegistry({ runtime }).register(
      ...projectCommands,
      ...mode.commands,
      ...createWorldCommands({ provider, style: () => Promise.resolve('') }),
    );
    let projectId = '';
    const run = async (id: string, input: Record<string, unknown>) => {
      const result = await registry.executeById(id, { projectId, ...input }, { actor: user });
      if (result.status !== 'ok') throw new Error(`${id}: ${JSON.stringify(result)}`);
      return result.output as { id: string };
    };
    projectId = (await run('project.create', { name: 'Storm', mode: 'movie' })).id;
    const sceneId = (
      await run('movie.scene.create', { heading: 'INT. LIGHTHOUSE, LAMP ROOM AT THE TOP - NIGHT' })
    ).id;
    const shotId = (await run('movie.shot.create', { sceneId, description: 'Wide.' })).id;
    const characterId = (await run('movie.character.create', { name: 'Mara' })).id;
    const locationId = (await run('world.location.create', { name: 'Lighthouse' })).id;
    const subject = (kind: string, id: string) => ({ kind, id, label: null });

    const named = await movieWork.label?.(
      runtime.store,
      projectId,
      [
        subject('scene', sceneId),
        subject('shot', shotId),
        subject('speaker', characterId),
        subject('location', locationId),
        subject('scene', 'gone'),
        subject('item', 'i1'),
      ],
      { sceneId },
    );
    expect(named?.map(({ kind, label }) => [kind, label])).toEqual([
      ['scene', 'Scene 1: INT. LIGHTHOUSE, LAMP ROOM AT THE T…'],
      ['shot', 'Scene 1, shot 1'],
      ['character', 'Mara'],
      ['location', 'Lighthouse'],
      ['scene', null],
      ['item', null],
    ]);
    // Without the scene, a shot cannot be found; outside a project nothing is named.
    expect(
      (await movieWork.label?.(runtime.store, projectId, [subject('shot', shotId)], {}))?.[0]
        ?.label,
    ).toBeNull();
    expect(
      await movieWork.label?.(runtime.store, null, [subject('scene', sceneId)], { sceneId }),
    ).toEqual([subject('scene', sceneId)]);
  });
});
