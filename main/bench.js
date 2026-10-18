'use strict';
/* Measures this PC for real: every AI engine runs the same kind of work an export does, each in its own
   process (one failing engine never hides the others). Results are cached in userData/bench.json and used
   to pick the fastest engine automatically and to show honest time estimates. */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const rt = require('./runtime');
const gpu = require('./gpu');
const img = require('./imgserver');
const { envFor } = require('./jobs');

const HEAD = `
import json, time, sys, os
import vapoursynth as vs
core = vs.core
P = json.loads(sys.argv[1])
def load(p):
    try: core.std.LoadPlugin(p)
    except vs.Error as e:
        if 'already loaded' not in str(e): raise
def clip(w, h, n):
    c = core.std.BlankClip(width=w, height=h, format=vs.RGBS, length=n, fpsnum=30)
    return core.std.Expr(c, ['X 7 % 0.1 * Y 5 % 0.12 * + N 3 % 0.05 * +'] * 3)
def speed(c, n, warm=2):
    t = time.perf_counter()
    for i in range(warm): c.get_frame(i)
    first = time.perf_counter() - t
    t = time.perf_counter(); k = 0
    for i in range(warm, min(c.num_frames, warm + n)):
        c.get_frame(i); k += 1
    return round(k / (time.perf_counter() - t), 2), round(first, 1)
res = {}
`;

const RIFE = HEAD + `
load(P['rife'])
for m, idx in (('4.26', 72), ('4.6', 23)):
    for (w, h) in ((1920, 1080), (3840, 2160)):
        try:
            o = core.rife.RIFE(clip(w, h, 40), model=idx, factor_num=2, factor_den=1, gpu_thread=2, gpu_id=P['gpu'], uhd=(w * h > 2600000))
            fps, first = speed(o, 40 if w < 2000 else 24)
            res['rife_%s_%dp_fps' % (m, h)] = fps
        except Exception as e:
            res['rife_%s_error' % m] = str(e)[:400]
print('RESULT ' + json.dumps(res))
`;

const UPSCALE = HEAD + `
be_name = P['backend']
load(P['plugin'])
import vsmlrt
from vsmlrt import Backend
g = P['gpu']
if be_name == 'ort': be = Backend.ORT_DML(fp16=True, num_streams=2, device_id=g)
elif be_name == 'ncnn': be = Backend.NCNN_VK(fp16=True, num_streams=2, device_id=g)
elif be_name == 'trt': be = Backend.TRT_RTX(fp16=True, num_streams=2, device_id=g, engine_folder=P['engines'])
for (w, h) in P['sizes']:
    key = 'esrgan_%s_%dp_fps' % (be_name, w)
    try:
        t = time.perf_counter()
        o = vsmlrt.inference(clip(w, h, 30), P['model'], backend=be)
        fps, first = speed(o, 16 if w < 1000 else 10)
        res[key] = fps
        res['esrgan_%s_%dp_first_s' % (be_name, w)] = round(time.perf_counter() - t, 1)
    except Exception as e:
        res['esrgan_%s_%dp_error' % (be_name, w)] = str(e)[-400:]
print('RESULT ' + json.dumps(res))
`;

function runPy(code, arg, timeout = 600000) {
  const P = rt.paths();
  return new Promise((resolve) => {
    const p = spawn(P.python, ['-X', 'utf8', '-c', code, arg], { windowsHide: true, env: envFor() });
    let out = '', err = '';
    const to = setTimeout(() => { try { p.kill(); } catch (e) {} err += '\n[timeout]'; }, timeout);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(to); resolve({ error: String(e) }); });
    p.on('close', code => {
      clearTimeout(to);
      const m = out.match(/RESULT (.*)/);
      resolve(m ? JSON.parse(m[1]) : { error: `exit ${code}: ${(err || out).slice(-900)}` });
    });
  });
}

function cached(ud) { try { return JSON.parse(fs.readFileSync(path.join(ud, 'bench.json'), 'utf8')); } catch (e) { return null; } }

/* fastest working AI upscale engine on this PC (720p working size is the default export case) */
function bestBackend(ud) {
  const b = cached(ud); if (!b || !b.vs) return null;
  const sc = n => b.vs[`esrgan_${n}_720p_fps`] || b.vs[`esrgan_${n}_540p_fps`] || 0;
  const order = ['trt', 'ort', 'ncnn'].map(n => [n, sc(n)]).filter(x => x[1] > 0).sort((a, c) => c[1] - a[1]);
  return order.length ? order[0][0] : null;
}

async function run(ud, settings, onProgress = () => {}) {
  const P = rt.paths();
  const t0 = Date.now();
  const g = settings.gpu || 0;
  let ver = ''; try { ver = require('electron').app.getVersion(); } catch (e) {}
  const report = { time: new Date().toISOString(), appVersion: ver, benchVersion: 2, runtime: rt.status(), vs: {} };
  onProgress({ step: 'caps' });
  report.caps = await gpu.caps(ud, true);
  const merge = r => Object.assign(report.vs, r.error ? { [r.k + '_error']: r.error } : r);
  onProgress({ step: 'rife' });
  merge({ k: 'rife', ...(await runPy(RIFE, JSON.stringify({ rife: P.plugins.rife, gpu: g }))) });
  const engines = path.join(ud, 'engines');
  for (const [name, plugin] of [['ort', P.plugins.vsort], ['ncnn', P.plugins.vsncnn], ['trt', P.plugins.vstrt]]) {
    if (!plugin || !fs.existsSync(plugin)) { report.vs[`esrgan_${name}_error`] = 'not installed'; continue; }
    onProgress({ step: 'upscale_' + name });
    // TensorRT builds an engine the first time (minutes); later runs reuse it from userData\engines
    const sizes = name === 'trt' ? [[720, 1280]] : [[540, 960], [720, 1280], [1080, 1920]];
    merge({ k: 'esrgan_' + name, ...(await runPy(UPSCALE, JSON.stringify({ backend: name, plugin, model: P.models.real_x4, gpu: g, engines, sizes }), name === 'trt' ? 1500000 : 600000)) });
  }
  onProgress({ step: 'image' });
  try { report.image = await img.call('bench', { device: g }); } catch (e) { report.image = { error: String(e.message || e).slice(0, 800) }; }
  report.best = (() => { fs.writeFileSync(path.join(ud, 'bench.json'), JSON.stringify(report, null, 1)); return bestBackend(ud); })();
  report.secs = Math.round((Date.now() - t0) / 1000);
  fs.writeFileSync(path.join(ud, 'bench.json'), JSON.stringify(report, null, 1));
  onProgress({ step: 'done' });
  return report;
}

module.exports = { run, cached, bestBackend };
