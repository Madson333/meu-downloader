'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { request, parseContentRange, HttpError } = require('./http-client');
const { chooseFileName, uniquePath } = require('./file-name');

const MAX_ATTEMPTS = 6;
const TEMP_SUFFIX = '.mdpart';

class RestartRequired extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'RestartRequired';
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(signal.reason);
  }, { once: true });
});

/**
 * One download split across several HTTP connections.
 *
 * Each segment covers [start, end] (inclusive) and `pos` is the first byte not
 * yet written. A connection downloads its segment until it reaches `end`; when
 * it finishes, it takes over the second half of the largest remaining segment
 * by shrinking that segment's `end`. The other connection notices the new
 * `end` on its next chunk and stops there, so the file is re-divided while it
 * downloads. `end === null` means the size is unknown (single connection).
 */
class SegmentedDownload extends EventEmitter {
  constructor(state, { limiter, getMaxConnections, minSplitBytes = 512 * 1024, isPathTaken = () => false }) {
    super();
    this.state = {
      status: 'queued',
      segments: [],
      totalSize: null,
      resumable: false,
      validator: null,
      error: null,
      ...state,
    };
    this.limiter = limiter;
    this.getMaxConnections = getMaxConnections;
    this.minSplitBytes = minSplitBytes;
    this.isPathTaken = isPathTaken;
    this.controller = null;
    this.file = null;
    this.running = null;
  }

  get tempPath() {
    return this.state.filePath + TEMP_SUFFIX;
  }

  get downloaded() {
    return this.state.segments.reduce((sum, s) => sum + (s.pos - s.start), 0);
  }

  get activeConnections() {
    return this.state.segments.filter((s) => s.active).length;
  }

  #setStatus(status, error = null, errorCode = null) {
    this.state.status = status;
    this.state.error = error;
    this.state.errorCode = errorCode;
    this.emit('change', this);
  }

  #headers(extra = {}) {
    const h = this.state.headers ?? {};
    const headers = {
      'User-Agent': h.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Accept: '*/*',
      // Compressed bodies cannot be split by byte ranges.
      'Accept-Encoding': 'identity',
      ...extra,
    };
    if (h.referrer) headers.Referer = h.referrer;
    if (h.cookie) headers.Cookie = h.cookie;
    return headers;
  }

  /** Starts or resumes the download. Resolves when it completes, pauses or fails. */
  start() {
    if (this.running) return this.running;
    this.controller = new AbortController();
    this.#setStatus('downloading');
    this.running = this.#run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async pause() {
    if (!this.running) {
      if (this.state.status !== 'completed') this.#setStatus('paused');
      return;
    }
    this.pauseRequested = true;
    this.controller.abort(new Error('paused'));
    await this.running;
  }

  async discardTemp() {
    if (this.state.filePath) await fs.promises.rm(this.tempPath, { force: true });
  }

  async #run() {
    this.pauseRequested = false;
    try {
      for (let restarts = 0; ; restarts++) {
        try {
          if (this.#canResume()) await this.#resume();
          else await this.#fresh();
          break;
        } catch (err) {
          if (!(err instanceof RestartRequired) || restarts >= 1 || this.pauseRequested) throw err;
          await this.#closeFile();
          await this.discardTemp();
          this.state.segments = [];
          // The failed attempt aborted its controller to stop sibling connections.
          this.controller = new AbortController();
        }
      }
      await this.#finish();
    } catch (err) {
      for (const s of this.state.segments) s.active = false;
      await this.#closeFile();
      if (this.pauseRequested) this.#setStatus('paused');
      else this.#setStatus('error', err.message || String(err), err.code ?? null);
    }
  }

  #canResume() {
    return this.state.resumable
      && this.state.segments.length > 0
      && this.state.filePath
      && fs.existsSync(this.tempPath);
  }

  async #fresh() {
    const signal = this.controller.signal;
    const { res, finalUrl } = await request(this.state.url, {
      headers: this.#headers({ Range: 'bytes=0-' }),
      signal,
    });

    // A web page in response to a link that does not name an HTML file means the
    // link opens a page (e.g. a video site), not a downloadable file.
    const mime = String(res.headers['content-type'] ?? '').toLowerCase();
    if (mime.startsWith('text/html') && !/\.x?html?$/i.test(new URL(finalUrl).pathname)) {
      res.destroy();
      throw new HttpError('O link abre uma página web, não um arquivo. Copie o link direto do arquivo.', { code: 'HTML_PAGE' });
    }

    let total = null;
    if (res.statusCode === 206) {
      const range = parseContentRange(res.headers['content-range']);
      if (!range || range.start !== 0) {
        res.destroy();
        throw new HttpError('Resposta parcial inesperada do servidor');
      }
      total = range.total;
      this.state.resumable = total !== null;
    } else {
      const length = Number(res.headers['content-length']);
      total = Number.isFinite(length) && res.headers['content-length'] !== undefined ? length : null;
      this.state.resumable = total !== null && /bytes/i.test(res.headers['accept-ranges'] ?? '');
    }
    this.state.finalUrl = finalUrl;
    this.state.totalSize = total;
    this.state.validator = {
      etag: res.headers.etag && !res.headers.etag.startsWith('W/') ? res.headers.etag : null,
      lastModified: res.headers['last-modified'] ?? null,
    };
    this.state.mime = res.headers['content-type'] ?? null;

    if (!this.state.filePath) {
      const name = chooseFileName({
        contentDisposition: res.headers['content-disposition'],
        finalUrl,
        originalUrl: this.state.url,
        suggested: this.state.suggestedName,
      });
      this.state.fileName = path.basename(uniquePath(this.state.dir, name, this.isPathTaken));
      this.state.filePath = path.join(this.state.dir, this.state.fileName);
      this.emit('change', this);
    }

    await fs.promises.mkdir(this.state.dir, { recursive: true });
    this.file = await fs.promises.open(this.tempPath, 'w');
    if (total !== null) await this.file.truncate(total);

    this.state.segments = [{ start: 0, end: total === null ? null : total - 1, pos: 0 }];
    await this.#runSegments(res);
  }

  async #resume() {
    const stat = await fs.promises.stat(this.tempPath);
    if (stat.size !== this.state.totalSize) throw new RestartRequired('arquivo temporário inconsistente');
    this.file = await fs.promises.open(this.tempPath, 'r+');
    await this.#runSegments(null);
  }

  /** Runs connections until every segment is complete. */
  #runSegments(initialResponse) {
    const segments = this.state.segments;
    return new Promise((resolve, reject) => {
      let failed = false;

      const launch = (segment, res) => {
        segment.active = true;
        segment.reserved = segment.pos;
        this.#downloadSegment(segment, res).then(() => {
          segment.active = false;
          if (failed) return;
          fill();
          if (segments.every((s) => !s.active)) {
            if (segments.every((s) => s.end !== null && s.pos > s.end)) resolve();
            else reject(new HttpError('Download interrompido antes do fim'));
          }
        }, (err) => {
          segment.active = false;
          if (failed) return;
          failed = true;
          this.controller.abort(err);
          reject(err);
        });
      };

      const fill = () => {
        while (this.activeConnections < Math.max(1, this.getMaxConnections())) {
          const idle = segments.find((s) => !s.active && (s.end === null || s.pos <= s.end));
          if (idle) {
            launch(idle, null);
            continue;
          }
          const split = this.#split();
          if (!split) break;
          launch(split, null);
        }
      };

      if (initialResponse) launch(segments[0], initialResponse);
      fill();
      if (segments.every((s) => !s.active)) resolve();
    });
  }

  /** Splits the largest active segment in half and returns the new tail segment. */
  #split() {
    if (!this.state.resumable) return null;
    let best = null;
    let bestRemaining = 0;
    for (const s of this.state.segments) {
      if (!s.active || s.end === null) continue;
      const remaining = s.end - s.reserved + 1;
      if (remaining > bestRemaining) {
        best = s;
        bestRemaining = remaining;
      }
    }
    if (!best || bestRemaining < 2 * this.minSplitBytes) return null;
    const newStart = best.reserved + Math.floor(bestRemaining / 2);
    const tail = { start: newStart, end: best.end, pos: newStart };
    best.end = newStart - 1;
    const segments = this.state.segments;
    segments.splice(segments.indexOf(best) + 1, 0, tail);
    return tail;
  }

  async #downloadSegment(segment, initialResponse) {
    const signal = this.controller.signal;
    let res = initialResponse;
    for (let attempt = 1; ; attempt++) {
      const posBefore = segment.pos;
      segment.reserved = segment.pos;
      try {
        if (!res) res = await this.#openRange(segment);
        await this.#pump(segment, res);
        res = null;
        if (segment.end === null) {
          // Unknown size: the stream ending means the file is complete.
          segment.end = segment.pos - 1;
          this.state.totalSize = segment.pos;
          return;
        }
        if (segment.pos > segment.end) return;
        throw new HttpError('Conexão encerrada antes do fim do segmento', { retryable: true });
      } catch (err) {
        res?.destroy();
        res = null;
        if (signal.aborted) throw signal.reason ?? err;
        const retryable = err.retryable || err.code === 'ECONNRESET' || err.code === 'EPIPE';
        if (!retryable || !this.state.resumable) throw err;
        // Only consecutive attempts without progress count toward the limit.
        if (segment.pos > posBefore) attempt = 1;
        else if (attempt >= MAX_ATTEMPTS) throw err;
        await sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)), signal);
      }
    }
  }

  async #openRange(segment) {
    const extra = { Range: `bytes=${segment.pos}-${segment.end}` };
    const validator = this.state.validator;
    const ifRange = validator?.etag || validator?.lastModified;
    if (ifRange) extra['If-Range'] = ifRange;

    const { res } = await request(this.state.finalUrl || this.state.url, {
      headers: this.#headers(extra),
      signal: this.controller.signal,
    });
    if (res.statusCode !== 206) {
      res.destroy();
      // A full 200 response to a ranged If-Range request means the file changed.
      throw new RestartRequired('o arquivo no servidor mudou ou não aceita retomada');
    }
    const range = parseContentRange(res.headers['content-range']);
    if (!range || range.start !== segment.pos) {
      res.destroy();
      throw new HttpError('O servidor devolveu um trecho diferente do pedido', { retryable: true });
    }
    return res;
  }

  async #pump(segment, res) {
    const signal = this.controller.signal;
    try {
      for await (const chunk of res) {
        // `end` can shrink at any time when another connection splits this segment.
        const remaining = segment.end === null ? chunk.length : segment.end - segment.reserved + 1;
        if (remaining <= 0) break;
        const piece = remaining < chunk.length ? chunk.subarray(0, remaining) : chunk;
        const at = segment.reserved;
        segment.reserved += piece.length;
        await this.limiter.take(piece.length, signal);
        await this.file.write(piece, 0, piece.length, at);
        segment.pos = at + piece.length;
        if (segment.end !== null && segment.pos > segment.end) break;
      }
    } finally {
      res.destroy();
    }
  }

  async #closeFile() {
    const file = this.file;
    this.file = null;
    await file?.close().catch(() => {});
  }

  async #finish() {
    await this.#closeFile();
    let target = this.state.filePath;
    if (fs.existsSync(target)) {
      target = uniquePath(this.state.dir, this.state.fileName, this.isPathTaken);
    }
    await fs.promises.rename(this.tempPath, target);
    this.state.filePath = target;
    this.state.fileName = path.basename(target);
    this.state.totalSize ??= this.downloaded;
    this.state.completedAt = Date.now();
    this.#setStatus('completed');
  }

  toJSON() {
    const { segments, ...rest } = this.state;
    return {
      ...rest,
      status: rest.status === 'downloading' ? 'paused' : rest.status,
      segments: segments.map(({ start, end, pos }) => ({ start, end, pos })),
    };
  }
}

module.exports = { SegmentedDownload, TEMP_SUFFIX };
