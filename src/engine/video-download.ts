import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Quality, Settings } from '../shared/api';
import type { BaseState, Download, InitialState } from './types';

// Sites that serve a player page instead of a file. Any other site still
// reaches yt-dlp when its link turns out to be a web page.
const VIDEO_HOSTS = [
  'youtube.com', 'youtu.be', 'youtube-nocookie.com', 'vimeo.com', 'dailymotion.com', 'twitch.tv',
  'tiktok.com', 'instagram.com', 'facebook.com', 'fb.watch', 'x.com', 'twitter.com', 'reddit.com',
  'soundcloud.com', 'bandcamp.com', 'bilibili.com', 'kick.com', 'rumble.com', 'streamable.com',
  'pinterest.com', 'threads.net', 'odysee.com', 'globo.com', 'globoplay.globo.com',
];

export function isVideoPageUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return VIDEO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export const QUALITIES: readonly Quality[] = ['best', '2160', '1440', '1080', '720', '480', '360', 'audio'];

export function isQuality(value: unknown): value is Quality {
  return QUALITIES.includes(value as Quality);
}

function formatArgs(quality: Quality): string[] {
  if (quality === 'audio') return ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'];
  // `res` is the smaller dimension, so "1080p" also means 1080x1920 for vertical videos.
  // -S res:N prefers the largest resolution not above N; H.264/AAC win among equals.
  const res = /^\d+$/.test(quality) ? `res:${quality}` : 'res';
  return ['-f', 'bv*+ba/b', '-S', `${res},fps,vcodec:h264,acodec:aac`, '--merge-output-format', 'mp4'];
}

/**
 * Netscape cookies.txt for yt-dlp from a Cookie header. Every cookie is
 * host-only for the page's host, so yt-dlp never sends them to other sites.
 */
export function toNetscapeCookies(cookieHeader: string | null | undefined, url: string): string | null {
  const { hostname, protocol } = new URL(url);
  const lines = ['# Netscape HTTP Cookie File'];
  for (const pair of String(cookieHeader ?? '').split(';')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (!name || /[\t\r\n]/.test(name + value)) continue;
    lines.push([hostname, 'FALSE', '/', protocol === 'https:' ? 'TRUE' : 'FALSE', '0', name, value].join('\t'));
  }
  return lines.length > 1 ? `${lines.join('\n')}\n` : null;
}

export function killTree(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  else child.kill('SIGTERM');
}

/** yt-dlp and where it finds ffmpeg and a JavaScript runtime. */
export interface VideoTools {
  ytdlp: string;
  ffmpegDir: string;
  jsRuntime: string;
  env: NodeJS.ProcessEnv;
}

/** The settings a video download reads; cookie options are optional. */
export type VideoSettings = Pick<Settings, 'maxConnections' | 'speedLimitKBps'>
  & Partial<Pick<Settings, 'videoCookies' | 'videoCookiesFile'>>;

interface StreamProgress {
  downloaded: number;
  total: number | null;
  tmp?: string | null;
  file?: string | null;
}

export interface VideoState extends BaseState {
  kind: 'video';
  quality: Quality;
  segments: [];
  /** Persisted so progress and partial files survive a restart. */
  streams: Record<string, StreamProgress>;
  videoId?: string;
}

/** The fields of yt-dlp's progress JSON that are used here. */
interface YtDlpProgress {
  status?: string;
  filename?: string;
  tmpfilename?: string;
  downloaded_bytes?: number;
  total_bytes?: number;
  total_bytes_estimate?: number;
  fragment_count?: number;
}

/**
 * A video page downloaded through yt-dlp. Same surface as SegmentedDownload so
 * the manager and interface treat both alike. yt-dlp keeps `.part` files, so
 * pausing kills the process and resuming runs it again with --continue.
 */
export class VideoDownload extends EventEmitter implements Download {
  readonly state: VideoState;
  private readonly tools: VideoTools | null;
  private readonly getSettings: () => VideoSettings;
  private readonly sessionDir: string | null;
  private cookieFile: string | null = null;
  private child: ChildProcess | null = null;
  private running: Promise<void> | null = null;
  private connections = 0;
  private pauseRequested = false;

  constructor(state: InitialState<VideoState>, { tools, getSettings, sessionDir = null }: {
    tools: VideoTools | null;
    getSettings: () => VideoSettings;
    sessionDir?: string | null;
  }) {
    super();
    this.state = { status: 'queued', streams: {}, totalSize: null, error: null, quality: 'best', ...state, segments: [], kind: 'video' };
    this.tools = tools;
    this.getSettings = getSettings;
    this.sessionDir = sessionDir;
  }

  get downloaded(): number {
    let sum = 0;
    for (const s of Object.values(this.state.streams)) sum += s.downloaded;
    return sum;
  }

  get activeConnections(): number {
    return this.connections;
  }

  #setStatus(status: VideoState['status'], error: string | null = null): void {
    this.state.status = status;
    this.state.error = error;
    if (status !== 'downloading') this.state.phase = null;
    this.emit('change', this);
  }

  /**
   * Writes the session file chosen in the settings and returns yt-dlp's
   * arguments for it. yt-dlp rewrites its cookie file on exit, so a user's
   * cookies.txt is copied first and the copy is deleted afterwards.
   */
  #cookieArgs(): string[] {
    const { videoCookies, videoCookiesFile } = this.getSettings();
    if (videoCookies === 'firefox') return ['--cookies-from-browser', 'firefox'];
    if (videoCookies !== 'browser' && videoCookies !== 'file') return [];
    if (!this.sessionDir) return [];
    let content: string | Buffer;
    if (videoCookies === 'browser') {
      const netscape = toNetscapeCookies(this.state.headers?.cookie, this.state.url);
      if (!netscape) return [];
      content = netscape;
    } else {
      const stat = videoCookiesFile ? fs.statSync(videoCookiesFile, { throwIfNoEntry: false }) : undefined;
      if (!videoCookiesFile || !stat?.isFile()) throw new Error('Arquivo de cookies não encontrado; escolha-o de novo em Configurações');
      if (stat.size > 10 * 1024 * 1024) throw new Error('Arquivo de cookies grande demais');
      content = fs.readFileSync(videoCookiesFile);
    }
    fs.mkdirSync(this.sessionDir, { recursive: true });
    this.cookieFile = path.join(this.sessionDir, `${this.state.id}.txt`);
    fs.writeFileSync(this.cookieFile, content, { mode: 0o600 });
    return ['--cookies', this.cookieFile];
  }

  #removeCookieFile(): void {
    if (this.cookieFile) fs.rmSync(this.cookieFile, { force: true });
    this.cookieFile = null;
  }

  #args(tools: VideoTools): string[] {
    const settings = this.getSettings();
    const args = [
      '--newline', '--progress', '--no-colors', '--encoding', 'utf-8',
      '--no-playlist', '--continue', '--no-mtime', '--windows-filenames',
      '--retries', '10', '--fragment-retries', '10',
      '--concurrent-fragments', String(settings.maxConnections),
      '--ffmpeg-location', tools.ffmpegDir,
      '--js-runtimes', `node:${tools.jsRuntime}`,
      '-P', this.state.dir,
      '-o', '%(title).150B [%(id)s].%(ext)s',
      '--progress-template', 'download:MDPROG %(progress)j',
      '--print', 'before_dl:MDINFO %(.{id,title})j',
      '--print', 'after_move:MDFILE %(filepath)s',
      '--no-simulate',
      ...formatArgs(this.state.quality),
    ];
    if (settings.speedLimitKBps > 0) args.push('--limit-rate', `${settings.speedLimitKBps}K`);
    args.push(...this.#cookieArgs());
    args.push('--', this.state.url);
    return args;
  }

  start(): Promise<void> {
    if (this.running) return this.running;
    if (!this.tools) {
      this.#setStatus('error', 'yt-dlp não encontrado na pasta bin do app');
      return Promise.resolve();
    }
    this.pauseRequested = false;
    this.#setStatus('downloading');
    this.running = this.#run(this.tools).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  #run(tools: VideoTools): Promise<void> {
    return new Promise((resolve) => {
      fs.mkdirSync(this.state.dir, { recursive: true });
      let args: string[];
      try {
        args = this.#args(tools);
      } catch (err) {
        this.#removeCookieFile();
        this.#setStatus('error', err instanceof Error ? err.message : String(err));
        resolve();
        return;
      }
      const child = spawn(tools.ytdlp, args, {
        windowsHide: true,
        env: { ...process.env, ...tools.env, PYTHONIOENCODING: 'utf-8' },
      });
      this.child = child;
      this.connections = 1;
      let lastError: string | null = null;
      let buffer = '';
      const onLine = (line: string): void => {
        if (line.startsWith('MDPROG ')) this.#onProgress(line.slice(7));
        else if (line.startsWith('MDINFO ')) this.#onInfo(line.slice(7));
        else if (line.startsWith('MDFILE ')) this.state.filePath = line.slice(7).trim();
        else if (/^ERROR:/.test(line)) lastError = line.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '');
        else if (/^\[Merger\]|^\[ExtractAudio\]|^\[VideoConvertor\]/.test(line)) this.#phase('Juntando áudio e vídeo…');
      };
      const read = (chunk: Buffer): void => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) onLine(line.trim());
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.on('error', (err) => {
        lastError = `Não foi possível iniciar o yt-dlp: ${err.message}`;
      });
      child.on('close', (code) => {
        if (buffer) onLine(buffer.trim());
        this.#removeCookieFile();
        this.child = null;
        this.connections = 0;
        const filePath = this.state.filePath;
        if (this.pauseRequested) this.#setStatus('paused');
        else if (code === 0 && filePath && fs.existsSync(filePath)) this.#finish(filePath);
        else this.#setStatus('error', lastError || `yt-dlp terminou com código ${code}`);
        resolve();
      });
    });
  }

  #phase(text: string): void {
    this.state.phase = text;
    this.emit('change', this);
  }

  #onInfo(json: string): void {
    try {
      const info = JSON.parse(json) as { id?: string; title?: string };
      if (info.title) this.state.fileName = info.title;
      if (info.id) this.state.videoId = info.id;
      this.emit('change', this);
    } catch {
      // Ignore malformed lines; progress keeps working without the title.
    }
  }

  #onProgress(json: string): void {
    let p: YtDlpProgress;
    try {
      p = JSON.parse(json) as YtDlpProgress;
    } catch {
      return;
    }
    const key = p.filename || p.tmpfilename || 'stream';
    const total = p.total_bytes || p.total_bytes_estimate || null;
    this.state.streams[key] = {
      downloaded: p.downloaded_bytes ?? 0,
      total,
      tmp: p.tmpfilename ?? null,
      file: p.filename ?? null,
    };
    const totals = Object.values(this.state.streams).map((s) => s.total);
    this.state.totalSize = totals.every(Boolean) ? totals.reduce<number>((a, b) => a + (b ?? 0), 0) : null;
    this.connections = p.status !== 'downloading' ? 0
      : p.fragment_count ? Math.min(this.getSettings().maxConnections, p.fragment_count) : 1;
    if (this.state.phase) this.state.phase = null;
  }

  #finish(filePath: string): void {
    this.state.fileName = path.basename(filePath);
    this.state.totalSize = fs.statSync(filePath).size;
    this.state.streams = { final: { downloaded: this.state.totalSize, total: this.state.totalSize } };
    this.state.completedAt = Date.now();
    this.#setStatus('completed');
  }

  async pause(): Promise<void> {
    if (!this.running) {
      if (this.state.status !== 'completed') this.#setStatus('paused');
      return;
    }
    this.pauseRequested = true;
    killTree(this.child);
    await this.running;
  }

  /** Removes the partial files this download created. */
  async discardTemp(): Promise<void> {
    const names = new Set<string>();
    for (const s of Object.values(this.state.streams)) {
      for (const f of [s.tmp, s.file]) if (f) names.add(path.resolve(this.state.dir, f));
    }
    for (const file of names) {
      for (const candidate of [file, `${file}.part`, `${file}.ytdl`]) {
        if (candidate !== this.state.filePath) await fs.promises.rm(candidate, { force: true });
      }
    }
  }

  toJSON(): VideoState {
    const { status, ...rest } = this.state;
    return { ...rest, status: status === 'downloading' ? 'paused' : status, segments: [] };
  }
}

/** Runs `yt-dlp -U` and resolves with its output. */
export function updateYtDlp(tools: VideoTools): Promise<string> {
  return new Promise((resolve) => {
    execFile(tools.ytdlp, ['-U'], { windowsHide: true, timeout: 120_000 }, (err, stdout, stderr) => {
      resolve(`${stdout}${stderr}`.trim() || err?.message || 'Sem resposta do yt-dlp');
    });
  });
}
