'use strict';

const http = require('node:http');
const https = require('node:https');

const MAX_REDIRECTS = 10;
const IDLE_TIMEOUT_MS = 30_000;

class HttpError extends Error {
  constructor(message, { status = null, retryable = false, code = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Sends a GET request and follows redirects. Resolves with the response whose
 * body has not been consumed yet, plus the final URL after redirects.
 */
function request(url, { headers = {}, signal, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    let redirects = 0;

    const send = (target) => {
      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        reject(new HttpError(`URL inválida: ${target}`));
        return;
      }
      const transport = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null;
      if (!transport) {
        reject(new HttpError(`Protocolo não suportado: ${parsed.protocol}`));
        return;
      }

      const req = transport.request(parsed, { method, headers, signal });
      req.setTimeout(IDLE_TIMEOUT_MS, () => {
        req.destroy(new HttpError('Tempo de conexão esgotado', { retryable: true }));
      });
      req.on('error', (err) => {
        if (err.name === 'AbortError') {
          reject(err);
          return;
        }
        reject(err instanceof HttpError ? err : new HttpError(err.message, { retryable: true }));
      });
      req.on('response', (res) => {
        const status = res.statusCode;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (++redirects > MAX_REDIRECTS) {
            reject(new HttpError('Redirecionamentos demais', { status }));
            return;
          }
          send(new URL(res.headers.location, target).href);
          return;
        }
        if (status >= 400) {
          res.resume();
          reject(new HttpError(`O servidor respondeu HTTP ${status}`, { status, retryable: isRetryableStatus(status) }));
          return;
        }
        res.setTimeout(IDLE_TIMEOUT_MS, () => {
          res.destroy(new HttpError('O servidor parou de enviar dados', { retryable: true }));
        });
        resolve({ res, finalUrl: target });
      });
      req.end();
    };

    send(url);
  });
}

/** Parses "bytes start-end/total"; total may be "*". */
function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec((value ?? '').trim());
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? null : Number(match[3]),
  };
}

module.exports = { request, parseContentRange, HttpError };
