'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { DownloadManager } = require('../src/engine/download-manager');
const { startBrowserBridge } = require('../src/main/browser-bridge');

let manager;
let bridge;
let base;
let tmp;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bridge-'));
  manager = new DownloadManager({ storeDir: tmp, defaultDownloadDir: tmp });
  bridge = startBrowserBridge({ manager, version: 'test', port: 0 });
  await once(bridge, 'listening');
  base = `http://127.0.0.1:${bridge.address().port}`;
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
  const body = await res.json();
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
  const { id } = await res.json();
  const added = manager.downloads.get(id).state;
  assert.equal(added.headers.cookie, 'session=abc');
  assert.equal(added.headers.referrer, 'https://example.com/page');
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
