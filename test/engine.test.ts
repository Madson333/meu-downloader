import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SegmentedDownload } from '../src/engine/segmented-download';
import { SpeedLimiter } from '../src/engine/speed-limiter';
import { DownloadManager } from '../src/engine/download-manager';
import { fromContentDisposition, sanitize } from '../src/engine/file-name';
import { startFileServer, type FileServer } from './helpers/file-server';

let server: FileServer;
let tmpRoot: string;

before(async () => {
  server = await startFileServer();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'md-test-'));
});

after(async () => {
  await server.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function sha256(file: string | null | undefined): string {
  assert.ok(file, 'expected a file path');
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function newDir(): string {
  return fs.mkdtempSync(path.join(tmpRoot, 'd-'));
}

interface MakeOptions {
  dir?: string;
  headers?: Record<string, string>;
  limiter?: SpeedLimiter;
  connections?: number;
  minSplitBytes?: number;
}

function makeDownload(url: string, opts: MakeOptions = {}): SegmentedDownload {
  return new SegmentedDownload(
    { id: crypto.randomUUID(), url, dir: opts.dir ?? newDir(), headers: opts.headers ?? {} },
    {
      limiter: opts.limiter ?? new SpeedLimiter(0),
      getMaxConnections: () => opts.connections ?? 8,
      minSplitBytes: opts.minSplitBytes ?? 64 * 1024,
    },
  );
}

test('downloads a ranged file over several dynamic segments', async () => {
  const before = server.stats.ranges.length;
  const d = makeDownload(`${server.base}/file`);
  await d.start();
  assert.equal(d.state.status, 'completed', d.state.error ?? undefined);
  assert.equal(sha256(d.state.filePath), server.sha);
  assert.ok(server.stats.ranges.length - before > 1, 'expected more than one ranged request');
  assert.ok(!fs.existsSync(`${d.state.filePath}.mdpart`));
});

test('uses parallel connections up to the configured maximum', async () => {
  server.stats.maxConcurrent = 0;
  const d = makeDownload(`${server.base}/slow`, { connections: 4 });
  await d.start();
  assert.equal(d.state.status, 'completed', d.state.error ?? undefined);
  assert.equal(sha256(d.state.filePath), server.sha);
  assert.ok(server.stats.maxConcurrent >= 3, `max concurrent was ${server.stats.maxConcurrent}`);
  assert.ok(server.stats.maxConcurrent <= 4, `max concurrent was ${server.stats.maxConcurrent}`);
  const segments = d.state.segments;
  for (let i = 1; i < segments.length; i++) assert.equal(segments[i]?.start, (segments[i - 1]?.end ?? 0) + 1);
});

test('pauses and resumes from the persisted segments', async () => {
  const d = makeDownload(`${server.base}/slow`, { connections: 4 });
  const running = d.start();
  await new Promise<void>((r) => setTimeout(r, 700));
  await d.pause();
  await running;
  assert.equal(d.state.status, 'paused');
  const saved = JSON.parse(JSON.stringify(d.toJSON()));
  const partial = saved.segments.reduce((sum: number, s: { start: number; pos: number }) => sum + s.pos - s.start, 0);
  assert.ok(partial > 0 && partial < server.body.length, `partial=${partial}`);

  // A new object built from the saved state continues instead of restarting.
  const resumed = new SegmentedDownload(saved, {
    limiter: new SpeedLimiter(0),
    getMaxConnections: () => 4,
    minSplitBytes: 64 * 1024,
  });
  const firstRequest = server.stats.ranges.length;
  await resumed.start();
  assert.equal(resumed.state.status, 'completed', resumed.state.error ?? undefined);
  assert.equal(sha256(resumed.state.filePath), server.sha);
  const resumedRanges = server.stats.ranges.slice(firstRequest);
  assert.ok(resumedRanges.every(([start]) => start > 0), 'resume must not request from byte 0');
});

test('falls back to one connection when the server ignores Range', async () => {
  const d = makeDownload(`${server.base}/norange`);
  await d.start();
  assert.equal(d.state.status, 'completed', d.state.error ?? undefined);
  assert.equal(d.state.resumable, false);
  assert.equal(d.state.segments.length, 1);
  assert.equal(sha256(d.state.filePath), server.sha);
});

test('handles unknown size streams', async () => {
  const d = makeDownload(`${server.base}/chunked`);
  await d.start();
  assert.equal(d.state.status, 'completed', d.state.error ?? undefined);
  assert.equal(d.state.totalSize, server.body.length);
  assert.equal(sha256(d.state.filePath), server.sha);
});

test('follows redirects and uses the Content-Disposition name', async () => {
  const d = makeDownload(`${server.base}/redirect`);
  await d.start();
  assert.equal(d.state.status, 'completed', d.state.error ?? undefined);
  assert.equal(d.state.fileName, 'relatório final.bin');
  assert.equal(d.state.finalUrl, `${server.base}/named`);
});

test('retries dropped connections without corrupting the file', async () => {
  const d = makeDownload(`${server.base}/flaky`, { connections: 4 });
  await d.start();
  assert.equal(d.state.status, 'completed', d.state.error ?? undefined);
  assert.equal(sha256(d.state.filePath), server.sha);
});

test('reports HTTP errors', async () => {
  const d = makeDownload(`${server.base}/missing`);
  await d.start();
  assert.equal(d.state.status, 'error');
  assert.match(d.state.error ?? '', /404/);
});

test('refuses web pages instead of saving them as files', async () => {
  const d = makeDownload(`${server.base}/watch?v=abc`);
  await d.start();
  assert.equal(d.state.status, 'error');
  assert.match(d.state.error ?? '', /página web/);
  assert.deepEqual(fs.readdirSync(d.state.dir), []);
});

test('still downloads links that name an HTML file', async () => {
  const d = makeDownload(`${server.base}/page.html`);
  await d.start();
  assert.equal(d.state.status, 'completed', d.state.error ?? undefined);
  assert.equal(d.state.fileName, 'page.html');
});

test('speed limiter bounds throughput', async () => {
  const limiter = new SpeedLimiter(2 * 1024 * 1024);
  const started = Date.now();
  const d = makeDownload(`${server.base}/file`, { limiter });
  await d.start();
  const seconds = (Date.now() - started) / 1000;
  assert.equal(d.state.status, 'completed', d.state.error ?? undefined);
  // 6 MiB at 2 MiB/s with a 1 s burst allowance takes at least ~2 s.
  assert.ok(seconds >= 1.8, `took ${seconds}s`);
});

test('manager queues downloads and persists them', async () => {
  const storeDir = newDir();
  const manager = new DownloadManager({ storeDir, defaultDownloadDir: newDir() });
  manager.updateSettings({ maxConcurrent: 1 });
  const ids = [manager.add({ url: `${server.base}/file` }), manager.add({ url: `${server.base}/named` })];
  await new Promise<void>((resolve) => {
    manager.on('update', (list) => {
      const running = list.filter((d) => d.status === 'downloading').length;
      assert.ok(running <= 1, 'maxConcurrent exceeded');
      if (list.every((d) => d.status === 'completed')) resolve();
    });
  });
  await manager.shutdown();
  const saved = JSON.parse(fs.readFileSync(path.join(storeDir, 'downloads.json'), 'utf8')) as { id: string; status: string }[];
  assert.deepEqual(saved.map((d) => d.id).sort(), ids.sort());
  assert.ok(saved.every((d) => d.status === 'completed'));
});

test('file name helpers', () => {
  assert.equal(fromContentDisposition('attachment; filename="a \\"b\\".zip"'), 'a "b".zip');
  assert.equal(fromContentDisposition("inline; filename*=UTF-8''%E2%82%AC%20rates.pdf"), '€ rates.pdf');
  assert.equal(sanitize('con.txt'), '_con.txt');
  assert.equal(sanitize('a<b>:c?.exe'), 'a_b__c_.exe');
});
