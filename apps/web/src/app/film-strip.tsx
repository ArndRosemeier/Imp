import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { shortSceneTitle } from '@imp/mode-movie';
import type { z } from 'zod';
import { ITEM_STATE_TEXT, type Film } from './cut-player.js';
import { usePinchZoom } from './gestures.js';

type FilmView = z.infer<typeof Film>;
type SceneView = FilmView['scenes'][number];

/** A marker as the film strip shows it: where in which scene, and of what kind. */
export interface StripMarker {
  id: string;
  sceneId: string;
  atSeconds: number;
  kind: 'note' | 'todo' | 'problem';
  done: boolean;
  text: string;
}

/** Pixels per second of the film strip, from a long film seen whole to one scene filling it. */
export const MIN_FILM_SCALE = 0.05;
export const MAX_FILM_SCALE = 60;
/** A scene keeps room for its number and a word of its heading, however short it is. */
export const MIN_SCENE_PX = 72;

/** m:ss, or h:mm:ss for a film over an hour. */
export function filmClock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, '0')}:${rest}`
    : `${String(minutes)}:${rest}`;
}

/** How finished a scene is, for its colour: nothing in it, some pieces missing, or all ready. */
export function sceneState(
  scene: Pick<SceneView, 'items' | 'readyItems'>,
): 'empty' | 'partial' | 'ready' {
  if (scene.items === 0) return 'empty';
  return scene.readyItems === scene.items ? 'ready' : 'partial';
}

/**
 * The scale at which the whole film fits a width, within the strip's bounds.
 * Short scenes keep their least width, so the rest share what room is left.
 */
export function fitScale(durations: readonly number[], width: number): number {
  const room = Math.max(1, width - durations.length * 4);
  const sorted = [...durations].sort((a, b) => a - b);
  let fixed = 0;
  for (let index = 0; index < sorted.length; index++) {
    const rest = sorted.slice(index).reduce((sum, seconds) => sum + seconds, 0);
    if (rest <= 0) break;
    const scale = (room - fixed) / rest;
    // Every scene left is long enough at this scale to be drawn to length.
    if ((sorted[index] ?? 0) * scale >= MIN_SCENE_PX) {
      return Math.min(MAX_FILM_SCALE, Math.max(MIN_FILM_SCALE, scale));
    }
    fixed += MIN_SCENE_PX;
  }
  return MAX_FILM_SCALE;
}

/** What a scene's block says when looked at closely: its state and what is missing. */
export function sceneSummary(scene: SceneView): string {
  const heading = scene.heading === '' ? 'Untitled' : scene.heading;
  const parts = [
    `Scene ${String(scene.position)} · ${heading}`,
    `starts at ${filmClock(scene.startSeconds)}, lasts ${filmClock(scene.durationSeconds)}`,
    `${String(scene.readyItems)} of ${String(scene.items)} pieces ready`,
  ];
  if (scene.missing.length > 0) {
    parts.push(
      scene.missing
        .slice(0, 6)
        .map((item) => `piece ${String(item.index)}: ${ITEM_STATE_TEXT[item.state].toLowerCase()}`)
        .join('; ') + (scene.missing.length > 6 ? '; …' : ''),
    );
  }
  if (scene.openMarkers > 0) {
    parts.push(`${String(scene.openMarkers)} open marker${scene.openMarkers === 1 ? '' : 's'}`);
  }
  return parts.join('\n');
}

/**
 * The whole film on one strip: every scene a block as long as the scene,
 * coloured by how finished it is, with its markers. Opening a scene shows its
 * own timeline below. It zooms from a feature seen whole to one scene filling
 * the strip, by pinch, by wheel with Ctrl, or with Fit.
 */
export function FilmStrip({
  film,
  sceneId,
  markers,
  playOn,
  onOpen,
  onPlayOn,
  tools,
}: {
  film: FilmView;
  sceneId: string | undefined;
  markers: readonly StripMarker[];
  /** Playback runs on from one scene into the next. */
  playOn: boolean;
  onOpen: (sceneId: string) => void;
  onPlayOn: (on: boolean) => void;
  /** More controls for the whole film, beside Play on. */
  tools?: ReactNode;
}): ReactElement {
  const scroller = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState<number | null>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const element = scroller.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => {
      setWidth(element.clientWidth);
    });
    watch.observe(element);
    setWidth(element.clientWidth);
    return () => {
      watch.disconnect();
    };
  }, []);
  const fitted = fitScale(
    film.scenes.map((scene) => scene.durationSeconds),
    width,
  );
  // Until it is zoomed, the strip follows the window and the film's length.
  const shown = scale ?? fitted;
  usePinchZoom(scroller, (factor) => {
    // Pinch steps build on each other even before the next render.
    setScale((before) =>
      Math.min(MAX_FILM_SCALE, Math.max(MIN_FILM_SCALE, (before ?? fitted) * factor)),
    );
  });
  // The open scene stays in view when it changes, as when playback runs on into the next.
  useEffect(() => {
    const block = scroller.current?.querySelector<HTMLElement>('[aria-current="true"]');
    block?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [sceneId]);
  const step = (factor: number): void => {
    setScale(Math.min(MAX_FILM_SCALE, Math.max(MIN_FILM_SCALE, shown * factor)));
  };
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0 }[event.key];
    const end = event.key === 'End' ? film.scenes.length - 1 : next;
    if (end === undefined) return;
    event.preventDefault();
    const target = scroller.current?.querySelectorAll<HTMLButtonElement>('.film-scene')[end];
    target?.focus();
  };
  const ready = film.scenes.filter((scene) => sceneState(scene) === 'ready').length;
  return (
    <section className="film-strip" aria-label="The whole film">
      <div className="film-strip-head">
        <span className="film-strip-title">Film</span>
        <span className="muted small">
          {String(film.scenes.length)} {film.scenes.length === 1 ? 'scene' : 'scenes'} ·{' '}
          {filmClock(film.totalSeconds)} · {String(ready)} finished
          {film.openMarkers > 0
            ? ` · ${String(film.openMarkers)} open marker${film.openMarkers === 1 ? '' : 's'}`
            : ''}
        </span>
        <span className="film-strip-tools">
          {tools}
          <button
            className="button small quiet"
            aria-pressed={playOn}
            title="When a scene ends, open the next one and play on"
            onClick={() => {
              onPlayOn(!playOn);
            }}
          >
            Play on
          </button>
          <span className="segmented" role="group" aria-label="Zoom the film">
            <button
              aria-label="Zoom out"
              onClick={() => {
                step(1 / 1.6);
              }}
            >
              −
            </button>
            <button
              aria-pressed={scale === null}
              onClick={() => {
                setScale(null);
              }}
            >
              Fit
            </button>
            <button
              aria-label="Zoom in"
              onClick={() => {
                step(1.6);
              }}
            >
              +
            </button>
          </span>
        </span>
      </div>
      <div
        className="film-strip-scroll"
        ref={scroller}
        onWheel={(event) => {
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          step(event.deltaY < 0 ? 1.15 : 1 / 1.15);
        }}
      >
        <div className="film-strip-track" role="list">
          {film.scenes.map((scene, index) => {
            const open = scene.sceneId === sceneId;
            const blockWidth = Math.max(MIN_SCENE_PX, scene.durationSeconds * shown);
            const own = markers.filter((marker) => marker.sceneId === scene.sceneId);
            return (
              <div role="listitem" key={scene.sceneId} style={{ width: blockWidth }}>
                <button
                  className={`film-scene film-scene-${sceneState(scene)}`}
                  aria-current={open}
                  aria-label={sceneSummary(scene).replace(/\n/g, ', ')}
                  title={sceneSummary(scene)}
                  onClick={() => {
                    onOpen(scene.sceneId);
                  }}
                  onKeyDown={(event) => {
                    move(event, index);
                  }}
                >
                  <span className="film-scene-name">
                    <strong>{scene.position}</strong> {shortSceneTitle(scene.heading)}
                  </span>
                  <span className="film-scene-meta">
                    {filmClock(scene.durationSeconds)}
                    {scene.items > 0 && ` · ${String(scene.readyItems)}/${String(scene.items)}`}
                  </span>
                  <span className="film-scene-bar" aria-hidden="true">
                    <span
                      style={{
                        width: `${String(scene.items === 0 ? 0 : (scene.readyItems / scene.items) * 100)}%`,
                      }}
                    />
                  </span>
                  {scene.durationSeconds > 0 &&
                    own.map((marker) => (
                      <span
                        key={marker.id}
                        className={`film-marker marker-${marker.kind}${marker.done ? ' done' : ''}`}
                        style={{
                          left: `${String(Math.min(100, (marker.atSeconds / scene.durationSeconds) * 100))}%`,
                        }}
                        aria-hidden="true"
                      />
                    ))}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
