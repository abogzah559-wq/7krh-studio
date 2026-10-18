/* 7krh Studio — timeline core, shared by the editor preview (browser) and the export renderer (Node).
   Everything that decides WHERE a clip is, HOW BIG, HOW TRANSPARENT and WHAT COLOUR lives here, once,
   so the preview and the exported file are computed by the same code.

   Project (saved as JSON, *.7krh):
   { v, name, canvas:{w,h,fps,bg}, tracks:[{id,kind:'video'|'audio'|'text',name,mute,hidden,volume,duck,voice}],
     clips:[{ id, track, kind:'video'|'image'|'audio'|'text', src, in, out, start, speed, reverse,
              volume, mute, fadeIn, fadeOut, denoise:'off'|'light'|'ai',
              fit:'contain'|'cover'|'none', tf:{x,y,s,r,o}, kf:{x:[{t,v}],y,s,r,o,vol},
              adj:{b,c,s,g,sh}, lut, stab, tin:{type,dur}, tout:{type,dur},
              text:{s, font, size, color, stroke, strokeW, shadow, bg, align, weight, png, pw, ph} }],
     media:{ [src]: {w,h,rotation,fps,duration,hasAudio,kind} } }
   Times: clip.in/out are SOURCE seconds; clip.start is TIMELINE seconds; length on the timeline = (out-in)/speed.
   Transform: x,y = centre offset as a fraction of the canvas (0 = centred), s = scale of the fitted size,
   r = rotation in degrees (clockwise), o = opacity 0..1. Keyframe times are seconds from the clip start. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TL = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VERSION = 1;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const num = (v, d) => (Number.isFinite(+v) ? +v : d);
  const uid = (p = 'c') => p + Math.random().toString(36).slice(2, 9);
  const round = (v, n = 6) => Math.round(v * 10 ** n) / 10 ** n;

  /* ---------------------------------------------------------------- project */
  const PRESETS = {
    landscape: { w: 1920, h: 1080, fps: 30 }, landscape60: { w: 1920, h: 1080, fps: 60 },
    vertical: { w: 1080, h: 1920, fps: 30 }, vertical60: { w: 1080, h: 1920, fps: 60 },
    square: { w: 1080, h: 1080, fps: 30 }, portrait: { w: 1080, h: 1350, fps: 30 },
    uhd: { w: 3840, h: 2160, fps: 30 }, qhd: { w: 2560, h: 1440, fps: 60 },
  };
  function newProject(preset = 'landscape', name = 'Untitled') {
    const c = PRESETS[preset] || PRESETS.landscape;
    return {
      v: VERSION, name, canvas: { w: c.w, h: c.h, fps: c.fps, bg: '#000000' },
      tracks: [
        { id: 'T1', kind: 'text', name: 'Text 1', mute: false, hidden: false },
        { id: 'V2', kind: 'video', name: 'Overlay', mute: false, hidden: false, volume: 1 },
        { id: 'V1', kind: 'video', name: 'Main', mute: false, hidden: false, volume: 1 },
        { id: 'A1', kind: 'audio', name: 'Music', mute: false, hidden: false, volume: 1, duck: false },
        { id: 'A2', kind: 'audio', name: 'Voice', mute: false, hidden: false, volume: 1, voice: true },
      ],
      clips: [], media: {},
    };
  }
  /* tracks are listed top → bottom; visually the top track is drawn last (on top) */
  function drawOrder(p) {
    return p.tracks.filter(t => t.kind !== 'audio').slice().reverse();
  }
  function migrate(p) {
    if (!p || typeof p !== 'object') throw new Error('not a 7krh project');
    p.v = p.v || 1;
    p.canvas = { w: 1920, h: 1080, fps: 30, bg: '#000000', ...(p.canvas || {}) };
    p.tracks = Array.isArray(p.tracks) ? p.tracks : [];
    p.clips = Array.isArray(p.clips) ? p.clips.map(normClip) : [];
    p.media = p.media || {};
    return p;
  }
  function normClip(c) {
    const o = { id: c.id || uid(), speed: 1, volume: 1, mute: false, fadeIn: 0, fadeOut: 0, denoise: 'off', fit: c.kind === 'text' ? 'none' : 'contain', reverse: false, ...c };
    o.tf = { x: 0, y: 0, s: 1, r: 0, o: 1, ...(c.tf || {}) };
    o.kf = { ...(c.kf || {}) };
    o.adj = { b: 0, c: 0, s: 0, g: 0, sh: 0, ...(c.adj || {}) };
    o.speed = clamp(num(o.speed, 1), 0.1, 16);
    return o;
  }
  const len = c => Math.max(0, (num(c.out, 0) - num(c.in, 0)) / (c.speed || 1));
  const end = c => c.start + len(c);
  function duration(p) { return p.clips.reduce((m, c) => Math.max(m, end(c)), 0); }
  const trackOf = (p, c) => p.tracks.find(t => t.id === c.track);
  const isVisual = c => c.kind === 'video' || c.kind === 'image' || c.kind === 'text';
  const hasSound = (p, c) => (c.kind === 'audio' || (c.kind === 'video' && (p.media[c.src] || {}).hasAudio)) && !c.mute && !(trackOf(p, c) || {}).mute && !c.reverseMuted;

  /* source time shown at timeline time t (clip must contain t) */
  function srcTime(c, t) {
    const u = clamp(t - c.start, 0, len(c));
    return c.reverse ? c.out - u * c.speed : c.in + u * c.speed;
  }

  /* ---------------------------------------------------------------- editing (mutates the project; the editor snapshots it for undo first) */
  function split(p, id, t) {
    const c = p.clips.find(x => x.id === id); if (!c) return null;
    if (t <= c.start + 0.04 || t >= end(c) - 0.04) return null;
    const cut = c.reverse ? c.out - (t - c.start) * c.speed : c.in + (t - c.start) * c.speed;
    const a = { ...c, kf: shiftKf(c.kf, 0, t - c.start), tout: null };
    const b = { ...JSON.parse(JSON.stringify(c)), id: uid(), start: t, kf: shiftKf(c.kf, t - c.start, Infinity), tin: null };
    if (c.reverse) { a.in = cut; b.out = cut; } else { a.out = cut; b.in = cut; }
    a.fadeOut = 0; b.fadeIn = 0;
    Object.assign(c, a); p.clips.push(b);
    return b;
  }
  function shiftKf(kf, from, to) {
    const o = {};
    for (const [k, arr] of Object.entries(kf || {})) {
      if (!Array.isArray(arr) || !arr.length) continue;
      const vs = arr.filter(x => x.t >= from - 1e-6 && x.t <= to + 1e-6).map(x => ({ t: round(x.t - from), v: x.v }));
      if (vs.length) o[k] = vs;
    }
    return o;
  }
  /* closes the gaps on a track (ripple) */
  function ripple(p, trackId) {
    let t = 0;
    p.clips.filter(c => c.track === trackId).sort((a, b) => a.start - b.start).forEach(c => {
      const overlap = c.tin && c.tin.dur && t > 0 ? c.tin.dur : 0;
      c.start = round(Math.max(0, t - overlap)); t = end(c);
    });
  }
  /* snaps a time to clip edges / playhead within `tol` seconds */
  function snap(p, t, tol, skipId, extra = []) {
    let best = t, d = tol;
    const pts = [0, ...extra];
    p.clips.forEach(c => { if (c.id !== skipId) pts.push(c.start, end(c)); });
    pts.forEach(x => { const e = Math.abs(x - t); if (e < d) { d = e; best = x; } });
    return best;
  }

  /* ---------------------------------------------------------------- animation */
  const ease = p => p * p * (3 - 2 * p);
  function kfValue(arr, u, dflt) {
    if (!Array.isArray(arr) || !arr.length) return dflt;
    const a = arr.slice().sort((x, y) => x.t - y.t);
    if (u <= a[0].t) return a[0].v;
    for (let i = 1; i < a.length; i++) {
      if (u <= a[i].t) { const k = (u - a[i - 1].t) / Math.max(1e-9, a[i].t - a[i - 1].t); return a[i - 1].v + (a[i].v - a[i - 1].v) * k; }
    }
    return a[a.length - 1].v;
  }
  /* transitions: in = first `dur` seconds of the clip, out = last `dur` seconds */
  const TRANSITIONS = ['dissolve', 'fadeblack', 'slideleft', 'slideright', 'slideup', 'slidedown', 'zoom'];
  function transState(c, u) {
    // returns multipliers/offsets for time u (seconds into the clip)
    const r = { o: 1, dx: 0, dy: 0, s: 1, black: 0 };
    const L = len(c);
    const apply = (tr, p, dir) => {
      if (!tr || !tr.type || !(tr.dur > 0)) return;
      if (p >= 1) return;
      const e = ease(clamp(p, 0, 1)), q = 1 - e;
      switch (tr.type) {
        case 'dissolve': r.o *= clamp(p, 0, 1); break;
        case 'fadeblack': r.black = Math.max(r.black, 1 - clamp(p, 0, 1)); break;
        case 'slideleft': r.dx += (dir > 0 ? 1 : -1) * q; break;
        case 'slideright': r.dx += (dir > 0 ? -1 : 1) * q; break;
        case 'slideup': r.dy += (dir > 0 ? 1 : -1) * q; break;
        case 'slidedown': r.dy += (dir > 0 ? -1 : 1) * q; break;
        case 'zoom': r.s *= 0.6 + 0.4 * e; r.o *= clamp(p, 0, 1); break;
        default: break;
      }
    };
    if (c.tin) apply(c.tin, u / c.tin.dur, 1);
    if (c.tout) apply(c.tout, (L - u) / c.tout.dur, -1);
    return r;
  }
  /* full visual state of a clip at clip-local time u */
  function stateAt(c, u) {
    const tf = c.tf || {}, kf = c.kf || {};
    const tr = transState(c, u);
    return {
      x: kfValue(kf.x, u, num(tf.x, 0)) + tr.dx,
      y: kfValue(kf.y, u, num(tf.y, 0)) + tr.dy,
      s: kfValue(kf.s, u, num(tf.s, 1)) * tr.s,
      r: kfValue(kf.r, u, num(tf.r, 0)),
      o: clamp(kfValue(kf.o, u, num(tf.o, 1)) * tr.o, 0, 1),
      black: tr.black,
    };
  }
  /* is anything about the geometry animated? (decides the static vs. animated render path) */
  const SLIDES = /^slide|^zoom/;
  function animated(c) {
    const kf = c.kf || {};
    const k = n => Array.isArray(kf[n]) && kf[n].length > 1 && kf[n].some(x => x.v !== kf[n][0].v);
    return {
      pos: k('x') || k('y') || !!(c.tin && /^slide/.test(c.tin.type)) || !!(c.tout && /^slide/.test(c.tout.type)),
      scale: k('s') || !!(c.tin && c.tin.type === 'zoom') || !!(c.tout && c.tout.type === 'zoom'),
      rot: k('r'),
      alpha: k('o') || !!(c.tin && /dissolve|zoom/.test(c.tin.type)) || !!(c.tout && /dissolve|zoom/.test(c.tout.type)),
      black: !!(c.tin && c.tin.type === 'fadeblack') || !!(c.tout && c.tout.type === 'fadeblack'),
    };
  }

  /* ---------------------------------------------------------------- geometry */
  /* natural (upright) size of a visual clip in pixels */
  function natural(p, c) {
    if (c.kind === 'text') return [num(c.text && c.text.pw, 10), num(c.text && c.text.ph, 10)];
    const m = p.media[c.src] || {};
    const r = ((num(m.rotation, 0) % 360) + 360) % 360;
    return r === 90 || r === 270 ? [m.h || 0, m.w || 0] : [m.w || 0, m.h || 0];
  }
  /* fitted size before the clip's own scale */
  function fitted(p, c) {
    const [iw, ih] = natural(p, c), W = p.canvas.w, H = p.canvas.h;
    if (!iw || !ih) return [W, H];
    if (c.fit === 'none') return [iw, ih];
    const k = c.fit === 'cover' ? Math.max(W / iw, H / ih) : Math.min(W / iw, H / ih);
    return [iw * k, ih * k];
  }
  /* rectangle (centre, size, rotation) in canvas pixels */
  function rect(p, c, st) {
    const [fw, fh] = fitted(p, c);
    return { cx: p.canvas.w / 2 + st.x * p.canvas.w, cy: p.canvas.h / 2 + st.y * p.canvas.h, w: fw * st.s, h: fh * st.s, r: st.r };
  }

  /* ---------------------------------------------------------------- colour (identical in preview + export)
     b, c, g, s in -100..100, sh 0..100. Applied per channel in sRGB, in this order, clamped after each step:
       1) brightness  v *= 1 + b/100            (0..2x)
       2) contrast    v = (v - .5) * k + .5,     k = 1 + c/100 (c<0) or 1 + 2c/100 (c>0)
       3) gamma       v = v ^ e,  e = 1 / (1 + 0.8 g/100) for g >= 0, 1 - 0.8 g/100 for g < 0 (g>0 brightens mid-tones)
       4) saturation  W3C saturate matrix with amount 1 + s/100
       5) sharpen     3x3 kernel [0,-a,0,-a,1+4a,-a,0,-a,0], a = sh/100 * 0.6
     The preview draws this with an SVG filter, the export with lutrgb + colorchannelmixer + convolution. */
  const colorParams = adj => {
    const a = adj || {};
    const b = clamp(num(a.b, 0), -100, 100), c = clamp(num(a.c, 0), -100, 100), g = clamp(num(a.g, 0), -100, 100);
    const s = clamp(num(a.s, 0), -100, 100), sh = clamp(num(a.sh, 0), 0, 100);
    return { bm: 1 + b / 100, ck: c < 0 ? 1 + c / 100 : 1 + 2 * c / 100, ge: g >= 0 ? 1 / (1 + g / 100 * 0.8) : 1 - g / 100 * 0.8, sa: 1 + s / 100, sh: sh / 100 * 0.6 };
  };
  const colorIsIdentity = adj => { const k = colorParams(adj); return k.bm === 1 && k.ck === 1 && k.ge === 1 && k.sa === 1 && !k.sh; };
  /* channel transfer for brightness + contrast + gamma (one lookup table) */
  function transfer(v, k) {
    v = clamp(v * k.bm, 0, 1);
    v = clamp((v - 0.5) * k.ck + 0.5, 0, 1);
    v = Math.pow(v, k.ge);
    return v;
  }
  /* W3C feColorMatrix type="saturate" */
  function satMatrix(s) {
    return [
      0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
      0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
      0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
    ];
  }
  function sharpKernel(a) { return [0, -a, 0, -a, 1 + 4 * a, -a, 0, -a, 0]; }

  /* ---------------------------------------------------------------- audio */
  /* gain of a clip at clip-local time u (fades, keyframes, clip + track volume), linear */
  function gainAt(p, c, u) {
    const t = trackOf(p, c) || {};
    let g = num(c.volume, 1) * num(t.volume, 1);
    if (Array.isArray(c.kf && c.kf.vol) && c.kf.vol.length) g = kfValue(c.kf.vol, u, 1) * num(t.volume, 1);
    const L = len(c);
    if (c.fadeIn > 0 && u < c.fadeIn) g *= u / c.fadeIn;
    if (c.fadeOut > 0 && u > L - c.fadeOut) g *= Math.max(0, (L - u) / c.fadeOut);
    return Math.max(0, g);
  }

  /* ---------------------------------------------------------------- subtitles */
  function parseTime(s) {
    const m = String(s).trim().match(/(?:(\d+):)?(\d+):(\d+)[,.](\d+)/);
    if (!m) return NaN;
    return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+('0.' + m[4]));
  }
  function parseSRT(txt) {
    const out = [];
    String(txt).replace(/\r/g, '').split(/\n{2,}/).forEach(b => {
      const L = b.split('\n').filter(x => x.trim() !== '');
      const i = L.findIndex(x => /-->/.test(x)); if (i < 0) return;
      const [a, z] = L[i].split('-->');
      const s = parseTime(a), e = parseTime(z);
      const text = L.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').trim();
      if (isFinite(s) && isFinite(e) && e > s && text) out.push({ start: s, end: e, text });
    });
    return out;
  }
  function parseASS(txt) {
    const out = [];
    let fmt = null;
    String(txt).replace(/\r/g, '').split('\n').forEach(l => {
      if (/^Format:/i.test(l) && fmt === null && /Start/i.test(l) && /Text/i.test(l)) fmt = l.slice(7).split(',').map(x => x.trim().toLowerCase());
      if (!/^Dialogue:/i.test(l)) return;
      const f = fmt || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
      const parts = l.slice(9).split(','); const head = parts.slice(0, f.length - 1), text = parts.slice(f.length - 1).join(',');
      const s = parseTime(head[f.indexOf('start')]), e = parseTime(head[f.indexOf('end')]);
      const clean = text.replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/\\h/g, ' ').trim();
      if (isFinite(s) && isFinite(e) && e > s && clean) out.push({ start: s, end: e, text: clean });
    });
    return out;
  }
  const fmtSrtTime = t => { t = Math.max(0, t); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = Math.floor(t % 60), ms = Math.round((t - Math.floor(t)) * 1000); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(Math.min(999, ms)).padStart(3, '0')}`; };
  function toSRT(items) {
    return items.map((x, i) => `${i + 1}\n${fmtSrtTime(x.start)} --> ${fmtSrtTime(x.end)}\n${x.text}\n`).join('\n');
  }
  function subtitleItems(p, trackId) {
    return p.clips.filter(c => c.kind === 'text' && (!trackId || c.track === trackId)).sort((a, b) => a.start - b.start)
      .map(c => ({ start: c.start, end: end(c), text: (c.text && c.text.s) || '' })).filter(x => x.text);
  }

  /* ---------------------------------------------------------------- checks before export */
  function validate(p) {
    const errs = [];
    if (!p.clips.length) errs.push('empty');
    p.clips.forEach(c => {
      if (c.kind !== 'text' && !p.media[c.src]) errs.push('missing:' + c.src);
      if (len(c) <= 0) errs.push('zero:' + c.id);
      if (c.kind === 'text' && !(c.text && c.text.png)) errs.push('textimg:' + c.id);
    });
    return errs;
  }

  return {
    VERSION, PRESETS, TRANSITIONS, newProject, migrate, normClip, uid, len, end, duration, drawOrder, trackOf, isVisual, hasSound,
    srcTime, split, ripple, snap, shiftKf, kfValue, ease, transState, stateAt, animated, natural, fitted, rect,
    colorParams, colorIsIdentity, transfer, satMatrix, sharpKernel, gainAt, parseSRT, parseASS, toSRT, subtitleItems, fmtSrtTime, validate, clamp,
  };
});
