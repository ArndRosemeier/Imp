// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cardText, type Item } from '../src/app/cut-player.js';
import { GradeTools } from '../src/app/grade.js';
import { PickupNote, PickupRequest } from '../src/app/pickups.js';
import { RescueTools } from '../src/app/rescue.js';
import { splitEditBlock } from '../src/app/split-edit.js';

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
  placeholder: false,
  pickupReason: null,
  plannedSeconds: null,
  lengthReason: '',
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

const slate = piece({
  placeholder: true,
  pickupReason: 'covers the jump',
  label: 'Close on Mara',
  state: 'no_clip',
  durationSeconds: 3,
  sourceSeconds: 0,
  movingSeconds: 0,
  ownSound: false,
});

describe('a pickup still to come', () => {
  it('shows as its slate and says why it is needed, without clip tools', () => {
    expect(cardText(slate)).toBe('Pickup shot to come\nClose on Mara');
    expect(cardText(piece({ kind: 'title', text: 'The End' }))).toBe('The End');
    const run = vi.fn(() => Promise.resolve({}));
    render(
      <>
        <PickupNote item={slate} />
        <PickupNote item={piece()} />
        <RescueTools item={slate} playheadSeconds={0} run={run} />
        <GradeTools item={slate} items={[slate, piece()]} run={run} canMatch />
      </>,
    );
    expect(screen.getByText('Pickup to come.')).toBeTruthy();
    expect(screen.getByText('Needed for: covers the jump')).toBeTruthy();
    expect(screen.queryByText('Colour')).toBeNull();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(splitEditBlock(piece(), slate, 'j', 0.5)).toBe('Both pieces need a ready clip.');
  });

  it('is asked for after a piece with what it shows and why', async () => {
    const run = vi.fn(() => Promise.resolve({}));
    render(<PickupRequest afterIndex={2} run={run} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask for a shot after this' }));
    const put = screen.getByRole('button', { name: 'Put it in the cut' });
    expect((put as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('What the camera shows'), {
      target: { value: ' Close on Tom ' },
    });
    fireEvent.change(screen.getByLabelText('What the cut needs it for'), {
      target: { value: 'his reaction' },
    });
    fireEvent.change(screen.getByLabelText('How long (s)'), { target: { value: '99' } });
    fireEvent.click(put);
    expect(run).toHaveBeenCalledWith('movie.edit.pickup.request', {
      description: 'Close on Tom',
      reason: 'his reaction',
      seconds: 30,
      toIndex: 2,
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Ask for a shot after this' })).toBeTruthy();
    });
  });

  it('says what went wrong and can be put away', async () => {
    const run = vi.fn(() => Promise.reject(new Error('No view "x".')));
    render(<PickupRequest afterIndex={0} run={run} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask for a shot after this' }));
    fireEvent.change(screen.getByLabelText('What the camera shows'), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText('What the cut needs it for'), {
      target: { value: 'B' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Put it in the cut' }));
    expect(await screen.findByText('No view "x".')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Ask for a shot after this' })).toBeTruthy();
  });
});
