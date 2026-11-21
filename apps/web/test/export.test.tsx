// @vitest-environment jsdom
import { MemoryKeyValueStore, type Project } from '@imp/core';
import { connectImp, createImp, createLocalPorts, serveImp, type Imp } from '@imp/host';
import type { FilmRenderer } from '@imp/mode-movie';
import { createFakeProvider } from '@imp/providers/testing';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImpContext } from '../src/app/context.js';
import { ExportBar } from '../src/app/ExportBar.js';
import { chooseFormat, fadeLevel, nearestRate } from '../src/host/film-format.js';
import { createLocalSecretStore } from '../src/host/secrets.js';

afterEach(cleanup);

function connect(imp: Imp) {
  const [page, core] = createLocalPorts();
  serveImp(() => imp, core);
  return connectImp(page, imp.secrets);
}

/** Renders in two steps, so the page can be seen while the film is rendering. */
function steppedRenderer() {
  let release: (() => void) | undefined;
  const renderer: FilmRenderer = {
    unavailable: () => null,
    render: async (job) => {
      await job.write(new Uint8Array([1, 2, 3]), 0);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (job.cancelled()) throw new Error('stopped');
      await job.write(new Uint8Array([4]), 3);
      return {
        mediaType: 'video/mp4',
        extension: 'mp4',
        videoCodec: 'avc',
        audioCodec: 'aac',
        width: 1920,
        height: 1080,
        fps: 24,
      };
    },
  };
  return { renderer, release: () => release?.(), waiting: () => release !== undefined };
}

async function setup(renderer: FilmRenderer) {
  const imp = createImp({
    store: new MemoryKeyValueStore(),
    secrets: createLocalSecretStore(),
    provider: createFakeProvider({}),
    filmRenderer: renderer,
  });
  const actor = { kind: 'user', id: 'local' } as const;
  const call = async (id: string, input: Record<string, unknown>) => {
    const result = await imp.registry.executeById(id, input, { actor });
    if (result.status !== 'ok') throw new Error(id);
    return result.output as Record<string, unknown>;
  };
  const project = (await call('project.create', { name: 'Storm', mode: 'movie' })) as Project;
  const scene = (await call('movie.scene.create', {
    projectId: project.id,
    heading: 'EXT. CLIFF',
  })) as { id: string };
  await call('movie.edit.title.add', { projectId: project.id, sceneId: scene.id, text: 'Storm' });
  render(
    <ImpContext.Provider value={connect(imp)}>
      <ExportBar project={project} sceneId={scene.id} sceneIds={[scene.id]} />
    </ImpContext.Provider>,
  );
  return { user: userEvent.setup() };
}

describe('exporting from the Edit screen', () => {
  it('renders in the background, shows progress, and offers the file', async () => {
    const stepped = steppedRenderer();
    const { user } = await setup(stepped.renderer);
    await user.click(await screen.findByRole('button', { name: /Export film/ }));
    expect(await screen.findByText(/Rendering film/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Export scene/ }).disabled).toBe(
      true,
    );
    await vi.waitFor(() => {
      expect(stepped.waiting()).toBe(true);
    });
    stepped.release();
    expect(await screen.findByText('Storm-film.mp4')).toBeTruthy();
    expect(screen.getByText(/1920×1080 24 fps/)).toBeTruthy();

    const saved: Blob[] = [];
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      saved.push(blob as Blob);
      return 'blob:test/film';
    };
    URL.revokeObjectURL = () => undefined;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    await user.click(screen.getByRole('button', { name: /Download/ }));
    await vi.waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect([...new Uint8Array(await (saved[0] ?? new Blob()).arrayBuffer())]).toEqual([1, 2, 3, 4]);
    click.mockRestore();

    await user.click(screen.getByRole('button', { name: /Delete Storm-film.mp4/ }));
    await vi.waitFor(() => {
      expect(screen.queryByText('Storm-film.mp4')).toBeNull();
    });
  });

  it('cancels a render', async () => {
    const stepped = steppedRenderer();
    const { user } = await setup(stepped.renderer);
    await user.click(await screen.findByRole('button', { name: /Export scene/ }));
    await user.click(await screen.findByRole('button', { name: /Cancel/ }));
    await vi.waitFor(() => {
      expect(stepped.waiting()).toBe(true);
    });
    stepped.release();
    expect(await screen.findByText(/Cancelled/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows why a render failed', async () => {
    const { user } = await setup({
      unavailable: () => null,
      render: () => Promise.reject(new Error('No encoder for this size.')),
    });
    await user.click(await screen.findByRole('button', { name: /Export film/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/No encoder for this size/);
    expect(screen.getByText(/Failed: No encoder/)).toBeTruthy();
  });
});

describe('the format of a rendered film', () => {
  it('follows the largest clip and the rate that plays longest', () => {
    expect(
      chooseFormat(
        [
          { width: 864, height: 496, fps: 24, seconds: 4 },
          { width: 1280, height: 720, fps: 29.97, seconds: 3 },
          { width: 1280, height: 720, fps: 23.976, seconds: 4 },
        ],
        null,
        null,
      ),
    ).toEqual({ width: 1280, height: 720, fps: 24 });
    expect(chooseFormat([{ width: 1280, height: 720, fps: 30, seconds: 1 }], 1080, 25)).toEqual({
      width: 1920,
      height: 1080,
      fps: 25,
    });
    // Only title cards: a 720p frame at 30 frames per second.
    expect(chooseFormat([], null, null)).toEqual({ width: 1280, height: 720, fps: 30 });
    expect(chooseFormat([{ width: 4096, height: 4096, fps: 60, seconds: 1 }], null, null)).toEqual({
      width: 2160,
      height: 2160,
      fps: 60,
    });
  });

  it('snaps measured rates and fades pictures to and from black', () => {
    expect(nearestRate(23.976)).toBe(24);
    expect(nearestRate(49.5)).toBe(50);
    expect(nearestRate(5)).toBe(24);
    expect(fadeLevel(2, 0, 1, 9)).toBe(0.5);
    expect(fadeLevel(0, 2, 5, 0.5)).toBe(0.25);
    expect(fadeLevel(0, 0, 1, 1)).toBe(1);
  });
});
