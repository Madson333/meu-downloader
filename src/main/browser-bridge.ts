import http from 'node:http';
import type { DownloadManager } from '../engine/download-manager';

export const PORT = 47900;
const MAX_BODY_BYTES = 256 * 1024;
const CLIENT_HEADER = 'x-meu-downloader';

/** What the extension posts to /download. */
interface DownloadRequest {
  url?: unknown;
  referrer?: unknown;
  cookie?: unknown;
  userAgent?: unknown;
  fileName?: unknown;
}

const optionalString = (value: unknown): string | null => (value ? String(value) : null);

/**
 * Loopback endpoint for the browser extension.
 *
 * Web pages cannot use it: requests must come from an extension origin and
 * carry a custom header, which forces a CORS preflight this server never
 * approves. Extension service workers with host permission skip that check.
 */
export function startBrowserBridge({ manager, onAdded, version, port = PORT }: {
  manager: DownloadManager;
  onAdded?: (id: string) => void;
  version: string;
  port?: number;
}): http.Server {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin ?? '';
    const fromExtension = /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin);
    if (!fromExtension || req.headers[CLIENT_HEADER] !== '1') {
      res.writeHead(403).end();
      return;
    }
    const reply = (status: number, value: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };

    if (req.method === 'GET' && req.url === '/ping') {
      const s = manager.settings;
      reply(200, {
        app: 'meu-downloader',
        version,
        captureEnabled: s.captureEnabled,
        captureExtensions: s.captureExtensions,
        minCaptureSizeKB: s.minCaptureSizeKB,
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/download') {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reply(413, { error: 'pedido grande demais' });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (res.writableEnded) return;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as DownloadRequest;
          const id = manager.add({
            url: String(body.url ?? ''),
            referrer: optionalString(body.referrer),
            cookie: optionalString(body.cookie),
            userAgent: optionalString(body.userAgent),
            fileName: optionalString(body.fileName),
          });
          onAdded?.(id);
          reply(202, { accepted: true, id });
        } catch (err) {
          reply(400, { error: err instanceof Error ? err.message : String(err) });
        }
      });
      return;
    }

    reply(404, { error: 'rota desconhecida' });
  });

  server.on('error', (err) => {
    console.error(`Ponte do navegador indisponível na porta ${port}:`, err.message);
  });
  server.listen(port, '127.0.0.1');
  return server;
}
