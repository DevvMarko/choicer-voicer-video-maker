'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Resolve the bundled ffmpeg binary. Inside a packaged Electron app the
// binaries live in app.asar.unpacked, so the path has to be rewritten.
function fixAsarPath(p) {
  return p ? p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`) : p;
}

// CVVM_FFMPEG overrides the binary; without a bundled one the system ffmpeg is used.
function resolveFfmpeg() {
  if (process.env.CVVM_FFMPEG) return process.env.CVVM_FFMPEG;
  try {
    const bundled = fixAsarPath(require('ffmpeg-static'));
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch (_) {
    // fall through to system binary
  }
  return 'ffmpeg';
}

const FFMPEG = resolveFfmpeg();

// Choicer Voicer names dub records like "_dubrecord_03_Hamshow_06-538.wav":
// the trailing "06-538" is the clip's start time in the scene (seconds-milliseconds).
// Longer scenes may use "MM-SS-mmm" or "HH-MM-SS-mmm", so groups are read from the right.
function parseStartFromName(fileName) {
  const base = path.basename(fileName).replace(/\.[^.]+$/, '');
  const m = base.match(/_(\d+(?:-\d+)+)$/);
  if (!m) return null;
  const parts = m[1].split('-');
  const ms = parts.pop();
  let seconds = Number(`0.${ms}`);
  const multipliers = [1, 60, 3600];
  for (let i = 0; i < parts.length && i < multipliers.length; i++) {
    seconds += Number(parts[parts.length - 1 - i]) * multipliers[i];
  }
  return Number.isFinite(seconds) ? seconds : null;
}

// Probe with ffmpeg itself (no separate ffprobe binary to ship). Remuxing to the null
// muxer is fast and -progress reports the exact length in microseconds; the stream list
// comes from the input summary on stderr.
function probe(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      FFMPEG,
      ['-hide_banner', '-nostats', '-i', filePath, '-map', '0:a?', '-map', '0:v?', '-c', 'copy', '-f', 'null', '-progress', 'pipe:1', '-'],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const reason = String(stderr).trim().split('\n').pop() || err.message;
          return reject(new Error(`Could not read ${path.basename(filePath)}: ${reason}`));
        }
        const streams = String(stderr).split('\n').filter((l) => /^\s*Stream #\d+:\d+/.test(l));
        const videoLine = streams.find((l) => / Video: /.test(l) && !/attached pic/.test(l));
        const hasVideo = Boolean(videoLine);
        const hasAudio = streams.some((l) => / Audio: /.test(l));
        if (!hasVideo && !hasAudio) return reject(new Error(`${path.basename(filePath)} has no audio or video`));

        // out_time is exact for audio but stops at the last video frame's timestamp, so
        // video files (or anything without progress output) use the container Duration,
        // which ffmpeg rounds to 10 ms.
        const times = String(stdout).match(/out_time_us=(\d+)/g) || [];
        let duration = times.length ? Number(times[times.length - 1].split('=')[1]) / 1e6 : 0;
        const m = String(stderr).match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m && (hasVideo || !duration)) {
          duration = Math.max(duration, Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
        }

        const info = {
          path: filePath,
          name: path.basename(filePath),
          duration,
          hasVideo,
          hasAudio,
          start: parseStartFromName(filePath),
        };
        if (videoLine) {
          const size = videoLine.match(/, (\d{2,5})x(\d{2,5})/);
          const fps = videoLine.match(/, ([\d.]+) (?:fps|tbr)/);
          info.width = size ? Number(size[1]) : 0;
          info.height = size ? Number(size[2]) : 0;
          info.fps = fps ? Number(fps[1]) : 0;
        }
        resolve(info);
      }
    );
  });
}

const fmt = (n) => n.toFixed(3);

// Mix all voice clips into one track; each clip starts at its own timestamp,
// overlapping parts are mixed and gaps stay silent.
function buildMixArgs(clips, output) {
  const args = ['-y', '-hide_banner', '-nostats', '-progress', 'pipe:1'];
  clips.forEach((c) => args.push('-i', c.path));
  const filters = [];
  let total = 0;
  clips.forEach((c, i) => {
    const start = Number.isFinite(c.start) ? Math.max(0, c.start) : 0;
    const startMs = Math.round(start * 1000);
    filters.push(`[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${startMs}:all=1[a${i}]`);
    total = Math.max(total, startMs / 1000 + c.duration);
  });
  const labels = clips.map((_, i) => `[a${i}]`).join('');
  filters.push(`${labels}amix=inputs=${clips.length}:normalize=0:dropout_transition=0[aout]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[aout]', '-c:a', 'pcm_s16le', output);
  return { args, total };
}

// Size limit: encode with constant quality (CRF) but cap the bitrate with x264's VBV.
// The output can then never be bigger than maxrate * duration + bufsize (+ audio),
// while easy content still comes out smaller than the limit. Long videos get a
// smaller picture / frame rate so the capped bitrate still looks reasonable.
function planCompression(video, targetBytes) {
  const duration = video.duration;
  // keep ~3% for MP4 container overhead
  const budgetBits = targetBytes * 8 * 0.97;
  let audioBps = 128000;
  if (budgetBits / duration < 600000) audioBps = 96000;
  if (budgetBits / duration < 250000) audioBps = 64000;
  // bufsize = 2 s of maxrate: maxrate * duration + 2 * maxrate = video budget
  const videoBps = Math.floor((budgetBits - audioBps * duration) / (duration + 2));
  if (videoBps < 100000) {
    throw new Error(
      `The video is too long (${duration.toFixed(0)} s) to fit in ${(targetBytes / 1e6).toFixed(0)} MB with watchable quality.`
    );
  }
  let maxHeight = Infinity;
  if (videoBps < 2500000) maxHeight = 720;
  if (videoBps < 1200000) maxHeight = 540;
  if (videoBps < 700000) maxHeight = 480;
  if (videoBps < 350000) maxHeight = 360;
  const height = video.height && video.height > maxHeight ? maxHeight : 0;
  const fps = video.fps > 30 && videoBps < 3000000 ? 30 : 0;
  return { videoBps, audioBps, height, fps };
}

function videoFilter(plan) {
  const f = [];
  if (plan && plan.height) f.push(`scale=-2:${plan.height}`);
  if (plan && plan.fps) f.push(`fps=${plan.fps}`);
  f.push('scale=trunc(iw/2)*2:trunc(ih/2)*2', 'format=yuv420p');
  return f.join(',');
}

// Encode the video stream of `video` together with the mixed voice track;
// the video's own audio is dropped. `plan` (from planCompression) caps the size.
function buildEncodeArgs({ video, audioPath, output, plan }) {
  const args = ['-y', '-hide_banner', '-nostats', '-progress', 'pipe:1', '-i', video.path, '-i', audioPath];
  args.push('-map', '0:v:0', '-map', '1:a:0', '-vf', videoFilter(plan), '-c:v', 'libx264', '-crf', '20');
  if (plan) {
    args.push('-preset', 'medium', '-maxrate', String(plan.videoBps), '-bufsize', String(plan.videoBps * 2));
  } else {
    args.push('-preset', 'veryfast');
  }
  // the voice track is padded with silence / cut so it matches the video length
  args.push(
    '-af', 'apad',
    '-c:a', 'aac', '-b:a', String(plan ? plan.audioBps : 192000),
    '-t', fmt(video.duration),
    '-map_metadata', '-1',
    '-movflags', '+faststart',
    output
  );
  return args;
}

// Run one ffmpeg command. onFraction receives 0..1 based on `duration`.
function run(args, duration, onFraction, job) {
  return new Promise((resolve, reject) => {
    if (job.cancelled) return reject(new Error('Cancelled'));
    const proc = spawn(FFMPEG, args, { windowsHide: true, cwd: job.tmpDir });
    job.proc = proc;
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      const m = String(chunk).match(/out_time_us=(\d+)/g);
      if (m && duration > 0) {
        const us = Number(m[m.length - 1].split('=')[1]);
        onFraction(Math.max(0, Math.min(1, us / 1e6 / duration)));
      }
    });
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    proc.on('error', (e) => reject(new Error(`Could not start ffmpeg (${FFMPEG}): ${e.message}`)));
    proc.on('close', (code) => {
      job.proc = null;
      if (job.cancelled) return reject(new Error('Cancelled'));
      if (code === 0) {
        onFraction(1);
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}\n${stderr.trim()}`));
      }
    });
  });
}

// Replace the video's original audio with the mixed voice clips.
// opts: { video, clips, output, maxBytes (0 = no size limit) }
// onProgress({ stage, fraction }) — fraction is for the whole job.
function makeVideo(opts, onProgress) {
  const { video, clips, output, maxBytes } = opts;
  const job = { cancelled: false, proc: null, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cvvm-')) };
  const report = (stage, from, to) => (f) => onProgress && onProgress({ stage, fraction: from + (to - from) * f });

  const promise = (async () => {
    if (!video) throw new Error('Add a video file first.');
    if (!clips.length) throw new Error('Add the voice clips (.wav) first.');
    const mixPath = path.join(job.tmpDir, 'voices.wav');
    const mix = buildMixArgs(clips, mixPath);
    await run(mix.args, mix.total, report('Mixing voice clips', 0, 0.05), job);

    if (!maxBytes) {
      await run(buildEncodeArgs({ video, audioPath: mixPath, output }), video.duration, report('Encoding video', 0.05, 1), job);
      return { output, size: fs.statSync(output).size };
    }

    const plan = planCompression(video, maxBytes);
    // The VBV cap keeps the size in budget; should it still overshoot, retry lower.
    for (let attempt = 0; attempt < 3; attempt++) {
      const label = attempt ? `Compressing (retry ${attempt})` : 'Compressing video';
      const args = buildEncodeArgs({ video, audioPath: mixPath, output, plan });
      await run(args, video.duration, report(label, attempt ? 0.5 : 0.05, 1), job);
      const size = fs.statSync(output).size;
      if (size <= maxBytes) return { output, size, plan };
      plan.videoBps = Math.floor(plan.videoBps * (maxBytes / size) * 0.95);
    }
    throw new Error(`Could not get the video under ${(maxBytes / 1e6).toFixed(0)} MB.`);
  })();

  promise
    .catch(() => {})
    .finally(() => fs.rm(job.tmpDir, { recursive: true, force: true }, () => {}));

  return {
    promise,
    cancel: () => {
      job.cancelled = true;
      if (job.proc) job.proc.kill();
    },
  };
}

module.exports = { probe, makeVideo, buildMixArgs, buildEncodeArgs, planCompression, parseStartFromName, FFMPEG };
