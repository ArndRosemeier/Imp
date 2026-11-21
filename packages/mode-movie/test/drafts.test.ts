import { describe, expect, it } from 'vitest';
import { applyChanges, diffCut, mirror, same, type CutParts } from '../src/drafts.js';
import {
  PLAIN_PIECE,
  type CutItem,
  type CutLine,
  type SoundPlacement,
  type TextItem,
} from '../src/schema.js';

const item = (id: string, extra: Partial<CutItem> = {}): CutItem => ({
  id,
  kind: 'shot',
  sceneId: 's',
  shotId: id,
  trimStartSeconds: 0,
  trimEndSeconds: 0,
  dialogueVolume: 1,
  clipAudioVolume: 1,
  fadeInSeconds: 0,
  fadeOutSeconds: 0,
  text: '',
  titleSeconds: 3,
  ...PLAIN_PIECE,
  ...extra,
});

const sound = (id: string, startSeconds = 0): SoundPlacement =>
  ({ id, source: 'sound', soundId: 'w', startSeconds, volume: 1 }) as unknown as SoundPlacement;
const line = (id: string, text = 'Hello.'): CutLine =>
  ({ id, characterId: 'n', text, startSeconds: 0 }) as unknown as CutLine;

const parts = (
  items: CutItem[],
  sounds: SoundPlacement[] = [],
  lines: CutLine[] = [],
  texts: TextItem[] = [],
): CutParts => ({
  items,
  sounds,
  lines,
  texts,
});
const ids = (cut: CutParts): string[] => cut.items.map((entry) => entry.id);

describe('same', () => {
  it('ignores the order keys were written in', () => {
    expect(same({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(same({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(same({ a: 1 }, { a: 2 })).toBe(false);
    expect(same([1], { 0: 1 })).toBe(false);
    expect(same([1, 2], [1])).toBe(false);
    expect(same(null, {})).toBe(false);
  });
});

describe('tracked changes of a cut', () => {
  it('finds additions, removals, field changes and moves', () => {
    const base = parts([item('a'), item('b'), item('c'), item('d')], [sound('w1')], [line('l1')]);
    const draft = parts(
      [item('b'), item('a', { trimStartSeconds: 0.8 }), item('n'), item('d')],
      [sound('w1', 2), sound('w2')],
      [],
    );
    const changes = diffCut(base, draft);
    expect(changes.map((change) => change.id)).toEqual([
      'item:a:moved',
      'item:a:changed',
      'item:n:added',
      'item:c:removed',
      'sound:w1:changed',
      'sound:w2:added',
      'line:l1:removed',
    ]);
    expect(changes[1]?.fields).toEqual([{ name: 'trimStartSeconds', before: 0, after: 0.8 }]);
  });

  it('sees nothing when nothing changed', () => {
    const base = parts([item('a'), item('b')], [sound('w')], [line('l')]);
    expect(diffCut(base, parts([item('a'), item('b')], [sound('w')], [line('l')]))).toEqual([]);
  });

  it('keeps everything onto an untouched cut and arrives at the draft', () => {
    const base = parts([item('a'), item('b'), item('c')], [sound('w1')], [line('l1')]);
    const draft = parts(
      [item('c'), item('x'), item('a', { fadeInSeconds: 1 })],
      [sound('w2')],
      [line('l1', 'Changed.')],
    );
    const kept = applyChanges(base, draft, diffCut(base, draft));
    expect(same(kept, draft)).toBe(true);
  });

  it('lays kept changes onto a cut the person edited meanwhile', () => {
    const base = parts([item('a'), item('b'), item('c')]);
    // The agent trims b and adds a title after it.
    const draft = parts([item('a'), item('b', { trimEndSeconds: 1 }), item('t'), item('c')]);
    // Meanwhile the person removed a and added their own shot at the end.
    const live = parts([item('b'), item('c'), item('p')]);
    const kept = applyChanges(live, draft, diffCut(base, draft));
    expect(ids(kept)).toEqual(['b', 't', 'c', 'p']);
    expect(kept.items[0]?.trimEndSeconds).toBe(1);
  });

  it('keeps single changes and leaves the rest', () => {
    const base = parts([item('a'), item('b')]);
    const draft = parts([item('b'), item('a'), item('n')]);
    const changes = diffCut(base, draft);
    const added = changes.filter((change) => change.kind === 'added');
    const kept = applyChanges(base, draft, added);
    expect(ids(kept)).toEqual(['a', 'n', 'b']);
    expect(diffCut(kept, draft).map((change) => change.kind)).toEqual(['moved']);
  });

  it('puts an added item first when nothing before it survives', () => {
    const base = parts([item('a'), item('b')]);
    const draft = parts([item('n'), item('a'), item('b')]);
    expect(ids(applyChanges(parts([item('b')]), draft, diffCut(base, draft)))).toEqual(['n', 'b']);
  });

  it('skips changes to pieces the target no longer has', () => {
    const base = parts([item('a'), item('b')], [sound('w')], [line('l')]);
    const draft = parts(
      [item('b'), item('a', { fadeOutSeconds: 2 })],
      [sound('w', 3)],
      [line('l', 'x')],
    );
    const kept = applyChanges(parts([], [], []), draft, diffCut(base, draft));
    expect(kept).toEqual(parts([], [], []));
  });

  it('does not add a piece twice', () => {
    const base = parts([], [], []);
    const draft = parts([item('a')], [sound('w')], [line('l')]);
    const twice = applyChanges(draft, draft, diffCut(base, draft));
    expect(same(twice, draft)).toBe(true);
  });

  it('rejects changes by carrying the base version back into the draft', () => {
    const base = parts([item('a'), item('b'), item('c')], [sound('w')]);
    const draft = parts([item('c'), item('a', { trimStartSeconds: 1 }), item('n')], []);
    const changes = diffCut(base, draft);
    const rejected = applyChanges(draft, base, changes.map(mirror));
    expect(same(rejected, base)).toBe(true);
    // A mirrored field change swaps before and after.
    const field = changes.find((change) => change.kind === 'changed');
    expect(field && mirror(field).fields[0]).toEqual({
      name: 'trimStartSeconds',
      before: 1,
      after: 0,
    });
  });
});
