'use strict';

// Runs the real yt-dlp from bin/ against the local test server (no internet).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { VideoDownload } = require('../src/engine/video-download');
const { DownloadManager } = require('../src/engine/download-manager');
const { startFileServer } = require('./helpers/file-server');

const BIN = path.join(__dirname, '..', 'bin');
const YTDLP = path.join(BIN, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const available = fs.existsSync(YTDLP);
const tools = { ytdlp: YTDLP, ffmpegDir: BIN, jsRuntime: process.execPath, env: {} };
const settings = { maxConnections: 4, speedLimitKBps: 0, videoQuality: 'best' };

let server;
let tmpRoot;

before(async () => {
  server = await startFileServer({ size: 4 * 1024 * 1024, bytesPerSecond: 1024 * 1024 });
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'md-video-'));
});

after(async () => {
  await server.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const newDir = () => fs.mkdtempSync(path.join(tmpRoot, 'd-'));

function makeVideo(url) {
  return new VideoDownload(
    { id: crypto.randomUUID(), url, dir: newDir(), quality: 'best' },
    { tools, getSettings: () => settings },
  );
}

test('downloads a video through yt-dlp and reports progress', { skip: !available && 'bin/yt-dlp ausente' }, async () => {
  const d = makeVideo(`${server.base}/clip.mp4`);
  let sawProgress = false;
  d.on('change', () => {});
  const timer = setInterval(() => {
    if (d.downloaded > 0 && d.downloaded < server.body.length) sawProgress = true;
  }, 100);
  await d.start();
  clearInterval(timer);
  assert.equal(d.state.status, 'completed', d.state.error);
  assert.equal(sha256(d.state.filePath), server.sha);
  assert.equal(d.state.totalSize, server.body.length);
  assert.ok(sawProgress, 'expected intermediate progress');
});

test('pauses and resumes a video download', { skip: !available && 'bin/yt-dlp ausente' }, async () => {
  const d = makeVideo(`${server.base}/clip.mp4`);
  const running = d.start();
  for (let i = 0; i < 100 && d.downloaded < 512 * 1024; i++) await new Promise((r) => setTimeout(r, 100));
  await d.pause();
  await running;
  assert.equal(d.state.status, 'paused');
  const partial = d.downloaded;
  assert.ok(partial > 0 && partial < server.body.length, `partial=${partial}`);

  // Resume from the persisted state, as after an app restart.
  const resumed = new VideoDownload(JSON.parse(JSON.stringify(d.toJSON())), { tools, getSettings: () => settings });
  const before = server.stats.ranges.length;
  await resumed.start();
  assert.equal(resumed.state.status, 'completed', resumed.state.error);
  assert.equal(sha256(resumed.state.filePath), server.sha);
  assert.ok(server.stats.ranges.slice(before).some(([start]) => start > 0), 'resume should continue the partial file');
});

test('a link that opens a page with a player becomes a video download', { skip: !available && 'bin/yt-dlp ausente' }, async () => {
  const manager = new DownloadManager({ storeDir: newDir(), defaultDownloadDir: newDir(), videoTools: tools });
  const id = manager.add({ url: `${server.base}/player` });
  const final = await new Promise((resolve) => {
    manager.on('update', (list) => {
      const d = list.find((x) => x.id === id);
      if (d && (d.status === 'completed' || (d.status === 'error' && d.kind === 'video'))) resolve(d);
    });
  });
  await manager.shutdown();
  assert.equal(final.kind, 'video');
  assert.equal(final.status, 'completed', final.error);
  assert.equal(sha256(final.filePath), server.sha);
});

test('video page hosts go straight to yt-dlp', () => {
  const manager = new DownloadManager({ storeDir: newDir(), defaultDownloadDir: newDir(), videoTools: tools });
  manager.updateSettings({ maxConcurrent: 1 });
  const paused = { startPaused: true };
  const yt = manager.add({ url: 'https://www.youtube.com/shorts/q_rpXntVlE4', quality: '720', ...paused });
  const file = manager.add({ url: 'https://example.com/a.zip', ...paused });
  const view = Object.fromEntries(manager.list().map((d) => [d.id, d]));
  assert.equal(view[yt].kind, 'video');
  assert.equal(view[yt].quality, '720');
  assert.equal(view[file].kind, 'file');
  clearInterval(manager.timer);
});
