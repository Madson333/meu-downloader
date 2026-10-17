'use strict';

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');

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

/** Loopback, private, link-local, CGNAT, multicast and unspecified addresses. */
function isPrivateAddress(ip) {
  const addr = String(ip).replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (!net.isIPv6(addr)) return false;
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (dotted) return isPrivateAddress(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (hex) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return addr === '::' || addr === '::1' || /^f[cd]/.test(addr) || /^fe[89ab]/.test(addr) || /^ff/.test(addr);
}

/** DNS lookup that refuses internal addresses, so redirects and DNS rebinding cannot reach them. */
function publicOnlyLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err);
      return;
    }
    if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
      callback(new HttpError(`Endereço interno bloqueado: ${hostname}`, { code: 'BLOCKED_ADDRESS' }));
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

// Guarded requests get their own connection pools: a keep-alive socket opened
// by an unguarded request skips the DNS check and must never be reused here.
const guardedAgents = {
  'http:': new http.Agent({ keepAlive: true, lookup: publicOnlyLookup }),
  'https:': new https.Agent({ keepAlive: true, lookup: publicOnlyLookup }),
};

/**
 * Sends a GET request and follows redirects. Resolves with the response whose
 * body has not been consumed yet, plus the final URL after redirects.
 *
 * `blockPrivate` refuses internal addresses at every hop. `cookieHost` sends
 * the Cookie header only to that host, so redirects to other hosts do not
 * receive the user's session.
 */
function request(url, { headers = {}, signal, method = 'GET', blockPrivate = false, cookieHost = null } = {}) {
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

      if (blockPrivate && isPrivateAddress(parsed.hostname)) {
        reject(new HttpError(`Endereço interno bloqueado: ${parsed.hostname}`, { code: 'BLOCKED_ADDRESS' }));
        return;
      }
      let hopHeaders = headers;
      if (cookieHost && parsed.hostname.toLowerCase() !== cookieHost.toLowerCase()) {
        hopHeaders = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'cookie'));
      }

      const req = transport.request(parsed, {
        method,
        headers: hopHeaders,
        signal,
        agent: blockPrivate ? guardedAgents[parsed.protocol] : undefined,
      });
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

/** Reads a whole (small) response body, refusing anything above maxBytes. */
async function fetchBody(url, { maxBytes = 20 * 1024 * 1024, ...options } = {}) {
  const { res, finalUrl } = await request(url, options);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of res) {
      size += chunk.length;
      if (size > maxBytes) throw new HttpError('Resposta maior que o permitido', { code: 'TOO_LARGE' });
      chunks.push(chunk);
    }
  } finally {
    res.destroy();
  }
  return { body: Buffer.concat(chunks), finalUrl, headers: res.headers, status: res.statusCode };
}

module.exports = { request, fetchBody, parseContentRange, isPrivateAddress, HttpError };
