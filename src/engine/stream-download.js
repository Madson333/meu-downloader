'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { request, fetchBody, isPrivateAddress, HttpError } = require('./http-client');
const { sanitize, uniquePath } = require('./file-name');
const {
  ManifestError, parseManifest, parseHls, selectVideo, selectDashAudio, pickDefault, describeVideo, isProtectedMp4,
} = require('./manifest');
const { remux, probeStreams } = require('./ffmpeg');

const MAX_ATTEMPTS = 6;
const TEMP_SUFFIX = '.mdstream';
const MAX_SUBTITLES = 20;
const GENERIC_NAME = /^(master|index|playlist|manifest|stream|main|video|audio|media|chunklist.*|prog_index|hls|dash|output|default)$/i;
const NATIVE_EXT = { ts: 'ts', mp4: 'mp4', webm: 'webm', aac: 'aac', mp3: 'mp3', ac3: 'ac3', eac3: 'eac3', vtt: 'vtt' };

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(signal.reason);
  }, { once: true });
});

/** A readable file name for a manifest URL such as .../my-show/ep1/master.m3u8 → "ep1". */
function streamBaseName(url, suggested = null) {
  if (suggested) return sanitize(String(suggested).replace(/\.(m3u8|mpd|mp4|mkv|ts|m4a|mka)$/i, ''));
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean).map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
    for (let i = parts.length - 1; i >= 0; i--) {
      const name = parts[i].replace(/\.[a-z0-9]{1,5}$/i, '');
      if (name && !GENERIC_NAME.test(name)) return sanitize(name);
    }
    return sanitize(parsed.hostname);
  } catch {
    return 'video';
  }
}

function containerOf(media, type) {
  if (media.map) return 'mp4';
  const first = media.segments[0]?.url ?? '';
  const ext = (/\.([a-z0-9]{2,5})$/i.exec(new URL(first).pathname)?.[1] ?? '').toLowerCase();
  if (ext === 'ts' || ext === 'm2ts' || ext === 'mts') return 'ts';
  if (ext === 'vtt' || ext === 'webvtt') return 'vtt';
  if (['aac', 'mp3', 'ac3'].includes(ext)) return ext;
  if (ext === 'ec3') return 'eac3';
  if (/^(m4s|mp4|m4a|m4v|cmf[av])$/.test(ext)) return 'mp4';
  return type === 'subtitle' ? 'vtt' : 'ts';
}

function dashContainer(rep) {
  const mime = String(rep.mimeType ?? '');
  if (mime.includes('webm')) return 'webm';
  if (mime === 'text/vtt' || /\.vtt$/i.test(rep.segments[0]?.url ?? '')) return 'vtt';
  return 'mp4';
}

function withoutQuery(url) {
  const u = new URL(url);
  return u.origin + u.pathname;
}

function friendlyError(err) {
  if (err?.code === 'ENOSPC') return 'Sem espaço em disco';
  if (err?.code === 'EACCES' || err?.code === 'EPERM') return 'Sem permissão para gravar na pasta de destino';
  if (err?.code === 'ENOENT' && err?.syscall === 'spawn') return 'FFmpeg não encontrado na pasta bin do app';
  return err?.message || String(err);
}

/**
 * Downloads an HLS or DASH video-on-demand stream: reads the manifest, picks
 * the tracks, fetches every segment in parallel, joins the segments of each
 * track and remuxes them with FFmpeg (stream copy, no re-encoding).
 *
 * Same surface as SegmentedDownload, so the manager treats it alike.
 * Segments live in "<id>.mdstream/" next to the final file. A segment file
 * only appears there after it was fully received, so resuming keeps every
 * finished segment. The manifest is read again on every start: its URLs may
 * carry expiring tokens, and a fingerprint of the segment list tells whether
 * it still describes the same content.
 */
class StreamDownload extends EventEmitter {
  constructor(state, { limiter, getMaxConnections, tools = null, isPathTaken = () => false }) {
    super();
    this.state = {
      status: 'queued',
      quality: 'best',
      totalSize: null,
      error: null,
      notices: [],
      chunks: { done: 0, total: 0 },
      downloadedBytes: 0,
      ...state,
      kind: 'stream',
    };
    this.limiter = limiter;
    this.getMaxConnections = getMaxConnections;
    this.tools = tools;
    this.isPathTaken = isPathTaken;
    this.controller = null;
    this.running = null;
    this.active = 0;
    this.doneBytes = null;
    this.inflightBytes = 0;
    this.keys = new Map();
  }

  get downloaded() {
    return this.doneBytes === null ? (this.state.downloadedBytes ?? 0) : this.doneBytes + this.inflightBytes;
  }

  get activeConnections() {
    return this.active;
  }

  get tempDir() {
    return path.join(this.state.dir, `${this.state.id}${TEMP_SUFFIX}`);
  }

  #setStatus(status, error = null, errorCode = null) {
    this.state.status = status;
    this.state.error = error;
    this.state.errorCode = errorCode;
    if (status !== 'downloading') this.state.phase = null;
    this.emit('change', this);
  }

  #phase(text) {
    this.state.phase = text;
    this.emit('change', this);
  }

  #headers(extra = {}) {
    const h = this.state.headers ?? {};
    const headers = {
      'User-Agent': h.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      ...extra,
    };
    if (h.referrer) headers.Referer = h.referrer;
    if (h.cookie) headers.Cookie = h.cookie;
    return headers;
  }

  /** Options shared by every request after the manifest. */
  #net(extraHeaders = {}) {
    return {
      headers: this.#headers(extraHeaders),
      signal: this.controller.signal,
      // Cookies only go to the host the user gave; CDNs never see the session.
      cookieHost: new URL(this.state.url).hostname,
      // A public manifest must not steer requests to the user's own network.
      blockPrivate: !this.allowPrivate,
    };
  }

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
    await fs.promises.rm(this.tempDir, { recursive: true, force: true });
  }

  async #run() {
    this.pauseRequested = false;
    try {
      const plan = await this.#plan();
      await this.#prepare(plan);
      await this.#downloadSegments(plan);
      await this.#assemble(plan);
      await this.#finish(plan);
    } catch (err) {
      this.active = 0;
      this.inflightBytes = 0;
      this.state.downloadedBytes = this.downloaded;
      if (this.pauseRequested) this.#setStatus('paused');
      else this.#setStatus('error', friendlyError(err), err?.code ?? null);
    }
  }

  // ---------------------------------------------------------------- planning

  async #plan() {
    this.#phase('Lendo o manifesto…');
    const host = new URL(this.state.url).hostname;
    this.allowPrivate = isPrivateAddress(host) || host === 'localhost'
      || await dns.promises.lookup(host, { all: true })
        .then((list) => list.some((a) => isPrivateAddress(a.address)), () => false);

    const { body, finalUrl } = await fetchBody(this.state.url, {
      headers: this.#headers(),
      signal: this.controller.signal,
      cookieHost: host,
    });
    const manifest = parseManifest(body.toString('utf8'), finalUrl);
    const notices = [];
    const plan = manifest.protocol === 'hls'
      ? await this.#planHls(manifest, notices)
      : this.#planDash(manifest, notices);

    plan.audioOnly = this.state.quality === 'audio';
    plan.fingerprint = crypto.createHash('sha1').update(JSON.stringify(plan.tracks.map((t) => [
      t.type, t.container, t.init && [withoutQuery(t.init.url), t.init.range],
      t.segments.map((s) => [withoutQuery(s.url), s.range?.offset, s.range?.length]),
    ]))).digest('hex');

    this.state.protocol = manifest.protocol;
    this.state.selection = plan.selection;
    this.state.notices = notices;
    this.state.fileName = this.state.filePath ? this.state.fileName : streamBaseName(this.state.url, this.state.suggestedName);
    this.state.chunks = {
      done: 0,
      total: plan.tracks.reduce((sum, t) => sum + t.segments.length + (t.init ? 1 : 0), 0),
    };
    return plan;
  }

  async #mediaPlaylist(url, type, meta = {}) {
    const { body, finalUrl } = await fetchBody(url, this.#net());
    const media = parseHls(body.toString('utf8'), finalUrl);
    if (media.kind !== 'media') throw new ManifestError('Playlist de variante inválida (outra playlist principal)');
    if (media.live) throw new ManifestError('Transmissões ao vivo não são suportadas; apenas vídeos sob demanda (VOD)', 'LIVE');
    if (!media.segments.length) throw new ManifestError('Playlist sem segmentos');
    return { type, ...meta, container: containerOf(media, type), init: media.map, segments: media.segments };
  }

  async #planHls(manifest, notices) {
    const quality = this.state.quality;
    if (manifest.kind === 'media') {
      if (manifest.live) throw new ManifestError('Transmissões ao vivo não são suportadas; apenas vídeos sob demanda (VOD)', 'LIVE');
      if (!manifest.segments.length) throw new ManifestError('Playlist sem segmentos');
      if (/^\d+$/.test(quality)) notices.push('A playlist tem uma única qualidade; a qualidade escolhida não se aplica');
      if (quality === 'audio') notices.push('A playlist não separa o áudio; ele será extraído do vídeo');
      const track = { type: 'main', container: containerOf(manifest, 'main'), init: manifest.map, segments: manifest.segments };
      return { tracks: [track], extractAudio: quality === 'audio', selection: { video: 'qualidade única' } };
    }

    const videoVariants = manifest.variants.filter((v) => v.hasVideo);
    const audioVariants = manifest.variants.filter((v) => !v.hasVideo);
    const audioRenditions = manifest.renditions.filter((r) => r.type === 'audio' && r.uri);
    const describeAudio = (r) => [r.name, r.language].filter(Boolean).join(' · ') || 'padrão';
    const tracks = [];
    const selection = {};

    if (quality === 'audio') {
      const reference = selectVideo(videoVariants.length ? videoVariants : manifest.variants, 'best').variant;
      const sameGroup = audioRenditions.filter((r) => r.groupId === reference.audio);
      const rendition = pickDefault(sameGroup.length ? sameGroup : audioRenditions);
      if (rendition) {
        tracks.push(await this.#mediaPlaylist(rendition.uri, 'audio', { language: rendition.language, label: rendition.name }));
        selection.audio = describeAudio(rendition);
      } else if (audioVariants.length) {
        const best = [...audioVariants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
        tracks.push(await this.#mediaPlaylist(best.uri, 'audio'));
        selection.audio = best.bandwidth ? `${Math.round(best.bandwidth / 1000)} kbps` : 'padrão';
      } else {
        const smallest = [...videoVariants].sort((a, b) => a.bandwidth - b.bandwidth)[0];
        notices.push('A fonte não oferece uma faixa só de áudio; o áudio será extraído da menor variante de vídeo');
        tracks.push(await this.#mediaPlaylist(smallest.uri, 'main'));
        selection.audio = 'extraído do vídeo';
        return { tracks, extractAudio: true, selection };
      }
      return { tracks, extractAudio: false, selection };
    }

    const { variant, notice } = selectVideo(videoVariants.length ? videoVariants : manifest.variants, quality);
    if (notice) notices.push(notice);
    selection.video = describeVideo(variant);
    const rendition = pickDefault(manifest.renditions.filter((r) => r.type === 'audio' && r.groupId === variant.audio));
    if (rendition?.uri) {
      tracks.push(await this.#mediaPlaylist(variant.uri, 'video'));
      tracks.push(await this.#mediaPlaylist(rendition.uri, 'audio', { language: rendition.language, label: rendition.name }));
      selection.audio = describeAudio(rendition);
    } else {
      tracks.push(await this.#mediaPlaylist(variant.uri, 'main'));
    }

    const subtitles = variant.subtitles
      ? manifest.renditions.filter((r) => r.type === 'subtitles' && r.uri && r.groupId === variant.subtitles)
      : [];
    selection.subtitles = [];
    for (const sub of subtitles.slice(0, MAX_SUBTITLES)) {
      const name = sub.name || sub.language || 'legenda';
      try {
        const track = await this.#mediaPlaylist(sub.uri, 'subtitle', { language: sub.language, label: sub.name });
        if (track.container !== 'vtt' || track.init) {
          notices.push(`Legenda "${name}" ignorada: formato não suportado (apenas WebVTT)`);
          continue;
        }
        tracks.push(track);
        selection.subtitles.push(name);
      } catch (err) {
        if (this.controller.signal.aborted) throw err;
        notices.push(`Legenda "${name}" ignorada: ${err.message}`);
      }
    }
    return { tracks, extractAudio: false, selection };
  }

  #planDash(manifest, notices) {
    const quality = this.state.quality;
    const track = (type, rep) => ({
      type,
      language: rep.language,
      label: rep.label,
      container: dashContainer(rep),
      init: rep.init,
      segments: rep.segments,
    });
    const tracks = [];
    const selection = {};
    const audio = selectDashAudio(manifest.audio);
    const describeAudio = (rep) => [rep.label, rep.language, rep.bandwidth && `${Math.round(rep.bandwidth / 1000)} kbps`]
      .filter(Boolean).join(' · ');

    if (quality === 'audio' || !manifest.video.length) {
      if (!audio) throw new ManifestError('O manifesto não oferece uma faixa de áudio separada', 'UNSUPPORTED');
      if (quality !== 'audio') notices.push('O manifesto só tem áudio');
      tracks.push(track('audio', audio));
      selection.audio = describeAudio(audio);
      return { tracks, extractAudio: false, selection };
    }

    const { variant, notice } = selectVideo(manifest.video, quality);
    if (notice) notices.push(notice);
    tracks.push(track('video', variant));
    selection.video = describeVideo(variant);
    if (audio) {
      tracks.push(track('audio', audio));
      selection.audio = describeAudio(audio);
    }

    selection.subtitles = [];
    const seen = new Set();
    for (const rep of manifest.subtitles) {
      if (seen.has(rep.adaptationIndex) || seen.size >= MAX_SUBTITLES) continue;
      seen.add(rep.adaptationIndex);
      const name = rep.label || rep.language || 'legenda';
      if (dashContainer(rep) !== 'vtt' || rep.init || rep.segments.length !== 1) {
        notices.push(`Legenda "${name}" ignorada: formato não suportado (apenas WebVTT em arquivo único)`);
        continue;
      }
      tracks.push(track('subtitle', rep));
      selection.subtitles.push(name);
    }
    return { tracks, extractAudio: false, selection };
  }

  // ---------------------------------------------------------------- files

  #segPath(trackIndex, index) {
    return path.join(this.tempDir, `t${trackIndex}-${index < 0 ? 'init' : String(index).padStart(6, '0')}.seg`);
  }

  #trackPath(trackIndex, track) {
    return path.join(this.tempDir, `t${trackIndex}.${NATIVE_EXT[track.container] ?? 'bin'}`);
  }

  /** Checks the temporary folder against the plan and counts what is already done. */
  async #prepare(plan) {
    const dir = this.tempDir;
    if (this.state.fingerprint && this.state.fingerprint !== plan.fingerprint && fs.existsSync(dir)) {
      await this.discardTemp();
      plan.restarted = true;
      this.state.notices.push('O conteúdo do manifesto mudou desde a última sessão; o download recomeçou do início');
    }
    this.state.fingerprint = plan.fingerprint;
    await fs.promises.mkdir(dir, { recursive: true });
    const present = new Set(await fs.promises.readdir(dir));

    this.doneBytes = 0;
    plan.pending = [];
    for (const [ti, track] of plan.tracks.entries()) {
      track.stats = { bytes: 0, count: 0 };
      const assembled = this.#trackPath(ti, track);
      if (present.has(path.basename(assembled))) {
        track.assembled = true;
        track.assembledSize = (await fs.promises.stat(assembled)).size;
        this.doneBytes += track.assembledSize;
        this.state.chunks.done += track.segments.length + (track.init ? 1 : 0);
        continue;
      }
      const items = track.init ? [-1, ...track.segments.keys()] : [...track.segments.keys()];
      for (const index of items) {
        const file = this.#segPath(ti, index);
        const seg = index < 0 ? track.init : track.segments[index];
        if (present.has(path.basename(file))) {
          const { size } = await fs.promises.stat(file);
          // A ranged, unencrypted segment must have exactly the requested size.
          if (!(seg.range && !seg.key && size !== seg.range.length)) {
            this.#countDone(track, size);
            continue;
          }
          await fs.promises.rm(file, { force: true });
        }
        plan.pending.push({ track: ti, index });
      }
    }
    // Interleave tracks so video and audio advance together.
    plan.pending.sort((a, b) => a.index - b.index || a.track - b.track);
    this.#updateEstimate(plan);
  }

  #countDone(track, size) {
    track.stats.bytes += size;
    track.stats.count++;
    this.doneBytes += size;
    this.state.chunks.done++;
  }

  /** Total size: exact for byte-range tracks, otherwise extrapolated from finished segments. */
  #updateEstimate(plan) {
    let total = 0;
    let exact = true;
    for (const track of plan.tracks) {
      if (track.assembled) {
        total += track.assembledSize;
        continue;
      }
      const parts = [...(track.init ? [track.init] : []), ...track.segments];
      if (parts.every((s) => s.range && !s.key)) {
        total += parts.reduce((sum, s) => sum + s.range.length, 0);
        continue;
      }
      if (!track.stats.count) {
        this.state.totalSize = null;
        return;
      }
      if (track.stats.count < parts.length) exact = false;
      total += track.stats.bytes + (track.stats.bytes / track.stats.count) * (parts.length - track.stats.count);
    }
    this.state.totalSize = Math.round(total);
    this.state.sizeEstimated = !exact;
  }

  // ---------------------------------------------------------------- download

  async #downloadSegments(plan) {
    if (!plan.pending.length) return;
    this.#phase(null);
    const queue = [...plan.pending];
    let failure = null;
    const worker = async () => {
      while (queue.length && !failure) {
        const item = queue.shift();
        try {
          await this.#fetchSegment(plan, item);
        } catch (err) {
          if (!failure) {
            failure = err;
            this.controller.abort(err);
          }
        }
      }
    };
    const count = Math.max(1, Math.min(this.getMaxConnections(), queue.length));
    await Promise.all(Array.from({ length: count }, worker));
    if (failure) throw this.controller.signal.reason ?? failure;
  }

  async #key(uri) {
    if (!this.keys.has(uri)) {
      const pending = fetchBody(uri, { ...this.#net(), maxBytes: 1024 }).then(({ body }) => {
        if (body.length !== 16) throw new HttpError('A chave AES-128 do manifesto é inválida');
        return body;
      }, (err) => {
        if (err.status === 401 || err.status === 403) {
          throw new HttpError(`O servidor recusou a chave de descriptografia (HTTP ${err.status}); o conteúdo exige autorização`);
        }
        throw err;
      });
      pending.catch(() => this.keys.delete(uri));
      this.keys.set(uri, pending);
    }
    return this.keys.get(uri);
  }

  async #fetchSegment(plan, { track: ti, index }) {
    const track = plan.tracks[ti];
    const seg = index < 0 ? track.init : track.segments[index];
    const file = this.#segPath(ti, index);
    const signal = this.controller.signal;
    const label = index < 0 ? 'de inicialização' : `${index + 1} de ${track.segments.length}`;

    for (let attempt = 1; ; attempt++) {
      let received = 0;
      try {
        const extra = seg.range ? { Range: `bytes=${seg.range.offset}-${seg.range.offset + seg.range.length - 1}` } : {};
        const { res } = await request(seg.url, this.#net(extra));
        this.active++;
        let written = 0;
        try {
          if (seg.range && res.statusCode !== 206) {
            throw new HttpError('O servidor não respeitou o intervalo de bytes do segmento');
          }
          if (/^text\/html/i.test(String(res.headers['content-type'] ?? ''))) {
            throw new HttpError('O servidor devolveu uma página web em vez do segmento');
          }
          const expected = res.headers['content-length'] !== undefined ? Number(res.headers['content-length']) : null;
          const decipher = seg.key
            ? crypto.createDecipheriv('aes-128-cbc', await this.#key(seg.key.uri), Buffer.from(seg.key.iv, 'hex'))
            : null;
          const out = await fs.promises.open(`${file}.part`, 'w');
          try {
            for await (const chunk of res) {
              await this.limiter.take(chunk.length, signal);
              received += chunk.length;
              this.inflightBytes += chunk.length;
              const data = decipher ? decipher.update(chunk) : chunk;
              if (data.length) await out.write(data);
              written += data.length;
            }
            if (expected !== null && received !== expected) {
              throw new HttpError('Segmento incompleto', { retryable: true });
            }
            if (seg.range && received !== seg.range.length) {
              throw new HttpError('Segmento com tamanho diferente do intervalo pedido', { retryable: true });
            }
            if (decipher) {
              let tail;
              try {
                tail = decipher.final();
              } catch {
                throw new HttpError('Falha ao descriptografar o segmento (chave AES-128 incorreta?)');
              }
              await out.write(tail);
              written += tail.length;
            }
          } finally {
            await out.close();
          }
        } finally {
          this.active--;
          res.destroy();
        }
        await fs.promises.rename(`${file}.part`, file);
        this.inflightBytes -= received;
        if (index < 0 || (index === 0 && !track.init && track.container === 'mp4')) await this.#checkProtection(file);
        this.#countDone(track, written);
        this.#updateEstimate(plan);
        return;
      } catch (err) {
        this.inflightBytes -= received;
        if (signal.aborted) throw signal.reason ?? err;
        const retryable = err.retryable || err.code === 'ECONNRESET' || err.code === 'EPIPE';
        if (!retryable || attempt >= MAX_ATTEMPTS) {
          const what = track.type === 'subtitle' ? 'Legenda' : 'Segmento';
          const wrapped = new Error(`${what} ${label}: ${friendlyError(err)}`);
          wrapped.code = err.code;
          throw wrapped;
        }
        await sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)), signal);
      }
    }
  }

  /** Refuses MP4 data that declares encryption even when the manifest did not. */
  async #checkProtection(file) {
    const handle = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.alloc(4 * 1024 * 1024);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      if (isProtectedMp4(buf.subarray(0, bytesRead))) {
        throw new ManifestError('A mídia é criptografada com DRM (CENC). O Meu Downloader não baixa mídia com DRM.', 'DRM');
      }
    } finally {
      await handle.close();
    }
  }

  // ---------------------------------------------------------------- assembly

  async #ensureSpace(bytes) {
    if (!fs.promises.statfs) return;
    const stats = await fs.promises.statfs(this.state.dir).catch(() => null);
    if (stats && stats.bavail * stats.bsize < bytes) {
      const err = new Error('Sem espaço em disco para juntar os segmentos');
      err.code = 'ENOSPC';
      throw err;
    }
  }

  /** Joins each track's segments, in order, into one file, then deletes the segments. */
  async #assemble(plan) {
    const signal = this.controller.signal;
    const todo = plan.tracks.map((t, i) => [t, i]).filter(([t]) => !t.assembled);
    if (!todo.length) return;
    this.#phase('Juntando segmentos…');
    await this.#ensureSpace(todo.reduce((sum, [t]) => sum + t.stats.bytes, 0));
    for (const [track, ti] of todo) {
      const target = this.#trackPath(ti, track);
      const files = [...(track.init ? [this.#segPath(ti, -1)] : []), ...track.segments.map((_, i) => this.#segPath(ti, i))];
      const out = await fs.promises.open(`${target}.part`, 'w');
      try {
        for (const [n, file] of files.entries()) {
          if (signal.aborted) throw signal.reason;
          if (track.container === 'vtt') {
            let text = await fs.promises.readFile(file, 'utf8');
            // Later WebVTT segments repeat the header; keep only their cues.
            if (n > 0) text = text.replace(/^﻿?WEBVTT[^]*?(\r?\n){2}/, '');
            await out.write(`${text.replace(/\s+$/, '')}\n\n`);
            continue;
          }
          for await (const chunk of fs.createReadStream(file)) await out.write(chunk);
        }
      } finally {
        await out.close();
      }
      await fs.promises.rename(`${target}.part`, target);
      track.assembled = true;
      track.assembledSize = (await fs.promises.stat(target)).size;
      await Promise.all(files.map((f) => fs.promises.rm(f, { force: true })));
    }
  }

  // ---------------------------------------------------------------- output

  async #finish(plan) {
    const signal = this.controller.signal;
    const media = plan.tracks.map((t, i) => [t, i]).filter(([t]) => t.type !== 'subtitle');
    const subtitles = plan.tracks.map((t, i) => [t, i]).filter(([t]) => t.type === 'subtitle');
    const base = streamBaseName(this.state.url, this.state.suggestedName);
    let output;
    let ext;

    if (this.tools?.ffmpeg) {
      this.#phase(media.length > 1 ? 'Juntando áudio e vídeo (FFmpeg)…' : 'Finalizando com FFmpeg…');
      await this.#ensureSpace(media.reduce((sum, [t]) => sum + t.assembledSize, 0));
      const inputs = media.map(([t, i]) => ({
        file: this.#trackPath(i, t),
        maps: t.type === 'video' ? ['v'] : t.type === 'audio' ? ['a'] : plan.audioOnly ? ['a'] : ['v?', 'a?'],
      }));
      // MP4 first; Matroska accepts codecs MP4 cannot hold.
      const formats = plan.audioOnly ? [['m4a', 'mp4'], ['mka', 'matroska']] : [['mp4', 'mp4'], ['mkv', 'matroska']];
      let lastError = null;
      for (const [candidateExt, format] of formats) {
        const candidate = path.join(this.tempDir, `output.${candidateExt}`);
        try {
          await remux({ ffmpeg: this.tools.ffmpeg, inputs, output: candidate, format, signal });
          output = candidate;
          ext = candidateExt;
          break;
        } catch (err) {
          if (signal.aborted) throw signal.reason;
          lastError = err;
          await fs.promises.rm(candidate, { force: true });
        }
      }
      if (!output) throw lastError;
    } else {
      if (media.length > 1) throw new Error('FFmpeg não encontrado: ele é necessário para juntar áudio e vídeo');
      if (plan.extractAudio) throw new Error('FFmpeg não encontrado: ele é necessário para extrair o áudio');
      const [track, ti] = media[0];
      output = this.#trackPath(ti, track);
      ext = track.container === 'mp4' && track.type === 'audio' ? 'm4a' : NATIVE_EXT[track.container] ?? 'bin';
      this.state.notices.push(`FFmpeg não encontrado; o vídeo foi salvo no formato original (.${ext})`);
    }

    // Never report success before the final file is checked.
    this.#phase('Verificando o arquivo final…');
    const { size } = await fs.promises.stat(output);
    if (size === 0) throw new Error('O arquivo final ficou vazio');
    if (this.tools?.ffprobe) {
      const streams = await probeStreams({ ffprobe: this.tools.ffprobe, file: output, signal });
      const has = (type) => streams.some((s) => s.codec_type === type);
      if (!streams.length) throw new Error('O arquivo final não tem faixas de mídia');
      if (plan.audioOnly && !has('audio')) throw new Error('O arquivo final não tem áudio');
      if (media.some(([t]) => t.type === 'video') && !has('video')) throw new Error('O arquivo final não tem vídeo');
    }

    const target = uniquePath(this.state.dir, `${base}.${ext}`, this.isPathTaken);
    await fs.promises.rename(output, target);
    const stem = target.slice(0, -(ext.length + 1));
    for (const [n, [track, ti]] of subtitles.entries()) {
      const lang = sanitize(track.language || track.label || `legenda${n + 1}`);
      const name = path.basename(uniquePath(this.state.dir, `${path.basename(stem)}.${lang}.vtt`, this.isPathTaken));
      await fs.promises.rename(this.#trackPath(ti, track), path.join(this.state.dir, name));
    }
    await this.discardTemp();

    this.state.filePath = target;
    this.state.fileName = path.basename(target);
    this.state.totalSize = size;
    this.state.sizeEstimated = false;
    this.doneBytes = size;
    this.inflightBytes = 0;
    this.state.downloadedBytes = size;
    this.state.completedAt = Date.now();
    this.#setStatus('completed');
  }

  toJSON() {
    const { status, ...rest } = this.state;
    return {
      ...rest,
      status: status === 'downloading' ? 'paused' : status,
      phase: null,
      downloadedBytes: this.downloaded,
      segments: [],
    };
  }
}

module.exports = { StreamDownload, streamBaseName, TEMP_SUFFIX };
