'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('./ffmpeg');

const AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'opus'];
const VIDEO_EXTENSIONS = ['ogv', 'mp4', 'mkv', 'webm', 'mov', 'avi'];
const MEDIA_EXTENSIONS = [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS];

let win;
let currentJob = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    title: 'Choicer Voicer Video Maker',
    backgroundColor: '#16181d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('pick-clips', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Add voice clips',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Voice clips', extensions: AUDIO_EXTENSIONS },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('pick-video', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose video',
    properties: ['openFile'],
    filters: [
      { name: 'Video', extensions: VIDEO_EXTENSIONS },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('pick-folder', async () => {
  const res = await dialog.showOpenDialog(win, { title: 'Add folder', properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return [];
  const dir = res.filePaths[0];
  return fs
    .readdirSync(dir)
    .filter((n) => MEDIA_EXTENSIONS.includes(path.extname(n).slice(1).toLowerCase()))
    .map((n) => path.join(dir, n));
});

ipcMain.handle('pick-output', async (_e, suggestedDir, name) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Save video',
    defaultPath: path.join(suggestedDir || app.getPath('videos'), name || 'dub.mp4'),
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  if (res.canceled || !res.filePath) return null;
  return res.filePath.toLowerCase().endsWith('.mp4') ? res.filePath : `${res.filePath}.mp4`;
});

ipcMain.handle('probe', async (_e, paths) => {
  const results = [];
  for (const p of paths) {
    try {
      results.push(await ffmpeg.probe(p));
    } catch (err) {
      results.push({ path: p, name: path.basename(p), error: err.message });
    }
  }
  return results;
});

ipcMain.handle('make-video', async (_e, opts) => {
  if (currentJob) throw new Error('A video is already being made.');
  if (path.resolve(opts.output) === path.resolve(opts.video.path)) {
    throw new Error('Choose a different file name: the output would overwrite the source video.');
  }
  currentJob = ffmpeg.makeVideo(opts, (p) => win && win.webContents.send('progress', p));
  try {
    return await currentJob.promise;
  } catch (err) {
    // remove partial output
    fs.rm(opts.output, { force: true }, () => {});
    throw err;
  } finally {
    currentJob = null;
  }
});

ipcMain.handle('cancel', () => {
  if (currentJob) currentJob.cancel();
});

ipcMain.handle('show-in-folder', (_e, p) => shell.showItemInFolder(p));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (currentJob) currentJob.cancel();
  if (process.platform !== 'darwin') app.quit();
});
