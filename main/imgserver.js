'use strict';
/* Talks to engine/imgserver.py (ONNX Runtime + DirectML) over JSON lines. */
const { spawn } = require('child_process');
const path = require('path');
const rt = require('./runtime');
const { envFor, killTree } = require('./jobs');

let proc = null, ready = null, rid = 0, buf = '';
const pend = new Map();
let lastErr = '';

function start(device = 0) {
  if (ready) return ready;
  const P = rt.paths();
  const man = JSON.stringify({ photo_x4: P.models.photo_x4, real_x4: P.models.real_x4, anime_x4: P.models.anime_x4, device });
  const script = path.join(P.engineDir, 'imgserver.py');
  ready = new Promise((resolve, reject) => {
    proc = spawn(P.python, ['-u', '-X', 'utf8', script, man], { windowsHide: true, env: envFor() });
    const to = setTimeout(() => reject(new Error('image engine did not start: ' + lastErr.slice(-400))), 60000);
    proc.stdout.on('data', d => {
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
        m.ok ? h.res(m) : h.rej(new Error(m.err + (m.trace ? '\n' + m.trace : '')));
      }
    });
    proc.stderr.on('data', d => { lastErr = (lastErr + d.toString()).slice(-4000); });
    proc.on('close', code => {
      clearTimeout(to);
      for (const [, h] of pend) h.rej(new Error('image engine stopped (' + code + '): ' + lastErr.slice(-400)));
      pend.clear(); proc = null; ready = null;
    });
    proc.on('error', e => { clearTimeout(to); reject(e); });
  });
  ready.catch(() => { ready = null; });
  return ready;
}

async function call(op, args = {}, onProgress) {
  await start(args.device || 0);
  return new Promise((res, rej) => {
    const id = ++rid;
    pend.set(id, { res, rej, onProgress });
    proc.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
  });
}

function stop() { if (proc) killTree(proc); proc = null; ready = null; }

module.exports = { start, call, stop };
