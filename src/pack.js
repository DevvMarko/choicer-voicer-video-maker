'use strict';

const fs = require('fs');
const path = require('path');

// A Choicer Voicer scene pack is a folder with "_pack_info.ini", the scene video, and
// for every line a "<line>.txt" like:
//   [data]
//   caption="Lois: Peter, the horse is here"
//   image="01_Lois.png"
//   dub_timestamps=[3.917]
//   dub_characters=["Lois"]
// The recording of that line is saved as "_dubrecord_<line>.wav", so packs whose
// recordings carry no time in the name ("_dubrecord_01_Lois.wav") get it from here.

const PACK_INFO = '_pack_info.ini';

function isPackDir(dir) {
  return fs.existsSync(path.join(dir, PACK_INFO));
}

// "_dubrecord_01_Lois.wav" -> "01_lois" (lower case, so lookups ignore case).
function lineKey(fileName) {
  return path
    .basename(fileName)
    .replace(/\.[^.]+$/, '')
    .replace(/^_?dubrecord_/i, '')
    .toLowerCase();
}

// First value of dub_timestamps, or null if the file isn't a line file.
function parseLineFile(text) {
  const m = String(text).match(/^\s*dub_timestamps\s*=\s*\[([^\]]*)\]/m);
  if (!m) return null;
  const first = Number.parseFloat(m[1].split(',')[0]);
  return Number.isFinite(first) && first >= 0 ? first : null;
}

// Read the given .txt files into { lineKey: seconds }. Unreadable or unrelated files are skipped.
function readTimings(txtPaths) {
  const timings = {};
  for (const p of txtPaths) {
    try {
      const start = parseLineFile(fs.readFileSync(p, 'utf8'));
      if (start !== null) timings[lineKey(p)] = start;
    } catch (_) {
      // not a line file
    }
  }
  return timings;
}

// Start time for one recording from the "<line>.txt" next to it, if there is one.
function startFromSidecar(clipPath) {
  const dir = path.dirname(clipPath);
  const key = lineKey(clipPath);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return null;
  }
  const txt = names.find((n) => n.toLowerCase().endsWith('.txt') && lineKey(n) === key);
  return txt ? (readTimings([path.join(dir, txt)])[key] ?? null) : null;
}

module.exports = { isPackDir, lineKey, parseLineFile, readTimings, startFromSidecar, PACK_INFO };
