'use strict';
/* End-to-end with the system ffmpeg (Linux/macOS dev machines and CI without the Windows runtime):
   real encodes, the site's platform techniques, PATCH byte-integrity, verification of every output. */
const path = require('path'), fs = require('fs'), os = require('os'), assert = require('assert');
const which = n => require('child_process').execSync(process.platform === 'win32' ? `where ${n}` : `command -v ${n}`).toString().trim().split(/\r?\n/)[0];
const bundled = path.join(__dirname, '..', 'runtime');
if (fs.existsSync(path.join(bundled, 'ffmpeg', 'ffmpeg.exe'))) process.env.SEVENKRH_RUNTIME = bundled; // Windows CI: the app's own ffmpeg
else {
  const rtDir = fs.mkdtempSync(path.join(os.tmpdir(), '7k-rt-'));
  fs.writeFileSync(path.join(rtDir, 'manifest.json'), JSON.stringify({ ffmpeg: which('ffmpeg'), ffprobe: which('ffprobe'), models: {} }));
  process.env.SEVENKRH_RUNTIME = rtDir;
}
const media = require('../main/media'), pipeline = require('../main/pipeline'), mp4patch = require('../main/mp4patch');
const { Job } = require('../main/jobs');
const P = require('../main/runtime').paths();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '7k-e2e-'));
let fails = 0, n = 0;
async function step(name, f) {
  const t0 = Date.now(); n++;
  try { const r = await f(); console.log('OK  ', name, ((Date.now() - t0) / 1000).toFixed(1) + 's', r ? JSON.stringify(r).slice(0, 240) : ''); }
  catch (e) { fails++; console.log('FAIL', name, String(e && e.stack || e).slice(0, 1200)); }
}
const caps = { encoders: ['libx264', 'libx265'], gpu: -1, upBackend: 'cpu', paths: P, tmp };
async function make(name, args) { const f = path.join(tmp, name); await media.run(P.ffmpeg, ['-v', 'error', '-y', ...args, f]); return f; }
async function exportWith(opts, info) {
  const plan = pipeline.buildPlan(opts, info, { ...caps, tmp: fs.mkdtempSync(path.join(tmp, 'j')) });
  const j = new Job(1, plan, () => {});
  await j.run(caps.tmp);
  return { plan, v: j.verified };
}
(async () => {
  const src60 = await make('src60.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=60', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
  const i60 = await media.probe(src60);
  await step('copy mode, instagram: lossless copy, verified', async () => {
    const { v } = await exportWith({ input: src60, outPath: path.join(tmp, 'ig.mp4'), output: { mode: 'copy' }, platform: 'instagram' }, i60);
    assert(v.ok && Math.abs(v.dur - 3) < 0.1); return v;
  });
  await step('copy mode, tiktok Krypton x2 (auto): duration doubled, fps halved', async () => {
    const { v } = await exportWith({ input: src60, outPath: path.join(tmp, 'tk.mp4'), output: { mode: 'copy' }, platform: 'tiktok' }, i60);
    assert(v.ok && Math.abs(v.dur - 6) < 0.15, JSON.stringify(v)); return v;
  });
  await step('copy mode, tiktok PATCH x2: samples byte-identical, only timescales change', async () => {
    const out = path.join(tmp, 'tp.mp4');
    const { v } = await exportWith({ input: src60, outPath: out, output: { mode: 'copy' }, platform: 'tiktok', tiktokTech: 'patch' }, i60);
    const a = fs.readFileSync(src60), b = fs.readFileSync(out);
    assert.strictEqual(a.length, b.length);
    let diff = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    const hp = mp4patch.probe(out);
    assert(v.ok && diff > 0 && diff < 40 && Math.abs(hp.fps - 30) < 0.5, `diff=${diff} ${JSON.stringify(hp)}`);
    return { ...v, bytesChanged: diff, headerFps: hp.fps };
  });
  await step('encode: trim + speed + 1080p + h264 + tiktok krypton, verified', async () => {
    const { v, plan } = await exportWith({ input: src60, outPath: path.join(tmp, 'enc.mp4'), trim: { start: 0.5, end: 2.5 }, speed: 2, output: { res: '1080', fps: 60, codec: 'h264', quality: 'balanced' }, platform: 'tiktok' }, i60);
    assert(v.ok && v.w === 1920 && v.h === 1080 && Math.abs(v.dur - 2) < 0.15, JSON.stringify(v)); return { ...v, k: plan.expect.kfactor };
  });
  const sd = await make('sd.mp4', ['-f', 'lavfi', '-i', 'smptebars=size=720x480:rate=30000/1001', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m']);
  await step('SD BT.601 → BT.709: colour of the bars stays the same', async () => {
    const isd = await media.probe(sd);
    const out = path.join(tmp, 'sd709.mp4');
    const { v } = await exportWith({ input: sd, outPath: out, output: { codec: 'h264', quality: 'max' } }, isd);
    // decode both with their own matrix to RGB and compare the yellow bar
    const px = async (f, m) => (await media.run(P.ffmpeg, ['-v', 'error', '-i', f, '-frames:v', '1', '-vf', `scale=in_color_matrix=${m}:out_color_matrix=bt709,crop=8:8:150:100,format=rgb24`, '-f', 'rawvideo', '-'], { binary: true }));
    const a = await px(sd, 'bt601'), b = await px(out, 'bt709');
    const d = Math.max(...[0, 1, 2].map(c => Math.abs(a[c] - b[c])));
    assert(v.ok && d <= 4, 'max channel diff ' + d); return { maxDiff: d };
  });
  const hdr = await make('hdr.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '1', '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-x265-params', 'log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc']);
  await step('HDR10 source → H.264 SDR: tone-mapped and tagged bt709', async () => {
    const ih = await media.probe(hdr); assert(ih.hdr, 'fixture is HDR');
    const { v } = await exportWith({ input: hdr, outPath: path.join(tmp, 'hdr-sdr.mp4'), output: { codec: 'h264' } }, ih);
    const o = JSON.parse(await media.run(P.ffprobe, ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=color_transfer,pix_fmt', '-of', 'json', path.join(tmp, 'hdr-sdr.mp4')])).streams[0];
    assert(v.ok && o.color_transfer === 'bt709' && o.pix_fmt === 'yuv420p', JSON.stringify(o)); return o;
  });
  await step('HDR10 source → 10-bit HEVC: HDR kept', async () => {
    const ih = await media.probe(hdr);
    const out = path.join(tmp, 'hdr-keep.mp4');
    const { v } = await exportWith({ input: hdr, outPath: out, output: { codec: 'hevc', tenBit: true } }, ih);
    const o = JSON.parse(await media.run(P.ffprobe, ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=color_transfer,color_primaries,pix_fmt', '-of', 'json', out])).streams[0];
    assert(v.ok && o.color_transfer === 'smpte2084' && o.pix_fmt === 'yuv420p10le', JSON.stringify(o)); return o;
  });
  await step('verify catches a broken promise (wrong expected size)', async () => {
    const { verifyOutput } = require('../main/jobs');
    const r = await verifyOutput(src60, { w: 1920, h: 1080, dur: 3, audio: true });
    assert(!r.ok && /size/.test(r.problems[0])); return r.problems;
  });
  console.log(fails ? `${fails}/${n} e2e step(s) failed` : `e2e passed (${n})`);
  process.exit(fails ? 1 : 0);
})();
