'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  video: null,
  clips: [],
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

// Probe the files, then put video files into the video slot and audio files into the clip list.
async function addPaths(paths) {
  const known = new Set(state.clips.map((c) => c.path));
  const fresh = paths.filter((p) => !known.has(p) && (!state.video || state.video.path !== p));
  if (!fresh.length) return;
  setStatus(`Reading ${fresh.length} file(s)…`);
  const probed = await window.api.probe(fresh);
  const messages = [];

  const videos = probed.filter((f) => !f.error && f.hasVideo);
  if (videos.length) {
    state.video = videos[0];
    if (videos.length > 1) messages.push(`Several videos added; using ${videos[0].name}.`);
  }
  const clips = probed.filter((f) => f.error || !f.hasVideo);
  state.clips.push(...clips);
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
  if (unset) warnings.push(`${unset} clip(s) have no start time and will start at 0 s.`);
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
  for (const id of ['add-folder', 'clear', 'pick-video', 'pick-clips', 'compress', 'max-mb']) {
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

$('pick-video').addEventListener('click', async () => addPaths(await window.api.pickVideo()));
$('pick-clips').addEventListener('click', async () => addPaths(await window.api.pickClips()));
$('add-folder').addEventListener('click', async () => addPaths(await window.api.pickFolder()));
$('video-remove').addEventListener('click', () => {
  state.video = null;
  render();
});
$('clear').addEventListener('click', () => {
  state.video = null;
  state.clips = [];
  setStatus('');
  render();
});
$('make').addEventListener('click', makeVideo);
$('cancel').addEventListener('click', () => window.api.cancel());
$('compress').addEventListener('change', () => ($('max-mb').disabled = !$('compress').checked));

// Drag & drop: both areas accept any mix of files; each file goes where it belongs.
for (const zone of [$('video-drop'), $('clips-drop')]) {
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
    addPaths(paths);
  });
}
// Prevent the window from navigating to a file dropped outside the drop areas.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

$('max-mb').disabled = true;
render();
