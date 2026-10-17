'use strict';
/* Measures this PC once: which AI backend is fastest for upscaling, RIFE speed, image engine speed.
   Results are cached in userData/bench.json and used for ETAs and automatic backend choice. */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const rt = require('./runtime');
const gpu = require('./gpu');
const img = require('./imgserver');
const { envFor } = require('./jobs');

const VS_BENCH = `
import json, time, sys
import vapoursynth as vs
core = vs.core
P = json.loads(sys.argv[1])
res = {}
def load(p):
    try: core.std.LoadPlugin(p)
    except vs.Error as e:
        if 'already loaded' not in str(e): raise
def speed(clip, n):
    for i in range(3): clip.get_frame(i)
    t = time.perf_counter(); c = 0
    for f in clip.frames(close=True):
        c += 1
        if c >= n: break
    return round(c / (time.perf_counter() - t), 2)
gid = P.get('gpu', 0)
try:
    load(P['rife'])
    for m, idx in (('4.6', 23), ('4.26', 72)):
        src = core.std.BlankClip(width=1920, height=1080, format=vs.RGBS, length=80, fpsnum=30)
        src = core.std.Expr(src, ['x 0.5 +'])
        out = core.rife.RIFE(src, model=idx, factor_num=2, factor_den=1, gpu_thread=2, gpu_id=gid)
        res['rife_' + m + '_1080p_x2_fps'] = speed(out, 100)
except Exception as e:
    res['rife_error'] = str(e)[:300]
import vsmlrt
from vsmlrt import Backend
for name, plug, be in (('ort', P['vsort'], lambda: Backend.ORT_DML(fp16=True, num_streams=2, device_id=gid)),
                       ('ncnn', P['vsncnn'], lambda: Backend.NCNN_VK(fp16=True, num_streams=2, device_id=gid))):
    try:
        load(plug)
        src = core.std.BlankClip(width=960, height=540, format=vs.RGBS, length=40, fpsnum=30)
        src = core.std.Expr(src, ['x 0.3 +'])
        out = vsmlrt.inference(src, P['model'], backend=be())
        res['esrgan_' + name + '_540p_to_4k_fps'] = speed(out, 30)
        src = core.std.BlankClip(width=1920, height=1080, format=vs.RGBS, length=24, fpsnum=30)
        out = vsmlrt.inference(core.std.Expr(src, ['x 0.3 +']), P['model'], backend=be())
        res['esrgan_' + name + '_1080p_x4_fps'] = speed(out, 16)
    except Exception as e:
        res['esrgan_' + name + '_error'] = str(e)[:300]
print('RESULT ' + json.dumps(res))
`;

function runPy(code, arg, timeout = 600000) {
  const P = rt.paths();
  return new Promise((resolve) => {
    const p = spawn(P.python, ['-X', 'utf8', '-c', code, arg], { windowsHide: true, env: envFor() });
    let out = '', err = '';
    const to = setTimeout(() => { try { p.kill(); } catch (e) {} }, timeout);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => {
      clearTimeout(to);
      const m = out.match(/RESULT (.*)/);
      resolve(m ? JSON.parse(m[1]) : { error: `exit ${code}: ${(err || out).slice(-800)}` });
    });
  });
}

function cached(ud) { try { return JSON.parse(fs.readFileSync(path.join(ud, 'bench.json'), 'utf8')); } catch (e) { return null; } }
function bestBackend(ud) {
  const b = cached(ud); if (!b || !b.vs) return null;
  const o = b.vs.esrgan_ort_540p_to_4k_fps || 0, n = b.vs.esrgan_ncnn_540p_to_4k_fps || 0;
  return o === 0 && n === 0 ? null : (n > o * 1.05 ? 'ncnn' : 'ort');
}

async function run(ud, settings, onProgress = () => {}) {
  const P = rt.paths();
  const t0 = Date.now();
  const report = { time: new Date().toISOString(), runtime: rt.status() };
  onProgress({ step: 'caps' });
  report.caps = await gpu.caps(ud, true);
  onProgress({ step: 'video' });
  report.vs = await runPy(VS_BENCH, JSON.stringify({ rife: P.plugins.rife, vsort: P.plugins.vsort, vsncnn: P.plugins.vsncnn, model: P.models.real_x4, gpu: settings.gpu || 0 }));
  onProgress({ step: 'image' });
  try { report.image = await img.call('bench', { device: settings.gpu || 0 }); } catch (e) { report.image = { error: String(e.message || e).slice(0, 800) }; }
  report.secs = Math.round((Date.now() - t0) / 1000);
  fs.writeFileSync(path.join(ud, 'bench.json'), JSON.stringify(report, null, 1));
  onProgress({ step: 'done' });
  return report;
}

module.exports = { run, cached, bestBackend };
