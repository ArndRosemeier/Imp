import type { Project } from '@imp/core';
import type { ImpClient } from '@imp/host';
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  ClipboardIcon,
  CopyIcon,
  DownloadSimpleIcon,
  EqualizerIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RobotIcon,
  ScissorsIcon,
  SkipBackIcon,
  SpeakerSimpleSlashIcon,
  TrashIcon,
  WaveformIcon,
  type Icon,
} from '@phosphor-icons/react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from 'react';
import { z } from 'zod';
import { messageOf, runCommand, useImp, useLive } from './context.js';
import { ConfirmButton, EditableField } from './Field.js';
import { Problem } from './movie.js';

// What the audio commands return, as far as the screen reads it.

const FadeCurve = z.enum(['linear', 'smooth']);
const Region = z.object({
  id: z.string(),
  label: z.string(),
  key: z.string(),
  startSeconds: z.number(),
  endSeconds: z.number(),
  trimStartSeconds: z.number(),
  volume: z.number(),
  gainDb: z.number(),
  pan: z.number(),
  fadeInSeconds: z.number(),
  fadeOutSeconds: z.number(),
  fadeCurve: FadeCurve,
});
type Region = z.infer<typeof Region>;
const Track = z.object({
  id: z.string(),
  name: z.string(),
  gainDb: z.number(),
  pan: z.number(),
  mute: z.boolean(),
  solo: z.boolean(),
  regions: z.array(Region),
});
type Track = z.infer<typeof Track>;
const Doc = z.object({
  id: z.string(),
  name: z.string(),
  durationSeconds: z.number(),
  markers: z.array(z.object({ id: z.string(), atSeconds: z.number(), label: z.string() })),
  link: z.object({ kind: z.string(), target: z.string() }).nullable().default(null),
  tracks: z.array(Track),
});
type Doc = z.infer<typeof Doc>;
/** The picture of a scene, for the strip above the tracks. */
const Picture = z.object({
  items: z.array(
    z
      .object({
        itemId: z.string(),
        kind: z.string(),
        index: z.number(),
        label: z.string(),
        startsAtSeconds: z.number(),
        durationSeconds: z.number(),
      })
      .loose(),
  ),
});
const Documents = z.object({
  documents: z.array(
    z.object({ id: z.string(), name: z.string(), durationSeconds: z.number(), tracks: z.number() }),
  ),
});
const WithDoc = z.object({ document: Doc });
const Step = z.object({
  label: z.string(),
  actor: z.object({ kind: z.string(), role: z.string().optional() }).loose().nullable(),
  at: z.string().nullable(),
});
const History = z.object({ undo: z.array(Step), redo: z.array(Step) });
type History = z.infer<typeof History>;
const Library = z.object({
  sounds: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      kind: z.enum(['dialogue', 'effect', 'music', 'voice']),
      sceneHeading: z.string().nullable(),
    }),
  ),
});
const Outline = z.object({
  fromSeconds: z.number(),
  toSeconds: z.number(),
  min: z.array(z.number()),
  max: z.array(z.number()),
});
const Measured = z.object({ durationSeconds: z.number() });
const Rendered = z.object({ key: z.string(), durationSeconds: z.number() });

const audioPrefix = (project: Project): string => `projects/${project.id}/audio/`;
const DOC_SETTING = (project: Project): string => `imp.audio.doc.${project.id}`;

/** Seconds as m:ss.mmm, the way an audio editor shows a position. */
export function timecode(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const minutes = Math.floor(ms / 60_000);
  const rest = ms % 60_000;
  return `${String(minutes)}:${String(Math.floor(rest / 1000)).padStart(2, '0')}.${String(rest % 1000).padStart(3, '0')}`;
}

const dbToGain = (db: number): number => 10 ** (db / 20);

/** The fade gain at a point of a region, 0 to 1, as the renderer applies it. */
function fadeAt(region: Region, offset: number): number {
  const length = region.endSeconds - region.startSeconds;
  const shape = (x: number): number =>
    region.fadeCurve === 'linear' ? x : 0.5 - 0.5 * Math.cos(Math.PI * x);
  const rise = region.fadeInSeconds > 0 ? Math.min(1, offset / region.fadeInSeconds) : 1;
  const fall =
    region.fadeOutSeconds > 0 ? Math.min(1, (length - offset) / region.fadeOutSeconds) : 1;
  return shape(Math.max(0, rise)) * shape(Math.max(0, fall));
}

// The pieces of a timeline, in pixels.
const LANE_PX = 88;
const MIN_ZOOM = 10;
const MAX_ZOOM = 1200;
const SNAP_PX = 6;

interface RangeSelection {
  readonly trackIds: readonly string[];
  readonly from: number;
  readonly to: number;
}

/** Runs an editing command, keeping the last failure to show. */
function useEdit(imp: ImpClient, project: Project, docId: string) {
  const [error, setError] = useState<string | null>(null);
  const edit = useCallback(
    async (id: string, input: Record<string, unknown> = {}): Promise<unknown> => {
      setError(null);
      try {
        return await runCommand(imp, id, { projectId: project.id, docId, ...input });
      } catch (reason) {
        setError(messageOf(reason));
        return undefined;
      }
    },
    [imp, project.id, docId],
  );
  return { edit, error, setError };
}

/**
 * Plays the document by having the engine mix it, so what is heard is exactly
 * what exports. The mix starts at the playhead and runs to the end.
 */
function usePlayer(imp: ImpClient, project: Project, docId: string) {
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const state = useRef<{
    context: AudioContext | null;
    node: AudioBufferSourceNode | null;
    frame: number;
    from: number;
    startedAt: number;
  }>({ context: null, node: null, frame: 0, from: 0, startedAt: 0 });

  const stop = useCallback(() => {
    const current = state.current;
    if (current.node !== null) {
      current.node.onended = null;
      current.node.stop();
      current.node = null;
    }
    cancelAnimationFrame(current.frame);
    setPlaying(false);
  }, []);

  const play = useCallback(
    async (from: number, end: number): Promise<void> => {
      stop();
      if (end - from <= 0.001) return;
      setLoading(true);
      try {
        const rendered = Rendered.parse(
          await runCommand(imp, 'audio.listen', {
            projectId: project.id,
            docId,
            fromSeconds: from,
            toSeconds: end,
          }),
        );
        const file = await imp.blob(rendered.key);
        if (file === undefined) return;
        const current = state.current;
        current.context ??= new AudioContext({ sampleRate: 48_000 });
        const context = current.context;
        await context.resume();
        const buffer = await context.decodeAudioData(file.bytes.slice().buffer);
        const node = context.createBufferSource();
        node.buffer = buffer;
        node.connect(context.destination);
        node.onended = () => {
          cancelAnimationFrame(current.frame);
          current.node = null;
          setPlaying(false);
        };
        current.node = node;
        current.from = from;
        current.startedAt = context.currentTime;
        node.start();
        setPlaying(true);
        const tick = (): void => {
          setAt(current.from + context.currentTime - current.startedAt);
          current.frame = requestAnimationFrame(tick);
        };
        tick();
      } finally {
        setLoading(false);
      }
    },
    [imp, project.id, docId, stop],
  );

  useEffect(
    () => () => {
      stop();
      void state.current.context?.close();
    },
    [stop],
  );

  return { at, setAt, playing, loading, play, stop };
}

/** The outline of one region's stretch of sound, drawn at the width it is shown. */
function RegionWave({
  region,
  width,
  height,
}: {
  region: Region;
  width: number;
  height: number;
}): ReactElement {
  const imp = useImp();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [outline, setOutline] = useState<z.infer<typeof Outline> | null>(null);
  const [unheard, setUnheard] = useState<string | null>(null);
  // Ask for a power of two of slices, so zooming a little does not ask again.
  const buckets = Math.min(4000, 2 ** Math.ceil(Math.log2(Math.max(8, width))));
  const length = region.endSeconds - region.startSeconds;
  useEffect(() => {
    let active = true;
    runCommand(imp, 'audio.waveform', {
      key: region.key,
      fromSeconds: region.trimStartSeconds,
      toSeconds: region.trimStartSeconds + length,
      buckets,
    }).then(
      (output) => {
        if (!active) return;
        setOutline(Outline.parse(output));
        setUnheard(null);
      },
      (reason: unknown) => {
        if (!active) return;
        setOutline(null);
        // Past the end of its sound a region is silent by design, not unheard.
        const message = messageOf(reason);
        setUnheard(message.includes('range inside it') ? null : message);
      },
    );
    return () => {
      active = false;
    };
  }, [imp, region.key, region.trimStartSeconds, length, buckets]);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (element === null || context === null || context === undefined) return;
    const ratio = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(width));
    element.width = Math.min(16_000, w * ratio);
    element.height = height * ratio;
    context.setTransform(element.width / w, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, w, height);
    if (outline === null || outline.min.length === 0) return;
    const color = getComputedStyle(element).color;
    const level = region.volume * dbToGain(region.gainDb);
    const middle = height / 2;
    const slices = outline.min.length;
    // The sound may end before the region does; past its end there is nothing to draw.
    const drawn = Math.min(w, (w * (outline.toSeconds - outline.fromSeconds)) / length);
    context.fillStyle = color;
    context.beginPath();
    for (let x = 0; x < drawn; x++) {
      const index = Math.min(slices - 1, Math.floor((x / drawn) * slices));
      const gain = level * fadeAt(region, (x / w) * length);
      const top = Math.min(1, (outline.max[index] ?? 0) * gain);
      const bottom = Math.max(-1, (outline.min[index] ?? 0) * gain);
      const y = middle - top * middle * 0.94;
      const h = Math.max(1, (top - bottom) * middle * 0.94);
      context.rect(x, y, 1, h);
    }
    context.fill();
  }, [outline, width, height, region, length]);

  return (
    <>
      <canvas ref={canvas} className="wave" aria-hidden="true" style={{ width, height }} />
      {unheard !== null && (
        <span className="unheard" title={unheard}>
          Silent here: {unheard}
        </span>
      )}
    </>
  );
}

/** Where in a region a pointer grabbed it. */
type Grab = 'move' | 'start' | 'end';

interface Drag {
  readonly regionId: string;
  readonly grab: Grab;
  readonly x: number;
  readonly y: number;
  dx: number;
  dTrack: number;
}

/** What a dragged region looks like before the change is sent. */
function dragged(region: Region, drag: Drag | null, zoom: number, length: number | undefined) {
  if (drag?.regionId !== region.id) return region;
  const d = drag.dx / zoom;
  const span = region.endSeconds - region.startSeconds;
  if (drag.grab === 'move') {
    const start = Math.max(0, region.startSeconds + d);
    return { ...region, startSeconds: start, endSeconds: start + span };
  }
  if (drag.grab === 'start') {
    const shift = Math.min(
      Math.max(d, -region.trimStartSeconds, -region.startSeconds),
      span - 0.01,
    );
    return {
      ...region,
      startSeconds: region.startSeconds + shift,
      trimStartSeconds: region.trimStartSeconds + shift,
    };
  }
  const available = length === undefined ? Infinity : length - region.trimStartSeconds;
  const end = region.startSeconds + Math.min(Math.max(0.01, span + d), available);
  return { ...region, endSeconds: end };
}

function ToolButton({
  icon: Glyph,
  label,
  keys,
  onClick,
  disabled = false,
  pressed,
}: {
  icon: Icon;
  label: string;
  keys?: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      className="tool"
      aria-label={label}
      aria-pressed={pressed}
      aria-keyshortcuts={keys}
      title={keys === undefined ? label : `${label} (${keys})`}
      disabled={disabled}
      onClick={onClick}
    >
      <Glyph aria-hidden="true" size={18} />
    </button>
  );
}

function NumberInput({
  label,
  value,
  step,
  min,
  max,
  unit,
  onCommit,
}: {
  label: string;
  value: number;
  step: number;
  min: number;
  max: number;
  unit?: string;
  onCommit: (value: number) => void;
}): ReactElement {
  const id = useId();
  const [typed, setTyped] = useState<string | null>(null);
  const text = typed ?? String(Math.round(value * 1000) / 1000);
  return (
    <div className="knob">
      <label htmlFor={id}>{label}</label>
      <span className="knob-input">
        <input
          id={id}
          className="input"
          type="number"
          step={step}
          min={min}
          max={max}
          value={text}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          onBlur={() => {
            const next = Number(text);
            setTyped(null);
            if (Number.isFinite(next) && next !== value) {
              onCommit(Math.min(max, Math.max(min, next)));
            }
          }}
        />
        {unit !== undefined && <span className="muted">{unit}</span>}
      </span>
    </div>
  );
}

/** Who made a step, in words. */
function byWhom(step: z.infer<typeof Step>): string {
  // The cut of a scene keeps its steps without saying who made them.
  if (step.actor === null) return 'Scene';
  if (step.actor.kind !== 'agent') return 'You';
  const role = step.actor.role ?? 'agent';
  return role
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function Inspector({
  doc,
  region,
  track,
  history,
  edit,
  onSelectRegion,
}: {
  doc: Doc;
  region: Region | undefined;
  track: Track | undefined;
  history: History | undefined;
  edit: (id: string, input?: Record<string, unknown>) => Promise<unknown>;
  onSelectRegion: (region: Region) => void;
}): ReactElement {
  const change = (fields: Record<string, unknown>): void => {
    if (region !== undefined) void edit('audio.region.update', { regionId: region.id, ...fields });
  };
  const steps = history?.undo.slice(-8).reverse() ?? [];
  return (
    <aside className="audio-inspector" aria-label="Inspector">
      {region !== undefined ? (
        <section className="stack">
          <p className="eyebrow">Region</p>
          <EditableField
            label="Label"
            value={region.label}
            placeholder="Mara, line 3"
            onCommit={(label) => edit('audio.region.update', { regionId: region.id, label })}
          />
          <p className="muted mono small">
            {timecode(region.startSeconds)} to {timecode(region.endSeconds)}
          </p>
          <div className="knobs">
            <NumberInput
              label="Gain"
              unit="dB"
              value={region.gainDb}
              step={0.5}
              min={-60}
              max={24}
              onCommit={(gainDb) => {
                change({ gainDb });
              }}
            />
            <NumberInput
              label="Volume"
              value={region.volume}
              step={0.05}
              min={0}
              max={1}
              onCommit={(volume) => {
                change({ volume });
              }}
            />
            <NumberInput
              label="Fade in"
              unit="s"
              value={region.fadeInSeconds}
              step={0.1}
              min={0}
              max={600}
              onCommit={(fadeInSeconds) => {
                change({ fadeInSeconds });
              }}
            />
            <NumberInput
              label="Fade out"
              unit="s"
              value={region.fadeOutSeconds}
              step={0.1}
              min={0}
              max={600}
              onCommit={(fadeOutSeconds) => {
                change({ fadeOutSeconds });
              }}
            />
            <NumberInput
              label="Pan"
              value={region.pan}
              step={0.1}
              min={-1}
              max={1}
              onCommit={(pan) => {
                change({ pan });
              }}
            />
            <div className="knob">
              <span id={`curve-${region.id}`}>Fade shape</span>
              <span className="segmented" role="group" aria-labelledby={`curve-${region.id}`}>
                {(['linear', 'smooth'] as const).map((curve) => (
                  <button
                    key={curve}
                    type="button"
                    aria-pressed={region.fadeCurve === curve}
                    onClick={() => {
                      change({ fadeCurve: curve });
                    }}
                  >
                    {curve === 'linear' ? 'Linear' : 'Smooth'}
                  </button>
                ))}
              </span>
            </div>
          </div>
          <div className="row wrap">
            <button
              type="button"
              className="button small"
              onClick={() => {
                void edit('audio.normalize', { regionIds: [region.id] });
              }}
            >
              <EqualizerIcon aria-hidden="true" /> Normalize to −1 dB
            </button>
            <button
              type="button"
              className="button small quiet"
              onClick={() => {
                onSelectRegion(region);
              }}
            >
              Select its time
            </button>
          </div>
        </section>
      ) : track !== undefined ? (
        <section className="stack">
          <p className="eyebrow">Track</p>
          <p className="inspector-title">{track.name}</p>
          {doc.link !== null && (
            <p className="muted small">
              The tracks of a scene are its kinds of sound. Set levels on the regions, or normalize
              them all here.
            </p>
          )}
          <div className="knobs" hidden={doc.link !== null}>
            <NumberInput
              label="Gain"
              unit="dB"
              value={track.gainDb}
              step={0.5}
              min={-60}
              max={24}
              onCommit={(gainDb) => {
                void edit('audio.track.update', { trackId: track.id, gainDb });
              }}
            />
            <NumberInput
              label="Pan"
              value={track.pan}
              step={0.1}
              min={-1}
              max={1}
              onCommit={(pan) => {
                void edit('audio.track.update', { trackId: track.id, pan });
              }}
            />
          </div>
          <div className="row wrap">
            <button
              type="button"
              className="button small"
              disabled={track.regions.length === 0}
              onClick={() => {
                void edit('audio.normalize', { trackId: track.id });
              }}
            >
              <EqualizerIcon aria-hidden="true" /> Normalize regions
            </button>
            {doc.link === null && (
              <ConfirmButton
                label="Remove track"
                question="Remove this track and its regions?"
                onConfirm={() => {
                  void edit('audio.track.remove', { trackId: track.id });
                }}
              >
                <TrashIcon aria-hidden="true" />
              </ConfirmButton>
            )}
          </div>
        </section>
      ) : (
        <section className="stack">
          <p className="eyebrow">Document</p>
          <p className="inspector-title">{doc.name}</p>
          <p className="muted">
            Click a region to shape it, or drag across a track to select a stretch of time.
          </p>
        </section>
      )}
      <section className="stack history">
        <p className="eyebrow">History</p>
        {steps.length === 0 ? (
          <p className="muted small">Nothing changed yet.</p>
        ) : (
          <ol className="steps-list">
            {steps.map((step, index) => (
              <li
                key={`${step.at ?? 'step'}-${String(index)}`}
                data-agent={step.actor?.kind === 'agent'}
              >
                <span>{step.label}</span>
                <span className="muted small">{byWhom(step)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}

/** Seconds between the numbered ticks of the ruler at a zoom. */
function tickStep(zoom: number): number {
  const steps = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return steps.find((step) => step * zoom >= 72) ?? 600;
}

function AudioEditor({
  project,
  docId,
  onClose,
}: {
  project: Project;
  docId: string;
  onClose: () => void;
}): ReactElement {
  const imp = useImp();
  const prefix = audioPrefix(project);
  // A document opened onto a scene changes whenever the scene's cut does.
  const watched = [
    `${prefix}docs/${docId}`,
    `${prefix}history/${docId}`,
    `projects/${project.id}/movie/`,
  ];
  const live = useLive(watched, async (current) => {
    const input = { projectId: project.id, docId };
    const [got, past] = await Promise.all([
      runCommand(current, 'audio.doc.get', input),
      runCommand(current, 'audio.history.list', input),
    ]);
    const loaded = WithDoc.parse(got).document;
    const picture =
      loaded.link?.kind === 'scene'
        ? Picture.parse(
            await runCommand(current, 'movie.edit.get', {
              projectId: project.id,
              sceneId: loaded.link.target,
            }),
          ).items.filter((item) => item.durationSeconds > 0)
        : null;
    return { doc: loaded, history: History.parse(past), picture };
  });
  const doc = live.data?.doc;
  const history = live.data?.history;
  const picture = live.data?.picture ?? null;
  const { edit, error, setError } = useEdit(imp, project, docId);
  const player = usePlayer(imp, project, docId);
  const [zoom, setZoom] = useState(80);
  const [selection, setSelection] = useState<RangeSelection | null>(null);
  const [regionId, setRegionId] = useState<string | null>(null);
  const [trackId, setTrackId] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [lengths, setLengths] = useState<ReadonlyMap<string, number>>(new Map());
  const lanes = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const fingers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; center: number; zoom: number; scroll: number } | null>(
    null,
  );
  const sweep = useRef<{
    trackIndex: number;
    at: number;
    moved: boolean;
    regionId: string | null;
  } | null>(null);

  // The length of every source, so trims stop at the end of the sound.
  const keys = [...new Set(doc?.tracks.flatMap((track) => track.regions.map((r) => r.key)))]
    .filter((key) => key !== '' && !lengths.has(key))
    .join('\n');
  useEffect(() => {
    if (keys === '') return;
    for (const key of keys.split('\n')) {
      runCommand(imp, 'audio.inspect', { key }).then(
        (output) => {
          setLengths((before) => new Map(before).set(key, Measured.parse(output).durationSeconds));
        },
        () => undefined,
      );
    }
  }, [imp, keys]);

  if (doc === undefined) {
    return (
      <>
        <Problem text={live.error} />
        {live.error !== null && (
          <button type="button" className="button" onClick={onClose}>
            Back to the documents
          </button>
        )}
      </>
    );
  }

  const tracks = doc.tracks;
  const allRegions = tracks.flatMap((track) => track.regions.map((region) => ({ track, region })));
  const picked = allRegions.find((entry) => entry.region.id === regionId);
  const pickedTrack = tracks.find((track) => track.id === trackId) ?? picked?.track;
  const length = Math.max(doc.durationSeconds, player.at);
  const width = Math.max(length + 10, 30) * zoom;
  const at = player.at;
  const lastStep = history?.undo.at(-1);
  const agentLast = lastStep?.actor?.kind === 'agent';

  /** The time under a pointer on the lanes, snapped to region edges and the playhead nearby. */
  const timeAt = (clientX: number, snap = true): number => {
    const box = lanes.current?.getBoundingClientRect();
    const raw = Math.max(0, (clientX - (box?.left ?? 0)) / zoom);
    if (!snap) return raw;
    const edges = [
      at,
      ...allRegions.flatMap(({ region }) => [region.startSeconds, region.endSeconds]),
    ];
    const near = edges.find((edge) => Math.abs(edge - raw) * zoom < SNAP_PX);
    return near ?? raw;
  };
  const trackIndexAt = (clientY: number): number => {
    const box = lanes.current?.getBoundingClientRect();
    const index = Math.floor((clientY - (box?.top ?? 0)) / LANE_PX);
    return Math.min(tracks.length - 1, Math.max(0, index));
  };

  const targetTracks = (): string[] | undefined =>
    selection === null ? undefined : [...selection.trackIds];
  const range = selection !== null && selection.to - selection.from > 0.0005 ? selection : null;

  const actions = {
    playPause: () => {
      if (player.playing) {
        player.stop();
      } else {
        const from = at >= doc.durationSeconds - 0.01 ? 0 : at;
        const end = range === null ? doc.durationSeconds : range.to;
        void player.play(range === null ? from : range.from, end).catch((reason: unknown) => {
          setError(messageOf(reason));
        });
      }
    },
    toStart: () => {
      player.stop();
      player.setAt(0);
    },
    split: () => {
      const under = allRegions.filter(
        ({ track, region }) =>
          region.startSeconds < at &&
          region.endSeconds > at &&
          (picked === undefined
            ? (selection?.trackIds.includes(track.id) ?? true)
            : region.id === picked.region.id),
      );
      void (async () => {
        for (const { region } of under)
          await edit('audio.region.split', { regionId: region.id, atSeconds: at });
      })();
    },
    copy: () => {
      if (range !== null) {
        void edit('audio.edit.copy', {
          trackIds: targetTracks(),
          fromSeconds: range.from,
          toSeconds: range.to,
        });
      } else if (picked !== undefined) {
        void edit('audio.edit.copy', {
          trackIds: [picked.track.id],
          fromSeconds: picked.region.startSeconds,
          toSeconds: picked.region.endSeconds,
        });
      }
    },
    cut: () => {
      if (range === null) return;
      void edit('audio.edit.cut', {
        trackIds: targetTracks(),
        fromSeconds: range.from,
        toSeconds: range.to,
      });
      setSelection({ ...range, to: range.from });
    },
    paste: () => {
      const into = selection?.trackIds[0] ?? picked?.track.id ?? trackId ?? tracks[0]?.id;
      if (into === undefined) return;
      void edit('audio.edit.paste', { trackId: into, atSeconds: range?.from ?? at });
    },
    remove: () => {
      if (range !== null) {
        void edit('audio.edit.delete', {
          trackIds: targetTracks(),
          fromSeconds: range.from,
          toSeconds: range.to,
        });
        setSelection({ ...range, to: range.from });
      } else if (picked !== undefined) {
        void edit('audio.region.remove', { regionId: picked.region.id });
        setRegionId(null);
      }
    },
    silence: () => {
      if (range !== null) {
        void edit('audio.edit.silence', {
          trackIds: targetTracks(),
          fromSeconds: range.from,
          toSeconds: range.to,
        });
      }
    },
    undo: (wholeRun = false) => {
      void edit('audio.history.undo', { wholeRun });
    },
    redo: () => {
      void edit('audio.history.redo');
    },
    zoomIn: () => {
      setZoom((z) => Math.min(MAX_ZOOM, z * 1.5));
    },
    zoomOut: () => {
      setZoom((z) => Math.max(MIN_ZOOM, z / 1.5));
    },
    fit: () => {
      const box = lanes.current?.parentElement?.clientWidth ?? 900;
      setZoom(
        Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (box - 40) / Math.max(1, doc.durationSeconds))),
      );
    },
    addTrack: () => {
      void edit('audio.track.add', { name: `Track ${String(tracks.length + 1)}` });
    },
    exportFile: () => {
      void (async () => {
        const output = await edit('audio.export');
        if (output === undefined) return;
        const file = await imp.blob(Rendered.parse(output).key);
        if (file === undefined) return;
        const url = URL.createObjectURL(new Blob([file.bytes.slice()], { type: 'audio/wav' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `${doc.name}.wav`;
        link.click();
        setTimeout(() => {
          URL.revokeObjectURL(url);
        }, 10_000);
      })();
    },
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select') !== null) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const run = (action: () => void): void => {
      event.preventDefault();
      action();
    };
    if (key === ' ' && target.closest('button') === null) run(actions.playPause);
    else if (key === 'home') run(actions.toStart);
    else if (mod && key === 'z' && event.shiftKey) run(actions.redo);
    else if (mod && key === 'z')
      run(() => {
        actions.undo();
      });
    else if (mod && key === 'y') run(actions.redo);
    else if (mod && key === 'x') run(actions.cut);
    else if (mod && key === 'c') run(actions.copy);
    else if (mod && key === 'v') run(actions.paste);
    else if (mod && key === 'l') run(actions.silence);
    else if (!mod && key === 's') run(actions.split);
    else if (key === 'delete' || key === 'backspace') run(actions.remove);
    else if (key === '=' || key === '+') run(actions.zoomIn);
    else if (key === '-') run(actions.zoomOut);
    else if (key === 'escape')
      run(() => {
        setSelection(null);
        setRegionId(null);
      });
  };

  /** Two fingers on the lanes pan and pinch-zoom them, as on a tablet. */
  const pinchMove = (): void => {
    const scroller = scroll.current;
    const start = pinch.current;
    const [a, b] = [...fingers.current.values()];
    if (scroller === null || start === null || a === undefined || b === undefined) return;
    const left = scroller.getBoundingClientRect().left;
    const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const center = (a.x + b.x) / 2;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (start.zoom * distance) / start.distance));
    const anchor = (start.scroll + start.center - left) / start.zoom;
    setZoom(next);
    requestAnimationFrame(() => {
      scroller.scrollLeft = anchor * next - (center - left);
    });
  };
  const releaseFinger = (event: PointerEvent<HTMLDivElement>): boolean => {
    const wasPinching = pinch.current !== null;
    fingers.current.delete(event.pointerId);
    if (fingers.current.size < 2) pinch.current = null;
    return wasPinching;
  };

  // Sweeping across lanes selects a stretch of time on the tracks crossed.
  const onLanesDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.pointerType === 'touch') {
      fingers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (fingers.current.size === 2) {
        // A second finger turns the gesture into pan and zoom; the first finger's sweep is dropped.
        const [a, b] = [...fingers.current.values()];
        if (a !== undefined && b !== undefined) {
          sweep.current = null;
          setSelection(null);
          pinch.current = {
            distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
            center: (a.x + b.x) / 2,
            zoom,
            scroll: scroll.current?.scrollLeft ?? 0,
          };
        }
        return;
      }
    }
    const hit = (event.target as HTMLElement).closest<HTMLElement>('[data-region-id]');
    const index = trackIndexAt(event.clientY);
    const t = timeAt(event.clientX);
    if (event.shiftKey && selection !== null) {
      const anchor =
        Math.abs(t - selection.from) < Math.abs(t - selection.to) ? selection.to : selection.from;
      sweep.current = { trackIndex: index, at: anchor, moved: true, regionId: null };
      setSelection({ ...selection, from: Math.min(anchor, t), to: Math.max(anchor, t) });
      return;
    }
    sweep.current = {
      trackIndex: index,
      at: t,
      moved: false,
      regionId: hit?.dataset['regionId'] ?? null,
    };
    setRegionId(null);
    setTrackId(tracks[index]?.id ?? null);
    setSelection(null);
    player.setAt(t);
  };
  const onLanesMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (fingers.current.has(event.pointerId)) {
      fingers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinch.current !== null) {
        pinchMove();
        return;
      }
    }
    const start = sweep.current;
    if (start === null) return;
    const t = timeAt(event.clientX);
    if (!start.moved && Math.abs(t - start.at) * zoom < 3) return;
    start.moved = true;
    const index = trackIndexAt(event.clientY);
    const low = Math.min(index, start.trackIndex);
    const high = Math.max(index, start.trackIndex);
    setSelection({
      trackIds: tracks.slice(low, high + 1).map((track) => track.id),
      from: Math.min(start.at, t),
      to: Math.max(start.at, t),
    });
  };
  const onLanesUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (releaseFinger(event)) {
      sweep.current = null;
      return;
    }
    // A click on a region without sweeping picks it.
    const done = sweep.current;
    sweep.current = null;
    if (done !== null && !done.moved && done.regionId !== null) {
      setRegionId(done.regionId);
      setTrackId(null);
    }
  };

  const onRegionDown = (event: PointerEvent<HTMLElement>, region: Region, grab: Grab): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setRegionId(region.id);
    setTrackId(null);
    setSelection(null);
    setDrag({ regionId: region.id, grab, x: event.clientX, y: event.clientY, dx: 0, dTrack: 0 });
  };
  const onRegionMove = (event: PointerEvent<HTMLElement>): void => {
    if (drag === null) return;
    const dTrack = drag.grab === 'move' ? Math.round((event.clientY - drag.y) / LANE_PX) : 0;
    setDrag({ ...drag, dx: event.clientX - drag.x, dTrack });
  };
  const onRegionUp = (region: Region, track: Track): void => {
    if (drag === null) return;
    const done = drag;
    setDrag(null);
    if (Math.abs(done.dx) < 2 && done.dTrack === 0) return;
    const next = dragged(region, done, zoom, lengths.get(region.key));
    if (done.grab === 'move') {
      const index = tracks.findIndex((candidate) => candidate.id === track.id) + done.dTrack;
      const to = tracks[Math.min(tracks.length - 1, Math.max(0, index))];
      // Snap the start to an edge nearby.
      const edges = allRegions
        .filter((entry) => entry.region.id !== region.id)
        .flatMap((entry) => [entry.region.startSeconds, entry.region.endSeconds]);
      const span = region.endSeconds - region.startSeconds;
      const snapped =
        edges.find((edge) => Math.abs(edge - next.startSeconds) * zoom < SNAP_PX) ??
        edges
          .map((edge) => edge - span)
          .find((edge) => edge >= 0 && Math.abs(edge - next.startSeconds) * zoom < SNAP_PX) ??
        next.startSeconds;
      void edit('audio.region.update', {
        regionId: region.id,
        startSeconds: snapped,
        ...(to !== undefined && to.id !== track.id ? { trackId: to.id } : {}),
      });
    } else {
      void edit('audio.region.update', {
        regionId: region.id,
        startSeconds: next.startSeconds,
        trimStartSeconds: next.trimStartSeconds,
        durationSeconds: next.endSeconds - next.startSeconds,
      });
    }
  };

  const step = tickStep(zoom);
  const ticks = Array.from({ length: Math.ceil(width / zoom / step) + 1 }, (_, i) => i * step);

  return (
    // The editor takes its shortcuts while it has focus, like a desktop audio editor.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="audio-editor"
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      onKeyDown={onKey}
      aria-label={`Audio editor: ${doc.name}`}
    >
      <div className="audio-top">
        <div className="transport" role="group" aria-label="Transport">
          <ToolButton icon={SkipBackIcon} label="To start" keys="Home" onClick={actions.toStart} />
          <button
            type="button"
            className="play"
            aria-label={player.playing ? 'Pause' : 'Play'}
            aria-keyshortcuts="Space"
            title={player.playing ? 'Pause (Space)' : 'Play (Space)'}
            disabled={player.loading || doc.durationSeconds === 0}
            onClick={actions.playPause}
          >
            {player.playing ? (
              <PauseIcon aria-hidden="true" size={20} weight="fill" />
            ) : (
              <PlayIcon aria-hidden="true" size={20} weight="fill" />
            )}
          </button>
          <output className="readout" aria-label="Playhead">
            {timecode(at)}
            <small>{player.loading ? 'mixing…' : `of ${timecode(doc.durationSeconds)}`}</small>
          </output>
          {/* Always there, so the layout does not move while a selection is drawn. */}
          <output className="readout range" aria-label="Selection" data-empty={range === null}>
            {range === null ? 'No selection' : `${timecode(range.from)} – ${timecode(range.to)}`}
            <small>
              {range === null
                ? 'drag across a track'
                : `${(range.to - range.from).toFixed(3)} s selected`}
            </small>
          </output>
        </div>
        <div className="tools" role="toolbar" aria-label="Edit">
          <ToolButton
            icon={ScissorsIcon}
            label="Split at playhead"
            keys="S"
            onClick={actions.split}
          />
          <ToolButton
            icon={CopyIcon}
            label="Copy"
            keys="Control+C"
            disabled={range === null && picked === undefined}
            onClick={actions.copy}
          />
          <ToolButton icon={ClipboardIcon} label="Paste" keys="Control+V" onClick={actions.paste} />
          <ToolButton
            icon={TrashIcon}
            label="Delete"
            keys="Delete"
            disabled={range === null && picked === undefined}
            onClick={actions.remove}
          />
          <ToolButton
            icon={SpeakerSimpleSlashIcon}
            label="Silence selection"
            keys="Control+L"
            disabled={range === null}
            onClick={actions.silence}
          />
          <span className="tool-gap" />
          <ToolButton
            icon={ArrowCounterClockwiseIcon}
            label="Undo"
            keys="Control+Z"
            disabled={history?.undo.length === 0}
            onClick={() => {
              actions.undo();
            }}
          />
          <ToolButton
            icon={ArrowClockwiseIcon}
            label="Redo"
            keys="Control+Shift+Z"
            disabled={history?.redo.length === 0}
            onClick={actions.redo}
          />
          <span className="tool-gap" />
          <ToolButton
            icon={MagnifyingGlassMinusIcon}
            label="Zoom out"
            keys="-"
            onClick={actions.zoomOut}
          />
          <button
            type="button"
            className="tool text"
            onClick={actions.fit}
            title="Fit the document"
          >
            Fit
          </button>
          <ToolButton
            icon={MagnifyingGlassPlusIcon}
            label="Zoom in"
            keys="="
            onClick={actions.zoomIn}
          />
          <span className="tool-gap" />
          <button
            type="button"
            className="button small"
            onClick={actions.exportFile}
            disabled={doc.durationSeconds === 0}
          >
            <DownloadSimpleIcon aria-hidden="true" /> Export WAV
          </button>
        </div>
      </div>
      {doc.link?.kind === 'scene' && (
        <p className="linked-note muted small">
          This is the sound of the scene&apos;s cut. Changes here change the Edit stage, and undo
          there as well. Moving or trimming a shot&apos;s line takes it apart from its picture.
        </p>
      )}
      {agentLast && (
        <div className="agent-pass" role="status">
          <RobotIcon aria-hidden="true" size={16} />
          <span>
            {byWhom(lastStep)} changed this document: {lastStep.label.toLowerCase()}.
          </span>
          <button
            type="button"
            className="button small quiet"
            onClick={() => {
              actions.undo(true);
            }}
          >
            Undo this pass
          </button>
        </div>
      )}
      <Problem text={error} />
      <div className="audio-body">
        <div className="audio-timeline">
          <div className="track-heads">
            <div className="ruler-corner">
              <span className="eyebrow">
                {tracks.length === 1 ? '1 track' : `${String(tracks.length)} tracks`}
              </span>
            </div>
            {picture !== null && (
              <div className="picture-head">
                <span className="eyebrow">Picture</span>
              </div>
            )}
            {tracks.map((track, index) => (
              <div
                key={track.id}
                className="track-head"
                data-index={index % 4}
                data-selected={pickedTrack?.id === track.id && picked === undefined}
                style={{ height: LANE_PX }}
              >
                <button
                  type="button"
                  className="track-name"
                  onClick={() => {
                    setTrackId(track.id);
                    setRegionId(null);
                  }}
                >
                  {track.name}
                </button>
                <div className="track-buttons">
                  <button
                    type="button"
                    className="ms"
                    aria-pressed={track.mute}
                    aria-label={`Mute ${track.name}`}
                    title="Mute"
                    onClick={() => {
                      void edit('audio.track.update', { trackId: track.id, mute: !track.mute });
                    }}
                  >
                    M
                  </button>
                  <button
                    type="button"
                    className="ms solo"
                    aria-pressed={track.solo}
                    aria-label={`Solo ${track.name}`}
                    title="Solo"
                    onClick={() => {
                      void edit('audio.track.update', { trackId: track.id, solo: !track.solo });
                    }}
                  >
                    S
                  </button>
                  <span className="muted mono small">
                    {track.gainDb === 0
                      ? '0 dB'
                      : `${track.gainDb > 0 ? '+' : ''}${String(track.gainDb)} dB`}
                  </span>
                </div>
              </div>
            ))}
            {doc.link === null && (
              <button type="button" className="add-track" onClick={actions.addTrack}>
                <PlusIcon aria-hidden="true" /> Add track
              </button>
            )}
          </div>
          <div className="lanes-scroll" ref={scroll}>
            <div className="lanes-inner" style={{ width }}>
              <div
                className="audio-ruler"
                role="slider"
                tabIndex={-1}
                aria-label="Playhead position"
                aria-valuemin={0}
                aria-valuemax={Math.round(doc.durationSeconds * 1000) / 1000}
                aria-valuenow={Math.round(at * 1000) / 1000}
                aria-valuetext={timecode(at)}
                onPointerDown={(event) => {
                  player.stop();
                  player.setAt(timeAt(event.clientX, false));
                }}
              >
                {ticks.map((tick) => (
                  <span key={tick} className="tick" style={{ left: tick * zoom }}>
                    {step < 1
                      ? timecode(tick).replace(/^0:/, '')
                      : timecode(tick).replace(/\.000$/, '')}
                  </span>
                ))}
                {doc.markers.map((marker) => (
                  <span
                    key={marker.id}
                    className="marker"
                    style={{ left: marker.atSeconds * zoom }}
                    title={marker.label}
                  >
                    {marker.label}
                  </span>
                ))}
              </div>
              {picture !== null && (
                <div className="picture-strip" aria-label="Picture of the scene" role="group">
                  {picture.map((item) => (
                    <span
                      key={item.itemId}
                      className="picture-item"
                      data-kind={item.kind}
                      style={{
                        left: item.startsAtSeconds * zoom,
                        width: item.durationSeconds * zoom,
                      }}
                      title={item.label}
                    >
                      <strong>
                        {item.kind === 'title' ? 'Title' : `Shot ${String(item.index)}`}
                      </strong>{' '}
                      {item.label}
                    </span>
                  ))}
                </div>
              )}
              <div
                ref={lanes}
                className="lanes"
                onPointerDown={onLanesDown}
                onPointerMove={onLanesMove}
                onPointerUp={onLanesUp}
                onPointerCancel={(event) => {
                  releaseFinger(event);
                  sweep.current = null;
                }}
              >
                {tracks.map((track, index) => {
                  const selected = selection?.trackIds.includes(track.id) === true;
                  return (
                    <div
                      key={track.id}
                      className="audio-lane"
                      data-index={index % 4}
                      data-muted={track.mute || (tracks.some((t) => t.solo) && !track.solo)}
                      style={{ height: LANE_PX }}
                      aria-label={track.name}
                      role="group"
                    >
                      {selected && (
                        <div
                          className="range"
                          style={{
                            left: selection.from * zoom,
                            width: Math.max(1, (selection.to - selection.from) * zoom),
                          }}
                        />
                      )}
                      {track.regions.map((original) => {
                        const region = dragged(original, drag, zoom, lengths.get(original.key));
                        const left = region.startSeconds * zoom;
                        const w = Math.max(4, (region.endSeconds - region.startSeconds) * zoom);
                        const lift = drag?.regionId === original.id ? drag.dTrack * LANE_PX : 0;
                        const fadeInPx = Math.min(w, region.fadeInSeconds * zoom);
                        const fadeOutPx = Math.min(w, region.fadeOutSeconds * zoom);
                        const name = region.label === '' ? 'Sound' : region.label;
                        return (
                          <div
                            key={original.id}
                            className="region"
                            data-selected={regionId === original.id}
                            data-dragging={drag?.regionId === original.id}
                            data-region-id={original.id}
                            role="group"
                            aria-label={`${name}, ${timecode(region.startSeconds)} to ${timecode(region.endSeconds)}`}
                            style={{ left, width: w, transform: `translateY(${String(lift)}px)` }}
                            onDoubleClick={() => {
                              setSelection({
                                trackIds: [track.id],
                                from: original.startSeconds,
                                to: original.endSeconds,
                              });
                            }}
                          >
                            <span
                              className="region-bar"
                              title="Drag to move"
                              aria-hidden="true"
                              onPointerDown={(event) => {
                                onRegionDown(event, original, 'move');
                              }}
                              onPointerMove={onRegionMove}
                              onPointerUp={() => {
                                onRegionUp(original, track);
                              }}
                            />
                            <span className="region-label">
                              {name}
                              {region.gainDb !== 0 && (
                                <small>{` ${region.gainDb > 0 ? '+' : ''}${region.gainDb.toFixed(1)} dB`}</small>
                              )}
                            </span>
                            <RegionWave region={region} width={w} height={LANE_PX - 26} />
                            <svg
                              className="fades"
                              width={w}
                              height={LANE_PX - 8}
                              aria-hidden="true"
                            >
                              {fadeInPx > 0 && (
                                <path d={`M0 ${String(LANE_PX - 8)} L${String(fadeInPx)} 18`} />
                              )}
                              {fadeOutPx > 0 && (
                                <path
                                  d={`M${String(w - fadeOutPx)} 18 L${String(w)} ${String(LANE_PX - 8)}`}
                                />
                              )}
                            </svg>
                            <span
                              className="trim trim-start"
                              aria-hidden="true"
                              onPointerDown={(event) => {
                                onRegionDown(event, original, 'start');
                              }}
                              onPointerMove={onRegionMove}
                              onPointerUp={() => {
                                onRegionUp(original, track);
                              }}
                            />
                            <span
                              className="trim trim-end"
                              aria-hidden="true"
                              onPointerDown={(event) => {
                                onRegionDown(event, original, 'end');
                              }}
                              onPointerMove={onRegionMove}
                              onPointerUp={() => {
                                onRegionUp(original, track);
                              }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
              <div className="audio-playhead" style={{ left: at * zoom }} />
            </div>
          </div>
        </div>
        <Inspector
          doc={doc}
          region={picked?.region}
          track={pickedTrack}
          history={history}
          edit={edit}
          onSelectRegion={(region) => {
            const owner = allRegions.find((entry) => entry.region.id === region.id)?.track;
            if (owner === undefined) return;
            setRegionId(null);
            setSelection({
              trackIds: [owner.id],
              from: region.startSeconds,
              to: region.endSeconds,
            });
          }}
        />
      </div>
      <p className="muted small shortcuts">
        Space plays · S splits at the playhead · drag across a track to select (two fingers pan and
        zoom) · Ctrl+X, C, V cut, copy and paste · Delete removes and closes the gap · Ctrl+L
        silences · Ctrl+Z undoes
      </p>
    </div>
  );
}

const KIND_LABEL = {
  dialogue: 'Dialogue',
  effect: 'Effect',
  music: 'Music',
  voice: 'Voice',
} as const;

function NewDocument({
  project,
  onCreated,
  onCancel,
}: {
  project: Project;
  onCreated: (id: string) => void;
  onCancel: (() => void) | null;
}): ReactElement {
  const imp = useImp();
  const library = useLive([`projects/${project.id}/movie/`], async (current) =>
    project.mode === 'movie'
      ? Library.parse(await runCommand(current, 'movie.sound.library', { projectId: project.id }))
      : { sounds: [] },
  );
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const sounds = library.data?.sounds ?? [];
  const create = (): void => {
    setError(null);
    const sources = chosen.map((key) => ({
      key,
      label: sounds.find((sound) => sound.key === key)?.label ?? '',
    }));
    runCommand(imp, 'audio.doc.create', {
      projectId: project.id,
      name: name.trim() === '' ? 'Untitled sound' : name.trim(),
      sources,
    }).then(
      (output) => {
        onCreated(WithDoc.parse(output).document.id);
      },
      (reason: unknown) => {
        setError(messageOf(reason));
      },
    );
  };
  return (
    <section className="card stack new-audio" aria-label="New audio document">
      <div className="field">
        <label htmlFor={nameId}>Name</label>
        <input
          id={nameId}
          className="input"
          value={name}
          placeholder="Scene 4, lamp room"
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </div>
      <fieldset className="library">
        <legend>Sounds to start with, each on its own track</legend>
        {library.data !== undefined && sounds.length === 0 && (
          <p className="muted">
            No sounds are recorded yet. Record dialogue on the Shots stage or make effects and music
            on the Sound stage, or start empty.
          </p>
        )}
        {sounds.map((sound) => (
          <label key={sound.key} className="library-item">
            <input
              type="checkbox"
              checked={chosen.includes(sound.key)}
              onChange={(event) => {
                setChosen((before) =>
                  event.target.checked
                    ? [...before, sound.key]
                    : before.filter((key) => key !== sound.key),
                );
              }}
            />
            <span className="tag neutral">{KIND_LABEL[sound.kind]}</span>
            <span>{sound.label}</span>
            {sound.sceneHeading !== null && (
              <span className="muted small">{sound.sceneHeading}</span>
            )}
          </label>
        ))}
      </fieldset>
      <Problem text={library.error ?? error} />
      <div className="row">
        <button type="button" className="button primary" onClick={create}>
          <WaveformIcon aria-hidden="true" />{' '}
          {chosen.length === 0
            ? 'Start empty'
            : `Open ${String(chosen.length)} ${chosen.length === 1 ? 'sound' : 'sounds'}`}
        </button>
        {onCancel !== null && (
          <button type="button" className="button quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </section>
  );
}

/** The window event that sends the person to another view; its detail is the view's id. */
export const OPEN_VIEW = 'imp:open-view';

/** Opens a scene's sound in the audio editor, on the Edit stage. */
export function OpenInAudioEditor({
  project,
  sceneId,
}: {
  project: Project;
  sceneId: string;
}): ReactElement {
  const imp = useImp();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="button quiet"
        title="Edit this scene's sound in the audio editor: waveforms, trims, fades, levels"
        onClick={() => {
          setError(null);
          runCommand(imp, 'audio.doc.open', {
            projectId: project.id,
            kind: 'scene',
            target: sceneId,
          }).then(
            (output) => {
              try {
                localStorage.setItem(DOC_SETTING(project), WithDoc.parse(output).document.id);
              } catch {
                // The editor then opens its newest document, which this is.
              }
              window.dispatchEvent(new CustomEvent(OPEN_VIEW, { detail: 'audio' }));
            },
            (reason: unknown) => {
              setError(messageOf(reason));
            },
          );
        }}
      >
        <WaveformIcon aria-hidden="true" /> Audio editor
      </button>
      {error !== null && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

/** The Audio stage: a list of audio documents, and the editor for the open one. */
export function AudioView({ project }: { project: Project }): ReactElement {
  const imp = useImp();
  const listed = useLive([`${audioPrefix(project)}docs/`], async (current) =>
    Documents.parse(await runCommand(current, 'audio.doc.list', { projectId: project.id })),
  );
  const [openId, setOpenIdState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DOC_SETTING(project));
    } catch {
      return null;
    }
  });
  const [making, setMaking] = useState(false);
  const setOpenId = (id: string | null): void => {
    setOpenIdState(id);
    try {
      if (id === null) localStorage.removeItem(DOC_SETTING(project));
      else localStorage.setItem(DOC_SETTING(project), id);
    } catch {
      // Remembering the open document is a convenience.
    }
  };
  const documents = listed.data?.documents ?? [];
  const open = documents.find((candidate) => candidate.id === openId) ?? documents[0];

  return (
    <>
      <div className="view-head">
        <h1>Audio</h1>
        <div className="row wrap audio-docs" role="tablist" aria-label="Audio documents">
          {documents.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              className="chip"
              aria-selected={candidate.id === open?.id && !making}
              onClick={() => {
                setMaking(false);
                setOpenId(candidate.id);
              }}
            >
              <span>{candidate.name}</span>
            </button>
          ))}
          <button
            type="button"
            className="chip add"
            onClick={() => {
              setMaking(true);
            }}
          >
            <PlusIcon aria-hidden="true" /> New
          </button>
        </div>
      </div>
      <Problem text={listed.error} />
      {making || (listed.data !== undefined && documents.length === 0) ? (
        <>
          {documents.length === 0 && (
            <p className="muted">
              Edit sound the way an audio editor does: cut, trim, fade, level and mix recorded
              dialogue, effects and music on tracks. Agents can do every step too, and you can undo
              their work at once.
            </p>
          )}
          <NewDocument
            project={project}
            onCancel={
              documents.length === 0
                ? null
                : () => {
                    setMaking(false);
                  }
            }
            onCreated={(id) => {
              setMaking(false);
              setOpenId(id);
            }}
          />
        </>
      ) : open !== undefined ? (
        <>
          <AudioEditor
            key={open.id}
            project={project}
            docId={open.id}
            onClose={() => {
              setOpenId(null);
            }}
          />
          <div className="row wrap doc-actions">
            <EditableField
              label="Document name"
              value={open.name}
              onCommit={(name) =>
                runCommand(imp, 'audio.doc.rename', { projectId: project.id, docId: open.id, name })
              }
            />
            <ConfirmButton
              label="Delete document"
              question="Delete this audio document? The sounds it plays stay."
              onConfirm={() => {
                void runCommand(imp, 'audio.doc.delete', {
                  projectId: project.id,
                  docId: open.id,
                }).then(() => {
                  setOpenId(null);
                });
              }}
            >
              <TrashIcon aria-hidden="true" />
            </ConfirmButton>
          </div>
        </>
      ) : null}
    </>
  );
}
