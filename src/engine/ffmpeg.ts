import { spawn } from 'node:child_process';
import { killTree } from './video-download';

const STDERR_TAIL = 4096;

/** ffmpeg and (optionally) ffprobe, used by stream downloads. */
export interface StreamTools {
  ffmpeg: string;
  ffprobe: string | null;
}

export interface ToolResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a tool with separate arguments (never through a shell). Resolves with
 * stdout and the tail of stderr; rejects with signal.reason when aborted.
 */
export function runTool(file: string, args: string[], { signal }: { signal?: AbortSignal } = {}): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    const onAbort = (): void => killTree(child);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(signal.reason);
      else resolve({ code, stdout, stderr: stderr.trim() });
    });
  });
}

export interface RemuxInput {
  file: string;
  /** Stream specifiers for -map, e.g. ['v'], ['a'] or ['v?', 'a?']. */
  maps: string[];
}

/** Remuxes tracks into one file without re-encoding (-c copy). */
export async function remux({ ffmpeg, inputs, output, format, signal }: {
  ffmpeg: string;
  inputs: RemuxInput[];
  output: string;
  format: string;
  signal?: AbortSignal;
}): Promise<void> {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];
  for (const input of inputs) args.push('-i', input.file);
  inputs.forEach((input, index) => {
    for (const map of input.maps) args.push('-map', `${index}:${map}`);
  });
  args.push('-c', 'copy');
  if (format === 'mp4') args.push('-movflags', '+faststart');
  args.push('-f', format, output);
  const { code, stderr } = await runTool(ffmpeg, args, signal ? { signal } : {});
  if (code !== 0) {
    // Windows reports FFmpeg's negative error codes as large unsigned numbers; its message says more.
    const last = stderr.split(/\r?\n/).filter(Boolean).pop();
    throw new Error(`FFmpeg falhou: ${last || `código ${code}`}`);
  }
}

export interface ProbedStream {
  codec_type?: string;
  codec_name?: string;
}

/** Lists the streams of a media file with ffprobe. */
export async function probeStreams({ ffprobe, file, signal }: {
  ffprobe: string;
  file: string;
  signal?: AbortSignal;
}): Promise<ProbedStream[]> {
  const { code, stdout, stderr } = await runTool(ffprobe, [
    '-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', file,
  ], signal ? { signal } : {});
  if (code !== 0) throw new Error(`ffprobe não conseguiu ler o arquivo final${stderr ? `: ${stderr}` : ''}`);
  try {
    return (JSON.parse(stdout) as { streams?: ProbedStream[] }).streams ?? [];
  } catch {
    throw new Error('Resposta inválida do ffprobe');
  }
}
