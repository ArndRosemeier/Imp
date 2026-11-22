import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import {
  createMemorySecretStore,
  decodeWire,
  encodeWire,
  serveImp,
  type Imp,
  type Port,
  type SecretStore,
} from '@imp/host';

export interface ImpServerOptions {
  /** Builds the core around the secrets it is given. Called once, on first use. */
  readonly open: (secrets: SecretStore) => Promise<Imp> | Imp;
  /** The folder with the built interface. */
  readonly webDir: string;
  /** How long an interface may be gone before the server forgets it. */
  readonly forgetAfterMs?: number;
  /** Where the OpenRouter key is kept. Left out, it is held in memory until the server stops. */
  readonly secrets?: SecretStore;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.zip': 'application/zip',
};

/** Tells the interface that a server stands behind it, so it does not start a core of its own. */
const SERVED_MARK = '<meta name="imp-host" content="server" />';
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

interface Session {
  readonly port: Port;
  stream: ServerResponse | null;
  readonly waiting: string[];
  forget: ReturnType<typeof setTimeout> | null;
  close(): void;
}

/**
 * The local server: it serves the interface and answers it over the same
 * protocol a worker does. It is meant for the person at this computer only,
 * so it refuses anything that does not address it as this computer or that
 * another website's page sent.
 */
export function createImpServer(options: ImpServerOptions): Server {
  const webDir = normalize(options.webDir);
  const forgetAfterMs = options.forgetAfterMs ?? 30_000;
  const secrets = options.secrets ?? createMemorySecretStore();
  let opened: Promise<Imp> | undefined;
  const open = (): Promise<Imp> => (opened ??= Promise.resolve(options.open(secrets)));
  const sessions = new Map<string, Session>();

  function sessionFor(id: string): { session: Session; fresh: boolean } {
    const existing = sessions.get(id);
    if (existing !== undefined) return { session: existing, fresh: false };
    const session: Session = {
      stream: null,
      waiting: [],
      forget: null,
      port: {
        onmessage: null,
        postMessage(message) {
          const event = `data: ${encodeWire(message)}\n\n`;
          if (session.stream === null) session.waiting.push(event);
          else session.stream.write(event);
        },
      },
      close: () => undefined,
    };
    const stop = serveImp(open, session.port, secrets);
    session.close = () => {
      stop();
      sessions.delete(id);
    };
    sessions.set(id, session);
    forgetLater(session);
    return { session, fresh: true };
  }

  function forgetLater(session: Session): void {
    if (session.forget !== null) clearTimeout(session.forget);
    session.forget = setTimeout(() => {
      session.close();
    }, forgetAfterMs);
    session.forget.unref();
  }

  function events(session: Session, fresh: boolean, response: ServerResponse): void {
    if (session.forget !== null) clearTimeout(session.forget);
    session.forget = null;
    session.stream?.end();
    session.stream = response;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    response.write(`retry: 1000\ndata: ${encodeWire({ hello: { fresh } })}\n\n`);
    for (const event of session.waiting.splice(0)) response.write(event);
    response.on('close', () => {
      if (session.stream !== response) return;
      session.stream = null;
      forgetLater(session);
    });
  }

  async function message(session: Session, request: IncomingMessage): Promise<number> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_MESSAGE_BYTES) return 413;
      chunks.push(chunk);
    }
    let data: unknown;
    try {
      data = decodeWire(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return 400;
    }
    if (typeof data !== 'object' || data === null || !('op' in data)) return 400;
    session.port.onmessage?.({ data });
    return 204;
  }

  async function file(pathname: string, response: ServerResponse, head: boolean): Promise<void> {
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const path = normalize(join(webDir, relative));
    let body: Buffer;
    try {
      if (!path.startsWith(webDir + sep)) throw new Error('outside');
      body = await readFile(path);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found.');
      return;
    }
    const html = extname(path) === '.html';
    const sent = html
      ? Buffer.from(body.toString('utf8').replace('<head>', `<head>\n    ${SERVED_MARK}`))
      : body;
    response.writeHead(200, {
      'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
      'Content-Length': sent.length,
      // Built assets carry a hash in their name; the page itself must always be asked for.
      'Cache-Control': relative.startsWith('assets/') ? 'max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(head ? undefined : sent);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const refuse = (status: number, text: string): void => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text);
    };
    const host = request.headers.host ?? '';
    // A page elsewhere can aim a name at this computer; such a request names that host.
    if (!LOCAL_HOST.test(host)) {
      refuse(403, 'Imp answers only on this computer.');
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) {
      refuse(403, 'Imp answers only its own pages.');
      return;
    }
    const url = new URL(request.url ?? '/', `http://${host}`);
    const method = request.method ?? 'GET';

    if (url.pathname.startsWith('/api/')) {
      const id = url.searchParams.get('session') ?? '';
      if (!SESSION_ID.test(id)) {
        refuse(400, 'A session is needed.');
      } else if (url.pathname === '/api/events' && method === 'GET') {
        const { session, fresh } = sessionFor(id);
        events(session, fresh, response);
      } else if (url.pathname === '/api/message' && method === 'POST') {
        // Only this type: a page elsewhere cannot send it without asking first, and is not answered.
        if (!(request.headers['content-type'] ?? '').startsWith('application/json')) {
          refuse(415, 'Messages are JSON.');
          return;
        }
        const status = await message(sessionFor(id).session, request);
        response.writeHead(status).end();
      } else {
        refuse(404, 'Not found.');
      }
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      refuse(405, 'Not allowed.');
      return;
    }
    await file(url.pathname, response, method === 'HEAD');
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.on('close', () => {
    for (const session of [...sessions.values()]) {
      session.stream?.end();
      session.close();
    }
  });
  return server;
}
