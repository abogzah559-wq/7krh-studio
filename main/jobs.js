'use strict';
/* Runs export plans: vspipe | ffmpeg pipelines, plain ffmpeg, header patches, moves and output checks.
   Progress + cancel. Each step: {kind:'pipe'|'ffmpeg'|'patch'|'move'|'verify', files?:{path:content}} */
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const rt = require('./runtime');

const WIN = process.platform === 'win32';
function envFor() {
  const P = rt.paths();
  const vsDir = path.dirname(P.python);
  const env = { ...process.env };
  env.PATH = [vsDir, path.join(vsDir, 'vs-plugins'), path.dirname(P.ffmpeg), env.PATH || ''].join(WIN ? ';' : ':');
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONNOUSERSITE = '1';
  delete env.PYTHONHOME; delete env.PYTHONPATH;
  return env;
}

function killTree(p) {
  if (!p || p.exitCode != null) return;
  if (WIN) { try { execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch (e) { try { p.kill(); } catch (_) {} } }
  else { try { p.kill('SIGKILL'); } catch (e) {} }
}

class Job {
  constructor(id, plan, onEvent, logFile = null, deps = {}) {
    this.id = id; this.plan = plan; this.onEvent = onEvent;
    this.procs = []; this.cancelled = false; this.log = [];
    this.logFile = logFile;
    this.deps = deps; // { platform, verify } injected so this file stays free of Electron
    this.result = {};
    if (logFile) {
      try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        const head = [`7krh Studio job ${id}  ${new Date().toISOString()}`, 'expect ' + JSON.stringify(plan.expect), 'up ' + JSON.stringify(plan.up || null) + '  fg ' + JSON.stringify(plan.fg || null) + '  encoder ' + plan.encoder];
        for (const st of plan.steps) {
          head.push('--- step ' + st.kind);
          if (st.vpy) head.push(st.vpy);
          if (st.vspipe) head.push('VSPIPE ' + st.vspipe.join(' '));
          if (st.ffmpeg) head.push('FFMPEG ' + st.ffmpeg.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' '));
          for (const [f, c] of Object.entries(st.files || {})) head.push(`FILE ${f} (${c.length} chars)` + (c.length < 6000 ? '\n' + c : ''));
          if (st.kind === 'patch') head.push(`PATCH ${st.src} -> ${st.out} k=${st.k}`);
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
    let buf = '';
    const t0 = Date.now();
    stream.on('data', d => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/); buf = lines.pop();
      let frame = null, speedx = null, outUs = null;
      for (const l of lines) {
        const [k, v] = l.split('=');
        if (k === 'frame') frame = +v; else if (k === 'speed') speedx = parseFloat(v); else if (k === 'out_time_us') outUs = +v;
      }
      // audio-only outputs report no frames: use the written duration instead
      if (!frame && outUs > 0 && this.plan.expect.dur > 0) frame = Math.round(outUs / 1e6 / this.plan.expect.dur * total);
      if (frame != null && frame !== this._lastFrame) { this._lastFrame = frame; this.alive = Date.now(); }
      if (frame != null) {
        const el = (Date.now() - t0) / 1000;
        if (!this._lp || Date.now() - this._lp > 5000) { this._lp = Date.now(); this.fileLog(`progress frame=${frame}/${total} t=${el.toFixed(1)}s fps=${(frame / Math.max(el, 0.01)).toFixed(2)}`); }
        const frac = Math.min(1, frame / total);
        const fps = el > 0 ? frame / el : 0;
        const eta = fps > 0 ? (total - frame) / fps : null;
        this.fpsSeen = fps;
        this.emit({ type: 'progress', frac: base + frac * weight, frame, total, fps, eta, speed: speedx, ms: fps > 0 ? 1000 / fps : null });
      }
    });
  }

  spawn(cmd, args, opts = {}) {
    const p = spawn(cmd, args, { windowsHide: true, env: envFor(), ...opts });
    this.procs.push(p);
    this.alive = Date.now();
    const beat = () => { this.alive = Date.now(); };
    p.stderr && p.stderr.on('data', d => { beat(); String(d).split(/\r?\n/).forEach(l => l.trim() && this.logLine(path.basename(cmd) + ': ' + l)); });
    // watchdog: a process whose progress does not advance (and that prints no message) for too long is stuck — stop it and say so
    const limit = this.plan.stallSecs || 300;
    const wd = setInterval(() => {
      if (p.exitCode != null) return clearInterval(wd);
      if ((Date.now() - this.alive) / 1000 > limit) { clearInterval(wd); this.stalled = path.basename(cmd); this.logLine(`${this.stalled}: no output for ${limit}s — stopped`); killTree(p); }
    }, 5000);
    p.on('close', () => clearInterval(wd));
    return p;
  }

  waitExit(p) { return new Promise(res => { if (p.exitCode != null) return res(p.exitCode); p.on('close', c => res(c)); p.on('error', e => { this.logLine(String(e)); res(-1); }); }); }

  async run(tmp) {
    const t0 = Date.now();
    try { await this._run(tmp); this.fileLog(`DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`); }
    catch (e) { this.fileLog(`FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e && e.message}`); throw e; }
    return this.result;
  }

  async _run(tmp) {
    const total = this.plan.expect.frames;
    const heavy = this.plan.steps.filter(s => (s.kind === 'pipe' || s.kind === 'ffmpeg') && !s.post);
    const mainSteps = heavy.length || 1;
    let i = 0;
    for (const st of this.plan.steps) {
      if (this.cancelled) throw new Error('cancelled');
      for (const [f, c] of Object.entries(st.files || {})) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); }
      const stTotal = st.frames || total;
      if (st.kind === 'pipe') {
        const vpy = path.join(tmp, `job${i}.vpy`);
        fs.writeFileSync(vpy, st.vpy);
        this.emit({ type: 'phase', phase: 'ai', step: i + 1, steps: mainSteps });
        const vargs = st.vspipe.slice(1).map(a => (a === '{VPY}' ? vpy : a));
        const vs = this.spawn(st.vspipe[0], vargs);
        const ff = this.spawn(st.ffmpeg[0], st.ffmpeg.slice(1));
        vs.stdout.pipe(ff.stdin);
        ff.stdin.on('error', () => {});
        vs.stdout.on('error', () => {});
        this.progressReader(ff.stdout, stTotal, 0.97 / mainSteps, i * 0.97 / mainSteps);
        const [cv, cf] = await Promise.all([this.waitExit(vs), this.waitExit(ff)]);
        if (this.cancelled) throw new Error('cancelled');
        if (cf !== 0 || (cv !== 0 && cv !== null)) throw new Error(`pipeline failed (vspipe ${cv}, ffmpeg ${cf})\n` + this.log.slice(-25).join('\n'));
        i++;
      } else if (st.kind === 'ffmpeg') {
        this.emit({ type: 'phase', phase: st.post ? 'platform' : (st.phase || 'encode'), step: i + 1, steps: mainSteps });
        let c;
        for (let attempt = 0; ; attempt++) {
          this.stalled = null; this._lastFrame = undefined;
          // a stalled run is retried once with a single-threaded filter graph (rare ffmpeg scheduling stall)
          const args = attempt ? [st.ffmpeg[1], '-filter_complex_threads', '1', ...st.ffmpeg.slice(2)] : st.ffmpeg.slice(1);
          const ff = this.spawn(st.ffmpeg[0], args);
          if (!st.post) this.progressReader(ff.stdout, stTotal, 0.97 / mainSteps, i * 0.97 / mainSteps);
          c = await this.waitExit(ff);
          if (this.cancelled) throw new Error('cancelled');
          if (!(this.stalled && attempt === 0)) break;
          this.logLine('retrying the step once after a stall');
          this.emit({ type: 'phase', phase: st.post ? 'platform' : (st.phase || 'encode'), step: i + 1, steps: mainSteps, retry: true });
        }
        if (c !== 0) throw new Error((this.stalled ? `ffmpeg stopped responding` : `ffmpeg failed (${c})`) + '\n' + this.log.slice(-25).join('\n'));
        if (!st.post) i++;
      } else if (st.kind === 'patch') {
        this.emit({ type: 'phase', phase: 'platform' });
        const r = this.deps.platform.patchTS(st.src, st.out, st.k);
        this.logLine(`patch x${st.k}: ${r.before.toFixed(3)}s -> ${r.dur.toFixed(3)}s`);
        if (st.cleanup) try { fs.unlinkSync(st.src); } catch (e) {}
      } else if (st.kind === 'move') {
        try { fs.renameSync(st.from, st.to); } catch (e) { fs.copyFileSync(st.from, st.to); fs.unlinkSync(st.from); }
      } else if (st.kind === 'verify') {
        this.emit({ type: 'phase', phase: 'verify' });
        const v = await this.deps.verify(st);
        this.result.verify = v;
        this.logLine('verify ' + JSON.stringify(v));
        if (!v.ok) throw new Error('output check failed: ' + v.problems.join('; '));
      }
    }
    this.emit({ type: 'progress', frac: 1 });
  }
}

module.exports = { Job, envFor, killTree };
