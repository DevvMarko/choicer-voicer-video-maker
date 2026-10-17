'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickClips: () => ipcRenderer.invoke('pick-clips'),
  pickVideo: () => ipcRenderer.invoke('pick-video'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  pickOutput: (dir, name) => ipcRenderer.invoke('pick-output', dir, name),
  probe: (paths) => ipcRenderer.invoke('probe', paths),
  makeVideo: (opts) => ipcRenderer.invoke('make-video', opts),
  cancel: () => ipcRenderer.invoke('cancel'),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, p) => cb(p)),
});
