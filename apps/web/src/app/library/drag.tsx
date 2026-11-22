import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import type { Asset } from './model.js';
import { t, tx } from '../../i18n/i18n.js';

/** Where an asset was let go, or null when it was placed from the "Use in" menu. */
export type DropPoint = { readonly clientX: number; readonly clientY: number } | null;

export interface DropTargetSpec {
  /** What the target is, in the "Use in" menu: "Audio editor, at the playhead". */
  readonly label: string;
  readonly accepts: (asset: Asset) => boolean;
  /** Places the asset. A rejection is shown to the person. */
  readonly onDrop: (asset: Asset, point: DropPoint) => Promise<void> | void;
}

interface Registered {
  readonly id: number;
  readonly ref: RefObject<HTMLElement | null>;
  readonly spec: RefObject<DropTargetSpec>;
}

interface DragApi {
  readonly register: (target: Registered) => () => void;
  /** The targets on screen now that take the asset, for the "Use in" menu. */
  readonly targetsFor: (asset: Asset) => { id: number; label: string }[];
  readonly place: (asset: Asset, targetId: number) => Promise<void>;
  readonly begin: (asset: Asset, x: number, y: number) => void;
  /** What went wrong at the last drop, until the next one. */
  readonly problem: string | null;
  readonly clearProblem: () => void;
}

const DragContext = createContext<DragApi | null>(null);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Puts the words of a text where a text field's cursor is, through the
 * field's own input event, so React and undo both see an ordinary edit.
 */
function insertIntoField(field: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  field.focus();
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  const next = field.value.slice(0, start) + text + field.value.slice(end);
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, next);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.setSelectionRange(start + text.length, start + text.length);
}

const textField = (element: Element | null): HTMLInputElement | HTMLTextAreaElement | null => {
  const field = element?.closest('textarea, input');
  if (field instanceof HTMLTextAreaElement && !field.readOnly && !field.disabled) return field;
  if (
    field instanceof HTMLInputElement &&
    ['text', 'search', ''].includes(field.type) &&
    !field.readOnly &&
    !field.disabled
  ) {
    return field;
  }
  return null;
};

/**
 * Carries assets from the library to wherever they are used. Pointer events,
 * not the browser's drag and drop, so a finger on a tablet drags the same as
 * a mouse: hold an item a moment, then move it. While something is carried,
 * every target that takes it is marked, and a text can go into any text field.
 */
export function LibraryDragProvider({ children }: { children: ReactNode }): ReactElement {
  const targets = useRef(new Map<number, Registered>());
  const [carried, setCarried] = useState<{ asset: Asset; x: number; y: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const over = useRef<{ kind: 'target'; id: number } | { kind: 'field'; field: Element } | null>(
    null,
  );

  const mark = useCallback((asset: Asset | null) => {
    for (const target of targets.current.values()) {
      const element = target.ref.current;
      if (element === null) continue;
      if (asset !== null && target.spec.current.accepts(asset)) element.dataset['drop'] = 'ready';
      else delete element.dataset['drop'];
    }
  }, []);

  const hit = useCallback((asset: Asset, x: number, y: number) => {
    const element = document.elementFromPoint(x, y);
    if (element === null) return null;
    // The innermost target under the pointer wins.
    let best: Registered | null = null;
    for (const target of targets.current.values()) {
      const node = target.ref.current;
      if (node === null || !node.contains(element) || !target.spec.current.accepts(asset)) continue;
      if (best === null || best.ref.current?.contains(node) === true) best = target;
    }
    if (best !== null) return { kind: 'target' as const, id: best.id };
    if (asset.text !== null && asset.modality === 'text') {
      const field = textField(element);
      if (field !== null) return { kind: 'field' as const, field };
    }
    return null;
  }, []);

  const highlight = useCallback((next: typeof over.current) => {
    const before = over.current;
    if (before?.kind === 'target') {
      const element = targets.current.get(before.id)?.ref.current;
      if (element !== null && element !== undefined) element.dataset['drop'] = 'ready';
    } else if (before?.kind === 'field') {
      delete (before.field as HTMLElement).dataset['dropOver'];
    }
    over.current = next;
    if (next?.kind === 'target') {
      const element = targets.current.get(next.id)?.ref.current;
      if (element !== null && element !== undefined) element.dataset['drop'] = 'over';
    } else if (next?.kind === 'field') {
      (next.field as HTMLElement).dataset['dropOver'] = 'true';
    }
  }, []);

  const place = useCallback(async (asset: Asset, targetId: number, point: DropPoint = null) => {
    const target = targets.current.get(targetId);
    if (target === undefined) return;
    setProblem(null);
    try {
      await target.spec.current.onDrop(asset, point);
    } catch (error) {
      setProblem(messageOf(error));
    }
  }, []);

  useEffect(() => {
    if (carried === null) return;
    const { asset } = carried;
    mark(asset);
    const move = (event: PointerEvent): void => {
      setCarried((before) =>
        before === null ? null : { ...before, x: event.clientX, y: event.clientY },
      );
      highlight(hit(asset, event.clientX, event.clientY));
    };
    const finish = (): void => {
      highlight(null);
      mark(null);
      setCarried(null);
    };
    const up = (event: PointerEvent): void => {
      const landed = hit(asset, event.clientX, event.clientY);
      finish();
      if (landed?.kind === 'target') {
        void place(asset, landed.id, { clientX: event.clientX, clientY: event.clientY });
      } else if (landed?.kind === 'field' && asset.text !== null) {
        insertIntoField(landed.field, asset.text);
      }
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') finish();
    };
    // A finger that carries something must not scroll the page under it.
    const touch = (event: TouchEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('keydown', key);
    window.addEventListener('touchmove', touch, { passive: false });
    document.body.dataset['carrying'] = asset.modality;
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('keydown', key);
      window.removeEventListener('touchmove', touch);
      delete document.body.dataset['carrying'];
    };
    // Only a new carried asset restarts the drag, not its moving position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carried?.asset, hit, highlight, mark, place]);

  const api = useMemo<DragApi>(
    () => ({
      register: (target) => {
        targets.current.set(target.id, target);
        return () => {
          targets.current.delete(target.id);
        };
      },
      targetsFor: (asset) =>
        [...targets.current.values()]
          .filter((target) => target.ref.current !== null && target.spec.current.accepts(asset))
          .map((target) => ({ id: target.id, label: target.spec.current.label })),
      place: (asset, targetId) => place(asset, targetId),
      begin: (asset, x, y) => {
        setProblem(null);
        setCarried({ asset, x, y });
      },
      problem,
      clearProblem: () => {
        setProblem(null);
      },
    }),
    [place, problem],
  );

  return (
    <DragContext.Provider value={api}>
      {children}
      {carried !== null && (
        <div
          className="library-ghost"
          data-modality={carried.asset.modality}
          style={{
            transform: `translate(${String(carried.x + 14)}px, ${String(carried.y + 14)}px)`,
          }}
          aria-hidden="true"
        >
          <span className="eyebrow">{tx(carried.asset.kindLabel)}</span>
          <span className="library-ghost-title">{carried.asset.title}</span>
        </div>
      )}
    </DragContext.Provider>
  );
}

export function useLibraryDrag(): DragApi {
  const api = useContext(DragContext);
  if (api === null) throw new Error(t('useLibraryDrag must be used inside LibraryDragProvider.'));
  return api;
}

let nextTargetId = 0;

/**
 * Makes an element a place library assets can be dropped on. The spec may
 * change every render; the latest one is used. Outside a LibraryDragProvider
 * (some tests) it does nothing.
 */
export function useLibraryDrop(ref: RefObject<HTMLElement | null>, spec: DropTargetSpec): void {
  const api = useContext(DragContext);
  const latest = useRef(spec);
  useEffect(() => {
    latest.current = spec;
  });
  const register = api?.register;
  useEffect(() => {
    if (register === undefined) return undefined;
    return register({ id: ++nextTargetId, ref, spec: latest });
  }, [register, ref]);
}

/** How far a mouse moves before a press becomes a drag, and how long a finger holds. */
const MOVE_PX = 6;
const HOLD_MS = 320;

/**
 * Pointer handlers that start carrying an asset: a mouse or pen after a small
 * move, a finger after holding still a moment (so a swipe still scrolls).
 */
export function useDragSource(asset: Asset): {
  onPointerDown: (event: ReactPointerEvent) => void;
  onPointerMove: (event: ReactPointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onContextMenu: (event: { preventDefault: () => void }) => void;
} {
  const api = useContext(DragContext);
  const press = useRef<{ x: number; y: number; touch: boolean; timer: number } | null>(null);
  const clear = (): void => {
    if (press.current !== null) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  return {
    onPointerDown: (event) => {
      if (api === null || event.button !== 0) return;
      const touch = event.pointerType === 'touch';
      const { clientX, clientY } = event;
      clear();
      press.current = {
        x: clientX,
        y: clientY,
        touch,
        timer: touch
          ? window.setTimeout(() => {
              press.current = null;
              if ('vibrate' in navigator) navigator.vibrate(8);
              api.begin(asset, clientX, clientY);
            }, HOLD_MS)
          : 0,
      };
    },
    onPointerMove: (event) => {
      const start = press.current;
      if (start === null || api === null) return;
      const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      if (start.touch) {
        // Moving before the hold is up is a scroll, not a drag.
        if (distance > MOVE_PX * 2) clear();
      } else if (distance > MOVE_PX) {
        clear();
        api.begin(asset, event.clientX, event.clientY);
      }
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    // A long press on a tablet would open the system's menu instead.
    onContextMenu: (event) => {
      if (press.current?.touch === true) event.preventDefault();
    },
  };
}
