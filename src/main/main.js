'use strict';

const path = require('node:path');
const fs = require('node:fs');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, clipboard, Notification, nativeImage,
} = require('electron');
const { DownloadManager } = require('../engine/download-manager');
const { updateYtDlp } = require('../engine/video-download');
const { startBrowserBridge } = require('./browser-bridge');

const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const BIN = path.join(__dirname, '..', '..', 'bin');

/** yt-dlp and ffmpeg from bin/; Electron itself runs YouTube's JavaScript challenges as Node. */
function findVideoTools() {
  const ytdlp = path.join(BIN, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (!fs.existsSync(ytdlp)) return null;
  return { ytdlp, ffmpegDir: BIN, jsRuntime: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

// Optional separate profile (settings, list and browser cache), e.g. for a portable copy.
if (process.env.MD_USER_DATA) app.setPath('userData', path.resolve(process.env.MD_USER_DATA));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let manager;
  let win = null;
  let tray = null;
  let quitting = false;

  const showWindow = () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  const createWindow = () => {
    win = new BrowserWindow({
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
    win.removeMenu();
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    win.once('ready-to-show', () => {
      if (!process.argv.includes('--hidden')) win.show();
    });
    // Closing the window keeps downloads running in the tray.
    win.on('close', (event) => {
      if (!quitting) {
        event.preventDefault();
        win.hide();
      }
    });
    // Surface interface warnings and errors in the terminal that started the app.
    win.webContents.on('console-message', (event) => {
      if (event.level !== 'warning' && event.level !== 'error') return;
      console.error(`[interface] ${event.message}${event.lineNumber ? ` (linha ${event.lineNumber})` : ''}`);
    });
    // Never navigate the app window or open new windows from it.
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  };

  const createTray = () => {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.setToolTip('Meu Downloader');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Abrir', click: showWindow },
      { type: 'separator' },
      { label: 'Retomar tudo', click: () => manager.resumeAll() },
      { label: 'Pausar tudo', click: () => manager.pauseAll() },
      { type: 'separator' },
      { label: 'Sair', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', showWindow);
  };

  const findDownload = (id) => manager.list().find((d) => d.id === id);

  const registerIpc = () => {
    ipcMain.handle('downloads:list', () => manager.list());
    ipcMain.handle('downloads:add', (_e, options) => manager.add(options ?? {}));
    ipcMain.handle('downloads:pause', (_e, ids) => Promise.all(ids.map((id) => manager.pause(id))));
    ipcMain.handle('downloads:resume', (_e, ids) => ids.forEach((id) => manager.resume(id)));
    ipcMain.handle('downloads:remove', (_e, ids, deleteFile) => Promise.all(
      ids.map((id) => manager.remove(id, { deleteFile: !!deleteFile })),
    ));
    ipcMain.handle('downloads:pauseAll', () => manager.pauseAll());
    ipcMain.handle('downloads:resumeAll', () => manager.resumeAll());
    ipcMain.handle('downloads:openFile', async (_e, id) => {
      const d = findDownload(id);
      if (d?.status === 'completed' && d.filePath && fs.existsSync(d.filePath)) return shell.openPath(d.filePath);
      return 'Arquivo não encontrado';
    });
    ipcMain.handle('downloads:showInFolder', (_e, id) => {
      const d = findDownload(id);
      if (d?.filePath && fs.existsSync(d.filePath)) shell.showItemInFolder(d.filePath);
      else if (d?.dir) shell.openPath(d.dir);
    });
    ipcMain.handle('downloads:copyUrl', (_e, id) => {
      const d = findDownload(id);
      if (d) return clipboard.writeText(d.url);
    });
    ipcMain.handle('settings:get', () => ({ ...manager.settings, videoAvailable: !!manager.videoTools }));
    ipcMain.handle('video:update', () => (manager.videoTools ? updateYtDlp(manager.videoTools) : 'yt-dlp não encontrado na pasta bin'));
    ipcMain.handle('settings:update', (_e, patch) => manager.updateSettings(patch ?? {}));
    ipcMain.handle('dialog:chooseFolder', async (_e, current) => {
      const result = await dialog.showOpenDialog(win, {
        title: 'Escolha a pasta de downloads',
        defaultPath: current || manager.settings.downloadDir,
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? null : result.filePaths[0];
    });
    // Electron's clipboard API is asynchronous (Promise-based) since v44.
    // Pre-filling from the clipboard is a convenience: any failure means "no URL".
    ipcMain.handle('clipboard:url', async () => {
      try {
        const text = String((await clipboard.readText()) ?? '').trim();
        return /^https?:\/\/\S+$/i.test(text) ? text : null;
      } catch (err) {
        console.warn('Não foi possível ler a área de transferência:', err?.message ?? err);
        return null;
      }
    });
  };

  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    app.setAppUserModelId('local.meu-downloader');
    const videoTools = findVideoTools();
    manager = new DownloadManager({
      storeDir: app.getPath('userData'),
      defaultDownloadDir: app.getPath('downloads'),
      videoTools,
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
      manager.shutdown().finally(() => app.quit());
    }
  });

  // The tray keeps the app alive when every window is hidden.
  app.on('window-all-closed', () => {});
}
