'use strict';
const assert = require('assert');
const P = require('../main/pipeline');
let n = 0; const t = (name, f) => { f(); n++; console.log('ok', name); };
const caps = { encoders: ['h264_nvenc', 'hevc_nvenc', 'av1_nvenc', 'libx264'], gpu: 0, upBackend: 'ort', tmp: 'C:\\T',
  paths: { ffmpeg: 'ffmpeg.exe', vspipe: 'vspipe.exe', plugins: { lsmas: 'L.dll', rife: 'R.dll', vsort: 'O.dll', vsncnn: 'N.dll' }, models: { real_x2: 'r2.onnx', real_x4: 'r4.onnx', anime_x2: 'a2.onnx', anime_x4: 'a4.onnx' } } };
const info = { width: 1920, height: 1080, rotation: 0, fps: '30000/1001', duration: 10, hasAudio: true };

t('targetSize landscape/portrait/cap', () => {
  assert.deepStrictEqual(P.targetSize(1920, 1080, '2160'), [3840, 2160]);
  assert.deepStrictEqual(P.targetSize(1080, 1920, '2160'), [2160, 3840]);
  assert.deepStrictEqual(P.targetSize(1280, 720, 'source'), [1280, 720]);
  assert.deepStrictEqual(P.targetSize(7680, 4320, 'source'), [3840, 2160]);
});
t('upscaleFactor', () => {
  assert.strictEqual(P.upscaleFactor(1920, 1080, 3840, 2160), 2);
  assert.strictEqual(P.upscaleFactor(1280, 720, 3840, 2160), 4);
  assert.strictEqual(P.upscaleFactor(1920, 1080, 1920, 1080), 0);
});
t('krypton factor (same rule as the site)', () => {
  assert.strictEqual(P.kryptonFactor(60), 2);
  assert.strictEqual(P.kryptonFactor(120), 6);
  assert.strictEqual(P.kryptonFactor(90), 3);
  assert.strictEqual(P.kryptonFactor(30), 2);
});
t('plain export: ffmpeg only, nvenc hevc, no krypton for self', () => {
  const pl = P.buildPlan({ input: 'in.mp4', outPath: 'out.mp4', output: { res: 'source', fps: 'source', codec: 'hevc', quality: 'high' }, platform: 'self' }, info, caps);
  assert.strictEqual(pl.steps.length, 2); assert.strictEqual(pl.steps[0].kind, 'ffmpeg'); assert.strictEqual(pl.steps[1].kind, 'verify');
  const a = pl.steps[0].ffmpeg.join(' ');
  assert(a.includes('hevc_nvenc') && a.includes('-tag:v hvc1') && a.endsWith('out.mp4'), a);
  assert.strictEqual(pl.expect.w, 1920); assert.ok(Math.abs(pl.expect.fps - 29.97) < 0.01);
});
t('4K120 enhance: AI upscale (720p working size) then RIFE x4 at 4K, vspipe pipe, tiktok krypton x6', () => {
  const pl = P.buildPlan({ input: 'in.mp4', outPath: 'out.mp4', enhance: { upscale: { on: true, model: 'real' }, framegen: { on: true, model: '4.26' } },
    output: { res: '2160', fps: 120, codec: 'hevc', quality: 'max', tenBit: true }, platform: 'tiktok' }, info, caps);
  assert.strictEqual(pl.steps[0].kind, 'pipe');
  assert(pl.steps[0].vpy.includes('core.rife.RIFE') && pl.steps[0].vpy.includes('r"r4.onnx"'), pl.steps[0].vpy);
  assert(pl.steps[0].vpy.indexOf('core.rife.RIFE') > pl.steps[0].vpy.indexOf('vsmlrt.inference'), 'upscale before RIFE');
  assert(pl.steps[0].vpy.includes('Spline36(rgb, 1280, 720)'), 'working size 720p');
  assert.deepStrictEqual([pl.up.inW, pl.up.inH], [1280, 720]);
  assert.deepStrictEqual([pl.fg.num, pl.fg.den], [4, 1]);
  assert.ok(Math.abs(pl.expect.fps - 119.88) < 0.01, 'reaches 119.88fps'); assert(!pl.steps[0].ffmpeg.join(' ').includes('fps='), 'no frame duplication');
  assert.strictEqual(pl.expect.kfactor, 6);
  assert.strictEqual(pl.steps[1].ffmpeg.join(' ').includes('-itsscale 6'), true);
  assert.strictEqual(pl.expect.w, 3840);
});
t('speed 2x + music mix + trim', () => {
  const pl = P.buildPlan({ input: 'in.mp4', outPath: 'o.mp4', trim: { start: 2, end: 8 }, speed: 2, audio: { mode: 'mix', file: 'm.mp3', volume: 1, musicVolume: 0.5 }, output: { codec: 'h264' } }, info, caps);
  const a = pl.steps[0].ffmpeg.join(' ');
  assert(a.includes('setpts=PTS/2') && a.includes('atempo=2') && a.includes('amix') && a.includes('-t 3.000'), a);
});
t('portrait rotated phone video to 1080 + crop 9:16 no-op', () => {
  const pl = P.buildPlan({ input: 'in.mov', outPath: 'o.mp4', crop: '9:16', output: { res: '1080' } }, { ...info, rotation: 90, width: 3840, height: 2160 }, caps);
  assert.strictEqual(pl.expect.w, 1080); assert.strictEqual(pl.expect.h, 1920);
});
t('no NVIDIA -> software fallback', () => {
  const e = P.pickEncoder('hevc', { encoders: [] }, true); assert.strictEqual(e.name, 'libx265');
});
t('AI preview frame: vspipe first frame -> png', () => {
  const pl = P.buildPlan({ input: 'in.mp4', outPath: 'p.png', preview: true, trim: { start: 5 }, enhance: { upscale: { on: true, model: 'anime' } }, output: { res: '2160' } }, info, caps);
  assert.strictEqual(pl.steps.length, 1); assert(pl.preview);
  const a = pl.steps[0].ffmpeg.join(' '); assert(a.endsWith('-frames:v 1 p.png') && !a.includes('aac'), a);
  assert(pl.steps[0].vpy.includes('a4.onnx'), 'anime x4 network');
});
t('AI working size: portrait 1440x2560 -> 4K', () => {
  assert.deepStrictEqual(P.aiInputSize(1440, 2560, 2160, 3840, 'balanced'), [720, 1280]);
  assert.deepStrictEqual(P.aiInputSize(1440, 2560, 2160, 3840, 'max'), [1080, 1920]);
  assert.deepStrictEqual(P.aiInputSize(1440, 2560, 2160, 3840, 'fast'), [540, 960]);
  assert.deepStrictEqual(P.aiInputSize(480, 854, 2160, 3840, 'balanced'), [480, 854]);
});
t('frame generation only: RIFE at source size before resize', () => {
  const pl = P.buildPlan({ input: 'in.mp4', outPath: 'o.mp4', enhance: { framegen: { on: true } }, output: { res: '2160', fps: 60 } }, { ...info, fps: '30/1' }, caps);
  const v = pl.steps[0].vpy; assert(v.indexOf('core.rife.RIFE') < v.indexOf('Spline36(rgb, 3840, 2160)'), v);
});
t('TensorRT backend script', () => {
  const pl = P.buildPlan({ input: 'in.mp4', outPath: 'o.mp4', enhance: { upscale: { on: true } }, output: { res: '2160' } }, info, { ...caps, upBackend: 'trt', engines: 'E:\\eng' });
  assert(pl.steps[0].vpy.includes('Backend.TRT_RTX(fp16=True') && pl.steps[0].vpy.includes('engine_folder=r"E:\\eng"'), pl.steps[0].vpy);
});
t('copy mode = site tool: instagram plain copy + faststart, verified', () => {
  const pl = P.buildPlan({ input: 'in.mp4', outPath: 'o.mp4', output: { mode: 'copy' }, platform: 'instagram' }, { ...info, vcodec: 'h264' }, caps);
  const a = pl.steps[0].ffmpeg.join(' ');
  assert(a.includes('-i in.mp4 -c:v copy -c:a copy -movflags +faststart o.mp4'), a);
  assert.strictEqual(pl.steps[1].kind, 'verify'); assert.strictEqual(pl.encoder, 'copy');
});
t('copy mode tiktok krypton: exact Krypton command (itsscale, copy, no faststart)', () => {
  const pl = P.buildPlan({ input: 'in.mp4', outPath: 'o.mp4', output: { mode: 'copy' }, platform: 'tiktok' }, { ...info, fps: '60/1' }, caps);
  assert.strictEqual(pl.steps[0].ffmpeg.join(' '), 'ffmpeg.exe -hide_banner -nostdin -y -loglevel error -itsscale 2 -i in.mp4 -c:v copy -c:a copy o.mp4');
  assert.strictEqual(pl.expect.finalDur, 20);
});
t('copy mode tiktok PATCH + "to 30" rule on 120 fps', () => {
  const pl = P.buildPlan({ input: 'in.mp4', outPath: 'o.mp4', output: { mode: 'copy' }, platform: 'tiktok', tiktokTech: 'patch', kryptonMode: 'to30' }, { ...info, fps: '120/1' }, caps);
  assert.deepStrictEqual([pl.steps[0].kind, pl.steps[0].k], ['patch', 4]);
});
t('copy mode tiktok on 30 fps with "to 30" → lowFps like the site', () => {
  assert.throws(() => P.buildPlan({ input: 'in.mp4', outPath: 'o.mp4', output: { mode: 'copy' }, platform: 'tiktok', kryptonMode: 'to30' }, { ...info, fps: '30/1' }, caps), /lowFps/);
});
t('canCopy only when nothing changes picture or sound', () => {
  const vi = { ...info, vcodec: 'h264' };
  assert.strictEqual(P.canCopy({ input: 'a.mp4', output: { res: 'source', fps: 'source' }, enhance: { upscale: { on: false } } }, vi), true);
  assert.strictEqual(P.canCopy({ input: 'a.mp4', trim: { start: 2, end: 10 } }, vi), false);
  assert.strictEqual(P.canCopy({ input: 'a.mp4', adjust: { brightness: 5 } }, vi), false);
  assert.strictEqual(P.canCopy({ input: 'a.mkv' }, vi), false);
});
t('HDR source: kept as HDR in 10-bit HEVC, tone-mapped for H.264', () => {
  const hi = { ...info, colorTransfer: 'smpte2084', colorSpace: 'bt2020nc' };
  const keep = P.buildPlan({ input: 'in.mp4', outPath: 'o.mp4', output: { codec: 'hevc', tenBit: true } }, hi, caps).steps[0].ffmpeg.join(' ');
  assert(keep.includes('-color_trc smpte2084') && keep.includes('-colorspace bt2020nc') && !keep.includes('tonemap'), keep);
  const tm = P.buildPlan({ input: 'in.mp4', outPath: 'o.mp4', output: { codec: 'h264' } }, hi, caps).steps[0].ffmpeg.join(' ');
  assert(tm.includes('tonemap=tonemap=hable') && tm.includes('-color_trc bt709'), tm);
  const ai = P.buildPlan({ input: 'in.mp4', outPath: 'o.mp4', enhance: { upscale: { on: true } }, output: { codec: 'h264', res: '2160' } }, hi, caps);
  assert(ai.steps[0].vpy.includes('vs.YUV420P10') && ai.steps[0].vpy.includes('matrix_s="2020ncl"') && ai.steps[0].ffmpeg.join(' ').includes('tonemap'), 'AI path tone-maps after VapourSynth');
});
t('SD BT.601 source is converted to BT.709, not just re-tagged', () => {
  const a = P.buildPlan({ input: 'in.mp4', outPath: 'o.mp4', output: { codec: 'h264' } }, { ...info, width: 720, height: 480, colorSpace: 'smpte170m' }, caps).steps[0].ffmpeg.join(' ');
  assert(a.includes('in_color_matrix=bt601:out_color_matrix=bt709'), a);
});
t('encode + tiktok PATCH technique', () => {
  const pl = P.buildPlan({ input: 'in.mp4', outPath: 'o.mp4', output: { fps: 60, codec: 'h264' }, platform: 'tiktok', tiktokTech: 'patch' }, { ...info, fps: '60/1' }, caps);
  assert.deepStrictEqual(pl.steps.map(s => s.kind), ['ffmpeg', 'patch', 'verify']);
});
console.log(n, 'tests passed');
