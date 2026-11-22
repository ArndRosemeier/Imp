import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryBlobStore, MemoryKeyValueStore } from '@imp/core';
import {
  connectImp,
  createHttpPort,
  createImp,
  createMemorySecretStore,
  type EventStream,
  type KeyKeeping,
  type SecretStore,
} from '@imp/host';
import { createFakeProvider } from '@imp/providers/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createImpServer } from '../src/server.js';

/** An event stream over `fetch`, standing in for the browser's `EventSource`. */
function openStream(url: string): EventStream {
  const controller = new AbortController();
  const stream: EventStream = {
    onopen: null,
    onmessage: null,
    onerror: null,
    close: () => {
      controller.abort();
    },
  };
  void (async () => {
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok || response.body === null) throw new Error('refused');
      stream.onopen?.();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
          const data = buffer
            .slice(0, end)
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .join('\n');
          buffer = buffer.slice(end + 2);
          stream.onmessage?.({ data });
        }
      }
    } catch {
      if (!controller.signal.aborted) stream.onerror?.();
    }
  })();
  return stream;
}

let webDir = '';
const servers: Server[] = [];
const streams: EventStream[] = [];

beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'imp-web-'));
  await mkdir(join(webDir, 'assets'));
  await writeFile(join(webDir, 'index.html'), '<html><head><title>Imp</title></head></html>');
  await writeFile(join(webDir, 'assets', 'app-1.js'), 'console.log(1)');
  await writeFile(join(webDir, 'notes.unknown'), 'x');
});
afterAll(async () => {
  await rm(webDir, { recursive: true, force: true });
});
afterEach(async () => {
  for (const stream of streams.splice(0)) stream.close();
  for (const server of servers.splice(0)) {
    await new Promise((done) => {
      server.close(done);
      server.closeAllConnections();
    });
  }
});

async function start(forgetAfterMs?: number, secrets?: SecretStore) {
  const store = new MemoryKeyValueStore();
  const blobs = new MemoryBlobStore();
  const held: { secrets?: SecretStore } = {};
  const open = vi.fn((secrets: SecretStore) => {
    held.secrets = secrets;
    return createImp({ store, blobs, secrets, provider: createFakeProvider({}) });
  });
  const server = createImpServer({
    open,
    webDir,
    ...(forgetAfterMs === undefined ? {} : { forgetAfterMs }),
    ...(secrets === undefined ? {} : { secrets }),
  });
  servers.push(server);
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
  const connect = (id: string = crypto.randomUUID(), keeping?: KeyKeeping) => {
    const onForgotten = vi.fn();
    const { port, lost } = createHttpPort({
      base,
      openStream: (url) => {
        const stream = openStream(url);
        streams.push(stream);
        return stream;
      },
      fetch,
      onForgotten,
      newId: () => id,
    });
    return {
      client: connectImp(port, keeping ?? createMemorySecretStore(), lost),
      onForgotten,
      id,
    };
  };
  return { base, store, blobs, held, open, connect };
}

/** A request with headers `fetch` does not let a caller set. */
function raw(base: string, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const sent = httpRequest(new URL(path, base), { headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    sent.on('error', reject);
    sent.end();
  });
}

describe('the local server', () => {
  it('keeps the key itself, so a new browser window starts with it and never holds it', async () => {
    const kept = createMemorySecretStore();
    const { connect } = await start(undefined, kept);
    const { client: first } = connect(undefined, { by: 'core' });
    await first.start();
    expect(first.secrets.hasKey()).toBe(false);
    first.secrets.setKey('sk-kept');
    await first.verifyCredentials();
    expect(kept.getKey()).toBe('sk-kept');

    const { client: second } = connect(undefined, { by: 'core' });
    await second.start();
    expect(second.secrets.hasKey()).toBe(true);
  });

  it('answers the interface over HTTP as a worker would', async () => {
    const { blobs, held, connect } = await start();
    const { client } = connect();
    client.secrets.setKey('sk-local');
    await client.start();
    expect(client.commands.length).toBeGreaterThan(10);
    expect(held.secrets?.getKey()).toBe('sk-local');

    const seen = vi.fn();
    client.subscribe('settings/', seen);
    expect(await client.run('settings.set', { key: 'theme', value: 'dark' })).toMatchObject({
      status: 'ok',
    });
    await vi.waitFor(() => {
      expect(seen).toHaveBeenCalledTimes(1);
    });
    await expect(client.run('settings.set', {})).rejects.toMatchObject({ code: 'invalid_input' });

    const bytes = new Uint8Array(256).map((_, index) => index);
    await blobs.put('a/b', { bytes, mediaType: 'video/mp4' });
    expect(await client.blob('a/b')).toEqual({ bytes, mediaType: 'video/mp4' });
    expect(await client.blob('a/none')).toBeUndefined();
  });

  it('shares one core and one key between two interfaces', async () => {
    const { held, open, connect } = await start();
    const [first, second] = [connect().client, connect().client];
    await first.start();
    await second.start();
    const seen = vi.fn();
    second.subscribe('settings/', seen);
    await second.listModels();
    first.secrets.setKey('sk-shared');
    await first.run('settings.set', { key: 'theme', value: 'light' });
    await vi.waitFor(() => {
      expect(seen).toHaveBeenCalledTimes(1);
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(held.secrets?.getKey()).toBe('sk-shared');
  });

  it('serves the interface, marked as served, and nothing outside its folder', async () => {
    const { base } = await start();
    const page = await fetch(base);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('cache-control')).toBe('no-cache');
    expect(await page.text()).toContain('<head>\n    <meta name="imp-host" content="server" />');
    const asset = await fetch(`${base}assets/app-1.js`);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(await asset.text()).toBe('console.log(1)');
    const head = await fetch(`${base}assets/app-1.js`, { method: 'HEAD' });
    expect([head.status, await head.text()]).toEqual([200, '']);
    expect((await fetch(`${base}notes.unknown`)).headers.get('content-type')).toBe(
      'application/octet-stream',
    );
    for (const path of ['missing.js', '..%2F..%2Fetc%2Fpasswd', 'assets']) {
      expect((await fetch(base + path)).status).toBe(404);
    }
    expect((await fetch(base, { method: 'POST' })).status).toBe(405);
  });

  it('refuses whoever is not this computer or not its own page', async () => {
    const { base } = await start();
    const session = `session=${crypto.randomUUID()}`;
    expect(await raw(base, '/', { Host: 'imp.example.com' })).toBe(403);
    expect(await raw(base, '/', { Origin: 'https://elsewhere.example' })).toBe(403);
    expect(await raw(base, '/', { Origin: base.slice(0, -1) })).toBe(200);
    const post = (query: string, body: string, type = 'application/json') =>
      fetch(`${base}api/message?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': type },
        body,
      }).then((response) => response.status);
    expect(await post('session=short', '{}')).toBe(400);
    expect(await post(session, '{"op":"key","key":null}', 'text/plain')).toBe(415);
    expect(await post(session, '{')).toBe(400);
    expect(await post(session, '[1]')).toBe(400);
    expect(await post(session, '{"op":"key","key":null}')).toBe(204);
    expect(await post(session, `"${'x'.repeat(9 * 1024 * 1024)}"`)).toBe(413);
    expect((await fetch(`${base}api/unknown?${session}`)).status).toBe(404);
  });

  it('keeps what an interface is owed while its stream is away, and forgets it later', async () => {
    const { base, connect } = await start(150);
    const { client, onForgotten, id } = connect();
    await client.start();
    // The stream breaks and comes back in time: nothing is lost.
    streams[0]?.close();
    const again = openStream(`${base}api/events?session=${id}`);
    streams.push(again);
    const greetings: string[] = [];
    again.onmessage = ({ data }) => greetings.push(data);
    await vi.waitFor(() => {
      expect(greetings).toEqual(['{"hello":{"fresh":false}}']);
    });
    // It stays away for too long: the server starts over with it and says so.
    again.close();
    await new Promise((done) => setTimeout(done, 400));
    const late = openStream(`${base}api/events?session=${id}`);
    streams.push(late);
    const met: string[] = [];
    late.onmessage = ({ data }) => met.push(data);
    await vi.waitFor(() => {
      expect(met).toEqual(['{"hello":{"fresh":true}}']);
    });
    expect(onForgotten).not.toHaveBeenCalled();
  });

  it('tells an interface that it was forgotten, so it can start over', () => {
    const forgotten = vi.fn();
    const stream: EventStream = { onopen: null, onmessage: null, onerror: null, close: vi.fn() };
    createHttpPort({
      base: 'http://127.0.0.1:1/',
      openStream: () => stream,
      fetch: () => Promise.resolve({ ok: true }),
      onForgotten: forgotten,
      newId: () => 'session-1',
    });
    stream.onopen?.();
    stream.onmessage?.({ data: '{"hello":{"fresh":true}}' });
    stream.onmessage?.({ data: '{"hello":{"fresh":false}}' });
    expect(forgotten).not.toHaveBeenCalled();
    stream.onmessage?.({ data: '{"hello":{"fresh":true}}' });
    expect(forgotten).toHaveBeenCalledTimes(1);
    // A break after the stream was open mends itself and is not a loss.
    stream.onerror?.();
  });

  it('fails calls and the start when no server answers', async () => {
    const { port, lost } = createHttpPort({
      base: 'http://127.0.0.1:1/',
      openStream,
      fetch,
      onForgotten: vi.fn(),
      newId: () => crypto.randomUUID(),
    });
    const client = connectImp(port, createMemorySecretStore(), lost);
    await expect(client.listModels()).rejects.toThrow('The local server did not answer.');
    await expect(client.start()).rejects.toThrow('the local server did not answer');
  });
});
