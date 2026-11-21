// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zoomStyle, type Item } from '../src/app/cut-player.js';
import { isPlain, padShare, RescueTools } from '../src/app/rescue.js';
import { BACKWARDS_RUN, inOrder } from '../src/host/frame-order.js';

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
