// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateNotice } from '../src/app/UpdateNotice.js';
import { newerVersion } from '../src/app/updates.js';

describe('newerVersion', () => {
  it('names a published version newer than the running one', () => {
    expect(newerVersion('0.002', { version: '0.028' })).toBe('0.028');
    expect(newerVersion('0.999', { version: '1.000' })).toBe('1.000');
  });

  it('stays quiet for the same, older or unreadable versions', () => {
    expect(newerVersion('0.028', { version: '0.028' })).toBeNull();
    expect(newerVersion('0.028', { version: '0.027' })).toBeNull();
    expect(newerVersion('0.028', { version: 'soon' })).toBeNull();
    expect(newerVersion('0.028', { version: 28 })).toBeNull();
    expect(newerVersion('0.028', null)).toBeNull();
    expect(newerVersion('0.028', '<!doctype html>')).toBeNull();
  });
});

describe('UpdateNotice', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('offers the newer version and can be put off', async () => {
    const check = vi.fn(() => Promise.resolve('0.030'));
    render(<UpdateNotice running="0.002" check={check} />);
    expect(await screen.findByText('0.030')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update now' })).toBeTruthy();
    expect(check).toHaveBeenCalledWith('0.002');
    act(() => {
      screen.getByRole('button', { name: 'Later' }).click();
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows nothing while the running version is current, and asks again later', async () => {
    vi.useFakeTimers();
    const check = vi.fn(() => Promise.resolve(null));
    render(<UpdateNotice running="0.030" check={check} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    });
    expect(check).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
