import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

export interface FileServer {
  base: string;
  body: Buffer;
  sha: string;
  stats: { requests: number; ranges: [number, number][]; maxConcurrent: number };
  close(): Promise<void>;
}

/**
 * Local HTTP server for engine tests.
 *   /file        ranged file (206 with Content-Range)
 *   /norange     ignores Range, always 200 with the whole body
 *   /chunked     no Content-Length (unknown size)
 *   /redirect    302 to /named
 *   /named       ranged file with Content-Disposition
 *   /slow        ranged file sent at ~bytesPerSecond per connection
 *   /flaky       ranged file whose connections drop after 300 KiB once each
 */
export async function startFileServer({ size = 6 * 1024 * 1024, bytesPerSecond = 2 * 1024 * 1024 } = {}): Promise<FileServer> {
  const body = crypto.randomBytes(size);
  const stats: FileServer['stats'] = { requests: 0, ranges: [], maxConcurrent: 0 };
  const flakyDropped = new Set<string>();
  let open = 0;

  const sendRange = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    extraHeaders: http.OutgoingHttpHeaders = {},
    { throttle = false, dropAfter = null }: { throttle?: boolean; dropAfter?: number | null } = {},
  ): void => {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    let start = 0;
    let end = size - 1;
    let status = 200;
    const headers: http.OutgoingHttpHeaders = { 'Accept-Ranges': 'bytes', ETag: '"v1"', ...extraHeaders };
    if (match) {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      if (req.headers['if-range'] && req.headers['if-range'] !== '"v1"') {
        start = 0;
        end = size - 1;
      } else {
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      }
      stats.ranges.push([start, end]);
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    const slice = body.subarray(start, end + 1);
    if (dropAfter !== null && slice.length > dropAfter) {
      res.write(slice.subarray(0, dropAfter), () => res.destroy());
      return;
    }
    if (!throttle) {
      res.end(slice);
      return;
    }
    let offset = 0;
    const step = Math.max(1024, Math.floor(bytesPerSecond / 20));
    const timer = setInterval(() => {
      if (res.destroyed) return clearInterval(timer);
      const next = slice.subarray(offset, offset + step);
      offset += next.length;
      if (offset >= slice.length) {
        clearInterval(timer);
        res.end(next);
      } else {
        res.write(next);
      }
    }, 50);
    res.on('close', () => clearInterval(timer));
  };

  const server = http.createServer((req, res) => {
    stats.requests++;
    open++;
    stats.maxConcurrent = Math.max(stats.maxConcurrent, open);
    res.on('close', () => open--);
    const { pathname } = new URL(req.url ?? '/', 'http://x');
    switch (pathname) {
      case '/file':
        return sendRange(req, res);
      case '/slow':
        return sendRange(req, res, {}, { throttle: true });
      case '/flaky': {
        const key = req.headers.range ?? 'all';
        const drop = !flakyDropped.has(key);
        flakyDropped.add(key);
        return sendRange(req, res, {}, { dropAfter: drop ? 300 * 1024 : null });
      }
      case '/named':
        return sendRange(req, res, { 'Content-Disposition': "attachment; filename*=UTF-8''relat%C3%B3rio%20final.bin" });
      case '/redirect':
        res.writeHead(302, { Location: '/named' });
        return res.end();
      case '/clip.mp4':
        return sendRange(req, res, { 'Content-Type': 'video/mp4' }, { throttle: true });
      case '/player':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><title>Meu clipe</title><video src="/clip.mp4" controls></video>');
      case '/watch':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><title>video page</title>');
      case '/page.html':
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<!doctype html><title>saved page</title>');
      case '/norange':
        res.writeHead(200, { 'Content-Length': size });
        return res.end(body);
      case '/chunked':
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.write(body.subarray(0, size / 2));
        return res.end(body.subarray(size / 2));
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  return {
    base,
    body,
    sha,
    stats,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

