'use strict';
/* 7krh Studio — timeline renderer: project (ui/core/tl-core.js) → one ffmpeg command.
   Pure planning (no I/O): returns steps + the side files the job writes before running.

   Video: a black canvas at the output size and frame rate; every visible clip becomes a layer
     input (-ss in -t len) → setpts (speed, timeline offset) → fps → scale (fit × scale) → gbrap
     → colour (lut + saturation matrix + sharpen kernel, same maths as the preview) → rotate
     → opacity (static, or per-frame values through sendcmd) → fade-to-black → overlay at the
     timeline position (x/y can be animated with expressions in t).
     Animated scale / rotation use a perspective warp of a padded layer with per-frame corner expressions.
   Audio: every sound-bearing clip → tempo → 48 kHz stereo → denoise → volume (fades + keyframes as one
     expression) → delay to its timeline position; ducked tracks are side-chain compressed by the rest;
     everything is mixed without normalisation and limited to stay below 0 dBFS. */
const TL = require('../ui/core/tl-core.js');
const pipeline = require('./pipeline');
const { colorChain, matrixOf } = require('./colorff');

const even = n => Math.max(2, Math.round(n / 2) * 2);
const f6 = v => { const s = (Math.round(v * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, ''); return s === '-0' ? '0' : s; };

/* ---------------------------------------------------------------- tiny expression AST
   Serialises to ffmpeg's expression language and also evaluates in JS (tests compare it with TL.stateAt). */
const V = name => ({ v: name });
const op = (o, ...a) => [o, ...a];
const isNum = e => typeof e === 'number';
const add = (a, b) => (isNum(a) && isNum(b) ? a + b : isNum(a) && a === 0 ? b : isNum(b) && b === 0 ? a : op('+', a, b));
const sub = (a, b) => (isNum(a) && isNum(b) ? a - b : isNum(b) && b === 0 ? a : op('-', a, b));
const mul = (a, b) => (isNum(a) && isNum(b) ? a * b : (isNum(a) && a === 1) ? b : (isNum(b) && b === 1) ? a : (isNum(a) && a === 0) || (isNum(b) && b === 0) ? 0 : op('*', a, b));
const div = (a, b) => (isNum(a) && isNum(b) ? a / b : isNum(b) && b === 1 ? a : op('/', a, b));
const clip01 = a => (isNum(a) ? Math.min(1, Math.max(0, a)) : op('clip', a, 0, 1));
function toFF(e) {
  if (isNum(e)) return f6(e);
  if (e.v) return e.v;
  const [o, ...a] = e;
  switch (o) {
    case '+': return `(${toFF(a[0])}+${toFF(a[1])})`;
    case '-': return `(${toFF(a[0])}-${toFF(a[1])})`;
    case '*': return `(${toFF(a[0])}*${toFF(a[1])})`;
    case '/': return `(${toFF(a[0])}/${toFF(a[1])})`;
    case 'clip': return `clip(${toFF(a[0])},${toFF(a[1])},${toFF(a[2])})`;
    case 'iflt': return `if(lt(${toFF(a[0])},${toFF(a[1])}),${toFF(a[2])},${toFF(a[3])})`;
    case 'cos': return `cos(${toFF(a[0])})`;
    case 'sin': return `sin(${toFF(a[0])})`;
    default: throw new Error('expr op ' + o);
  }
}
function evalE(e, env) {
  if (isNum(e)) return e;
  if (e.v) return env[e.v];
  const [o, ...a] = e, x = i => evalE(a[i], env);
  switch (o) {
    case '+': return x(0) + x(1); case '-': return x(0) - x(1); case '*': return x(0) * x(1); case '/': return x(0) / x(1);
    case 'clip': return Math.min(x(2), Math.max(x(1), x(0)));
    case 'iflt': return x(0) < x(1) ? x(2) : x(3);
    case 'cos': return Math.cos(x(0)); case 'sin': return Math.sin(x(0));
    default: throw new Error('expr op ' + o);
  }
}
const isConst = e => isNum(e);

/* keyframes → piecewise linear expression of u (same as TL.kfValue) */
function kfExpr(arr, dflt, u) {
  if (!Array.isArray(arr) || !arr.length) return dflt;
  const a = arr.slice().sort((p, q) => p.t - q.t);
  if (a.length === 1 || a.every(k => k.v === a[0].v)) return a[0].v;
  let e = a[a.length - 1].v;
  for (let i = a.length - 1; i >= 1; i--) {
    const k0 = a[i - 1], k1 = a[i], dt = Math.max(1e-9, k1.t - k0.t);
    const seg = add(k0.v, mul((k1.v - k0.v) / dt, sub(u, k0.t)));
    e = op('iflt', u, k1.t, seg, e);
  }
  return op('iflt', u, a[0].t, a[0].v, e);
}
const easeE = p => (isNum(p) ? TL.ease(p) : mul(mul(p, p), sub(3, mul(2, p))));
/* transitions → expressions (mirror of TL.transState) */
function transExpr(c, u) {
  const r = { o: 1, dx: 0, dy: 0, s: 1, black: 0 };
  const L = TL.len(c);
  const one = (tr, pRaw, dir) => {
    if (!tr || !tr.type || !(tr.dur > 0)) return;
    const p = clip01(pRaw), e = easeE(p), q = sub(1, e);
    switch (tr.type) {
      case 'dissolve': r.o = mul(r.o, p); break;
      case 'fadeblack': r.black = r.black === 0 ? sub(1, p) : op('iflt', r.black, sub(1, p), sub(1, p), r.black); break;
      case 'slideleft': r.dx = add(r.dx, mul(dir > 0 ? 1 : -1, q)); break;
      case 'slideright': r.dx = add(r.dx, mul(dir > 0 ? -1 : 1, q)); break;
      case 'slideup': r.dy = add(r.dy, mul(dir > 0 ? 1 : -1, q)); break;
      case 'slidedown': r.dy = add(r.dy, mul(dir > 0 ? -1 : 1, q)); break;
      case 'zoom': r.s = mul(r.s, add(0.6, mul(0.4, e))); r.o = mul(r.o, p); break;
      default: break;
    }
  };
  if (c.tin) one(c.tin, div(u, c.tin.dur), 1);
  if (c.tout) one(c.tout, div(sub(L, u), c.tout.dur), -1);
  return r;
}
function stateExpr(c, u) {
  const tf = c.tf || {}, kf = c.kf || {}, tr = transExpr(c, u);
  const o = mul(kfExpr(kf.o, tf.o ?? 1, u), tr.o);
  return {
    x: add(kfExpr(kf.x, tf.x || 0, u), tr.dx),
    y: add(kfExpr(kf.y, tf.y || 0, u), tr.dy),
    s: mul(kfExpr(kf.s, tf.s ?? 1, u), tr.s),
    r: kfExpr(kf.r, tf.r || 0, u),
    o: isNum(o) ? Math.min(1, Math.max(0, o)) : clip01(o),
    black: tr.black,
  };
}

/* ---------------------------------------------------------------- filtergraph helpers */
const esc = p => "'" + String(p).replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:') + "'";
const atempo = s => pipeline.atempoChain(s);

/* sendcmd script with one opacity value per output frame of the clip (only where it changes) */
function alphaCmds(target, c, oE, fps) {
  const L = TL.len(c), n = Math.ceil(L * fps) + 1, lines = [];
  let last = null;
  for (let i = 0; i <= n; i++) {
    const u = Math.min(L, i / fps), v = Math.round(evalE(oE, { u }) * 1000) / 1000;
    // a command at time T is applied to the first frame whose timestamp is >= T
    if (v !== last) { lines.push(`${f6(Math.max(0, c.start + i / fps - 0.25 / fps))} ${target} aa ${v};`); last = v; }
  }
  return lines.join('\n') + '\n';
}

/* ---------------------------------------------------------------- the plan
   opts = { outPath, output:{ res:'project'|'720'|'1080'|'1440'|'2160', fps:'project'|n, codec, quality, tenBit, rate:{mode:'quality'|'bitrate', mbps},
            container:'mp4'|'mov'|'webm', loudnorm:bool, softSubs:bool }, intermediate:bool }
   caps = { encoders, ffmpegMajor, paths:{ffmpeg, models:{rnnoise}}, tmp } */
function buildTimelinePlan(project, opts, caps) {
  const p = TL.migrate(JSON.parse(JSON.stringify(project)));
  const errs = TL.validate(p);
  if (errs.length) { const e = new Error('project: ' + errs.join(', ')); e.code = errs[0]; throw e; }
  const P = caps.paths, out = opts.output || {};
  const total = TL.duration(p);
  const cw = p.canvas.w, ch = p.canvas.h;
  // output size: project canvas, or the same shape at another short side
  let W = cw, H = ch;
  const RES = { '720': 720, '1080': 1080, '1440': 1440, '2160': 2160 };
  if (RES[out.res]) { const s = RES[out.res], k = s / Math.min(cw, ch); W = even(cw * k); H = even(ch * k); }
  W = even(W); H = even(H);
  const K = W / cw;
  const fps = out.fps && out.fps !== 'project' ? +out.fps : +p.canvas.fps || 30;
  const [fn, fd] = pipeline.fraction(fps);
  const container = out.container || 'mp4';
  const tmp = caps.tmp;
  const files = {};
  const ff = [P.ffmpeg, '-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-stats_period', '0.5'];
  const fc = [];
  let nIn = 0;
  const inputOf = new Map(); // clip id -> input index
  const subsTracks = new Set(out.softSubs ? p.tracks.filter(t => t.sub).map(t => t.id) : []);

  /* inputs */
  const addInput = c => {
    const m = p.media[c.src] || {};
    if (c.kind === 'video') ff.push('-ss', f6(c.in), '-t', f6(c.out - c.in), '-i', c.src);
    else if (c.kind === 'image') ff.push('-loop', '1', '-framerate', `${fn}/${fd}`, '-t', f6(TL.len(c) + 1 / fps), '-i', c.src);
    else if (c.kind === 'text') ff.push('-loop', '1', '-framerate', `${fn}/${fd}`, '-t', f6(TL.len(c) + 1 / fps), '-i', c.text.png);
    else if (c.kind === 'audio') ff.push('-ss', f6(c.in), '-t', f6(c.out - c.in), '-i', c.src);
    inputOf.set(c.id, nIn++);
    return m;
  };

  const audioOnly = !!opts.audioOnly;
  /* video layers in draw order: bottom track first, then by start time */
  if (!audioOnly) fc.push(`color=c=${(p.canvas.bg || '#000000').replace('#', '0x')}:s=${W}x${H}:r=${fn}/${fd}:d=${f6(total)},format=gbrp[base0]`);
  let cur = 'base0', li = 0;
  const layers = [];
  for (const t of (audioOnly ? [] : TL.drawOrder(p))) {
    if (t.hidden || subsTracks.has(t.id)) continue;
    p.clips.filter(c => c.track === t.id && TL.isVisual(c)).sort((a, b) => a.start - b.start).forEach(c => layers.push(c));
  }
  for (const c of layers) {
    addInput(c);
    const idx = inputOf.get(c.id), L = TL.len(c), S = c.start, tag = 'L' + (++li);
    const u = V('u');
    const st = stateExpr(c, u);
    const an = TL.animated(c);
    const [fw0, fh0] = TL.fitted(p, c);
    const fw = fw0 * K, fh = fh0 * K;
    const chain = [];
    if (c.kind === 'video') {
      if (c.reverse) chain.push('reverse');
      chain.push(`setpts=(PTS-STARTPTS)/${f6(c.speed)}+${f6(S)}/TB`, `fps=${fn}/${fd}`);
    } else chain.push(`setpts=PTS-STARTPTS+${f6(S)}/TB`);
    const geoAnim = an.scale || an.rot;
    const smax = geoAnim ? Math.max(1, ...((c.kf && c.kf.s) || []).map(k => k.v), (c.tf && c.tf.s) || 1) : 1;
    const s0 = isConst(st.s) ? st.s : 1;
    const lw = Math.max(2, Math.round(fw * (geoAnim ? smax : s0))), lh = Math.max(2, Math.round(fh * (geoAnim ? smax : s0)));
    chain.push(`scale=${lw}:${lh}:flags=lanczos${c.kind === 'video' ? ':in_color_matrix=' + matrixOf(p.media[c.src]) + ':in_range=auto' : ''}`, 'format=gbrap');
    chain.push(...colorChain(c.adj));
    const ccm = `colorchannelmixer@a${li}`;
    // opacity: constant → one mixer; animated → per-frame values through sendcmd
    if (!isConst(st.o)) {
      const f = `${tmp}/alpha-${li}.cmd`; files[f] = alphaCmds(ccm, c, st.o, fps);
      chain.push(`sendcmd=f=${esc(f)}`, `${ccm}=aa=1`);
    } else if (st.o < 0.999) chain.push(`colorchannelmixer=aa=${f6(st.o)}`);
    // fade to / from black
    if (c.tin && c.tin.type === 'fadeblack' && c.tin.dur > 0) chain.push(`fade=t=in:st=${f6(S)}:d=${f6(c.tin.dur)}`);
    if (c.tout && c.tout.type === 'fadeblack' && c.tout.dur > 0) chain.push(`fade=t=out:st=${f6(S + L - c.tout.dur)}:d=${f6(c.tout.dur)}`);
    const enable = `enable='between(t,${f6(S)},${f6(S + L - 0.5 / fps)})'`;
    const ut = sub(V('t'), S); // overlay/rotate time → clip time
    const subst = e => substitute(e, 'u', ut);
    if (!geoAnim) {
      const r = isConst(st.r) ? st.r : 0;
      if (Math.abs(r) > 0.01) chain.push(`rotate=a=${f6(r * Math.PI / 180)}:ow=rotw(${f6(r * Math.PI / 180)}):oh=roth(${f6(r * Math.PI / 180)}):c=none`);
      fc.push(`[${idx}:v]${chain.join(',')}[${tag}]`);
      const cx = add(W / 2, mul(W, subst(st.x))), cy = add(H / 2, mul(H, subst(st.y)));
      const x = sub(cx, V('overlay_w/2')), y = sub(cy, V('overlay_h/2'));
      fc.push(`[${cur}][${tag}]overlay=x='${toFF(x)}':y='${toFF(y)}':eval=${an.pos ? 'frame' : 'init'}:format=gbrp:eof_action=pass:${enable}[b${li}]`);
    } else {
      // perspective warp: the layer is padded to a frame that covers the canvas, then its corners are moved per frame
      const PW = even(Math.max(W, lw) + 8), PH = even(Math.max(H, lh) + 8);
      chain.push(`pad=${PW}:${PH}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`);
      const nU = div(V('in'), fps); // perspective has no "t": frame count / fps = clip time
      const sx = mul(subst2(st.s, nU), 1 / smax), rr = mul(subst2(st.r, nU), Math.PI / 180);
      const cx = add(W / 2 + (PW - W) / 2, mul(W, subst2(st.x, nU))), cy = add(H / 2 + (PH - H) / 2, mul(H, subst2(st.y, nU)));
      const cs = op('cos', rr), sn = op('sin', rr);
      const corner = (dx, dy) => [add(cx, mul(sx, sub(mul(cs, dx), mul(sn, dy)))), add(cy, mul(sx, add(mul(sn, dx), mul(cs, dy))))];
      const hx = PW / 2, hy = PH / 2;
      const c0 = corner(-hx, -hy), c1 = corner(hx, -hy), c2 = corner(-hx, hy), c3 = corner(hx, hy);
      chain.push(`perspective=x0='${toFF(c0[0])}':y0='${toFF(c0[1])}':x1='${toFF(c1[0])}':y1='${toFF(c1[1])}':x2='${toFF(c2[0])}':y2='${toFF(c2[1])}':x3='${toFF(c3[0])}':y3='${toFF(c3[1])}':sense=destination:eval=frame:interpolation=linear`);
      fc.push(`[${idx}:v]${chain.join(',')}[${tag}]`);
      fc.push(`[${cur}][${tag}]overlay=x=${-(PW - W) / 2}:y=${-(PH - H) / 2}:format=gbrp:eof_action=pass:${enable}[b${li}]`);
    }
    cur = 'b' + li;
  }
  // compositing happens in RGB; one conversion to BT.709 video range at the very end
  if (!audioOnly) fc.push(`[${cur}]scale=out_color_matrix=bt709:out_range=tv,format=${out.tenBit ? 'yuv420p10le' : 'yuv420p'}[vout]`);

  /* audio */
  const sounds = p.clips.filter(c => TL.hasSound(p, c) && !(TL.trackOf(p, c) || {}).hidden).sort((a, b) => a.start - b.start);
  const duck = [], rest = [];
  let ai = 0;
  for (const c of sounds) {
    if (!inputOf.has(c.id)) addInput(c);
    const idx = inputOf.get(c.id), L = TL.len(c), tag = 'a' + (++ai);
    const ch = ['asetpts=PTS-STARTPTS'];
    if (c.reverse) ch.push('areverse');
    ch.push(...atempo(c.speed), 'aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo');
    if (c.denoise === 'light') ch.push('afftdn=nr=12:nf=-40');
    else if (c.denoise === 'ai') {
      if (!P.models || !P.models.rnnoise) { const e = new Error('rnnoise model missing'); e.code = 'rnnoise'; throw e; }
      ch.push(`arnndn=m=${esc(P.models.rnnoise)}`);
    }
    const g = gainExpr(p, c, V('t'));
    if (!isConst(g)) ch.push(`volume='${toFF(g)}':eval=frame`);
    else if (Math.abs(g - 1) > 1e-4) ch.push(`volume=${f6(g)}`);
    ch.push(`atrim=0:${f6(L)}`, `adelay=${Math.round(c.start * 1000)}:all=1`);
    fc.push(`[${idx}:a]${ch.join(',')}[${tag}]`);
    ((TL.trackOf(p, c) || {}).duck ? duck : rest).push(tag);
  }
  let aout = null;
  if (duck.length && rest.length) {
    fc.push(`${duck.map(x => `[${x}]`).join('')}amix=inputs=${duck.length}:duration=longest:normalize=0[duckmix]`);
    fc.push(`${rest.map(x => `[${x}]`).join('')}amix=inputs=${rest.length}:duration=longest:normalize=0,asplit=2[voice1][voice2]`);
    fc.push('[duckmix][voice1]sidechaincompress=threshold=0.04:ratio=8:attack=15:release=450:makeup=1[ducked]');
    fc.push('[ducked][voice2]amix=inputs=2:duration=longest:normalize=0[amixed]');
    aout = 'amixed';
  } else if (duck.length + rest.length) {
    const all = [...duck, ...rest];
    fc.push(`${all.map(x => `[${x}]`).join('')}amix=inputs=${all.length}:duration=longest:normalize=0[amixed]`);
    aout = 'amixed';
  }
  if (aout) {
    const post = [out.loudnorm ? 'loudnorm=I=-14:TP=-1.5:LRA=11' : null, 'alimiter=limit=0.966:level=disabled', `apad`, `atrim=0:${f6(total)}`, 'aresample=48000'].filter(Boolean);
    fc.push(`[${aout}]${post.join(',')}[aout]`);
  }

  /* subtitles as a separate track: muxed in a second, copy-only step (ffmpeg 7/8 can stall when a subtitle
     input shares the encode with a filter graph) */
  let subsFile = null;
  if (subsTracks.size) {
    const items = p.clips.filter(c => c.kind === 'text' && subsTracks.has(c.track)).sort((a, b) => a.start - b.start).map(c => ({ start: c.start, end: TL.end(c), text: c.text.s }));
    if (items.length) { subsFile = `${tmp}/subs.srt`; files[subsFile] = TL.toSRT(items); }
  }
  const finalOut = opts.outPath;
  const encOut = subsFile ? `${tmp}/av-nosubs.${container === 'webm' ? 'webm' : container}` : finalOut;

  const script = `${tmp}/graph.txt`;
  files[script] = fc.join(';\n');
  ff.push(...((caps.ffmpegMajor || 7) >= 7 ? ['-/filter_complex', script] : ['-filter_complex_script', script]));
  if (audioOnly) {
    if (!aout) { const e = new Error('no sound in the project'); e.code = 'noAudio'; throw e; }
    const fmt = opts.audioFormat || 'wav';
    ff.push('-map', '[aout]', ...({ mp3: ['-c:a', 'libmp3lame', '-b:a', '320k'], m4a: ['-c:a', 'aac', '-b:a', '320k'], flac: ['-c:a', 'flac'], opus: ['-c:a', 'libopus', '-b:a', '192k'] }[fmt] || ['-c:a', 'pcm_s24le']), '-ar', '48000', '-t', f6(total), '-map_metadata', '-1', opts.outPath);
    return { steps: [{ kind: 'ffmpeg', ffmpeg: ff, files }], encoder: fmt, enhance: false, expect: { frames: Math.max(1, Math.round(total * 50)), fps: 50, w: 0, h: 0, dur: total, audio: true, kfactor: 1, finalDur: total }, layers: 0, sounds: sounds.length };
  }
  ff.push('-map', '[vout]');
  if (aout) ff.push('-map', '[aout]');

  // encoder
  let enc;
  if (opts.intermediate) {
    enc = { name: 'libx264', tenBit: false };
    ff.push('-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p');
  } else {
    const hwAv1 = (caps.encoders || []).some(e => /^av1_(nvenc|amf|qsv)$/.test(e));
    const codec = container === 'webm' ? (out.codec === 'av1' && hwAv1 ? 'av1' : 'vp9') : (out.codec || 'h264');
    enc = pickEnc(codec, caps, !!out.tenBit);
    ff.push(...encArgs(enc, out, fps, W, H));
  }
  ff.push('-r', `${fn}/${fd}`, '-g', String(Math.round(fps * 2)));
  if (aout) {
    if (container === 'webm') ff.push('-c:a', 'libopus', '-b:a', '192k');
    else if (opts.intermediate) ff.push('-c:a', 'pcm_s16le');
    else ff.push('-c:a', 'aac', '-b:a', '320k');
    ff.push('-ar', '48000');
  }
  ff.push('-t', f6(total));
  if (!opts.intermediate) {
    ff.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
    if (container !== 'webm') ff.push('-movflags', '+faststart');
    ff.push('-map_metadata', '-1', '-metadata', 'encoder=7krh Studio');
  }
  ff.push(encOut);
  const frames = Math.max(1, Math.round(total * fps));
  const steps = [{ kind: 'ffmpeg', ffmpeg: ff, files }];
  if (subsFile) steps.push({ kind: 'ffmpeg', post: true, ffmpeg: [P.ffmpeg, '-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-i', encOut, '-i', subsFile, '-map', '0', '-map', '1:s', '-c', 'copy', '-c:s', container === 'webm' ? 'webvtt' : 'mov_text', '-metadata:s:s:0', 'language=ara', ...(container !== 'webm' ? ['-movflags', '+faststart'] : []), finalOut] });
  return {
    steps,
    encoder: enc.name, enhance: false,
    expect: { frames, fps, w: W, h: H, dur: total, audio: !!aout, kfactor: 1, finalDur: total },
    layers: layers.length, sounds: sounds.length,
  };
}
/* replace variable `name` with expression `by` (used to rewrite clip time u in terms of t or frame count) */
function substitute(e, name, by) {
  if (isNum(e)) return e;
  if (e.v) return e.v === name ? by : e;
  const [o, ...a] = e;
  return [o, ...a.map(x => substitute(x, name, by))];
}
const subst2 = (e, by) => substitute(e, 'u', by);
function gainExpr(p, c, u) {
  const t = TL.trackOf(p, c) || {};
  const tv = t.volume ?? 1, L = TL.len(c);
  let g = Array.isArray(c.kf && c.kf.vol) && c.kf.vol.length ? mul(kfExpr(c.kf.vol, 1, u), tv) : (c.volume ?? 1) * tv;
  if (c.fadeIn > 0) g = mul(g, clip01(div(u, c.fadeIn)));
  if (c.fadeOut > 0) g = mul(g, clip01(div(sub(L, u), c.fadeOut)));
  return g;
}

/* encoders: same choice + quality rules as the single-clip pipeline, plus VP9 for WebM and a bitrate mode */
function pickEnc(codec, caps, tenBit) {
  if (codec === 'vp9') return { name: (caps.encoders || []).includes('vp9_qsv') ? 'vp9_qsv' : 'libvpx-vp9', tenBit: false };
  return pipeline.pickEncoder(codec, caps, tenBit);
}
function encArgs(enc, out, fps, W, H) {
  const rate = out.rate || {};
  if (enc.name === 'libvpx-vp9') {
    const crf = { balanced: 34, high: 30, max: 26 }[out.quality || 'high'];
    return rate.mode === 'bitrate' ? ['-c:v', 'libvpx-vp9', '-b:v', rate.mbps + 'M', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p']
      : ['-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p'];
  }
  const a = pipeline.encoderArgs(enc, out.quality || 'high', fps, W, H);
  if (rate.mode !== 'bitrate' || !(rate.mbps > 0)) return a;
  return withBitrate(a, enc.name, +rate.mbps);
}
/* swap the constant-quality settings for a target bitrate (keeps preset, profile, pixel format) */
function withBitrate(args, name, mbps) {
  const a = args.slice();
  const drop = (k, n = 2) => { const i = a.indexOf(k); if (i >= 0) a.splice(i, n); };
  ['-cq', '-crf', '-qvbr_quality_level', '-global_quality', '-b:v', '-maxrate', '-bufsize'].forEach(k => drop(k));
  if (name.endsWith('_nvenc')) { const i = a.indexOf('-rc'); if (i >= 0) a[i + 1] = 'vbr'; }
  if (name.endsWith('_amf')) { const i = a.indexOf('-rc'); if (i >= 0) a[i + 1] = 'vbr_peak'; }
  a.push('-b:v', mbps + 'M', '-maxrate', Math.round(mbps * 1.5) + 'M', '-bufsize', Math.round(mbps * 2) + 'M');
  return a;
}
/* estimated file size (only meaningful in bitrate mode; quality mode depends on the picture) */
function estimateBytes(opts, dur, hasAudio) {
  const r = (opts.output || {}).rate || {};
  if (r.mode !== 'bitrate' || !(r.mbps > 0)) return null;
  return Math.round((r.mbps * 1e6 + (hasAudio ? 320e3 : 0)) / 8 * dur);
}

module.exports = { buildTimelinePlan, stateExpr, evalE, toFF, kfExpr, gainExpr, colorChain, withBitrate, estimateBytes, esc };
