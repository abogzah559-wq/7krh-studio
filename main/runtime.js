'use strict';
/* Locates the bundled engines and models (resources/runtime in the installed app). */
const path = require('path');
const fs = require('fs');

let RT = null, cache = null;

function root() {
  if (RT) return RT;
  let app = null;
  try { app = require('electron').app; } catch (e) {}
  const cands = [];
  if (process.env.SEVENKRH_RUNTIME) cands.push(process.env.SEVENKRH_RUNTIME);
  if (app && app.isPackaged) cands.push(path.join(process.resourcesPath, 'runtime'));
  cands.push(path.join(__dirname, '..', 'runtime'));
  RT = cands.find(p => fs.existsSync(p)) || cands[cands.length - 1];
  return RT;
}

function findFile(dir, name, depth = 4) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p;
    }
    if (depth > 0) for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { const r = findFile(path.join(dir, e.name), name, depth - 1); if (r) return r; }
    }
  } catch (e) {}
  return null;
}

function paths() {
  if (cache) return cache;
  const r = root();
  let man = {};
  try { man = JSON.parse(fs.readFileSync(path.join(r, 'manifest.json'), 'utf8')); } catch (e) {}
  const abs = p => (p ? (path.isAbsolute(p) ? p : path.join(r, p)) : null);
  const m = man.models || {};
  cache = {
    root: r,
    ffmpeg: abs(man.ffmpeg) || path.join(r, 'ffmpeg', 'ffmpeg.exe'),
    ffprobe: abs(man.ffprobe) || path.join(r, 'ffmpeg', 'ffprobe.exe'),
    python: abs(man.python) || path.join(r, 'vs', 'python.exe'),
    vspipe: abs(man.vspipe) || findFile(path.join(r, 'vs'), 'vspipe.exe') || path.join(r, 'vs', 'vspipe.exe'),
    plugins: {
      lsmas: abs(man.lsmas) || path.join(r, 'vs-plugins', 'LSMASHSource.dll'),
      rife: abs(man.rife) || path.join(r, 'vs-plugins', 'librife.dll'),
      vsort: abs(man.vsort) || path.join(r, 'vs-plugins', 'vsort.dll'),
      vsncnn: abs(man.vsncnn) || path.join(r, 'vs-plugins', 'vsncnn.dll'),
      vstrt: abs(man.vstrt) || path.join(r, 'vs-plugins', 'vstrt_rtx.dll'),
      dir: path.join(r, 'vs-plugins'),
    },
    models: {
      ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, abs(v)])),
      real_x2: abs(m.real_x2), real_x4: abs(m.real_x4), anime_x2: abs(m.anime_x2), anime_x4: abs(m.anime_x4),
      photo_x4: abs(m.photo_x4),
      rifeDir: path.join(r, 'models', 'rife'),
    },
    engineDir: path.join(__dirname, '..', 'engine').replace('app.asar', 'app.asar.unpacked'),
  };
  return cache;
}

function status() {
  const p = paths();
  const check = { ffmpeg: p.ffmpeg, python: p.python, vspipe: p.vspipe, lsmas: p.plugins.lsmas, rife: p.plugins.rife, upscale: p.models.real_x4 };
  const out = {};
  for (const [k, v] of Object.entries(check)) out[k] = !!(v && fs.existsSync(v));
  out.ok = Object.values(out).every(Boolean);
  out.root = p.root;
  return out;
}

module.exports = { root, paths, status, findFile };
