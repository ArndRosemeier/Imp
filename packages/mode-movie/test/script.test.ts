/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call --
 * Commands run by id answer with untyped output; these tests read it loosely and assert on it.
 */
import { CommandRegistry, createProjectCommands, decodeUtf8, settingsCommands } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { createFakeProvider } from '@imp/providers/testing';
import { createWorldCommands } from '@imp/world';
import { describe, expect, it } from 'vitest';
import { createMovieMode } from '../src/index.js';
import { utf8 } from '../src/text.js';

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
  const run = async (id: string, input: object): Promise<any> => {
    const result = await registry.executeById(id, input, { actor: user, approved: true });
    if (result.status !== 'ok') {
      throw new Error(`${id}: ${result.status} ${JSON.stringify((result as any).error ?? '')}`);
    }
    return result.output;
  };
  const failure = async (id: string, input: object): Promise<string> => {
    try {
      const result: any = await registry.executeById(id, input, { actor: user, approved: true });
      return result.status === 'ok' ? 'ok' : String(result.error?.message ?? result.status);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  const { id: projectId } = await run('project.create', { name: 'The Keeper', mode: 'movie' });
  const p = { projectId };
  const mara = await run('movie.character.create', { ...p, name: 'Mara', part: 'lead' });
  const scene = await run('movie.scene.create', {
    ...p,
    heading: 'INT. LAMP ROOM - NIGHT',
    body: 'Rain.\n\nMARA\n(shouting)\nHold the light!\n\nJON (O.S.)\nWhere?',
  });
  const shot = await run('movie.shot.create', { ...p, sceneId: scene.id, description: 'Mara.' });
  await run('movie.shot.update', {
    ...p,
    sceneId: scene.id,
    shotId: shot.id,
    speakerId: mara.id,
    line: 'hold the light',
  });
  const other = await run('movie.shot.create', { ...p, sceneId: scene.id, description: 'Jon.' });
  await run('movie.shot.update', { ...p, sceneId: scene.id, shotId: other.id, line: 'Over here!' });
  return { runtime, run, failure, p, mara, scene, shot, other };
}

describe('the script commands', () => {
  it('lists a scene’s lines with the cast member and the shots that speak them', async () => {
    const { run, p, mara, scene, shot, other } = await setup();
    const listed = await run('movie.script.lines', { ...p, sceneId: scene.id });
    expect(listed.lines).toEqual([
      {
        index: 0,
        speaker: 'MARA',
        characterId: mara.id,
        extension: null,
        direction: 'shouting',
        words: 'Hold the light!',
        shotIds: [shot.id],
      },
      {
        index: 1,
        speaker: 'JON',
        characterId: null,
        extension: 'O.S.',
        direction: '',
        words: 'Where?',
        shotIds: [],
      },
    ]);
    expect(listed.unscripted).toEqual([
      { shotId: other.id, position: 2, speaker: null, words: 'Over here!' },
    ]);
  });

  it('measures the script and counts what is not in it', async () => {
    const { run, p, scene } = await setup();
    const script = await run('movie.script.get', p);
    expect(script.scenes).toEqual([
      expect.objectContaining({ sceneId: scene.id, lines: 2, unscripted: 1 }),
    ]);
    expect(script.pages).toBeGreaterThan(0);
    expect(script.minutes).toBeCloseTo(script.pages, 1);
  });

  it('writes the script as PDF, Fountain and Final Draft', async () => {
    const { runtime, run, p } = await setup();
    const pdf = await run('movie.script.export', { ...p, author: 'Arnd' });
    expect(pdf).toMatchObject({ fileName: 'The-Keeper.pdf', mediaType: 'application/pdf' });
    const bytes = (await runtime.blobs.get(pdf.blobKey))?.bytes ?? new Uint8Array();
    expect(decodeUtf8(bytes.slice(0, 8))).toBe('%PDF-1.4');
    const fountain = await run('movie.script.export', { ...p, format: 'fountain' });
    const text = decodeUtf8((await runtime.blobs.get(fountain.blobKey))?.bytes ?? new Uint8Array());
    expect(text).toContain('Title: The Keeper');
    expect(text).toContain('INT. LAMP ROOM - NIGHT\n\nRain.');
    const fdx = await run('movie.script.export', { ...p, format: 'fdx' });
    expect(fdx.fileName).toBe('The-Keeper.fdx');
    const fdxText = decodeUtf8((await runtime.blobs.get(fdx.blobKey))?.bytes ?? new Uint8Array());
    expect(fdxText).toContain('Number="1"');
    const plain = await run('movie.script.export', { ...p, format: 'fdx', sceneNumbers: false });
    const plainText = decodeUtf8(
      (await runtime.blobs.get(plain.blobKey))?.bytes ?? new Uint8Array(),
    );
    expect(plainText).not.toContain('Number=');
  });

  it('brings in scenes from Fountain text, a Final Draft file or an upload, after the others', async () => {
    const { runtime, run, failure, p } = await setup();
    const added = await run('movie.script.import', {
      ...p,
      text: 'Title: Storm\n\nEXT. CLIFF - DAWN\n= Jon waits.\n\nWind.\n\n.MONTAGE\n\nWaves.',
    });
    expect(added.title).toBe('Storm');
    expect(added.scenes.map((scene: any) => [scene.position, scene.heading])).toEqual([
      [2, 'EXT. CLIFF - DAWN'],
      [3, 'MONTAGE'],
    ]);
    const cliff = await run('movie.scene.get', { ...p, sceneId: added.scenes[0].id });
    expect(cliff).toMatchObject({ summary: 'Jon waits.', body: 'Wind.' });
    await runtime.blobs.put('uploads/x', {
      bytes: utf8(
        '<FinalDraft><Content><Paragraph Type="Scene Heading"><Text>INT. HUT - DAY</Text></Paragraph></Content></FinalDraft>',
      ),
      mediaType: 'application/xml',
    });
    const fromFile = await run('movie.script.import', { ...p, fileKey: 'uploads/x' });
    expect(fromFile.scenes[0]).toMatchObject({ position: 4, heading: 'INT. HUT - DAY' });
    expect(await runtime.blobs.get('uploads/x')).toBeUndefined();
    expect(await failure('movie.script.import', { ...p, text: '  ' })).toMatch(/text or as a file/);
    expect(await failure('movie.script.import', { ...p, fileKey: 'nope' })).toMatch(
      /Nothing is stored/,
    );
    expect(await failure('movie.script.lines', { ...p, sceneId: 'nope' })).toMatch(/No scene/);
  });
});
