import type { Project } from '@imp/core';
import {
  ArrowCounterClockwiseIcon,
  ArrowClockwiseIcon,
  ClipboardIcon,
  CopyIcon,
  PauseIcon,
  PlayIcon,
  ScissorsIcon,
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
import { runCommand, useImp, useLive } from './context.js';
import {
  clock,
  blobKeys,
  CutPlayer,
  Film,
  ITEM_STATE_TEXT,
  loadCut,
  placementKey,
  Scenes,
  type Cut,
  type Look,
  type Placement,
  type Source,
} from './cut-player.js';
import { ExportBar } from './ExportBar.js';
import { CharacterLanes, LineInspector } from './lines.js';
import { NumberField } from './NumberField.js';
import { EditableField } from './Field.js';
import { moviePrefix, Problem, useAct, type Act } from './movie.js';
import { SceneTabs } from './shots.js';

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
  const [look, setLook] = useState<Look>({ brightness: 1, title: '' });
  const [player] = useState(
    () =>
      new CutPlayer(
        { cut, source, urls },
        {
          at: setAt,
          playing: setPlaying,
          look: (next) => {
            setLook((before) =>
              before.brightness === next.brightness && before.title === next.title ? before : next,
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
};

/** How many pixels wide a second is on the timeline. */
const MIN_SCALE = 12;
const MAX_SCALE = 160;
/** A piece without length still gets a handle to grab. */
const MIN_BLOCK_PX = 18;

type Selection =
  | { kind: 'item'; id: string }
  | { kind: 'sound'; id: string }
  | { kind: 'line'; id: string }
  | null;

/** Follows a pointer across the page while a button is held, and reports the distance in the end. */
function useDrag(onEnd: (distance: number) => void) {
  const [dragging, setDragging] = useState<{ id: string; edge: string; dx: number } | null>(null);
  const origin = useRef(0);
  return {
    dragging,
    start: (event: PointerEvent, id: string, edge: string) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      origin.current = event.clientX;
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
      if (Math.abs(dx) >= 2) done(id, edge, dx);
      else onEnd(0);
    },
  };
}

function Timeline({
  cut,
  scale,
  at,
  selection,
  lengths,
  source,
  onSelect,
  onSeek,
  act,
  sceneId,
}: {
  cut: Cut;
  scale: number;
  at: number;
  selection: Selection;
  lengths: ReadonlyMap<string, number>;
  source: Source;
  onSelect: (selection: Selection) => void;
  onSeek: (seconds: number) => void;
  act: Act;
  sceneId: string;
}): ReactElement {
  const edges = useDrag(() => undefined);
  const audioDrag = useDrag(() => undefined);
  const [over, setOver] = useState<string | null>(null);
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
    10,
  );
  const width = Math.ceil((widest + 2) * scale);
  const playing = cut.items.filter((item) => item.durationSeconds > 0);
  const ticks = Array.from({ length: Math.floor(widest + 2) + 1 }, (_, second) => second);
  const every = scale < 24 ? 10 : scale < 50 ? 5 : 1;

  const seekFrom = (event: React.MouseEvent<HTMLDivElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, (event.clientX - box.left) / scale));
  };

  return (
    <div className="timeline" role="group" aria-label="Timeline">
      <div className="timeline-scroll">
        <div className="timeline-inner" style={{ width }}>
          <div
            className="timeline-ruler"
            onClick={seekFrom}
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
          <div className="lane lane-picture" aria-label="Picture lane">
            <span className="lane-name">Picture</span>
            {playing.map((item) => {
              const drag = edges.dragging?.id === item.itemId ? edges.dragging : null;
              const shift = drag === null ? 0 : drag.dx / scale;
              const startShift = drag?.edge === 'start' ? shift : 0;
              const endShift = drag?.edge === 'end' ? shift : 0;
              const left = (item.startsAtSeconds + startShift) * scale;
              const blockWidth = Math.max(
                MIN_BLOCK_PX,
                (item.durationSeconds - startShift + endShift) * scale,
              );
              const selected = selection?.kind === 'item' && selection.id === item.itemId;
              return (
                <div
                  key={item.itemId}
                  className={`block block-${item.kind}${selected ? ' selected' : ''}${over === item.itemId ? ' drop' : ''}`}
                  style={{ left, width: blockWidth }}
                  draggable
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
                  onDragStart={(event) => {
                    event.dataTransfer.setData('text/plain', item.itemId);
                    event.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setOver(item.itemId);
                  }}
                  onDragLeave={() => {
                    setOver(null);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setOver(null);
                    const moving = event.dataTransfer.getData('text/plain');
                    if (moving === '' || moving === item.itemId) return;
                    void act('movie.edit.item.move', {
                      sceneId,
                      itemId: moving,
                      toIndex: cut.items.findIndex((candidate) => candidate.itemId === item.itemId),
                    });
                  }}
                >
                  {item.kind === 'shot' && (
                    <span
                      className="handle handle-start"
                      aria-label={`Trim the start of item ${String(item.index)}`}
                      onPointerDown={(event) => {
                        edges.start(event, item.itemId, 'start');
                      }}
                      onPointerMove={edges.move}
                      onPointerUp={(event) => {
                        edges.end(event, (id, edge, distance) => {
                          void act('movie.edit.item.set', {
                            sceneId,
                            itemId: id,
                            trimStartSeconds: Math.max(
                              0,
                              Math.round((item.trimStartSeconds + distance / scale) * 10) / 10,
                            ),
                          });
                        });
                      }}
                      draggable={false}
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
                        edges.start(event, item.itemId, 'end');
                      }}
                      onPointerMove={edges.move}
                      onPointerUp={(event) => {
                        edges.end(event, (id, _edge, distance) => {
                          void act('movie.edit.item.set', {
                            sceneId,
                            itemId: id,
                            trimEndSeconds: Math.max(
                              0,
                              Math.round((item.trimEndSeconds - distance / scale) * 10) / 10,
                            ),
                          });
                        });
                      }}
                      draggable={false}
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div className="lane lane-audio" aria-label="Audio lane">
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
                  className={`block block-${placement.kind}${selected ? ' selected' : ''}${placement.recorded ? '' : ' empty'}`}
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
                    audioDrag.start(event, placement.id, 'move');
                    onSelect({ kind: 'sound', id: placement.id });
                  }}
                  onPointerMove={audioDrag.move}
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
          />
          <div className="playhead" style={{ left: at * scale }} aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

function SceneEditor({
  project,
  sceneId,
  act,
}: {
  project: Project;
  sceneId: string;
  act: Act;
}): ReactElement {
  const live = useLive([moviePrefix(project)], (imp) => loadCut(imp, project.id, sceneId));
  const [selection, setSelection] = useState<Selection>(null);
  const [scale, setScale] = useState(48);
  const [clipboard, setClipboard] = useState<{
    itemId: string;
    sceneId: string;
    cutting: boolean;
  } | null>(null);
  const [placing, setPlacing] = useState('');
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
  if (data === undefined) return <Problem text={live.error} />;

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
    } else if (event.key === ' ') {
      event.preventDefault();
      if (playback.playing) playback.pause();
      else playback.play();
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
              style={{ opacity: playback.look.title === '' ? playback.look.brightness : 0 }}
            />
            {playback.look.title !== '' && (
              <div className="preview-title" style={{ opacity: playback.look.brightness }}>
                {playback.look.title}
              </div>
            )}
          </div>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio ref={attachVoice} aria-label="Dialogue of the preview" />
        </figure>
        <div className="stack inspector" aria-label="Selected piece">
          {item === undefined && placement === undefined && line === undefined && (
            <p className="muted">
              Select a piece on the timeline to change it. Drag a picture onto another to reorder,
              drag its ends to trim, drag audio sideways to move it. Space plays, S splits at the
              playhead, Ctrl+C, X and V copy, cut and paste, Ctrl+Z undoes.
            </p>
          )}
          {item !== undefined && (
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
            </>
          )}
          {line !== undefined && (
            <LineInspector
              line={line}
              who={cut.lanes.find((lane) => lane.characterId === line.characterId)?.name ?? 'Line'}
              url={urls.get(line.take?.blobKey ?? '')}
              sceneId={sceneId}
              act={act}
              onGone={() => {
                setSelection(null);
              }}
            />
          )}
          {placement !== undefined && (
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

      <div className="row wrap toolbar" role="toolbar" aria-label="Editing">
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
          disabled={!cut.canUndo}
          onClick={() => {
            void run('movie.edit.undo', {});
          }}
        >
          <ArrowCounterClockwiseIcon aria-hidden="true" /> Undo
        </button>
        <button
          className="button quiet"
          disabled={!cut.canRedo}
          onClick={() => {
            void run('movie.edit.redo', {});
          }}
        >
          <ArrowClockwiseIcon aria-hidden="true" /> Redo
        </button>
        <button
          className="button quiet"
          disabled={!canSplit}
          onClick={split}
          title="Cut the selected shot in two at the playhead"
        >
          <ScissorsIcon aria-hidden="true" /> Split
        </button>
        <button
          className="button quiet"
          disabled={item === undefined}
          onClick={() => {
            copy(false);
          }}
        >
          <CopyIcon aria-hidden="true" /> Copy
        </button>
        <button
          className="button quiet"
          disabled={item === undefined}
          onClick={() => {
            copy(true);
          }}
        >
          <ScissorsIcon aria-hidden="true" /> Cut
        </button>
        <button
          className="button quiet"
          disabled={clipboard === null}
          onClick={() => {
            void paste();
          }}
        >
          <ClipboardIcon aria-hidden="true" /> Paste
        </button>
        <button
          className="button quiet"
          disabled={item === undefined && placement === undefined}
          onClick={remove}
        >
          <TrashIcon aria-hidden="true" /> Delete
        </button>
        <button
          className="button quiet"
          onClick={() => {
            void run('movie.edit.title.add', {
              text: 'Title',
              toIndex: index < 0 ? undefined : index + 1,
            });
          }}
        >
          <TextTIcon aria-hidden="true" /> Add title
        </button>
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

      <Timeline
        cut={cut}
        scale={scale}
        at={playback.at}
        selection={selection}
        lengths={lengths}
        source={source}
        onSelect={setSelection}
        onSeek={playback.seek}
        act={act}
        sceneId={sceneId}
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

      <div className="row wrap">
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
        <SceneEditor key={sceneId} project={project} sceneId={sceneId} act={act} />
      )}
    </>
  );
}
