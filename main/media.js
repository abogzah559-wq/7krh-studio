'use strict';
/* Media probing, timeline thumbnails, preview frames and playback proxies. */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const rt = require('./runtime');

const HIDE = { windowsHide: true };

function run(cmd, args, { timeout = 120000, input = null, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, HIDE);
    const out = [], err = [];
    let to = setTimeout(() => { try { p.kill(); } catch (e) {} reject(new Error('timeout: ' + path.basename(cmd))); }, timeout);
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => err.push(d));
    p.on('error', e => { clearTimeout(to); reject(e); });
    p.on('close', code => {
      clearTimeout(to);
      const o = Buffer.concat(out), e = Buffer.concat(err).toString();
      if (code === 0) resolve(binary ? o : o.toString());
      else reject(new Error(`${path.basename(cmd)} exited ${code}: ${e.slice(-600)}`));
    });
    p.stdin.end(input || undefined); // never leave stdin open: ffmpeg could wait on it
  });
}

const IMG_EXT = /\.(png|jpe?g|webp|bmp|tiff?|avif|heic|gif)$/i;

async function probe(file) {
  const P = rt.paths();
  const j = JSON.parse(await run(P.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
  const v = (j.streams || []).find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = (j.streams || []).find(s => s.codec_type === 'audio');
  const isImage = !!v && (IMG_EXT.test(file) || (j.format && /image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|tiff_pipe/.test(j.format.format_name || '')));
  let rotation = 0;
  if (v) {
    const sd = (v.side_data_list || []).find(s => s.rotation != null);
    if (sd) rotation = -Math.round(+sd.rotation);
    else if (v.tags && v.tags.rotate) rotation = +v.tags.rotate;
    rotation = ((rotation % 360) + 360) % 360;
  }
  const fps = v ? (v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate) : '0/1';
  const dur = +(j.format && j.format.duration) || +(v && v.duration) || 0;
  return {
    path: file, name: path.basename(file), size: +(j.format && j.format.size) || 0,
    kind: !v ? (a ? 'audio' : 'unknown') : isImage ? 'image' : 'video',
    width: v ? v.width : 0, height: v ? v.height : 0, rotation, fps, duration: dur,
    vcodec: v ? v.codec_name : null, pixFmt: v ? v.pix_fmt : null, bitDepth: v && /10|12/.test(v.pix_fmt || '') ? 10 : 8,
    colorSpace: v ? v.color_space || null : null, colorTransfer: v ? v.color_transfer || null : null,
    hdr: !!(v && /smpte2084|arib-std-b67/.test(v.color_transfer || '')),
    hasAudio: !!a, acodec: a ? a.codec_name : null, bitrate: +(j.format && j.format.bit_rate) || 0,
    frames: v && v.nb_frames ? +v.nb_frames : 0,
    fpsNum: v ? (() => { const r = String(fps).split('/'); const x = r.length === 2 ? +r[0] / +r[1] : +r[0]; return Number.isFinite(x) ? x : 0; })() : 0,
    colorPrimaries: v ? v.color_primaries || null : null, sampleRate: a ? +a.sample_rate || 0 : 0, channels: a ? a.channels || 0 : 0,
    container: j.format && j.format.format_name || '',
  };
}

/* N thumbnails across the clip, as JPEG data URLs, using fast input seeking. */
async function thumbs(file, duration, count = 12, height = 72, start = 0) {
  const P = rt.paths();
  const out = [];
  const jobs = [];
  for (let i = 0; i < count; i++) {
    const t = start + (duration > 0 ? (duration * (i + 0.5)) / count : 0);
    jobs.push(run(P.ffmpeg, ['-v', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', `scale=-2:${height}:flags=fast_bilinear`, '-q:v', '5', '-f', 'mjpeg', 'pipe:1'], { binary: true, timeout: 30000 })
      .then(b => { out[i] = 'data:image/jpeg;base64,' + b.toString('base64'); })
      .catch(() => { out[i] = null; }));
    if (jobs.length >= 4) { await Promise.all(jobs); jobs.length = 0; }
  }
  await Promise.all(jobs);
  return out;
}

/* One full-resolution frame (PNG) at time t, for before/after previews. */
async function frame(file, t, outPng) {
  const P = rt.paths();
  await run(P.ffmpeg, ['-v', 'error', '-y', '-ss', Math.max(0, t).toFixed(3), '-i', file, '-frames:v', '1', outPng], { timeout: 60000 });
  return outPng;
}

/* Chromium can't play every codec/container: make a light H.264 proxy for the editor preview. */
async function proxy(file, info, outMp4, onProgress) {
  const P = rt.paths();
  const h = Math.min(720, info.height || 720);
  const args = ['-v', 'error', '-y', '-i', file, '-vf', `scale=-2:${h}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-progress', 'pipe:1', outMp4];
  return new Promise((resolve, reject) => {
    const p = spawn(P.ffmpeg, args, HIDE);
    let buf = '';
    p.stdout.on('data', d => {
      buf += d; const m = buf.match(/out_time_us=(\d+)/g);
      if (m && info.duration) onProgress && onProgress(Math.min(1, +m[m.length - 1].split('=')[1] / 1e6 / info.duration));
      if (buf.length > 4096) buf = buf.slice(-1024);
    });
    p.on('error', reject);
    p.on('close', c => (c === 0 ? resolve(outMp4) : reject(new Error('proxy failed ' + c))));
  });
}

/* Loudness peaks for the timeline waveform: mono 8 kHz PCM, max |sample| per bucket, 0..1 */
async function peaks(file, start, dur, n = 400) {
  const P = rt.paths();
  const args = ['-v', 'error', ...(start > 0 ? ['-ss', start.toFixed(3)] : []), ...(dur > 0 ? ['-t', dur.toFixed(3)] : []), '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'];
  const b = await run(P.ffmpeg, args, { binary: true, timeout: 120000 });
  const total = Math.floor(b.length / 2), per = Math.max(1, Math.floor(total / n)), out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = i * per, e = Math.min(total, (i + 1) * per); j < e; j++) { const v = Math.abs(b.readInt16LE(j * 2)); if (v > m) m = v; }
    out[i] = Math.round(m / 327.68) / 100;
  }
  return out;
}

/* Checks a finished export: it opens, the last second decodes, and duration / size / audio match the plan */
async function verifyOutput(st) {
  const P = rt.paths();
  const problems = [];
  let info = null;
  try { info = await probe(st.file); } catch (e) { return { ok: false, problems: ['cannot open the file: ' + String(e.message || e).slice(0, 200)] }; }
  const size = (() => { try { return fs.statSync(st.file).size; } catch (e) { return 0; } })();
  if (!size) problems.push('empty file');
  if (st.expectDur > 0 && Math.abs(info.duration - st.expectDur) / st.expectDur > (st.tol || 0.03) && Math.abs(info.duration - st.expectDur) > 0.15) problems.push(`duration ${info.duration.toFixed(2)}s, expected ${st.expectDur.toFixed(2)}s`);
  const [w, h] = info.rotation % 180 ? [info.height, info.width] : [info.width, info.height];
  if (st.w && st.h && (w !== st.w || h !== st.h)) problems.push(`size ${w}x${h}, expected ${st.w}x${st.h}`);
  if (st.audio && !info.hasAudio) problems.push('audio missing');
  try {
    await run(P.ffmpeg, ['-v', 'error', '-xerror', '-sseof', '-1', '-i', st.file, '-f', 'null', '-'], { timeout: 120000 });
  } catch (e) { problems.push('the end of the file does not decode'); }
  return { ok: !problems.length, problems, dur: info.duration, w, h, fps: info.fps, audio: info.hasAudio, size, vcodec: info.vcodec, acodec: info.acodec };
}

function canPlayNatively(info) {
  return ['h264', 'vp8', 'vp9', 'av1', 'hevc'].includes(info.vcodec) && !/10|12/.test(info.pixFmt || '') || info.vcodec === 'h264';
}

function tmpDir(name) {
  const d = path.join(os.tmpdir(), '7krh-studio', name || String(Date.now()));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

module.exports = { run, probe, thumbs, frame, proxy, peaks, verifyOutput, canPlayNatively, tmpDir, IMG_EXT };
