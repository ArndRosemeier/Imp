// @vitest-environment jsdom
import { MemoryKeyValueStore } from '@imp/core';
import {
  connectImp,
  createImp,
  createLocalPorts,
  createMemorySecretStore,
  serveImp,
  type FfmpegStatus,
} from '@imp/host';
import { createFakeProvider } from '@imp/providers/testing';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImpContext } from '../src/app/context.js';
import { FfmpegOffer } from '../src/app/FfmpegOffer.js';

const missing: FfmpegStatus = {
  available: false,
  source: null,
  canDownload: true,
  downloadBytes: 25 * 1024 ** 2,
  downloading: null,
  error: null,
};

function show(compact: boolean) {
  let status = missing;
  let finish: () => void = () => undefined;
  const ffmpeg = {
    status: () => status,
    install: vi.fn(
      (progress?: (now: FfmpegStatus) => void) =>
        new Promise<FfmpegStatus>((resolve) => {
          status = {
            ...missing,
            downloading: { receivedBytes: 5 * 1024 ** 2, totalBytes: 25 * 1024 ** 2 },
          };
          progress?.(status);
          finish = () => {
            status = { ...missing, available: true, source: 'downloaded' };
            resolve(status);
          };
        }),
    ),
  };
  const imp = createImp({
    store: new MemoryKeyValueStore(),
    secrets: createMemorySecretStore(),
    provider: createFakeProvider({}),
    ffmpeg,
  });
  const [page, core] = createLocalPorts();
  serveImp(() => imp, core);
  const client = connectImp(page, createMemorySecretStore());
  render(
    <ImpContext value={client}>
      <FfmpegOffer compact={compact} />
    </ImpContext>,
  );
  return {
    ffmpeg,
    finish: () => {
      finish();
    },
    user: userEvent.setup(),
  };
}

beforeEach(() => {
  const meta = document.createElement('meta');
  meta.name = 'imp-host';
  meta.content = 'server';
  document.head.append(meta);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  document.head.querySelector('meta[name="imp-host"]')?.remove();
});

describe('the offer to download ffmpeg on the local server', () => {
  it('downloads ffmpeg on a tap, shows how far it got, then says it is there', async () => {
    const { ffmpeg, finish, user } = show(false);
    await user.click(await screen.findByRole('button', { name: /Download ffmpeg/ }));
    expect(ffmpeg.install).toHaveBeenCalledOnce();
    expect(await screen.findByText(/5 MB of 25 MB/)).toBeTruthy();
    finish();
    expect(await screen.findByText(/Imp downloaded ffmpeg/)).toBeTruthy();
  });

  it('can be put away for good in the export bar', async () => {
    const { user } = show(true);
    await user.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('button', { name: /Download ffmpeg/ })).toBeNull();
    expect(localStorage.getItem('imp.ffmpeg-offer.dismissed')).toBe('true');
  });
});
