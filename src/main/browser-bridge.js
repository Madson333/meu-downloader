'use strict';

const http = require('node:http');

const PORT = 47900;
const MAX_BODY_BYTES = 256 * 1024;
const CLIENT_HEADER = 'x-meu-downloader';

/**
 * Loopback endpoint for the browser extension.
 *
 * Web pages cannot use it: requests must come from an extension origin and
 * carry a custom header, which forces a CORS preflight this server never
 * approves. Extension service workers with host permission skip that check.
 */
function startBrowserBridge({ manager, onAdded, version, port = PORT }) {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin ?? '';
    const fromExtension = /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin);
    if (!fromExtension || req.headers[CLIENT_HEADER] !== '1') {
      res.writeHead(403).end();
      return;
    }
    const reply = (status, value) => {
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
      const chunks = [];
      req.on('data', (chunk) => {
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
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const id = manager.add({
            url: String(body.url ?? ''),
            referrer: body.referrer ? String(body.referrer) : null,
            cookie: body.cookie ? String(body.cookie) : null,
            userAgent: body.userAgent ? String(body.userAgent) : null,
            fileName: body.fileName ? String(body.fileName) : null,
          });
          onAdded?.(id);
          reply(202, { accepted: true, id });
        } catch (err) {
          reply(400, { error: err.message });
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

module.exports = { startBrowserBridge, PORT };
