'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('./ffmpeg');
const pack = require('./pack');

const AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'opus'];
const VIDEO_EXTENSIONS = ['ogv', 'mp4', 'mkv', 'webm', 'mov', 'avi'];

const extOf = (n) => path.extname(n).slice(1).toLowerCase();

// Replace folders with the files the app can use from them; files are kept as they are.
// - "scene": the scene pack (video, plus the line .txt files with start times). Its own
//   voice lines and backing track are not voice clips, so audio is never taken from it.
// - "recordings": the voice clips. If the folder has "_dubrecord_" files, only those are
//   taken. Videos and .txt files come along too, since the game may save the video next to
//   the recordings, or the pack and the recordings may share a folder.
function expandPaths(paths, kind) {
  const out = [];
  for (const p of paths) {
    let isDir = false;
    try {
      isDir = fs.statSync(p).isDirectory();
    } catch (_) {
      // missing file: let probe report it
    }
    if (!isDir) {
      out.push(p);
      continue;
    }
    const names = fs.readdirSync(p);
    let picked;
    if (kind === 'scene') {
      picked = names.filter((n) => [...VIDEO_EXTENSIONS, 'txt'].includes(extOf(n)));
    } else {
      const audio = names.filter((n) => AUDIO_EXTENSIONS.includes(extOf(n)));
      const dubs = audio.filter((n) => /^_?dubrecord_/i.test(n));
      // a pack's own audio is never a recording
      const clips = dubs.length || pack.isPackDir(p) ? dubs : audio;
      picked = [...clips, ...names.filter((n) => [...VIDEO_EXTENSIONS, 'txt'].includes(extOf(n)))];
    }
    out.push(...picked.map((n) => path.join(p, n)));
  }
  return out;
}

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

ipcMain.handle('pick-folder', async (_e, kind) => {
  const res = await dialog.showOpenDialog(win, {
    title: kind === 'scene' ? 'Add scene folder (video + times)' : 'Add recordings folder (voice clips)',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return expandPaths(res.filePaths, kind);
});

ipcMain.handle('expand-paths', (_e, paths, kind) => expandPaths(paths, kind));

ipcMain.handle('read-timings', (_e, txtPaths) => pack.readTimings(txtPaths));

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
      const info = await ffmpeg.probe(p);
      info.lineKey = pack.lineKey(p);
      if (!info.hasVideo && info.start === null) info.start = pack.startFromSidecar(p);
      results.push(info);
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
