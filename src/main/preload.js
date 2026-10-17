'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('downloader', {
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
  clipboardUrl: () => ipcRenderer.invoke('clipboard:url'),
  updateVideoTool: () => ipcRenderer.invoke('video:update'),
  onUpdate: (callback) => {
    const listener = (_event, list) => callback(list);
    ipcRenderer.on('downloads:update', listener);
    return () => ipcRenderer.removeListener('downloads:update', listener);
  },
  onFocusDownload: (callback) => ipcRenderer.on('downloads:focus', (_event, id) => callback(id)),
});
