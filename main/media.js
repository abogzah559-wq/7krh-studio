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
    if (input) { p.stdin.end(input); }
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
  };
}

/* N thumbnails across the clip, as JPEG data URLs, using fast input seeking. */
async function thumbs(file, duration, count = 12, height = 72) {
  const P = rt.paths();
  const out = [];
  const jobs = [];
  for (let i = 0; i < count; i++) {
    const t = duration > 0 ? (duration * (i + 0.5)) / count : 0;
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

function canPlayNatively(info) {
  return ['h264', 'vp8', 'vp9', 'av1', 'hevc'].includes(info.vcodec) && !/10|12/.test(info.pixFmt || '') || info.vcodec === 'h264';
}

function tmpDir(name) {
  const d = path.join(os.tmpdir(), '7krh-studio', name || String(Date.now()));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

module.exports = { run, probe, thumbs, frame, proxy, canPlayNatively, tmpDir, IMG_EXT };
