import path from 'node:path';
import fs from 'node:fs';
import {
  app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, clipboard, Notification, nativeImage,
} from 'electron';
import { DownloadManager } from '../engine/download-manager';
import { updateYtDlp, type VideoTools } from '../engine/video-download';
import type { StreamTools } from '../engine/ffmpeg';
import { startBrowserBridge } from './browser-bridge';
import type { AddOptions, Settings, SettingsView } from '../shared/api';

// Compiled to dist/src/main; assets and tools stay at the project root.
const ROOT = path.join(__dirname, '..', '..', '..');
const ICON = path.join(ROOT, 'assets', 'icon.png');
const BIN = path.join(ROOT, 'bin');

/** yt-dlp and ffmpeg from bin/; Electron itself runs YouTube's JavaScript challenges as Node. */
function findVideoTools(): VideoTools | null {
  const ytdlp = path.join(BIN, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (!fs.existsSync(ytdlp)) return null;
  return { ytdlp, ffmpegDir: BIN, jsRuntime: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** ffmpeg/ffprobe from bin/, used by HLS/DASH downloads to join and check tracks. */
function findStreamTools(): StreamTools | null {
  const exe = (name: string): string => path.join(BIN, process.platform === 'win32' ? `${name}.exe` : name);
  if (!fs.existsSync(exe('ffmpeg'))) return null;
  return { ffmpeg: exe('ffmpeg'), ffprobe: fs.existsSync(exe('ffprobe')) ? exe('ffprobe') : null };
}

// IPC arguments come from the renderer: check their shape instead of trusting it.
const asIds = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
const asObject = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? value as Record<string, unknown> : {});

// Optional separate profile (settings, list and browser cache), e.g. for a portable copy.
if (process.env.MD_USER_DATA) app.setPath('userData', path.resolve(process.env.MD_USER_DATA));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let manager: DownloadManager;
  let win: BrowserWindow | null = null;
  let tray: Tray | null = null;
  let quitting = false;

  const showWindow = (): void => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  const createWindow = (): void => {
    const window = new BrowserWindow({
      width: 1180,
      height: 720,
      minWidth: 760,
      minHeight: 460,
      title: 'Meu Downloader',
      icon: ICON,
      backgroundColor: '#14161a',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    win = window;
    window.removeMenu();
    void window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    window.once('ready-to-show', () => {
      if (!process.argv.includes('--hidden')) window.show();
    });
    // Closing the window keeps downloads running in the tray.
    window.on('close', (event) => {
      if (!quitting) {
        event.preventDefault();
        window.hide();
      }
    });
    // Surface interface warnings and errors in the terminal that started the app.
    window.webContents.on('console-message', (event) => {
      if (event.level !== 'warning' && event.level !== 'error') return;
      console.error(`[interface] ${event.message}${event.lineNumber ? ` (linha ${event.lineNumber})` : ''}`);
    });
    // Never navigate the app window or open new windows from it.
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  };

  const createTray = (): void => {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.setToolTip('Meu Downloader');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Abrir', click: showWindow },
      { type: 'separator' },
      { label: 'Retomar tudo', click: () => manager.resumeAll() },
      { label: 'Pausar tudo', click: () => void manager.pauseAll() },
      { type: 'separator' },
      { label: 'Sair', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', showWindow);
  };

  const findDownload = (id: unknown) => manager.list().find((d) => d.id === id);

  const registerIpc = (): void => {
    ipcMain.handle('downloads:list', () => manager.list());
    ipcMain.handle('downloads:add', (_e, options: unknown) => manager.add(asObject(options) as unknown as AddOptions));
    ipcMain.handle('downloads:pause', async (_e, ids: unknown) => {
      await Promise.all(asIds(ids).map((id) => manager.pause(id)));
    });
    ipcMain.handle('downloads:resume', (_e, ids: unknown) => asIds(ids).forEach((id) => manager.resume(id)));
    ipcMain.handle('downloads:remove', async (_e, ids: unknown, deleteFile: unknown) => {
      await Promise.all(asIds(ids).map((id) => manager.remove(id, { deleteFile: !!deleteFile })));
    });
    ipcMain.handle('downloads:pauseAll', () => manager.pauseAll());
    ipcMain.handle('downloads:resumeAll', () => manager.resumeAll());
    ipcMain.handle('downloads:openFile', async (_e, id: unknown) => {
      const d = findDownload(id);
      if (d?.status === 'completed' && d.filePath && fs.existsSync(d.filePath)) return shell.openPath(d.filePath);
      return 'Arquivo não encontrado';
    });
    ipcMain.handle('downloads:showInFolder', async (_e, id: unknown) => {
      const d = findDownload(id);
      if (d?.filePath && fs.existsSync(d.filePath)) shell.showItemInFolder(d.filePath);
      else if (d?.dir) await shell.openPath(d.dir);
    });
    ipcMain.handle('downloads:copyUrl', (_e, id: unknown) => {
      const d = findDownload(id);
      if (d) clipboard.writeText(d.url);
    });
    ipcMain.handle('settings:get', (): SettingsView => ({
      ...manager.settings,
      videoAvailable: !!manager.videoTools,
      ffmpegAvailable: !!manager.streamTools,
    }));
    ipcMain.handle('video:update', () => (manager.videoTools ? updateYtDlp(manager.videoTools) : 'yt-dlp não encontrado na pasta bin'));
    ipcMain.handle('settings:update', (_e, patch: unknown) => manager.updateSettings(asObject(patch) as Partial<Settings>));
    ipcMain.handle('dialog:chooseFolder', async (_e, current: unknown) => {
      const options: Electron.OpenDialogOptions = {
        title: 'Escolha a pasta de downloads',
        defaultPath: typeof current === 'string' && current ? current : manager.settings.downloadDir,
        properties: ['openDirectory', 'createDirectory'],
      };
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths[0] ?? null;
    });
    ipcMain.handle('dialog:chooseCookiesFile', async () => {
      const options: Electron.OpenDialogOptions = {
        title: 'Escolha o arquivo de cookies (formato Netscape)',
        filters: [{ name: 'Cookies', extensions: ['txt'] }, { name: 'Todos os arquivos', extensions: ['*'] }],
        properties: ['openFile'],
      };
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths[0] ?? null;
    });
    // Electron's clipboard API is asynchronous (Promise-based) since v44.
    // Pre-filling from the clipboard is a convenience: any failure means "no URL".
    ipcMain.handle('clipboard:url', async () => {
      try {
        const text = String((await clipboard.readText()) ?? '').trim();
        return /^https?:\/\/\S+$/i.test(text) ? text : null;
      } catch (err) {
        console.warn('Não foi possível ler a área de transferência:', err instanceof Error ? err.message : err);
        return null;
      }
    });
  };

  app.on('second-instance', showWindow);

  void app.whenReady().then(() => {
    app.setAppUserModelId('local.meu-downloader');
    manager = new DownloadManager({
      storeDir: app.getPath('userData'),
      defaultDownloadDir: app.getPath('downloads'),
      videoTools: findVideoTools(),
      streamTools: findStreamTools(),
    });
    manager.on('update', (list) => win?.webContents.send('downloads:update', list));
    manager.on('completed', (d) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: 'Download concluído', body: d.fileName, icon: ICON });
      n.on('click', () => d.filePath && shell.showItemInFolder(d.filePath));
      n.show();
    });

    registerIpc();
    createWindow();
    createTray();
    startBrowserBridge({
      manager,
      version: app.getVersion(),
      onAdded: (id) => {
        showWindow();
        win?.webContents.send('downloads:focus', id);
      },
    });
    manager.startQueued();
  });

  app.on('before-quit', (event) => {
    quitting = true;
    if (manager && !manager.closed) {
      event.preventDefault();
      manager.closed = true;
      void manager.shutdown().finally(() => app.quit());
    }
  });

  // The tray keeps the app alive when every window is hidden.
  app.on('window-all-closed', () => {});
}
