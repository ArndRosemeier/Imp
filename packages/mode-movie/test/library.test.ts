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

  it('turns files from the library into sounds, portraits, key frames, clips and world pictures', async () => {
    const { runtime, run } = setup();
    const { id } = await run('project.create', { name: 'Lighthouse', mode: 'movie' });
    const scene = await run('movie.scene.create', { projectId: id, heading: 'INT. LAMP ROOM' });
    const mara = await run('movie.character.create', { projectId: id, name: 'Mara' });
    const shot = await run('movie.shot.create', {
      projectId: id,
      sceneId: scene.id,
      description: 'Lamp',
    });
    const put = async (name: string, mediaType: string) => {
      await runtime.blobs.put(`uploads/${name}`, { bytes: new Uint8Array([1, 2]), mediaType });
      return run('library.import', { projectId: id, fileKey: `uploads/${name}`, fileName: name });
    };
    const door = await put('door.wav', 'audio/wav');
    const face = await put('face.png', 'image/png');
    const take = await put('take.mp4', 'video/mp4');

    const first = await run('movie.sound.fromFile', {
      projectId: id,
      sceneId: scene.id,
      blobKey: door.blobKey,
      name: 'Door',
    });
    expect(first).toMatchObject({ added: true, sound: { name: 'Door', kind: 'effect' } });
    expect((await runtime.blobs.get(first.sound.take.blobKey))?.bytes).toEqual(
      new Uint8Array([1, 2]),
    );
    // The same file given again, by its scene key, is the same sound.
    const again = await run('movie.sound.fromFile', {
      projectId: id,
      sceneId: scene.id,
      blobKey: first.sound.take.blobKey,
    });
    expect(again).toMatchObject({ added: false, sound: { id: first.sound.id } });
    await expect(
      run('movie.sound.fromFile', { projectId: id, sceneId: scene.id, blobKey: face.blobKey }),
    ).rejects.toThrow();

    const portrait = await run('movie.character.image.fromFile', {
      projectId: id,
      characterId: mara.id,
      blobKey: face.blobKey,
    });
    expect(portrait.portraitId).toBe(portrait.image.id);
    const frame = await run('movie.shot.frame.fromFile', {
      projectId: id,
      sceneId: scene.id,
      shotId: shot.id,
      blobKey: face.blobKey,
    });
    expect(frame.frame).toMatchObject({ model: 'file', mediaType: 'image/png' });
    const filmed = await run('movie.shot.clip.fromFile', {
      projectId: id,
      sceneId: scene.id,
      shotId: shot.id,
      blobKey: take.blobKey,
      durationSeconds: 4,
    });
    expect(filmed.clip).toMatchObject({ status: 'ready', durationSeconds: 4, model: 'file' });
    // A second video becomes the clip, and the first is kept as a take.
    const refilmed = await run('movie.shot.clip.fromFile', {
      projectId: id,
      sceneId: scene.id,
      shotId: shot.id,
      blobKey: take.blobKey,
    });
    expect(refilmed.takes).toEqual([expect.objectContaining({ blobKey: filmed.clip?.blobKey })]);

    const room = await run('world.location.create', { projectId: id, name: 'Lamp room' });
    const drawn = await run('world.location.image.fromFile', {
      projectId: id,
      locationId: room.id,
      blobKey: face.blobKey,
    });
    expect(drawn.image).toMatchObject({ model: 'file', stateId: null });
    const night = await run('world.location.state.add', {
      projectId: id,
      locationId: room.id,
      name: 'Night',
    });
    const unchosen = await run('world.location.image.fromFile', {
      projectId: id,
      locationId: room.id,
      blobKey: face.blobKey,
      stateId: night.id,
    });
    await run('world.location.image.fromFile', {
      projectId: id,
      locationId: room.id,
      blobKey: face.blobKey,
      stateId: night.id,
      choose: false,
    });
    const refused = (command: string, input: Record<string, unknown>) =>
      expect(run(command, { projectId: id, ...input })).rejects.toThrow();
    await refused('world.location.image.fromFile', {
      locationId: room.id,
      blobKey: 'uploads/none',
    });
    await refused('world.location.image.fromFile', { locationId: room.id, blobKey: door.blobKey });
    await refused('movie.sound.fromFile', { sceneId: 'nope', blobKey: door.blobKey });
    await refused('movie.sound.fromFile', { sceneId: scene.id, blobKey: 'uploads/none' });
    await refused('movie.character.image.fromFile', {
      characterId: mara.id,
      blobKey: 'uploads/none',
    });
    await refused('movie.character.image.fromFile', {
      characterId: mara.id,
      blobKey: door.blobKey,
    });
    await refused('movie.shot.frame.fromFile', {
      sceneId: scene.id,
      shotId: shot.id,
      blobKey: 'uploads/none',
    });
    await refused('movie.shot.frame.fromFile', {
      sceneId: scene.id,
      shotId: shot.id,
      blobKey: door.blobKey,
    });
    const views = await run('library.list', { projectId: id, kind: 'location-view' });
    const nightViews = views.assets.filter((asset: any) => asset.title.endsWith('Night'));
    expect(nightViews).toHaveLength(2);
    expect(nightViews.find((asset: any) => asset.refs.imageId === unchosen.image.id)?.context).toBe(
      'Chosen picture',
    );
    expect(await worldLibrarySource.list(runtime, 'no-such-project')).toEqual([]);
    const { assets } = await run('library.list', { projectId: id, limit: 100 });
    expect(assets.map((asset: any) => asset.kind).sort()).toEqual(
      [
        'clip',
        'clip',
        'effect',
        'imported-image',
        'imported-sound',
        'imported-video',
        'key-frame',
        'location-view',
        'location-view',
        'location-view',
        'portrait',
      ].sort(),
    );
  });
});
