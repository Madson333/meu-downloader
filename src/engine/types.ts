import type { EventEmitter } from 'node:events';
import type { DownloadKind, DownloadStatus, Quality } from '../shared/api';

/** Browser context sent with a link, replayed on every request. */
export interface RequestHeaders {
  referrer?: string | null;
  cookie?: string | null;
  userAgent?: string | null;
}

/** Fields every download kind persists in downloads.json. */
export interface BaseState {
  id: string;
  url: string;
  kind: DownloadKind;
  dir: string;
  status: DownloadStatus;
  error: string | null;
  errorCode?: string | null;
  createdAt?: number;
  completedAt?: number;
  fileName?: string;
  filePath?: string | null;
  suggestedName?: string | null;
  headers?: RequestHeaders;
  quality?: Quality;
  totalSize: number | null;
  phase?: string | null;
}

/** State as read back from disk or handed over by the manager: only the identity is required. */
export type InitialState<S extends BaseState> = Partial<S> & Pick<BaseState, 'id' | 'url' | 'dir'>;

/** The surface the manager relies on; SegmentedDownload, VideoDownload and StreamDownload all offer it. */
export interface Download extends EventEmitter {
  readonly state: BaseState;
  readonly downloaded: number;
  readonly activeConnections: number;
  start(): Promise<void>;
  pause(): Promise<void>;
  discardTemp(): Promise<void>;
  toJSON(): BaseState;
}

/** Errors that carry a machine-readable code (Node system errors, HttpError, ManifestError). */
export interface CodedError extends Error {
  code?: string | null;
  retryable?: boolean;
  status?: number | null;
  syscall?: string;
}

export function asCodedError(err: unknown): CodedError {
  return err instanceof Error ? err : new Error(String(err));
}
