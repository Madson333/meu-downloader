// Types shared by the main process and the interface. A declaration file, so it
// emits no code and both the CommonJS and the browser builds can import it.

export type Quality = 'best' | '2160' | '1440' | '1080' | '720' | '480' | '360' | 'audio';
export type DownloadKind = 'file' | 'video' | 'stream';
export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'error';
export type CookieSource = 'none' | 'browser' | 'firefox' | 'file';
export type StreamProtocol = 'hls' | 'dash';

export interface Settings {
  downloadDir: string;
  maxConnections: number;
  maxConcurrent: number;
  speedLimitKBps: number;
  captureEnabled: boolean;
  captureExtensions: string[];
  minCaptureSizeKB: number;
  videoQuality: Quality;
  videoCookies: CookieSource;
  videoCookiesFile: string;
}

export interface SettingsView extends Settings {
  videoAvailable: boolean;
  ffmpegAvailable: boolean;
}

/** Tracks picked from a stream manifest, described for display. */
export interface StreamSelection {
  video?: string;
  audio?: string;
  subtitles?: string[];
}

export interface SegmentView {
  start: number;
  end: number | null;
  pos: number;
  active: boolean;
}

/** One row of the download list, as sent to the interface. */
export interface DownloadView {
  id: string;
  url: string;
  kind: DownloadKind;
  quality: Quality | null;
  phase: string | null;
  protocol: StreamProtocol | null;
  selection: StreamSelection | null;
  notices: string[];
  chunks: { done: number; total: number } | null;
  sizeEstimated: boolean;
  fileName: string;
  filePath: string | null;
  dir: string;
  status: DownloadStatus;
  error: string | null;
  totalSize: number | null;
  downloaded: number;
  resumable: boolean;
  speed: number;
  eta: number | null;
  connections: number;
  createdAt: number;
  completedAt: number | null;
  segments: SegmentView[];
}

export interface AddOptions {
  url: string;
  referrer?: string | null;
  cookie?: string | null;
  userAgent?: string | null;
  fileName?: string | null;
  dir?: string;
  startPaused?: boolean;
  quality?: string | null;
}

/** API the preload script exposes to the interface as window.downloader. */
export interface DownloaderApi {
  list(): Promise<DownloadView[]>;
  add(options: AddOptions): Promise<string>;
  pause(ids: string[]): Promise<void>;
  resume(ids: string[]): Promise<void>;
  remove(ids: string[], deleteFile: boolean): Promise<void>;
  pauseAll(): Promise<void>;
  resumeAll(): Promise<void>;
  openFile(id: string): Promise<string>;
  showInFolder(id: string): Promise<void>;
  copyUrl(id: string): Promise<void>;
  getSettings(): Promise<SettingsView>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  chooseFolder(current: string): Promise<string | null>;
  chooseCookiesFile(): Promise<string | null>;
  clipboardUrl(): Promise<string | null>;
  updateVideoTool(): Promise<string>;
  onUpdate(callback: (list: DownloadView[]) => void): () => void;
  onFocusDownload(callback: (id: string) => void): void;
}
