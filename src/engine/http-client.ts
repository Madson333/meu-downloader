import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders } from 'node:http';

const MAX_REDIRECTS = 10;
const IDLE_TIMEOUT_MS = 30_000;

export class HttpError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly code: string | null;

  constructor(message: string, { status = null, retryable = false, code = null }: {
    status?: number | null;
    retryable?: boolean;
    code?: string | null;
  } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Loopback, private, link-local, CGNAT, multicast and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  const addr = String(ip).replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(addr)) {
    const [a = 0, b = 0] = addr.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (!net.isIPv6(addr)) return false;
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (dotted?.[1]) return isPrivateAddress(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (hex?.[1] && hex[2]) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return addr === '::' || addr === '::1' || /^f[cd]/.test(addr) || /^fe[89ab]/.test(addr) || /^ff/.test(addr);
}

/** DNS lookup that refuses internal addresses, so redirects and DNS rebinding cannot reach them. */
const publicOnlyLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '');
      return;
    }
    if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
      // Its code is always set here, so it fits ErrnoException (whose code cannot be null).
      const blocked = new HttpError(`Endereço interno bloqueado: ${hostname}`, { code: 'BLOCKED_ADDRESS' });
      callback(blocked as HttpError & NodeJS.ErrnoException, '');
      return;
    }
    const [first] = addresses as [dns.LookupAddress];
    if (options.all) callback(null, addresses);
    else callback(null, first.address, first.family);
  });
};

// Guarded requests get their own connection pools: a keep-alive socket opened
// by an unguarded request skips the DNS check and must never be reused here.
const guardedAgents: Record<string, http.Agent> = {
  'http:': new http.Agent({ keepAlive: true, lookup: publicOnlyLookup }),
  'https:': new https.Agent({ keepAlive: true, lookup: publicOnlyLookup }),
};

export interface RequestOptions {
  headers?: OutgoingHttpHeaders;
  signal?: AbortSignal;
  method?: string;
  /** Refuse internal addresses at every hop. */
  blockPrivate?: boolean;
  /** Send the Cookie header only to this host, so redirects elsewhere do not receive the session. */
  cookieHost?: string | null;
}

export interface Response {
  res: IncomingMessage;
  finalUrl: string;
}

/**
 * Sends a GET request and follows redirects. Resolves with the response whose
 * body has not been consumed yet, plus the final URL after redirects.
 */
export function request(url: string, {
  headers = {}, signal, method = 'GET', blockPrivate = false, cookieHost = null,
}: RequestOptions = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    let redirects = 0;

    const send = (target: string): void => {
      let parsed: URL;
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
        ...(signal ? { signal } : {}),
        ...(blockPrivate ? { agent: guardedAgents[parsed.protocol] } : {}),
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
        const status = res.statusCode ?? 0;
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

export interface ContentRange {
  start: number;
  end: number;
  total: number | null;
}

/** Parses "bytes start-end/total"; total may be "*". */
export function parseContentRange(value: string | undefined): ContentRange | null {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec((value ?? '').trim());
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? null : Number(match[3]),
  };
}

export interface Body {
  body: Buffer;
  finalUrl: string;
  headers: IncomingHttpHeaders;
  status: number;
}

/** Reads a whole (small) response body, refusing anything above maxBytes. */
export async function fetchBody(url: string, { maxBytes = 20 * 1024 * 1024, ...options }: RequestOptions & {
  maxBytes?: number;
} = {}): Promise<Body> {
  const { res, finalUrl } = await request(url, options);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of res as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > maxBytes) throw new HttpError('Resposta maior que o permitido', { code: 'TOO_LARGE' });
      chunks.push(chunk);
    }
  } finally {
    res.destroy();
  }
  return { body: Buffer.concat(chunks), finalUrl, headers: res.headers, status: res.statusCode ?? 0 };
}
