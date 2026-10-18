'use strict';
/* Runs export plans: vspipe | ffmpeg pipelines, plain ffmpeg, post steps. Progress + cancel. */
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const rt = require('./runtime');

function envFor() {
  const P = rt.paths();
  const vsDir = path.dirname(P.python);
  const env = { ...process.env };
  env.PATH = [vsDir, path.join(vsDir, 'vs-plugins'), path.dirname(P.ffmpeg), env.PATH || ''].join(';');
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONNOUSERSITE = '1';
  delete env.PYTHONHOME; delete env.PYTHONPATH;
  return env;
}

function killTree(p) {
  if (!p || p.exitCode != null) return;
  try { execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch (e) { try { p.kill(); } catch (_) {} }
}

class Job {
  constructor(id, plan, onEvent, logFile = null) {
    this.id = id; this.plan = plan; this.onEvent = onEvent;
    this.procs = []; this.cancelled = false; this.log = [];
    this.logFile = logFile;
    if (logFile) {
      try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        const head = [`7krh Studio job ${id}  ${new Date().toISOString()}`, 'expect ' + JSON.stringify(plan.expect), 'up ' + JSON.stringify(plan.up || null) + '  fg ' + JSON.stringify(plan.fg || null) + '  encoder ' + plan.encoder];
        for (const st of plan.steps) {
          head.push('--- step ' + st.kind);
          if (st.vpy) head.push(st.vpy);
          if (st.vspipe) head.push('VSPIPE ' + st.vspipe.join(' '));
          if (st.ffmpeg) head.push('FFMPEG ' + st.ffmpeg.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' '));
        }
        fs.writeFileSync(logFile, head.join('\n') + '\n--- output\n');
      } catch (e) { this.logFile = null; }
    }
  }
  fileLog(s) { if (this.logFile) try { fs.appendFileSync(this.logFile, s + '\n'); } catch (e) {} }
  emit(o) { this.onEvent({ id: this.id, ...o }); }
  cancel() { this.cancelled = true; this.procs.forEach(killTree); }

  logLine(s) { this.log.push(s); if (this.log.length > 400) this.log.splice(0, 100); this.fileLog(s); }

  progressReader(stream, total, weight, base) {
    let buf = '', t0 = Date.now();
    stream.on('data', d => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/); buf = lines.pop();
      let frame = null, speedx = null, outUs = null;
      for (const l of lines) {
        const [k, v] = l.split('=');
        if (k === 'frame') frame = +v; else if (k === 'speed') speedx = parseFloat(v); else if (k === 'out_time_us') outUs = +v;
      }
      if (frame != null) {
        const el = (Date.now() - t0) / 1000;
        if (!this._lp || Date.now() - this._lp > 5000) { this._lp = Date.now(); this.fileLog(`progress frame=${frame}/${total} t=${el.toFixed(1)}s fps=${(frame / Math.max(el, 0.01)).toFixed(2)}`); }
        const frac = Math.min(1, frame / total);
        const fps = el > 0 ? frame / el : 0;
        const eta = fps > 0 ? (total - frame) / fps : null;
        this.emit({ type: 'progress', frac: base + frac * weight, frame, total, fps, eta, speed: speedx });
      }
    });
  }

  spawn(cmd, args, opts = {}) {
    const p = spawn(cmd, args, { windowsHide: true, env: envFor(), ...opts });
    this.procs.push(p);
    p.stderr && p.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && this.logLine(path.basename(cmd) + ': ' + l)));
    return p;
  }

  waitExit(p) { return new Promise(res => { if (p.exitCode != null) return res(p.exitCode); p.on('close', c => res(c)); p.on('error', e => { this.logLine(String(e)); res(-1); }); }); }

  async run(tmp) {
    const t0 = Date.now();
    try { await this._run(tmp); this.fileLog(`DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`); }
    catch (e) { this.fileLog(`FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e && e.message}`); throw e; }
  }

  async _run(tmp) {
    const total = this.plan.expect.frames;
    const mainSteps = this.plan.steps.filter(s => !s.post && s.kind !== 'move').length || 1;
    let i = 0;
    for (const st of this.plan.steps) {
      if (this.cancelled) throw new Error('cancelled');
      if (st.kind === 'pipe') {
        const vpy = path.join(tmp, 'job.vpy');
        fs.writeFileSync(vpy, st.vpy);
        this.emit({ type: 'phase', phase: 'ai' });
        const vargs = st.vspipe.slice(1).map(a => (a === '{VPY}' ? vpy : a));
        const vs = this.spawn(st.vspipe[0], vargs);
        const ff = this.spawn(st.ffmpeg[0], st.ffmpeg.slice(1));
        vs.stdout.pipe(ff.stdin);
        ff.stdin.on('error', () => {});
        vs.stdout.on('error', () => {});
        this.progressReader(ff.stdout, total, 0.98 / mainSteps, i / mainSteps);
        const [cv, cf] = await Promise.all([this.waitExit(vs), this.waitExit(ff)]);
        if (this.cancelled) throw new Error('cancelled');
        if (cf !== 0 || (cv !== 0 && cv !== null)) throw new Error(`pipeline failed (vspipe ${cv}, ffmpeg ${cf})\n` + this.log.slice(-25).join('\n'));
        i++;
      } else if (st.kind === 'ffmpeg') {
        this.emit({ type: 'phase', phase: st.post ? 'platform' : 'encode' });
        const ff = this.spawn(st.ffmpeg[0], st.ffmpeg.slice(1));
        if (!st.post) this.progressReader(ff.stdout, total, 0.98 / mainSteps, i / mainSteps);
        const c = await this.waitExit(ff);
        if (this.cancelled) throw new Error('cancelled');
        if (c !== 0) throw new Error(`ffmpeg failed (${c})\n` + this.log.slice(-25).join('\n'));
        if (!st.post) i++;
      } else if (st.kind === 'move') {
        try { fs.renameSync(st.from, st.to); } catch (e) { fs.copyFileSync(st.from, st.to); fs.unlinkSync(st.from); }
      }
    }
    this.emit({ type: 'progress', frac: 1 });
  }
}

module.exports = { Job, envFor, killTree };
