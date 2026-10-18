'use strict';
/* Engine manager: what is installed, how big it is, what it is for, whether it works on this PC.
   Everything ships inside the installer (nothing is downloaded behind the user's back); this module checks
   the files against the manifest written at build time (size + SHA-256) and combines that with the
   measured results of the performance test. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rt = require('./runtime');

/* id, files (runtime-relative or absolute), purpose, licence, which processor it runs on */
function components() {
  const P = rt.paths(), r = P.root;
  const rel = p => (p ? path.relative(r, p) : null);
  return [
    { id: 'ffmpeg', name: 'FFmpeg', use: 'decode_encode', license: 'GPL-3.0', device: 'gpu-encode', files: [rel(path.dirname(P.ffmpeg))], required: true },
    { id: 'python', name: 'Python 3.12 + ONNX Runtime (DirectML)', use: 'image_ai', license: 'PSF / MIT', device: 'gpu-ai', files: [rel(P.python), 'vs/Lib/site-packages/onnxruntime'], required: true },
    { id: 'vapoursynth', name: 'VapourSynth + L-SMASH Works', use: 'video_frames', license: 'LGPL-2.1', device: 'cpu', files: [rel(P.vspipe), rel(P.plugins.lsmas)], required: true },
    { id: 'vsort', name: 'vs-mlrt · ONNX Runtime DirectML', use: 'video_ai', license: 'GPL-3.0', device: 'gpu-ai', bench: 'ort', files: [rel(P.plugins.vsort)] },
    { id: 'vsncnn', name: 'vs-mlrt · ncnn Vulkan', use: 'video_ai', license: 'GPL-3.0', device: 'gpu-ai', bench: 'ncnn', files: [rel(P.plugins.vsncnn)] },
    { id: 'vstrt', name: 'vs-mlrt · TensorRT-RTX (NVIDIA)', use: 'video_ai', license: 'GPL-3.0 / NVIDIA', device: 'gpu-ai', bench: 'trt', files: [rel(P.plugins.vstrt)], nvidiaOnly: true },
    { id: 'rife', name: 'RIFE ncnn Vulkan (4.6, 4.22, 4.25, 4.26)', use: 'frames_ai', license: 'MIT', device: 'gpu-ai', bench: 'rife', files: [rel(P.plugins.rife), 'vs-plugins/models'] },
    { id: 'esrgan_general', name: 'Real-ESRGAN general x4v3', use: 'model_video', license: 'BSD-3', device: 'model', files: [rel(P.models.real_x4)] },
    { id: 'esrgan_x4plus', name: 'Real-ESRGAN x4plus', use: 'model_photo', license: 'BSD-3', device: 'model', files: [rel(P.models.photo_x4)] },
    { id: 'esrgan_anime', name: 'Real-ESRGAN animevideo v3', use: 'model_anime', license: 'BSD-3', device: 'model', files: [rel(P.models.anime_x4)] },
    { id: 'rnnoise', name: 'RNNoise (voice noise removal)', use: 'audio_ai', license: 'BSD-3', device: 'cpu', files: [rel(P.models.rnnoise)] },
  ];
}

function sizeOf(p) {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size;
    let s = 0; for (const e of fs.readdirSync(p, { withFileTypes: true })) s += sizeOf(path.join(p, e.name)); return s;
  } catch (e) { return -1; }
}

/* quick status (sizes only) */
function status(bench, caps) {
  const P = rt.paths(), r = P.root;
  const man = readManifest();
  if (bench && !(bench.benchVersion >= 4)) bench = null; // results from the broken v3 test are ignored
  const vs = (bench && bench.vs) || {};
  const nvidia = !!(caps && caps.nvidia);
  return components().map(c => {
    const files = c.files.filter(Boolean);
    const sizes = files.map(f => sizeOf(path.isAbsolute(f) ? f : path.join(r, f)));
    const missing = !files.length || sizes.some(s => s < 0);
    let state = missing ? 'missing' : 'ready', detail = '';
    if (!missing && man.files) {
      for (const f of files) { const m = man.files[f.replace(/\//g, '\\')] || man.files[f]; const s = sizeOf(path.join(r, f)); if (m && s >= 0 && m.size !== s) { state = 'damaged'; detail = f; } }
    }
    if (state === 'ready' && c.nvidiaOnly && caps && !nvidia) state = 'incompatible';
    if (state === 'ready' && c.bench && bench) {
      const err = c.bench === 'rife' ? vs['rife_4.26_error'] || vs.rife_error : vs[`esrgan_${c.bench}_720p_error`] || vs[`esrgan_${c.bench}_error`];
      const ok = c.bench === 'rife' ? vs['rife_4.26_1080p_fps'] : vs[`esrgan_${c.bench}_720p_fps`];
      if (err && !ok && !/not installed|not an NVIDIA/.test(err)) { state = 'failed'; detail = String(err).slice(-200); }
      if (ok) detail = (c.bench === 'rife' ? 'RIFE 4.26 1080p ×2: ' : '720p → ×4: ') + ok + ' fps';
    }
    return { ...c, state, detail, bytes: sizes.filter(s => s > 0).reduce((a, b) => a + b, 0) };
  });
}

function readManifest() { try { return JSON.parse(fs.readFileSync(path.join(rt.paths().root, 'manifest.json'), 'utf8').replace(/^﻿/, '')); } catch (e) { return {}; } }

/* full integrity check against the SHA-256 written by scripts/fetch-runtime.ps1 */
async function verify(onProgress = () => {}) {
  const r = rt.paths().root, man = readManifest();
  const list = Object.entries(man.files || {});
  const bad = [];
  let i = 0;
  for (const [rel, m] of list) {
    const f = path.join(r, rel);
    const h = await new Promise(res => {
      const s = crypto.createHash('sha256'); const st = fs.createReadStream(f);
      st.on('data', d => s.update(d)); st.on('end', () => res(s.digest('hex'))); st.on('error', () => res(null));
    });
    if (!h) bad.push({ file: rel, why: 'missing' }); else if (m.sha256 && h !== m.sha256.toLowerCase()) bad.push({ file: rel, why: 'changed' });
    onProgress(++i / Math.max(1, list.length));
  }
  return { checked: list.length, bad, ok: !bad.length, hasHashes: list.length > 0 };
}

module.exports = { components, status, verify, readManifest };
