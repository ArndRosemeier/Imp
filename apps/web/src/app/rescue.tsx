import { placePicture } from '@imp/mode-movie';
import { useId, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react';
import type { Item } from './cut-player.js';
import { NumberField } from './NumberField.js';

type Run = (id: string, input: Record<string, unknown>) => Promise<unknown>;

/** The speeds offered at a tap; any other can be typed. */
export const SPEEDS: readonly { value: number; label: string }[] = [
  { value: 0.25, label: '¼×' },
  { value: 0.5, label: '½×' },
  { value: 0.75, label: '¾×' },
  { value: 1, label: '1×' },
  { value: 1.5, label: '1½×' },
  { value: 2, label: '2×' },
  { value: 4, label: '4×' },
];

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Whether a piece plays as filmed: nothing slowed, reversed, held or zoomed. */
export const isPlain = (
  item: Pick<Item, 'speed' | 'reverse' | 'holdSeconds' | 'zoom' | 'zoomTo'>,
): boolean =>
  item.speed === 1 &&
  !item.reverse &&
  item.holdSeconds === 0 &&
  item.zoom === 1 &&
  item.zoomTo === null;

/** The part of the frame that stays in view at a zoom, as a box on the focus pad. */
function windowStyle(
  zoom: number,
  focus: { focusX: number; focusY: number },
): { left: string; top: string; width: string; height: string } {
  const at = placePicture(1, 1, 1, 1, zoom, focus.focusX, focus.focusY);
  const percent = (share: number): string => `${String(Math.round(share * 10000) / 100)}%`;
  return {
    left: percent(-at.x / at.width),
    top: percent(-at.y / at.height),
    width: percent(1 / at.width),
    height: percent(1 / at.height),
  };
}

/** The share of a pad a pointer is at, from 0 to 1 across and down. */
export function padShare(
  box: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
): { focusX: number; focusY: number } {
  const clamp = (value: number): number => round2(Math.min(1, Math.max(0, value)));
  return {
    focusX: clamp((x - box.left) / Math.max(1, box.width)),
    focusY: clamp((y - box.top) / Math.max(1, box.height)),
  };
}

/**
 * Tools that save a shot in the edit: slow it or speed it up, play it
 * backwards, freeze a frame, and punch in on part of the frame, still or as
 * a slow push. The same fields and commands the Film Editor uses.
 */
export function RescueTools({
  item,
  playheadSeconds,
  run,
}: {
  item: Item;
  /** Where the playhead is in the scene, for a freeze there. */
  playheadSeconds: number;
  run: Run;
}): ReactElement | null {
  const titleId = useId();
  if (item.kind !== 'shot' || item.durationSeconds <= 0) return null;
  const set = (fields: Record<string, unknown>): void => {
    void run('movie.edit.item.set', { itemId: item.itemId, ...fields });
  };
  const into = round2(playheadSeconds - item.startsAtSeconds);
  const canFreeze = into >= 0.2 && into <= item.movingSeconds - 0.2;
  const pushing = item.zoomTo !== null;
  const zoomEnd = item.zoomTo ?? item.zoom;
  const moveFocus = (event: PointerEvent<HTMLDivElement>): void => {
    set(padShare(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY));
  };
  const nudge = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 0.1 : 0.02;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    set({
      focusX: round2(Math.min(1, Math.max(0, item.focusX + move[0]))),
      focusY: round2(Math.min(1, Math.max(0, item.focusY + move[1]))),
    });
  };
  return (
    <section className="stack rescue" aria-labelledby={titleId}>
      <div className="row spread wrap">
        <h4 id={titleId}>Speed, freeze and zoom</h4>
        {!isPlain(item) && (
          <button
            className="button small quiet"
            onClick={() => {
              set({ speed: 1, reverse: false, holdSeconds: 0, zoom: 1, zoomTo: null });
            }}
          >
            Play as filmed
          </button>
        )}
      </div>
      <div className="row wrap rescue-speed">
        <span className="segmented" role="group" aria-label="Speed">
          {SPEEDS.map((speed) => (
            <button
              key={speed.value}
              aria-pressed={item.speed === speed.value}
              aria-label={`${String(speed.value)} times speed`}
              onClick={() => {
                set({ speed: speed.value });
              }}
            >
              {speed.label}
            </button>
          ))}
        </span>
        <button
          className="button small"
          aria-pressed={item.reverse}
          onClick={() => {
            set({ reverse: !item.reverse });
          }}
        >
          Reverse
        </button>
      </div>
      {(item.speed !== 1 || item.reverse) && (
        <p className="muted small">
          {item.reverse ? 'Backwards' : item.speed < 1 ? 'Slowed' : 'Sped up'}, this shot&apos;s own
          sound and dialogue are silent. Lay sound for it on the audio lane.
        </p>
      )}
      <div className="row wrap rescue-freeze">
        <NumberField
          label="Hold last frame (s)"
          value={item.holdSeconds}
          step={0.5}
          max={30}
          onCommit={(holdSeconds) => {
            set({ holdSeconds });
          }}
        />
        <button
          className="button small"
          disabled={!canFreeze}
          title={
            canFreeze
              ? `Freeze ${String(into)} s into this shot for 2 seconds, then play on.`
              : 'Put the playhead inside the moving part of this shot to freeze there.'
          }
          onClick={() => {
            void run('movie.edit.item.freeze', {
              itemId: item.itemId,
              atSeconds: into,
              holdSeconds: 2,
            });
          }}
        >
          Freeze at playhead
        </button>
      </div>
      <div className="rescue-zoom">
        <div className="stack rescue-zoom-fields">
          <label className="field compact">
            <span>
              Zoom {item.zoom.toFixed(2)}×{pushing ? ` to ${zoomEnd.toFixed(2)}×` : ''}
            </span>
            <input
              type="range"
              min={1}
              max={2.5}
              step={0.05}
              value={item.zoom}
              aria-label="Zoom"
              onChange={(event) => {
                set({ zoom: Number(event.target.value) });
              }}
            />
          </label>
          <label className="row rescue-push">
            <input
              type="checkbox"
              checked={pushing}
              onChange={(event) => {
                set({
                  zoomTo: event.target.checked
                    ? round2(Math.min(4, item.zoom + (item.zoom < 1.2 ? 0.25 : -0.25)))
                    : null,
                });
              }}
            />
            <span>Move over the shot</span>
          </label>
          {pushing && (
            <label className="field compact">
              <span>Ends at {zoomEnd.toFixed(2)}×</span>
              <input
                type="range"
                min={1}
                max={2.5}
                step={0.05}
                value={zoomEnd}
                aria-label="Zoom at the end"
                onChange={(event) => {
                  set({ zoomTo: Number(event.target.value) });
                }}
              />
            </label>
          )}
        </div>
        <div
          className="focus-pad"
          role="slider"
          tabIndex={0}
          aria-label="Point to zoom on"
          aria-valuetext={`${String(Math.round(item.focusX * 100))}% across, ${String(Math.round(item.focusY * 100))}% down`}
          aria-valuenow={Math.round(item.focusX * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          title="Tap where the zoom should look"
          onPointerUp={moveFocus}
          onKeyDown={nudge}
        >
          <span className="focus-window" style={windowStyle(Math.max(item.zoom, zoomEnd), item)} />
          <span
            className="focus-dot"
            style={{ left: `${String(item.focusX * 100)}%`, top: `${String(item.focusY * 100)}%` }}
          />
        </div>
      </div>
    </section>
  );
}
