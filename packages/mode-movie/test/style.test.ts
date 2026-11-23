/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return --
 * Commands run by id answer with untyped output; these tests read it loosely and assert on it.
 */
import { CommandRegistry, createProjectCommands, settingsCommands } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { createFakeProvider } from '@imp/providers/testing';
import { createWorldCommands } from '@imp/world';
import { describe, expect, it } from 'vitest';
import { createMovieMode, styleWords, visualStyleOf } from '../src/index.js';

const user = { kind: 'user', id: 'arnd' } as const;

async function setup() {
  const runtime = createTestRuntime();
  const provider = createFakeProvider({});
  const mode = createMovieMode({ provider });
  const registry = new CommandRegistry({ runtime }).register(
    ...createProjectCommands([{ mode: mode.id, ...mode.project }]),
    ...settingsCommands,
    ...mode.commands,
    ...createWorldCommands({
      provider,
      style: visualStyleOf,
      ...(mode.visualReference === undefined ? {} : { styleReference: mode.visualReference }),
    }),
  );
  const run = async (id: string, input: object) => {
    const result = await registry.executeById(id, input, { actor: user, approved: true });
    if (result.status !== 'ok') throw new Error(`${id}: ${result.status}`);
    return result.output as any;
  };
  const { id: projectId } = await run('project.create', { name: 'Keeper', mode: 'movie' });
  await run('settings.set', { key: 'images.model', value: 'vendor/painter' });
  return { runtime, provider, run, projectId };
}

/**
 * The look bible: the visual style in words and a chosen look picture, which
 * every portrait, place and key frame is drawn in and given as a reference.
 */
describe('the visual style', () => {
  it('says the style in one clause and falls back to the tone', async () => {
    const { runtime, run, projectId } = await setup();
    expect(
      styleWords({ palette: 'cold blues.', light: '', camera: '16mm, handheld', era: '' }),
    ).toBe('16mm, handheld; palette: cold blues');
    await run('movie.development.update', { projectId, tone: 'Bleak thriller' });
    expect(await visualStyleOf(runtime.store, projectId)).toBe('Bleak thriller');
    await run('movie.style.update', { projectId, palette: 'Cold blues', camera: 'Grainy 16mm' });
    expect(await visualStyleOf(runtime.store, projectId)).toBe(
      'Grainy 16mm; palette: Cold blues. Mood: Bleak thriller',
    );
    const got = await run('movie.style.get', { projectId });
    expect(got.drawnIn).toContain('Cold blues');
  });

  it('paints look pictures, chooses one and draws every picture with it', async () => {
    const { provider, run, projectId } = await setup();
    await expect(run('movie.style.image.generate', { projectId })).rejects.toThrow();
    await run('movie.style.update', { projectId, palette: 'Sodium orange' });
    const first = await run('movie.style.image.generate', { projectId });
    expect(provider.imageRequests.at(-1)?.prompt).toContain('palette: Sodium orange');
    const second = await run('movie.style.image.generate', { projectId, direction: 'Night' });
    let style = await run('movie.style.get', { projectId });
    expect(style.keyImageId).toBe(first.image.id);
    await run('movie.style.image.select', { projectId, imageId: second.image.id });

    // A portrait gets the look picture and the style.
    const mara = await run('movie.character.create', {
      projectId,
      name: 'Mara',
      appearance: 'Sixties.',
    });
    await run('movie.character.image.generate', { projectId, characterId: mara.id });
    const portrait = provider.imageRequests.at(-1);
    expect(portrait?.references).toHaveLength(1);
    expect(portrait?.prompt).toContain('Sodium orange');
    expect(portrait?.prompt).toContain('only shows the look of the film');

    // A place too.
    const place = await run('world.location.create', { projectId, name: 'Lamp room' });
    await run('world.location.image.generate', { projectId, locationId: place.id });
    const plate = provider.imageRequests.at(-1);
    expect(plate?.references).toHaveLength(1);
    expect(plate?.prompt).toContain('only shows the look of the film');

    // Removing the chosen one passes the choice on; none left means no reference.
    await run('movie.style.image.delete', { projectId, imageId: second.image.id });
    style = await run('movie.style.get', { projectId });
    expect(style.keyImageId).toBe(first.image.id);
    await run('movie.style.image.select', { projectId, imageId: null });
    await run('movie.character.image.generate', { projectId, characterId: mara.id });
    expect(provider.imageRequests.at(-1)?.references).toBeUndefined();
  });
});
