'use strict';
/* Timeline renderer end-to-end with a real ffmpeg (any OS). Renders a small project that uses every
   layer path (static, animated position, perspective scale+rotate, animated opacity, dissolve, fade, text,
   ducked music, speed) and then reads pixels back from the file to check that things are where the shared
   timeline maths (TL.stateAt) says they are — the same maths the editor preview draws with.
   FFMPEG / FFPROBE env vars or the Windows runtime are used. */
const path = require('path'), fs = require('fs'), os = require('os');
const { execFileSync } = require('child_process');
const rt = require('../main/runtime');
const WIN = process.platform === 'win32';
if (process.env.FFMPEG || !WIN) rt.override({ ffmpeg: process.env.FFMPEG || 'ffmpeg', ffprobe: process.env.FFPROBE || 'ffprobe' });
const P = rt.paths();
const media = require('../main/media'), render = require('../main/render'), platform = require('../main/platform');
const TL = require('../ui/core/tl-core.js');
const { Job } = require('../main/jobs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '7k-tl-'));
// -nostdin + no inherited stdin: on the CI runner an inherited pipe can make ffmpeg wait forever
const X = (cmd, args, o = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 1 << 28, ...o });
const ff = (...a) => X(P.ffmpeg, ['-nostdin', '-v', 'error', '-y', ...a]);
let fails = 0;
// every line also goes straight to a file, so a CI timeout still leaves the trace behind
const TRACE = process.env.TRACE_FILE;
const log = s => { console.log(s); if (TRACE) try { fs.appendFileSync(TRACE, s + '\n'); } catch (e) {} };
const check = (name, ok, extra = '') => { log((ok ? 'OK  ' : 'FAIL') + ' ' + name + (extra ? '  ' + extra : '')); if (!ok) fails++; };
function pixel(file, t, x, y, W, H) {
  const b = X(P.ffmpeg, ['-nostdin', '-v', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  const i = (Math.round(y) * W + Math.round(x)) * 3; return [b[i], b[i + 1], b[i + 2]];
}
const near = (a, b, tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

(async () => {
  const v1 = path.join(tmp, 'clip ä ع.mp4'); // spaces + non-ASCII on purpose
  ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', v1);
  const red = path.join(tmp, 'red.png'); ff('-f', 'lavfi', '-i', 'color=c=red:s=200x100', '-frames:v', '1', red);
  const blue = path.join(tmp, 'text.png'); ff('-f', 'lavfi', '-i', 'color=c=blue:s=120x40', '-frames:v', '1', blue);
  const green = path.join(tmp, 'green.png'); ff('-f', 'lavfi', '-i', 'color=c=0x00ff00:s=160x90', '-frames:v', '1', green);
  const tone = path.join(tmp, 'music.wav'); ff('-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100', '-t', '5', tone);

  const p = TL.newProject('landscape', 'e2e');
  p.canvas = { w: 640, h: 360, fps: 30, bg: '#000000' };
  for (const f of [v1, red, blue, green, tone]) { const m = await media.probe(f); p.media[f] = { w: m.width, h: m.height, rotation: m.rotation, fps: m.fps, duration: m.duration, hasAudio: m.hasAudio, kind: m.kind, colorSpace: m.colorSpace }; }
  const C = o => TL.normClip({ id: TL.uid(), ...o });
  p.clips.push(
    C({ id: 'vid', kind: 'video', track: 'V1', src: v1, in: 0.5, out: 3.5, start: 0, adj: { s: 50 } }),
    C({ id: 'img', kind: 'image', track: 'V1', src: green, in: 0, out: 1.5, start: 3, fit: 'contain', tin: { type: 'dissolve', dur: 0.5 } }),
    C({ id: 'mov', kind: 'image', track: 'V2', src: red, in: 0, out: 3, start: 0, fit: 'none', tf: { x: -0.3, y: -0.3 }, kf: { x: [{ t: 0, v: -0.3 }, { t: 2, v: 0.3 }] } }),
    C({ id: 'spin', kind: 'image', track: 'V2', src: red, in: 0, out: 1, start: 3.5, fit: 'none', kf: { s: [{ t: 0, v: 0.5 }, { t: 1, v: 1 }], r: [{ t: 0, v: 0 }, { t: 1, v: 90 }] } }),
    C({ id: 'txt', kind: 'text', track: 'T1', in: 0, out: 2, start: 1, text: { s: 'مرحبا', png: blue, pw: 120, ph: 40 }, kf: { o: [{ t: 0, v: 0 }, { t: 1, v: 1 }] } }),
    C({ id: 'mus', kind: 'audio', track: 'A1', src: tone, in: 0, out: 4, start: 0.5, volume: 0.8, fadeIn: 0.5, fadeOut: 0.5 }),
  );
  p.tracks.find(t => t.id === 'A1').duck = true;
  const total = TL.duration(p);
  const W = 640, H = 360;
  const major = +String(X(P.ffmpeg, ['-version'])).match(/version (?:n)?(\d+)/)?.[1] || 7;
  const caps = { encoders: ['libx264', 'libx265', 'libsvtav1', 'libvpx-vp9'], ffmpegMajor: major, paths: P, tmp };
  const out = path.join(tmp, 'out ع.mp4');
  const plan = render.buildTimelinePlan(p, { outPath: out, output: { codec: 'h264', quality: 'high' } }, caps);
  plan.steps.push({ kind: 'verify', file: out, expectDur: total, w: W, h: H, audio: true, tol: 0.03 });
  const t0 = Date.now();
  const job = new Job(1, plan, () => {}, path.join(tmp, 'log.txt'), { platform, verify: media.verifyOutput });
  try { const r = await job.run(tmp); check('render + verify', r.verify && r.verify.ok, JSON.stringify(r.verify) + ` ${((Date.now() - t0) / 1000).toFixed(1)}s`); }
  catch (e) { check('render', false, String(e.message).slice(0, 1500)); console.log(fs.readFileSync(path.join(tmp, 'graph.txt'), 'utf8')); process.exit(1); }

  // pixels: where the shared maths says the layers are
  const posAt = (id, t) => { const c = p.clips.find(x => x.id === id); return TL.rect(p, c, TL.stateAt(c, t - c.start)); };
  let r = posAt('mov', 0.0); check('animated red box at t=0', near(pixel(out, 0.0, r.cx, r.cy, W, H), [255, 0, 0]), `${r.cx},${r.cy} ${pixel(out, 0, r.cx, r.cy, W, H)}`);
  r = posAt('mov', 1.0); check('animated red box at t=1 (centre)', near(pixel(out, 1.0, r.cx, r.cy, W, H), [255, 0, 0]), `${r.cx},${r.cy}`);
  r = posAt('mov', 1.8); check('animated red box at t=1.8', near(pixel(out, 1.8, r.cx + r.w / 2 - 6, r.cy, W, H), [255, 0, 0]), `${r.cx},${r.cy}`);
  check('red box gone after its clip (t=3.2, left side)', !near(pixel(out, 3.2, 128, 72, W, H), [255, 0, 0]));
  // x=300 lies on the yellow bar of the test pattern: yellow = no text, grey = half blue over yellow, blue = full
  check('text invisible at its start (opacity keyframe 0)', near(pixel(out, 1.0, 300, 180, W, H), [255, 255, 0], 50), String(pixel(out, 1.0, 300, 180, W, H)));
  check('text fully visible at t=2.5', near(pixel(out, 2.5, 320, 180, W, H), [0, 0, 255]), String(pixel(out, 2.5, 320, 180, W, H)));
  const half = pixel(out, 1.5, 300, 180, W, H);
  check('text half transparent at t=1.5 (blend of blue over yellow)', near(half, [128, 128, 128], 30), String(half));
  check('green image dissolving in at t=3.25', (() => { const c = pixel(out, 3.25, 20, 180, W, H); return c[1] > 40 && c[1] < 245; })(), String(pixel(out, 3.25, 20, 180, W, H)));
  check('green image full at t=4.2', near(pixel(out, 4.2, 20, 180, W, H), [0, 255, 0]));
  // perspective path: at u=1 the box is scale 1, rotated 90° → 100 wide, 200 tall around the centre
  const sp = pixel(out, 4.45, 320, 180 - 80, W, H), sp2 = pixel(out, 4.45, 320 - 80, 180, W, H);
  check('scaled + rotated box (perspective) covers the vertical extent', near(sp, [255, 0, 0], 60), String(sp));
  check('…and not the horizontal one', !near(sp2, [255, 0, 0], 60), String(sp2));
  // audio: loud where the video sound + music play
    check('audio stream present', /audio/i.test(JSON.stringify(await media.probe(out))));

  // TikTok header patch on the rendered file (site rule: 30 fps "auto" → ×2)
  const k = platform.factor(30, 'auto');
  const tik = path.join(tmp, 'tiktok.mp4');
  const pr = platform.patchTS(out, tik, k);
  const pm = platform.probeMp4(tik);
  check('TikTok PATCH ×2 doubles the duration and halves the fps', Math.abs(pr.dur - total * 2) < 0.1 && Math.abs(pm.fps - 15) < 0.2, JSON.stringify(pm));
  const kr = platform.copyPlan(out, path.join(tmp, 'kr.mp4'), { fpsNum: 30, duration: total, w: W, h: H, hasAudio: true }, { platform: 'tiktok', fx: 'auto', tech: 'krypton' }, P.ffmpeg);
  try { const j = new Job(2, { steps: kr.steps, expect: { frames: 1 } }, () => {}, null, { platform, verify: media.verifyOutput }); const v = await j.run(tmp); check('TikTok Krypton remux ×2 verified', v.verify.ok, JSON.stringify(v.verify)); }
  catch (e) { check('TikTok Krypton remux', false, e.message); }
  try { platform.copyPlan(out, 'x.mp4', { fpsNum: 30, duration: 1 }, { platform: 'tiktok', fx: 'to30' }, P.ffmpeg); check('to30 on 30 fps refused (lowFps, like the site)', false); }
  catch (e) { check('to30 on 30 fps refused (lowFps, like the site)', e.code === 'lowFps'); }

  // WebM / VP9 + bitrate mode + soft subtitles
  p.tracks.find(t => t.id === 'T1').sub = true;
  const wout = path.join(tmp, 'o.webm');
  log('… WebM step: building plan');
  const wplan = render.buildTimelinePlan(p, { outPath: wout, output: { container: 'webm', codec: 'vp9', quality: 'balanced', rate: { mode: 'bitrate', mbps: 2 }, softSubs: true } }, caps);
  wplan.steps.push({ kind: 'verify', file: wout, expectDur: total, w: W, h: H, audio: true });
  wplan.stallSecs = 60;
  log('… WebM step: running', wplan.steps[0].ffmpeg.slice(-12).join(' '));
  try { const v = await new Job(3, wplan, () => {}, null, { platform, verify: media.verifyOutput }).run(tmp); check('WebM VP9 bitrate + soft subtitles', v.verify.ok, JSON.stringify(v.verify)); }
  catch (e) { check('WebM VP9', false, String(e.message).slice(0, 800)); }
  log('… WebM step: probing');
  const sp3 = JSON.parse(X(P.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', wout])).streams.map(s => s.codec_type);
  check('subtitle stream muxed', sp3.includes('subtitle'), sp3.join(','));

  // WebM diagnosis: which part stalls on Windows? (reported, not counted as failures)
  const variant = async (label, out2, mutate) => {
    const pl = render.buildTimelinePlan(p, { outPath: out2, output: { container: 'webm', codec: 'vp9', quality: 'balanced' } }, caps);
    mutate(pl.steps[0].ffmpeg); pl.stallSecs = 45;
    const t1 = Date.now(); let last = 0;
    try { await new Job(9, pl, ev => { if (ev.frame) last = ev.frame; }, null, { platform, verify: media.verifyOutput }).run(tmp); log(`DIAG ${label}: ok ${((Date.now() - t1) / 1000).toFixed(1)}s`); }
    catch (e) { log(`DIAG ${label}: STALL/FAIL at frame ${last} — ${String(e.message).split('\n')[0]}`); }
  };
  const swap = (a, k, v) => { const i = a.indexOf(k); if (i >= 0) a[i + 1] = v; };
  await variant('vp9 default', path.join(tmp, 'd1.webm'), () => {});
  await variant('vp9 row-mt 0', path.join(tmp, 'd2.webm'), a => swap(a, '-row-mt', '0'));
  await variant('vp9 realtime', path.join(tmp, 'd4.webm'), a => swap(a, '-deadline', 'realtime'));
  await variant('vp9 threads 1', path.join(tmp, 'd5.webm'), a => { const i = a.indexOf('libvpx-vp9'); a.splice(i + 1, 0, '-threads', '1'); });
  await variant('av1 svt in webm', path.join(tmp, 'd6.webm'), a => { const i = a.indexOf('libvpx-vp9'); a.splice(i - 1, 2, '-c:v', 'libsvtav1', '-preset', '10', '-crf', '35'); ['-row-mt', '-deadline', '-cpu-used'].forEach(k => { const j = a.indexOf(k); if (j > 0) a.splice(j, 2); }); const b = a.indexOf('-b:v'); if (b > 0) a.splice(b, 2); });
  console.log(fails ? fails + ' check(s) failed' : 'timeline e2e passed');
  if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true }); else console.log('kept', tmp);
  process.exit(fails ? 1 : 0);
})();
