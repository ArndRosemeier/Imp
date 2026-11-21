/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return --
 * Commands run by id answer with untyped output; these tests read it loosely and assert on it.
 */
import { createDefaultAudioCodec } from '@imp/audio';
import { CommandRegistry, createProjectCommands, projectPrefix, settingsCommands } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { createFakeProvider } from '@imp/providers/testing';
import { createWorldCommands } from '@imp/world';
import { describe, expect, it } from 'vitest';
import {
  createMovieMode,
  DEFAULT_TEXT_STYLES,
  placeText,
  styleOf,
  subtitleCues,
  textMotion,
  toSrt,
  toVtt,
  type FilmRenderer,
  type FilmRenderJob,
} from '../src/index.js';
import { utf8 } from '../src/text.js';

const user = { kind: 'user', id: 'arnd' } as const;
const editor = { kind: 'agent', id: 'ed', role: 'film-editor' } as const;
type Actor = typeof user | typeof editor;

/** A renderer that keeps the plan it was given and writes a tiny file. */
function keepingRenderer() {
  const seen: { job?: FilmRenderJob } = {};
  const renderer: FilmRenderer = {
    unavailable: () => null,
    render: async (job) => {
      seen.job = job;
      await job.write(new Uint8Array([1, 2, 3]), 0);
      return {
        mediaType: 'video/mp4',
        extension: 'mp4',
        videoCodec: 'avc',
        audioCodec: 'aac',
        width: 1280,
        height: 720,
        fps: 24,
      };
    },
  };
  return { renderer, seen };
}

/**
 * Two scenes. The first has three ready shots of four seconds; the second
 * shot has a line of Mara's over a silent clip, recorded at 2 seconds. The
 * second scene has one ready shot of four seconds with a line of Jon's in its
 * clip's own sound.
 */
async function setup(renderer?: FilmRenderer) {
  const runtime = createTestRuntime();
  const provider = createFakeProvider({});
  const mode = createMovieMode({
    provider,
    film: { codec: createDefaultAudioCodec(), ...(renderer === undefined ? {} : { renderer }) },
  });
  const registry = new CommandRegistry({ runtime }).register(
    ...createProjectCommands([{ mode: mode.id, ...mode.project }]),
    ...settingsCommands,
    ...mode.commands,
    ...createWorldCommands({ provider }),
  );
  const run = async (id: string, input: object, actor: Actor = user): Promise<any> => {
    const result = await registry.executeById(id, input, { actor, approved: true });
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
  const { id: projectId } = await run('project.create', { name: 'Keeper', mode: 'movie' });
  const p = { projectId };
  const mara = await run('movie.character.create', { ...p, name: 'Mara', part: 'lead' });
  const jon = await run('movie.character.create', { ...p, name: 'Jon', part: 'support' });
  const scene = await run('movie.scene.create', { ...p, heading: 'INT. LAMP ROOM - NIGHT' });
  const other = await run('movie.scene.create', { ...p, heading: 'EXT. CLIFF - DAWN' });
  const shots = [];
  for (const description of ['Stairs.', 'Mara at the lamp.', 'The beam turns.']) {
    shots.push(await run('movie.shot.create', { ...p, sceneId: scene.id, description }));
  }
  const cliff = await run('movie.shot.create', { ...p, sceneId: other.id, description: 'Jon.' });
  const line = 'Hold the light! The ship is close, closer than it has ever been.';
  await run('movie.shot.update', {
    ...p,
    sceneId: scene.id,
    shotId: shots[1].id,
    speakerId: mara.id,
    line,
  });
  await run('movie.shot.update', {
    ...p,
    sceneId: other.id,
    shotId: cliff.id,
    speakerId: jon.id,
    line: 'Morning.',
  });
  const ready = async (sceneId: string, shot: any, silent: boolean, words: string) => {
    const key = `${projectPrefix(projectId)}movie/shots/${sceneId}/${String(shot.id)}`;
    const stored = (await runtime.store.get(key)) as Record<string, unknown>;
    await runtime.store.batch([
      {
        type: 'put',
        key,
        value: {
          ...stored,
          clip: {
            status: 'ready',
            jobId: 'j',
            blobKey: `${key}/clip`,
            mediaType: 'video/mp4',
            prompt: 'p',
            model: 'm',
            portraits: 0,
            progress: null,
            error: null,
            durationSeconds: 4,
            silent,
            costUsd: 0.1,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          dialogue:
            silent && words !== ''
              ? {
                  blobKey: `${key}/dialogue`,
                  mediaType: 'audio/mpeg',
                  line: words,
                  direction: '',
                  model: 'm',
                  durationSeconds: 2,
                  costUsd: 0,
                  createdAt: '2026-01-01T00:00:00.000Z',
                }
              : null,
        },
      },
    ]);
    await runtime.blobs.put(`${key}/clip`, { bytes: new Uint8Array([1]), mediaType: 'video/mp4' });
  };
  await ready(scene.id, shots[0], false, '');
  await ready(scene.id, shots[1], true, line);
  await ready(scene.id, shots[2], false, '');
  await ready(other.id, cliff, false, 'Morning.');
  const at = { projectId, sceneId: scene.id };
  const cut = async (actor: Actor = user, version?: 'cut' | 'draft') =>
    run('movie.edit.get', { ...at, ...(version === undefined ? {} : { version }) }, actor);
  return { runtime, run, failure, at, cut, shots, scene, other, cliff, projectId, line };
}

describe('placing texts in time', () => {
  const targets = {
    items: [{ itemId: 'a', startsAtSeconds: 4, durationSeconds: 4 }],
    spoken: [
      { source: 'shot' as const, id: 'a', who: 'Mara', startsAtSeconds: 4, durationSeconds: 2 },
    ],
  };
  it('keeps its own time without an anchor', () => {
    expect(placeText({ startSeconds: 1, durationSeconds: 2, anchor: null }, targets)).toEqual({
      startSeconds: 1,
      durationSeconds: 2,
      follows: null,
      orphaned: false,
    });
  });
  it('follows a share of a piece or a line', () => {
    expect(
      placeText(
        { startSeconds: 0, durationSeconds: 1, anchor: { on: 'item', id: 'a', from: 0.5, to: 1 } },
        targets,
      ),
    ).toEqual({
      startSeconds: 6,
      durationSeconds: 2,
      follows: 'its piece of the picture',
      orphaned: false,
    });
    expect(
      placeText(
        { startSeconds: 0, durationSeconds: 1, anchor: { on: 'shot', id: 'a', from: 1, to: 0 } },
        targets,
      ),
    ).toMatchObject({ startSeconds: 4, durationSeconds: 2, follows: 'the line of Mara' });
  });
  it('is orphaned when what it follows is gone', () => {
    expect(
      placeText(
        { startSeconds: 3, durationSeconds: 1, anchor: { on: 'lane', id: 'x', from: 0, to: 1 } },
        targets,
      ),
    ).toEqual({
      startSeconds: 3,
      durationSeconds: 1,
      follows: 'a piece that is no longer in the cut',
      orphaned: true,
    });
  });
});

describe('text motion', () => {
  it('fades and rises in, fades out', () => {
    const rise = { enter: 'rise', exit: 'fade', ease: 0.5, roll: false } as const;
    expect(textMotion(rise, 0, 4, 10)).toMatchObject({ opacity: 0, typed: 1, roll: null });
    expect(textMotion(rise, 0, 4, 10).drop).toBeCloseTo(0.025);
    expect(textMotion(rise, 2, 4, 10)).toEqual({ opacity: 1, drop: 0, typed: 1, roll: null });
    expect(textMotion(rise, 3.75, 4, 10).opacity).toBeCloseTo(0.5);
  });
  it('cuts in and out', () => {
    const cut = { enter: 'cut', exit: 'cut', ease: 0, roll: false } as const;
    expect(textMotion(cut, 0, 2, 5).opacity).toBe(1);
    expect(textMotion(cut, 1.99, 2, 5).opacity).toBe(1);
  });
  it('types its letters, never for longer than half its time', () => {
    const type = { enter: 'type', exit: 'cut', ease: 0.2, roll: false } as const;
    expect(textMotion(type, 0.5, 4, 28).typed).toBeCloseTo(0.5);
    expect(textMotion(type, 1, 2, 280).typed).toBe(1);
    expect(textMotion({ ...type, ease: 0 }, 0, 0, 0).typed).toBe(1);
  });
  it('rolls through the frame over its length', () => {
    const roll = { enter: 'cut', exit: 'cut', ease: 0, roll: true } as const;
    expect(textMotion(roll, 5, 10, 100).roll).toBe(0.5);
    expect(textMotion(roll, 0, 0, 100).roll).toBe(1);
  });
  it('shares a short time between coming on and going off', () => {
    const fade = { enter: 'fade', exit: 'fade', ease: 2, roll: false } as const;
    expect(textMotion(fade, 0.5, 1, 4).opacity).toBe(1);
  });
});

describe('subtitles from a line', () => {
  it('keeps a short line whole', () => {
    expect(subtitleCues('  Hold   the light! ')).toEqual([
      { text: 'Hold the light!', from: 0, to: 1 },
    ]);
    expect(subtitleCues('   ')).toEqual([]);
  });
  it('puts short sentences together and gives each subtitle its share of time', () => {
    const cues = subtitleCues('Hold the light! The ship is close. Closer than ever.', 30);
    expect(cues.map((cue) => cue.text)).toEqual([
      'Hold the light!',
      'The ship is close.',
      'Closer than ever.',
    ]);
    expect(cues[0]?.from).toBe(0);
    expect(cues.at(-1)?.to).toBe(1);
    for (const [index, cue] of cues.entries()) {
      if (index > 0) expect(cue.from).toBe(cues[index - 1]?.to);
    }
  });
  it('breaks a long sentence at its pauses, then between words', () => {
    const cues = subtitleCues(
      'When the storm came over the cliffs, the keeper climbed the stairs again and again without rest',
      40,
    );
    expect(cues.every((cue) => cue.text.length <= 40)).toBe(true);
    expect(cues[0]?.text).toBe('When the storm came over the cliffs,');
    expect(cues.map((cue) => cue.text).join(' ')).toBe(
      'When the storm came over the cliffs, the keeper climbed the stairs again and again without rest',
    );
  });
});

describe('subtitle files', () => {
  const cues = [
    { startSeconds: 1.5, endSeconds: 3, text: 'Hold the light!' },
    { startSeconds: 3661.004, endSeconds: 3662, text: 'A --> B' },
  ];
  it('writes SubRip', () => {
    expect(toSrt(cues)).toBe(
      '1\n00:00:01,500 --> 00:00:03,000\nHold the light!\n\n2\n01:01:01,004 --> 01:01:02,000\nA --> B\n',
    );
  });
  it('writes WebVTT', () => {
    expect(toVtt(cues)).toBe(
      'WEBVTT\n\n00:00:01.500 --> 00:00:03.000\nHold the light!\n\n01:01:01.004 --> 01:01:02.000\nA → B\n',
    );
  });
  it('encodes text as UTF-8', () => {
    expect([...utf8('aé→')]).toEqual([97, 0xc3, 0xa9, 0xe2, 0x86, 0x92]);
    expect([...utf8('\uD800x')]).toEqual([0xef, 0xbf, 0xbd, 120]);
  });
});

describe('styles', () => {
  it('finds a text’s style, or its kind’s', () => {
    expect(styleOf(DEFAULT_TEXT_STYLES, { styleId: 'caption', kind: 'title' }).id).toBe('caption');
    expect(styleOf([], { styleId: 'gone', kind: 'subtitle' }).id).toBe('subtitle');
    expect(styleOf([], { styleId: 'gone', kind: 'nothing' as never }).id).toBe('title');
  });
});

describe('the text lane', () => {
  it('adds a text with the defaults of its kind and reads it back', async () => {
    const { run, at, cut } = await setup();
    const added = await run('movie.edit.text.add', {
      ...at,
      kind: 'lower-third',
      text: 'Mara Venn\nKeeper of the light',
      startSeconds: 4.5,
    });
    expect(added).toMatchObject({
      kind: 'lower-third',
      styleId: 'lower-third',
      startSeconds: 4.5,
      durationSeconds: 4.5,
      follows: null,
      orphaned: false,
      generated: false,
    });
    const read = await cut();
    expect(read.texts).toHaveLength(1);
    expect(read.canUndo).toBe(true);
    await run('movie.edit.undo', at);
    expect((await cut()).texts).toEqual([]);
  });

  it('refuses a style or an anchor that is not there', async () => {
    const { failure, at } = await setup();
    expect(
      await failure('movie.edit.text.add', { ...at, kind: 'title', text: 'A', styleId: 'neon' }),
    ).toMatch(/No text style "neon"/);
    expect(
      await failure('movie.edit.text.add', {
        ...at,
        kind: 'title',
        text: 'A',
        anchor: { on: 'item', id: 'nope' },
      }),
    ).toMatch(/No playing item/);
    expect(
      await failure('movie.edit.text.add', {
        ...at,
        kind: 'subtitle',
        text: 'A',
        anchor: { on: 'lane', id: 'nope' },
      }),
    ).toMatch(/No heard line from lane/);
    expect(await failure('movie.edit.text.set', { ...at, textId: 'nope', text: 'B' })).toMatch(
      /No text "nope"/,
    );
  });

  it('follows the piece it is anchored to, and lets go when given a time', async () => {
    const { run, at, shots, cut } = await setup();
    const caption = await run('movie.edit.text.add', {
      ...at,
      kind: 'caption',
      text: 'Fastnet Rock, 1891',
      anchor: { on: 'item', id: shots[2].id, from: 0, to: 0.5 },
    });
    expect(caption).toMatchObject({ startSeconds: 8, durationSeconds: 2 });
    await run('movie.edit.item.set', { ...at, itemId: shots[0].id, trimStartSeconds: 1 });
    expect((await cut()).texts[0]).toMatchObject({ startSeconds: 7, durationSeconds: 2 });

    const moved = await run('movie.edit.text.set', { ...at, textId: caption.id, x: 0.2 });
    expect(moved).toMatchObject({ x: 0.2, anchor: { on: 'item' } });
    const freed = await run('movie.edit.text.set', { ...at, textId: caption.id, startSeconds: 1 });
    expect(freed).toMatchObject({ startSeconds: 1, durationSeconds: 2, anchor: null });
    const tied = await run('movie.edit.text.set', {
      ...at,
      textId: caption.id,
      anchor: { on: 'item', id: shots[0].id },
      styleId: 'title',
      kind: 'title',
      y: null,
    });
    expect(tied).toMatchObject({ startSeconds: 0, durationSeconds: 3, kind: 'title' });
    const loose = await run('movie.edit.text.set', { ...at, textId: caption.id, anchor: null });
    expect(loose).toMatchObject({ anchor: null, startSeconds: 0, durationSeconds: 3 });

    // A text whose piece leaves the cut is kept but not shown, and says so.
    await run('movie.edit.text.set', {
      ...at,
      textId: caption.id,
      anchor: { on: 'item', id: shots[2].id },
    });
    await run('movie.edit.item.remove', { ...at, itemId: shots[2].id });
    expect((await cut()).texts[0]).toMatchObject({ orphaned: true });
    const edl = await run('movie.edit.edl', at);
    expect(edl.text).toContain('TEXT LANE');
    expect(edl.text).toContain('NOT SHOWN');

    expect(await run('movie.edit.text.remove', { ...at, textIds: ['other'] })).toEqual({
      removed: 0,
    });
    expect(await run('movie.edit.text.remove', { ...at, textIds: [caption.id] })).toEqual({
      removed: 1,
    });
  });

  it('makes subtitles that keep up with the lines and replaces only its own', async () => {
    const { run, at, cut, shots, other, projectId } = await setup();
    const own = await run('movie.edit.text.add', {
      ...at,
      kind: 'subtitle',
      text: '[Thunder]',
      startSeconds: 0.5,
    });
    const made = await run('movie.edit.subtitles.generate', { projectId, names: true });
    expect(made.scenes).toEqual([
      { sceneId: at.sceneId, subtitles: 1 },
      { sceneId: other.id, subtitles: 1 },
    ]);
    let texts = (await cut()).texts;
    expect(texts.map((text: any) => text.text)).toEqual([
      '[Thunder]',
      'MARA: Hold the light! The ship is close, closer than it has ever been.',
    ]);
    expect(texts[1]).toMatchObject({
      startSeconds: 4,
      durationSeconds: 2,
      generated: true,
      follows: 'the line of Mara',
    });

    // The line starts later when the first shot is trimmed; its subtitle goes with it.
    await run('movie.edit.item.set', { ...at, itemId: shots[0].id, trimEndSeconds: 1 });
    texts = (await cut()).texts;
    expect(texts[1]).toMatchObject({ startSeconds: 3, durationSeconds: 2 });

    // Made again, without names and split shorter: the old ones go, the hand-made one stays.
    await run('movie.edit.subtitles.generate', { projectId, sceneIds: [at.sceneId] });
    texts = (await cut()).texts;
    expect(texts.map((text: any) => text.id)).toContain(own.id);
    expect(texts).toHaveLength(2);
    expect(texts[1].text).toBe('Hold the light! The ship is close, closer than it has ever been.');

    // A subtitle changed by hand is no longer made, so it stays too.
    await run('movie.edit.text.set', { ...at, textId: texts[1].id, text: 'Hold it!' });
    await run('movie.edit.subtitles.generate', { projectId, sceneIds: [at.sceneId] });
    expect((await cut()).texts).toHaveLength(3);
  });

  it('writes the film’s subtitles as a file timed to the whole film', async () => {
    const { run, runtime, projectId } = await setup();
    await run('movie.edit.subtitles.generate', { projectId });
    const srt = await run('movie.edit.subtitles.export', { projectId });
    expect(srt).toMatchObject({ fileName: 'Keeper.srt', subtitles: 2 });
    const bytes = (await runtime.blobs.get(srt.blobKey))?.bytes ?? new Uint8Array();
    const text = String.fromCharCode(...bytes);
    expect(text).toContain('00:00:04,000 --> 00:00:06,000');
    // The second scene starts after the first's twelve seconds.
    expect(text).toContain('00:00:12,000 --> 00:00:16,000\nMorning.');
    const vtt = await run('movie.edit.subtitles.export', { projectId, format: 'vtt' });
    expect(vtt.mediaType).toBe('text/vtt');
    expect(vtt.preview.startsWith('WEBVTT')).toBe(true);
  });

  it('rolls end credits over a black card at the end of the film', async () => {
    const { run, projectId, other } = await setup();
    const first = await run('movie.edit.credits.generate', { projectId });
    const read = await run('movie.edit.get', { projectId, sceneId: other.id });
    const card = read.items.at(-1);
    expect(card).toMatchObject({ itemId: first.itemId, kind: 'title', text: '' });
    expect(first.text.text).toBe('Keeper\n\nCast\nMara\nJon\n\nMade with Imp');
    expect(first.text).toMatchObject({
      kind: 'credits',
      startSeconds: 4,
      durationSeconds: card.durationSeconds,
    });

    const again = await run('movie.edit.credits.generate', {
      projectId,
      seconds: 12,
      text: 'The End',
    });
    const after = await run('movie.edit.get', { projectId, sceneId: other.id });
    expect(after.items).toHaveLength(2);
    expect(after.items[1].itemId).toBe(again.itemId);
    expect(after.texts).toHaveLength(1);
    expect(after.texts[0]).toMatchObject({ text: 'The End', durationSeconds: 12 });
  });

  it('names the crew in the credits by their role', async () => {
    const { run, runtime, projectId } = await setup();
    await runtime.store.batch([
      { type: 'put', key: 'crew/ed', value: { name: 'Edith', roleId: 'film-editor' } },
      { type: 'put', key: 'crew/x', value: { broken: true } },
    ]);
    const made = await run('movie.edit.credits.generate', { projectId });
    expect(made.text.text).toContain('Crew\nFilm Editor · Edith');
  });

  it('turns an agent’s texts into proposed changes', async () => {
    const { run, at, cut } = await setup();
    await run('movie.edit.text.add', { ...at, kind: 'title', text: 'The Keeper' }, editor);
    expect((await cut()).texts).toEqual([]);
    const proposal = await run('movie.edit.draft.get', at);
    expect(proposal.changes).toHaveLength(1);
    expect(proposal.changes[0]).toMatchObject({ part: 'text', kind: 'added' });
    expect(proposal.changes[0].summary).toBe('Added the title "The Keeper" at 0:00.00');
    await run('movie.edit.draft.keep', at);
    const [title] = (await cut()).texts;
    expect(title.text).toBe('The Keeper');

    await run('movie.edit.text.set', { ...at, textId: title.id, text: 'Keeper' }, editor);
    const changed = await run('movie.edit.draft.get', at);
    expect(changed.changes[0].summary).toBe(
      'Changed the title "Keeper": words "The Keeper" → "Keeper"',
    );
    await run('movie.edit.draft.reject', { ...at, changeIds: [changed.changes[0].id] });
    await run('movie.edit.text.remove', { ...at, textIds: [title.id] }, editor);
    const removed = await run('movie.edit.draft.get', at);
    expect(removed.changes[0].summary).toBe('Removed the title "The Keeper"');
  });
});

describe('text styles', () => {
  it('lists the built-in styles, changes and resets one, and makes new ones', async () => {
    const { run, failure, projectId } = await setup();
    const list = await run('movie.edit.text.style.list', { projectId });
    expect(list.styles.map((style: any) => style.id)).toEqual([
      'title',
      'lower-third',
      'subtitle',
      'caption',
      'credits',
    ]);
    expect(list.styles.every((style: any) => style.builtIn)).toBe(true);

    const yellow = await run('movie.edit.text.style.set', {
      projectId,
      styleId: 'subtitle',
      color: '#ffd84a',
    });
    expect(yellow).toMatchObject({ id: 'subtitle', color: '#ffd84a', font: 'sans' });
    const made = await run('movie.edit.text.style.set', {
      projectId,
      name: 'Chapter',
      basedOn: 'caption',
      size: 6,
    });
    expect(made).toMatchObject({ name: 'Chapter', font: 'mono', size: 6 });
    const copy = await run('movie.edit.text.style.set', { projectId });
    expect(copy.name).toBe('Title copy');
    const styles = (await run('movie.edit.text.style.list', { projectId })).styles;
    expect(styles).toHaveLength(7);
    expect(styles.find((style: any) => style.id === made.id).builtIn).toBe(false);

    expect(await run('movie.edit.text.style.remove', { projectId, styleId: made.id })).toEqual({
      removed: true,
      reset: false,
    });
    expect(await run('movie.edit.text.style.remove', { projectId, styleId: 'subtitle' })).toEqual({
      removed: false,
      reset: true,
    });
    expect(await run('movie.edit.text.style.remove', { projectId, styleId: 'gone' })).toEqual({
      removed: false,
      reset: false,
    });
    const back = (await run('movie.edit.text.style.list', { projectId })).styles;
    expect(back.find((style: any) => style.id === 'subtitle').color).toBe('#ffffff');
    expect(back).toHaveLength(6);

    expect(
      await failure('movie.edit.text.style.set', { projectId, styleId: 'gone', size: 3 }),
    ).toMatch(/No text style "gone"/);
    expect(await failure('movie.edit.text.style.set', { projectId, basedOn: 'gone' })).toMatch(
      /No text style "gone" to start from/,
    );
  });
});

describe('texts in the exported film', () => {
  it('burns the texts in at film times, subtitles only when asked', async () => {
    const keeping = keepingRenderer();
    const { run, at, projectId, other } = await setup(keeping.renderer);
    await run('movie.edit.subtitles.generate', { projectId });
    await run('movie.edit.text.add', {
      projectId,
      sceneId: other.id,
      kind: 'title',
      text: 'Dawn',
      startSeconds: 3,
      durationSeconds: 5,
    });
    await run('movie.edit.text.add', { ...at, kind: 'caption', text: 'Late', startSeconds: 30 });
    await run('movie.edit.export', { projectId });
    const texts = keeping.seen.job?.plan.texts ?? [];
    expect(texts.map((text) => [text.kind, text.startSeconds, text.durationSeconds])).toEqual([
      ['subtitle', 4, 2],
      ['subtitle', 12, 4],
      // Cut at the end of its scene's picture.
      ['title', 15, 1],
    ]);
    expect(texts[2]?.style.id).toBe('title');

    await run('movie.edit.export', { projectId, subtitles: false });
    expect((keeping.seen.job?.plan.texts ?? []).map((text) => text.kind)).toEqual(['title']);
  });
});
