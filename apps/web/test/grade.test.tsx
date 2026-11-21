// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gradeFilterId, matrixValues, screenStyle, type Item } from '../src/app/cut-player.js';
import { FilmLookPanel, GradeSlider, GradeTools, isNeutralGrade } from '../src/app/grade.js';
import { createColorSampler } from '../src/host/frame-grab.js';

afterEach(cleanup);

const NEUTRAL = { exposure: 0, contrast: 0, temperature: 0, tint: 0, saturation: 0 };

const piece = (fields: Partial<Item> = {}): Item => ({
  itemId: 'a',
  kind: 'shot',
  index: 1,
  sceneId: 's',
  shotId: 'a',
  label: 'Wide on the sea',
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
  transition: 'cut',
  transitionSeconds: 1,
  overlapSeconds: 0,
  dipIn: null,
  dipOut: null,
  grade: NEUTRAL,
  ...fields,
});

describe('grading in the preview', () => {
  it('filters a graded screen with the renderer’s matrix', () => {
    const matrix = Array.from({ length: 20 }, (_, index) => (index % 6 === 0 ? 1.23456 : 0));
    expect(screenStyle({ opacity: 1, wipe: null, front: true, matrix }, 1)['filter']).toBe(
      `url(#${gradeFilterId(1)})`,
    );
    expect(screenStyle({ opacity: 1, wipe: null, front: true })).not.toHaveProperty('filter');
    expect(matrixValues([1.23456, 0, -0.5]).split(' ')).toEqual(['1.2346', '0', '-0.5']);
  });

  it('reads no colours where the browser cannot decode', () => {
    expect(createColorSampler({})).toBeUndefined();
  });
});

describe('the colour controls', () => {
  it('send a drag once, when it is let go, and go back to zero at a double tap', () => {
    const onCommit = vi.fn();
    render(
      <GradeSlider
        label="Exposure"
        value={0.5}
        min={-3}
        max={3}
        low="Darker"
        high="Brighter"
        onCommit={onCommit}
      />,
    );
    const slider = screen.getByRole('slider', { name: 'Exposure' });
    expect(slider.getAttribute('aria-valuetext')).toBe('+0.50, Brighter');
    fireEvent.change(slider, { target: { value: '1.2' } });
    fireEvent.change(slider, { target: { value: '1.5' } });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText('+1.50')).toBeTruthy();
    fireEvent.pointerUp(slider);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith(1.5);
    // Let go without a change sends nothing.
    fireEvent.keyUp(slider);
    expect(onCommit).toHaveBeenCalledTimes(1);
    fireEvent.doubleClick(slider);
    expect(onCommit).toHaveBeenLastCalledWith(0);
  });

  it('grade a shot, put it back as filmed and match it to another', async () => {
    const run = vi.fn(() => Promise.resolve());
    const graded = piece({ grade: { ...NEUTRAL, saturation: -0.4 } });
    const other = piece({ itemId: 'b', index: 2, label: 'Close on Mara' });
    render(
      <GradeTools
        item={graded}
        items={[graded, other, piece({ itemId: 'c', kind: 'title', index: 3 })]}
        run={run}
        canMatch
      />,
    );
    const warmth = screen.getByRole('slider', { name: 'Temperature' });
    fireEvent.change(warmth, { target: { value: '0.3' } });
    fireEvent.blur(warmth);
    expect(run).toHaveBeenLastCalledWith('movie.edit.item.set', {
      itemId: 'a',
      grade: { temperature: 0.3 },
    });
    fireEvent.click(screen.getByRole('button', { name: 'As filmed' }));
    expect(run).toHaveBeenLastCalledWith('movie.edit.item.set', { itemId: 'a', grade: NEUTRAL });
    const match = screen.getByLabelText('Match colour to');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    fireEvent.change(match, { target: { value: 'b' } });
    expect(run).toHaveBeenLastCalledWith('movie.edit.grade.match', { itemId: 'a', toItemId: 'b' });
    await Promise.resolve();
  });

  it('say why a match failed, and are not there for a title card', async () => {
    const run = vi.fn(() => Promise.reject(new Error('The frames could not be read.')));
    const { rerender } = render(
      <GradeTools item={piece()} items={[piece(), piece({ itemId: 'b' })]} run={run} canMatch />,
    );
    expect(screen.queryByRole('button', { name: 'As filmed' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Match colour to'), { target: { value: 'b' } });
    expect(await screen.findByText('The frames could not be read.')).toBeTruthy();
    rerender(<GradeTools item={piece({ kind: 'title' })} items={[]} run={run} canMatch />);
    expect(screen.queryByText('Colour')).toBeNull();
    expect(isNeutralGrade(NEUTRAL)).toBe(true);
  });

  it('set the look of the film from a preset or by hand', () => {
    const run = vi.fn(() => Promise.resolve());
    const onClose = vi.fn();
    render(
      <FilmLookPanel
        view={{
          look: { ...NEUTRAL, temperature: 0.3, preset: 'warm' },
          presets: ['none', 'warm', 'noir'],
          canMatch: false,
        }}
        run={run}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole('button', { name: 'Warm' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Noir' }));
    expect(run).toHaveBeenLastCalledWith('movie.edit.look.set', { preset: 'noir' });
    const contrast = screen.getByRole('slider', { name: 'Contrast' });
    fireEvent.change(contrast, { target: { value: '0.2' } });
    fireEvent.pointerUp(contrast);
    expect(run).toHaveBeenLastCalledWith('movie.edit.look.set', { contrast: 0.2 });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });
});
