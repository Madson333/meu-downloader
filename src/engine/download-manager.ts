import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { SegmentedDownload, type FileState } from './segmented-download';
import { SpeedLimiter } from './speed-limiter';
import { VideoDownload, isVideoPageUrl, isQuality, type VideoState, type VideoTools } from './video-download';
import { StreamDownload, streamBaseName, type StreamState } from './stream-download';
import { isManifestUrl } from './manifest';
import { sanitize } from './file-name';
import type { StreamTools } from './ffmpeg';
import type { BaseState, InitialState } from './types';
import type { AddOptions, CookieSource, DownloadKind, DownloadView, Settings } from '../shared/api';

export const DEFAULT_SETTINGS: Settings = {
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

const COOKIE_SOURCES: readonly CookieSource[] = ['none', 'browser', 'firefox', 'file'];

// A failed download whose errorCode is listed here is retried as another kind.
const CONVERSIONS: Record<string, DownloadKind> = {
  HTML_PAGE: 'video',
  STREAM_MANIFEST: 'stream',
  NOT_A_STREAM: 'file',
};

const TICK_MS = 500;

export type AnyDownload = SegmentedDownload | VideoDownload | StreamDownload;

/** A download as stored in downloads.json or handed to #attach; checked loosely, since it comes from disk. */
type StoredState = InitialState<BaseState> & Record<string, unknown>;

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function isStoredState(value: unknown): value is StoredState {
  const v = value as Partial<StoredState> | null;
  return typeof v === 'object' && v !== null
    && typeof v.id === 'string' && typeof v.url === 'string' && typeof v.dir === 'string';
}

/** Clamps and fills settings read from disk or sent by the interface. */
function normalizeSettings(raw: Partial<Settings>): Settings {
  const next = { ...DEFAULT_SETTINGS, ...raw };
  next.downloadDir = typeof next.downloadDir === 'string' ? next.downloadDir : '';
  next.maxConnections = Math.min(32, Math.max(1, Math.round(Number(next.maxConnections) || 1)));
  next.maxConcurrent = Math.min(10, Math.max(1, Math.round(Number(next.maxConcurrent) || 1)));
  next.speedLimitKBps = Math.max(0, Number(next.speedLimitKBps) || 0);
  next.minCaptureSizeKB = Math.max(0, Number(next.minCaptureSizeKB) || 0);
  next.captureEnabled = !!next.captureEnabled;
  if (!isQuality(next.videoQuality)) next.videoQuality = 'best';
  if (!COOKIE_SOURCES.includes(next.videoCookies)) next.videoCookies = 'none';
  next.videoCookiesFile = typeof next.videoCookiesFile === 'string' ? next.videoCookiesFile : '';
  if (next.videoCookiesFile && !path.isAbsolute(next.videoCookiesFile)) next.videoCookiesFile = '';
  next.captureExtensions = [...new Set((Array.isArray(next.captureExtensions) ? next.captureExtensions : [])
    .map((e) => String(e).trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean))];
  return next;
}

export interface ManagerOptions {
  storeDir: string;
  defaultDownloadDir: string;
  /** Enables video pages through yt-dlp; null disables them. */
  videoTools?: VideoTools | null;
  /** Lets HLS/DASH downloads join audio and video. */
  streamTools?: StreamTools | null;
}

export interface DownloadManager {
  on(event: 'update', listener: (list: DownloadView[]) => void): this;
  on(event: 'completed', listener: (download: DownloadView) => void): this;
  on(event: 'settings', listener: (settings: Settings) => void): this;
  off(event: 'update', listener: (list: DownloadView[]) => void): this;
}

export class DownloadManager extends EventEmitter {
  readonly videoTools: VideoTools | null;
  readonly streamTools: StreamTools | null;
  readonly storeDir: string;
  readonly downloads = new Map<string, AnyDownload>();
  readonly timer: NodeJS.Timeout;
  settings: Settings;
  /** Set by the main process once shutdown has started. */
  closed = false;
  private readonly downloadsFile: string;
  private readonly settingsFile: string;
  private readonly limiter: SpeedLimiter;
  private readonly speeds = new Map<string, { at: number; bytes: number; speed: number }>();
  private dirty = false;
  private updatePending = false;

  constructor({ storeDir, defaultDownloadDir, videoTools = null, streamTools = null }: ManagerOptions) {
    super();
    this.videoTools = videoTools;
    this.streamTools = streamTools;
    this.storeDir = storeDir;
    this.downloadsFile = path.join(storeDir, 'downloads.json');
    this.settingsFile = path.join(storeDir, 'settings.json');
    fs.mkdirSync(storeDir, { recursive: true });

    const saved = readJson(this.settingsFile);
    this.settings = normalizeSettings(typeof saved === 'object' && saved !== null ? saved : {});
    if (!this.settings.downloadDir) this.settings.downloadDir = defaultDownloadDir;
    this.limiter = new SpeedLimiter(this.settings.speedLimitKBps * 1024);

    const stored = readJson(this.downloadsFile);
    for (const state of Array.isArray(stored) ? stored : []) if (isStoredState(state)) this.#attach(state);
    this.timer = setInterval(() => this.#tick(), TICK_MS);
    this.timer.unref?.();
  }

  #attach(state: StoredState): AnyDownload {
    const download = state.kind === 'video' ? this.#createVideo(state as InitialState<VideoState>)
      : state.kind === 'stream' ? this.#createStream(state as InitialState<StreamState>)
        : this.#createFile(state as InitialState<FileState>);
    download.on('change', () => {
      this.dirty = true;
      const { status, errorCode } = download.state;
      if (status !== 'downloading') this.speeds.delete(download.state.id);
      const target = status === 'error' && errorCode && Object.hasOwn(CONVERSIONS, errorCode) ? CONVERSIONS[errorCode] : undefined;
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

  #isPathTaken(self: AnyDownload, candidate: string): boolean {
    return [...this.downloads.values()].some(
      (d) => d !== self && d.state.filePath?.toLowerCase() === candidate.toLowerCase(),
    );
  }

  #createVideo(state: InitialState<VideoState>): VideoDownload {
    return new VideoDownload(state, {
      tools: this.videoTools,
      getSettings: () => this.settings,
      sessionDir: path.join(this.storeDir, 'sessions'),
    });
  }

  #createStream(state: InitialState<StreamState>): StreamDownload {
    const download: StreamDownload = new StreamDownload(state, {
      limiter: this.limiter,
      getMaxConnections: () => this.settings.maxConnections,
      tools: this.streamTools,
      isPathTaken: (candidate) => this.#isPathTaken(download, candidate),
    });
    return download;
  }

  #createFile(state: InitialState<FileState>): SegmentedDownload {
    const download: SegmentedDownload = new SegmentedDownload(state, {
      limiter: this.limiter,
      getMaxConnections: () => this.settings.maxConnections,
      isPathTaken: (candidate) => this.#isPathTaken(download, candidate),
    });
    return download;
  }

  /**
   * Retries a download as another kind under the same id: a web page goes to
   * yt-dlp, a manifest to the stream engine, and a plain .m3u8 list (not HLS)
   * back to a file download that will not divert it again.
   */
  #convert(download: AnyDownload, kind: DownloadKind): void {
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
      fileName: kind === 'stream' ? streamBaseName(url, suggestedName ?? null) : fileName,
      forceFile: kind === 'file' ? true : undefined,
      status: 'queued',
    });
    this.dirty = true;
    this.#schedule();
    this.#emitUpdate();
  }

  add({ url, referrer, cookie, userAgent, fileName, dir, startPaused = false, quality = null }: AddOptions): string {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Apenas links http e https são suportados');
    const id = crypto.randomUUID();
    const kind: DownloadKind = isManifestUrl(parsed.href) ? 'stream'
      : this.videoTools && isVideoPageUrl(parsed.href) ? 'video' : 'file';
    this.#attach({
      id,
      url: parsed.href,
      kind,
      quality: isQuality(quality) ? quality : this.settings.videoQuality,
      dir: dir || this.settings.downloadDir,
      suggestedName: fileName ? sanitize(fileName) : null,
      fileName: kind === 'stream' ? streamBaseName(parsed.href, fileName ?? null)
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

  async pause(id: string): Promise<void> {
    const d = this.downloads.get(id);
    if (!d || d.state.status === 'completed') return;
    await d.pause();
  }

  resume(id: string): void {
    const d = this.downloads.get(id);
    if (!d || !['paused', 'error'].includes(d.state.status)) return;
    d.state.status = 'queued';
    d.state.error = null;
    this.dirty = true;
    this.#schedule();
    this.#emitUpdate();
  }

  async remove(id: string, { deleteFile = false }: { deleteFile?: boolean } = {}): Promise<void> {
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

  async pauseAll(): Promise<void> {
    await Promise.all([...this.downloads.keys()].map((id) => this.pause(id)));
  }

  resumeAll(): void {
    for (const id of this.downloads.keys()) this.resume(id);
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const next = normalizeSettings({ ...this.settings, ...patch });
    this.settings = next;
    this.limiter.setRate(next.speedLimitKBps * 1024);
    writeJsonAtomic(this.settingsFile, next);
    this.#schedule();
    this.emit('settings', next);
    return next;
  }

  #schedule(): void {
    const all = [...this.downloads.values()];
    let running = all.filter((d) => d.state.status === 'downloading').length;
    for (const d of all) {
      if (running >= this.settings.maxConcurrent) break;
      if (d.state.status === 'queued') {
        running++;
        void d.start();
      }
    }
  }

  #tick(): void {
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

  save(): void {
    this.dirty = false;
    writeJsonAtomic(this.downloadsFile, [...this.downloads.values()].map((d) => d.toJSON()));
  }

  #view(d: AnyDownload): DownloadView {
    const s = d.state;
    const speed = this.speeds.get(s.id)?.speed ?? 0;
    const downloaded = s.status === 'completed' ? (s.totalSize ?? d.downloaded) : d.downloaded;
    return {
      id: s.id,
      url: s.url,
      kind: s.kind,
      quality: s.kind === 'video' || s.kind === 'stream' ? s.quality : null,
      phase: s.phase ?? null,
      protocol: s.kind === 'stream' ? s.protocol ?? null : null,
      selection: s.kind === 'stream' ? s.selection ?? null : null,
      notices: s.kind === 'stream' ? s.notices : [],
      chunks: s.kind === 'stream' ? s.chunks : null,
      sizeEstimated: s.kind === 'stream' && !!s.sizeEstimated && s.status !== 'completed',
      fileName: s.fileName ?? '',
      filePath: s.filePath ?? null,
      dir: s.dir,
      status: s.status,
      error: s.error,
      totalSize: s.totalSize,
      downloaded,
      resumable: s.kind === 'file' && s.resumable,
      speed,
      eta: speed > 0 && s.totalSize ? (s.totalSize - downloaded) / speed : null,
      connections: d.activeConnections,
      createdAt: s.createdAt ?? 0,
      completedAt: s.completedAt ?? null,
      segments: s.kind === 'file' ? s.segments.map(({ start, end, pos, active }) => ({ start, end, pos, active: !!active })) : [],
    };
  }

  list(): DownloadView[] {
    return [...this.downloads.values()].map((d) => this.#view(d));
  }

  #emitUpdate(): void {
    if (this.updatePending) return;
    this.updatePending = true;
    setImmediate(() => {
      this.updatePending = false;
      this.emit('update', this.list());
    });
  }

  /** Starts queued downloads, including those interrupted by the last shutdown. */
  startQueued(): void {
    this.#schedule();
  }

  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    const unfinished = [...this.downloads.values()].filter((d) => ['downloading', 'queued'].includes(d.state.status));
    await this.pauseAll();
    // Re-queue them so the next launch continues where this one stopped.
    for (const d of unfinished) if (d.state.status === 'paused') d.state.status = 'queued';
    this.save();
  }
}
