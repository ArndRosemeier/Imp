import type { CutItem, CutLine, SoundPlacement, TextItem } from './schema.js';

/**
 * Tracked changes for a scene's cut. An agent's proposal is a second version
 * of the cut; what it changes is worked out by comparing that version with
 * the cut it started from, piece by piece and by id. Every change can then be
 * kept or thrown away on its own, and kept changes land on the cut as it is
 * now, even when the person went on editing while the agent worked.
 */

/** The parts of a cut that changes are tracked in. Items are always explicit here. */
export interface CutParts {
  readonly items: readonly CutItem[];
  readonly sounds: readonly SoundPlacement[];
  readonly lines: readonly CutLine[];
  readonly texts: readonly TextItem[];
}

export type ChangePart = 'item' | 'sound' | 'line' | 'text';
export type ChangeKind = 'added' | 'removed' | 'changed' | 'moved';

export interface FieldChange {
  readonly name: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface CutChange {
  /** Stable for as long as the change exists: `item:<id>:trimmed` style. */
  readonly id: string;
  readonly part: ChangePart;
  readonly kind: ChangeKind;
  /** The id of the item, placement or line. */
  readonly elementId: string;
  /** For kind "changed": what differs, field by field. */
  readonly fields: readonly FieldChange[];
}

interface Element {
  readonly id: string;
}

/** Whether two stored values are the same, whatever order their keys were written in. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => same(value, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!same(left[key], right[key])) return false;
  }
  return true;
}

function fieldChanges(before: object, after: object): FieldChange[] {
  const left = before as Record<string, unknown>;
  const right = after as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(
    (key) => key !== 'id',
  );
  return keys
    .filter((key) => !same(left[key], right[key]))
    .map((name) => ({ name, before: left[name], after: right[name] }));
}

/**
 * The ids that kept their order from one list to the other: the longest
 * common subsequence. Whatever is in both lists but not in it was moved.
 */
function keptInOrder(before: readonly string[], after: readonly string[]): Set<string> {
  const rows = before.length;
  const columns = after.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(columns + 1).fill(0),
  );
  const cell = (row: number, column: number): number => table[row]?.[column] ?? 0;
  for (let row = rows - 1; row >= 0; row--) {
    for (let column = columns - 1; column >= 0; column--) {
      const value =
        before[row] === after[column]
          ? cell(row + 1, column + 1) + 1
          : Math.max(cell(row + 1, column), cell(row, column + 1));
      const line = table[row];
      if (line !== undefined) line[column] = value;
    }
  }
  const kept = new Set<string>();
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    const id = before[row];
    if (id !== undefined && id === after[column]) {
      kept.add(id);
      row++;
      column++;
    } else if (cell(row + 1, column) >= cell(row, column + 1)) {
      row++;
    } else {
      column++;
    }
  }
  return kept;
}

const changeId = (part: ChangePart, kind: ChangeKind, elementId: string): string =>
  `${part}:${elementId}:${kind}`;

function diffUnordered<T extends Element>(
  part: ChangePart,
  before: readonly T[],
  after: readonly T[],
): CutChange[] {
  const old = new Map(before.map((element) => [element.id, element]));
  const now = new Set(after.map((element) => element.id));
  const changes: CutChange[] = [];
  for (const element of after) {
    const was = old.get(element.id);
    if (was === undefined) {
      changes.push({
        id: changeId(part, 'added', element.id),
        part,
        kind: 'added',
        elementId: element.id,
        fields: [],
      });
    } else if (!same(was, element)) {
      changes.push({
        id: changeId(part, 'changed', element.id),
        part,
        kind: 'changed',
        elementId: element.id,
        fields: fieldChanges(was, element),
      });
    }
  }
  for (const element of before) {
    if (!now.has(element.id)) {
      changes.push({
        id: changeId(part, 'removed', element.id),
        part,
        kind: 'removed',
        elementId: element.id,
        fields: [],
      });
    }
  }
  return changes;
}

/**
 * What changed from one version of a cut to another: items in the order they
 * play in the new version (added, changed, moved), then removed items, then
 * the audio lane, the character lanes and the text lane.
 */
export function diffCut(before: CutParts, after: CutParts): CutChange[] {
  const old = new Map(before.items.map((item) => [item.id, item]));
  const now = new Set(after.items.map((item) => item.id));
  const kept = keptInOrder(
    before.items.map((item) => item.id).filter((id) => now.has(id)),
    after.items.map((item) => item.id).filter((id) => old.has(id)),
  );
  const changes: CutChange[] = [];
  for (const item of after.items) {
    const was = old.get(item.id);
    if (was === undefined) {
      changes.push({
        id: changeId('item', 'added', item.id),
        part: 'item',
        kind: 'added',
        elementId: item.id,
        fields: [],
      });
      continue;
    }
    if (!kept.has(item.id)) {
      changes.push({
        id: changeId('item', 'moved', item.id),
        part: 'item',
        kind: 'moved',
        elementId: item.id,
        fields: [],
      });
    }
    if (!same(was, item)) {
      changes.push({
        id: changeId('item', 'changed', item.id),
        part: 'item',
        kind: 'changed',
        elementId: item.id,
        fields: fieldChanges(was, item),
      });
    }
  }
  for (const item of before.items) {
    if (!now.has(item.id)) {
      changes.push({
        id: changeId('item', 'removed', item.id),
        part: 'item',
        kind: 'removed',
        elementId: item.id,
        fields: [],
      });
    }
  }
  return [
    ...changes,
    ...diffUnordered('sound', before.sounds, after.sounds),
    ...diffUnordered('line', before.lines, after.lines),
    ...diffUnordered('text', before.texts, after.texts),
  ];
}

/** The same change seen from the other side: what undoes it. */
export function mirror(change: CutChange): CutChange {
  const kind: ChangeKind =
    change.kind === 'added' ? 'removed' : change.kind === 'removed' ? 'added' : change.kind;
  return {
    ...change,
    id: changeId(change.part, kind, change.elementId),
    kind,
    fields: change.fields.map((field) => ({
      name: field.name,
      before: field.after,
      after: field.before,
    })),
  };
}

/**
 * Where an item goes in a list so that it follows what it follows in the
 * source: right after the nearest item before it in the source that the list
 * also has, or first.
 */
function placeAfterPredecessor(
  list: CutItem[],
  source: readonly CutItem[],
  item: CutItem,
): CutItem[] {
  const at = source.findIndex((candidate) => candidate.id === item.id);
  for (let index = at - 1; index >= 0; index--) {
    const before = source[index];
    if (before === undefined) continue;
    const found = list.findIndex((candidate) => candidate.id === before.id);
    if (found >= 0) return [...list.slice(0, found + 1), item, ...list.slice(found + 1)];
  }
  return [item, ...list];
}

function applyUnordered<T extends Element>(
  target: readonly T[],
  source: readonly T[],
  change: CutChange,
): T[] {
  const wanted = source.find((element) => element.id === change.elementId);
  const has = target.some((element) => element.id === change.elementId);
  if (change.kind === 'removed') return target.filter((e) => e.id !== change.elementId);
  if (wanted === undefined) return [...target];
  if (change.kind === 'added') return has ? [...target] : [...target, wanted];
  return target.map((element) => (element.id === change.elementId ? wanted : element));
}

/**
 * Carries changes over from source to target: added pieces are put in, removed
 * ones taken out, changed ones replaced by the source's version and moved
 * items put in the source's order. Applied in the order given, which should be
 * the order diffCut returns, so that new items find the items they follow.
 * Changes whose piece the target no longer has are skipped.
 */
export function applyChanges(
  target: CutParts,
  source: CutParts,
  changes: readonly CutChange[],
): CutParts {
  let items = [...target.items];
  let sounds = [...target.sounds];
  let lines = [...target.lines];
  let texts = [...target.texts];
  for (const change of changes) {
    if (change.part === 'text') {
      texts = applyUnordered(texts, source.texts, change);
      continue;
    }
    if (change.part === 'sound') {
      sounds = applyUnordered(sounds, source.sounds, change);
      continue;
    }
    if (change.part === 'line') {
      lines = applyUnordered(lines, source.lines, change);
      continue;
    }
    const wanted = source.items.find((item) => item.id === change.elementId);
    const index = items.findIndex((item) => item.id === change.elementId);
    if (change.kind === 'removed') {
      items = items.filter((item) => item.id !== change.elementId);
    } else if (wanted === undefined) {
      continue;
    } else if (change.kind === 'changed') {
      if (index >= 0) items[index] = wanted;
    } else if (change.kind === 'added') {
      if (index < 0) items = placeAfterPredecessor(items, source.items, wanted);
    } else if (index >= 0) {
      // Moved: taken out, then put back where the source has it, as it is in the target.
      const current = items[index] ?? wanted;
      items = placeAfterPredecessor(
        items.filter((item) => item.id !== change.elementId),
        source.items,
        current,
      );
    }
  }
  return { items, sounds, lines, texts };
}
