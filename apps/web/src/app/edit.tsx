import type { Project } from '@imp/core';
import {
  ArrowCounterClockwiseIcon,
  ArrowClockwiseIcon,
  ClipboardIcon,
  CopyIcon,
  PauseIcon,
  PlayIcon,
  ScissorsIcon,
  BracketsSquareIcon,
  SpeakerHighIcon,
  TextTIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
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
  zoomStyle,
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
import { SceneTabs } from './shots.js';
import { RescueTools } from './rescue.js';
import { SplitEdit, TakeSwitcher } from './split-edit.js';
import { useLibraryDrop } from './library/drag.js';
import { isPlayableSound, soundForScene } from './library/scene.js';
import {
  StyleEditor,
  TextInspector,
  TextLane,
  TextOverlay,
  TextTools,
  useTextStyles,
} from './texts.js';

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
            setLook((before) =>
              before.brightness === next.brightness &&
              before.title === next.title &&
              before.card === next.card
                ? before
                : next,
            );
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
    at,
    playing,
    look,
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
const MAX_SCALE = 160;
/** A piece without length still gets a handle to grab. */
const MIN_BLOCK_PX = 18;

type Selection =
  | { kind: 'item'; id: string }
  | { kind: 'sound'; id: string }
  | { kind: 'line'; id: string }
  | { kind: 'text'; id: string }
  | null;

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
}): ReactElement {
  const edges = useDrag();
  /** Whether a pointer on a piece may start dragging it. */
  const may = (event: PointerEvent, selected: boolean): boolean =>
    !readOnly && grabs(event, selected);
  const marked = (id: string): string => {
    const mark = marks.get(id);
    return mark === undefined ? '' : ` tracked tracked-${mark}`;
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
    if (anchor === null || scroller.current === null) return;
    pending.current = null;
    scroller.current.scrollLeft = anchor.second * scale - anchor.offset;
  }, [scale]);
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
    if (output === undefined) throw new Error('It was not placed; see the message on the stage.');
    return output;
  };
  useLibraryDrop(audioLane, {
    label: 'Edit stage, audio lane, at the playhead',
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
    label: 'Edit stage, picture, at the end',
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
    <div className="timeline" role="group" aria-label="Timeline" data-readonly={readOnly}>
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
              if (event.key === 'ArrowRight') onSeek(at + 1);
              if (event.key === 'ArrowLeft') onSeek(at - 1);
            }}
            aria-label="Playhead"
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
          <div className="lane lane-picture" aria-label="Picture lane" ref={pictureLane}>
            <span className="lane-name">Picture</span>
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
                  className={`block block-${item.kind}${selected ? ' selected' : ''}${target?.itemId === item.itemId ? ' drop' : ''}${lift === 0 ? '' : ' lifted'}${marked(item.itemId)}`}
                  style={{ left, width: blockWidth }}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  aria-label={`${item.kind === 'title' ? 'Title' : 'Shot'} ${String(item.index)}: ${item.label.slice(0, 40)}`}
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
                  {item.kind === 'shot' && (
                    <span
                      className="handle handle-start"
                      aria-label={`Trim the start of item ${String(item.index)}`}
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
                  <span className="block-label">
                    {item.index} · {item.label || 'Untitled'}
                  </span>
                  {item.kind === 'shot' && (
                    <span
                      className="handle handle-end"
                      aria-label={`Trim the end of item ${String(item.index)}`}
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
          </div>
          {removed.length > 0 && (
            <div className="lane lane-removed" aria-label="Taken out by the proposal">
              <span className="lane-name">Taken out</span>
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
          <div className="lane lane-audio" aria-label="Audio lane" ref={audioLane}>
            <span className="lane-name">Audio</span>
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
                  aria-label={`Audio: ${placement.name}`}
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
}: {
  project: Project;
  sceneId: string;
  /** How the scene is named to the crew: "Scene 2". */
  sceneLabel: string;
  act: Act;
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
  const data = live.data;
  const shots = data?.shots;
  const sounds = data?.sounds;
  const source = useMemo<Source>(
    () => ({ shots: shots ?? [], sounds: sounds ?? [] }),
    [shots, sounds],
  );
  const cut = data?.cut ?? EMPTY_CUT;
  const urls = useBlobUrls(blobKeys(source, cut));
  const lengths = useAudioLengths(urls);
  const { attachVideo, attachVoice, ...playback } = usePlayback(cut, source, urls);
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
        label: sound.name === '' ? 'Untitled sound' : sound.name,
      })),
    ...source.shots
      .filter((shot) => shot.sceneId === sceneId && shot.dialogue !== null)
      .map((shot) => ({
        value: `dialogue:${shot.id}`,
        label: `Dialogue of shot ${String(shot.position)}`,
      })),
  ];
  const notInFilm = cut.items.filter((candidate) => candidate.durationSeconds === 0);

  return (
    // The shortcuts belong to the whole editor, which takes the keys that reach it.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-static-element-interactions
    <div className="stack editor" tabIndex={0} onKeyDown={keys} aria-label="Cut editor">
      <div className="editor-top">
        <figure className="preview">
          <div className="preview-frame">
            {/* The cut has no captions; the lines are in the shots. */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              ref={attachVideo}
              className="preview-screen"
              aria-label="Preview of the scene"
              playsInline
              style={{
                opacity: playback.look.card ? 0 : playback.look.brightness,
                ...zoomStyle(playback.look),
              }}
            />
            <TextOverlay
              texts={cut.texts}
              styles={styles}
              at={playback.at}
              now={playback.now}
              playing={playback.playing}
              look={playback.look}
            />
          </div>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio ref={attachVoice} aria-label="Dialogue of the preview" />
        </figure>
        <div
          className="stack inspector"
          aria-label={readOnly ? 'Proposed changes' : 'Selected piece'}
        >
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
          {!readOnly &&
            item === undefined &&
            placement === undefined &&
            line === undefined &&
            text === undefined && (
              <p className="muted">
                {coarse
                  ? 'Tap a piece on the timeline to select it; then drag it onto another to reorder, drag its ends to trim, or drag audio sideways to move it. Swipe to scroll the timeline, pinch to zoom, and drag along the time ruler to move the playhead. Mark in and out to ask the crew about a stretch.'
                  : 'Select a piece on the timeline to change it. Drag a picture onto another to reorder, drag its ends to trim, drag audio sideways to move it. Space plays, S splits at the playhead, Ctrl+C, X and V copy, cut and paste, Ctrl+Z undoes. I and O mark a stretch to ask the crew about.'}
              </p>
            )}
          {!readOnly && item !== undefined && (
            <>
              <h3>
                {item.kind === 'title' ? 'Title card' : `Shot ${String(item.index)}`}{' '}
                <span className="muted">
                  {item.state === 'ready'
                    ? `${clock(item.startsAtSeconds)} · ${item.durationSeconds.toFixed(1)} s`
                    : ITEM_STATE_TEXT[item.state]}
                </span>
              </h3>
              {item.kind === 'title' ? (
                <>
                  <EditableField
                    label="Words"
                    rows={2}
                    value={item.text}
                    placeholder="The words on the card"
                    onCommit={(text) => run('movie.edit.item.set', { itemId: item.itemId, text })}
                  />
                  <NumberField
                    label="Length (s)"
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
              <div className="row wrap">
                {item.kind === 'shot' && (
                  <>
                    <NumberField
                      label="Trim start (s)"
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
                      label="Trim end (s)"
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
                      label="Dialogue volume"
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
                      label="Clip sound volume"
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
                  label="Fade in from black (s)"
                  value={item.fadeInSeconds}
                  step={0.5}
                  max={30}
                  onCommit={(value) => {
                    void run('movie.edit.item.set', { itemId: item.itemId, fadeInSeconds: value });
                  }}
                />
                <NumberField
                  label="Fade out to black (s)"
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
                  <SpeakerHighIcon aria-hidden="true" /> Take the clip&apos;s sound apart
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
              <RescueTools item={item} playheadSeconds={playback.at} run={run} />
              <SplitEdit item={item} next={cut.items[index + 1]} run={run} />
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
              who={cut.lanes.find((lane) => lane.characterId === line.characterId)?.name ?? 'Line'}
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
                  label="Starts at (s)"
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
                  label="Skip the first (s)"
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
                  label="Volume"
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
                  label="Fade in (s)"
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
                  label="Fade out (s)"
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
                  label="Pan (-1 left, 1 right)"
                  value={placement.pan}
                  step={0.1}
                  min={-1}
                  max={1}
                  onCommit={(value) => {
                    void run('movie.edit.sound.update', { placementId: placement.id, pan: value });
                  }}
                />
                <NumberField
                  label="Gain (dB)"
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
                Repeat until the scene ends
              </label>
              {!placement.recorded && (
                <p className="muted">There is no recording for this yet, so it is silent.</p>
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

      <div className="row wrap toolbar" role="toolbar" aria-label="Editing">
        <OpenInAudioEditor project={project} sceneId={sceneId} />
        <button
          className="button"
          onClick={playback.playing ? playback.pause : playback.play}
          disabled={cut.totalSeconds === 0}
        >
          {playback.playing ? <PauseIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}{' '}
          {playback.playing ? 'Pause' : 'Play'}
        </button>
        <span className="muted mono">
          {clock(playback.at)} / {clock(cut.totalSeconds)}
        </span>
        <button
          className="button quiet"
          disabled={readOnly || !cut.canUndo}
          onClick={() => {
            void run('movie.edit.undo', {});
          }}
        >
          <ArrowCounterClockwiseIcon aria-hidden="true" /> Undo
        </button>
        <button
          className="button quiet"
          disabled={readOnly || !cut.canRedo}
          onClick={() => {
            void run('movie.edit.redo', {});
          }}
        >
          <ArrowClockwiseIcon aria-hidden="true" /> Redo
        </button>
        <button
          className="button quiet"
          disabled={readOnly || !canSplit}
          onClick={split}
          title="Cut the selected shot in two at the playhead"
        >
          <ScissorsIcon aria-hidden="true" /> Split
        </button>
        <button
          className="button quiet"
          disabled={readOnly || item === undefined}
          onClick={() => {
            copy(false);
          }}
        >
          <CopyIcon aria-hidden="true" /> Copy
        </button>
        <button
          className="button quiet"
          disabled={readOnly || item === undefined}
          onClick={() => {
            copy(true);
          }}
        >
          <ScissorsIcon aria-hidden="true" /> Cut
        </button>
        <button
          className="button quiet"
          disabled={readOnly || clipboard === null}
          onClick={() => {
            void paste();
          }}
        >
          <ClipboardIcon aria-hidden="true" /> Paste
        </button>
        <button
          className="button quiet"
          disabled={
            readOnly || (item === undefined && placement === undefined && text === undefined)
          }
          onClick={remove}
        >
          <TrashIcon aria-hidden="true" /> Delete
        </button>
        <button
          className="button quiet"
          disabled={readOnly}
          onClick={() => {
            void run('movie.edit.title.add', {
              text: 'Title',
              toIndex: index < 0 ? undefined : index + 1,
            });
          }}
        >
          <TextTIcon aria-hidden="true" /> Add title card
        </button>
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
        <span className="mark-range" role="group" aria-label="Mark a stretch to ask the crew about">
          <button
            className="button quiet"
            title="Mark the start of a stretch at the playhead (I)"
            onClick={() => {
              setMarksAt((before) => ({ ...before, in: playback.at }));
            }}
          >
            In
          </button>
          <button
            className="button quiet"
            title="Mark the end of a stretch at the playhead (O)"
            onClick={() => {
              setMarksAt((before) => ({ ...before, out: playback.at }));
            }}
          >
            Out
          </button>
          {item !== undefined && item.durationSeconds > 0 && (
            <button
              className="button quiet"
              title="Mark the selected piece"
              onClick={() => {
                setMarksAt({
                  in: item.startsAtSeconds,
                  out: item.startsAtSeconds + item.durationSeconds,
                });
              }}
            >
              <BracketsSquareIcon aria-hidden="true" /> Mark piece
            </button>
          )}
        </span>
        <label className="field compact zoom">
          <span>Zoom</span>
          <input
            type="range"
            min={MIN_SCALE}
            max={MAX_SCALE}
            value={scale}
            onChange={(event) => {
              setScale(Number(event.target.value));
            }}
          />
        </label>
      </div>

      {range !== null && (
        <div className="range-note row wrap">
          <span className="chip" aria-label="Marked stretch">
            {clock(range.from)}–{clock(range.to)} marked
            <button
              type="button"
              className="button quiet icon"
              aria-label="Clear the marked stretch"
              onClick={() => {
                setMarksAt({ in: null, out: null });
              }}
            >
              ×
            </button>
          </span>
          <span className="muted small">
            {attached === null
              ? 'Detached from the crew panel.'
              : 'Goes with your next message to the crew: tell them what to do with it.'}
          </span>
        </div>
      )}

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
      />

      {(notInFilm.length > 0 || cut.unplaced.length > 0) && (
        <div className="stack">
          <h3>Not in the film yet</h3>
          <div className="row wrap">
            {notInFilm.map((entry) => (
              <button
                key={entry.itemId}
                className="chip"
                onClick={() => {
                  setSelection({ kind: 'item', id: entry.itemId });
                }}
              >
                Shot {entry.index}: {ITEM_STATE_TEXT[entry.state].toLowerCase()}
              </button>
            ))}
            {cut.unplaced.map((entry) => (
              <button
                key={entry.shotId}
                className="chip"
                title="Add this shot to the cut"
                disabled={readOnly}
                onClick={() => {
                  void run('movie.edit.item.add', { shotId: entry.shotId });
                }}
              >
                + Shot {entry.position}: {entry.description.slice(0, 40)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="row wrap" hidden={readOnly}>
        <div className="field">
          <label htmlFor="place-sound">Lay on the audio lane at the playhead</label>
          <select
            id="place-sound"
            className="select"
            value={placing}
            onChange={(event) => {
              setPlacing(event.target.value);
            }}
          >
            <option value="">Choose a sound or dialogue</option>
            {placeable.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
        <button
          className="button"
          disabled={placing === ''}
          onClick={() => {
            const [kind, id] = placing.split(':');
            const music = source.sounds.find((sound) => sound.id === id)?.kind === 'music';
            void run('movie.edit.sound.place', {
              ...(kind === 'sound' ? { soundId: id } : { source: 'dialogue', shotId: id }),
              startSeconds: Math.round(playback.at * 10) / 10,
              ...(music ? { volume: 0.4, fadeInSeconds: 1, fadeOutSeconds: 2 } : {}),
            }).then(() => {
              setPlacing('');
            });
          }}
        >
          Lay it down
        </button>
      </div>
    </div>
  );
}

/** The film as a whole, and the cut of one scene at a time. */
export function EditView({ project }: { project: Project }): ReactElement {
  const live = useLive([moviePrefix(project)], async (imp) => ({
    film: Film.parse(await runCommand(imp, 'movie.edit.film', { projectId: project.id })),
    scenes: Scenes.parse(await runCommand(imp, 'movie.scene.list', { projectId: project.id }))
      .scenes,
  }));
  const { act, error } = useAct(project);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const film = live.data?.film;
  const scenes = live.data?.scenes ?? [];
  const sceneId = (scenes.find((candidate) => candidate.id === selectedId) ?? scenes[0])?.id;

  return (
    <>
      <div className="view-head">
        <h1>Edit</h1>
        {film !== undefined && (
          <span className="muted">
            {String(film.readyItems)} of {String(film.items)} pieces ready ·{' '}
            {clock(film.totalSeconds)} · ${film.totalCostUsd.toFixed(2)} spent
          </span>
        )}
      </div>
      <Problem text={live.error ?? error} />
      {film !== undefined && film.scenes.length > 0 && (
        <table className="film-overview">
          <thead>
            <tr>
              <th>Scene</th>
              <th>Ready</th>
              <th>Length</th>
              <th>Missing</th>
            </tr>
          </thead>
          <tbody>
            {film.scenes.map((scene) => (
              <tr key={scene.sceneId}>
                <td>
                  {scene.position} · {scene.heading === '' ? 'Untitled' : scene.heading}
                </td>
                <td>
                  {String(scene.readyItems)} / {String(scene.items)}
                </td>
                <td>{clock(scene.durationSeconds)}</td>
                <td>
                  {scene.missing
                    .map(
                      (item) =>
                        `piece ${String(item.index)}: ${ITEM_STATE_TEXT[item.state].toLowerCase()}`,
                    )
                    .join('; ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ExportBar project={project} sceneId={sceneId} sceneIds={scenes.map((scene) => scene.id)} />
      <SceneTabs scenes={scenes} sceneId={sceneId} onSelect={setSelectedId} />
      {sceneId === undefined ? (
        live.data !== undefined && (
          <p className="muted">There are no scenes yet. Write the script first.</p>
        )
      ) : (
        <SceneEditor
          key={sceneId}
          project={project}
          sceneId={sceneId}
          sceneLabel={`Scene ${String(scenes.find((scene) => scene.id === sceneId)?.position ?? '')}`}
          act={act}
        />
      )}
    </>
  );
}
