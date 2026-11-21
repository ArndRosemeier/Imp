// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  filmClock,
  FilmStrip,
  fitScale,
  MAX_FILM_SCALE,
  MIN_SCENE_PX,
  sceneState,
  sceneSummary,
} from '../src/app/film-strip.js';
import { MarkerInspector, markerAuthor, MarkerLane, type MarkerView } from '../src/app/markers.js';

beforeAll(() => {
  // jsdom lays nothing out, so it cannot scroll an element into view.
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

/** The element, or a failed test when it is not there. */
function must<T>(element: T | null | undefined): T {
  if (element === null || element === undefined) throw new Error('Not found.');
  return element;
}

const scene = (position: number, fields: Record<string, unknown> = {}) => ({
  sceneId: `s${String(position)}`,
  position,
  heading: `SCENE ${String(position)}`,
  items: 2,
  readyItems: 2,
  durationSeconds: 30,
  startSeconds: (position - 1) * 30,
  missing: [],
  openMarkers: 0,
  ...fields,
});

const film = {
  totalSeconds: 60,
  totalCostUsd: 1,
  items: 4,
  readyItems: 3,
  openMarkers: 1,
  scenes: [
    scene(1),
    scene(2, {
      heading: '',
      readyItems: 1,
      missing: [{ itemId: 'x', index: 2, state: 'no_clip' }],
      openMarkers: 1,
    }),
  ],
};

const marker = (fields: Partial<MarkerView> = {}): MarkerView => ({
  id: 'm1',
  sceneId: 's2',
  atSeconds: 15,
  filmSeconds: 45,
  text: 'Needs a wide',
  kind: 'todo',
  done: false,
  by: 'person',
  ...fields,
});

describe('the film strip', () => {
  it('names times, states and what a scene still needs', () => {
    expect(filmClock(75)).toBe('1:15');
    expect(filmClock(3725)).toBe('1:02:05');
    expect(sceneState({ items: 0, readyItems: 0 })).toBe('empty');
    expect(sceneState({ items: 3, readyItems: 1 })).toBe('partial');
    expect(sceneState({ items: 3, readyItems: 3 })).toBe('ready');
    const summary = sceneSummary(film.scenes[1] ?? scene(9));
    expect(summary).toContain('Scene 2 · Untitled');
    expect(summary).toContain('piece 2: no clip yet');
    expect(summary).toContain('1 open marker');
  });

  it('fits the film, giving short scenes their least width', () => {
    expect(fitScale([30, 30], 608)).toBe(10);
    // The empty scene keeps its least width; the others share the rest.
    expect(fitScale([0, 50], 108 + MIN_SCENE_PX)).toBe(2);
    expect(fitScale([], 500)).toBe(MAX_FILM_SCALE);
    expect(fitScale([0], 500)).toBe(MAX_FILM_SCALE);
  });

  it('opens scenes, moves between them by key, zooms and plays on', () => {
    const onOpen = vi.fn();
    const onPlayOn = vi.fn();
    render(
      <FilmStrip
        film={film}
        sceneId="s1"
        markers={[marker()]}
        playOn={false}
        onOpen={onOpen}
        onPlayOn={onPlayOn}
      />,
    );
    expect(screen.getByText(/2 scenes · 1:00 · 1 finished · 1 open marker/)).toBeTruthy();
    const blocks = screen.getAllByRole('button', { name: /^Scene/ });
    expect(blocks[0]?.getAttribute('aria-current')).toBe('true');
    expect(blocks[1]?.className).toContain('film-scene-partial');
    fireEvent.click(must(blocks[1]));
    expect(onOpen).toHaveBeenCalledWith('s2');
    fireEvent.keyDown(must(blocks[0]), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(blocks[1]);
    fireEvent.keyDown(must(blocks[1]), { key: 'Home' });
    expect(document.activeElement).toBe(blocks[0]);
    fireEvent.keyDown(must(blocks[0]), { key: 'End' });
    expect(document.activeElement).toBe(blocks[1]);
    fireEvent.keyDown(must(blocks[1]), { key: 'a' });
    expect(document.querySelectorAll('.film-marker')).toHaveLength(1);

    const fit = screen.getByRole('button', { name: 'Fit' });
    expect(fit.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(fit.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.wheel(must(document.querySelector('.film-strip-scroll')), {
      ctrlKey: true,
      deltaY: -1,
    });
    fireEvent.wheel(must(document.querySelector('.film-strip-scroll')), { deltaY: 1 });
    fireEvent.click(fit);
    expect(fit.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Play on' }));
    expect(onPlayOn).toHaveBeenCalledWith(true);
  });
});

describe('markers', () => {
  it('says who left one', () => {
    expect(markerAuthor('person')).toBe('You');
    expect(markerAuthor('film-editor')).toBe('Film editor');
  });

  it('show on their lane and select at a tap', () => {
    const onSelect = vi.fn();
    render(
      <MarkerLane
        markers={[marker(), marker({ id: 'm2', done: true, kind: 'problem' })]}
        scale={10}
        selectedId="m2"
        onSelect={onSelect}
      />,
    );
    const flag = screen.getByRole('button', { name: 'To do: Needs a wide' });
    expect(flag.style.left).toBe('150px');
    fireEvent.pointerDown(flag);
    fireEvent.click(flag);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }));
    expect(screen.getByRole('button', { name: /Problem, done/ }).className).toContain('selected');
  });

  it('change, move and remove a marker in the inspector', async () => {
    const run = vi.fn(() => Promise.resolve());
    const onRemoved = vi.fn();
    render(
      <MarkerInspector marker={marker()} playheadSeconds={3.21} run={run} onRemoved={onRemoved} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Problem' }));
    expect(run).toHaveBeenLastCalledWith('movie.edit.marker.set', {
      markerId: 'm1',
      kind: 'problem',
    });
    const words = screen.getByLabelText('What it says');
    fireEvent.change(words, { target: { value: '  Needs a wide of the rocks ' } });
    fireEvent.blur(words);
    expect(run).toHaveBeenLastCalledWith('movie.edit.marker.set', {
      markerId: 'm1',
      text: 'Needs a wide of the rocks',
    });
    run.mockClear();
    fireEvent.change(words, { target: { value: '   ' } });
    fireEvent.blur(words);
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Done'));
    expect(run).toHaveBeenLastCalledWith('movie.edit.marker.set', { markerId: 'm1', done: true });
    fireEvent.click(screen.getByRole('button', { name: 'Move to playhead' }));
    expect(run).toHaveBeenLastCalledWith('movie.edit.marker.set', {
      markerId: 'm1',
      atSeconds: 3.21,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(run).toHaveBeenLastCalledWith('movie.edit.marker.remove', { markerId: 'm1' });
    await Promise.resolve();
    expect(onRemoved).toHaveBeenCalled();
  });
});
