import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

export interface RouteOptions {
  type?: string;
  failTimes?: number;
  failStatus?: number;
  status?: number;
  delayMs?: number;
}

interface Route extends RouteOptions {
  body: Buffer | string | null;
}

export interface LoggedRequest {
  path: string;
  host: string | undefined;
  cookie: string | null;
  range: string | null;
}

export interface StreamServer {
  base: string;
  port: number;
  log: LoggedRequest[];
  set(pathname: string, body: Buffer | string | null, options?: RouteOptions): void;
  serveDir(prefix: string, dir: string): void;
  requests(prefix: string): LoggedRequest[];
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt',
};

/**
 * Local server for stream tests. Routes are set per test:
 *   set(path, body, { type, failTimes, failStatus, status, delayMs })
 *   serveDir(prefix, dir)   serves files written by ffmpeg
 * Every request is logged with its host, cookie and range.
 */
export async function startStreamServer(): Promise<StreamServer> {
  const routes = new Map<string, Route>();
  const dirs: [string, string][] = [];
  const log: LoggedRequest[] = [];

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://x');
    log.push({ path: pathname, host: req.headers.host, cookie: req.headers.cookie ?? null, range: req.headers.range ?? null });
    let route = routes.get(pathname);
    if (!route) {
      const mount = dirs.find(([prefix]) => pathname.startsWith(prefix));
      if (mount) {
        const file = path.join(mount[1], ...pathname.slice(mount[0].length).split('/').filter((p) => p && p !== '..'));
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          route = { body: fs.readFileSync(file), type: TYPES[path.extname(file)] ?? 'application/octet-stream' };
        }
      }
    }
    if (!route) {
      res.writeHead(404);
      res.end();
      return;
    }
    if ((route.failTimes ?? 0) > 0) {
      route.failTimes = (route.failTimes ?? 0) - 1;
      res.writeHead(route.failStatus ?? 503);
      res.end();
      return;
    }
    if (route.status) {
      res.writeHead(route.status);
      res.end();
      return;
    }
    if (route.delayMs) await new Promise((r) => setTimeout(r, route.delayMs));
    const body = Buffer.isBuffer(route.body) ? route.body : Buffer.from(String(route.body));
    const headers: http.OutgoingHttpHeaders = { 'Content-Type': route.type ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
      headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      res.end(body.subarray(start, end + 1));
      return;
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    log,
    set(pathname, body, options = {}) {
      routes.set(pathname, { body, ...options });
    },
    serveDir(prefix, dir) {
      dirs.push([prefix, dir]);
    },
    requests(prefix) {
      return log.filter((r) => r.path.startsWith(prefix));
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

