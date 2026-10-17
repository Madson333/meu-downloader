'use strict';

const APP = 'http://127.0.0.1:47900';
// The app rejects requests without this header, which web pages cannot send
// to it without a CORS preflight.
const APP_HEADERS = { 'X-Meu-Downloader': '1' };
const CONFIG_TTL_MS = 10_000;

let cachedConfig = null;
let cachedAt = 0;

async function getConfig(force = false) {
  if (!force && Date.now() - cachedAt < CONFIG_TTL_MS) return cachedConfig;
  try {
    const res = await fetch(`${APP}/ping`, { headers: APP_HEADERS });
    cachedConfig = res.ok ? await res.json() : null;
  } catch {
    cachedConfig = null;
  }
  cachedAt = Date.now();
  await updateBadge();
  return cachedConfig;
}

async function isEnabled() {
  const { enabled = true } = await chrome.storage.local.get('enabled');
  return enabled;
}

async function updateBadge() {
  const enabled = await isEnabled();
  const text = !enabled ? 'OFF' : cachedConfig ? '' : '!';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: enabled ? '#dc2626' : '#6b7280' });
  await chrome.action.setTitle({
    title: !enabled ? 'Meu Downloader — captura desligada'
      : cachedConfig ? 'Meu Downloader — conectado' : 'Meu Downloader — app não está aberto',
  });
}

function extensionOf(name) {
  const match = /\.([a-z0-9]{1,8})$/i.exec(name ?? '');
  return match ? match[1].toLowerCase() : '';
}

function baseName(filePath) {
  return (filePath ?? '').split(/[\\/]/).pop();
}

function urlPathName(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  } catch {
    return '';
  }
}

async function cookieHeader(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ') || null;
  } catch {
    return null;
  }
}

async function sendToApp({ url, referrer, fileName }) {
  const body = {
    url,
    referrer: referrer || null,
    fileName: fileName || null,
    cookie: await cookieHeader(url),
    userAgent: navigator.userAgent,
  };
  try {
    const res = await fetch(`${APP}/download`, {
      method: 'POST',
      headers: { ...APP_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.status === 202;
  } catch {
    return false;
  }
}

async function shouldCapture(item) {
  if (!(await isEnabled())) return false;
  const url = item.finalUrl || item.url;
  if (!/^https?:/i.test(url)) return false;
  const config = await getConfig();
  if (!config?.captureEnabled) return false;
  const ext = extensionOf(baseName(item.filename)) || extensionOf(urlPathName(url));
  if (!config.captureExtensions.includes(ext)) return false;
  if (item.totalBytes > 0 && item.totalBytes < config.minCaptureSizeKB * 1024) return false;
  return true;
}

// Chrome waits for suggest() before writing the file, so the decision happens
// before the browser commits to the download.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  (async () => {
    if (!(await shouldCapture(item))) return;
    const accepted = await sendToApp({
      url: item.finalUrl || item.url,
      referrer: item.referrer,
      fileName: baseName(item.filename),
    });
    if (!accepted) return;
    await chrome.downloads.cancel(item.id).catch(() => {});
    await chrome.downloads.erase({ id: item.id }).catch(() => {});
  })().finally(() => {
    try {
      suggest();
    } catch {
      // The download was already cancelled.
    }
  });
  return true;
});

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'link',
      title: 'Baixar link com Meu Downloader',
      contexts: ['link'],
      targetUrlPatterns: ['http://*/*', 'https://*/*'],
    });
    chrome.contextMenus.create({
      id: 'media',
      title: 'Baixar mídia com Meu Downloader',
      contexts: ['image', 'video', 'audio'],
      targetUrlPatterns: ['http://*/*', 'https://*/*'],
    });
    // Players such as YouTube stream from blob: URLs; the app extracts the video from the page instead.
    chrome.contextMenus.create({
      id: 'page',
      title: 'Baixar vídeo desta página com Meu Downloader',
      contexts: ['page', 'video', 'frame'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  const url = info.menuItemId === 'link' ? info.linkUrl
    : info.menuItemId === 'page' ? (info.frameUrl || info.pageUrl) : info.srcUrl;
  if (!url) return;
  const ok = await sendToApp({ url, referrer: info.pageUrl });
  if (!ok) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setTitle({ title: 'Meu Downloader — abra o app para baixar' });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  createMenus();
  getConfig(true);
});
chrome.runtime.onStartup.addListener(() => getConfig(true));
chrome.storage.onChanged.addListener(() => updateBadge());

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'status') {
    Promise.all([getConfig(true), isEnabled()]).then(([config, enabled]) => sendResponse({ connected: !!config, config, enabled }));
    return true;
  }
  return false;
});
