import { XIcon } from '@phosphor-icons/react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

/**
 * A button that opens a panel beside it: the Edit screen's menus (Export,
 * Look, Add). The panel stays mounted while closed, so work it started, such
 * as recording an export, goes on. It closes on Escape and on a tap outside.
 */
export function Popover({
  label,
  title,
  icon,
  text,
  badge,
  side = 'down',
  align = 'end',
  disabled = false,
  wide = false,
  bare = false,
  className = '',
  children,
}: {
  /** The button's accessible name, and its tooltip. */
  label: string;
  /** The panel's heading; the label when left out. */
  title?: string;
  icon?: ReactNode;
  /** Words shown on the button beside the icon; icon only when left out. */
  text?: ReactNode;
  /** A small count or state on the button, such as the export's progress. */
  badge?: string | null;
  side?: 'down' | 'up';
  align?: 'start' | 'end';
  disabled?: boolean;
  wide?: boolean;
  /** The content brings its own heading and close button. */
  bare?: boolean;
  className?: string;
  children: ReactNode | ((close: () => void) => ReactNode);
}): ReactElement {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = (): void => {
    setOpen(false);
  };
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      // A dialog opened from the panel lives elsewhere in the page; using it keeps the panel.
      if (target instanceof Element && target.closest('dialog[open]') !== null) return;
      if (target !== null && root.current?.contains(target) !== true) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  const panel = useRef<HTMLDivElement>(null);
  // The panel never reaches past the stage: on a short screen (a tablet) a panel that opens
  // upwards from the timeline would otherwise slide under the top bar.
  useLayoutEffect(() => {
    const element = panel.current;
    const trigger = root.current;
    if (!open || element === null || trigger === null) return;
    const fit = (): void => {
      const box = trigger.getBoundingClientRect();
      const stageTop = trigger.closest('.main')?.getBoundingClientRect().top ?? 0;
      const room = side === 'up' ? box.top - stageTop - 16 : window.innerHeight - box.bottom - 16;
      element.style.maxHeight = `${String(Math.max(160, Math.min(600, room)))}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => {
      window.removeEventListener('resize', fit);
    };
  }, [open, side]);
  const heading = title ?? label;
  return (
    <div className={`popover ${className}`} ref={root}>
      <button
        type="button"
        className={`button quiet popover-trigger${text === undefined ? ' icon-only' : ''}`}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {icon}
        {text !== undefined && <span className="popover-text">{text}</span>}
        {badge !== undefined && badge !== null && <span className="popover-badge">{badge}</span>}
      </button>
      <div
        ref={panel}
        className={`popover-panel${wide ? ' wide' : ''}`}
        data-side={side}
        data-align={align}
        role="dialog"
        aria-label={heading}
        hidden={!open}
      >
        {!bare && (
          <div className="popover-head">
            <span className="popover-title">{heading}</span>
            <button
              type="button"
              className="button quiet icon-only"
              aria-label={`Close ${heading.toLowerCase()}`}
              onClick={close}
            >
              <XIcon aria-hidden="true" />
            </button>
          </div>
        )}
        <div className="popover-body">
          {typeof children === 'function' ? children(close) : children}
        </div>
      </div>
    </div>
  );
}

/** The editor's keys, as the help lists them. */
const KEYS: readonly (readonly [string, string])[] = [
  ['Space', 'Play or pause'],
  ['S', 'Split the selected shot at the playhead'],
  [', and .', 'One frame back or on'],
  ['I and O', 'Mark the start and end of a stretch to ask the crew about'],
  ['Esc', 'Clear the marked stretch'],
  ['M', 'Leave a marker at the playhead'],
  ['Ctrl C, X, V', 'Copy, cut and paste the selected piece'],
  ['Delete', 'Remove the selected piece'],
  ['Ctrl Z', 'Undo; with Shift, redo'],
  ['Ctrl + wheel', 'Zoom the timeline'],
];

const GESTURES: readonly (readonly [string, string])[] = [
  ['Tap', 'Select a piece on the timeline'],
  ['Drag a selected piece', 'Move it onto another to reorder; audio slides sideways'],
  ['Drag an end', 'Trim the piece'],
  ['Swipe', 'Scroll the timeline'],
  ['Pinch', 'Zoom the timeline or the film strip'],
  ['Drag the time ruler', 'Move the playhead'],
  ['Drag the bar above the tools', 'Give the picture or the timeline more room'],
];

/** How the editor is used: its gestures and keys, out of the way until asked for. */
export function EditHelp({
  open,
  coarse,
  onClose,
}: {
  open: boolean;
  /** A finger is the pointer, so gestures come first. */
  coarse: boolean;
  onClose: () => void;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      if (typeof element.showModal === 'function') element.showModal();
      else element.setAttribute('open', '');
    }
    if (!open && element.open) element.close();
  }, [open]);
  const table = (rows: readonly (readonly [string, string])[], caption: string): ReactElement => (
    <table className="edit-help-table">
      <caption className="eyebrow">{caption}</caption>
      <tbody>
        {rows.map(([keys, what]) => (
          <tr key={keys}>
            <th scope="row">
              <kbd>{keys}</kbd>
            </th>
            <td>{what}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <dialog
      ref={dialog}
      className="modal wide edit-help"
      aria-label="Using the editor"
      onClose={onClose}
    >
      <div className="stack modal-body">
        <div className="row edit-help-head">
          <h2>Using the editor</h2>
          <button
            type="button"
            className="button quiet icon-only"
            aria-label="Close the help"
            onClick={onClose}
          >
            <XIcon aria-hidden="true" />
          </button>
        </div>
        <p className="muted">
          Select a piece on the timeline to change it in the panel beside the picture. Mark in and
          out to send a stretch with your next message to the crew. Exports run in the background
          from the Export menu, and the Film Editor can do all of this too.
        </p>
        <div className="edit-help-columns">
          {coarse ? table(GESTURES, 'Touch') : table(KEYS, 'Keys')}
          {coarse ? table(KEYS, 'With a keyboard') : table(GESTURES, 'Touch')}
        </div>
      </div>
    </dialog>
  );
}

const HEIGHT_KEY = 'imp.edit.timeline-height';

/**
 * The timeline's share of the editor's height, set by dragging the bar between
 * the picture and the tools and remembered in this browser. Null is the
 * default share, which the stylesheet sets.
 */
export function useTimelineHeight(): {
  height: number | null;
  set: (height: number | null) => void;
} {
  const [height, setHeight] = useState<number | null>(() => {
    try {
      const stored = Number(localStorage.getItem(HEIGHT_KEY));
      return Number.isFinite(stored) && stored > 0 ? stored : null;
    } catch {
      return null;
    }
  });
  return {
    height,
    set: (next) => {
      setHeight(next);
      try {
        if (next === null) localStorage.removeItem(HEIGHT_KEY);
        else localStorage.setItem(HEIGHT_KEY, String(Math.round(next)));
      } catch {
        // Remembering is a convenience; without storage the height lasts this visit.
      }
    },
  };
}

/** The least room the picture and the timeline each keep, in pixels. */
const LEAST_PICTURE = 120;
const LEAST_TIMELINE = 140;

/**
 * The bar between the picture and the timeline. Dragging it up gives the
 * timeline more room, down gives it to the picture; arrow keys step it, and a
 * double click goes back to the default.
 */
export function SplitBar({
  height,
  measure,
  onHeight,
}: {
  height: number | null;
  /** The editor's height and the timeline block's current height. */
  measure: () => { total: number; timeline: number } | null;
  onHeight: (height: number | null) => void;
}): ReactElement {
  const drag = useRef<{ y: number; start: number; total: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const bounded = (value: number, total: number): number =>
    Math.max(LEAST_TIMELINE, Math.min(total - LEAST_PICTURE, value));
  const down = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const sizes = measure();
    if (sizes === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { y: event.clientY, start: sizes.timeline, total: sizes.total };
    setDragging(true);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = drag.current;
    if (start === null) return;
    onHeight(bounded(start.start + (start.y - event.clientY), start.total));
  };
  const up = (): void => {
    drag.current = null;
    setDragging(false);
  };
  const keys = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = { ArrowUp: 24, ArrowDown: -24 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const sizes = measure();
    if (sizes !== null) onHeight(bounded(sizes.timeline + step, sizes.total));
  };
  return (
    // A focusable separator is a widget (a splitter) by the ARIA specification.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className="edit-splitbar"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Room for the picture and the timeline"
      aria-valuenow={height === null ? undefined : Math.round(height)}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      data-dragging={dragging}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => {
        onHeight(null);
      }}
      onKeyDown={keys}
    >
      <span aria-hidden="true" />
    </div>
  );
}
