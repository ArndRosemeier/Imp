import { useRef, useState, type PointerEvent } from 'react';

/**
 * Follows a pointer across the page while a button or finger is held, and
 * reports the distance in the end. A finger must move further than a mouse
 * before it counts as a drag rather than a tap.
 */
/** A pointer being dragged: what it holds, by which edge, and how far it moved. */
export interface Dragging {
  readonly id: string;
  readonly edge: string;
  readonly dx: number;
}

export interface Drag {
  readonly dragging: Dragging | null;
  readonly start: (event: PointerEvent, id: string, edge: string) => void;
  readonly move: (event: PointerEvent) => void;
  readonly end: (
    event: PointerEvent,
    done: (id: string, edge: string, distance: number) => void,
  ) => void;
  readonly cancel: () => void;
}

export function useDrag(): Drag {
  const [dragging, setDragging] = useState<{
    id: string;
    edge: string;
    dx: number;
  } | null>(null);
  const origin = useRef(0);
  const slop = useRef(2);
  return {
    dragging,
    start: (event: PointerEvent, id: string, edge: string) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      origin.current = event.clientX;
      slop.current = event.pointerType === 'touch' ? 8 : 2;
      setDragging({ id, edge, dx: 0 });
    },
    move: (event: PointerEvent) => {
      setDragging((before) =>
        before === null ? null : { ...before, dx: event.clientX - origin.current },
      );
    },
    end: (event: PointerEvent, done: (id: string, edge: string, distance: number) => void) => {
      if (dragging === null) return;
      event.currentTarget.releasePointerCapture(event.pointerId);
      const { id, edge, dx } = dragging;
      setDragging(null);
      if (Math.abs(dx) >= slop.current) done(id, edge, dx);
    },
    /** The browser took the pointer, for example to scroll: nothing changes. */
    cancel: () => {
      setDragging(null);
    },
  };
}

/** A finger on a piece that is not selected scrolls the timeline; it must be selected to move. */
export const grabs = (event: PointerEvent, selected: boolean): boolean =>
  event.pointerType !== 'touch' || selected;
