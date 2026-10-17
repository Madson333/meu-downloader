import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DownloadManager } from '../src/engine/download-manager';
import { startBrowserBridge } from '../src/main/browser-bridge';

let manager: DownloadManager;
let bridge: Server;
let base: string;
let tmp: string;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bridge-'));
  manager = new DownloadManager({ storeDir: tmp, defaultDownloadDir: tmp });
  bridge = startBrowserBridge({ manager, version: 'test', port: 0 });
  await once(bridge, 'listening');
  base = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
});

after(async () => {
  bridge.close();
  await manager.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const EXT = { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'X-Meu-Downloader': '1' };

test('rejects requests from web pages', async () => {
  const res = await fetch(`${base}/ping`, { headers: { Origin: 'https://evil.example', 'X-Meu-Downloader': '1' } });
  assert.equal(res.status, 403);
});

test('rejects requests without the client header', async () => {
  const res = await fetch(`${base}/ping`, { headers: { Origin: EXT.Origin } });
  assert.equal(res.status, 403);
});

test('ping returns capture settings to the extension', async () => {
  const res = await fetch(`${base}/ping`, { headers: EXT });
  assert.equal(res.status, 200);
  const body = await res.json() as { app: string; captureExtensions: string[] };
  assert.equal(body.app, 'meu-downloader');
  assert.ok(body.captureExtensions.includes('zip'));
});

test('accepts downloads with cookies and referrer', async () => {
  const res = await fetch(`${base}/download`, {
    method: 'POST',
    headers: { ...EXT, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'http://127.0.0.1:9/file.zip',
      referrer: 'https://example.com/page',
      cookie: 'session=abc',
      fileName: 'file.zip',
    }),
  });
  assert.equal(res.status, 202);
  const { id } = await res.json() as { id: string };
  const added = manager.downloads.get(id)?.state;
  assert.ok(added);
  assert.equal(added.headers?.cookie, 'session=abc');
  assert.equal(added.headers?.referrer, 'https://example.com/page');
  assert.equal(added.suggestedName, 'file.zip');
});

test('rejects non-http URLs', async () => {
  const res = await fetch(`${base}/download`, {
    method: 'POST',
    headers: { ...EXT, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'file:///C:/Windows/win.ini' }),
  });
  assert.equal(res.status, 400);
});
