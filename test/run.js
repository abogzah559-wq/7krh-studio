'use strict';
const assert = require('assert');
const P = require('../main/pipeline');
const PL = require('../main/platform');
const R = require('../main/render');
const TL = require('../ui/core/tl-core.js');
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
t('TikTok factor (same rules as the website tool)', () => {
  assert.strictEqual(PL.factor(60), 2); assert.strictEqual(PL.factor(120), 6); assert.strictEqual(PL.factor(90), 3); assert.strictEqual(PL.factor(30), 2);
  assert.strictEqual(PL.factor(240), 8);
  assert.strictEqual(PL.factor(60, 'to30'), 2); assert.strictEqual(PL.factor(120, 'to30'), 4); assert.strictEqual(PL.factor(30, 'to30'), 1);
  assert.strictEqual(PL.factor(60, '6'), 6); assert.strictEqual(PL.factor(120, 'auto', 'youtube'), 1);
});
t('copy plans: krypton remux / patch / plain copy', () => {
  const info = { fpsNum: 60, duration: 10, w: 1080, h: 1920, hasAudio: true };
  const k = PL.copyPlan('in.mp4', 'o.mp4', info, { platform: 'tiktok', fx: 'auto', tech: 'krypton' }, 'ffmpeg');
  assert(k.steps[0].ffmpeg.join(' ').includes('-itsscale 2 -i in.mp4 -c:v copy -c:a copy o.mp4')); assert.strictEqual(k.steps[1].kind, 'verify'); assert.strictEqual(k.steps[1].expectDur, 20);
  const pa = PL.copyPlan('in.mov', 'o.mov', info, { platform: 'tiktok', fx: '4', tech: 'patch' }, 'ffmpeg');
  assert.strictEqual(pa.steps[0].kind, 'patch'); assert.strictEqual(pa.steps[0].k, 4);
  assert.throws(() => PL.copyPlan('in.mkv', 'o.mkv', info, { platform: 'tiktok', tech: 'patch' }, 'ffmpeg'), /notMp4/);
  const yt = PL.copyPlan('in.mp4', 'o.mp4', info, { platform: 'youtube' }, 'ffmpeg');
  assert(yt.steps[0].ffmpeg.join(' ').includes('-c:v copy -c:a copy -movflags +faststart o.mp4')); assert.strictEqual(yt.steps[1].expectDur, 10);
  const pe = PL.postEncode('enc.mp4', 'o.mp4', 120, 5, { platform: 'tiktok', fx: 'auto' });
  assert.strictEqual(pe.steps[0].kind, 'patch'); assert.strictEqual(pe.k, 6); assert.strictEqual(pe.finalDur, 30);
});
t('plain export: ffmpeg only, nvenc hevc, no krypton for self', () => {
  const pl = P.buildPlan({ input: 'in.mp4', outPath: 'out.mp4', output: { res: 'source', fps: 'source', codec: 'hevc', quality: 'high' }, platform: 'self' }, info, caps);
  assert.strictEqual(pl.steps.length, 1); assert.strictEqual(pl.steps[0].kind, 'ffmpeg');
  const a = pl.steps[0].ffmpeg.join(' ');
  assert(a.includes('hevc_nvenc') && a.includes('-tag:v hvc1') && a.endsWith('out.mp4'), a);
  assert.strictEqual(pl.expect.w, 1920); assert.ok(Math.abs(pl.expect.fps - 29.97) < 0.01);
});
t('4K120 enhance: AI upscale (720p working size) then RIFE x4 at 4K, vspipe pipe', () => {
  const pl = P.buildPlan({ input: 'in.mp4', outPath: 'out.mp4', enhance: { upscale: { on: true, model: 'real' }, framegen: { on: true, model: '4.26' } },
    output: { res: '2160', fps: 120, codec: 'hevc', quality: 'max', tenBit: true }, platform: 'tiktok' }, info, caps);
  assert.strictEqual(pl.steps[0].kind, 'pipe');
  assert(pl.steps[0].vpy.includes('core.rife.RIFE') && pl.steps[0].vpy.includes('r"r4.onnx"'), pl.steps[0].vpy);
  assert(pl.steps[0].vpy.indexOf('core.rife.RIFE') > pl.steps[0].vpy.indexOf('vsmlrt.inference'), 'upscale before RIFE');
  assert(pl.steps[0].vpy.includes('Spline36(rgb, 1280, 720)'), 'working size 720p');
  assert.deepStrictEqual([pl.up.inW, pl.up.inH], [1280, 720]);
  assert.deepStrictEqual([pl.fg.num, pl.fg.den], [4, 1]);
  assert.ok(Math.abs(pl.expect.fps - 119.88) < 0.01, 'reaches 119.88fps'); assert(!pl.steps[0].ffmpeg.join(' ').includes('fps='), 'no frame duplication');
  assert.strictEqual(pl.steps.length, 1, 'platform delivery is planned separately');
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
t('timeline: export expressions equal the preview maths at every time', () => {
  const c = TL.normClip({ kind: 'image', in: 0, out: 3, start: 1, tf: { x: 0.1, y: -0.2, s: 1.2, r: 10, o: 0.9 },
    kf: { x: [{ t: 0, v: -0.4 }, { t: 1.5, v: 0.2 }, { t: 3, v: 0 }], s: [{ t: 0.5, v: 0.5 }, { t: 2, v: 1.5 }], o: [{ t: 0, v: 0 }, { t: 1, v: 1 }] },
    tin: { type: 'slideleft', dur: 0.6 }, tout: { type: 'zoom', dur: 0.8 } });
  const e = R.stateExpr(c, { v: 'u' });
  for (let u = 0; u <= 3; u += 0.037) {
    const a = TL.stateAt(c, u);
    for (const k of ['x', 'y', 's', 'r', 'o']) assert(Math.abs(R.evalE(e[k], { u }) - a[k]) < 1e-9, `${k} at ${u}: ${R.evalE(e[k], { u })} vs ${a[k]}`);
  }
  assert(/if\(lt\(u,/.test(R.toFF(e.x)), R.toFF(e.x));
});
t('timeline: split keeps the source times and keyframes', () => {
  const p = TL.newProject(); p.media.v = { w: 1920, h: 1080, hasAudio: true, duration: 20 };
  p.clips.push(TL.normClip({ id: 'a', kind: 'video', src: 'v', track: 'V1', in: 2, out: 12, start: 5, speed: 2, kf: { x: [{ t: 0, v: 0 }, { t: 4, v: 1 }] } }));
  const b = TL.split(p, 'a', 7);
  const a = p.clips[0];
  assert.deepStrictEqual([a.in, a.out, a.start, TL.len(a)], [2, 6, 5, 2]);
  assert.deepStrictEqual([b.in, b.out, b.start, TL.len(b)], [6, 12, 7, 3]);
  assert.deepStrictEqual(b.kf.x, [{ t: 2, v: 1 }]);
  assert.strictEqual(TL.split(p, 'a', 5.01), null, 'no zero-length pieces');
});
t('timeline: reverse + speed source mapping', () => {
  const c = TL.normClip({ kind: 'video', in: 1, out: 5, start: 10, speed: 2, reverse: true });
  assert.strictEqual(TL.srcTime(c, 10), 5); assert.strictEqual(TL.srcTime(c, 11), 3); assert.strictEqual(TL.len(c), 2);
});
t('subtitles: SRT + ASS import, SRT export round trip', () => {
  const s = TL.parseSRT('1\r\n00:00:01,000 --> 00:00:02,500\r\nمرحبا <i>بك</i>\r\n\r\n2\n00:01:00,250 --> 00:01:01,000\nline1\nline2\n');
  assert.deepStrictEqual(s, [{ start: 1, end: 2.5, text: 'مرحبا بك' }, { start: 60.25, end: 61, text: 'line1\nline2' }]);
  const a = TL.parseASS('[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:03.50,0:00:05.00,Default,,0,0,0,,{\\b1}Hi, there\\Nnext');
  assert.deepStrictEqual(a, [{ start: 3.5, end: 5, text: 'Hi, there\nnext' }]);
  assert.deepStrictEqual(TL.parseSRT(TL.toSRT(s)), s);
});
t('timeline: colour filter graph is the preview maths', () => {
  assert.deepStrictEqual(R.colorChain({}), []);
  const f = R.colorChain({ b: 20, s: -50, sh: 50 }).join(',');
  assert(f.includes("lut=c0='255*pow(clip((clip(val/255*1.2,0,1)-0.5)*1+0.5,0,1),1)'") && f.includes('colorchannelmixer=rr=0.6065') && f.includes("convolution=0m='0 -0.3 0 -0.3 2.2 -0.3 0 -0.3 0'"), f);
  assert.strictEqual(TL.transfer(0.5, TL.colorParams({ c: 100 })), 0.5);
});
t('bitrate mode replaces constant quality', () => {
  const a = R.withBitrate(P.encoderArgs({ name: 'h264_nvenc' }, 'high', 30, 1920, 1080), 'h264_nvenc', 12).join(' ');
  assert(!a.includes('-cq') && a.includes('-b:v 12M -maxrate 18M -bufsize 24M'), a);
  const x = R.withBitrate(P.encoderArgs({ name: 'libx264' }, 'high', 30, 1920, 1080), 'libx264', 8).join(' ');
  assert(!x.includes('-crf') && x.includes('-b:v 8M'), x);
});
console.log(n, 'tests passed');
