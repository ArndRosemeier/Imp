import type { Project } from '@imp/core';
import { DEFAULT_TEXT_STYLES, TextStyle, type TextKind, type TextView } from '@imp/mode-movie';
import {
  ClosedCaptioningIcon,
  DownloadSimpleIcon,
  FilmSlateIcon,
  LinkBreakIcon,
  LinkSimpleIcon,
  PaletteIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState, type PointerEvent, type ReactElement } from 'react';
import { z } from 'zod';
import { drawLane, drawText } from '@imp/host/film';
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

/**
 * The texts over the preview, drawn by the same function as the film export.
 * While the cut plays it is drawn every frame, so fades and rolls are smooth.
 */
export function TextOverlay({
  texts,
  styles,
  at,
  now,
  playing,
  look,
}: {
  texts: readonly TextView[];
  styles: readonly StyleEntry[];
  at: number;
  now: () => number;
  playing: boolean;
  look: Look;
}): ReactElement {
  const time = useRef(at);
  time.current = at;
  const { canvas, paint } = useCanvas((g, width, height) => {
    drawLane(g, {
      texts,
      styles,
      seconds: playing ? now() : time.current,
      width,
      height,
      card: look.card ? { title: look.title, brightness: look.brightness } : null,
    });
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
  return <canvas ref={canvas} className="preview-text" aria-hidden="true" />;
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
        const first = text.text.split('\n')[0] ?? '';
        return (
          <div
            key={text.id}
            className={`block block-text text-${text.kind}${selected ? ' selected' : ''}${text.orphaned ? ' orphaned' : ''}${move === 0 ? '' : ' lifted'}${marked(text.id)}`}
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
                : text.text
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
      <EditableField
        label="Words"
        rows={3}
        value={text.text}
        placeholder="A new line breaks the line"
        onCommit={(words) => set({ text: words })}
      />
      <div className="row wrap">
        <label className="field compact">
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
        <label className="field compact">
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
