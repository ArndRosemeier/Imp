// @vitest-environment jsdom
import { Shot } from '@imp/mode-movie';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Item } from '../src/app/cut-player.js';
import { SplitEdit, splitEditBlock, TakeSwitcher } from '../src/app/split-edit.js';

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
  startsAtSeconds: 0,
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

const clip = (blobKey: string, durationSeconds: number | null = 4) => ({
  status: 'ready' as const,
  jobId: 'j',
  blobKey,
  mediaType: 'video/mp4',
  prompt: '',
  model: 'vendor/clips',
  progress: null,
  error: null,
  durationSeconds,
  portraits: 0,
  guides: [],
  silent: false,
  startFrameId: null,
  costUsd: null,
  createdAt: '2026-11-21T10:00:00.000Z',
});

describe('when a split edit can be made', () => {
  it('needs picture trimmed off where the cut moves to, and two ready shots', () => {
    const a = piece({ trimEndSeconds: 1 });
    const b = piece({ itemId: 'b', trimStartSeconds: 0.4 });
    expect(splitEditBlock(a, b, 'j', 0.5)).toBeNull();
    expect(splitEditBlock(a, b, 'l', 0.5)).toMatch(/0.4 s trimmed off its start/);
    expect(splitEditBlock(a, b, 'l', 0.4)).toBeNull();
    expect(splitEditBlock(a, b, 'j', 2)).toMatch(/1 s trimmed off its end/);
    expect(splitEditBlock(a, undefined, 'j', 0.5)).toMatch(/last piece/);
    expect(splitEditBlock(a, piece({ kind: 'title' }), 'j', 0.5)).toMatch(/shots/);
    expect(splitEditBlock(a, piece({ durationSeconds: 0 }), 'j', 0.5)).toMatch(/ready clip/);
    expect(splitEditBlock(a, b, 'j', 0)).toMatch(/above 0/);
    expect(splitEditBlock(a, piece({ speed: 2 }), 'j', 0.5)).toMatch(/own speed/);
    expect(
      splitEditBlock(piece({ durationSeconds: 0.5 }), piece({ trimStartSeconds: 1 }), 'l', 0.4),
    ).toMatch(/this picture too short/);
    expect(
      splitEditBlock(piece({ trimEndSeconds: 1 }), piece({ durationSeconds: 0.5 }), 'j', 0.4),
    ).toMatch(/next picture too short/);
  });
});

describe('the split edit controls', () => {
  it('run the same command the Film Editor uses, with the overlap typed', () => {
    const run = vi.fn(() => Promise.resolve());
    render(
      <SplitEdit
        item={piece({ trimEndSeconds: 1 })}
        next={piece({ itemId: 'b', trimStartSeconds: 1 })}
        run={run}
      />,
    );
    fireEvent.change(screen.getByLabelText('Overlap (s)'), { target: { value: '0.8' } });
    fireEvent.click(screen.getByRole('button', { name: /L cut/ }));
    expect(run).toHaveBeenCalledWith('movie.edit.item.roll', {
      itemId: 'a',
      type: 'l',
      seconds: 0.8,
    });
    fireEvent.click(screen.getByRole('button', { name: /J cut/ }));
    expect(run).toHaveBeenLastCalledWith('movie.edit.item.roll', {
      itemId: 'a',
      type: 'j',
      seconds: 0.8,
    });
  });

  it('say what to trim when neither cut can be made, and hide for the last piece', () => {
    const run = vi.fn(() => Promise.resolve());
    const { rerender, container } = render(
      <SplitEdit item={piece()} next={piece({ itemId: 'b' })} run={run} />,
    );
    expect(screen.getByRole('button', { name: /J cut/ })).toHaveProperty('disabled', true);
    expect(screen.getByText(/shows picture that was trimmed off/)).toBeTruthy();
    rerender(<SplitEdit item={piece()} next={undefined} run={run} />);
    expect(container.innerHTML).toBe('');
  });

  it('swap a piece’s picture for an earlier take of its shot', () => {
    const run = vi.fn(() => Promise.resolve());
    const shot = Shot.parse({
      id: 'a',
      sceneId: 's',
      position: 1,
      description: '',
      characterIds: [],
      performance: '',
      speakerId: null,
      line: '',
      delivery: '',
      clip: clip('now'),
      takes: [clip('older', 6), clip('oldest', null)],
    });
    render(<TakeSwitcher shot={shot} run={run} />);
    expect(screen.getByText(/2 earlier takes/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Take'), { target: { value: 'older' } });
    expect(run).toHaveBeenCalledWith('movie.shot.take.use', {
      sceneId: 's',
      shotId: 'a',
      blobKey: 'older',
    });
    cleanup();
    const { container } = render(
      <TakeSwitcher shot={Shot.parse({ ...shot, takes: [] })} run={run} />,
    );
    expect(container.innerHTML).toBe('');
    cleanup();
    render(
      <TakeSwitcher shot={{ ...shot, clip: { ...clip('now'), status: 'pending' } }} run={run} />,
    );
    expect(screen.getByText(/being made/)).toBeTruthy();
  });
});
