import { useEffect, useRef, useState, type RefObject } from 'react';

const COARSE = '(pointer: coarse)';

/** Test environments without `matchMedia` match nothing. */
const mediaQuery = (query: string): MediaQueryList | null =>
  typeof matchMedia === 'function' ? matchMedia(query) : null;

/** Whether the main pointer is a finger (a tablet) rather than a mouse or pen, right now. */
export const isCoarsePointer = (): boolean => mediaQuery(COARSE)?.matches ?? false;

/** Whether a media query matches, following changes such as turning a tablet. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => mediaQuery(query)?.matches ?? false);
  useEffect(() => {
    const list = mediaQuery(query);
    if (list === null) return;
    const update = (): void => {
      setMatches(list.matches);
    };
    update();
    list.addEventListener('change', update);
    return () => {
      list.removeEventListener('change', update);
    };
  }, [query]);
  return matches;
}

/** Whether the main pointer is a finger (a tablet) rather than a mouse or pen. */
export const useCoarsePointer = (): boolean => useMediaQuery(COARSE);

interface TouchPoint {
  readonly clientX: number;
  readonly clientY: number;
}

const spread = (a: TouchPoint, b: TouchPoint): number =>
  Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

/**
 * Two-finger pinch on an element. Calls `onZoom` with the change in spread
 * since the last call (above 1 is apart) and the horizontal middle of the
 * fingers, so the caller can zoom around the point under them.
 *
 * Touch events rather than pointer events: iPadOS Safari hands pinches to the
 * page zoom unless `touchmove` is cancelled, which only a non-passive listener
 * can do. One finger is left alone, for scrolling and dragging.
 */
export function usePinchZoom(
  target: RefObject<HTMLElement | null>,
  onZoom: (factor: number, clientX: number) => void,
): void {
  const latest = useRef(onZoom);
  useEffect(() => {
    latest.current = onZoom;
  });
  useEffect(() => {
    const element = target.current;
    if (element === null) return;
    let last: number | null = null;
    const move = (event: TouchEvent): void => {
      const [a, b] = [event.touches[0], event.touches[1]];
      if (event.touches.length !== 2 || a === undefined || b === undefined) {
        last = null;
        return;
      }
      event.preventDefault();
      const now = spread(a, b);
      if (last !== null && last > 0 && now > 0) {
        latest.current(now / last, (a.clientX + b.clientX) / 2);
      }
      last = now;
    };
    const end = (event: TouchEvent): void => {
      if (event.touches.length < 2) last = null;
    };
    element.addEventListener('touchmove', move, { passive: false });
    element.addEventListener('touchend', end);
    element.addEventListener('touchcancel', end);
    return () => {
      element.removeEventListener('touchmove', move);
      element.removeEventListener('touchend', end);
      element.removeEventListener('touchcancel', end);
    };
  }, [target]);
}
