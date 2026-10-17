import { contextBridge, ipcRenderer } from 'electron';
import type { DownloaderApi, DownloadView } from '../shared/api';

const api: DownloaderApi = {
  list: () => ipcRenderer.invoke('downloads:list'),
  add: (options) => ipcRenderer.invoke('downloads:add', options),
  pause: (ids) => ipcRenderer.invoke('downloads:pause', ids),
  resume: (ids) => ipcRenderer.invoke('downloads:resume', ids),
  remove: (ids, deleteFile) => ipcRenderer.invoke('downloads:remove', ids, deleteFile),
  pauseAll: () => ipcRenderer.invoke('downloads:pauseAll'),
  resumeAll: () => ipcRenderer.invoke('downloads:resumeAll'),
  openFile: (id) => ipcRenderer.invoke('downloads:openFile', id),
  showInFolder: (id) => ipcRenderer.invoke('downloads:showInFolder', id),
  copyUrl: (id) => ipcRenderer.invoke('downloads:copyUrl', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  chooseFolder: (current) => ipcRenderer.invoke('dialog:chooseFolder', current),
  chooseCookiesFile: () => ipcRenderer.invoke('dialog:chooseCookiesFile'),
  clipboardUrl: () => ipcRenderer.invoke('clipboard:url'),
  updateVideoTool: () => ipcRenderer.invoke('video:update'),
  onUpdate: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, list: DownloadView[]): void => callback(list);
    ipcRenderer.on('downloads:update', listener);
    return () => {
      ipcRenderer.removeListener('downloads:update', listener);
    };
  },
  onFocusDownload: (callback) => {
    ipcRenderer.on('downloads:focus', (_event, id: string) => callback(id));
  },
};

contextBridge.exposeInMainWorld('downloader', api);
