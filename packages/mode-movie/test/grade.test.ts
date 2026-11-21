import { CommandRegistry, projectCommands } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { createFakeProvider } from '@imp/providers/testing';
import { describe, expect, it } from 'vitest';
import {
  applyMatrix,
  colorStats,
  combine,
  gradeMatrix,
  gradeStats,
  gradeText,
  IDENTITY_MATRIX,
  isNeutral,
  matchGrade,
  NEUTRAL_GRADE,
  pieceMatrix,
  type ColorStats,
  type Grade,
} from '../src/grade.js';
import { createMovieMode, type ColorSampler } from '../src/index.js';

const grade = (fields: Partial<Grade>): Grade => ({ ...NEUTRAL_GRADE, ...fields });

/** One pixel through a matrix, as the renderer draws it. */
const through = (matrix: readonly number[], rgb: [number, number, number]): number[] => {
  const pixels = new Uint8ClampedArray([...rgb, 255]);
  applyMatrix(pixels, matrix);
  return [...pixels.slice(0, 3)];
};

describe('colour grades', () => {
  it('leave a neutral grade alone and combine matrices in order', () => {
    expect(isNeutral(NEUTRAL_GRADE)).toBe(true);
    expect(gradeMatrix(NEUTRAL_GRADE)).toBe(IDENTITY_MATRIX);
    expect(pieceMatrix(NEUTRAL_GRADE, NEUTRAL_GRADE)).toBeNull();
    expect(combine(IDENTITY_MATRIX, IDENTITY_MATRIX)).toEqual(IDENTITY_MATRIX);
    const brighter = gradeMatrix(grade({ exposure: 1 }));
    const flat = gradeMatrix(grade({ contrast: -0.5 }));
    // Doubling then flattening is not flattening then doubling.
    expect(through(combine(brighter, flat), [32, 32, 32])).toEqual([96, 96, 96]);
    expect(through(combine(flat, brighter), [32, 32, 32])[0]).toBeGreaterThanOrEqual(159);
    expect(pieceMatrix(grade({ exposure: 1 }), grade({ contrast: -0.5 }))).toEqual(
      combine(brighter, flat),
    );
  });

  it('brightens by stops, warms, tints and takes colour away', () => {
    expect(through(gradeMatrix(grade({ exposure: 1 })), [50, 60, 70])).toEqual([100, 120, 140]);
    const [r, g, b] = through(gradeMatrix(grade({ temperature: 1 })), [100, 100, 100]);
    expect(r).toBeGreaterThan(100);
    expect(g).toBe(100);
    expect(b).toBeLessThan(100);
    expect(through(gradeMatrix(grade({ tint: 1 })), [100, 100, 100])[1]).toBeLessThan(100);
    const [gr, gg, gb] = through(gradeMatrix(grade({ saturation: -1 })), [200, 50, 50]);
    expect(gr).toBe(gg);
    expect(gg).toBe(gb);
    // Clipped at white, never past it.
    expect(through(gradeMatrix(grade({ exposure: 3 })), [200, 200, 200])).toEqual([255, 255, 255]);
    expect(gradeText(grade({ exposure: 0.5, saturation: -0.25 }))).toBe(
      'exposure +0.50, saturation -0.25',
    );
  });

  it('reads the colours of pixels and works out what a grade does to them', () => {
    expect(colorStats([], 3)).toEqual({ mean: [0, 0, 0], luma: 0, lumaSpread: 0, chroma: 0 });
    const grey = colorStats([128, 128, 128, 255, 128, 128, 128, 255], 4);
    expect(grey.luma).toBeCloseTo(128 / 255);
    expect(grey.lumaSpread).toBeCloseTo(0);
    expect(grey.chroma).toBeCloseTo(0);
    const mixed = colorStats([0, 0, 0, 255, 255, 255], 3);
    expect(mixed.lumaSpread).toBeCloseTo(0.5);
    const doubled = gradeStats(grey, gradeMatrix(grade({ exposure: 1 })));
    expect(doubled.luma).toBeCloseTo((2 * 128) / 255);
  });

  it('matches a frame to a reference closely in brightness and white balance', () => {
    // A dull, cool frame and a bright, warm, contrasty one.
    const dull: ColorStats = { mean: [0.3, 0.32, 0.38], luma: 0.32, lumaSpread: 0.1, chroma: 0.03 };
    const warm: ColorStats = { mean: [0.6, 0.5, 0.4], luma: 0.51, lumaSpread: 0.2, chroma: 0.07 };
    const matched = matchGrade(dull, warm);
    expect(matched.exposure).toBeGreaterThan(0);
    expect(matched.temperature).toBeGreaterThan(0);
    expect(matched.contrast).toBeGreaterThan(0);
    const after = gradeStats(dull, gradeMatrix(matched));
    expect(after.luma).toBeCloseTo(warm.luma, 1);
    expect(after.mean[0] - after.mean[2]).toBeCloseTo(warm.mean[0] - warm.mean[2], 1);
    // A frame matched to itself needs next to nothing.
    for (const value of Object.values(matchGrade(warm, warm))) {
      expect(Math.abs(value)).toBeLessThan(0.05);
    }
  });
});

describe('the look of the film and matching shots', () => {
  const user = { kind: 'user', id: 'arnd' } as const;
  const editor = { kind: 'agent', id: 'fe', role: 'film-editor' } as const;

  async function setup(colorSampler?: ColorSampler) {
    const runtime = createTestRuntime();
    const registry = new CommandRegistry({ runtime }).register(
      ...projectCommands,
      ...createMovieMode({
        provider: createFakeProvider({}),
        ...(colorSampler === undefined ? {} : { colorSampler }),
      }).commands,
    );
    const run = async (
      id: string,
      input: Record<string, unknown>,
      actor: typeof user | typeof editor = user,
    ): Promise<Record<string, unknown>> => {
      const result = await registry.executeById(id, { projectId, ...input }, { actor });
      if (result.status !== 'ok') {
        throw new Error(`${id}: ${JSON.stringify(result)}`);
      }
      return result.output as Record<string, unknown>;
    };
    let projectId = '';
    projectId = ((await run('project.create', { name: 'Storm', mode: 'movie' })) as { id: string })
      .id;
    const sceneId = ((await run('movie.scene.create', { heading: 'INT. LAMP' })) as { id: string })
      .id;
    const base = `projects/${projectId}/movie/`;
    const clip = (blobKey: string) => ({
      status: 'ready',
      jobId: 'j',
      blobKey,
      mediaType: 'video/mp4',
      prompt: '',
      model: 'm',
      progress: null,
      error: null,
      durationSeconds: 4,
      silent: true,
      costUsd: null,
      createdAt: new Date(0).toISOString(),
    });
    const shot = (id: string, position: number) => ({
      id,
      sceneId,
      position,
      description: `Shot ${id}`,
      characterIds: [],
      performance: '',
      speakerId: null,
      line: '',
      delivery: '',
      clip: clip(`clip/${id}`),
    });
    await runtime.blobs.put('clip/a', { bytes: new Uint8Array([1]), mediaType: 'video/mp4' });
    await runtime.blobs.put('clip/b', { bytes: new Uint8Array([2]), mediaType: 'video/mp4' });
    await runtime.store.batch([
      { type: 'put', key: `${base}shots/${sceneId}/a`, value: shot('a', 1) },
      { type: 'put', key: `${base}shots/${sceneId}/b`, value: shot('b', 2) },
    ]);
    const edit = (
      id: string,
      input: Record<string, unknown>,
      actor = user as typeof user | typeof editor,
    ) => run(`movie.edit.${id}`, { sceneId, ...input }, actor);
    return { run, edit, sceneId };
  }

  it('sets a look from a preset and by hand, and grades shots by field', async () => {
    const { run, edit } = await setup();
    expect(await run('movie.edit.look.get', {})).toMatchObject({
      look: { ...NEUTRAL_GRADE, preset: null },
      canMatch: false,
    });
    expect(await run('movie.edit.look.set', { preset: 'noir' })).toMatchObject({
      look: { saturation: -1, preset: 'noir' },
    });
    // Changed by hand, it is the film's own look.
    expect(await run('movie.edit.look.set', { contrast: 0.1 })).toMatchObject({
      look: { saturation: -1, contrast: 0.1, preset: null },
    });
    await edit('item.set', { itemId: 'a', grade: { exposure: 0.5 } });
    const after = (await edit('item.set', { itemId: 'a', grade: { temperature: -0.2 } })) as {
      item: { grade: Grade };
    };
    expect(after.item.grade).toEqual(grade({ exposure: 0.5, temperature: -0.2 }));
    const cut = (await edit('get', {})) as {
      look: { contrast: number };
      items: { grade: Grade }[];
    };
    expect(cut.look.contrast).toBe(0.1);
    expect(cut.items[0]?.grade.exposure).toBe(0.5);
    const edl = (await edit('edl', {})) as { text: string };
    expect(edl.text).toContain('grade exposure +0.50, temperature -0.20');
    const film = (await run('movie.edit.film.edl', {})) as { text: string };
    expect(film.text).toContain('LOOK own: exposure -0.15, contrast +0.10, saturation -1.00');
    const card = (await edit('title.add', { text: 'Later' })) as { item: { id: string } };
    await expect(
      edit('item.set', { itemId: card.item.id, grade: { exposure: 1 } }),
    ).rejects.toThrow(/grade/);
    await expect(edit('grade.match', { itemId: 'a', toItemId: 'b' })).rejects.toThrow(
      /cannot read the colours/,
    );
  });

  it('matches a shot to a reference, keeping the reference grade, as a proposal for agents', async () => {
    const stats: Record<number, ColorStats> = {
      1: { mean: [0.3, 0.32, 0.38], luma: 0.32, lumaSpread: 0.1, chroma: 0.03 },
      2: { mean: [0.6, 0.5, 0.4], luma: 0.51, lumaSpread: 0.2, chroma: 0.07 },
    };
    const sampler: ColorSampler = (video, times) =>
      Promise.resolve(
        times.map((_, index) => (index === 2 ? undefined : stats[video.bytes[0] ?? 0])),
      );
    const { run, edit, sceneId } = await setup(sampler);
    expect(await run('movie.edit.look.get', {})).toMatchObject({ canMatch: true });
    const matched = (await edit('grade.match', { itemId: 'a', toItemId: 'b' }, editor)) as {
      item: { grade: Grade };
    };
    expect(matched.item.grade.exposure).toBeGreaterThan(0);
    // The agent's match waits as a proposal; the cut is unchanged until it is kept.
    const cut = (await edit('get', {})) as { items: { grade: Grade }[] };
    expect(cut.items[0]?.grade).toEqual(NEUTRAL_GRADE);
    const draft = (await run('movie.edit.draft.get', { sceneId })) as { changes: unknown[] };
    expect(draft.changes).toHaveLength(1);

    // Graded already, the reference is matched as it looks.
    await edit('item.set', { itemId: 'b', grade: { exposure: -1 } });
    const darker = (await edit('grade.match', { itemId: 'a', toItemId: 'b' })) as {
      item: { grade: Grade };
    };
    expect(darker.item.grade.exposure).toBeLessThan(matched.item.grade.exposure);
    await expect(edit('grade.match', { itemId: 'a', toItemId: 'nope' })).rejects.toThrow(
      /not a shot/,
    );
    const other = (await run('movie.scene.create', { heading: 'EXT. ROCKS' })) as { id: string };
    await expect(
      edit('grade.match', { itemId: 'a', toItemId: 'a', toSceneId: other.id }),
    ).rejects.toThrow(/not a shot/);
  });

  it('says so when the frames cannot be read', async () => {
    const { edit } = await setup(() => Promise.reject(new Error('no decoder')));
    await expect(edit('grade.match', { itemId: 'a', toItemId: 'b' })).rejects.toThrow(
      /could not be read/,
    );
  });
});
