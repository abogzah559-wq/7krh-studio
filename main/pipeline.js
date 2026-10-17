'use strict';
/* 7krh Studio — turns the editor/export settings into an execution plan.
   Pure functions only (no I/O) so they can be unit-tested anywhere.

   Plan = { steps: [ {kind:'vs'|'ffmpeg', ...} ], out, expect:{frames, fps, w, h, dur} }
   - "enhance" (AI upscale and/or AI frame generation) runs through VapourSynth:
       vspipe (y4m) | ffmpeg (filters + audio + encode)
   - otherwise ffmpeg alone does trim/speed/adjust/scale/encode.
   - platform post-processing (TikTok "Krypton" duration trick) is a final stream-copy step. */

const even = n => Math.max(2, Math.round(n / 2) * 2);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (Number.isFinite(+v) ? +v : d);

const RES = { source: 0, '720': 720, '1080': 1080, '1440': 1440, '2160': 2160 };
const MAX_W = 3840, MAX_H = 2160, MAX_FPS = 120;

/* Real-ESRGAN family. Files are resolved by the runtime manifest. */
const UPSCALERS = {
  real: { x2: 'real_x2', x4: 'real_x4' },     // realesr-general (photos, live action)
  anime: { x2: 'anime_x2', x4: 'anime_x4' },  // realesr-animevideov3 (anime, drawings)
};
/* RIFE model ids (plugin index) — same set as Harbor Boost */
const RIFE = { '4.6': 23, '4.22-lite': 65, '4.25-lite': 70, '4.26': 72 };

/* ---------------------------------------------------------------- geometry */
function rotatedSize(info) {
  const r = ((num(info.rotation, 0) % 360) + 360) % 360;
  return r === 90 || r === 270 ? [info.height, info.width] : [info.width, info.height];
}

/* Output size for a "short side" target (works for portrait and landscape), never above 4K. */
function targetSize(srcW, srcH, res) {
  const short = RES[res] || 0;
  let w = srcW, h = srcH;
  if (short) {
    if (w >= h) { h = short; w = srcW * short / srcH; }
    else { w = short; h = srcH * short / srcW; }
  }
  const k = Math.min(1, MAX_W / Math.max(w, h), MAX_H / Math.min(w, h));
  return [even(w * k), even(h * k)];
}

/* Which AI scale to run: the smallest model scale that reaches the target (x2 or x4). */
function upscaleFactor(srcW, srcH, outW, outH) {
  const need = Math.max(outW / srcW, outH / srcH);
  if (need <= 1.05) return 0;
  return need <= 2.05 ? 2 : 4;
}

/* ---------------------------------------------------------------- frame rate */
function parseRate(r) {
  if (!r) return 0;
  if (typeof r === 'number') return r;
  const m = String(r).split('/');
  const v = m.length === 2 ? +m[0] / +m[1] : +m[0];
  return Number.isFinite(v) && v > 0 ? v : 0;
}
function fraction(x, maxDen = 1001) {
  // best rational approximation, used for RIFE factor and -r
  let bestN = Math.round(x), bestD = 1, err = Math.abs(x - bestN);
  for (let d = 2; d <= maxDen; d++) {
    const n = Math.round(x * d), e = Math.abs(x - n / d);
    if (e < err - 1e-9) { err = e; bestN = n; bestD = d; if (e < 1e-7) break; }
  }
  return [bestN, bestD];
}

/* ---------------------------------------------------------------- Krypton (TikTok) */
function kryptonFactor(fps, mode = 'auto') {
  if (mode === 'to30') { let k = fps / 30; if (Math.abs(k - Math.round(k)) < 0.02 * k) k = Math.round(k); return k > 1 ? k : 1; }
  if (mode !== 'auto') return +mode || 1;
  const k = fps >= 110 ? 6 : 2;
  return fps / k > 30.5 ? Math.ceil(fps / 30) : k;
}

/* ---------------------------------------------------------------- encoders */
/* caps.encoders: Set-like array of encoder names that passed a real test encode on this PC */
function pickEncoder(codec, caps, tenBit) {
  const has = n => (caps.encoders || []).includes(n);
  const order = {
    h264: ['h264_nvenc', 'h264_amf', 'h264_qsv', 'libx264'],
    hevc: ['hevc_nvenc', 'hevc_amf', 'hevc_qsv', 'libx265'],
    av1: ['av1_nvenc', 'av1_amf', 'av1_qsv', 'libsvtav1'],
  }[codec] || [];
  let name = order.find(has);
  if (!name) name = codec === 'h264' ? 'libx264' : codec === 'av1' ? 'libsvtav1' : 'libx265';
  if (codec === 'h264') tenBit = false;
  return { name, tenBit: !!tenBit };
}

/* quality: 'balanced' | 'high' | 'max'  →  encoder args */
function encoderArgs(enc, quality, fps, w, h) {
  const q = { balanced: 0, high: 1, max: 2 }[quality] ?? 1;
  const pix = enc.tenBit ? 'p010le' : 'yuv420p';
  const px = w * h * Math.max(24, fps);
  // generous VBR caps so CQ can breathe; scaled with pixels/second (4K120 ≈ 1 Gpix/s)
  const capMbps = Math.round(clamp(px / 1e6 * [0.09, 0.14, 0.2][q], 8, 400));
  const n = enc.name;
  if (n.endsWith('_nvenc')) {
    const cq = n.startsWith('av1') ? [32, 26, 21][q] : n.startsWith('hevc') ? [26, 21, 17][q] : [24, 19, 16][q];
    return ['-c:v', n, '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', String(cq), '-b:v', '0',
      '-maxrate', capMbps + 'M', '-bufsize', capMbps * 2 + 'M', '-multipass', 'fullres', '-spatial-aq', '1', '-temporal-aq', '1',
      '-rc-lookahead', '32', '-bf', n.startsWith('h264') ? '3' : '4', '-pix_fmt', enc.tenBit ? 'p010le' : 'yuv420p',
      ...(n.startsWith('hevc') ? ['-profile:v', enc.tenBit ? 'main10' : 'main', '-tag:v', 'hvc1'] : []),
      ...(n.startsWith('h264') ? ['-profile:v', 'high'] : [])];
  }
  if (n.endsWith('_amf')) {
    const qp = n.startsWith('av1') ? [120, 96, 80][q] : [24, 20, 17][q];
    return ['-c:v', n, '-quality', 'quality', '-rc', 'qvbr', '-qvbr_quality_level', String(n.startsWith('av1') ? 51 - Math.round(qp / 5) : 51 - qp),
      '-b:v', capMbps * 0.6 + 'M', '-maxrate', capMbps + 'M', '-pix_fmt', n.startsWith('h264') ? 'nv12' : (enc.tenBit ? 'p010le' : 'nv12'),
      ...(n.startsWith('hevc') ? ['-tag:v', 'hvc1'] : [])];
  }
  if (n.endsWith('_qsv')) {
    const gq = [25, 21, 18][q];
    return ['-c:v', n, '-preset', 'veryslow', '-global_quality', String(gq), '-look_ahead', '1', '-pix_fmt', enc.tenBit ? 'p010le' : 'nv12',
      ...(n.startsWith('hevc') ? ['-tag:v', 'hvc1'] : [])];
  }
  if (n === 'libx264') return ['-c:v', 'libx264', '-preset', ['medium', 'slow', 'slower'][q], '-crf', String([21, 18, 16][q]), '-pix_fmt', 'yuv420p', '-profile:v', 'high'];
  if (n === 'libx265') return ['-c:v', 'libx265', '-preset', ['medium', 'slow', 'slow'][q], '-crf', String([24, 20, 17][q]), '-pix_fmt', enc.tenBit ? 'yuv420p10le' : 'yuv420p', '-tag:v', 'hvc1'];
  if (n === 'libsvtav1') return ['-c:v', 'libsvtav1', '-preset', String([8, 6, 5][q]), '-crf', String([34, 28, 24][q]), '-pix_fmt', enc.tenBit ? 'yuv420p10le' : 'yuv420p'];
  return ['-c:v', n, '-pix_fmt', pix];
}

/* ---------------------------------------------------------------- filters */
function atempoChain(speed) {
  // atempo accepts 0.5..2 per instance
  const out = []; let s = speed;
  while (s > 2.0001) { out.push('atempo=2'); s /= 2; }
  while (s < 0.4999) { out.push('atempo=0.5'); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-4) out.push('atempo=' + s.toFixed(5));
  return out;
}
function eqFilter(adj) {
  if (!adj) return null;
  const b = clamp(num(adj.brightness, 0), -100, 100), c = clamp(num(adj.contrast, 0), -100, 100), s = clamp(num(adj.saturation, 0), -100, 100);
  const g = clamp(num(adj.gamma, 0), -100, 100);
  if (!b && !c && !s && !g) return null;
  const parts = [];
  if (b) parts.push('brightness=' + (b / 100 * 0.25).toFixed(4));
  if (c) parts.push('contrast=' + (1 + c / 100 * 0.6).toFixed(4));
  if (s) parts.push('saturation=' + (1 + s / 100).toFixed(4));
  if (g) parts.push('gamma=' + (1 + g / 100 * 0.6).toFixed(4));
  return 'eq=' + parts.join(':');
}
function sharpenFilter(adj) {
  const v = clamp(num(adj && adj.sharpen, 0), 0, 100);
  return v ? `cas=strength=${(v / 100 * 0.9).toFixed(3)}` : null;
}
function cropFilter(crop, w, h) {
  // center crop to an aspect ratio, before scaling
  if (!crop || crop === 'none') return null;
  const [a, b] = String(crop).split(':').map(Number);
  if (!a || !b) return null;
  const want = a / b, have = w / h;
  if (Math.abs(want - have) < 0.01) return null;
  let cw = w, ch = h;
  if (have > want) cw = even(h * want); else ch = even(w / want);
  return { filter: `crop=${cw}:${ch}`, w: cw, h: ch };
}

/* ---------------------------------------------------------------- VapourSynth script */
function vpyScript(p) {
  // p: { src, cache, start, end, rotation, matrix, up:{model, scale, backend}, fg:{model, num, den}, outW, outH, tenBit, plugins, models }
  const L = [];
  L.push('import vapoursynth as vs');
  L.push('from fractions import Fraction');
  L.push('core = vs.core');
  L.push('def _load(p):');
  L.push('    try:');
  L.push('        core.std.LoadPlugin(p)');
  L.push('    except vs.Error as e:');
  L.push('        if "already loaded" not in str(e): raise');
  L.push(`_load(r"${p.plugins.lsmas}")`);
  if (p.fg) L.push(`_load(r"${p.plugins.rife}")`);
  L.push(`clip = core.lsmas.LWLibavSource(r"${p.src}", cachefile=r"${p.cache}", prefer_hw=0)`);
  L.push(`fps = clip.fps if clip.fps.numerator > 0 else Fraction(${p.fpsNum}, ${p.fpsDen})`);
  L.push(`a = max(0, int(round(${p.start.toFixed(6)} * fps)))`);
  L.push(`b = min(clip.num_frames, int(round(${p.end.toFixed(6)} * fps)))`);
  L.push('clip = clip[a:max(b, a + 1)]');
  const rot = ((p.rotation % 360) + 360) % 360;
  if (rot === 90) L.push('clip = core.std.Transpose(clip).std.FlipHorizontal()');
  else if (rot === 270) L.push('clip = core.std.Transpose(clip).std.FlipVertical()');
  else if (rot === 180) L.push('clip = core.std.Turn180(clip)');
  if (p.crop) L.push(`clip = core.std.CropAbs(clip, ${p.crop.w}, ${p.crop.h}, ${(p.crop.x)}, ${(p.crop.y)})`);
  L.push(`matrix = "${p.matrix}"`);
  L.push('rgb = core.resize.Bicubic(clip, format=vs.RGBS, matrix_in_s=matrix)');
  if (p.fg) {
    // frame generation first, at source resolution (much cheaper than at 4K)
    L.push('luma = core.resize.Bilinear(core.std.ShufflePlanes(clip, 0, vs.GRAY), 64, 36, format=vs.GRAYS)');
    L.push('st = core.std.PlaneStats(luma, luma[1:] + luma[-1])');
    L.push('def _mark(n, f):');
    L.push('    o = f.copy()');
    L.push('    o.props["_SceneChangeNext"] = 1 if f.props["PlaneStatsDiff"] > 0.1 else 0');
    L.push('    return o');
    L.push('st = core.std.ModifyFrame(st, st, _mark)');
    L.push('rgb = core.std.CopyFrameProps(rgb, st, props=["_SceneChangeNext"])');
    L.push(`rgb = core.rife.RIFE(rgb, model=${p.fg.model}, factor_num=${p.fg.num}, factor_den=${p.fg.den}, gpu_thread=${p.fg.threads || 2}, uhd=${rgbWide(p) ? 'True' : 'False'}, sc=True${p.gpu >= 0 ? ', gpu_id=' + p.gpu : ''})`);
  }
  if (p.up) {
    L.push(`_load(r"${p.up.backend === 'ncnn' ? p.plugins.vsncnn : p.plugins.vsort}")`);
    L.push('import vsmlrt');
    L.push('from vsmlrt import Backend');
    const be = p.up.backend === 'ncnn'
      ? `Backend.NCNN_VK(fp16=True, num_streams=2${p.gpu >= 0 ? ', device_id=' + p.gpu : ''})`
      : `Backend.ORT_DML(fp16=True, num_streams=2${p.gpu >= 0 ? ', device_id=' + p.gpu : ''})`;
    L.push(`be = ${be}`);
    if (p.up.tiles > 1) L.push(`rgb = vsmlrt.inference(rgb, r"${p.up.model}", tiles=${p.up.tiles}, overlap=16, backend=be)`);
    else L.push(`rgb = vsmlrt.inference(rgb, r"${p.up.model}", backend=be)`);
  }
  L.push(`if rgb.width != ${p.outW} or rgb.height != ${p.outH}:`);
  L.push(`    rgb = core.resize.Spline36(rgb, ${p.outW}, ${p.outH})`);
  L.push(`out = core.resize.Bicubic(rgb, format=${p.tenBit ? 'vs.YUV420P10' : 'vs.YUV420P8'}, matrix_s="709", dither_type="error_diffusion")`);
  L.push('out.set_output()');
  return L.join('\n') + '\n';
}
function rgbWide(p) { return Math.max(p.srcW, p.srcH) > 2560; }

/* ---------------------------------------------------------------- the plan */
/*
 opts = {
   input, outPath,
   trim:{start,end}, speed, adjust:{brightness,contrast,saturation,gamma,sharpen}, crop:'none'|'9:16'|'1:1'|'16:9'|'4:5',
   audio:{mode:'keep'|'mute'|'replace'|'mix', file, volume, musicVolume, musicStart},
   enhance:{ upscale:{on, model:'real'|'anime'}, framegen:{on, model:'4.26'} },
   output:{ res:'source'|'1080'|'1440'|'2160', fps:'source'|number, codec:'h264'|'hevc'|'av1', quality, tenBit },
   platform:'self'|'tiktok'|'instagram'|'youtube', kryptonMode:'auto'
 }
 info = { width, height, rotation, fps, duration, hasAudio, colorPrimaries, colorSpace }
 caps = { encoders:[...], gpu:-1|0.., upBackend:'ort'|'ncnn', paths:{ffmpeg, vspipe, plugins:{lsmas,rife}, models:{...}}, tmp }
*/
function buildPlan(opts, info, caps) {
  const P = caps.paths;
  const srcFps = parseRate(info.fps) || 30;
  const dur = num(info.duration, 0);
  const start = clamp(num(opts.trim && opts.trim.start, 0), 0, dur || 1e9);
  let end = clamp(num(opts.trim && opts.trim.end, dur), start + 0.04, dur || 1e9);
  if (opts.preview) end = Math.min(dur || 1e9, start + 4 / srcFps);
  const speed = clamp(num(opts.speed, 1), 0.25, 4);
  const segDur = (end - start) / speed;

  let [w0, h0] = rotatedSize(info);
  const crop = cropFilter(opts.crop, w0, h0);
  const cw = crop ? crop.w : w0, ch = crop ? crop.h : h0;
  const out = opts.output || {};
  let [W, H] = targetSize(cw, ch, out.res || 'source');

  // output fps: 'source' keeps it; numbers are capped at 120
  let outFps = out.fps === 'source' || !out.fps ? srcFps : clamp(+out.fps, 1, MAX_FPS);
  // NTSC sources (29.97, 59.94…): "120" means 119.88 so frame generation lands exactly, with no duplicated frames
  const ntsc = Math.abs(srcFps * 1.001 - Math.round(srcFps * 1.001)) < 0.01 && Math.abs(srcFps - Math.round(srcFps)) > 0.01;
  if (ntsc && out.fps !== 'source' && out.fps && Number.isInteger(+out.fps)) outFps = +out.fps / 1.001;
  const fgOn = !!(opts.enhance && opts.enhance.framegen && opts.enhance.framegen.on);
  const upOn = !!(opts.enhance && opts.enhance.upscale && opts.enhance.upscale.on);
  // frames per second coming out of VapourSynth / the source, before the speed change
  let fpsBeforeSpeed = srcFps;
  let fg = null;
  if (fgOn) {
    // RIFE multiplies the source rate; the speed change then scales time
    const want = outFps * speed;               // rate needed before setpts so that after speed we land on outFps
    const ratio = want / srcFps;
    if (ratio > 1.01) {
      const [n, d] = fraction(ratio, 100);
      fg = { model: RIFE[(opts.enhance.framegen.model) || '4.26'] ?? 72, num: n, den: d, threads: 2 };
      fpsBeforeSpeed = srcFps * n / d;
    }
  }
  if (!fgOn && out.fps !== 'source' && out.fps) {
    // no AI: ffmpeg fps filter (duplicates frames when going up)
    fpsBeforeSpeed = srcFps;
  }

  let up = null;
  if (upOn) {
    const f = upscaleFactor(cw, ch, W, H);
    if (f) {
      const fam = UPSCALERS[opts.enhance.upscale.model] || UPSCALERS.real;
      const key = f === 2 ? fam.x2 : fam.x4;
      const model = P.models[key] || P.models[fam.x4];
      // tile large inputs so VRAM stays reasonable (input pixels × scale²)
      const tiles = cw * ch * f * f > 3840 * 2160 * 1.2 ? 2 : 1;
      up = { model, scale: f, backend: caps.upBackend || 'ort', tiles };
    }
  }

  const enhance = !!(fg || up);
  const enc = pickEncoder(out.codec || 'hevc', caps, !!out.tenBit);
  const vf = [];
  const af = [];
  const ff = [P.ffmpeg, '-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-stats_period', '0.5'];
  const steps = [];
  let vpy = null;

  if (enhance) {
    const matrix = (info.colorSpace && /bt2020/.test(info.colorSpace)) ? '2020ncl' : (h0 > 576 || w0 > 1024 ? '709' : '170m');
    vpy = vpyScript({
      src: opts.input, cache: caps.tmp + '\\src.lwi', start, end, rotation: num(info.rotation, 0), matrix,
      fpsNum: fraction(srcFps)[0], fpsDen: fraction(srcFps)[1],
      crop: crop ? { w: crop.w, h: crop.h, x: Math.floor((w0 - crop.w) / 4) * 2, y: Math.floor((h0 - crop.h) / 4) * 2 } : null,
      fg, up, outW: W, outH: H, tenBit: enc.tenBit, gpu: num(caps.gpu, -1), srcW: cw, srcH: ch,
      plugins: P.plugins,
    });
    const [rn, rd] = fraction(fpsBeforeSpeed);
    ff.push('-f', 'yuv4mpegpipe', '-r', `${rn}/${rd}`, '-i', 'pipe:0');
  } else {
    ff.push('-ss', start.toFixed(3), '-to', end.toFixed(3), '-i', opts.input);
    if (crop) vf.push(crop.filter);
    if (W !== cw || H !== ch) vf.push(`scale=${W}:${H}:flags=lanczos+accurate_rnd+full_chroma_int`);
  }
  // audio inputs
  const am = (opts.audio && opts.audio.mode) || 'keep';
  const music = (am === 'replace' || am === 'mix') && opts.audio.file;
  let srcAudioIdx = -1, musicIdx = -1, nextIdx = 1;
  if (enhance && info.hasAudio && (am === 'keep' || am === 'mix')) {
    ff.push('-ss', start.toFixed(3), '-to', end.toFixed(3), '-i', opts.input); srcAudioIdx = nextIdx++;
  } else if (!enhance && info.hasAudio && (am === 'keep' || am === 'mix')) {
    srcAudioIdx = 0;
  }
  if (music) {
    const ms = Math.max(0, num(opts.audio.musicStart, 0));
    ff.push('-ss', ms.toFixed(3), '-i', opts.audio.file); musicIdx = nextIdx++;
  }

  // video filters common to both paths
  if (speed !== 1) vf.push(`setpts=PTS/${speed}`);
  const eq = eqFilter(opts.adjust); if (eq) vf.push(eq);
  const sh = sharpenFilter(opts.adjust); if (sh) vf.push(sh);
  const fpsAfterSpeed = fpsBeforeSpeed * speed;
  if (Math.abs(fpsAfterSpeed - outFps) / outFps > 0.002) vf.push(`fps=${fraction(outFps).join('/')}`);
  if (!enhance) vf.push(`format=${enc.tenBit ? 'yuv420p10le' : 'yuv420p'}`);

  // audio graph
  const vol = clamp(num(opts.audio && opts.audio.volume, 1), 0, 4);
  const mvol = clamp(num(opts.audio && opts.audio.musicVolume, 1), 0, 4);
  let filterComplex = null, aMap = null;
  const tempo = atempoChain(speed);
  if (srcAudioIdx >= 0 && musicIdx >= 0) {
    const a1 = [...tempo, vol !== 1 ? `volume=${vol}` : null].filter(Boolean).join(',') || 'anull';
    filterComplex = `[${srcAudioIdx}:a:0]${a1}[a1];[${musicIdx}:a:0]volume=${mvol}[a2];[a1][a2]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`;
    aMap = '[aout]';
  } else if (srcAudioIdx >= 0) {
    [...tempo, vol !== 1 ? `volume=${vol}` : null].filter(Boolean).forEach(x => af.push(x));
    aMap = `${srcAudioIdx}:a:0`;
  } else if (musicIdx >= 0) {
    if (mvol !== 1) af.push(`volume=${mvol}`);
    af.push(`afade=t=out:st=${Math.max(0, segDur - 1.5).toFixed(3)}:d=1.5`);
    aMap = `${musicIdx}:a:0`;
  }

  ff.push('-map', '0:v:0');
  if (filterComplex) ff.push('-filter_complex', filterComplex);
  if (aMap) ff.push('-map', aMap);
  if (vf.length) ff.push('-vf', vf.join(','));
  if (af.length) ff.push('-af', af.join(','));
  ff.push(...encoderArgs(enc, out.quality || 'high', outFps, W, H));
  ff.push('-g', String(Math.round(outFps * 2)));
  if (aMap) ff.push('-c:a', 'aac', '-b:a', '320k', '-ar', '48000');
  ff.push('-t', segDur.toFixed(3), '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
  ff.push('-movflags', '+faststart', '-map_metadata', '-1', '-metadata', 'encoder=7krh Studio');

  if (opts.preview) {
    // single still through exactly the same chain (no audio, PNG)
    const pf = [P.ffmpeg, '-hide_banner', '-nostdin', '-y', '-loglevel', 'error'];
    if (enhance) { const [rn, rd] = fraction(fpsBeforeSpeed); pf.push('-f', 'yuv4mpegpipe', '-r', `${rn}/${rd}`, '-i', 'pipe:0'); }
    else pf.push('-ss', start.toFixed(3), '-i', opts.input);
    const pvf = vf.filter(f => !/^setpts|^fps=|^format=/.test(f));
    if (pvf.length) pf.push('-vf', pvf.join(','));
    pf.push('-frames:v', '1', opts.outPath);
    return { steps: [enhance ? { kind: 'pipe', vpy, vspipe: [P.vspipe, '-c', 'y4m', '-e', '0', '{VPY}', '-'], ffmpeg: pf } : { kind: 'ffmpeg', ffmpeg: pf }],
      enhance, preview: true, expect: { frames: 1, fps: outFps, w: W, h: H, dur: 0, kfactor: 1, finalDur: 0 } };
  }
  const platform = opts.platform || 'self';
  const needKrypton = platform === 'tiktok';
  const encOut = needKrypton ? caps.tmp + '\\encoded.mp4' : opts.outPath;
  ff.push(encOut);

  if (enhance) steps.push({ kind: 'pipe', vpy, vspipe: [P.vspipe, '-c', 'y4m', '{VPY}', '-'], ffmpeg: ff });
  else steps.push({ kind: 'ffmpeg', ffmpeg: ff });

  let kfactor = 1;
  if (needKrypton) {
    kfactor = kryptonFactor(outFps, opts.kryptonMode || 'auto');
    if (kfactor > 1) {
      steps.push({ kind: 'ffmpeg', post: true, ffmpeg: [P.ffmpeg, '-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-itsscale', String(kfactor), '-i', encOut, '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart', opts.outPath] });
    } else {
      steps.push({ kind: 'move', from: encOut, to: opts.outPath });
    }
  }

  return {
    steps,
    enhance,
    encoder: enc.name,
    expect: { frames: Math.max(1, Math.round(segDur * outFps)), fps: outFps, w: W, h: H, dur: segDur, kfactor, finalDur: segDur * kfactor },
    up: up ? { scale: up.scale, backend: up.backend } : null,
    fg: fg ? { num: fg.num, den: fg.den } : null,
  };
}

module.exports = { buildPlan, targetSize, upscaleFactor, kryptonFactor, pickEncoder, encoderArgs, fraction, parseRate, atempoChain, eqFilter, vpyScript, rotatedSize, RIFE };
