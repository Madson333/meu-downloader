'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { SegmentedDownload } = require('./segmented-download');
const { SpeedLimiter } = require('./speed-limiter');
const { VideoDownload, isVideoPageUrl, QUALITIES } = require('./video-download');
const { StreamDownload, streamBaseName } = require('./stream-download');
const { isManifestUrl } = require('./manifest');
const { sanitize } = require('./file-name');

const DEFAULT_SETTINGS = {
  downloadDir: '',
  maxConnections: 8,
  maxConcurrent: 3,
  speedLimitKBps: 0,
  captureEnabled: true,
  captureExtensions: [
    '7z', 'aac', 'apk', 'avi', 'bin', 'bz2', 'deb', 'dmg', 'docx', 'epub', 'exe', 'flac', 'gz', 'img',
    'iso', 'jar', 'm4a', 'm4v', 'mkv', 'mov', 'mp3', 'mp4', 'msi', 'msix', 'ogg', 'pdf', 'pptx', 'rar',
    'rpm', 'tar', 'tgz', 'wav', 'webm', 'wma', 'wmv', 'xlsx', 'xz', 'zip', 'zst',
  ],
  minCaptureSizeKB: 0,
  videoQuality: 'best',
  // Session cookies for yt-dlp: none, browser (sent by the extension), firefox or file.
  videoCookies: 'none',
  videoCookiesFile: '',
};

const COOKIE_SOURCES = ['none', 'browser', 'firefox', 'file'];

// A failed download whose errorCode is listed here is retried as another kind.
const CONVERSIONS = {
  HTML_PAGE: 'video',
  STREAM_MANIFEST: 'stream',
  NOT_A_STREAM: 'file',
};

const TICK_MS = 500;

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

class DownloadManager extends EventEmitter {
  /**
   * `videoTools` ({ ytdlp, ffmpegDir, jsRuntime, env }) enables video pages; null disables them.
   * `streamTools` ({ ffmpeg, ffprobe }) lets HLS/DASH downloads join audio and video.
   */
  constructor({ storeDir, defaultDownloadDir, videoTools = null, streamTools = null }) {
    super();
    this.videoTools = videoTools;
    this.streamTools = streamTools;
    this.storeDir = storeDir;
    this.downloadsFile = path.join(storeDir, 'downloads.json');
    this.settingsFile = path.join(storeDir, 'settings.json');
    fs.mkdirSync(storeDir, { recursive: true });

    this.settings = { ...DEFAULT_SETTINGS, ...readJson(this.settingsFile, {}) };
    if (!this.settings.downloadDir) this.settings.downloadDir = defaultDownloadDir;
    this.limiter = new SpeedLimiter(this.settings.speedLimitKBps * 1024);

    this.downloads = new Map();
    this.speeds = new Map();
    this.dirty = false;

    for (const state of readJson(this.downloadsFile, [])) this.#attach(state);
    this.timer = setInterval(() => this.#tick(), TICK_MS);
    this.timer.unref?.();
  }

  #attach(state) {
    const download = state.kind === 'video' ? this.#createVideo(state)
      : state.kind === 'stream' ? this.#createStream(state) : this.#createFile(state);
    download.on('change', () => {
      this.dirty = true;
      const { status } = download.state;
      if (status !== 'downloading') this.speeds.delete(download.state.id);
      const target = status === 'error' ? CONVERSIONS[download.state.errorCode] : null;
      if (target && (target !== 'video' || this.videoTools)) {
        this.#convert(download, target);
        return;
      }
      if (status === 'completed') this.emit('completed', this.#view(download));
      this.#schedule();
      this.#emitUpdate();
    });
    this.downloads.set(state.id, download);
    return download;
  }

  #createVideo(state) {
    return new VideoDownload(state, {
      tools: this.videoTools,
      getSettings: () => this.settings,
      sessionDir: path.join(this.storeDir, 'sessions'),
    });
  }

  #createStream(state) {
    const download = new StreamDownload(state, {
      limiter: this.limiter,
      getMaxConnections: () => this.settings.maxConnections,
      tools: this.streamTools,
      isPathTaken: (candidate) => [...this.downloads.values()].some(
        (d) => d !== download && d.state.filePath?.toLowerCase() === candidate.toLowerCase(),
      ),
    });
    return download;
  }

  /**
   * Retries a download as another kind under the same id: a web page goes to
   * yt-dlp, a manifest to the stream engine, and a plain .m3u8 list (not HLS)
   * back to a file download that will not divert it again.
   */
  #convert(download, kind) {
    const { id, url, dir, createdAt, headers, quality, suggestedName, fileName } = download.state;
    download.removeAllListeners('change');
    this.#attach({
      id,
      url,
      dir,
      createdAt,
      headers,
      suggestedName,
      kind,
      quality: quality ?? this.settings.videoQuality,
      fileName: kind === 'stream' ? streamBaseName(url, suggestedName) : fileName,
      forceFile: kind === 'file' ? true : undefined,
      status: 'queued',
    });
    this.dirty = true;
    this.#schedule();
    this.#emitUpdate();
  }

  #createFile(state) {
    const download = new SegmentedDownload(state, {
      limiter: this.limiter,
      getMaxConnections: () => this.settings.maxConnections,
      isPathTaken: (candidate) => [...this.downloads.values()].some(
        (d) => d !== download && d.state.filePath?.toLowerCase() === candidate.toLowerCase(),
      ),
    });
    return download;
  }

  add({ url, referrer, cookie, userAgent, fileName, dir, startPaused = false, quality = null }) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Apenas links http e https são suportados');
    const id = crypto.randomUUID();
    const kind = isManifestUrl(parsed.href) ? 'stream'
      : this.videoTools && isVideoPageUrl(parsed.href) ? 'video' : 'file';
    this.#attach({
      id,
      url: parsed.href,
      kind,
      quality: QUALITIES.includes(quality) ? quality : this.settings.videoQuality,
      dir: dir || this.settings.downloadDir,
      suggestedName: fileName ? sanitize(fileName) : null,
      fileName: kind === 'stream' ? streamBaseName(parsed.href, fileName)
        : fileName ? sanitize(fileName) : parsed.pathname.split('/').pop() || parsed.hostname,
      headers: { referrer: referrer || null, cookie: cookie || null, userAgent: userAgent || null },
      status: startPaused ? 'paused' : 'queued',
      createdAt: Date.now(),
    });
    this.dirty = true;
    this.#schedule();
    this.#emitUpdate();
    return id;
  }

  async pause(id) {
    const d = this.downloads.get(id);
    if (!d || d.state.status === 'completed') return;
    await d.pause();
  }

  resume(id) {
    const d = this.downloads.get(id);
    if (!d || !['paused', 'error'].includes(d.state.status)) return;
    d.state.status = 'queued';
    d.state.error = null;
    this.dirty = true;
    this.#schedule();
    this.#emitUpdate();
  }

  async remove(id, { deleteFile = false } = {}) {
    const d = this.downloads.get(id);
    if (!d) return;
    await d.pause();
    if (d.state.status !== 'completed') await d.discardTemp();
    else if (deleteFile && d.state.filePath) await fs.promises.rm(d.state.filePath, { force: true });
    this.downloads.delete(id);
    this.speeds.delete(id);
    this.dirty = true;
    this.#emitUpdate();
  }

  async pauseAll() {
    await Promise.all([...this.downloads.keys()].map((id) => this.pause(id)));
  }

  resumeAll() {
    for (const id of this.downloads.keys()) this.resume(id);
  }

  updateSettings(patch) {
    const next = { ...this.settings, ...patch };
    next.maxConnections = Math.min(32, Math.max(1, Math.round(Number(next.maxConnections) || 1)));
    next.maxConcurrent = Math.min(10, Math.max(1, Math.round(Number(next.maxConcurrent) || 1)));
    next.speedLimitKBps = Math.max(0, Number(next.speedLimitKBps) || 0);
    next.minCaptureSizeKB = Math.max(0, Number(next.minCaptureSizeKB) || 0);
    if (!QUALITIES.includes(next.videoQuality)) next.videoQuality = 'best';
    if (!COOKIE_SOURCES.includes(next.videoCookies)) next.videoCookies = 'none';
    next.videoCookiesFile = typeof next.videoCookiesFile === 'string' ? next.videoCookiesFile : '';
    if (next.videoCookiesFile && !path.isAbsolute(next.videoCookiesFile)) next.videoCookiesFile = '';
    next.captureExtensions = [...new Set((next.captureExtensions ?? [])
      .map((e) => String(e).trim().toLowerCase().replace(/^\./, ''))
      .filter(Boolean))];
    this.settings = next;
    this.limiter.setRate(next.speedLimitKBps * 1024);
    writeJsonAtomic(this.settingsFile, next);
    this.#schedule();
    this.emit('settings', next);
    return next;
  }

  #schedule() {
    const all = [...this.downloads.values()];
    let running = all.filter((d) => d.state.status === 'downloading').length;
    for (const d of all) {
      if (running >= this.settings.maxConcurrent) break;
      if (d.state.status === 'queued') {
        running++;
        d.start();
      }
    }
  }

  #tick() {
    const now = Date.now();
    for (const d of this.downloads.values()) {
      if (d.state.status !== 'downloading') continue;
      const prev = this.speeds.get(d.state.id);
      const bytes = d.downloaded;
      if (!prev) {
        this.speeds.set(d.state.id, { at: now, bytes, speed: 0 });
        continue;
      }
      const instant = ((bytes - prev.bytes) * 1000) / Math.max(1, now - prev.at);
      this.speeds.set(d.state.id, { at: now, bytes, speed: prev.speed ? prev.speed * 0.7 + instant * 0.3 : instant });
    }
    if ([...this.downloads.values()].some((d) => d.state.status === 'downloading')) {
      this.dirty = true;
      this.#emitUpdate();
    }
    if (this.dirty) this.save();
  }

  save() {
    this.dirty = false;
    writeJsonAtomic(this.downloadsFile, [...this.downloads.values()].map((d) => d.toJSON()));
  }

  #view(d) {
    const s = d.state;
    const speed = this.speeds.get(s.id)?.speed ?? 0;
    const downloaded = s.status === 'completed' ? (s.totalSize ?? d.downloaded) : d.downloaded;
    return {
      id: s.id,
      url: s.url,
      kind: s.kind ?? 'file',
      quality: s.kind === 'video' || s.kind === 'stream' ? s.quality : null,
      phase: s.phase ?? null,
      protocol: s.protocol ?? null,
      selection: s.selection ?? null,
      notices: s.notices ?? [],
      chunks: s.kind === 'stream' ? s.chunks ?? null : null,
      sizeEstimated: !!s.sizeEstimated && s.status !== 'completed',
      fileName: s.fileName,
      filePath: s.filePath ?? null,
      dir: s.dir,
      status: s.status,
      error: s.error,
      totalSize: s.totalSize,
      downloaded,
      resumable: s.resumable,
      speed,
      eta: speed > 0 && s.totalSize ? (s.totalSize - downloaded) / speed : null,
      connections: d.activeConnections,
      createdAt: s.createdAt,
      completedAt: s.completedAt ?? null,
      segments: (s.segments ?? []).map(({ start, end, pos, active }) => ({ start, end, pos, active: !!active })),
    };
  }

  list() {
    return [...this.downloads.values()].map((d) => this.#view(d));
  }

  #emitUpdate() {
    if (this.updatePending) return;
    this.updatePending = true;
    setImmediate(() => {
      this.updatePending = false;
      this.emit('update', this.list());
    });
  }

  /** Starts queued downloads, including those interrupted by the last shutdown. */
  startQueued() {
    this.#schedule();
  }

  async shutdown() {
    clearInterval(this.timer);
    const unfinished = [...this.downloads.values()].filter((d) => ['downloading', 'queued'].includes(d.state.status));
    await this.pauseAll();
    // Re-queue them so the next launch continues where this one stopped.
    for (const d of unfinished) if (d.state.status === 'paused') d.state.status = 'queued';
    this.save();
  }
}

module.exports = { DownloadManager, DEFAULT_SETTINGS };
