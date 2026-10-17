// Stream downloads against a local server. Tests marked "ffmpeg" generate real
// media with bin/ffmpeg and are skipped when it is missing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { StreamDownload } from '../src/engine/stream-download';
import { SpeedLimiter } from '../src/engine/speed-limiter';
import { DownloadManager } from '../src/engine/download-manager';
import { request } from '../src/engine/http-client';
import { probeStreams, type StreamTools } from '../src/engine/ffmpeg';
import { startStreamServer, type RouteOptions, type StreamServer } from './helpers/stream-server';
import type { DownloadView, Quality } from '../src/shared/api';

const BIN = path.join(__dirname, '..', '..', 'bin');
const exe = (name: string): string => path.join(BIN, process.platform === 'win32' ? `${name}.exe` : name);
const FFMPEG = exe('ffmpeg');
const FFPROBE = exe('ffprobe');
const hasFfmpeg = fs.existsSync(FFMPEG) && fs.existsSync(FFPROBE);
const tools: StreamTools | null = hasFfmpeg ? { ffmpeg: FFMPEG, ffprobe: FFPROBE } : null;
const noFfmpeg = !hasFfmpeg && 'bin/ffmpeg ausente';

let server: StreamServer;
let tmpRoot: string;

before(async () => {
  server = await startStreamServer();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'md-stream-'));
});

after(async () => {
  await server.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const newDir = (): string => fs.mkdtempSync(path.join(tmpRoot, 'd-'));
const sha = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex');

/** The final file of a finished download, failing the test when there is none. */
function output(d: { state: { filePath?: string | null } } | DownloadView): string {
  const file = 'state' in d ? d.state.filePath : d.filePath;
  assert.ok(file, 'expected a final file');
  return file;
}

interface StreamTestOptions {
  quality?: Quality;
  connections?: number;
  withTools?: StreamTools | null;
  headers?: Record<string, string>;
  dir?: string;
}

function makeStream(url: string, { quality = 'best', connections = 4, withTools = null, headers = {}, dir = newDir() }: StreamTestOptions = {}): StreamDownload {
  return new StreamDownload(
    { id: crypto.randomUUID(), url, dir, quality, headers },
    { limiter: new SpeedLimiter(0), getMaxConnections: () => connections, tools: withTools },
  );
}

/** Registers `count` random segments under prefix and returns them. */
function addSegments(prefix: string, count: number, { size = 40 * 1024, ext = 'ts', ...options }: RouteOptions & { size?: number; ext?: string } = {}): Buffer[] {
  return Array.from({ length: count }, (_, i) => {
    const body = crypto.randomBytes(size);
    server.set(`${prefix}/seg${i}.${ext}`, body, options);
    return body;
  });
}

function mediaPlaylist(count: number, { ext = 'ts', extra = '', live = false, names = null }: { ext?: string; extra?: string; live?: boolean; names?: string[] | null } = {}): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', extra];
  for (let i = 0; i < count; i++) lines.push('#EXTINF:2.0,', names?.[i] ?? `seg${i}.${ext}`);
  if (!live) lines.push('#EXT-X-ENDLIST');
  return lines.filter(Boolean).join('\n');
}

test('HLS media playlist: downloads every segment and keeps their order', async () => {
  const segs = addSegments('/a', 12);
  server.set('/a/index.m3u8', mediaPlaylist(12));
  const d = makeStream(`${server.base}/a/index.m3u8`);
  await d.start();
  assert.equal(d.state.status, 'completed', d.state.error ?? undefined);
  assert.equal(path.extname(output(d)), '.ts');
  assert.equal(sha(fs.readFileSync(output(d))), sha(Buffer.concat(segs)));
  assert.deepEqual(d.state.chunks, { done: 12, total: 12 });
  assert.equal(d.state.totalSize, Buffer.concat(segs).length);
  assert.ok(!fs.existsSync(d.tempDir), 'temporary folder must be removed');
  assert.ok(d.state.notices.some((n) => /FFmpeg não encontrado/.test(n)));
});

test('HLS master playlist: downloads only the variant of the requested quality', async () => {
  const variants: Record<number, Buffer[]> = {};
  for (const h of [360, 720, 1080]) {
    variants[h] = addSegments(`/b/${h}`, 3);
    server.set(`/b/${h}/index.m3u8`, mediaPlaylist(3));
  }
  server.set('/b/master.m3u8', [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    '360/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720',
    '720/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
    '1080/index.m3u8',
  ].join('\n'));

  const before = server.log.length;
  const d = makeStream(`${server.base}/b/master.m3u8`, { quality: '720' });
  await d.start();
  assert.equal(d.state.status, 'completed', d.state.error ?? undefined);
  assert.equal(sha(fs.readFileSync(output(d))), sha(Buffer.concat(variants[720])));
  assert.match(d.state.selection?.video ?? '', /^720p/);
  const fetched = server.log.slice(before).map((r) => r.path).filter((p) => p.endsWith('.ts'));
  assert.ok(fetched.every((p) => p.startsWith('/b/720/')), fetched.join(','));
  assert.equal(d.state.fileName, 'b.ts');

  const fallback = makeStream(`${server.base}/b/master.m3u8`, { quality: '1440' });
  await fallback.start();
  assert.equal(fallback.state.status, 'completed', fallback.state.error ?? undefined);
  assert.match(fallback.state.selection?.video ?? '', /^1080p/);
  assert.ok(fallback.state.notices.some((n) => /1440p não está disponível; usado 1080p/.test(n)));
});

test('HLS byte ranges are requested and joined exactly', async () => {
  const file = crypto.randomBytes(300 * 1024);
  server.set('/c/all.ts', file);
  server.set('/c/index.m3u8', [
    '#EXTM3U', '#EXT-X-VERSION:4', '#EXT-X-TARGETDURATION:2',
    '#EXTINF:2,', '#EXT-X-BYTERANGE:100000@0', 'all.ts',
    '#EXTINF:2,', '#EXT-X-BYTERANGE:100000', 'all.ts',
    '#EXTINF:2,', '#EXT-X-BYTERANGE:107200@200000', 'all.ts',
    '#EXT-X-ENDLIST',
  ].join('\n'));
  const before = server.log.length;
  const d = makeStream(`${server.base}/c/index.m3u8`);
  await d.start();
  assert.equal(d.state.status, 'completed', d.state.error ?? undefined);
  assert.equal(sha(fs.readFileSync(output(d))), sha(file));
  const ranges = server.log.slice(before).filter((r) => r.path === '/c/all.ts').map((r) => r.range).sort();
  assert.deepEqual(ranges, ['bytes=0-99999', 'bytes=100000-199999', 'bytes=200000-307199']);
  assert.equal(d.state.sizeEstimated, false);
});

/** A minimal, unencrypted MP4 init segment (ftyp + moov). */
function fakeInit(sampleEntry = 'avc1'): Buffer {
  const box = (type: string, payload: Buffer = Buffer.alloc(0)): Buffer => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + payload.length, 0);
    header.write(type, 4, 'latin1');
    return Buffer.concat([header, payload]);
  };
  return Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', box('trak', box(sampleEntry)))]);
}

test('HLS fMP4: the EXT-X-MAP init segment comes first', async () => {
  const init = fakeInit();
  server.set('/d/init.mp4', init);
  const segs = addSegments('/d', 3, { ext: 'm4s' });
  server.set('/d/index.m3u8', mediaPlaylist(3, { ext: 'm4s', extra: '#EXT-X-MAP:URI="init.mp4"' }));
  const d = makeStream(`${server.base}/d/index.m3u8`);
  await d.start();
  assert.equal(d.state.status, 'completed', d.state.error ?? undefined);
  assert.equal(path.extname(output(d)), '.mp4');
  assert.equal(sha(fs.readFileSync(output(d))), sha(Buffer.concat([init, ...segs])));
});

test('HLS AES-128 segments are decrypted with the key from the manifest', async () => {
  const key = crypto.randomBytes(16);
  server.set('/e/key.bin', key);
  const plain = [];
  for (let i = 0; i < 4; i++) {
    const body = crypto.randomBytes(30 * 1000 + i);
    plain.push(body);
    const iv = Buffer.alloc(16);
    iv.writeUInt32BE(7 + i, 12); // media sequence starts at 7
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    server.set(`/e/seg${i}.ts`, Buffer.concat([cipher.update(body), cipher.final()]));
  }
  server.set('/e/index.m3u8', mediaPlaylist(4, { extra: '#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"' }));
  const d = makeStream(`${server.base}/e/index.m3u8`);
  await d.start();
  assert.equal(d.state.status, 'completed', d.state.error ?? undefined);
  assert.equal(sha(fs.readFileSync(output(d))), sha(Buffer.concat(plain)));
  assert.equal(server.requests('/e/key.bin').length, 1, 'the key is fetched once');
});

test('temporary HTTP failures are retried', async () => {
  const segs = addSegments('/f', 3);
  server.set('/f/seg1.ts', segs[1], { failTimes: 2, failStatus: 503 });
  server.set('/f/index.m3u8', mediaPlaylist(3));
  const d = makeStream(`${server.base}/f/index.m3u8`);
  await d.start();
  assert.equal(d.state.status, 'completed', d.state.error ?? undefined);
  assert.equal(sha(fs.readFileSync(output(d))), sha(Buffer.concat(segs)));
  assert.equal(server.requests('/f/seg1.ts').length, 3);
});

test('a missing segment fails with a clear message and can be resumed later', async () => {
  const segs = addSegments('/g', 5);
  server.set('/g/seg2.ts', null, { status: 404 });
  server.set('/g/index.m3u8', mediaPlaylist(5));
  const d = makeStream(`${server.base}/g/index.m3u8`, { connections: 1 });
  await d.start();
  assert.equal(d.state.status, 'error');
  assert.match(d.state.error ?? '', /Segmento 3 de 5: O servidor respondeu HTTP 404/);

  // Once the server has it, resuming downloads only what is missing.
  server.set('/g/seg2.ts', segs[2]);
  const before = server.requests('/g/seg0.ts').length;
  const resumed = new StreamDownload(JSON.parse(JSON.stringify(d.toJSON())), {
    limiter: new SpeedLimiter(0), getMaxConnections: () => 2, tools: null,
  });
  await resumed.start();
  assert.equal(resumed.state.status, 'completed', resumed.state.error ?? undefined);
  assert.equal(server.requests('/g/seg0.ts').length, before, 'finished segments are not downloaded again');
  assert.equal(sha(fs.readFileSync(output(resumed))), sha(Buffer.concat(segs)));
});

test('pauses and resumes from the persisted state', async () => {
  const segs = addSegments('/h', 30, { size: 20 * 1024, delayMs: 60 });
  server.set('/h/index.m3u8', mediaPlaylist(30));
  const d = makeStream(`${server.base}/h/index.m3u8`, { connections: 2 });
  const running = d.start();
  for (let i = 0; i < 100 && d.state.chunks.done < 6; i++) await new Promise<void>((r) => setTimeout(r, 50));
  await d.pause();
  await running;
  assert.equal(d.state.status, 'paused');
  const saved = JSON.parse(JSON.stringify(d.toJSON()));
  assert.ok(saved.downloadedBytes > 0 && saved.downloadedBytes < 30 * 20 * 1024, `downloaded=${saved.downloadedBytes}`);
  const done = d.state.chunks.done;
  assert.ok(done > 0 && done < 30, `done=${done}`);

  const before = server.requests('/h/seg').length;
  const resumed = new StreamDownload(saved, { limiter: new SpeedLimiter(0), getMaxConnections: () => 4, tools: null });
  await resumed.start();
  assert.equal(resumed.state.status, 'completed', resumed.state.error ?? undefined);
  assert.equal(sha(fs.readFileSync(output(resumed))), sha(Buffer.concat(segs)));
  assert.ok(server.requests('/h/seg').length - before <= 30 - done + 2, 'only missing segments are fetched');
});

test('a manifest that changed while paused restarts the download', async () => {
  addSegments('/i', 20, { size: 10 * 1024, delayMs: 50 });
  server.set('/i/index.m3u8', mediaPlaylist(20));
  const d = makeStream(`${server.base}/i/index.m3u8`, { connections: 1 });
  const running = d.start();
  for (let i = 0; i < 100 && d.state.chunks.done < 2; i++) await new Promise<void>((r) => setTimeout(r, 50));
  await d.pause();
  await running;

  const fresh = Array.from({ length: 4 }, (_, i) => {
    const body = crypto.randomBytes(8 * 1024);
    server.set(`/i/new${i}.ts`, body);
    return body;
  });
  server.set('/i/index.m3u8', mediaPlaylist(4, { names: fresh.map((_, i) => `new${i}.ts`) }));
  const resumed = new StreamDownload(JSON.parse(JSON.stringify(d.toJSON())), {
    limiter: new SpeedLimiter(0), getMaxConnections: () => 4, tools: null,
  });
  await resumed.start();
  assert.equal(resumed.state.status, 'completed', resumed.state.error ?? undefined);
  assert.ok(resumed.state.notices.some((n) => /mudou/.test(n)));
  assert.equal(sha(fs.readFileSync(output(resumed))), sha(Buffer.concat(fresh)));
});

test('DRM-protected and live streams are refused', async () => {
  server.set('/j/fairplay.m3u8', mediaPlaylist(1, {
    extra: '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"',
  }));
  const drm = makeStream(`${server.base}/j/fairplay.m3u8`);
  await drm.start();
  assert.equal(drm.state.status, 'error');
  assert.equal(drm.state.errorCode, 'DRM');
  assert.match(drm.state.error ?? '', /DRM/);
  assert.ok(!fs.existsSync(drm.tempDir));

  // Encryption declared only inside the MP4 init segment.
  server.set('/j/init.mp4', fakeInit('encv'));
  addSegments('/j', 2, { ext: 'm4s' });
  server.set('/j/cenc.m3u8', mediaPlaylist(2, { ext: 'm4s', extra: '#EXT-X-MAP:URI="init.mp4"' }));
  const cenc = makeStream(`${server.base}/j/cenc.m3u8`);
  await cenc.start();
  assert.equal(cenc.state.status, 'error');
  assert.equal(cenc.state.errorCode, 'DRM');

  server.set('/j/mpd.mpd', '<MPD type="static" mediaPresentationDuration="PT4S"><Period><AdaptationSet contentType="video"><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/><Representation id="v" bandwidth="1"><BaseURL>v.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>');
  const dash = makeStream(`${server.base}/j/mpd.mpd`);
  await dash.start();
  assert.equal(dash.state.errorCode, 'DRM');

  addSegments('/j/live', 2);
  server.set('/j/live/index.m3u8', mediaPlaylist(2, { live: true }));
  const live = makeStream(`${server.base}/j/live/index.m3u8`);
  await live.start();
  assert.equal(live.state.status, 'error');
  assert.equal(live.state.errorCode, 'LIVE');
  assert.match(live.state.error ?? '', /ao vivo/);
});

test('cookies are sent only to the manifest host', async () => {
  const segs = addSegments('/k', 4);
  // Two segments are addressed through another host name for the same server.
  const names = segs.map((_, i) => (i % 2 ? `http://localhost:${server.port}/k/seg${i}.ts` : `seg${i}.ts`));
  server.set('/k/index.m3u8', mediaPlaylist(4, { names }));
  const before = server.log.length;
  const d = makeStream(`${server.base}/k/index.m3u8`, { headers: { cookie: 'session=secret' } });
  await d.start();
  assert.equal(d.state.status, 'completed', d.state.error ?? undefined);
  const requests = server.log.slice(before).filter((r) => r.path.startsWith('/k/'));
  for (const r of requests) {
    if (r.host?.startsWith('localhost')) assert.equal(r.cookie, null, `${r.host}${r.path} received the cookie`);
    else assert.equal(r.cookie, 'session=secret');
  }
  assert.ok(requests.some((r) => r.host?.startsWith('localhost')));
});

test('a public manifest cannot reach internal addresses', async () => {
  await assert.rejects(request(`${server.base}/a/index.m3u8`, { blockPrivate: true }), (err: unknown) => (err as { code?: string }).code === 'BLOCKED_ADDRESS');
  await assert.rejects(
    request(`http://localhost:${server.port}/a/index.m3u8`, { blockPrivate: true }),
    (err: unknown) => (err as { code?: string }).code === 'BLOCKED_ADDRESS',
  );
});

test('WebVTT subtitles are joined and saved next to the video', async () => {
  const segs = addSegments('/l', 2);
  server.set('/l/v.m3u8', mediaPlaylist(2));
  server.set('/l/sub0.vtt', 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:00:00.000 --> 00:00:01.000\nOlá\n');
  server.set('/l/sub1.vtt', 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:00:02.000 --> 00:00:03.000\nMundo\n');
  server.set('/l/subs.m3u8', mediaPlaylist(2, { names: ['sub0.vtt', 'sub1.vtt'] }));
  server.set('/l/master.m3u8', [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Português",LANGUAGE="pt",URI="subs.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=320x240,SUBTITLES="s"',
    'v.m3u8',
  ].join('\n'));
  const d = makeStream(`${server.base}/l/master.m3u8`);
  await d.start();
  assert.equal(d.state.status, 'completed', d.state.error ?? undefined);
  assert.equal(sha(fs.readFileSync(output(d))), sha(Buffer.concat(segs)));
  assert.deepEqual(d.state.selection?.subtitles, ['Português']);
  const vtt = fs.readFileSync(path.join(d.state.dir, 'l.pt.vtt'), 'utf8');
  assert.equal(vtt.match(/WEBVTT/g)?.length, 1);
  assert.match(vtt, /Olá[\s\S]*00:00:02.000 --> 00:00:03.000\nMundo/);
});

test('DASH audio-only quality saves the audio representation', async () => {
  const init = fakeInit('mp4a');
  server.set('/m/a/init.mp4', init);
  const segs = [1, 2, 3].map((n) => {
    const body = crypto.randomBytes(5000);
    server.set(`/m/a/${n}.m4s`, body);
    return body;
  });
  addSegments('/m/v', 3, { ext: 'm4s' });
  server.set('/m/manifest.mpd', `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT6S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v" bandwidth="1000000" width="640" height="360">
        <SegmentTemplate media="v/seg$Number$.m4s" startNumber="0" duration="2" timescale="1"/>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="pt">
      <Representation id="a" bandwidth="128000">
        <SegmentTemplate initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Number$.m4s" duration="2" timescale="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`);
  const d = makeStream(`${server.base}/m/manifest.mpd`, { quality: 'audio' });
  await d.start();
  assert.equal(d.state.status, 'completed', d.state.error ?? undefined);
  assert.equal(d.state.protocol, 'dash');
  assert.equal(path.extname(output(d)), '.m4a');
  assert.equal(sha(fs.readFileSync(output(d))), sha(Buffer.concat([init, ...segs])));
});

// ---------------------------------------------------------------- manager

function waitFor(manager: DownloadManager, id: string, predicate: (d: DownloadView) => boolean): Promise<DownloadView> {
  return new Promise((resolve) => {
    const check = (list: DownloadView[]): void => {
      const d = list.find((x) => x.id === id);
      if (d && predicate(d)) {
        manager.off('update', check);
        resolve(d);
      }
    };
    manager.on('update', check);
  });
}

test('manager: .m3u8 links and manifests without extension become streams', async () => {
  const segs = addSegments('/n', 3);
  server.set('/n/index.m3u8', mediaPlaylist(3));
  server.set('/n/play', mediaPlaylist(3), { type: 'application/vnd.apple.mpegurl' });
  const manager = new DownloadManager({ storeDir: newDir(), defaultDownloadDir: newDir() });
  const direct = manager.add({ url: `${server.base}/n/index.m3u8` });
  assert.equal(manager.list().find((d) => d.id === direct)?.kind, 'stream');
  const sniffed = manager.add({ url: `${server.base}/n/play` });
  assert.equal(manager.list().find((d) => d.id === sniffed)?.kind, 'file');

  const [a, b] = await Promise.all([
    waitFor(manager, direct, (d) => ['completed', 'error'].includes(d.status)),
    waitFor(manager, sniffed, (d) => d.kind === 'stream' && ['completed', 'error'].includes(d.status)),
  ]);
  await manager.shutdown();
  for (const d of [a, b]) {
    assert.equal(d.status, 'completed', d.error ?? undefined);
    assert.equal(sha(fs.readFileSync(output(d))), sha(Buffer.concat(segs)));
  }
});

test('manager: a plain M3U list is saved as a file, not treated as a stream', async () => {
  const list = '#EXTM3U\n#EXTINF:-1,Canal\nhttp://iptv.example/1\n';
  server.set('/o/canais.m3u8', list, { type: 'application/vnd.apple.mpegurl' });
  const manager = new DownloadManager({ storeDir: newDir(), defaultDownloadDir: newDir() });
  const id = manager.add({ url: `${server.base}/o/canais.m3u8` });
  const d = await waitFor(manager, id, (x) => x.kind === 'file' && ['completed', 'error'].includes(x.status));
  await manager.shutdown();
  assert.equal(d.status, 'completed', d.error ?? undefined);
  assert.equal(fs.readFileSync(output(d), 'utf8'), list);
});

test('manager: cancelling a stream removes its temporary files', async () => {
  addSegments('/p', 40, { size: 10 * 1024, delayMs: 80 });
  server.set('/p/index.m3u8', mediaPlaylist(40));
  const dir = newDir();
  const manager = new DownloadManager({ storeDir: newDir(), defaultDownloadDir: dir });
  const id = manager.add({ url: `${server.base}/p/index.m3u8` });
  await waitFor(manager, id, (d) => (d.chunks?.done ?? 0) > 2);
  const download = manager.downloads.get(id);
  assert.ok(download instanceof StreamDownload);
  const temp = download.tempDir;
  assert.ok(fs.existsSync(temp));
  await manager.remove(id);
  await manager.shutdown();
  assert.ok(!fs.existsSync(temp));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('manager: a stream interrupted by shutdown continues on the next launch', async () => {
  const segs = addSegments('/q', 30, { size: 10 * 1024, delayMs: 50 });
  server.set('/q/index.m3u8', mediaPlaylist(30));
  const storeDir = newDir();
  const first = new DownloadManager({ storeDir, defaultDownloadDir: newDir() });
  const id = first.add({ url: `${server.base}/q/index.m3u8`, quality: '720' });
  await waitFor(first, id, (d) => (d.chunks?.done ?? 0) > 3);
  await first.shutdown();

  const saved = JSON.parse(fs.readFileSync(path.join(storeDir, 'downloads.json'), 'utf8'));
  assert.equal(saved[0].kind, 'stream');
  assert.equal(saved[0].status, 'queued');
  assert.equal(saved[0].quality, '720');

  const second = new DownloadManager({ storeDir, defaultDownloadDir: newDir() });
  const done = waitFor(second, id, (d) => ['completed', 'error'].includes(d.status));
  second.startQueued();
  const d = await done;
  await second.shutdown();
  assert.equal(d.status, 'completed', d.error ?? undefined);
  assert.equal(sha(fs.readFileSync(output(d))), sha(Buffer.concat(segs)));
});

// ---------------------------------------------------------------- ffmpeg

/** Runs ffmpeg inside dir with relative output names: some builds write segments to the cwd. */
function ffmpeg(dir: string, args: string[]): void {
  const result = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', cwd: dir });
  assert.equal(result.status, 0, result.stderr);
}

const VIDEO_IN = ['-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=25'];
const AUDIO_IN = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=4'];
const H264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-pix_fmt', 'yuv420p'];

async function streamTypes(file: string): Promise<(string | undefined)[]> {
  return (await probeStreams({ ffprobe: FFPROBE, file })).map((s) => s.codec_type).sort();
}

test('ffmpeg: HLS with a separate audio rendition becomes one MP4', { skip: noFfmpeg }, async () => {
  const dir = newDir();
  ffmpeg(dir, [...VIDEO_IN, ...H264, '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', 'v%03d.ts', 'video.m3u8']);
  ffmpeg(dir, [...AUDIO_IN, '-c:a', 'aac', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', 'a%03d.ts', 'audio.m3u8']);
  fs.writeFileSync(path.join(dir, 'master.m3u8'), [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Principal",LANGUAGE="pt",DEFAULT=YES,URI="audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x240,CODECS="avc1.42c00d,mp4a.40.2",AUDIO="aud"',
    'video.m3u8',
  ].join('\n'));
  server.serveDir('/ff1/', dir);

  const d = makeStream(`${server.base}/ff1/master.m3u8`, { withTools: tools });
  await d.start();
  assert.equal(d.state.status, 'completed', d.state.error ?? undefined);
  assert.equal(path.extname(output(d)), '.mp4');
  assert.deepEqual(await streamTypes(output(d)), ['audio', 'video']);
  assert.match(d.state.selection?.audio ?? '', /Principal/);

  const audio = makeStream(`${server.base}/ff1/master.m3u8`, { withTools: tools, quality: 'audio' });
  await audio.start();
  assert.equal(audio.state.status, 'completed', audio.state.error ?? undefined);
  assert.equal(path.extname(output(audio)), '.m4a');
  assert.deepEqual(await streamTypes(output(audio)), ['audio']);
});

test('ffmpeg: fMP4 HLS with muxed audio and video', { skip: noFfmpeg }, async () => {
  const dir = newDir();
  ffmpeg(dir, [...VIDEO_IN, ...AUDIO_IN, ...H264, '-c:a', 'aac', '-shortest', '-f', 'hls', '-hls_time', '1',
    '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', 'f%03d.m4s', 'index.m3u8']);
  server.serveDir('/ff2/', dir);
  const d = makeStream(`${server.base}/ff2/index.m3u8`, { withTools: tools });
  await d.start();
  assert.equal(d.state.status, 'completed', d.state.error ?? undefined);
  assert.deepEqual(await streamTypes(output(d)), ['audio', 'video']);
});

test('ffmpeg: DASH manifest with separate audio and video', { skip: noFfmpeg }, async () => {
  const dir = newDir();
  ffmpeg(dir, [...VIDEO_IN, ...AUDIO_IN, '-map', '0:v', '-map', '1:a', ...H264, '-c:a', 'aac', '-shortest',
    '-f', 'dash', '-seg_duration', '1', '-use_template', '1', '-use_timeline', '1', 'manifest.mpd']);
  server.serveDir('/ff3/', dir);
  const d = makeStream(`${server.base}/ff3/manifest.mpd`, { withTools: tools, quality: '1080' });
  await d.start();
  assert.equal(d.state.status, 'completed', d.state.error ?? undefined);
  assert.equal(d.state.protocol, 'dash');
  assert.deepEqual(await streamTypes(output(d)), ['audio', 'video']);
  assert.ok(d.state.notices.some((n) => /1080p não está disponível; usado 240p/.test(n)));
});

test('ffmpeg: a failed remux is reported and nothing is marked as completed', { skip: noFfmpeg }, async () => {
  addSegments('/ff4', 2, { size: 2000 });
  addSegments('/ff4/a', 2, { size: 2000 });
  server.set('/ff4/v.m3u8', mediaPlaylist(2));
  server.set('/ff4/a/a.m3u8', mediaPlaylist(2));
  server.set('/ff4/master.m3u8', [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="x",DEFAULT=YES,URI="a/a.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=320x240,AUDIO="a"',
    'v.m3u8',
  ].join('\n'));
  const dir = newDir();
  const d = makeStream(`${server.base}/ff4/master.m3u8`, { withTools: tools, dir });
  await d.start();
  assert.equal(d.state.status, 'error');
  assert.match(d.state.error ?? '', /FFmpeg falhou/);
  assert.equal(d.state.filePath, undefined);
  // Only the temporary folder remains, so a retry does not download again.
  assert.deepEqual(fs.readdirSync(dir), [path.basename(d.tempDir)]);
});
