import type { Project } from '@imp/core';
import {
  DEFAULT_TEXT_STYLES,
  FAST_READING,
  plainText,
  styleOf,
  TextStyle,
  type TextKind,
  type TextView,
} from '@imp/mode-movie';
import {
  ClosedCaptioningIcon,
  DownloadSimpleIcon,
  FilmSlateIcon,
  LinkBreakIcon,
  LinkSimpleIcon,
  PaletteIcon,
  PlusIcon,
  TextBIcon,
  TextItalicIcon,
  TextUnderlineIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState, type PointerEvent, type ReactElement } from 'react';
import { z } from 'zod';
import { drawLane, drawText, layoutText } from '@imp/host/film';
import { loadTextFonts } from '../host/text-fonts.js';
import { runCommand, useImp, useLive } from './context.js';
import { clock, type Item, type Look } from './cut-player.js';
import { useDrag } from './drag.js';
import { EditableField } from './Field.js';
import { moviePrefix, type Act } from './movie.js';
import { NumberField } from './NumberField.js';
import { Modal, saveFile } from './projects.js';

/** A style as the list gives it: built-in ones can be reset, the film's own removed. */
const StyleEntry = TextStyle.extend({ builtIn: z.boolean() });
export type StyleEntry = z.infer<typeof StyleEntry>;
const Styles = z.object({ styles: z.array(StyleEntry) });

const BUILT_IN: readonly StyleEntry[] = DEFAULT_TEXT_STYLES.map((style) => ({
  ...style,
  builtIn: true,
}));

/** The film's text styles, live. */
export function useTextStyles(project: Project): readonly StyleEntry[] {
  const live = useLive([moviePrefix(project)], async (imp) =>
    Styles.parse(await runCommand(imp, 'movie.edit.text.style.list', { projectId: project.id })),
  );
  return live.data?.styles ?? BUILT_IN;
}

export const KIND_NAMES: Record<TextKind, string> = {
  title: 'Title',
  'lower-third': 'Lower third',
  subtitle: 'Subtitle',
  caption: 'Caption',
  credits: 'Credits',
};

/** What a new text says until it is written. */
const SAMPLE: Record<TextKind, string> = {
  title: 'Title',
  'lower-third': 'Name\nWho they are',
  subtitle: 'Subtitle',
  caption: 'A place, a time',
  credits: 'Cast\nName',
};

/** The words a style is shown with in the style editor. */
const PREVIEW_WORDS: Record<string, string> = {
  title: 'The Lighthouse Keeper',
  'lower-third': 'Mara Venn\nKeeper of the light',
  subtitle: 'Hold the light! The ship is close.',
  caption: 'Fastnet Rock, 1891',
  credits: 'Cast\nMara Venn\nJon Hale',
};

/** A canvas laid exactly over an element, drawn at the screen's pixel density. */
function useCanvas(draw: (g: CanvasRenderingContext2D, width: number, height: number) => void) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [fonts, setFonts] = useState(false);
  useEffect(() => {
    let active = true;
    void loadTextFonts().then(() => {
      if (active) setFonts(true);
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const element = canvas.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setSize({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  const paint = (): void => {
    const element = canvas.current;
    if (element === null || size.width === 0 || size.height === 0) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(size.width * ratio);
    const height = Math.round(size.height * ratio);
    if (element.width !== width) element.width = width;
    if (element.height !== height) element.height = height;
    const g = element.getContext('2d');
    if (g === null) return;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, size.width, size.height);
    draw(g, size.width, size.height);
  };
  return { canvas, paint, ready: fonts, size };
}

/** The title-safe area: texts are kept inside it, 5% in from each edge. */
const TITLE_SAFE = 0.05;
/** The action-safe area, 3.5% in from each edge. */
const ACTION_SAFE = 0.035;
/** How close, in screen pixels, a dragged text comes before it snaps to a guide. */
const SNAP_PX = 8;

/** A text as the preview draws it, with its style. */
function drawnOf(text: TextView, styles: readonly StyleEntry[]) {
  const style = styles.find((candidate) => candidate.id === text.styleId) ?? styleOf(styles, text);
  return {
    kind: text.kind,
    text: text.text,
    style,
    startSeconds: text.startSeconds,
    durationSeconds: text.durationSeconds,
    x: text.x,
    y: text.y,
  };
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where a box dragged by dx, dy lands, snapped to the centre lines and the
 * title-safe edges when it comes close; and which guides it snapped to.
 */
export function snapBox(
  box: Box,
  dx: number,
  dy: number,
  width: number,
  height: number,
): { dx: number; dy: number; guides: string[] } {
  const guides: string[] = [];
  const snap = (
    start: number,
    size: number,
    whole: number,
    names: readonly [string, string, string],
  ): number => {
    const candidates: [number, string][] = [
      [whole / 2 - (start + size / 2), names[1]],
      [whole * TITLE_SAFE - start, names[0]],
      [whole * (1 - TITLE_SAFE) - (start + size), names[2]],
    ];
    let best: [number, string] | null = null;
    for (const candidate of candidates) {
      if (
        Math.abs(candidate[0]) <= SNAP_PX &&
        (best === null || Math.abs(candidate[0]) < Math.abs(best[0]))
      ) {
        best = candidate;
      }
    }
    if (best === null) return 0;
    guides.push(best[1]);
    return best[0];
  };
  const moved = { left: box.left + dx, top: box.top + dy };
  const sx = snap(moved.left, box.width, width, ['left', 'centre-x', 'right']);
  const sy = snap(moved.top, box.height, height, ['top', 'centre-y', 'bottom']);
  return { dx: dx + sx, dy: dy + sy, guides };
}

const inside = (box: Box, width: number, height: number, margin: number): boolean =>
  box.left >= width * margin - 0.5 &&
  box.top >= height * margin - 0.5 &&
  box.left + box.width <= width * (1 - margin) + 0.5 &&
  box.top + box.height <= height * (1 - margin) + 0.5;

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

let measuring: CanvasRenderingContext2D | null | undefined;

/** A canvas of its own to measure texts with, in CSS pixels, outside of drawing. */
function measuringContext(): CanvasRenderingContext2D | null {
  if (measuring === undefined) {
    measuring =
      typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  }
  return measuring;
}

/**
 * The texts over the preview, drawn by the same function as the film export.
 * While the cut plays it is drawn every frame, so fades and rolls are smooth.
 * A selected text gets a frame on the picture: drag it (or use the arrow
 * keys) to place it, with guides for the centre and the title-safe area.
 * When the selected text is not on screen at the playhead, it is shown faint,
 * so that it can still be seen and placed.
 */
export function TextOverlay({
  texts,
  styles,
  at,
  now,
  playing,
  look,
  selectedId = null,
  onPlace,
  onEdit,
}: {
  texts: readonly TextView[];
  styles: readonly StyleEntry[];
  at: number;
  now: () => number;
  playing: boolean;
  look: Look;
  /** The selected text, framed on the picture while the preview is still. */
  selectedId?: string | null;
  /** Puts a text at a new place: shares of the frame, as its x and y. */
  onPlace?: (textId: string, x: number, y: number) => void;
  /** Asked to change the selected text's words (a double tap on its frame). */
  onEdit?: () => void;
}): ReactElement {
  const time = useRef(at);
  time.current = at;
  const [drag, setDrag] = useState<{ dx: number; dy: number; guides: string[] } | null>(null);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const selected = playing ? undefined : texts.find((text) => text.id === selectedId);
  const { canvas, paint, size } = useCanvas((g, width, height) => {
    const seconds = playing ? now() : time.current;
    // The selected text is drawn still (as it looks once it is on), so that it can be seen and placed
    // even at the moment it starts to fade in; faint while it is not on screen at the playhead.
    const still = selected !== undefined && !selected.orphaned;
    drawLane(g, {
      texts: still ? texts.filter((text) => text.id !== selected.id) : texts,
      styles,
      seconds,
      width,
      height,
      card: look.card ? { title: look.title, brightness: look.brightness } : null,
    });
    if (!still) return;
    const drawn = drawnOf(selected, styles);
    const showing =
      seconds >= selected.startSeconds &&
      seconds < selected.startSeconds + selected.durationSeconds;
    const moved =
      drag === null
        ? drawn
        : {
            ...drawn,
            x: (drawn.x ?? drawn.style.x) + drag.dx / width,
            y: (drawn.y ?? drawn.style.y) + drag.dy / height,
          };
    drawText(
      g,
      { ...moved, style: { ...drawn.style, enter: 'cut', exit: 'cut', roll: false } },
      0,
      width,
      height,
      showing || drag !== null ? 1 : 0.45,
    );
  });
  // Drawn again whenever what is shown changes; every frame while playing.
  useEffect(() => {
    if (!playing) {
      paint();
      return;
    }
    let frame = requestAnimationFrame(function tick() {
      paint();
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  });
  const g = measuringContext();
  const box: Box | null =
    selected === undefined || selected.orphaned || g === null || size.width === 0
      ? null
      : (() => {
          const drawn = drawnOf(selected, styles);
          const laid = layoutText(
            g,
            { ...drawn, style: { ...drawn.style, roll: false } },
            size.width,
            size.height,
          );
          const pad = laid.size * 0.3;
          return {
            left: laid.left - pad,
            top: laid.top - pad,
            width: laid.width + pad * 2,
            height: laid.height + pad * 2,
          };
        })();
  const place = (dx: number, dy: number): void => {
    if (selected === undefined || onPlace === undefined) return;
    const drawn = drawnOf(selected, styles);
    const x = Math.min(1, Math.max(0, (drawn.x ?? drawn.style.x) + dx / size.width));
    const y = Math.min(1, Math.max(0, (drawn.y ?? drawn.style.y) + dy / size.height));
    onPlace(selected.id, round3(x), round3(y));
  };
  const moved =
    box === null
      ? null
      : drag === null
        ? box
        : { ...box, left: box.left + drag.dx, top: box.top + drag.dy };
  const safe = moved === null || inside(moved, size.width, size.height, TITLE_SAFE);
  const placed =
    selected === undefined
      ? null
      : (() => {
          const drawn = drawnOf(selected, styles);
          return { x: drawn.x ?? drawn.style.x, y: drawn.y ?? drawn.style.y };
        })();
  return (
    <>
      <canvas ref={canvas} className="preview-text" aria-hidden="true" />
      {moved !== null && onPlace !== undefined && (
        <div className="text-stage">
          <div
            className="safe-area safe-title"
            style={{ inset: `${String(TITLE_SAFE * 100)}%` }}
            aria-hidden="true"
          />
          <div
            className="safe-area safe-action"
            style={{ inset: `${String(ACTION_SAFE * 100)}%` }}
            aria-hidden="true"
          />
          {drag?.guides.includes('centre-x') === true && (
            <div className="snap-guide snap-x" aria-hidden="true" />
          )}
          {drag?.guides.includes('centre-y') === true && (
            <div className="snap-guide snap-y" aria-hidden="true" />
          )}
          <div
            className={`text-frame${safe ? '' : ' unsafe'}${drag === null ? '' : ' dragging'}`}
            style={{ left: moved.left, top: moved.top, width: moved.width, height: moved.height }}
            role="slider"
            tabIndex={0}
            aria-label="Place of the selected text: drag it, or use the arrow keys"
            aria-valuenow={placed === null ? 0 : Math.round(placed.x * 100)}
            aria-valuetext={
              placed === null
                ? undefined
                : `${String(Math.round(placed.x * 100))}% across, ${String(Math.round(placed.y * 100))}% down`
            }
            title={
              safe
                ? 'Drag to place. Double-tap to change the words.'
                : 'Outside the title-safe area: some screens may cut it off.'
            }
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              start.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
              setDrag({ dx: 0, dy: 0, guides: [] });
            }}
            onPointerMove={(event) => {
              const from = start.current;
              if (from?.id !== event.pointerId || box === null) return;
              setDrag(
                snapBox(
                  box,
                  event.clientX - from.x,
                  event.clientY - from.y,
                  size.width,
                  size.height,
                ),
              );
            }}
            onPointerUp={(event) => {
              const from = start.current;
              start.current = null;
              if (from?.id !== event.pointerId) return;
              const last = drag;
              setDrag(null);
              if (last !== null && Math.hypot(last.dx, last.dy) >= 2) place(last.dx, last.dy);
            }}
            onPointerCancel={() => {
              start.current = null;
              setDrag(null);
            }}
            onDoubleClick={onEdit}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 0.05 : 0.005;
              const keys: Record<string, [number, number]> = {
                ArrowLeft: [-step, 0],
                ArrowRight: [step, 0],
                ArrowUp: [0, -step],
                ArrowDown: [0, step],
              };
              const by = keys[event.key];
              if (by === undefined) {
                if (event.key === 'Enter') onEdit?.();
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              place(by[0] * size.width, by[1] * size.height);
            }}
          >
            {!safe && <span className="text-frame-note">Outside the safe area</span>}
          </div>
        </div>
      )}
    </>
  );
}

/** Puts texts in rows so that texts that show at the same time do not cover each other. */
export function laneRows(
  texts: readonly Pick<TextView, 'id' | 'startSeconds' | 'durationSeconds'>[],
): { rows: Map<string, number>; count: number } {
  const ends: number[] = [];
  const rows = new Map<string, number>();
  const sorted = [...texts].sort((a, b) => a.startSeconds - b.startSeconds);
  for (const text of sorted) {
    let row = ends.findIndex((end) => end <= text.startSeconds + 0.001);
    if (row < 0) row = ends.length;
    ends[row] = text.startSeconds + text.durationSeconds;
    rows.set(text.id, row);
  }
  return { rows, count: Math.max(1, ends.length) };
}

const ROW_PX = 28;

/** The text lane of the timeline: each text a block to select, move and lengthen. */
export function TextLane({
  texts,
  scale,
  selectedId,
  onSelect,
  act,
  sceneId,
  may,
  marked,
}: {
  texts: readonly TextView[];
  scale: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  act: Act;
  sceneId: string;
  /** Whether a pointer on a block may start dragging it. */
  may: (event: PointerEvent, selected: boolean) => boolean;
  /** The tracked-change classes of a block, while a proposal is shown. */
  marked: (id: string) => string;
}): ReactElement {
  const moving = useDrag();
  const edge = useDrag();
  const { rows, count } = laneRows(texts);
  const round = (seconds: number): number => Math.max(0, Math.round(seconds * 10) / 10);
  return (
    <div className="lane lane-text" aria-label="Text lane" style={{ height: 16 + count * ROW_PX }}>
      <span className="lane-name">Text</span>
      {texts.map((text) => {
        const selected = selectedId === text.id;
        const move = moving.dragging?.id === text.id ? moving.dragging.dx / scale : 0;
        const stretch = edge.dragging?.id === text.id ? edge.dragging.dx / scale : 0;
        const first = plainText(text.text).split('\n')[0] ?? '';
        const fast = text.lettersPerSecond !== null && text.lettersPerSecond > FAST_READING;
        return (
          <div
            key={text.id}
            className={`block block-text text-${text.kind}${selected ? ' selected' : ''}${text.orphaned ? ' orphaned' : ''}${fast ? ' fast' : ''}${move === 0 ? '' : ' lifted'}${marked(text.id)}`}
            style={{
              left: Math.max(0, text.startSeconds + move) * scale,
              width: Math.max(18, (text.durationSeconds + stretch) * scale),
              top: 14 + (rows.get(text.id) ?? 0) * ROW_PX,
            }}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
            aria-label={`${KIND_NAMES[text.kind]}: ${first.slice(0, 40)}`}
            title={
              text.orphaned
                ? `Not shown: it followed ${text.follows ?? 'a piece'} that is gone`
                : fast
                  ? `Hard to read in time (${String(text.lettersPerSecond)} letters a second): ${plainText(text.text)}`
                  : plainText(text.text)
            }
            onClick={(event) => {
              event.stopPropagation();
              onSelect(text.id);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSelect(text.id);
            }}
            onPointerDown={(event) => {
              if (!may(event, selected)) return;
              moving.start(event, text.id, 'move');
              onSelect(text.id);
            }}
            onPointerMove={moving.move}
            onPointerCancel={moving.cancel}
            onPointerUp={(event) => {
              moving.end(event, (id, _edge, distance) => {
                void act('movie.edit.text.set', {
                  sceneId,
                  textId: id,
                  startSeconds: round(text.startSeconds + distance / scale),
                });
              });
            }}
          >
            {text.anchor !== null && !text.orphaned && (
              <LinkSimpleIcon className="block-icon" aria-label="Follows the cut" />
            )}
            <span className="block-label">{first || 'Empty'}</span>
            <span
              className="handle handle-end"
              aria-label={`Change how long "${first.slice(0, 20)}" shows`}
              onPointerDown={(event) => {
                if (may(event, selected)) edge.start(event, text.id, 'end');
              }}
              onPointerMove={edge.move}
              onPointerCancel={edge.cancel}
              onPointerUp={(event) => {
                edge.end(event, (id, _edge, distance) => {
                  void act('movie.edit.text.set', {
                    sceneId,
                    textId: id,
                    durationSeconds: Math.max(0.2, round(text.durationSeconds + distance / scale)),
                  });
                });
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

/** The id of the words field of the selected text, so that the picture can send the focus there. */
export const TEXT_WORDS_ID = 'text-words';

/** The colours offered for a word, besides the style's own. */
const WORD_COLOURS = ['#ffd166', '#ef6f5e', '#7cc4ff', '#8fe3a1'] as const;

/**
 * Wraps the selected words of a field in marks, or takes the marks away when
 * they are already there; with nothing selected, puts the marks at the caret.
 */
export function wrapSelection(
  value: string,
  from: number,
  to: number,
  open: string,
  close: string,
): { value: string; from: number; to: number } {
  const before = value.slice(0, from);
  const picked = value.slice(from, to);
  const after = value.slice(to);
  if (before.endsWith(open) && after.startsWith(close)) {
    return {
      value: before.slice(0, before.length - open.length) + picked + after.slice(close.length),
      from: from - open.length,
      to: to - open.length,
    };
  }
  if (
    picked.startsWith(open) &&
    picked.endsWith(close) &&
    picked.length >= open.length + close.length
  ) {
    const inner = picked.slice(open.length, picked.length - close.length);
    return { value: before + inner + after, from, to: from + inner.length };
  }
  return {
    value: before + open + picked + close + after,
    from: from + open.length,
    to: to + open.length,
  };
}

/**
 * The words of a text, with buttons that style the selected words: bold,
 * italic, underlined, a colour, smaller or bigger. The marks are plain text
 * (the same ones agents write), and the picture shows them styled.
 */
function MarkupField({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (words: string) => Promise<unknown>;
}): ReactElement {
  const [draft, setDraft] = useState(value);
  const [stored, setStored] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  if (value !== stored) {
    setStored(value);
    setDraft(value);
  }
  const commit = (words: string): void => {
    if (words === value || words.trim() === '') return;
    setError(null);
    onCommit(words).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };
  const mark = (open: string, close: string): void => {
    const element = area.current;
    if (element === null) return;
    const next = wrapSelection(draft, element.selectionStart, element.selectionEnd, open, close);
    setDraft(next.value);
    commit(next.value);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(next.from, next.to);
    });
  };
  const tool = (label: string, open: string, close: string, child: ReactElement | string) => (
    <button
      type="button"
      className="button quiet markup-tool"
      aria-label={label}
      title={label}
      // Keeps the words selected in the field while the button is pressed.
      onPointerDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        mark(open, close);
      }}
    >
      {child}
    </button>
  );
  return (
    <div className="field markup-field">
      <label htmlFor={TEXT_WORDS_ID}>Words</label>
      <div className="markup-tools" role="toolbar" aria-label="Style the selected words">
        {tool('Bold', '**', '**', <TextBIcon aria-hidden="true" weight="bold" />)}
        {tool('Italic', '*', '*', <TextItalicIcon aria-hidden="true" />)}
        {tool('Underline', '_', '_', <TextUnderlineIcon aria-hidden="true" />)}
        <span className="markup-sep" aria-hidden="true" />
        {WORD_COLOURS.map((colour) =>
          tool(
            `Colour ${colour}`,
            `{${colour}|`,
            '}',
            <span className="markup-swatch" style={{ background: colour }} />,
          ),
        )}
        <span className="markup-sep" aria-hidden="true" />
        {tool('Smaller', '{small|', '}', <span className="markup-size small">A</span>)}
        {tool('Bigger', '{big|', '}', <span className="markup-size big">A</span>)}
      </div>
      <textarea
        id={TEXT_WORDS_ID}
        ref={area}
        className="input"
        rows={3}
        value={draft}
        placeholder="A new line breaks the line"
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={() => {
          commit(draft);
        }}
        onKeyDown={(event) => {
          if (!(event.ctrlKey || event.metaKey)) return;
          const keys: Record<string, [string, string]> = {
            b: ['**', '**'],
            i: ['*', '*'],
            u: ['_', '_'],
          };
          const marks = keys[event.key.toLowerCase()];
          if (marks === undefined) return;
          event.preventDefault();
          event.stopPropagation();
          mark(marks[0], marks[1]);
        }}
      />
      <p className="muted small">
        Select words and style them, or write *italic*, **bold**, _underline_, {'{#ffd166|colour}'},{' '}
        {'{small|smaller}'} or {'{big|bigger}'}.
      </p>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Changes the selected text: words, kind, style, time, anchor and place in the frame. */
export function TextInspector({
  text,
  styles,
  items,
  sceneId,
  act,
  onGone,
  onStyles,
}: {
  text: TextView;
  styles: readonly StyleEntry[];
  items: readonly Item[];
  sceneId: string;
  act: Act;
  onGone: () => void;
  onStyles: (styleId: string) => void;
}): ReactElement {
  const set = (fields: Record<string, unknown>): Promise<unknown> =>
    act('movie.edit.text.set', { sceneId, textId: text.id, ...fields });
  const style = styles.find((candidate) => candidate.id === text.styleId) ?? styles[0];
  const under = items.find(
    (item) =>
      item.durationSeconds > 0 &&
      text.startSeconds >= item.startsAtSeconds &&
      text.startSeconds < item.startsAtSeconds + item.durationSeconds,
  );
  return (
    <>
      <h3>
        {KIND_NAMES[text.kind]}{' '}
        <span className="muted">
          {clock(text.startSeconds)} · {text.durationSeconds.toFixed(1)} s
        </span>
      </h3>
      {text.orphaned && (
        <p className="change-flag">
          It followed {text.follows ?? 'a piece'}, which is no longer in the cut, so it is not in
          the film. Give it a time of its own, or remove it.
        </p>
      )}
      <MarkupField value={text.text} onCommit={(words) => set({ text: words })} />
      {text.lettersPerSecond !== null && text.lettersPerSecond > FAST_READING && (
        <p className="change-flag">
          Hard to read in time: {text.lettersPerSecond} letters a second (keep it under{' '}
          {FAST_READING}). Shorten the words or show it longer.
        </p>
      )}
      <div className="row wrap">
        <label className="field compact wide">
          <span>Kind</span>
          <select
            className="select"
            value={text.kind}
            onChange={(event) => {
              void set({ kind: event.target.value });
            }}
          >
            {Object.entries(KIND_NAMES).map(([kind, name]) => (
              <option key={kind} value={kind}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="field compact wide">
          <span>Style</span>
          <select
            className="select"
            value={text.styleId}
            onChange={(event) => {
              void set({ styleId: event.target.value });
            }}
          >
            {styles.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button quiet"
          onClick={() => {
            onStyles(text.styleId);
          }}
        >
          <PaletteIcon aria-hidden="true" /> Edit style
        </button>
      </div>
      <div className="row wrap">
        <NumberField
          label="Starts at (s)"
          value={text.startSeconds}
          step={0.1}
          max={36000}
          onCommit={(startSeconds) => {
            void set({ startSeconds });
          }}
        />
        <NumberField
          label="Shows for (s)"
          value={text.durationSeconds}
          step={0.1}
          min={0.2}
          max={3600}
          onCommit={(durationSeconds) => {
            void set({ durationSeconds });
          }}
        />
      </div>
      {text.anchor !== null && !text.orphaned ? (
        <p className="muted small row wrap">
          <LinkSimpleIcon aria-hidden="true" /> Follows {text.follows}, so it keeps up when the cut
          changes.
          <button
            type="button"
            className="button quiet small"
            onClick={() => {
              void set({ anchor: null });
            }}
          >
            <LinkBreakIcon aria-hidden="true" /> Keep its own time
          </button>
        </p>
      ) : (
        under !== undefined && (
          <button
            type="button"
            className="button quiet"
            onClick={() => {
              void set({ anchor: { on: 'item', id: under.itemId } });
            }}
          >
            <LinkSimpleIcon aria-hidden="true" /> Follow the piece under it
          </button>
        )
      )}
      <div className="row wrap">
        <NumberField
          label="Across (0 left, 1 right)"
          value={text.x ?? style?.x ?? 0.5}
          step={0.01}
          max={1}
          onCommit={(x) => {
            void set({ x });
          }}
        />
        <NumberField
          label="Down (0 top, 1 bottom)"
          value={text.y ?? style?.y ?? 0.5}
          step={0.01}
          max={1}
          onCommit={(y) => {
            void set({ y });
          }}
        />
        {(text.x !== null || text.y !== null) && (
          <button
            type="button"
            className="button quiet"
            onClick={() => {
              void set({ x: null, y: null });
            }}
          >
            Back to the style’s place
          </button>
        )}
      </div>
      <button
        type="button"
        className="button quiet"
        onClick={() => {
          void act('movie.edit.text.remove', { sceneId, textIds: [text.id] }).then(onGone);
        }}
      >
        <TrashIcon aria-hidden="true" /> Remove text
      </button>
    </>
  );
}

/** Adding texts, subtitles and credits, the style editor and the subtitle file, on the toolbar. */
export function TextTools({
  project,
  sceneId,
  at,
  readOnly,
  act,
  onAdded,
  onStyles,
}: {
  project: Project;
  sceneId: string;
  at: number;
  readOnly: boolean;
  act: Act;
  onAdded: (textId: string) => void;
  onStyles: () => void;
}): ReactElement {
  const imp = useImp();
  const [note, setNote] = useState('');
  const add = async (kind: TextKind): Promise<void> => {
    const made = (await act('movie.edit.text.add', {
      sceneId,
      kind,
      text: SAMPLE[kind],
      startSeconds: Math.max(0, Math.round(at * 10) / 10),
    })) as { id?: string } | undefined;
    if (made?.id !== undefined) onAdded(made.id);
  };
  const download = async (): Promise<void> => {
    const file = z
      .object({
        blobKey: z.string(),
        fileName: z.string(),
        mediaType: z.string(),
        subtitles: z.number(),
      })
      .parse(
        await runCommand(imp, 'movie.edit.subtitles.export', {
          projectId: project.id,
          format: 'srt',
        }),
      );
    if (file.subtitles === 0) {
      setNote('The film has no subtitles yet: make them first.');
      return;
    }
    const blob = await imp.blob(file.blobKey);
    if (blob !== undefined) saveFile(blob.bytes, file.mediaType, file.fileName);
    setNote('');
  };
  return (
    <span className="text-tools" role="group" aria-label="Text">
      <label className="add-text">
        <PlusIcon aria-hidden="true" />
        <select
          className="select"
          aria-label="Add text at the playhead"
          value=""
          disabled={readOnly}
          onChange={(event) => {
            const kind = event.target.value as TextKind | '';
            if (kind !== '') void add(kind);
          }}
        >
          <option value="">Add text</option>
          <option value="title">Title</option>
          <option value="lower-third">Lower third</option>
          <option value="caption">Caption in the frame</option>
          <option value="subtitle">Subtitle</option>
        </select>
      </label>
      <button
        type="button"
        className="button quiet"
        disabled={readOnly}
        title="Subtitle every line that is heard in this scene; they follow the lines when the cut changes"
        onClick={() => {
          void act('movie.edit.subtitles.generate', { sceneIds: [sceneId] });
        }}
      >
        <ClosedCaptioningIcon aria-hidden="true" /> Subtitles
      </button>
      <button
        type="button"
        className="button quiet"
        disabled={readOnly}
        title="Roll end credits from the cast and crew after the last piece of this scene"
        onClick={() => {
          void act('movie.edit.credits.generate', { sceneId });
        }}
      >
        <FilmSlateIcon aria-hidden="true" /> Credits
      </button>
      <button type="button" className="button quiet" onClick={onStyles}>
        <PaletteIcon aria-hidden="true" /> Text styles
      </button>
      <button
        type="button"
        className="button quiet"
        title="Download the film’s subtitles as an .srt file, for players and video sites"
        onClick={() => {
          void download().catch((reason: unknown) => {
            setNote(reason instanceof Error ? reason.message : String(reason));
          });
        }}
      >
        <DownloadSimpleIcon aria-hidden="true" /> .srt
      </button>
      {note !== '' && <span className="muted small">{note}</span>}
    </span>
  );
}

/** A style drawn on a frame, the way the film shows it. */
function StylePreview({ style }: { style: TextStyle }): ReactElement {
  const words = PREVIEW_WORDS[style.id] ?? 'The quick brown fox';
  const kind: TextKind = (Object.keys(KIND_NAMES) as TextKind[]).includes(style.id as TextKind)
    ? (style.id as TextKind)
    : 'title';
  const { canvas, paint } = useCanvas((g, width, height) => {
    const sky = g.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, '#2a3346');
    sky.addColorStop(0.62, '#7b6a5a');
    sky.addColorStop(1, '#1b1a1d');
    g.fillStyle = sky;
    g.fillRect(0, 0, width, height);
    const length = style.roll ? 10 : 4;
    drawText(
      g,
      { kind, text: words, style, startSeconds: 0, durationSeconds: length, x: null, y: null },
      style.roll ? length * 0.45 : length / 2,
      width,
      height,
    );
  });
  useEffect(paint);
  return <canvas ref={canvas} className="style-preview" aria-label={`How ${style.name} looks`} />;
}

/** A colour picked in the system's picker, kept until the picker is left. */
function ColorField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
}): ReactElement {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <label className="field compact color-field">
      <span>{label}</span>
      <input
        type="color"
        value={picked ?? value}
        onChange={(event) => {
          setPicked(event.target.value);
        }}
        onBlur={() => {
          if (picked !== null && picked !== value) onCommit(picked);
          setPicked(null);
        }}
      />
    </label>
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}): ReactElement {
  return (
    <label className="field compact">
      <span>{label}</span>
      <select
        className="select"
        value={value}
        onChange={(event) => {
          onChange(event.target.value as T);
        }}
      >
        {options.map(([option, name]) => (
          <option key={option} value={option}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The film's text styles, each with a live picture of how it looks: letters,
 * colour, place in the frame and how it comes on and goes off.
 */
export function StyleEditor({
  open,
  onClose,
  styles,
  act,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  styles: readonly StyleEntry[];
  act: Act;
  initial: string;
}): ReactElement {
  const [chosen, setChosen] = useState(initial);
  const [shown, setShown] = useState(initial);
  if (initial !== shown) {
    setShown(initial);
    setChosen(initial);
  }
  const style = styles.find((candidate) => candidate.id === chosen) ?? styles[0];
  const set = (fields: Partial<TextStyle>): void => {
    if (style !== undefined)
      void act('movie.edit.text.style.set', { styleId: style.id, ...fields });
  };
  return (
    <Modal open={open} onClose={onClose} label="Text styles" wide>
      <div className="style-editor">
        <nav className="style-list" aria-label="Styles">
          <h2>Text styles</h2>
          {styles.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className="style-choice"
              aria-pressed={candidate.id === style?.id}
              onClick={() => {
                setChosen(candidate.id);
              }}
            >
              {candidate.name}
              {!candidate.builtIn && <span className="muted small"> · yours</span>}
            </button>
          ))}
          <button
            type="button"
            className="button quiet"
            onClick={() => {
              void act('movie.edit.text.style.set', {
                basedOn: style?.id ?? 'title',
                name: `${style?.name ?? 'Title'} copy`,
              }).then((made) => {
                const id = (made as { id?: string } | undefined)?.id;
                if (id !== undefined) setChosen(id);
              });
            }}
          >
            <PlusIcon aria-hidden="true" /> New style
          </button>
        </nav>
        {style !== undefined && (
          <div className="stack style-fields">
            <StylePreview style={style} />
            <p className="muted small">
              Every text in this style changes with it, in every scene of the film.
            </p>
            <EditableField
              label="Name"
              value={style.name}
              onCommit={(name) => act('movie.edit.text.style.set', { styleId: style.id, name })}
            />
            <fieldset className="style-group">
              <legend>Letters</legend>
              <Choice
                label="Font"
                value={style.font}
                options={[
                  ['sans', 'Sans (Inter)'],
                  ['serif', 'Serif (Instrument)'],
                  ['mono', 'Typewriter (Courier Prime)'],
                ]}
                onChange={(font) => {
                  set({ font });
                }}
              />
              <NumberField
                label="Size (% of height)"
                value={style.size}
                step={0.2}
                min={1}
                max={25}
                onCommit={(size) => {
                  set({ size });
                }}
              />
              <NumberField
                label="Weight"
                value={style.weight}
                step={100}
                min={300}
                max={900}
                onCommit={(weight) => {
                  set({ weight });
                }}
              />
              <NumberField
                label="Letter spacing (em)"
                value={style.tracking}
                step={0.01}
                min={-0.1}
                max={0.5}
                onCommit={(tracking) => {
                  set({ tracking });
                }}
              />
              <NumberField
                label="Line height"
                value={style.leading}
                step={0.05}
                min={0.8}
                max={2.5}
                onCommit={(leading) => {
                  set({ leading });
                }}
              />
              <label className="choice">
                <input
                  type="checkbox"
                  checked={style.italic}
                  onChange={() => {
                    set({ italic: !style.italic });
                  }}
                />
                Italic
              </label>
              <label className="choice">
                <input
                  type="checkbox"
                  checked={style.uppercase}
                  onChange={() => {
                    set({ uppercase: !style.uppercase });
                  }}
                />
                Capitals
              </label>
            </fieldset>
            <fieldset className="style-group">
              <legend>Colour</legend>
              <ColorField
                label="Letters"
                value={style.color}
                onCommit={(color) => {
                  set({ color });
                }}
              />
              <ColorField
                label="Outline"
                value={style.outlineColor}
                onCommit={(outlineColor) => {
                  set({ outlineColor });
                }}
              />
              <NumberField
                label="Outline width (%)"
                value={style.outline}
                step={1}
                max={30}
                onCommit={(outline) => {
                  set({ outline });
                }}
              />
              <NumberField
                label="Shadow (0–1)"
                value={style.shadow}
                step={0.05}
                max={1}
                onCommit={(shadow) => {
                  set({ shadow });
                }}
              />
              <ColorField
                label="Box"
                value={style.boxColor}
                onCommit={(boxColor) => {
                  set({ boxColor });
                }}
              />
              <NumberField
                label="Box opacity (0–1)"
                value={style.box}
                step={0.05}
                max={1}
                onCommit={(box) => {
                  set({ box });
                }}
              />
            </fieldset>
            <fieldset className="style-group">
              <legend>Place</legend>
              <Choice
                label="Align"
                value={style.align}
                options={[
                  ['left', 'Left'],
                  ['center', 'Centre'],
                  ['right', 'Right'],
                ]}
                onChange={(align) => {
                  set({ align });
                }}
              />
              <NumberField
                label="Across (0–1)"
                value={style.x}
                step={0.01}
                max={1}
                onCommit={(x) => {
                  set({ x });
                }}
              />
              <NumberField
                label="Down (0–1)"
                value={style.y}
                step={0.01}
                max={1}
                onCommit={(y) => {
                  set({ y });
                }}
              />
              <Choice
                label="Hangs from"
                value={style.anchor}
                options={[
                  ['top', 'Its top'],
                  ['middle', 'Its middle'],
                  ['bottom', 'Its bottom'],
                ]}
                onChange={(anchor) => {
                  set({ anchor });
                }}
              />
              <NumberField
                label="Widest line (% of width)"
                value={style.width}
                step={1}
                min={10}
                max={100}
                onCommit={(width) => {
                  set({ width });
                }}
              />
            </fieldset>
            <fieldset className="style-group">
              <legend>Motion</legend>
              <Choice
                label="Comes on"
                value={style.enter}
                options={[
                  ['cut', 'At once'],
                  ['fade', 'Fades in'],
                  ['rise', 'Rises in'],
                  ['type', 'Typed'],
                ]}
                onChange={(enter) => {
                  set({ enter });
                }}
              />
              <Choice
                label="Goes off"
                value={style.exit}
                options={[
                  ['cut', 'At once'],
                  ['fade', 'Fades out'],
                ]}
                onChange={(exit) => {
                  set({ exit });
                }}
              />
              <NumberField
                label="Takes (s)"
                value={style.ease}
                step={0.05}
                max={3}
                onCommit={(ease) => {
                  set({ ease });
                }}
              />
              <label className="choice">
                <input
                  type="checkbox"
                  checked={style.roll}
                  onChange={() => {
                    set({ roll: !style.roll });
                  }}
                />
                Rolls up through the frame, like end credits
              </label>
            </fieldset>
            <div className="row wrap">
              <button
                type="button"
                className="button quiet"
                onClick={() => {
                  void act('movie.edit.text.style.remove', { styleId: style.id }).then(() => {
                    if (!style.builtIn) setChosen('title');
                  });
                }}
              >
                {style.builtIn ? 'Put back as Imp made it' : 'Delete style'}
              </button>
              <button type="button" className="button primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
