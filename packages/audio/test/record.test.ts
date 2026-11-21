import { CommandRegistry, createLibraryCommands, projectCommands, type Actor } from '@imp/core';
import { createTestRuntime } from '@imp/core/testing';
import { describe, expect, it } from 'vitest';
import {
  audioLibrarySource,
  createAudioCommands,
  createDefaultAudioCodec,
  encodeWav,
} from '../src/index.js';

const take = (seconds: number) =>
  encodeWav(
    {
      sampleRate: 44_100,
      channels: [
        Float32Array.from(
          { length: Math.round(44_100 * seconds) },
          (_, i) => 0.2 * Math.sin(i / 10),
        ),
      ],
    },
    'float32',
  );

interface Outline {
  tracks: {
    id: string;
    name: string;
    regions: { id: string; key: string; label: string; startSeconds: number; endSeconds: number }[];
  }[];
}

async function setup() {
  const runtime = createTestRuntime();
  const registry = new CommandRegistry({ runtime }).register(
    ...projectCommands,
    ...createAudioCommands({ codec: createDefaultAudioCodec() }),
    ...createLibraryCommands([audioLibrarySource]),
  );
  const you: Actor = { kind: 'user', id: 'u' };
  const run = async (id: string, input: unknown) =>
    ((await registry.executeById(id, input, { actor: you })) as { output: Record<string, unknown> })
      .output;
  const projectId = ((await run('project.create', { name: 'P', mode: 'movie' })) as { id: string })
    .id;
  const docId = (
    (await run('audio.doc.create', { projectId, name: 'Voice over' })) as {
      document: { id: string };
    }
  ).document.id;
  return { runtime, run, projectId, docId };
}

describe('microphone recordings', () => {
  it('keeps an upload in the project and places it on a new track, then on a named one', async () => {
    const { runtime, run, projectId, docId } = await setup();
    await runtime.blobs.put('uploads/a', { bytes: take(1.5), mediaType: 'audio/wav' });
    const first = (await run('audio.recording.keep', {
      projectId,
      docId,
      uploadKey: 'uploads/a',
      startSeconds: 2,
    })) as {
      document: Outline;
    };
    const track = first.document.tracks.at(-1);
    expect(track?.name).toBe('Recording 1');
    expect(track?.regions[0]).toMatchObject({
      label: 'Recording 1',
      startSeconds: 2,
      endSeconds: 3.5,
    });
    expect(track?.regions[0]?.key).toMatch(
      new RegExp(`^projects/${projectId}/audio/recordings/.+\\.wav$`),
    );
    expect(await runtime.blobs.get('uploads/a')).toBeUndefined();

    await runtime.blobs.put('uploads/b', { bytes: take(0.5), mediaType: 'audio/wav' });
    const second = (await run('audio.recording.keep', {
      projectId,
      docId,
      uploadKey: 'uploads/b',
      trackId: track?.id,
      label: 'Take 2',
    })) as { document: Outline };
    expect(second.document.tracks.at(-1)?.regions.map((r) => r.label)).toEqual([
      'Recording 1',
      'Take 2',
    ]);
    const listed = (await run('audio.recording.list', { projectId })) as {
      recordings: { key: string; durationSeconds: number }[];
    };
    expect(listed.recordings.map((r) => r.durationSeconds).sort()).toEqual([0.5, 1.5]);
    // The library shows each recording by the region it became, beside the document.
    const library = (await run('library.list', { projectId, kind: 'recording' })) as {
      assets: { title: string; context: string; blobKey: string; durationSeconds: number }[];
    };
    expect(
      library.assets.map((asset) => [asset.title, asset.context, asset.durationSeconds]).sort(),
    ).toEqual([
      ['Recording 1', 'Voice over', 1.5],
      ['Take 2', 'Voice over', 0.5],
    ]);
    // One step undoes the recording.
    await run('audio.history.undo', { projectId, docId });
    const back = (await run('audio.doc.get', { projectId, docId })) as { document: Outline };
    expect(back.document.tracks.at(-1)?.regions).toHaveLength(1);
    const unplaced = (await run('library.list', { projectId, kind: 'recording' })) as {
      assets: { title: string; context: string; open: unknown }[];
    };
    expect(unplaced.assets).toContainEqual(
      expect.objectContaining({ title: 'Recording', context: 'Not placed', open: null }),
    );
  });

  it('refuses what is not an upload, is missing or is not sound', async () => {
    const { runtime, run, projectId, docId } = await setup();
    await expect(
      run('audio.recording.keep', { projectId, docId, uploadKey: 'p/x' }),
    ).rejects.toThrow(/upload/);
    await expect(
      run('audio.recording.keep', { projectId, docId, uploadKey: 'uploads/none' }),
    ).rejects.toThrow(/Nothing was uploaded/);
    await runtime.blobs.put('uploads/junk', {
      bytes: new Uint8Array([1, 2, 3, 4]),
      mediaType: 'audio/wav',
    });
    await expect(
      run('audio.recording.keep', { projectId, docId, uploadKey: 'uploads/junk' }),
    ).rejects.toThrow(/cannot be read/);
    const listed = (await run('audio.recording.list', { projectId })) as { recordings: unknown[] };
    expect(listed.recordings).toEqual([]);
    await runtime.blobs.put('uploads/ok', { bytes: take(0.2), mediaType: 'audio/wav' });
    await expect(
      run('audio.recording.keep', { projectId, docId, uploadKey: 'uploads/ok', trackId: 'nope' }),
    ).rejects.toThrow(/No track/);
  });
});
