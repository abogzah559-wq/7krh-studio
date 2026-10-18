'use strict';
/* Talks to engine/imgserver.py (ONNX Runtime + DirectML) over JSON lines.
   The process is restarted when the chosen graphics card or the GPU-only setting changes. */
const { spawn } = require('child_process');
const path = require('path');
const rt = require('./runtime');
const { envFor, killTree } = require('./jobs');

let proc = null, ready = null, rid = 0, buf = '', key = '';
const pend = new Map();
let lastErr = '';

function start(device = 0, gpuOnly = false, cpu = false) {
  const k = `${device}|${gpuOnly}|${cpu}`;
  if (ready && k === key) return ready;
  if (proc) stop();
  key = k;
  const P = rt.paths();
  const man = JSON.stringify({ photo_x4: P.models.photo_x4, real_x4: P.models.real_x4, anime_x4: P.models.anime_x4, device, gpu_only: !!gpuOnly, cpu: !!cpu });
  const script = path.join(P.engineDir, 'imgserver.py');
  ready = new Promise((resolve, reject) => {
    proc = spawn(P.python, ['-u', '-X', 'utf8', script, man], { windowsHide: true, env: envFor() });
    const me = proc;
    const to = setTimeout(() => reject(new Error('image engine did not start: ' + lastErr.slice(-400))), 60000);
    me.stdout.on('data', d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch (e) { continue; }
        if (m.ready) { clearTimeout(to); resolve(m); continue; }
        const h = pend.get(m.id); if (!h) continue;
        if (m.progress != null && m.ok == null) { h.onProgress && h.onProgress(m.progress); continue; }
        pend.delete(m.id);
        if (m.ok) h.res(m);
        else { const e = new Error(m.err); e.gpuOnly = !!m.gpuOnly; e.oom = !!m.oom; e.trace = m.trace; h.rej(e); }
      }
    });
    me.stderr.on('data', d => { lastErr = (lastErr + d.toString()).slice(-4000); });
    me.on('close', code => {
      clearTimeout(to);
      for (const [, h] of pend) h.rej(new Error('image engine stopped (' + code + '): ' + lastErr.slice(-400)));
      pend.clear(); if (proc === me) { proc = null; ready = null; }
    });
    me.on('error', e => { clearTimeout(to); reject(e); });
  });
  ready.catch(() => { ready = null; });
  return ready;
}

async function call(op, args = {}, onProgress, opts = {}) {
  await start(args.device || 0, !!opts.gpuOnly, !!opts.cpu);
  return new Promise((res, rej) => {
    const id = ++rid;
    pend.set(id, { res, rej, onProgress });
    proc.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
  });
}

/* cancelling a long image job: the only safe way to stop ONNX mid-run is to stop the process */
function cancelAll() { if (proc) stop(); }
function stop() { if (proc) killTree(proc); proc = null; ready = null; buf = ''; }
function lastStderr() { return lastErr; }

module.exports = { start, call, stop, cancelAll, lastStderr };
