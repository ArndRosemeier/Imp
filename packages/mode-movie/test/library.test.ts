/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions --
 * Commands run by id answer with untyped output; these tests read it loosely and assert on it.
 */
import {
  CommandRegistry,
  createLibraryCommands,
  createProjectCommands,
  projectPrefix,
} from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { createFakeProvider } from '@imp/providers/testing';
import { createWorldCommands, worldLibrarySource } from '@imp/world';
import { describe, expect, it } from 'vitest';
import { createMovieMode } from '../src/index.js';

const user = { kind: 'user', id: 'arnd' } as const;

function setup() {
  const runtime = createTestRuntime();
  const provider = createFakeProvider({});
  const mode = createMovieMode({ provider });
  const registry = new CommandRegistry({ runtime }).register(
    ...createProjectCommands([{ mode: mode.id, ...mode.project }]),
    ...mode.commands,
    ...createWorldCommands({ provider }),
    ...createLibraryCommands([...(mode.library ?? []), worldLibrarySource]),
  );
  const run = async (id: string, input: unknown): Promise<any> => {
    const result = await registry.executeById(id, input, { actor: user });
    if (result.status !== 'ok') throw new Error(`${id}: ${result.status}`);
    return result.output;
  };
  return { runtime, run };
}

describe('the movie in the library', () => {
  it('lists what a film made and wrote, each with where to open it', async () => {
    const { runtime, run } = setup();
    const { id } = await run('project.create', { name: 'Lighthouse', mode: 'movie' });
    await run('movie.development.update', { projectId: id, logline: 'A keeper and a storm.' });
    const scene = await run('movie.scene.create', {
      projectId: id,
      heading: 'INT. LAMP ROOM - NIGHT',
      body: 'MARA climbs.',
    });
    const mara = await run('movie.character.create', { projectId: id, name: 'Mara' });
    const shot = await run('movie.shot.create', {
      projectId: id,
      sceneId: scene.id,
      description: 'Mara at the lamp',
      speakerId: mara.id,
      line: 'Hold on!',
    });
    const sound = await run('movie.sound.create', {
      projectId: id,
      sceneId: scene.id,
      kind: 'effect',
      name: 'Wind',
      description: 'howling wind',
    });
    // Give the sound a take and the character a picture, as generation would.
    const soundKey = `${projectPrefix(id)}movie/sounds/${scene.id}/${sound.id}`;
    await runtime.store.batch([
      {
        type: 'put',
        key: soundKey,
        value: {
          ...sound,
          take: {
            blobKey: `${soundKey}/take/t1`,
            mediaType: 'audio/mpeg',
            prompt: 'howling wind',
            model: 'm',
            costUsd: null,
            createdAt: '2026-01-02T00:00:00.000Z',
          },
        },
      },
    ]);
    const charKey = `${projectPrefix(id)}movie/characters/${mara.id}`;
    const stored = (await runtime.store.get(charKey)) as Record<string, unknown>;
    await runtime.store.batch([
      {
        type: 'put',
        key: charKey,
        value: {
          ...stored,
          images: [
            {
              id: 'img1',
              blobKey: `${charKey}/images/img1`,
              mediaType: 'image/png',
              prompt: 'p',
              model: 'm',
              createdAt: '2026-01-03T00:00:00.000Z',
            },
          ],
          portraitId: 'img1',
        },
      },
    ]);

    const { assets } = await run('library.list', { projectId: id, limit: 100 });
    const byKind = Object.fromEntries(assets.map((asset: any) => [asset.kind, asset]));
    expect(byKind['portrait']).toMatchObject({
      title: 'Mara, portrait',
      modality: 'image',
      open: { view: 'casting', focus: { characterId: mara.id } },
    });
    expect(byKind['effect']).toMatchObject({
      title: 'Wind',
      modality: 'sound',
      blobKey: `${soundKey}/take/t1`,
      context: 'Scene 1, INT. LAMP ROOM - NIGHT',
      refs: { sceneId: scene.id, soundId: sound.id },
      deletable: false,
    });
    expect(byKind['scene']).toMatchObject({ modality: 'text', text: 'MARA climbs.' });
    expect(byKind['development']).toMatchObject({ title: 'Logline' });
    expect(byKind['spoken-line']).toMatchObject({
      title: 'Mara: Hold on!',
      refs: { sceneId: scene.id, shotId: shot.id },
    });

    const sounds = await run('library.list', { projectId: id, modality: 'sound' });
    expect(sounds.assets.map((asset: any) => asset.title)).toEqual(['Wind']);
  });
});
