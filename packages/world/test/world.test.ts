import { CommandRegistry, projectCommands, projectCreate, settingsCommands } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { ProviderError } from '@imp/providers';
import { createFakeProvider } from '@imp/providers/testing';
import { describe, expect, it } from 'vitest';
import {
  createWorldCommands,
  keyImageOf,
  Location,
  MAX_IMAGE_REFERENCES,
  referencesFor,
  WorldElement,
  WorldObject,
  worldImagePrompt,
  type WorldImage,
} from '../src/index.js';

const user = { kind: 'user', id: 'arnd' } as const;

/** What the commands return, loosely: tests check the fields they care about. */
interface Out {
  id: string;
  views: { id: string; name: string }[];
  items: { id: string; name: string; [key: string]: unknown }[];
  image: WorldImage;
  [key: string]: unknown;
}

async function setup(providerOptions: Parameters<typeof createFakeProvider>[0] = {}) {
  const runtime = createTestRuntime();
  const provider = createFakeProvider(providerOptions);
  const registry = new CommandRegistry({ runtime }).register(
    ...projectCommands,
    ...settingsCommands,
    ...createWorldCommands({
      provider,
      style: (_store, projectId) => Promise.resolve(`style of ${projectId}`),
    }),
  );
  const created = await registry.execute(
    projectCreate,
    { name: 'The Lighthouse Keeper', mode: 'movie' },
    { actor: user },
  );
  if (created.status !== 'ok') throw new Error('not ok');
  const projectId = created.output.id;
  const run = async (id: string, input: Record<string, unknown>) => {
    const result = await registry.executeById(id, { projectId, ...input }, { actor: user });
    if (result.status !== 'ok') {
      throw new Error(`${id}: ${result.status} ${JSON.stringify(result)}`);
    }
    return result.output as Out;
  };
  const fails = async (id: string, input: Record<string, unknown>): Promise<string> => {
    try {
      const result = await registry.executeById(id, { projectId, ...input }, { actor: user });
      return `not refused: ${result.status}`;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  const location = async (locationId: string) =>
    Location.parse(await run('world.location.get', { locationId }));
  return { runtime, registry, provider, projectId, run, fails, location };
}

describe('locations', () => {
  it('are made with a first view, listed in short and read whole', async () => {
    const { run, location } = await setup();
    const lamp = await run('world.location.create', {
      name: 'Lamp room',
      look: 'A round iron room under a glass dome.',
      layout: 'The door faces the sea window.',
    });
    expect(lamp).toMatchObject({
      kind: 'location',
      name: 'Lamp room',
      views: [{ name: 'Establishing' }],
      parentId: null,
    });
    const named = await run('world.location.create', {
      name: 'Cove',
      firstView: 'From the cliff',
    });
    expect(named).toMatchObject({ views: [{ name: 'From the cliff', description: '' }] });

    const listed = await run('world.location.list', {});
    expect(listed.items.map((item) => item.name)).toEqual(['Cove', 'Lamp room']);
    expect(listed.items[1]).toEqual({
      id: lamp.id,
      kind: 'location',
      name: 'Lamp room',
      parentId: null,
      views: [{ id: lamp.views[0]?.id, name: 'Establishing' }],
      states: [],
      imageKey: null,
    });
    const full = await run('world.location.list', { full: true });
    expect(full.items[1]).toMatchObject({ look: 'A round iron room under a glass dome.' });
    expect((await location(lamp.id)).layout).toBe('The door faces the sea window.');
  });

  it('change their fields and the place they are part of, without circles', async () => {
    const { run, fails, location } = await setup();
    const tower = await run('world.location.create', { name: 'Lighthouse' });
    const lamp = await run('world.location.create', { name: 'Lamp room', parentId: tower.id });
    const changed = await run('world.location.update', {
      locationId: lamp.id,
      look: 'Brass and glass.',
      ambience: 'Wind in the frame.',
    });
    expect(changed).toMatchObject({
      look: 'Brass and glass.',
      ambience: 'Wind in the frame.',
      parentId: tower.id,
      name: 'Lamp room',
    });
    expect(
      await fails('world.location.update', { locationId: tower.id, parentId: lamp.id }),
    ).toMatch(/part of itself/);
    expect(
      await fails('world.location.update', { locationId: tower.id, parentId: tower.id }),
    ).toMatch(/part of itself/);
    expect(
      await fails('world.location.update', { locationId: lamp.id, parentId: 'nowhere' }),
    ).toMatch(/No location "nowhere"/);
    expect(await fails('world.location.create', { name: 'X', parentId: 'nowhere' })).toMatch(
      /No location/,
    );
    await run('world.location.update', { locationId: lamp.id, parentId: null });
    expect((await location(lamp.id)).parentId).toBeNull();
    expect(await fails('world.location.get', { locationId: 'nowhere' })).toMatch(/No location/);
  });

  it('let places inside a deleted place stand on their own and remove its pictures', async () => {
    const { run, runtime, location } = await setup();
    await run('settings.set', { key: 'images.model', value: 'vendor/painter' });
    const tower = await run('world.location.create', { name: 'Lighthouse' });
    const lamp = await run('world.location.create', { name: 'Lamp room', parentId: tower.id });
    const { image } = await run('world.location.image.generate', { locationId: tower.id });
    expect(await runtime.blobs.get(image.blobKey)).toBeDefined();
    await run('world.location.delete', { locationId: tower.id });
    expect((await location(lamp.id)).parentId).toBeNull();
    expect(await runtime.blobs.get(image.blobKey)).toBeUndefined();
  });
});

describe('views and states', () => {
  it('are added, changed and removed with the pictures made of them', async () => {
    const { run, fails, location, runtime } = await setup();
    await run('settings.set', { key: 'images.model', value: 'vendor/painter' });
    const lamp = await run('world.location.create', { name: 'Lamp room' });
    const locationId = lamp.id;
    const master = lamp.views[0]?.id ?? '';
    const stairs = await run('world.location.view.add', {
      locationId,
      name: 'From the stairs',
      description: 'Low, looking up.',
    });
    const renamed = await run('world.location.view.update', {
      locationId,
      viewId: stairs.id,
      name: 'Up the stairs',
    });
    expect(renamed).toEqual({
      id: stairs.id,
      name: 'Up the stairs',
      description: 'Low, looking up.',
    });
    const night = await run('world.location.state.add', { locationId, name: 'Night' });
    expect(
      await run('world.location.state.update', {
        locationId,
        stateId: night.id,
        description: 'Only the lamp lights the room.',
      }),
    ).toEqual({ id: night.id, name: 'Night', description: 'Only the lamp lights the room.' });

    const make = async (input: Record<string, unknown>) =>
      (await run('world.location.image.generate', { locationId, ...input })).image;
    await make({});
    const stairsDay = await make({ viewId: stairs.id });
    const stairsNight = await make({ viewId: stairs.id, stateId: night.id });
    expect((await location(locationId)).keyImages).toHaveLength(3);

    expect(await run('world.location.state.remove', { locationId, stateId: night.id })).toEqual({
      states: 0,
    });
    expect(await runtime.blobs.get(stairsNight.blobKey)).toBeUndefined();
    expect((await location(locationId)).keyImages).toHaveLength(2);

    expect(
      await fails('world.location.view.update', { locationId, viewId: 'x', name: 'Y' }),
    ).toMatch(/no view "x"/);
    expect(await fails('world.location.state.update', { locationId, stateId: 'x' })).toMatch(
      /no state "x"/,
    );
    // The master goes; the stairs view becomes the master.
    await run('world.location.view.remove', { locationId, viewId: master });
    const after = await location(locationId);
    expect(after.views.map((view) => view.name)).toEqual(['Up the stairs']);
    expect(keyImageOf(after)?.id).toBe(stairsDay.id);
    expect(await fails('world.location.view.remove', { locationId, viewId: stairs.id })).toMatch(
      /last view/,
    );
  });
});

describe('pictures', () => {
  it('need an image model', async () => {
    const { run, fails } = await setup();
    const lamp = await run('world.location.create', { name: 'Lamp room' });
    expect(await fails('world.location.image.generate', { locationId: lamp.id })).toMatch(
      /No image model/,
    );
  });

  it('are drawn empty, in the project style, and agree with the pictures made before', async () => {
    const { run, provider, projectId, fails } = await setup();
    await run('settings.set', { key: 'images.model', value: 'vendor/painter' });
    const tower = await run('world.location.create', { name: 'Lighthouse', look: 'White stone.' });
    const lamp = await run('world.location.create', {
      name: 'Lamp room',
      look: 'Round iron room.',
      layout: 'Door opposite the sea window',
      parentId: tower.id,
    });
    const locationId = lamp.id;
    const first = await run('world.location.image.generate', { locationId });
    expect(first.image).toMatchObject({ references: 0, model: 'vendor/painter', stateId: null });
    expect(provider.imageRequests[0]).toMatchObject({ aspectRatio: '16:9' });
    expect(provider.imageRequests[0]?.references).toBeUndefined();
    const prompt = provider.imageRequests[0]?.prompt ?? '';
    expect(prompt).toContain('Film location plate of Lamp room, view "Establishing".');
    expect(prompt).toContain('It is part of Lighthouse: White stone.');
    expect(prompt).toContain('Layout: Door opposite the sea window.');
    expect(prompt).toContain(`Visual style: style of ${projectId}.`);
    expect(prompt).toContain('No people in the frame.');

    const window = await run('world.location.view.add', { locationId, name: 'Sea window' });
    const second = await run('world.location.image.generate', {
      locationId,
      viewId: window.id,
      direction: 'dusk',
    });
    expect(second.image.references).toBe(1);
    expect(provider.imageRequests[1]?.references).toHaveLength(1);
    expect(provider.imageRequests[1]?.prompt).toContain('Keep its architecture');
    expect(provider.imageRequests[1]?.prompt).toContain(' dusk.');

    const third = await run('world.location.image.generate', {
      locationId,
      viewId: window.id,
      references: false,
      prompt: 'Just this.',
    });
    expect(third.image).toMatchObject({ references: 0, prompt: 'Just this.' });
    expect(await fails('world.location.image.generate', { locationId, viewId: 'x' })).toMatch(
      /no view/,
    );
    expect(await fails('world.location.image.generate', { locationId, stateId: 'x' })).toMatch(
      /no state/,
    );
  });

  it('are drawn from the words alone when the model takes no references', async () => {
    const { run, provider } = await setup({ imageRefusesReferences: true });
    await run('settings.set', { key: 'images.model', value: 'vendor/painter' });
    const watch = await run('world.object.create', { name: 'Pocket watch', look: 'Brass.' });
    const objectId = watch.id;
    await run('world.object.image.generate', { objectId });
    const side = await run('world.object.view.add', { objectId, name: 'Side' });
    const made = await run('world.object.image.generate', { objectId, viewId: side.id });
    expect(made.image.references).toBe(0);
    expect(made.image.prompt).not.toContain('reference images');
    expect(provider.imageRequests).toHaveLength(3);
    expect(provider.imageRequests[0]).toMatchObject({ aspectRatio: '1:1' });
    expect(provider.imageRequests[0]?.prompt).toContain('Alone on a plain neutral background');
  });

  it('report a failed model as a failed command', async () => {
    const { run, fails } = await setup({
      imageError: new ProviderError('unavailable', 'fake', 'Down.'),
    });
    await run('settings.set', { key: 'images.model', value: 'vendor/painter' });
    const watch = await run('world.object.create', { name: 'Pocket watch' });
    expect(await fails('world.object.image.generate', { objectId: watch.id })).toMatch(
      /No picture was made: Down/,
    );
  });

  it('are chosen as key pictures and deleted, with the newest one taking over', async () => {
    const { run, fails, runtime } = await setup();
    await run('settings.set', { key: 'images.model', value: 'vendor/painter' });
    const watch = await run('world.object.create', { name: 'Pocket watch' });
    const objectId = watch.id;
    const make = async () => (await run('world.object.image.generate', { objectId })).image;
    const one = await make();
    const two = await make();
    const three = await make();
    const read = async () => WorldObject.parse(await run('world.object.get', { objectId }));
    expect(keyImageOf(await read())?.id).toBe(one.id);
    expect(await run('world.object.image.select', { objectId, imageId: two.id })).toMatchObject({
      imageId: two.id,
    });
    expect(keyImageOf(await read())?.id).toBe(two.id);
    expect(await run('world.object.image.delete', { objectId, imageId: two.id })).toEqual({
      images: 2,
    });
    expect(keyImageOf(await read())?.id).toBe(three.id);
    expect(await runtime.blobs.get(two.blobKey)).toBeUndefined();
    expect(await fails('world.object.image.select', { objectId, imageId: 'x' })).toMatch(
      /No picture/,
    );
    expect(await fails('world.object.image.delete', { objectId, imageId: 'x' })).toMatch(
      /No picture/,
    );
  });
});

describe('objects', () => {
  it('are made, changed, listed with an owner and deleted', async () => {
    const { run, fails } = await setup();
    const watch = await run('world.object.create', {
      name: 'Pocket watch',
      ownerId: 'mara',
      firstView: 'Open',
      firstViewDescription: 'Lid open, face up.',
    });
    expect(watch).toMatchObject({
      kind: 'object',
      ownerId: 'mara',
      views: [{ name: 'Open', description: 'Lid open, face up.' }],
    });
    const changed = await run('world.object.update', {
      objectId: watch.id,
      look: 'Tarnished brass.',
      ownerId: null,
    });
    expect(changed).toMatchObject({
      look: 'Tarnished brass.',
      ownerId: null,
      name: 'Pocket watch',
    });
    const listed = await run('world.object.list', {});
    expect(listed.items[0]).toMatchObject({ ownerId: null, kind: 'object' });
    // An object is not found as a location, and the other way round.
    expect(await fails('world.location.get', { locationId: watch.id })).toMatch(/No location/);
    await run('world.object.delete', { objectId: watch.id });
    expect(await fails('world.object.get', { objectId: watch.id })).toMatch(/No object/);
  });
});

describe('the closest picture', () => {
  const image = (id: string, viewId: string, stateId: string | null): WorldImage => ({
    id,
    blobKey: id,
    mediaType: 'image/webp',
    viewId,
    stateId,
    prompt: '',
    model: 'm',
    references: 0,
    costUsd: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const element = WorldElement.parse({
    id: 'l',
    kind: 'location',
    name: 'Lamp room',
    description: '',
    look: '',
    layout: '',
    ambience: '',
    parentId: null,
    views: [
      { id: 'v1', name: 'A', description: '' },
      { id: 'v2', name: 'B', description: '' },
      { id: 'v3', name: 'C', description: '' },
    ],
    states: [{ id: 'night', name: 'Night', description: '' }],
    images: [
      image('a', 'v1', null),
      image('an', 'v1', 'night'),
      image('b', 'v2', null),
      image('c', 'v3', null),
    ],
    keyImages: [
      { viewId: 'v1', stateId: null, imageId: 'a' },
      { viewId: 'v1', stateId: 'night', imageId: 'an' },
      { viewId: 'v2', stateId: null, imageId: 'b' },
      { viewId: 'v3', stateId: null, imageId: 'c' },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  it('falls back from the exact view and state to the master', () => {
    expect(keyImageOf(element, 'v2', 'night')?.id).toBe('b');
    expect(keyImageOf(element, 'v1', 'night')?.id).toBe('an');
    expect(keyImageOf(element, 'v1', 'gone')?.id).toBe('a');
    expect(keyImageOf(element, 'gone', null)?.id).toBe('a');
    expect(keyImageOf({ ...element, keyImages: [] })).toBeUndefined();
  });

  it('guides a new picture by the same view, then the master, then the others', () => {
    expect(referencesFor(element, 'v2', 'night').map((found) => found.id)).toEqual([
      'b',
      'an',
      'a',
      'c',
    ]);
    expect(referencesFor(element, 'v1', null).map((found) => found.id)).toEqual(['b', 'c']);
    expect(MAX_IMAGE_REFERENCES).toBe(4);
  });

  it('builds a prompt from the look alone when nothing else is known', () => {
    const watch = WorldObject.parse({
      id: 'w',
      kind: 'object',
      name: 'Watch',
      description: 'A family heirloom',
      look: '',
      ownerId: null,
      views: [{ id: 'v', name: 'Front', description: '' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(
      worldImagePrompt({
        element: watch,
        view: watch.views[0] ?? { id: '', name: '', description: '' },
        state: { id: 's', name: 'Cracked', description: 'The glass is cracked' },
        style: '',
        references: 2,
      }),
    ).toBe(
      'Reference still of Watch, view "Front". A family heirloom. State "Cracked": The glass is cracked. The reference images show this same object. Keep its shape, proportions, materials and colours exactly; only the view and the state described here may differ. Alone on a plain neutral background, evenly lit, the whole object in frame.',
    );
  });
});
