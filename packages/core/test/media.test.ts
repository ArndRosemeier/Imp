import { describe, expect, it } from 'vitest';
import { CommandRegistry, mediaCommands } from '../src/index.js';
import { createTestRuntime } from '../src/testing.js';

describe('media.view', () => {
  const setup = async () => {
    const runtime = createTestRuntime();
    await runtime.blobs.put('p/a', { bytes: new Uint8Array(3), mediaType: 'image/webp' });
    await runtime.blobs.put('p/b', { bytes: new Uint8Array(5), mediaType: 'audio/mpeg' });
    const registry = new CommandRegistry({ runtime }).register(...mediaCommands);
    const view = (keys: string[]) =>
      registry.executeById('media.view', { keys }, { actor: { kind: 'user', id: 'u' } });
    return { runtime, view };
  };

  it('returns what is stored under the keys as attachments', async () => {
    const { view } = await setup();
    expect(await view(['p/a', 'p/b'])).toMatchObject({
      status: 'ok',
      output: {
        attachments: [
          { key: 'p/a', mediaType: 'image/webp', sizeBytes: 3 },
          { key: 'p/b', mediaType: 'audio/mpeg', sizeBytes: 5 },
        ],
      },
    });
  });

  it('refuses keys that hold nothing, and more than fits', async () => {
    const { runtime, view } = await setup();
    await expect(view(['p/a', 'p/x'])).rejects.toThrow(/Nothing is stored under "p\/x"/);
    await runtime.blobs.put('p/big', {
      bytes: new Uint8Array(20 * 1024 * 1024 + 1),
      mediaType: 'video/mp4',
    });
    await expect(view(['p/big'])).rejects.toThrow(/too large/);
  });
});
