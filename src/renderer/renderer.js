'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  video: null,
  clips: [],
  // start times from scene pack .txt files, by line name ("01_lois")
  timings: {},
  busy: false,
};

const naturalCompare = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const byStart = (a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || naturalCompare(a, b);

function formatTime(sec) {
  if (!Number.isFinite(sec)) return '–';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(2)} s`;
}

function validClips() {
  return state.clips.filter((c) => !c.error);
}

// Give clips that have no time in their name the time from the scene pack. Returns how many got one.
function applyTimings() {
  let n = 0;
  for (const c of state.clips) {
    if (c.error || Number.isFinite(c.start)) continue;
    const t = state.timings[c.lineKey];
    if (Number.isFinite(t)) {
      c.start = t;
      n++;
    }
  }
  return n;
}

// Probe the files, then put video files into the video slot and audio files into the clip list.
// Scene pack .txt files are read for start times instead. Folders are expanded by kind
// ("scene" or "recordings"); paths from the folder pickers are already expanded.
async function addPaths(paths, kind) {
  const given = new Set(paths);
  if (kind) paths = await window.api.expandPaths(paths, kind);
  // a video found in a recordings folder only fills an empty video slot
  if (kind === 'recordings' && state.video) {
    paths = paths.filter((p) => given.has(p) || !/\.(ogv|mp4|mkv|webm|mov|avi)$/i.test(p));
  }
  const isTxt = (p) => p.toLowerCase().endsWith('.txt');
  const known = new Set(state.clips.map((c) => c.path));
  const fresh = paths.filter((p) => !isTxt(p) && !known.has(p) && (!state.video || state.video.path !== p));
  const txt = paths.filter(isTxt);
  if (!fresh.length && !txt.length) {
    if (!paths.length) setStatus('No video, voice clips or line times found there.', 'error');
    return;
  }
  setStatus(`Reading ${fresh.length + txt.length} file(s)…`);
  const timings = txt.length ? await window.api.readTimings(txt) : {};
  Object.assign(state.timings, timings);
  const probed = fresh.length ? await window.api.probe(fresh) : [];
  const messages = [];
  const lines = Object.keys(timings).length;
  if (lines) messages.push(`Read start times for ${lines} line(s) from the scene.`);

  const videos = probed.filter((f) => !f.error && f.hasVideo);
  if (videos.length) {
    state.video = videos[0];
    if (videos.length > 1) messages.push(`Several videos added; using ${videos[0].name}.`);
  }
  const clips = probed.filter((f) => f.error || !f.hasVideo);
  state.clips.push(...clips);
  const timed = applyTimings();
  if (timed) messages.push(`${timed} clip(s) got their start time from the scene.`);
  state.clips.sort(byStart);

  const failed = probed.filter((f) => f.error).length;
  if (failed) messages.push(`${failed} file(s) could not be read and will be skipped.`);
  setStatus(messages.join(' '), failed ? 'error' : '');
  render();
}

function render() {
  renderVideo();
  renderClips();
  updateSummary();
}

function renderVideo() {
  const v = state.video;
  $('video-empty').hidden = Boolean(v);
  $('video-info').hidden = !v;
  $('video-drop').classList.toggle('filled', Boolean(v));
  if (!v) return;
  $('video-name').textContent = v.name;
  $('video-name').title = v.path;
  const parts = [formatTime(v.duration)];
  if (v.width) parts.push(`${v.width}×${v.height}`);
  if (v.fps) parts.push(`${Math.round(v.fps)} fps`);
  parts.push(v.hasAudio ? 'original audio will be removed' : 'no audio');
  $('video-meta').textContent = parts.join(' · ');
  $('video-remove').disabled = state.busy;
}

function renderClips() {
  const rows = $('rows');
  rows.textContent = '';
  state.clips.forEach((c, i) => {
    const tr = document.createElement('tr');
    if (c.error) tr.className = 'error';
    else if (state.video && (c.start ?? 0) >= state.video.duration) tr.className = 'outside';

    const num = document.createElement('td');
    num.className = 'num';
    num.textContent = i + 1;

    const name = document.createElement('td');
    name.className = 'name';
    name.textContent = c.name;
    name.title = c.error || c.path;

    const start = document.createElement('td');
    start.className = 'time';
    if (!c.error) {
      const input = document.createElement('input');
      input.type = 'number';
      input.step = '0.001';
      input.min = '0';
      input.value = Number.isFinite(c.start) ? c.start.toFixed(3) : '';
      input.placeholder = 'not set';
      input.disabled = state.busy;
      input.addEventListener('change', () => {
        const v = parseFloat(input.value);
        c.start = Number.isFinite(v) && v >= 0 ? v : null;
        state.clips.sort(byStart);
        render();
      });
      start.appendChild(input);
    }

    const len = document.createElement('td');
    len.className = 'time';
    len.textContent = c.error ? 'unreadable' : formatTime(c.duration);

    const ctl = document.createElement('td');
    ctl.className = 'ctl';
    const remove = document.createElement('button');
    remove.className = 'icon';
    remove.textContent = '✕';
    remove.title = 'Remove';
    remove.disabled = state.busy;
    remove.addEventListener('click', () => {
      state.clips.splice(i, 1);
      render();
    });
    ctl.appendChild(remove);

    tr.append(num, name, start, len, ctl);
    rows.appendChild(tr);
  });

  $('table').hidden = state.clips.length === 0;
  $('clips-empty').hidden = state.clips.length > 0;
}

function updateSummary() {
  const clips = validClips();
  const v = state.video;
  const lines = [];
  lines.push(v ? `Video: ${formatTime(v.duration)}` : 'Video: missing');
  lines.push(clips.length ? `Voice clips: ${clips.length}` : 'Voice clips: missing');
  $('summary').textContent = lines.join('\n');

  const warnings = [];
  const unset = clips.filter((c) => !Number.isFinite(c.start)).length;
  if (unset) {
    warnings.push(
      `${unset} clip(s) have no start time and will start at 0 s. ` +
        'Add the scene folder (the one with _pack_info.ini) to read their times, or type them in.'
    );
  }
  if (v && clips.length) {
    const end = Math.max(...clips.map((c) => (c.start ?? 0) + c.duration));
    if (end > v.duration + 0.25) {
      warnings.push(`Voice clips run until ${formatTime(end)}, but the video ends at ${formatTime(v.duration)}. Audio after the end is cut.`);
    }
  }
  $('warning').textContent = warnings.join('\n');
  $('warning').hidden = !warnings.length;

  $('make').disabled = !v || !clips.length || state.busy;
}

function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = '';
  el.hidden = !text;
  el.className = `status ${kind}`;
  if (text) el.append(text);
  return el;
}

function setBusy(busy) {
  state.busy = busy;
  for (const id of ['clear', 'pick-scene', 'pick-recordings', 'compress', 'max-mb']) {
    $(id).disabled = busy;
  }
  $('max-mb').disabled = busy || !$('compress').checked;
  $('progress-wrap').hidden = !busy;
  render();
}

function formatSize(bytes) {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

async function makeVideo() {
  const clips = validClips();
  if (!state.video || !clips.length) return;
  const dir = state.video.path.replace(/[\\/][^\\/]*$/, '');
  const name = state.video.name.replace(/\.[^.]+$/, '') + '_dubbed.mp4';
  const output = await window.api.pickOutput(dir, name);
  if (!output) return;

  const maxMb = parseFloat($('max-mb').value);
  const opts = {
    video: state.video,
    clips: clips.map(({ path, name, duration, start }) => ({ path, name, duration, start })),
    output,
    maxBytes: $('compress').checked && maxMb > 0 ? Math.floor(maxMb * 1e6) : 0,
  };

  setStatus('');
  $('progress').value = 0;
  $('progress-text').textContent = 'Starting…';
  setBusy(true);
  try {
    const res = await window.api.makeVideo(opts);
    const el = setStatus(`Saved ${output} (${formatSize(res.size)}) `, 'ok');
    const open = document.createElement('button');
    open.className = 'link';
    open.textContent = 'Show in folder';
    open.addEventListener('click', () => window.api.showInFolder(output));
    el.appendChild(open);
  } catch (err) {
    const msg = String(err.message || err).replace(/^Error invoking remote method '[\w-]+': (Error: )?/, '');
    setStatus(msg === 'Cancelled' ? 'Cancelled.' : msg, msg === 'Cancelled' ? '' : 'error');
  } finally {
    setBusy(false);
  }
}

window.api.onProgress(({ stage, fraction }) => {
  $('progress').value = fraction;
  $('progress-text').textContent = `${stage}… ${Math.round(fraction * 100)}%`;
});

// pickFolder returns null when the dialog is cancelled
for (const [id, kind] of [['pick-scene', 'scene'], ['pick-recordings', 'recordings']]) {
  $(id).addEventListener('click', async () => {
    const paths = await window.api.pickFolder(kind);
    if (paths) addPaths(paths);
  });
}
$('video-remove').addEventListener('click', () => {
  state.video = null;
  render();
});
$('clear').addEventListener('click', () => {
  state.video = null;
  state.clips = [];
  state.timings = {};
  setStatus('');
  render();
});
$('make').addEventListener('click', makeVideo);
$('cancel').addEventListener('click', () => window.api.cancel());
$('compress').addEventListener('change', () => ($('max-mb').disabled = !$('compress').checked));

// Drag & drop: both areas accept any mix of files, and each file goes where it belongs.
// A dropped folder is read like the area's button reads it (scene or recordings).
for (const [zone, kind] of [[$('video-drop'), 'scene'], [$('clips-drop'), 'recordings']]) {
  ['dragenter', 'dragover'].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      if (!state.busy) zone.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove('over')));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    if (state.busy) return;
    const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
    addPaths(paths, kind);
  });
}
// Prevent the window from navigating to a file dropped outside the drop areas.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

$('max-mb').disabled = true;
render();
