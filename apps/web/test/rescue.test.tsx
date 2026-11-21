// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HIDDEN, screenStyle, zoomStyle, type Item } from '../src/app/cut-player.js';
import { isPlain, padShare, RescueTools } from '../src/app/rescue.js';
import { transitionNote, TransitionPicker } from '../src/app/transition.js';
import { BACKWARDS_RUN, framesInOrder } from '../src/host/frame-order.js';

/** Shows each frame framesInOrder gives, as the renderer does, one frame at a time. */
async function inOrder<T extends object>(
  times: readonly number[],
  read: (rising: readonly number[]) => AsyncIterable<T | null>,
  close: (frame: T) => void,
  show: (frame: T | null) => Promise<void>,
): Promise<void> {
  for await (const frame of framesInOrder(times, read, close)) await show(frame);
}

afterEach(cleanup);

const piece = (fields: Partial<Item> = {}): Item => ({
  itemId: 'a',
  kind: 'shot',
  index: 1,
  sceneId: 's',
  shotId: 'a',
  label: '',
  state: 'ready',
  trimStartSeconds: 0,
  trimEndSeconds: 0,
  dialogueVolume: 1,
  clipAudioVolume: 1,
  hasClipAudio: true,
  fadeInSeconds: 0,
  fadeOutSeconds: 0,
  text: '',
  startsAtSeconds: 10,
  durationSeconds: 4,
  sourceSeconds: 4,
  speed: 1,
  reverse: false,
  holdSeconds: 0,
  zoom: 1,
  zoomTo: null,
  focusX: 0.5,
  focusY: 0.5,
  movingSeconds: 4,
  ownSound: true,
  transition: 'cut',
  transitionSeconds: 1,
  overlapSeconds: 0,
  dipIn: null,
  dipOut: null,
  grade: { exposure: 0, contrast: 0, temperature: 0, tint: 0, saturation: 0 },
  ...fields,
});

describe('frames in any order', () => {
  /** A decoder that only reads forwards, and says what it was asked for. */
  const decoder = () => {
    const asked: number[][] = [];
    const closed: number[] = [];
    const read = async function* (rising: readonly number[]) {
      asked.push([...rising]);
      for (const time of rising) yield await Promise.resolve({ time });
    };
    return { asked, closed, read, close: (frame: { time: number }) => closed.push(frame.time) };
  };

  it('streams forwards and decodes a frame asked for twice only once', async () => {
    const { asked, closed, read, close } = decoder();
    const shown: (number | null)[] = [];
    await inOrder([0, 0.5, 0.5, 1], read, close, async (frame) => {
      shown.push(frame?.time ?? null);
      await Promise.resolve();
    });
    expect(shown).toEqual([0, 0.5, 0.5, 1]);
    expect(asked).toEqual([[0, 0.5, 1]]);
    expect(closed).toEqual([0, 0.5, 1]);
  });

  it('reads backwards runs forwards a few frames at a time', async () => {
    const { asked, closed, read, close } = decoder();
    const times = Array.from({ length: BACKWARDS_RUN + 3 }, (_, i) => 10 - i);
    const shown: (number | null)[] = [];
    await inOrder(times, read, close, async (frame) => {
      shown.push(frame?.time ?? null);
      await Promise.resolve();
    });
    expect(shown).toEqual(times);
    expect(asked[0]).toEqual([...times.slice(0, BACKWARDS_RUN)].reverse());
    expect(asked[1]).toEqual([...times.slice(BACKWARDS_RUN)].reverse());
    expect(closed.sort((a, b) => a - b)).toEqual([...times].sort((a, b) => a - b));
  });

  it('shows nothing where the decoder has no frame', async () => {
    const shown: unknown[] = [];
    await inOrder(
      [0, 1],
      async function* () {
        yield await Promise.resolve(null);
      },
      () => undefined,
      async (frame) => {
        shown.push(frame);
        await Promise.resolve();
      },
    );
    expect(shown).toEqual([null, null]);
  });

  it('frees the frame it holds when the reader stops early', async () => {
    const { closed, read, close } = decoder();
    for await (const frame of framesInOrder([0, 1, 2], read, close)) {
      if (frame?.time === 1) break;
    }
    expect(closed).toEqual([0, 1]);
  });
});

describe('the two screens of the preview', () => {
  it('stack, fade and wipe one screen over the other', () => {
    expect(screenStyle(HIDDEN)).toEqual({ opacity: 0, zIndex: 1 });
    expect(
      screenStyle({
        opacity: 1,
        wipe: 0.25,
        front: true,
        zoom: { scale: 1, focusX: 0, focusY: 0 },
      }),
    ).toEqual({ opacity: 1, zIndex: 2, clipPath: 'inset(0 75% 0 0)' });
  });
});

describe('the transition of a piece', () => {
  it('sets how a piece comes in and how long it takes', () => {
    const run = vi.fn(() => Promise.resolve());
    render(<TransitionPicker item={piece()} run={run} />);
    expect(screen.queryByLabelText('Length (s)')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dissolve' }));
    expect(run).toHaveBeenLastCalledWith('movie.edit.item.set', {
      itemId: 'a',
      transition: 'dissolve',
    });
    cleanup();
    render(
      <TransitionPicker
        item={piece({ transition: 'wipe', overlapSeconds: 1, transitionSeconds: 1 })}
        run={run}
      />,
    );
    expect(screen.getByRole('button', { name: 'Wipe' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/Lies over the shot before for 1 s/)).toBeTruthy();
    const length = screen.getByLabelText('Length (s)');
    fireEvent.change(length, { target: { value: '2' } });
    fireEvent.blur(length);
    expect(run).toHaveBeenLastCalledWith('movie.edit.item.set', {
      itemId: 'a',
      transitionSeconds: 2,
    });
  });

  it('says what each kind does to the scene', () => {
    expect(transitionNote({ transition: 'cut', overlapSeconds: 0 })).toBe('');
    expect(transitionNote({ transition: 'dissolve', overlapSeconds: 0 })).toMatch(/no room/);
    expect(transitionNote({ transition: 'dip-white', overlapSeconds: 0 })).toMatch(
      /keeps its length/,
    );
  });
});

describe('the zoom of the preview', () => {
  it('scales about the point that keeps the focus in view', () => {
    expect(zoomStyle({ brightness: 1, title: '', card: false })).toEqual({});
    expect(
      zoomStyle({
        brightness: 1,
        title: '',
        card: false,
        zoom: { scale: 2, focusX: 0.5, focusY: 0 },
      }),
    ).toEqual({ transform: 'scale(2)', transformOrigin: '50% 0%' });
  });
});

describe('the rescue tools', () => {
  it('set speed, reverse, a held frame and a punch-in with the editor’s commands', () => {
    const run = vi.fn(() => Promise.resolve());
    render(<RescueTools item={piece()} playheadSeconds={11} run={run} />);
    fireEvent.click(screen.getByRole('button', { name: '0.5 times speed' }));
    expect(run).toHaveBeenLastCalledWith('movie.edit.item.set', { itemId: 'a', speed: 0.5 });
    fireEvent.click(screen.getByRole('button', { name: 'Reverse' }));
    expect(run).toHaveBeenLastCalledWith('movie.edit.item.set', { itemId: 'a', reverse: true });
    fireEvent.click(screen.getByRole('button', { name: 'Freeze at playhead' }));
    expect(run).toHaveBeenLastCalledWith('movie.edit.item.freeze', {
      itemId: 'a',
      atSeconds: 1,
      holdSeconds: 2,
    });
    fireEvent.change(screen.getByLabelText('Zoom'), { target: { value: '1.5' } });
    expect(run).toHaveBeenLastCalledWith('movie.edit.item.set', { itemId: 'a', zoom: 1.5 });
    fireEvent.click(screen.getByLabelText('Move over the shot'));
    expect(run).toHaveBeenLastCalledWith('movie.edit.item.set', { itemId: 'a', zoomTo: 1.25 });
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Point to zoom on' }), {
      key: 'ArrowRight',
    });
    expect(run).toHaveBeenLastCalledWith('movie.edit.item.set', {
      itemId: 'a',
      focusX: 0.52,
      focusY: 0.5,
    });
    expect(screen.queryByText('Play as filmed')).toBeNull();
  });

  it('say the sound is silent off speed, and put a piece back as filmed', () => {
    const run = vi.fn(() => Promise.resolve());
    render(
      <RescueTools
        item={piece({ speed: 2, zoom: 1.4, zoomTo: 1.1 })}
        playheadSeconds={0}
        run={run}
      />,
    );
    expect(screen.getByText(/Sped up/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Freeze at playhead' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByLabelText('Move over the shot'));
    expect(run).toHaveBeenLastCalledWith('movie.edit.item.set', { itemId: 'a', zoomTo: null });
    fireEvent.change(screen.getByLabelText('Zoom at the end'), { target: { value: '2' } });
    expect(run).toHaveBeenLastCalledWith('movie.edit.item.set', { itemId: 'a', zoomTo: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Play as filmed' }));
    expect(run).toHaveBeenLastCalledWith('movie.edit.item.set', {
      itemId: 'a',
      speed: 1,
      reverse: false,
      holdSeconds: 0,
      zoom: 1,
      zoomTo: null,
    });
    cleanup();
    const { container } = render(
      <RescueTools item={piece({ kind: 'title' })} playheadSeconds={0} run={run} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('know a plain piece and where a tap on the focus pad falls', () => {
    expect(isPlain(piece())).toBe(true);
    expect(isPlain(piece({ holdSeconds: 1 }))).toBe(false);
    expect(padShare({ left: 10, top: 10, width: 100, height: 50 }, 35, 70)).toEqual({
      focusX: 0.25,
      focusY: 1,
    });
  });
});
