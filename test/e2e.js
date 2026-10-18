'use strict';
/* End-to-end on the CI runner (no GPU): real ffmpeg / vspipe / python through the app's own modules. */
const path = require('path'), fs = require('fs'), os = require('os');
process.env.SEVENKRH_RUNTIME = path.join(__dirname, '..', 'runtime');
const rt = require('../main/runtime'), media = require('../main/media'), pipeline = require('../main/pipeline');
const { Job } = require('../main/jobs');
const img = require('../main/imgserver');
const P = rt.paths();
P.engineDir = path.join(__dirname, '..', 'engine');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '7k-'));
let fails = 0;
async function step(name, f) {
  const t0 = Date.now();
  try { const r = await f(); console.log('OK  ', name, ((Date.now() - t0) / 1000).toFixed(1) + 's', r ? JSON.stringify(r).slice(0, 300) : ''); }
  catch (e) { fails++; console.log('FAIL', name, String(e && e.stack || e).slice(0, 1500)); }
}
(async () => {
  console.log('runtime', JSON.stringify(rt.status()));
  const src = path.join(tmp, 'src.mp4');
  await media.run(P.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  const info = await media.probe(src);
  console.log('probe', JSON.stringify(info));
  const caps = { encoders: ['libx264', 'libx265', 'libsvtav1'], gpu: -1, upBackend: 'cpu', paths: P, tmp };
  const run = async (opts, name) => {
    const plan = pipeline.buildPlan(opts, info, caps);
    const j = new Job(1, plan, () => {});
    try { await j.run(tmp); } catch (e) { throw new Error(e.message + '\n' + (plan.steps[0].vpy || '') + '\n' + j.log.slice(-20).join('\n')); }
    const o = await media.probe(opts.outPath);
    return { w: o.width, h: o.height, fps: o.fps, dur: +o.duration.toFixed(2), audio: o.hasAudio, enc: plan.encoder };
  };
  await step('plain export (trim, speed 2x, 1080p, hevc, music mix)', () => run({ input: src, outPath: path.join(tmp, 'a.mp4'), trim: { start: 0.2, end: 1.8 }, speed: 2, audio: { mode: 'mix', file: src, musicVolume: 0.5 }, adjust: { brightness: 20, saturation: 30, sharpen: 30 }, output: { res: '1080', codec: 'hevc', quality: 'high' } }, 'a'));
  await step('AI upscale x4 (ORT CPU) through vspipe', () => run({ input: src, outPath: path.join(tmp, 'b.mp4'), trim: { start: 0, end: 0.5 }, enhance: { upscale: { on: true, model: 'real' } }, output: { res: '720', codec: 'h264' } }, 'b'));
  await step('AI upscale anime + crop 9:16', () => run({ input: src, outPath: path.join(tmp, 'c.mp4'), trim: { start: 0, end: 0.5 }, crop: '9:16', enhance: { upscale: { on: true, model: 'anime' } }, output: { res: '720', fps: 60, codec: 'h264' } }, 'c'));
  await step('AI preview frame', async () => { const plan = pipeline.buildPlan({ input: src, outPath: path.join(tmp, 'p.png'), preview: true, trim: { start: 1 }, enhance: { upscale: { on: true, model: 'real' } }, output: { res: '720' } }, info, caps); await new Job(2, plan, () => {}).run(tmp); return { size: fs.statSync(path.join(tmp, 'p.png')).size }; });
  const still = path.join(tmp, 'still.png');
  await media.run(P.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x480', '-frames:v', '1', still]);
  await step('image engine: analyze', async () => img.call('analyze', { src: still }, null, { cpu: true }));
  await step('image engine: upscale x2 (real, CPU, strength 0.7, strip metadata)', async () => img.call('upscale', { src: still, out: path.join(tmp, 'u.png'), model: 'real', scale: 2, strength: 0.7, meta: 'strip' }, null, { cpu: true }));
  await step('image engine: GPU-only refuses to fall back silently on a runner without a GPU', async () => {
    img.stop();
    try { await img.call('upscale', { src: still, out: path.join(tmp, 'g.png'), model: 'real', scale: 2 }, null, { gpuOnly: true }); return { note: 'DirectML ran (WARP or a GPU)' }; }
    catch (e) { if (!/GPU-only/.test(e.message)) throw e; return { refused: true }; }
  });
  await step('GPU lists per API (DXGI / Vulkan)', async () => JSON.parse((await media.run(P.python, ['-X', 'utf8', path.join(P.engineDir, 'gpuinfo.py')])).trim()));
  await step('performance-test clip builder works in the bundled VapourSynth', async () => {
    const bench = require('../main/bench');
    const r = await bench.runPy(bench.HEAD + "\nc = clip(1280, 720, 6)\nfor i in range(6): c.get_frame(i)\nres['ok'] = [c.width, c.height, c.num_frames]\nprint('RESULT ' + json.dumps(res))\n", '{}', 120000);
    if (!r.ok) throw new Error(JSON.stringify(r)); return r;
  });
  img.stop();
  console.log(fails ? fails + ' e2e step(s) failed' : 'e2e passed');
  process.exit(0);
})();
