import { CheckpointBar } from './checkpoints.js';
import type { Project } from '@imp/core';
import {
  ArrowCounterClockwiseIcon,
  ArrowClockwiseIcon,
  ClipboardIcon,
  CopyIcon,
  FlagIcon,
  PauseIcon,
  PlayIcon,
  ScissorsIcon,
  BracketsSquareIcon,
  SpeakerHighIcon,
  TextTIcon,
  TrashIcon,
  ExportIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  PaletteIcon,
  PlusIcon,
  QuestionIcon,
  SidebarSimpleIcon,
  SplitHorizontalIcon,
  ArrowsInLineHorizontalIcon,
  XIcon,
  FilmReelIcon,
} from '@phosphor-icons/react';
import { EditHelp, Popover, SplitBar, useTimelineHeight } from './edit-chrome.js';
import { IDENTITY_MATRIX } from '@imp/mode-movie';
import { FilmStrip } from './film-strip.js';
import { FilmLookPanel, GradeTools, LookView, PRESET_LABELS } from './grade.js';
import { MarkerInspector, MarkerLane, MarkerList, type MarkerView } from './markers.js';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from 'react';
import { setAttachment, useAttachment } from './attachment.js';
import { runCommand, useImp, useLive } from './context.js';
import {
  clock,
  blobKeys,
  CutPlayer,
  Film,
  ITEM_STATE_TEXT,
  loadCut,
  placementKey,
  Proposal,
  Scenes,
  type Change,
  type Cut,
  type Look,
  type Placement,
  type Source,
  gradeFilterId,
  HIDDEN,
  matrixValues,
  screenStyle,
  type ScreenLook,
} from './cut-player.js';
import { OpenInAudioEditor } from './audio.js';
import { ExportBar } from './ExportBar.js';
import { grabs, useDrag } from './drag.js';
import { useCoarsePointer, usePinchZoom } from './gestures.js';
import { CharacterLanes, LineInspector } from './lines.js';
import { NumberField } from './NumberField.js';
import { EditableField } from './Field.js';
import { moviePrefix, Problem, useAct, type Act } from './movie.js';
import { ChangeList, ProposalBar } from './proposal.js';
import { PickupNote, PickupRequest } from './pickups.js';
import { RescueTools } from './rescue.js';
import { TRANSITIONS, TransitionPicker } from './transition.js';
import { SplitEdit, TakeSwitcher } from './split-edit.js';
import { useLibraryDrop } from './library/drag.js';
import { isPlayableSound, soundForScene } from './library/scene.js';
import {
  StyleEditor,
  TextInspector,
  TextLane,
  TEXT_WORDS_ID,
  TextOverlay,
  TextTools,
  useTextStyles,
} from './texts.js';
import { EmptyState } from './help/EmptyState.js';
import { fixed, t, tn } from '../i18n/i18n.js';
import { formatUsd } from './spend.js';
import { ImpSpinner } from './ImpMark.js';
import { RenderingBadge, usePendingClips } from './clips-pending.js';

/** Turns stored media into object URLs for as long as the keys are shown. */
function useBlobUrls(keys: readonly string[]): ReadonlyMap<string, string> {
  const imp = useImp();
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const joined = [...new Set(keys)].sort().join('\n');
  useEffect(() => {
    let active = true;
    const made: string[] = [];
    const wanted = joined === '' ? [] : joined.split('\n');
    void Promise.all(wanted.map(async (key) => [key, await imp.blob(key)] as const)).then(
      (blobs) => {
        if (!active) return;
        const next = new Map<string, string>();
        for (const [key, blob] of blobs) {
          if (blob === undefined) continue;
          const url = URL.createObjectURL(new Blob([blob.bytes.slice()], { type: blob.mediaType }));
          made.push(url);
          next.set(key, url);
        }
        setUrls(next);
      },
    );
    return () => {
      active = false;
      for (const url of made) URL.revokeObjectURL(url);
    };
  }, [imp, joined]);
  return urls;
}

/** How long each stored sound plays, read from the files. */
function useAudioLengths(urls: ReadonlyMap<string, string>): ReadonlyMap<string, number> {
  const [lengths, setLengths] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    let active = true;
    for (const [key, url] of urls) {
      const probe = new Audio();
      probe.preload = 'metadata';
      probe.onloadedmetadata = () => {
        if (active && Number.isFinite(probe.duration)) {
          setLengths((before) => new Map(before).set(key, probe.duration));
        }
      };
      probe.src = url;
    }
    return () => {
      active = false;
    };
  }, [urls]);
  return lengths;
}
function usePlayback(cut: Cut, source: Source, urls: ReadonlyMap<string, string>) {
  const [at, setAt] = useState(0);
  /** How many times the cut has played to its end. */
  const [endings, setEndings] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [look, setLook] = useState<Look>({ brightness: 1, title: '', card: false });
  const [player] = useState(
    () =>
      new CutPlayer(
        { cut, source, urls },
        {
          at: setAt,
          playing: setPlaying,
          look: (next) => {
            // A new look only when something in it changed, so that a still frame draws once.
            setLook((before) => (JSON.stringify(before) === JSON.stringify(next) ? before : next));
          },
          ended: () => {
            setEndings((count) => count + 1);
          },
        },
      ),
  );
  useEffect(() => {
    player.update({ cut, source, urls });
  }, [player, cut, source, urls]);
  useEffect(
    () => () => {
      player.dispose();
    },
    [player],
  );
  return {
    // Callback refs: the player keeps the elements.
    attachVideo: (element: HTMLVideoElement | null) => {
      player.attach(element, null);
    },
    attachVoice: (element: HTMLAudioElement | null) => {
      player.attach(null, element);
    },
    attachSecondVideo: (element: HTMLVideoElement | null) => {
      player.attach(element, null, 1);
    },
    attachSecondVoice: (element: HTMLAudioElement | null) => {
      player.attach(null, element, 1);
    },
    at,
    playing,
    look,
    endings,
    /** The time to the millisecond, for drawing texts smoothly while playing. */
    now: () => player.now,
    play: () => {
      player.play();
    },
    pause: () => {
      player.pause();
    },
    seek: (seconds: number) => {
      player.seek(seconds);
    },
  };
}

const EMPTY_CUT: Cut = {
  totalSeconds: 0,
  canUndo: false,
  canRedo: false,
  items: [],
  unplaced: [],
  sounds: [],
  lanes: [],
  lines: [],
  texts: [],
  look: { exposure: 0, contrast: 0, temperature: 0, tint: 0, saturation: 0, preset: null },
  version: 'cut',
  draft: null,
};

/** A stretch of the timeline the person marked, to ask the crew about. */
interface Range {
  from: number;
  to: number;
}

/** How a piece is marked while the proposal is shown, like tracked changes. */
type Mark = Change['kind'];

/** How many pixels wide a second is on the timeline. */
const MIN_SCALE = 12;
/** Close enough to see and step single frames. */
const MAX_SCALE = 600;
/** The frame rate the timeline steps and draws its frame grid at. */
const FRAME_RATE = 30;
/** A piece without length still gets a handle to grab. */
const MIN_BLOCK_PX = 18;

type Selection =
  | { kind: 'item'; id: string }
  | { kind: 'sound'; id: string }
  | { kind: 'line'; id: string }
  | { kind: 'text'; id: string }
  | { kind: 'marker'; id: string }
  | null;

/** Pieces narrower than this show their words only, without a still. */
const THUMB_MIN_BLOCK_PX = 96;

function Timeline({
  cut,
  scale,
  at,
  selection,
  lengths,
  source,
  onSelect,
  onSeek,
  onZoom,
  act,
  sceneId,
  readOnly,
  marks,
  removed,
  range,
  markers,
  urls,
}: {
  cut: Cut;
  scale: number;
  at: number;
  selection: Selection;
  lengths: ReadonlyMap<string, number>;
  source: Source;
  onSelect: (selection: Selection) => void;
  onSeek: (seconds: number) => void;
  /** Zooms to a new scale, keeping the given second under the same point of the screen. */
  onZoom: (scale: number) => void;
  act: Act;
  sceneId: string;
  /** The proposal is shown: it is looked at and played, not edited. */
  readOnly: boolean;
  /** The pieces agents changed, by id, while the proposal is shown. */
  marks: ReadonlyMap<string, Mark>;
  /** Pieces the proposal takes out, where they were in the cut. */
  removed: readonly Change[];
  range: Range | null;
  markers: readonly MarkerView[];
  /** Media addresses by blob key, for the still each clip shows on its piece. */
  urls: ReadonlyMap<string, string>;
}): ReactElement {
  const edges = useDrag();
  /** Whether a pointer on a piece may start dragging it. */
  const may = (event: PointerEvent, selected: boolean): boolean =>
    !readOnly && grabs(event, selected);
  const marked = (id: string): string => {
    const mark = marks.get(id);
    return mark === undefined ? '' : ` tracked tracked-${mark}`;
  };
  /**
   * A still from the stretch of the clip a piece uses: its first frame, or its
   * last when it plays backwards. Pieces too short to hold one keep their words.
   */
  const thumbFor = (item: Cut['items'][number], width: number): ReactElement | null => {
    if (item.kind !== 'shot' || item.placeholder || width < THUMB_MIN_BLOCK_PX) return null;
    const key = source.shots.find((shot) => shot.id === item.shotId)?.clip?.blobKey;
    const url = key === undefined || key === null ? undefined : urls.get(key);
    if (url === undefined) return null;
    const second = item.reverse
      ? Math.max(0, item.sourceSeconds - item.trimEndSeconds - 0.1)
      : item.trimStartSeconds + 0.1;
    return (
      <video
        className="block-thumb"
        src={`${url}#t=${second.toFixed(2)}`}
        muted
        playsInline
        preload="metadata"
        aria-hidden="true"
        tabIndex={-1}
      />
    );
  };
  const audioDrag = useDrag();
  const lineDrag = useDrag();
  const moving = useDrag();
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [scrubbing, setScrubbing] = useState(false);
  // The second of the timeline where a picture piece was grabbed.
  const [grabbed, setGrabbed] = useState(0);
  // The second under the fingers stays under them while pinching.
  const pending = useRef<{ second: number; offset: number } | null>(null);
  // Several pinch steps can arrive before the next render, so they build on each other here.
  const zooming = useRef(scale);
  usePinchZoom(scroller, (factor, clientX) => {
    const box = scroller.current?.getBoundingClientRect();
    if (box === undefined || scroller.current === null) return;
    const offset = clientX - box.left;
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, zooming.current * factor));
    zooming.current = next;
    // Measured against what is on screen, which still has the rendered scale.
    pending.current ??= { second: (scroller.current.scrollLeft + offset) / scale, offset };
    onZoom(next);
  });
  useEffect(() => {
    zooming.current = scale;
    const anchor = pending.current;
    const view = scroller.current;
    if (view === null) return;
    if (anchor === null) {
      // Zoomed with the slider or Fit: the playhead stays in view, centred if it fell out.
      const x = at * scale;
      if (x < view.scrollLeft || x > view.scrollLeft + view.clientWidth) {
        view.scrollLeft = Math.max(0, x - view.clientWidth / 2);
      }
      return;
    }
    pending.current = null;
    view.scrollLeft = anchor.second * scale - anchor.offset;
  }, [scale]); // eslint-disable-line react-hooks/exhaustive-deps
  /** The second of the timeline under a point of the screen. */
  const secondAt = (clientX: number): number => {
    const box = inner.current?.getBoundingClientRect();
    return box === undefined ? 0 : Math.max(0, (clientX - box.left) / scale);
  };
  // From the library: sounds onto the audio lane where they are let go, shot clips into the picture.
  const audioLane = useRef<HTMLDivElement>(null);
  const pictureLane = useRef<HTMLDivElement>(null);
  const done = (output: unknown): unknown => {
    // act shows what went wrong under the timeline and answers nothing.
    if (output === undefined)
      throw new Error(t('It was not placed; see the message on the stage.'));
    return output;
  };
  useLibraryDrop(audioLane, {
    label: t('Edit stage, audio lane, at the playhead'),
    accepts: (asset) => !readOnly && isPlayableSound(asset),
    onDrop: async (asset, point) => {
      const run = async (id: string, input: Record<string, unknown>) => done(await act(id, input));
      const sound = await soundForScene(run, sceneId, asset);
      await run('movie.edit.sound.place', {
        sceneId,
        ...(sound.source === 'sound'
          ? { source: 'sound', soundId: sound.soundId }
          : { source: 'dialogue', shotId: sound.shotId, shotSceneId: sound.shotSceneId }),
        startSeconds: point === null ? at : secondAt(point.clientX),
        volume: asset.kind === 'music' ? 0.4 : 1,
      });
    },
  });
  useLibraryDrop(pictureLane, {
    label: t('Edit stage, picture, at the end'),
    accepts: (asset) =>
      !readOnly && asset.id.startsWith('movie:clip:') && asset.refs['shotId'] !== undefined,
    onDrop: async (asset, point) => {
      const second = point === null ? null : secondAt(point.clientX);
      const index =
        second === null
          ? undefined
          : cut.items.findIndex((item) => item.startsAtSeconds + item.durationSeconds / 2 > second);
      done(
        await act('movie.edit.item.add', {
          sceneId,
          shotId: asset.refs['shotId'],
          ...(asset.refs['sceneId'] === sceneId ? {} : { shotSceneId: asset.refs['sceneId'] }),
          ...(index === undefined || index < 0 ? {} : { toIndex: index }),
        }),
      );
    },
  });
  const audioLength = (placement: Placement): number => {
    if (placement.loop) return Math.max(cut.totalSeconds - placement.startSeconds, 1);
    const item = cut.items.find((candidate) => candidate.shotId === placement.shotId);
    if (placement.source === 'clip' && item !== undefined) return item.sourceSeconds;
    const file = placementKey(placement, source);
    const measured = file === undefined ? undefined : lengths.get(file);
    return Math.max((measured ?? 3) - placement.trimStartSeconds, 0.5);
  };
  const widest = Math.max(
    cut.totalSeconds,
    ...cut.sounds.map((placement) => placement.startSeconds + audioLength(placement)),
    ...cut.lines.map((line) => line.startSeconds + Math.max(line.durationSeconds, 0.5)),
    ...cut.texts.map((text) => text.startSeconds + text.durationSeconds),
    10,
  );
  const width = Math.ceil((widest + 2) * scale);
  const playing = cut.items.filter((item) => item.durationSeconds > 0);
  const ticks = Array.from({ length: Math.floor(widest + 2) + 1 }, (_, second) => second);
  const every = scale < 24 ? 10 : scale < 50 ? 5 : 1;

  // Where a picture piece being moved would land: before the piece under the pointer.
  const movingId = moving.dragging?.id;
  const target =
    moving.dragging === null || Math.abs(moving.dragging.dx) < 2
      ? undefined
      : playing.find((candidate) => {
          const second = grabbed + (moving.dragging?.dx ?? 0) / scale;
          return (
            candidate.itemId !== movingId &&
            second >= candidate.startsAtSeconds &&
            second < candidate.startsAtSeconds + candidate.durationSeconds
          );
        });

  return (
    <div className="timeline" role="group" aria-label={t('Timeline')} data-readonly={readOnly}>
      <div className="timeline-scroll" ref={scroller}>
        <div className="timeline-inner" style={{ width }} ref={inner}>
          <div
            className="timeline-ruler"
            data-scrubbing={scrubbing}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              setScrubbing(true);
              onSeek(secondAt(event.clientX));
            }}
            onPointerMove={(event) => {
              if (scrubbing) onSeek(secondAt(event.clientX));
            }}
            onPointerUp={() => {
              setScrubbing(false);
            }}
            onPointerCancel={() => {
              setScrubbing(false);
            }}
            role="slider"
            tabIndex={0}
            onKeyDown={(event) => {
              // Shift steps a single frame.
              const by = event.shiftKey ? 1 / FRAME_RATE : 1;
              if (event.key === 'ArrowRight') onSeek(at + by);
              if (event.key === 'ArrowLeft') onSeek(Math.max(0, at - by));
            }}
            aria-label={t('Playhead')}
            style={
              scale >= 200
                ? {
                    // A line at every frame once frames are wide enough to tell apart.
                    backgroundImage: `repeating-linear-gradient(to right, var(--line-strong) 0 1px, transparent 1px ${String(scale / FRAME_RATE)}px)`,
                    backgroundSize: '100% 6px',
                    backgroundRepeat: 'no-repeat',
                    backgroundPosition: t('bottom left'),
                  }
                : undefined
            }
            aria-valuemin={0}
            aria-valuemax={Math.round(cut.totalSeconds)}
            aria-valuenow={Math.round(at)}
          >
            {ticks
              .filter((second) => second % every === 0)
              .map((second) => (
                <span key={second} className="tick" style={{ left: second * scale }}>
                  {clock(second)}
                </span>
              ))}
          </div>
          <MarkerLane
            markers={markers}
            scale={scale}
            selectedId={selection?.kind === 'marker' ? selection.id : null}
            onSelect={(marker) => {
              onSelect({ kind: 'marker', id: marker.id });
              onSeek(marker.atSeconds);
            }}
          />
          <TextLane
            texts={cut.texts}
            scale={scale}
            selectedId={selection?.kind === 'text' ? selection.id : null}
            onSelect={(id) => {
              onSelect({ kind: 'text', id });
            }}
            act={act}
            sceneId={sceneId}
            may={may}
            marked={marked}
          />
          <div className="lane lane-picture" aria-label={t('Picture lane')} ref={pictureLane}>
            <span className="lane-name">{t('Picture')}</span>
            {playing.map((item) => {
              const drag = edges.dragging?.id === item.itemId ? edges.dragging : null;
              const shift = drag === null ? 0 : drag.dx / scale;
              const startShift = drag?.edge === 'start' ? shift : 0;
              const endShift = drag?.edge === 'end' ? shift : 0;
              const lift = moving.dragging?.id === item.itemId ? moving.dragging.dx : 0;
              const left = (item.startsAtSeconds + startShift) * scale + lift;
              const blockWidth = Math.max(
                MIN_BLOCK_PX,
                (item.durationSeconds - startShift + endShift) * scale,
              );
              const selected = selection?.kind === 'item' && selection.id === item.itemId;
              return (
                <div
                  key={item.itemId}
                  className={`block block-${item.kind}${item.placeholder ? ' block-placeholder' : ''}${selected ? ' selected' : ''}${target?.itemId === item.itemId ? ' drop' : ''}${lift === 0 ? '' : ' lifted'}${marked(item.itemId)}`}
                  style={{ left, width: blockWidth }}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  aria-label={`${item.kind === 'title' ? t('Title {index}', { index: item.index }) : item.placeholder ? t('Pickup to come {index}', { index: item.index }) : t('Shot {index}', { index: item.index })}: ${item.label.slice(0, 40)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect({ kind: 'item', id: item.itemId });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onSelect({ kind: 'item', id: item.itemId });
                  }}
                  onPointerDown={(event) => {
                    if (!may(event, selected)) return;
                    setGrabbed(secondAt(event.clientX));
                    moving.start(event, item.itemId, 'move');
                  }}
                  onPointerMove={moving.move}
                  onPointerUp={(event) => {
                    const landing = target;
                    moving.end(event, (id) => {
                      if (landing === undefined) return;
                      void act('movie.edit.item.move', {
                        sceneId,
                        itemId: id,
                        toIndex: cut.items.findIndex(
                          (candidate) => candidate.itemId === landing.itemId,
                        ),
                      });
                    });
                  }}
                  onPointerCancel={moving.cancel}
                >
                  {item.kind === 'shot' && !item.placeholder && (
                    <span
                      className="handle handle-start"
                      aria-label={t('Trim the start of item {index}', {
                        index: String(item.index),
                      })}
                      onPointerDown={(event) => {
                        if (may(event, selected)) edges.start(event, item.itemId, 'start');
                      }}
                      onPointerMove={edges.move}
                      onPointerCancel={edges.cancel}
                      onPointerUp={(event) => {
                        edges.end(event, (id, _edge, distance) => {
                          // The start shows the clip's end when it plays backwards; seconds of the clip go at its speed.
                          const field = item.reverse ? 'trimEndSeconds' : 'trimStartSeconds';
                          void act('movie.edit.item.set', {
                            sceneId,
                            itemId: id,
                            [field]: Math.max(
                              0,
                              Math.round((item[field] + (distance / scale) * item.speed) * 10) / 10,
                            ),
                          });
                        });
                      }}
                    />
                  )}
                  {item.transition !== 'cut' && (
                    <span
                      className={`transition-mark transition-${item.transition}`}
                      style={{ width: Math.max(10, item.overlapSeconds * scale) }}
                      title={t('{transition} in', {
                        transition:
                          TRANSITIONS.find((choice) => choice.kind === item.transition)?.label ??
                          item.transition,
                      })}
                      aria-hidden="true"
                    />
                  )}
                  {thumbFor(item, blockWidth)}
                  <span className="block-label">
                    {item.index} · {item.placeholder ? `${t('Pickup')} · ` : ''}
                    {item.label || t('Untitled')}
                  </span>
                  {item.kind === 'shot' && !item.placeholder && (
                    <span
                      className="handle handle-end"
                      aria-label={t('Trim the end of item {index}', { index: String(item.index) })}
                      onPointerDown={(event) => {
                        if (may(event, selected)) edges.start(event, item.itemId, 'end');
                      }}
                      onPointerMove={edges.move}
                      onPointerCancel={edges.cancel}
                      onPointerUp={(event) => {
                        edges.end(event, (id, _edge, distance) => {
                          const field = item.reverse ? 'trimStartSeconds' : 'trimEndSeconds';
                          void act('movie.edit.item.set', {
                            sceneId,
                            itemId: id,
                            [field]: Math.max(
                              0,
                              Math.round((item[field] - (distance / scale) * item.speed) * 10) / 10,
                            ),
                          });
                        });
                      }}
                    />
                  )}
                </div>
              );
            })}
            {cut.items
              .filter((item) => item.state === 'clip_pending' && item.durationSeconds === 0)
              .map((item) => (
                <button
                  key={item.itemId}
                  type="button"
                  className={`rendering-pin${selection?.kind === 'item' && selection.id === item.itemId ? ' selected' : ''}`}
                  style={{ left: item.startsAtSeconds * scale }}
                  title={t(
                    'Shot {index}: the clip is being made. It joins the cut here when it is ready.',
                    {
                      index: String(item.index),
                    },
                  )}
                  aria-label={t('Shot {index}: clip being made', { index: String(item.index) })}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect({ kind: 'item', id: item.itemId });
                  }}
                >
                  <ImpSpinner size={12} />
                  <span>{item.index}</span>
                </button>
              ))}
          </div>
          {removed.length > 0 && (
            <div className="lane lane-removed" aria-label={t('Taken out by the proposal')}>
              <span className="lane-name">{t('Taken out')}</span>
              {removed.map((change) => (
                <div
                  key={change.id}
                  className="ghost"
                  style={{
                    left: change.startsAtSeconds * scale,
                    width: Math.max(MIN_BLOCK_PX, change.durationSeconds * scale),
                  }}
                  title={change.summary}
                >
                  <span className="block-label">{change.summary}</span>
                </div>
              ))}
            </div>
          )}
          <div className="lane lane-audio" aria-label={t('Audio lane')} ref={audioLane}>
            <span className="lane-name">{t('Audio')}</span>
            {cut.sounds.map((placement) => {
              const drag = audioDrag.dragging?.id === placement.id ? audioDrag.dragging : null;
              const start = Math.max(
                0,
                placement.startSeconds + (drag === null ? 0 : drag.dx / scale),
              );
              const selected = selection?.kind === 'sound' && selection.id === placement.id;
              return (
                <div
                  key={placement.id}
                  className={`block block-${placement.kind}${selected ? ' selected' : ''}${placement.recorded ? '' : ' empty'}${marked(placement.id)}`}
                  style={{
                    left: start * scale,
                    width: Math.max(MIN_BLOCK_PX, audioLength(placement) * scale),
                  }}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  aria-label={t('Audio: {name}', { name: placement.name })}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect({ kind: 'sound', id: placement.id });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onSelect({ kind: 'sound', id: placement.id });
                  }}
                  onPointerDown={(event) => {
                    if (!may(event, selected)) return;
                    audioDrag.start(event, placement.id, 'move');
                    onSelect({ kind: 'sound', id: placement.id });
                  }}
                  onPointerMove={audioDrag.move}
                  onPointerCancel={audioDrag.cancel}
                  onPointerUp={(event) => {
                    audioDrag.end(event, (id, _edge, distance) => {
                      void act('movie.edit.sound.update', {
                        sceneId,
                        placementId: id,
                        startSeconds: Math.max(
                          0,
                          Math.round((placement.startSeconds + distance / scale) * 10) / 10,
                        ),
                      });
                    });
                  }}
                >
                  <span className="block-label">{placement.name}</span>
                </div>
              );
            })}
          </div>
          <CharacterLanes
            cut={cut}
            scale={scale}
            at={at}
            sceneId={sceneId}
            selectedId={selection?.kind === 'line' ? selection.id : null}
            onSelect={(id) => {
              onSelect({ kind: 'line', id });
            }}
            act={act}
            marks={marks}
            drag={(line, selected) => ({
              dx: lineDrag.dragging?.id === line.id ? lineDrag.dragging.dx / scale : 0,
              props: {
                onPointerDown: (event) => {
                  if (!may(event, selected)) return;
                  lineDrag.start(event, line.id, 'move');
                  onSelect({ kind: 'line', id: line.id });
                },
                onPointerMove: lineDrag.move,
                onPointerCancel: lineDrag.cancel,
                onPointerUp: (event) => {
                  lineDrag.end(event, (id, _edge, distance) => {
                    void act('movie.edit.line.update', {
                      sceneId,
                      lineId: id,
                      startSeconds: Math.max(
                        0,
                        Math.round((line.startSeconds + distance / scale) * 10) / 10,
                      ),
                    });
                  });
                },
              },
            })}
          />
          {range !== null && (
            <div
              className="range-band"
              style={{ left: range.from * scale, width: (range.to - range.from) * scale }}
              aria-hidden="true"
            />
          )}
          <div className="playhead" style={{ left: at * scale }} aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

function SceneEditor({
  project,
  sceneId,
  sceneLabel,
  act: actOnCut,
  autoplay = false,
  canMatch = false,
  onEnded,
  onHelp,
}: {
  project: Project;
  sceneId: string;
  /** Opens the help with the editor's gestures and keys. */
  onHelp: () => void;
  /** How the scene is named to the crew: "Scene 2". */
  sceneLabel: string;
  act: Act;
  /** Start playing as soon as the scene and its media are loaded. */
  autoplay?: boolean;
  /** The scene played to its end. */
  onEnded?: () => void;
  /** Whether this host can read clip colours, to match shots. */
  canMatch?: boolean;
}): ReactElement {
  const [version, setVersion] = useState<'cut' | 'draft'>('cut');
  const live = useLive(
    // The key changes with the version, so that switching reads again.
    version === 'draft'
      ? [moviePrefix(project), `projects/${project.id}/movie/edit-drafts/${sceneId}`]
      : [moviePrefix(project)],
    (imp) => loadCut(imp, project.id, sceneId, version),
  );
  const proposal = useLive([moviePrefix(project)], async (imp) =>
    Proposal.parse(
      await runCommand(imp, 'movie.edit.draft.get', { projectId: project.id, sceneId }),
    ),
  );
  const markerList = useLive([moviePrefix(project)], async (imp) =>
    MarkerList.parse(
      await runCommand(imp, 'movie.edit.marker.list', { projectId: project.id, sceneId }),
    ),
  );
  const markers = markerList.data?.markers ?? [];
  const timelineBox = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [marksAt, setMarksAt] = useState<{ in: number | null; out: number | null }>({
    in: null,
    out: null,
  });
  const attached = useAttachment();
  const [scale, setScale] = useState(48);
  const [clipboard, setClipboard] = useState<{
    itemId: string;
    sceneId: string;
    cutting: boolean;
  } | null>(null);
  const [placing, setPlacing] = useState('');
  const styles = useTextStyles(project);
  /** The style the style editor is open on, or null while it is closed. */
  const [styling, setStyling] = useState<string | null>(null);
  const coarse = useCoarsePointer();
  const editorBox = useRef<HTMLDivElement>(null);
  const timelineHeight = useTimelineHeight();
  // Beside the picture on a wide stage; on a narrow one it slides over the picture while open.
  const [inspectorOpen, setInspectorOpen] = useState(false);
  // Selecting a piece, or showing a proposal, opens the details.
  const selected = selection === null ? '' : `${selection.kind}:${selection.id}`;
  const [opener, setOpener] = useState('');
  const data = live.data;
  const openWith = `${selected}|${live.data?.cut.version === 'draft' ? 'draft' : ''}`;
  if (openWith !== opener) {
    setOpener(openWith);
    if (selected !== '' || live.data?.cut.version === 'draft') setInspectorOpen(true);
  }
  const shots = data?.shots;
  const sounds = data?.sounds;
  const source = useMemo<Source>(
    () => ({ shots: shots ?? [], sounds: sounds ?? [] }),
    [shots, sounds],
  );
  const cut = data?.cut ?? EMPTY_CUT;
  const urls = useBlobUrls(blobKeys(source, cut));
  const lengths = useAudioLengths(urls);
  const { attachVideo, attachVoice, attachSecondVideo, attachSecondVoice, ...playback } =
    usePlayback(cut, source, urls);
  useEffect(() => {
    if (playback.endings > 0) onEnded?.();
  }, [playback.endings]); // eslint-disable-line react-hooks/exhaustive-deps
  // Playing on from the scene before: start once the media is there.
  const started = useRef(!autoplay);
  const mediaReady = data !== undefined && blobKeys(source, cut).every((key) => urls.has(key));
  useEffect(() => {
    if (started.current || !mediaReady) return;
    started.current = true;
    playback.seek(0);
    playback.play();
  }, [mediaReady]); // eslint-disable-line react-hooks/exhaustive-deps
  const range: Range | null =
    marksAt.in !== null && marksAt.out !== null && Math.abs(marksAt.out - marksAt.in) >= 0.1
      ? { from: Math.min(marksAt.in, marksAt.out), to: Math.max(marksAt.in, marksAt.out) }
      : null;
  // The marked stretch goes with the next message to the crew.
  useEffect(() => {
    setAttachment(
      range === null
        ? null
        : {
            label: `${sceneLabel} · ${clock(range.from)}–${clock(range.to)}`,
            projectId: project.id,
            sceneId,
            fromSeconds: Math.round(range.from * 100) / 100,
            toSeconds: Math.round(range.to * 100) / 100,
          },
    );
  }, [range?.from, range?.to, sceneLabel, project.id, sceneId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      setAttachment(null);
    },
    [],
  );
  if (data === undefined) return <Problem text={live.error} />;

  const readOnly = cut.version === 'draft';
  // The proposal is looked at and played; edits go to the cut.
  const act: Act = readOnly ? () => Promise.resolve(undefined) : actOnCut;
  const changes = proposal.data?.changes ?? [];
  const marks = new Map<string, Mark>();
  if (readOnly) {
    for (const change of changes) {
      if (change.kind !== 'removed' && marks.get(change.elementId) !== 'changed') {
        marks.set(change.elementId, change.kind);
      }
    }
  }
  const removed = readOnly
    ? changes.filter((change) => change.part === 'item' && change.kind === 'removed')
    : [];
  const review = (id: string, changeIds?: string[]): void => {
    void actOnCut(id, { sceneId, ...(changeIds === undefined ? {} : { changeIds }) });
  };
  const focus = (change: Change): void => {
    playback.seek(change.startsAtSeconds);
    if (change.kind !== 'removed') setSelection({ kind: change.part, id: change.elementId });
  };

  const item =
    selection?.kind === 'item'
      ? cut.items.find((candidate) => candidate.itemId === selection.id)
      : undefined;
  const placement =
    selection?.kind === 'sound'
      ? cut.sounds.find((candidate) => candidate.id === selection.id)
      : undefined;
  const line =
    selection?.kind === 'line'
      ? cut.lines.find((candidate) => candidate.id === selection.id)
      : undefined;
  const text =
    selection?.kind === 'text'
      ? cut.texts.find((candidate) => candidate.id === selection.id)
      : undefined;
  const run = (id: string, input: Record<string, unknown>): Promise<unknown> =>
    act(id, { sceneId, ...input });
  // Markers are notes, not edits: they can be left on a proposal too.
  const runMarker = (id: string, input: Record<string, unknown>): Promise<unknown> =>
    actOnCut(id, { sceneId, ...input });
  const marker =
    selection?.kind === 'marker'
      ? markers.find((candidate) => candidate.id === selection.id)
      : undefined;
  const addMarker = (): void => {
    void runMarker('movie.edit.marker.add', {
      atSeconds: Math.round(playback.at * 1000) / 1000,
      text: t('Note'),
    }).then((output) => {
      const id = (output as { marker?: { id?: unknown } } | undefined)?.marker?.id;
      if (typeof id === 'string') setSelection({ kind: 'marker', id });
    });
  };
  const fit = (): void => {
    const width = timelineBox.current?.clientWidth ?? 0;
    if (width <= 0) return;
    setScale(
      Math.min(MAX_SCALE, Math.max(MIN_SCALE, (width - 24) / Math.max(4, cut.totalSeconds + 1))),
    );
  };
  const index = item === undefined ? -1 : cut.items.findIndex((c) => c.itemId === item.itemId);
  const canSplit =
    item?.kind === 'shot' &&
    item.durationSeconds > 0 &&
    playback.at > item.startsAtSeconds + 0.2 &&
    playback.at < item.startsAtSeconds + item.durationSeconds - 0.2;

  const split = (): void => {
    if (item !== undefined && canSplit) {
      void run('movie.edit.item.split', {
        itemId: item.itemId,
        atSeconds: Math.round((playback.at - item.startsAtSeconds) * 100) / 100,
      });
    }
  };
  const remove = (): void => {
    if (item !== undefined) {
      void run('movie.edit.item.remove', { itemId: item.itemId });
      setSelection(null);
    } else if (placement !== undefined) {
      void run('movie.edit.sound.remove', { placementId: placement.id });
      setSelection(null);
    } else if (text !== undefined) {
      void run('movie.edit.text.remove', { textIds: [text.id] });
      setSelection(null);
    }
  };
  const copy = (cutting: boolean): void => {
    if (item !== undefined) setClipboard({ itemId: item.itemId, sceneId, cutting });
  };
  const paste = async (): Promise<void> => {
    if (clipboard === null) return;
    await act('movie.edit.item.duplicate', {
      sceneId: clipboard.sceneId,
      itemId: clipboard.itemId,
      toSceneId: sceneId,
      toIndex: index < 0 ? cut.items.length : index + 1,
    });
    if (clipboard.cutting) {
      await act('movie.edit.item.remove', { sceneId: clipboard.sceneId, itemId: clipboard.itemId });
      setClipboard(null);
    }
  };
  const keys = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    const mod = event.metaKey || event.ctrlKey;
    if (!mod && event.key.toLowerCase() === 'i') {
      setMarksAt((before) => ({ ...before, in: playback.at }));
      return;
    }
    if (!mod && event.key.toLowerCase() === 'o') {
      setMarksAt((before) => ({ ...before, out: playback.at }));
      return;
    }
    if (event.key === 'Escape') {
      setMarksAt({ in: null, out: null });
      return;
    }
    // One frame back or on, as in other editors.
    if (!mod && (event.key === ',' || event.key === '.')) {
      event.preventDefault();
      playback.pause();
      playback.seek(Math.max(0, playback.at + (event.key === '.' ? 1 : -1) / FRAME_RATE));
      return;
    }
    if (!mod && event.key.toLowerCase() === 'm') {
      addMarker();
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      if (playback.playing) playback.pause();
      else playback.play();
      return;
    }
    if (readOnly) return;
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      void run(event.shiftKey ? 'movie.edit.redo' : 'movie.edit.undo', {});
    } else if (mod && event.key.toLowerCase() === 'c') {
      copy(false);
    } else if (mod && event.key.toLowerCase() === 'x') {
      copy(true);
    } else if (mod && event.key.toLowerCase() === 'v') {
      void paste();
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      remove();
    } else if (event.key.toLowerCase() === 's' && !mod) {
      split();
    }
  };

  const placeable = [
    ...source.sounds
      .filter((sound) => sound.take !== null)
      .map((sound) => ({
        value: `sound:${sound.id}`,
        label: sound.name === '' ? t('Untitled sound') : sound.name,
      })),
    ...source.shots
      .filter((shot) => shot.sceneId === sceneId && shot.dialogue !== null)
      .map((shot) => ({
        value: `dialogue:${shot.id}`,
        label: t('Dialogue of shot {position}', { position: String(shot.position) }),
      })),
  ];
  const notInFilm = cut.items.filter((candidate) => candidate.durationSeconds === 0);

  const tool = (
    label: string,
    icon: ReactElement,
    onClick: () => void,
    disabled: boolean,
    keyHint?: string,
  ): ReactElement => (
    <button
      type="button"
      className="button quiet icon-only"
      aria-label={label}
      title={keyHint === undefined ? label : `${label} (${keyHint})`}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
  const waiting = notInFilm.length + cut.unplaced.length;
  const zoomBy = (factor: number): void => {
    setScale((before) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, before * factor)));
  };

  return (
    // The shortcuts belong to the whole editor, which takes the keys that reach it.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="editor"
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      onKeyDown={keys}
      aria-label={t('Cut editor')}
      ref={editorBox}
      style={
        timelineHeight.height === null
          ? undefined
          : ({
              '--timeline-height': `${String(timelineHeight.height)}px`,
            } as CSSProperties)
      }
    >
      {cut.draft !== null && (
        <ProposalBar
          draft={cut.draft}
          version={cut.version}
          onVersion={setVersion}
          onKeepAll={() => {
            review('movie.edit.draft.keep');
          }}
          onDiscard={() => {
            review('movie.edit.draft.discard');
          }}
        />
      )}

      <div className="edit-stage" data-inspector={inspectorOpen ? 'open' : 'closed'}>
        <figure className="preview">
          <div className="preview-frame">
            {/* The cut has no captions; the lines are in the shots. */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              ref={attachVideo}
              className="preview-screen"
              aria-label={t('Preview of the scene')}
              playsInline
              style={screenStyle(playback.look.screens?.[0] ?? HIDDEN)}
            />
            {/* The second screen, for the piece that dissolves or wipes in over the first. */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              ref={attachSecondVideo}
              className="preview-screen"
              aria-hidden="true"
              playsInline
              style={screenStyle(playback.look.screens?.[1] ?? HIDDEN, 1)}
            />
            {playback.look.still !== undefined && (
              <div
                className="preview-still"
                style={{ opacity: playback.look.still.level }}
                aria-label={t('Key frame of a shot with no clip yet')}
                role="img"
              >
                <img src={playback.look.still.url} alt="" />
                {playback.look.still.line !== '' && (
                  <p className="preview-still-line">{playback.look.still.line}</p>
                )}
              </div>
            )}
            <GradeFilters screens={playback.look.screens} />
            <div
              className="preview-wash"
              aria-hidden="true"
              style={{ opacity: playback.look.white ?? 0 }}
            />
            <TextOverlay
              texts={cut.texts}
              styles={styles}
              at={playback.at}
              now={playback.now}
              playing={playback.playing}
              look={playback.look}
              selectedId={readOnly ? null : (text?.id ?? null)}
              onPlace={(textId, x, y) => {
                void act('movie.edit.text.set', { sceneId, textId, x, y });
              }}
              onEdit={() => {
                document.getElementById(TEXT_WORDS_ID)?.focus();
              }}
            />
          </div>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio ref={attachVoice} aria-label={t('Dialogue of the preview')} />
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio ref={attachSecondVoice} aria-hidden="true" />
          {range !== null && (
            <div className="range-note">
              <span className="chip" aria-label={t('Marked stretch')}>
                {t('{from}–{to} marked', { from: clock(range.from), to: clock(range.to) })}
                <button
                  type="button"
                  className="button quiet icon"
                  aria-label={t('Clear the marked stretch')}
                  onClick={() => {
                    setMarksAt({ in: null, out: null });
                  }}
                >
                  ×
                </button>
              </span>
              <span className="muted small">
                {attached === null
                  ? t('Detached from the crew panel.')
                  : t('Goes with your next message to the crew.')}
              </span>
            </div>
          )}
        </figure>
        <div
          className="stack inspector"
          aria-label={readOnly ? t('Proposed changes') : t('Selected piece')}
        >
          <button
            type="button"
            className="button quiet icon-only inspector-close"
            aria-label={t('Close the details')}
            onClick={() => {
              setInspectorOpen(false);
            }}
          >
            <XIcon aria-hidden="true" />
          </button>
          {readOnly && (
            <ChangeList
              proposal={proposal.data}
              onKeep={(changeId) => {
                review('movie.edit.draft.keep', [changeId]);
              }}
              onReject={(changeId) => {
                review('movie.edit.draft.reject', [changeId]);
              }}
              onFocus={focus}
            />
          )}
          {marker !== undefined && (
            <MarkerInspector
              key={marker.id}
              marker={marker}
              playheadSeconds={playback.at}
              run={runMarker}
              onRemoved={() => {
                setSelection(null);
              }}
            />
          )}
          {!readOnly &&
            item === undefined &&
            placement === undefined &&
            line === undefined &&
            marker === undefined &&
            text === undefined && (
              <div className="inspector-empty">
                <span className="eyebrow">{t('Nothing selected')}</span>
                <p className="muted">
                  {coarse
                    ? t(
                        'Tap a piece on the timeline to trim, grade, retime or replace it. Mark in and out to ask the crew about a stretch.',
                      )
                    : t(
                        'Select a piece on the timeline to trim, grade, retime or replace it. Mark in and out to ask the crew about a stretch.',
                      )}
                </p>
                <button type="button" className="button quiet" onClick={onHelp}>
                  <QuestionIcon aria-hidden="true" />{' '}
                  {coarse ? t('Gestures and help') : t('Shortcuts and help')}
                </button>
              </div>
            )}
          {!readOnly && item !== undefined && (
            <>
              <h3>
                {item.kind === 'title'
                  ? t('Title card')
                  : t('Shot {index}', { index: String(item.index) })}{' '}
                <span className="muted">
                  {item.placeholder
                    ? t('Pickup to come · {value} s', { value: fixed(item.durationSeconds, 1) })
                    : item.state === 'ready'
                      ? t('{startsAtSeconds} · {value} s', {
                          startsAtSeconds: clock(item.startsAtSeconds),
                          value: fixed(item.durationSeconds, 1),
                        })
                      : ITEM_STATE_TEXT[item.state]}
                </span>
                {item.state === 'clip_pending' && <ImpSpinner size={14} />}
              </h3>
              {item.kind === 'title' ? (
                <>
                  <EditableField
                    label={t('Words')}
                    rows={2}
                    value={item.text}
                    placeholder={t('The words on the card')}
                    onCommit={(text) => run('movie.edit.item.set', { itemId: item.itemId, text })}
                  />
                  <NumberField
                    label={t('Length (s)')}
                    value={item.durationSeconds}
                    step={0.5}
                    max={60}
                    onCommit={(titleSeconds) => {
                      void run('movie.edit.item.set', { itemId: item.itemId, titleSeconds });
                    }}
                  />
                </>
              ) : (
                <p className="muted">{item.label}</p>
              )}
              <PickupNote item={item} />
              <div className="row wrap">
                {item.kind === 'shot' && !item.placeholder && (
                  <>
                    <NumberField
                      label={t('Trim start (s)')}
                      value={item.trimStartSeconds}
                      step={0.1}
                      max={600}
                      onCommit={(value) => {
                        void run('movie.edit.item.set', {
                          itemId: item.itemId,
                          trimStartSeconds: value,
                        });
                      }}
                    />
                    <NumberField
                      label={t('Trim end (s)')}
                      value={item.trimEndSeconds}
                      step={0.1}
                      max={600}
                      onCommit={(value) => {
                        void run('movie.edit.item.set', {
                          itemId: item.itemId,
                          trimEndSeconds: value,
                        });
                      }}
                    />
                    <NumberField
                      label={t('Dialogue volume')}
                      value={item.dialogueVolume}
                      step={0.1}
                      max={1}
                      onCommit={(value) => {
                        void run('movie.edit.item.set', {
                          itemId: item.itemId,
                          dialogueVolume: value,
                        });
                      }}
                    />
                    <NumberField
                      label={t('Clip sound volume')}
                      value={item.clipAudioVolume}
                      step={0.1}
                      max={1}
                      onCommit={(value) => {
                        void run('movie.edit.item.set', {
                          itemId: item.itemId,
                          clipAudioVolume: value,
                        });
                      }}
                    />
                  </>
                )}
                <NumberField
                  label={t('Fade in from black (s)')}
                  value={item.fadeInSeconds}
                  step={0.5}
                  max={30}
                  onCommit={(value) => {
                    void run('movie.edit.item.set', { itemId: item.itemId, fadeInSeconds: value });
                  }}
                />
                <NumberField
                  label={t('Fade out to black (s)')}
                  value={item.fadeOutSeconds}
                  step={0.5}
                  max={30}
                  onCommit={(value) => {
                    void run('movie.edit.item.set', { itemId: item.itemId, fadeOutSeconds: value });
                  }}
                />
              </div>
              {item.kind === 'shot' && item.hasClipAudio && item.clipAudioVolume > 0 && (
                <button
                  className="button"
                  onClick={() => {
                    void run('movie.edit.audio.detach', { itemId: item.itemId });
                  }}
                >
                  <SpeakerHighIcon aria-hidden="true" /> {t("Take the clip's sound apart")}
                </button>
              )}
              {item.kind === 'shot' && (
                <TakeSwitcher
                  shot={shots?.find(
                    (candidate) =>
                      candidate.id === item.shotId && candidate.sceneId === item.sceneId,
                  )}
                  run={run}
                />
              )}
              {index > 0 && <TransitionPicker item={item} run={run} />}
              <RescueTools item={item} playheadSeconds={playback.at} run={run} />
              <GradeTools item={item} items={cut.items} run={run} canMatch={canMatch} />
              <SplitEdit item={item} next={cut.items[index + 1]} run={run} />
              <PickupRequest key={item.itemId} afterIndex={index + 1} run={run} />
            </>
          )}
          {!readOnly && text !== undefined && (
            <TextInspector
              text={text}
              styles={styles}
              items={cut.items}
              sceneId={sceneId}
              act={act}
              onGone={() => {
                setSelection(null);
              }}
              onStyles={(styleId) => {
                setStyling(styleId);
              }}
            />
          )}
          {!readOnly && line !== undefined && (
            <LineInspector
              line={line}
              who={
                cut.lanes.find((lane) => lane.characterId === line.characterId)?.name ?? t('Line')
              }
              url={urls.get(line.playKey ?? line.take?.blobKey ?? '')}
              sceneId={sceneId}
              act={act}
              onGone={() => {
                setSelection(null);
              }}
            />
          )}
          {!readOnly && placement !== undefined && (
            <>
              <h3>
                {placement.name} <span className="muted">{placement.kind}</span>
              </h3>
              <div className="row wrap">
                <NumberField
                  label={t('Starts at (s)')}
                  value={placement.startSeconds}
                  step={0.5}
                  max={36000}
                  onCommit={(value) => {
                    void run('movie.edit.sound.update', {
                      placementId: placement.id,
                      startSeconds: value,
                    });
                  }}
                />
                <NumberField
                  label={t('Skip the first (s)')}
                  value={placement.trimStartSeconds}
                  step={0.5}
                  max={600}
                  onCommit={(value) => {
                    void run('movie.edit.sound.update', {
                      placementId: placement.id,
                      trimStartSeconds: value,
                    });
                  }}
                />
                <NumberField
                  label={t('Volume')}
                  value={placement.volume}
                  step={0.1}
                  max={1}
                  onCommit={(value) => {
                    void run('movie.edit.sound.update', {
                      placementId: placement.id,
                      volume: value,
                    });
                  }}
                />
                <NumberField
                  label={t('Fade in (s)')}
                  value={placement.fadeInSeconds}
                  step={0.5}
                  max={60}
                  onCommit={(value) => {
                    void run('movie.edit.sound.update', {
                      placementId: placement.id,
                      fadeInSeconds: value,
                    });
                  }}
                />
                <NumberField
                  label={t('Fade out (s)')}
                  value={placement.fadeOutSeconds}
                  step={0.5}
                  max={60}
                  onCommit={(value) => {
                    void run('movie.edit.sound.update', {
                      placementId: placement.id,
                      fadeOutSeconds: value,
                    });
                  }}
                />
                <NumberField
                  label={t('Pan (-1 left, 1 right)')}
                  value={placement.pan}
                  step={0.1}
                  min={-1}
                  max={1}
                  onCommit={(value) => {
                    void run('movie.edit.sound.update', { placementId: placement.id, pan: value });
                  }}
                />
                <NumberField
                  label={t('Gain (dB)')}
                  value={placement.gainDb}
                  step={1}
                  min={-60}
                  max={24}
                  onCommit={(value) => {
                    void run('movie.edit.sound.update', {
                      placementId: placement.id,
                      gainDb: value,
                    });
                  }}
                />
              </div>
              <label className="choice">
                <input
                  type="checkbox"
                  checked={placement.loop}
                  onChange={() => {
                    void run('movie.edit.sound.update', {
                      placementId: placement.id,
                      loop: !placement.loop,
                    });
                  }}
                />
                {t('Repeat until the scene ends')}
              </label>
              <div className="knob">
                <span id={`edit-curve-${placement.id}`}>{t('Fade shape')}</span>
                <span
                  className="segmented"
                  role="group"
                  aria-labelledby={`edit-curve-${placement.id}`}
                >
                  {(['linear', 'smooth'] as const).map((curve) => (
                    <button
                      key={curve}
                      type="button"
                      aria-pressed={placement.fadeCurve === curve}
                      onClick={() => {
                        void run('movie.edit.sound.update', {
                          placementId: placement.id,
                          fadeCurve: curve,
                        });
                      }}
                    >
                      {curve === 'linear' ? t('Linear') : t('Smooth')}
                    </button>
                  ))}
                </span>
              </div>
              {!placement.recorded && (
                <p className="muted">{t('There is no recording for this yet, so it is silent.')}</p>
              )}
            </>
          )}
        </div>
      </div>

      <StyleEditor
        open={styling !== null}
        initial={styling ?? 'subtitle'}
        styles={styles}
        act={actOnCut}
        onClose={() => {
          setStyling(null);
        }}
      />

      <SplitBar
        height={timelineHeight.height}
        onHeight={timelineHeight.set}
        measure={() => {
          const total = editorBox.current?.clientHeight ?? 0;
          const timeline = timelineBox.current?.clientHeight ?? 0;
          return total > 0 ? { total, timeline } : null;
        }}
      />

      <div className="edit-toolbar" role="toolbar" aria-label={t('Editing')}>
        <button
          type="button"
          className="button primary play-button"
          aria-label={playback.playing ? t('Pause') : t('Play')}
          title={playback.playing ? t('Pause (Space)') : t('Play (Space)')}
          onClick={playback.playing ? playback.pause : playback.play}
          disabled={cut.totalSeconds === 0}
        >
          {playback.playing ? (
            <PauseIcon aria-hidden="true" weight="fill" />
          ) : (
            <PlayIcon aria-hidden="true" weight="fill" />
          )}
        </button>
        <span className="edit-clock mono" aria-label={t('Playhead and length of the scene')}>
          <strong>{clock(playback.at)}</strong>
          <span>/ {clock(cut.totalSeconds)}</span>
        </span>
        <div className="edit-tools">
          <span className="tool-group" role="group" aria-label={t('History')}>
            {tool(
              t('Undo'),
              <ArrowCounterClockwiseIcon aria-hidden="true" />,
              () => {
                void run('movie.edit.undo', {});
              },
              readOnly || !cut.canUndo,
              t('Ctrl+Z'),
            )}
            {tool(
              t('Redo'),
              <ArrowClockwiseIcon aria-hidden="true" />,
              () => {
                void run('movie.edit.redo', {});
              },
              readOnly || !cut.canRedo,
              t('Ctrl+Shift+Z'),
            )}
          </span>
          <span className="tool-group" role="group" aria-label={t('Pieces')}>
            {tool(
              t('Split at the playhead'),
              <SplitHorizontalIcon aria-hidden="true" />,
              split,
              readOnly || !canSplit,
              'S',
            )}
            {tool(
              item?.kind === 'shot'
                ? t('Trim the selected shot to its planned length')
                : t('Trim every shot to its planned length'),
              <ArrowsInLineHorizontalIcon aria-hidden="true" />,
              () => {
                // A chosen piece is trimmed again from its whole clip; the scene keeps hand trims.
                void run(
                  'movie.edit.assemble',
                  item?.kind === 'shot' ? { itemIds: [item.itemId], retrim: true } : {},
                );
              },
              readOnly || !cut.items.some((piece) => piece.plannedSeconds !== null),
            )}
            {tool(
              t('Copy'),
              <CopyIcon aria-hidden="true" />,
              () => {
                copy(false);
              },
              readOnly || item === undefined,
              t('Ctrl+C'),
            )}
            {tool(
              t('Cut'),
              <ScissorsIcon aria-hidden="true" />,
              () => {
                copy(true);
              },
              readOnly || item === undefined,
              t('Ctrl+X'),
            )}
            {tool(
              t('Paste'),
              <ClipboardIcon aria-hidden="true" />,
              () => {
                void paste();
              },
              readOnly || clipboard === null,
              t('Ctrl+V'),
            )}
            {tool(
              'Delete',
              <TrashIcon aria-hidden="true" />,
              remove,
              readOnly || (item === undefined && placement === undefined && text === undefined),
              'Delete',
            )}
          </span>
          <span
            className="tool-group mark-range"
            role="group"
            aria-label={t('Mark a stretch to ask the crew about')}
          >
            <button
              type="button"
              className="button quiet mark-button"
              title={t('Mark the start of a stretch at the playhead (I)')}
              aria-pressed={marksAt.in !== null}
              onClick={() => {
                setMarksAt((before) => ({ ...before, in: playback.at }));
              }}
            >
              {t('In')}
            </button>
            <button
              type="button"
              className="button quiet mark-button"
              title={t('Mark the end of a stretch at the playhead (O)')}
              aria-pressed={marksAt.out !== null}
              onClick={() => {
                setMarksAt((before) => ({ ...before, out: playback.at }));
              }}
            >
              {t('Out')}
            </button>
            {item !== undefined &&
              item.durationSeconds > 0 &&
              tool(
                t('Mark the selected piece'),
                <BracketsSquareIcon aria-hidden="true" />,
                () => {
                  setMarksAt({
                    in: item.startsAtSeconds,
                    out: item.startsAtSeconds + item.durationSeconds,
                  });
                },
                false,
              )}
            {tool(
              t('Leave a marker at the playhead'),
              <FlagIcon aria-hidden="true" />,
              addMarker,
              false,
              'M',
            )}
          </span>
          <span className="tool-group" role="group" aria-label={t('Sound')}>
            <OpenInAudioEditor project={project} sceneId={sceneId} />
          </span>
        </div>
        <Popover
          label={t('Add to the scene')}
          title={t('Add to the scene')}
          icon={<PlusIcon aria-hidden="true" />}
          text={t('Add')}
          badge={waiting > 0 ? String(waiting) : null}
          side="up"
          wide
          className="edit-add"
        >
          {(close) => (
            <div className="stack edit-add-body">
              <section className="stack" aria-label={t('Words')}>
                <span className="eyebrow">{t('Words')}</span>
                <div className="row wrap">
                  <button
                    type="button"
                    className="button"
                    disabled={readOnly}
                    onClick={() => {
                      void run('movie.edit.title.add', {
                        text: t('Title'),
                        toIndex: index < 0 ? undefined : index + 1,
                      });
                      close();
                    }}
                  >
                    <TextTIcon aria-hidden="true" /> {t('Add title card')}
                  </button>
                </div>
                <TextTools
                  project={project}
                  sceneId={sceneId}
                  at={playback.at}
                  readOnly={readOnly}
                  act={act}
                  onAdded={(id) => {
                    setSelection({ kind: 'text', id });
                  }}
                  onStyles={() => {
                    setStyling(text?.styleId ?? 'subtitle');
                  }}
                />
              </section>
              {!readOnly && (
                <section className="stack" aria-label={t('Sound')}>
                  <span className="eyebrow">{t('Sound at the playhead')}</span>
                  <div className="row edit-add-sound">
                    <label htmlFor="place-sound" className="sr-only">
                      {t('Lay on the audio lane at the playhead')}
                    </label>
                    <select
                      id="place-sound"
                      className="select"
                      value={placing}
                      onChange={(event) => {
                        setPlacing(event.target.value);
                      }}
                    >
                      <option value="">{t('Choose a sound or dialogue')}</option>
                      {placeable.map((entry) => (
                        <option key={entry.value} value={entry.value}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="button"
                      disabled={placing === ''}
                      onClick={() => {
                        const [kind, id] = placing.split(':');
                        const music =
                          source.sounds.find((sound) => sound.id === id)?.kind === 'music';
                        void run('movie.edit.sound.place', {
                          ...(kind === 'sound'
                            ? { soundId: id }
                            : { source: 'dialogue', shotId: id }),
                          startSeconds: Math.round(playback.at * 10) / 10,
                          ...(music ? { volume: 0.4, fadeInSeconds: 1, fadeOutSeconds: 2 } : {}),
                        }).then(() => {
                          setPlacing('');
                        });
                      }}
                    >
                      {t('Lay it down')}
                    </button>
                  </div>
                </section>
              )}
              {waiting > 0 && (
                <section className="stack" aria-label={t('Not in the film yet')}>
                  <span className="eyebrow">{t('Not in the film yet')}</span>
                  <div className="row wrap">
                    {notInFilm.map((entry) => (
                      <button
                        key={entry.itemId}
                        type="button"
                        className="chip"
                        onClick={() => {
                          setSelection({ kind: 'item', id: entry.itemId });
                          close();
                        }}
                      >
                        {t('Shot {index}: {value}', {
                          index: entry.index,
                          value: ITEM_STATE_TEXT[entry.state].toLowerCase(),
                        })}
                      </button>
                    ))}
                    {cut.unplaced.map((entry) => (
                      <button
                        key={entry.shotId}
                        type="button"
                        className="chip"
                        title={t('Add this shot to the cut')}
                        disabled={readOnly}
                        onClick={() => {
                          void run('movie.edit.item.add', { shotId: entry.shotId });
                        }}
                      >
                        {t('+ Shot {position}: {value}', {
                          position: entry.position,
                          value: entry.description.slice(0, 40),
                        })}
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </Popover>
        <button
          type="button"
          className="button quiet icon-only inspector-toggle"
          aria-label={t('Details of the selected piece')}
          title={t('Details of the selected piece')}
          aria-pressed={inspectorOpen}
          onClick={() => {
            setInspectorOpen(!inspectorOpen);
          }}
        >
          <SidebarSimpleIcon aria-hidden="true" mirrored />
        </button>
        <span className="edit-zoom" role="group" aria-label={t('Zoom the timeline')}>
          {tool(
            t('Zoom out'),
            <MagnifyingGlassMinusIcon aria-hidden="true" />,
            () => {
              zoomBy(1 / 1.5);
            },
            scale <= MIN_SCALE,
          )}
          <input
            type="range"
            className="zoom-slider"
            aria-label={scale >= 200 ? t('Zoom · frames') : t('Zoom')}
            // Even steps of the slider zoom by the same factor, from the whole scene to single frames.
            min={Math.log(MIN_SCALE)}
            max={Math.log(MAX_SCALE)}
            step="any"
            value={Math.log(scale)}
            onChange={(event) => {
              setScale(Math.round(Math.exp(Number(event.target.value)) * 100) / 100);
            }}
          />
          {tool(
            t('Zoom in'),
            <MagnifyingGlassPlusIcon aria-hidden="true" />,
            () => {
              zoomBy(1.5);
            },
            scale >= MAX_SCALE,
          )}
          <button
            type="button"
            className="button quiet fit-button"
            title={t('Fit the scene to the timeline')}
            onClick={fit}
          >
            {t('Fit')}
          </button>
        </span>
      </div>

      <div className="edit-timeline" ref={timelineBox}>
        <Timeline
          cut={cut}
          scale={scale}
          at={playback.at}
          selection={selection}
          lengths={lengths}
          source={source}
          onSelect={setSelection}
          onSeek={playback.seek}
          onZoom={setScale}
          act={act}
          sceneId={sceneId}
          readOnly={readOnly}
          marks={marks}
          removed={removed}
          range={range}
          markers={markers}
          urls={urls}
        />
      </div>
    </div>
  );
}

/** The colour-matrix filters the two preview screens are graded with, the film renderer's numbers. */
function GradeFilters({
  screens,
}: {
  screens: readonly [ScreenLook, ScreenLook] | undefined;
}): ReactElement {
  return (
    <svg className="grade-filters" aria-hidden="true" width="0" height="0">
      {([0, 1] as const).map((slot) => {
        const matrix = screens?.[slot].matrix;
        return (
          <filter key={slot} id={gradeFilterId(slot)} colorInterpolationFilters="sRGB">
            <feColorMatrix type="matrix" values={matrixValues(matrix ?? IDENTITY_MATRIX)} />
          </filter>
        );
      })}
    </svg>
  );
}

/** Where the choice to play on from scene to scene is remembered, per browser. */
const PLAY_ON_KEY = 'imp.edit.play-on';

/** The film as a whole, and the cut of one scene at a time. */
export function EditView({ project }: { project: Project }): ReactElement {
  const live = useLive([moviePrefix(project)], async (imp) => ({
    film: Film.parse(await runCommand(imp, 'movie.edit.film', { projectId: project.id })),
    scenes: Scenes.parse(await runCommand(imp, 'movie.scene.list', { projectId: project.id }))
      .scenes,
    markers: MarkerList.parse(
      await runCommand(imp, 'movie.edit.marker.list', { projectId: project.id }),
    ).markers,
    look: LookView.parse(await runCommand(imp, 'movie.edit.look.get', { projectId: project.id })),
  }));
  const look = live.data?.look;
  const { act, error, retry } = useAct(project);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [autoplay, setAutoplay] = useState(false);
  const [playOn, setPlayOn] = useState(() => {
    try {
      return localStorage.getItem(PLAY_ON_KEY) === '1';
    } catch {
      return false;
    }
  });
  const film = live.data?.film;
  const markers = live.data?.markers ?? [];
  const scenes = live.data?.scenes ?? [];
  const sceneId = (scenes.find((candidate) => candidate.id === selectedId) ?? scenes[0])?.id;

  const [exporting, setExporting] = useState<string | null>(null);
  const rendering = usePendingClips().clips.length;
  const [helpOpen, setHelpOpen] = useState(false);
  const coarse = useCoarsePointer();
  const openHelp = (): void => {
    setHelpOpen(true);
  };

  return (
    <div className="edit-screen">
      <header className="edit-head">
        <h1>{t('Edit')}</h1>
        {film !== undefined && (
          <span className="muted edit-summary">
            {tn(film.scenes.length, '{count} scene', '{count} scenes')}{' '}
            {t('· {readyItems} of {items} pieces ready · {totalSeconds} · {cost} spent', {
              readyItems: String(film.readyItems),
              items: String(film.items),
              totalSeconds: clock(film.totalSeconds),
              cost: formatUsd(film.totalCostUsd),
            })}
          </span>
        )}
        {rendering > 0 && <RenderingBadge count={rendering} />}
        <span className="edit-head-tools">
          {sceneId !== undefined && (
            <CheckpointBar project={project} checkpointId="first-cut" itemId={sceneId} compact />
          )}
          {look !== undefined && (
            <Popover
              label={t('Look of the whole film')}
              title={t('Film look')}
              icon={<PaletteIcon aria-hidden="true" />}
              text={
                look.look.preset !== null && look.look.preset !== 'none'
                  ? t('Look · {value}', {
                      value: PRESET_LABELS[look.look.preset] ?? look.look.preset,
                    })
                  : t('Look')
              }
              wide
              bare
              className="edit-look"
            >
              {(close) => (
                <FilmLookPanel view={look} run={(id, input) => act(id, input)} onClose={close} />
              )}
            </Popover>
          )}
          <Popover
            label={t('Export the scene or the film')}
            title={t('Export')}
            icon={<ExportIcon aria-hidden="true" />}
            text={t('Export')}
            badge={exporting}
            wide
            className="edit-export"
          >
            <ExportBar
              project={project}
              sceneId={sceneId}
              sceneIds={scenes.map((scene) => scene.id)}
              onStatus={setExporting}
            />
          </Popover>
          <button
            type="button"
            className="button quiet icon-only"
            aria-label={t('Help with the editor')}
            title={t('Help with the editor')}
            onClick={openHelp}
          >
            <QuestionIcon aria-hidden="true" />
          </button>
        </span>
      </header>
      <Problem text={live.error ?? error} retry={retry} />
      {film !== undefined && film.scenes.length > 0 && (
        <FilmStrip
          compact
          film={film}
          sceneId={sceneId}
          markers={markers}
          playOn={playOn}
          onOpen={(id) => {
            setAutoplay(false);
            setSelectedId(id);
          }}
          onPlayOn={(on) => {
            setPlayOn(on);
            try {
              localStorage.setItem(PLAY_ON_KEY, on ? '1' : '0');
            } catch {
              // Remembering is a convenience; without storage it is on for this visit only.
            }
          }}
        />
      )}
      {sceneId === undefined ? (
        live.data !== undefined && (
          <EmptyState
            icon={FilmReelIcon}
            title={t('Nothing to cut yet')}
            quip={t('The scissors are getting restless.')}
            body={t(
              'There are no scenes yet. Write the script first, then make clips of its shots; they come together here.',
            )}
            go={{ stage: 'script', label: t('Go to Script') }}
          />
        )
      ) : (
        <SceneEditor
          key={sceneId}
          project={project}
          sceneId={sceneId}
          sceneLabel={t('Scene {value}', {
            value: String(scenes.find((scene) => scene.id === sceneId)?.position ?? ''),
          })}
          act={act}
          autoplay={autoplay}
          canMatch={look?.canMatch ?? false}
          onHelp={openHelp}
          onEnded={() => {
            const at = scenes.findIndex((scene) => scene.id === sceneId);
            const next = scenes[at + 1];
            if (!playOn || next === undefined) return;
            setAutoplay(true);
            setSelectedId(next.id);
          }}
        />
      )}
      <EditHelp
        open={helpOpen}
        coarse={coarse}
        onClose={() => {
          setHelpOpen(false);
        }}
      />
    </div>
  );
}
