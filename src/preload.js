'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickFolder: (kind) => ipcRenderer.invoke('pick-folder', kind),
  pickOutput: (dir, name) => ipcRenderer.invoke('pick-output', dir, name),
  expandPaths: (paths, kind) => ipcRenderer.invoke('expand-paths', paths, kind),
  readTimings: (txtPaths) => ipcRenderer.invoke('read-timings', txtPaths),
  probe: (paths) => ipcRenderer.invoke('probe', paths),
  makeVideo: (opts) => ipcRenderer.invoke('make-video', opts),
  cancel: () => ipcRenderer.invoke('cancel'),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, p) => cb(p)),
});
