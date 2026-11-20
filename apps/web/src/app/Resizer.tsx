import { useState, type PointerEvent, type ReactElement } from 'react';

export interface PanelWidth {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly set: (width: number) => void;
  readonly reset: () => void;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Math.round(value), min), max);

/**
 * The width of a side panel, remembered in this browser. It is a preference of
 * the person at this screen and not project data, so it stays out of the store.
 */
export function usePanelWidth(
  name: string,
  bounds: { initial: number; min: number; max: number },
): PanelWidth {
  const key = `imp.width.${name}`;
  const { initial, min, max } = bounds;
  const [value, setValue] = useState(() => {
    const stored = Number(localStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0 ? clamp(stored, min, max) : initial;
  });
  return {
    value,
    min,
    max,
    set: (width) => {
      const next = clamp(width, min, max);
      setValue(next);
      localStorage.setItem(key, String(next));
    },
    reset: () => {
      setValue(initial);
      localStorage.removeItem(key);
    },
  };
}

const STEP = 16;

/**
 * The draggable edge of a side panel. Works with the pointer, with the arrow
 * keys, and resets on a double click.
 */
export function Resizer({
  label,
  side,
  width,
}: {
  label: string;
  /** Which side of the window the panel is on; decides the drag direction. */
  side: 'left' | 'right';
  width: PanelWidth;
}): ReactElement {
  const [drag, setDrag] = useState<{ x: number; width: number } | null>(null);
  const direction = side === 'left' ? 1 : -1;

  const onPointerMove = (event: PointerEvent): void => {
    if (drag !== null) width.set(drag.width + (event.clientX - drag.x) * direction);
  };
  const stop = (): void => {
    setDrag(null);
  };

  return (
    // A focusable separator is a widget (a splitter) by the ARIA specification.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width.value}
      aria-valuemin={width.min}
      aria-valuemax={width.max}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className="resizer"
      data-side={side}
      data-dragging={drag !== null}
      title="Drag to resize. Double click to reset."
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrag({ x: event.clientX, width: width.value });
      }}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={width.reset}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') width.set(width.value - STEP * direction);
        else if (event.key === 'ArrowRight') width.set(width.value + STEP * direction);
        else if (event.key === 'Home') width.set(width.min);
        else if (event.key === 'End') width.set(width.max);
        else return;
        event.preventDefault();
      }}
    />
  );
}
