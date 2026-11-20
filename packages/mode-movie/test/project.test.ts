/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions --
 * Commands run by id answer with untyped output; these tests read it loosely and assert on it.
 */
import { CommandRegistry, createProjectCommands, projectPrefix, settingsCommands } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { createFakeProvider } from '@imp/providers/testing';
import { createWorldCommands } from '@imp/world';
import { describe, expect, it } from 'vitest';
import { createMovieMode, movieTemplates } from '../src/index.js';

const user = { kind: 'user', id: 'arnd' } as const;
const agent = { kind: 'agent', id: 'c', role: 'casting-director' } as const;

function setup() {
  const runtime = createTestRuntime();
  const provider = createFakeProvider({});
  const mode = createMovieMode({ provider });
  const registry = new CommandRegistry({ runtime }).register(
    ...createProjectCommands([{ mode: mode.id, ...mode.project }]),
    ...settingsCommands,
    ...mode.commands,
    ...createWorldCommands({ provider }),
  );
  const run = async (
    id: string,
    input: unknown,
    actor: typeof user | typeof agent = user,
  ): Promise<any> => {
    const result = await registry.executeById(id, input, { actor });
    if (result.status !== 'ok') throw new Error(`${id}: ${result.status}`);
    return result.output;
  };
  const project = async (name: string, templateId?: string) =>
    (await run('project.create', {
      name,
      mode: 'movie',
      ...(templateId === undefined ? {} : { templateId }),
    })) as {
      id: string;
    };
  /** Gives a character a stored portrait, as image generation would. */
  const portray = async (projectId: string, characterId: string) => {
    const key = `${projectPrefix(projectId)}movie/characters/${characterId}`;
    const character = (await runtime.store.get(key)) as Record<string, unknown>;
    const blobKey = `${key}/images/img1`;
    await runtime.blobs.put(blobKey, { bytes: new Uint8Array([1]), mediaType: 'image/png' });
    const image = {
      id: 'img1',
      blobKey,
      mediaType: 'image/png',
      prompt: 'p',
      model: 'm',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await runtime.store.batch([
      { type: 'put', key, value: { ...character, images: [image], portraitId: 'img1' } },
    ]);
    return blobKey;
  };
  /** Gives a shot a ready clip, as clip generation would. */
  const film = async (projectId: string, sceneId: string, shotId: string) => {
    const key = `${projectPrefix(projectId)}movie/shots/${sceneId}/${shotId}`;
    const shot = (await runtime.store.get(key)) as Record<string, unknown>;
    const blobKey = `${key}/clip/c1`;
    await runtime.blobs.put(blobKey, { bytes: new Uint8Array([2]), mediaType: 'video/mp4' });
    const clip = {
      status: 'ready',
      jobId: 'j',
      blobKey,
      mediaType: 'video/mp4',
      prompt: 'p',
      model: 'm',
      portraits: 0,
      progress: null,
      error: null,
      durationSeconds: 4,
      silent: false,
      costUsd: 0.1,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await runtime.store.batch([{ type: 'put', key, value: { ...shot, clip } }]);
    return blobKey;
  };
  return { runtime, run, project, portray, film };
}

/** A small film: a scene with a shot that shows Mara, a sound, and a cut that uses a second scene. */
async function smallFilm(context: ReturnType<typeof setup>, name = 'Keeper') {
  const { run, project, portray, film } = context;
  const { id } = await project(name);
  const p = { projectId: id };
  await run('movie.development.update', { ...p, logline: 'A keeper and a storm.' });
  const mara = await run('movie.character.create', { ...p, name: 'Mara', part: 'lead' });
  const portrait = await portray(id, mara.id);
  const lamp = await run('movie.scene.create', {
    ...p,
    heading: 'INT. LAMP ROOM - NIGHT',
    body: 'Mara climbs.',
  });
  const gallery = await run('movie.scene.create', { ...p, heading: 'EXT. GALLERY - NIGHT' });
  const shot = await run('movie.shot.create', {
    ...p,
    sceneId: lamp.id,
    description: 'Mara at the lamp.',
    characterIds: [mara.id],
  });
  const clip = await film(id, lamp.id, shot.id);
  const outside = await run('movie.shot.create', {
    ...p,
    sceneId: gallery.id,
    description: 'Rain on the rail.',
  });
  const wind = await run('movie.sound.create', {
    ...p,
    sceneId: lamp.id,
    kind: 'effect',
    name: 'Wind',
    description: 'Howling wind.',
  });
  // The lamp room's cut borrows the gallery shot.
  await run('movie.edit.item.add', {
    ...p,
    sceneId: lamp.id,
    shotId: outside.id,
    shotSceneId: gallery.id,
  });
  return { id, mara, lamp, gallery, shot, outside, wind, portrait, clip };
}

describe('movie templates', () => {
  it('start a project with scenes, notes and characters under fresh ids', async () => {
    const { run, project } = setup();
    expect(movieTemplates.map((t) => t.id)).toEqual([
      'movie.short-film',
      'movie.music-video',
      'movie.trailer',
      'movie.two-hander',
    ]);
    const a = await project('A', 'movie.short-film');
    const b = await project('B', 'movie.short-film');
    const scenesOf = async (projectId: string) =>
      (await run('movie.scene.list', { projectId })).scenes;
    const first = await scenesOf(a.id);
    expect(first.map((s: { heading: string }) => s.heading)).toEqual([
      'OPENING IMAGE',
      'INCITING INCIDENT',
      'TURNING POINT',
      'CLIMAX',
      'FINAL IMAGE',
    ]);
    const second = await scenesOf(b.id);
    expect(second[0].id).not.toBe(first[0].id);
    expect((await run('movie.character.list', { projectId: a.id })).characters).toHaveLength(1);
    const development = await run('movie.development.get', { projectId: a.id });
    expect(development.treatment).toMatch(/Act one/);
    for (const template of movieTemplates) {
      const made = await project(template.name, template.id);
      expect((await scenesOf(made.id)).length).toBeGreaterThan(0);
    }
  });
});

describe('movie progress', () => {
  it('says stage by stage how far a project has come', async () => {
    const context = setup();
    const film = await smallFilm(context);
    const overview = await context.run('project.overview', {});
    const entry = overview.projects.find((p: { id: string }) => p.id === film.id);
    expect(entry.summary.headline).toBe('A keeper and a storm.');
    expect(entry.summary.posterKeys).toEqual([film.portrait]);
    const stages = Object.fromEntries(
      entry.summary.stages.map((s: { id: string; done: number; total: number; note: string }) => [
        s.id,
        `${String(s.done)}/${String(s.total)} ${s.note}`,
      ]),
    );
    expect(stages).toEqual({
      development: '1/4 1 of 4 parts written',
      script: '1/2 1 of 2 scenes written',
      casting: '1/1 1 character, 1 with a portrait, 0 with a voice',
      design: '0/0 No locations or objects',
      shots: '1/2 1 of 2 clips ready',
      sound: '0/1 0 of 1 sound made',
      edit: '1/2 1 of 2 scenes cut',
    });
    const empty = await context.project('Empty');
    const blank = (await context.run('project.overview', {})).projects.find(
      (p: { id: string }) => p.id === empty.id,
    );
    expect(blank.progress).toBe(0);
    expect(blank.summary.stages.map((s: { note: string }) => s.note)).toEqual([
      'Not started',
      'No scenes',
      'No characters',
      'No locations or objects',
      'No shots',
      'No sounds',
      'Nothing to cut',
    ]);
  });
});

describe('copying movie resources', () => {
  it('lists what can be copied', async () => {
    const context = setup();
    const film = await smallFilm(context);
    const listed = await context.run('project.resources.list', { projectId: film.id }, agent);
    expect(listed.kinds.map((k: { id: string }) => k.id)).toEqual([
      'development',
      'character',
      'location',
      'object',
      'scene',
      'shot',
      'sound',
    ]);
    expect(listed.items.map((i: { kind: string; name: string }) => `${i.kind}: ${i.name}`)).toEqual(
      [
        'development: Development notes',
        'character: Mara',
        'scene: 1. INT. LAMP ROOM - NIGHT',
        'shot: Scene 1, shot 1',
        'sound: Wind',
        'scene: 2. EXT. GALLERY - NIGHT',
        'shot: Scene 2, shot 1',
      ],
    );
    expect(listed.items[1].detail).toBe('lead · portrait');
  });

  it('copies a scene with its shots, files and cut, and brings the cast and borrowed scenes along', async () => {
    const context = setup();
    const { run, runtime } = context;
    const film = await smallFilm(context);
    const sequel = await context.project('Sequel');
    const copied = await run(
      'project.resources.copy',
      {
        fromProjectId: film.id,
        toProjectId: sequel.id,
        items: [{ kind: 'scene', id: film.lamp.id }],
      },
      agent,
    );
    expect(copied.status).toBe('copied');
    expect(
      copied.outcomes.map((o: { kind: string; outcome: string }) => `${o.kind} ${o.outcome}`),
    ).toEqual(['scene copied', 'character copied', 'scene copied']);
    const p = { projectId: sequel.id };
    const scenes = (await run('movie.scene.list', p)).scenes;
    expect(scenes.map((s: { heading: string }) => s.heading)).toEqual([
      'INT. LAMP ROOM - NIGHT',
      'EXT. GALLERY - NIGHT',
    ]);
    const shot = await run('movie.shot.get', { ...p, sceneId: film.lamp.id, shotId: film.shot.id });
    expect(shot.clip.blobKey).toBe(film.clip.replace(film.id, sequel.id));
    expect(await runtime.blobs.get(shot.clip.blobKey)).toBeDefined();
    const mara = await run('movie.character.get', { ...p, characterId: film.mara.id });
    expect(await runtime.blobs.get(mara.images[0].blobKey)).toBeDefined();
    expect(mara.images[0].blobKey.startsWith(projectPrefix(sequel.id))).toBe(true);
    expect((await run('movie.sound.list', { ...p, sceneId: film.lamp.id })).sounds).toHaveLength(1);
    const cut = await run('movie.edit.get', { ...p, sceneId: film.lamp.id });
    expect(cut.items.length).toBeGreaterThan(0);
  });

  it('asks about a character of the same name, and keeping both points the copied shots at the copy', async () => {
    const context = setup();
    const { run } = context;
    const film = await smallFilm(context);
    const sequel = await context.project('Sequel');
    const p = { projectId: sequel.id };
    const theirMara = await run('movie.character.create', { ...p, name: 'mara' });
    const asked = await run(
      'project.resources.copy',
      {
        fromProjectId: film.id,
        toProjectId: sequel.id,
        items: [{ kind: 'shot', id: film.shot.id }],
        parentId: await firstScene(run, sequel.id),
      },
      agent,
    );
    expect(asked.status).toBe('waiting-for-person');
    expect(asked.collisions).toEqual([
      expect.objectContaining({
        kind: 'character',
        reason: 'needed',
        neededBy: 'Scene 1, shot 1',
        collision: {
          targetId: theirMara.id,
          targetName: 'mara',
          match: 'name',
          choices: ['overwrite', 'keepBoth', 'skip'],
        },
      }),
    ]);
    const done = await run('project.resources.request.resolve', {
      requestId: asked.requestId,
      choices: { [`character:${film.mara.id}`]: 'keepBoth' },
    });
    const kept = done.outcomes.find((o: { kind: string }) => o.kind === 'character');
    const characters = (await run('movie.character.list', p)).characters;
    expect(characters.map((c: { name: string }) => c.name).sort()).toEqual(['Mara (2)', 'mara']);
    const sceneId = await firstScene(run, sequel.id);
    const shots = (await run('movie.shot.list', { ...p, sceneId })).shots;
    const shot = await run('movie.shot.get', { ...p, sceneId, shotId: shots[0].id });
    expect(shot.characterIds).toEqual([kept.targetId]);
    expect(shot.clip.blobKey).toContain(`${sceneId}/${film.shot.id}/clip`);
  });

  it('skipping uses the one in the target, and overwriting replaces it in place', async () => {
    const context = setup();
    const { run, runtime } = context;
    const film = await smallFilm(context);
    const copy = await run('project.duplicate', { projectId: film.id });
    const p = { projectId: copy.id };
    await run('movie.scene.update', { ...p, sceneId: film.lamp.id, body: 'Changed in the copy.' });
    await run('movie.character.update', { ...p, characterId: film.mara.id, part: 'changed' });
    // Copying the scene back from the duplicate meets the same ids.
    const asked = await run('project.resources.copy', {
      fromProjectId: copy.id,
      toProjectId: film.id,
      items: [
        { kind: 'scene', id: film.lamp.id },
        { kind: 'development', id: 'development' },
      ],
    });
    expect(
      asked.collisions.map(
        (c: { kind: string; collision: { match: string } }) => `${c.kind} ${c.collision.match}`,
      ),
    ).toEqual(['scene id', 'development singleton', 'character id', 'scene id']);
    const before = await runtime.blobs.list(projectPrefix(film.id));
    const done = await run('project.resources.request.resolve', {
      requestId: asked.requestId,
      choices: {
        [`scene:${film.lamp.id}`]: 'overwrite',
        'development:development': 'skip',
        [`character:${film.mara.id}`]: 'skip',
        [`scene:${film.gallery.id}`]: 'skip',
      },
    });
    expect(done.outcomes.map((o: { outcome: string }) => o.outcome)).toEqual([
      'overwritten',
      'skipped',
      'skipped',
      'skipped',
    ]);
    const scene = await run('movie.scene.get', { projectId: film.id, sceneId: film.lamp.id });
    expect(scene).toMatchObject({ body: 'Changed in the copy.', position: 1 });
    expect(
      (await run('movie.character.get', { projectId: film.id, characterId: film.mara.id })).part,
    ).toBe('lead');
    expect(await runtime.blobs.list(projectPrefix(film.id))).toEqual(before);
    expect((await run('movie.scene.list', { projectId: film.id })).scenes).toHaveLength(2);

    // Overwriting a character replaces its record and files.
    const again = await run('project.resources.copy', {
      fromProjectId: copy.id,
      toProjectId: film.id,
      items: [{ kind: 'character', id: film.mara.id }],
    });
    await run('project.resources.request.resolve', {
      requestId: again.requestId,
      choices: { [`character:${film.mara.id}`]: 'overwrite' },
    });
    expect(
      (await run('movie.character.get', { projectId: film.id, characterId: film.mara.id })).part,
    ).toBe('changed');
  });

  it('copies sounds and shots into a chosen scene, asking about names, and development when empty', async () => {
    const context = setup();
    const { run } = context;
    const film = await smallFilm(context);
    const other = await context.project('Other');
    const p = { projectId: other.id };
    const scene = await run('movie.scene.create', { ...p, heading: 'INT. HALL' });
    await run('movie.sound.create', {
      ...p,
      sceneId: scene.id,
      kind: 'effect',
      name: 'WIND',
      description: 'x',
    });
    const copy = (items: unknown[]) =>
      run('project.resources.copy', {
        fromProjectId: film.id,
        toProjectId: other.id,
        items,
        parentId: scene.id,
      });
    const sounds = await copy([
      { kind: 'sound', id: film.wind.id },
      { kind: 'development', id: 'development' },
    ]);
    expect(sounds.status).toBe('waiting-for-person');
    expect(sounds.collisions.map((c: { kind: string }) => c.kind)).toEqual(['sound']);
    await run('project.resources.request.resolve', {
      requestId: sounds.requestId,
      choices: { [`sound:${film.wind.id}`]: 'keepBoth' },
    });
    const names = (await run('movie.sound.list', { ...p, sceneId: scene.id })).sounds.map(
      (s: { name: string }) => s.name,
    );
    expect(names.sort()).toEqual(['WIND', 'Wind (2)']);
    expect((await run('movie.development.get', p)).logline).toBe('A keeper and a storm.');

    // The same shot twice: the second time it collides by id within the scene.
    const first = await copy([{ kind: 'shot', id: film.outside.id }]);
    expect(first.status).toBe('copied');
    const second = await copy([{ kind: 'shot', id: film.outside.id }]);
    await run('project.resources.request.resolve', {
      requestId: second.requestId,
      choices: { [`shot:${film.outside.id}`]: 'keepBoth' },
    });
    const third = await copy([{ kind: 'shot', id: film.outside.id }]);
    await run('project.resources.request.resolve', {
      requestId: third.requestId,
      choices: { [`shot:${film.outside.id}`]: 'overwrite' },
    });
    const shots = (await run('movie.shot.list', { ...p, sceneId: scene.id })).shots;
    expect(shots.map((s: { position: number }) => s.position)).toEqual([1, 2]);
    // Shots and sounds of a scene that is copied whole come with it, not twice.
    const whole = await run('project.resources.copy', {
      fromProjectId: film.id,
      toProjectId: other.id,
      items: [
        { kind: 'scene', id: film.gallery.id },
        { kind: 'shot', id: film.outside.id },
      ],
      parentId: scene.id,
    });
    expect(whole.status).toBe('copied');
    expect(whole.outcomes.map((o: { kind: string }) => o.kind)).toEqual(['scene']);
  });

  it('brings the places and objects a scene shows along, with their pictures and larger places', async () => {
    const context = setup();
    const { run, runtime } = context;
    await run('settings.set', { key: 'images.model', value: 'vendor/painter' });
    const from = await context.project('From');
    const to = await context.project('To');
    const at = (projectId: string) => ({ projectId });
    const tower = await run('world.location.create', { ...at(from.id), name: 'Lighthouse' });
    const lamp = await run('world.location.create', {
      ...at(from.id),
      name: 'Lamp room',
      parentId: tower.id,
    });
    const night = await run('world.location.state.add', {
      ...at(from.id),
      locationId: lamp.id,
      name: 'Night',
    });
    const picture = await run('world.location.image.generate', {
      ...at(from.id),
      locationId: lamp.id,
    });
    const watch = await run('world.object.create', { ...at(from.id), name: 'Pocket watch' });
    const scene = await run('movie.scene.create', {
      ...at(from.id),
      heading: 'INT. LAMP ROOM - NIGHT',
      locationId: lamp.id,
      locationStateId: night.id,
    });
    await run('movie.shot.create', {
      ...at(from.id),
      sceneId: scene.id,
      objects: [{ objectId: watch.id }],
    });
    // The target already has a lamp room of its own.
    await run('world.location.create', { ...at(to.id), name: 'Lamp room' });

    const listed = await run('project.resources.list', { projectId: from.id });
    expect(
      listed.items
        .filter((i: { kind: string }) => i.kind === 'location')
        .map((i: { name: string; detail: string }) => `${i.name}: ${i.detail}`),
    ).toEqual(['Lamp room: 1 view · 1 state · 1 picture', 'Lighthouse: 1 view · 0 pictures']);

    const asked = await run('project.resources.copy', {
      fromProjectId: from.id,
      toProjectId: to.id,
      items: [{ kind: 'scene', id: scene.id }],
    });
    expect(asked.status).toBe('waiting-for-person');
    expect(
      asked.collisions.map(
        (i: { kind: string; name: string; reason: string }) => `${i.kind} ${i.name} ${i.reason}`,
      ),
    ).toEqual(['location Lamp room needed']);
    await run('project.resources.request.resolve', {
      requestId: asked.requestId,
      choices: { [`location:${lamp.id}`]: 'keepBoth' },
    });
    const places = (await run('world.location.list', { projectId: to.id, full: true })).items;
    expect(places.map((p: { name: string }) => p.name)).toEqual([
      'Lamp room',
      'Lamp room (2)',
      'Lighthouse',
    ]);
    const copy = places.find((p: { name: string }) => p.name === 'Lamp room (2)');
    expect(copy.id).not.toBe(lamp.id);
    expect(copy.parentId).toBe(tower.id);
    expect(copy.images[0].blobKey).toContain(`projects/${to.id}/world/locations/${copy.id}/`);
    expect(await runtime.blobs.get(copy.images[0].blobKey)).toBeDefined();
    expect(picture.image.blobKey).toContain(from.id);
    // The copied scene points at the copy.
    const scenes = (await run('movie.scene.list', { projectId: to.id })).scenes;
    expect(scenes[0].locationId).toBe(copy.id);
    const objects = (await run('world.object.list', { projectId: to.id })).items;
    expect(objects.map((o: { name: string }) => o.name)).toEqual(['Pocket watch']);
  });

  it('refuses what is not there', async () => {
    const context = setup();
    const film = await smallFilm(context);
    const other = await context.project('Other');
    const copy = (items: unknown[], parentId?: string) =>
      context.run('project.resources.copy', {
        fromProjectId: film.id,
        toProjectId: other.id,
        items,
        ...(parentId === undefined ? {} : { parentId }),
      });
    await expect(copy([{ kind: 'character', id: 'nope' }])).rejects.toThrow(/No character/);
    await expect(copy([{ kind: 'scene', id: 'nope' }])).rejects.toThrow(
      /No scene "nope" in the source/,
    );
    await expect(copy([{ kind: 'shot', id: film.shot.id }], 'nope')).rejects.toThrow(
      /target has no scene/,
    );
    const scene = await context.run('movie.scene.create', { projectId: other.id, heading: 'X' });
    await expect(copy([{ kind: 'shot', id: 'nope' }], scene.id)).rejects.toThrow(/No shot/);
    await expect(copy([{ kind: 'sound', id: 'nope' }], scene.id)).rejects.toThrow(/No sound/);
  });
});

async function firstScene(
  run: (id: string, input: unknown) => Promise<any>,
  projectId: string,
): Promise<string> {
  const scenes = (await run('movie.scene.list', { projectId })).scenes;
  if (scenes.length > 0) return scenes[0].id as string;
  return (await run('movie.scene.create', { projectId, heading: 'INT. NEW' })).id as string;
}
