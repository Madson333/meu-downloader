const APP = 'http://127.0.0.1:47900';
// The app rejects requests without this header, which web pages cannot send
// to it without a CORS preflight.
const APP_HEADERS = { 'X-Meu-Downloader': '1' };
const CONFIG_TTL_MS = 10_000;

/** What the app answers on /ping. */
export interface AppConfig {
  app: string;
  version: string;
  captureEnabled: boolean;
  captureExtensions: string[];
  minCaptureSizeKB: number;
}

/** Reply to the popup's { type: 'status' } message. */
export interface StatusReply {
  connected: boolean;
  config: AppConfig | null;
  enabled: boolean;
}

let cachedConfig: AppConfig | null = null;
let cachedAt = 0;

async function getConfig(force = false): Promise<AppConfig | null> {
  if (!force && Date.now() - cachedAt < CONFIG_TTL_MS) return cachedConfig;
  try {
    const res = await fetch(`${APP}/ping`, { headers: APP_HEADERS });
    cachedConfig = res.ok ? await res.json() as AppConfig : null;
  } catch {
    cachedConfig = null;
  }
  cachedAt = Date.now();
  await updateBadge();
  return cachedConfig;
}

async function isEnabled(): Promise<boolean> {
  const { enabled = true } = await chrome.storage.local.get<{ enabled?: boolean }>('enabled');
  return enabled;
}

async function updateBadge(): Promise<void> {
  const enabled = await isEnabled();
  const text = !enabled ? 'OFF' : cachedConfig ? '' : '!';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: enabled ? '#dc2626' : '#6b7280' });
  await chrome.action.setTitle({
    title: !enabled ? 'Meu Downloader — captura desligada'
      : cachedConfig ? 'Meu Downloader — conectado' : 'Meu Downloader — app não está aberto',
  });
}

function extensionOf(name: string | undefined): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(name ?? '');
  return match?.[1]?.toLowerCase() ?? '';
}

function baseName(filePath: string | undefined): string {
  return (filePath ?? '').split(/[\\/]/).pop() ?? '';
}

function urlPathName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  } catch {
    return '';
  }
}

async function cookieHeader(url: string): Promise<string | null> {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ') || null;
  } catch {
    return null;
  }
}

async function sendToApp({ url, referrer, fileName }: { url: string; referrer?: string | undefined; fileName?: string | undefined }): Promise<boolean> {
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

async function shouldCapture(item: chrome.downloads.DownloadItem): Promise<boolean> {
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

function createMenus(): void {
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
  void getConfig(true);
});
chrome.runtime.onStartup.addListener(() => void getConfig(true));
chrome.storage.onChanged.addListener(() => void updateBadge());

chrome.runtime.onMessage.addListener((message: { type?: string } | undefined, _sender, sendResponse: (reply: StatusReply) => void) => {
  if (message?.type === 'status') {
    void Promise.all([getConfig(true), isEnabled()]).then(([config, enabled]) => sendResponse({ connected: !!config, config, enabled }));
    return true;
  }
  return false;
});
