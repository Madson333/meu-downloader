'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');

// Sites that serve a player page instead of a file. Any other site still
// reaches yt-dlp when its link turns out to be a web page.
const VIDEO_HOSTS = [
  'youtube.com', 'youtu.be', 'youtube-nocookie.com', 'vimeo.com', 'dailymotion.com', 'twitch.tv',
  'tiktok.com', 'instagram.com', 'facebook.com', 'fb.watch', 'x.com', 'twitter.com', 'reddit.com',
  'soundcloud.com', 'bandcamp.com', 'bilibili.com', 'kick.com', 'rumble.com', 'streamable.com',
  'pinterest.com', 'threads.net', 'odysee.com', 'globo.com', 'globoplay.globo.com',
];

function isVideoPageUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return VIDEO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

const QUALITIES = ['best', '2160', '1440', '1080', '720', '480', '360', 'audio'];

function formatArgs(quality) {
  if (quality === 'audio') return ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'];
  // `res` is the smaller dimension, so "1080p" also means 1080x1920 for vertical videos.
  // -S res:N prefers the largest resolution not above N; H.264/AAC win among equals.
  const res = /^\d+$/.test(quality) ? `res:${quality}` : 'res';
  return ['-f', 'bv*+ba/b', '-S', `${res},fps,vcodec:h264,acodec:aac`, '--merge-output-format', 'mp4'];
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  else child.kill('SIGTERM');
}

/**
 * A video page downloaded through yt-dlp. Same surface as SegmentedDownload so
 * the manager and interface treat both alike. yt-dlp keeps `.part` files, so
 * pausing kills the process and resuming runs it again with --continue.
 */
class VideoDownload extends EventEmitter {
  constructor(state, { tools, getSettings }) {
    super();
    // `streams` is persisted so progress and partial files survive a restart.
    this.state = { status: 'queued', segments: [], streams: {}, totalSize: null, error: null, quality: 'best', ...state, kind: 'video' };
    this.tools = tools;
    this.getSettings = getSettings;
    this.child = null;
    this.running = null;
    this.connections = 0;
  }

  get downloaded() {
    let sum = 0;
    for (const s of Object.values(this.state.streams)) sum += s.downloaded;
    return sum;
  }

  get activeConnections() {
    return this.connections;
  }

  #setStatus(status, error = null) {
    this.state.status = status;
    this.state.error = error;
    if (status !== 'downloading') this.state.phase = null;
    this.emit('change', this);
  }

  #args() {
    const settings = this.getSettings();
    const args = [
      '--newline', '--progress', '--no-colors', '--encoding', 'utf-8',
      '--no-playlist', '--continue', '--no-mtime', '--windows-filenames',
      '--retries', '10', '--fragment-retries', '10',
      '--concurrent-fragments', String(settings.maxConnections),
      '--ffmpeg-location', this.tools.ffmpegDir,
      '--js-runtimes', `node:${this.tools.jsRuntime}`,
      '-P', this.state.dir,
      '-o', '%(title).150B [%(id)s].%(ext)s',
      '--progress-template', 'download:MDPROG %(progress)j',
      '--print', 'before_dl:MDINFO %(.{id,title})j',
      '--print', 'after_move:MDFILE %(filepath)s',
      '--no-simulate',
      ...formatArgs(this.state.quality),
    ];
    if (settings.speedLimitKBps > 0) args.push('--limit-rate', `${settings.speedLimitKBps}K`);
    args.push('--', this.state.url);
    return args;
  }

  start() {
    if (this.running) return this.running;
    if (!this.tools) {
      this.#setStatus('error', 'yt-dlp não encontrado na pasta bin do app');
      return Promise.resolve();
    }
    this.pauseRequested = false;
    this.#setStatus('downloading');
    this.running = this.#run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  #run() {
    return new Promise((resolve) => {
      fs.mkdirSync(this.state.dir, { recursive: true });
      const child = spawn(this.tools.ytdlp, this.#args(), {
        windowsHide: true,
        env: { ...process.env, ...this.tools.env, PYTHONIOENCODING: 'utf-8' },
      });
      this.child = child;
      this.connections = 1;
      let lastError = null;
      let buffer = '';
      const onLine = (line) => {
        if (line.startsWith('MDPROG ')) this.#onProgress(line.slice(7));
        else if (line.startsWith('MDINFO ')) this.#onInfo(line.slice(7));
        else if (line.startsWith('MDFILE ')) this.state.filePath = line.slice(7).trim();
        else if (/^ERROR:/.test(line)) lastError = line.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '');
        else if (/^\[Merger\]|^\[ExtractAudio\]|^\[VideoConvertor\]/.test(line)) this.#phase('Juntando áudio e vídeo…');
      };
      const read = (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) onLine(line.trim());
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.on('error', (err) => {
        lastError = `Não foi possível iniciar o yt-dlp: ${err.message}`;
      });
      child.on('close', (code) => {
        if (buffer) onLine(buffer.trim());
        this.child = null;
        this.connections = 0;
        if (this.pauseRequested) this.#setStatus('paused');
        else if (code === 0 && this.state.filePath && fs.existsSync(this.state.filePath)) this.#finish();
        else this.#setStatus('error', lastError || `yt-dlp terminou com código ${code}`);
        resolve();
      });
    });
  }

  #phase(text) {
    this.state.phase = text;
    this.emit('change', this);
  }

  #onInfo(json) {
    try {
      const info = JSON.parse(json);
      if (info.title) this.state.fileName = info.title;
      this.state.videoId = info.id ?? this.state.videoId;
      this.emit('change', this);
    } catch {
      // Ignore malformed lines; progress keeps working without the title.
    }
  }

  #onProgress(json) {
    let p;
    try {
      p = JSON.parse(json);
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
    this.state.totalSize = totals.every(Boolean) ? totals.reduce((a, b) => a + b, 0) : null;
    this.connections = p.status !== 'downloading' ? 0
      : p.fragment_count ? Math.min(this.getSettings().maxConnections, p.fragment_count) : 1;
    if (this.state.phase) this.state.phase = null;
  }

  #finish() {
    const filePath = this.state.filePath;
    this.state.fileName = path.basename(filePath);
    this.state.totalSize = fs.statSync(filePath).size;
    this.state.streams = { final: { downloaded: this.state.totalSize, total: this.state.totalSize } };
    this.state.completedAt = Date.now();
    this.#setStatus('completed');
  }

  async pause() {
    if (!this.running) {
      if (this.state.status !== 'completed') this.#setStatus('paused');
      return;
    }
    this.pauseRequested = true;
    killTree(this.child);
    await this.running;
  }

  /** Removes the partial files this download created. */
  async discardTemp() {
    const names = new Set();
    for (const s of Object.values(this.state.streams)) {
      for (const f of [s.tmp, s.file]) if (f) names.add(path.resolve(this.state.dir, f));
    }
    for (const file of names) {
      for (const candidate of [file, `${file}.part`, `${file}.ytdl`]) {
        if (candidate !== this.state.filePath) await fs.promises.rm(candidate, { force: true });
      }
    }
  }

  toJSON() {
    const { status, ...rest } = this.state;
    return { ...rest, status: status === 'downloading' ? 'paused' : status, segments: [] };
  }
}

/** Runs `yt-dlp -U` and resolves with its output. */
function updateYtDlp(tools) {
  return new Promise((resolve) => {
    execFile(tools.ytdlp, ['-U'], { windowsHide: true, timeout: 120_000 }, (err, stdout, stderr) => {
      resolve(`${stdout}${stderr}`.trim() || err?.message || 'Sem resposta do yt-dlp');
    });
  });
}

module.exports = { VideoDownload, isVideoPageUrl, updateYtDlp, QUALITIES };
