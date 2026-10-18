'use strict';
/* 7krh Studio — platform delivery, ported one-to-one from the 7krh website tool "Original-quality upload"
   (krypton/index.html). Same rules, same ffmpeg commands, same header patch, same checks:

   - TikTok   : frame-rate disguise. Factor "auto" (Krypton rule: ×2, or ×6 at 110 fps and more, never reading
                above ~30 fps), "to30" (PATCH rule: exactly 30 fps), or a fixed ×2 / ×4 / ×6.
                Method "krypton" = remux with `-itsscale k` and stream copy; "patch" = divide the mvhd and every
                mdhd timescale by k directly in the MP4/MOV header. A re-encoded result always gets the header
                patch, as on the site. The new duration is verified afterwards.
   - Instagram, YouTube : no disguise, stream copy with +faststart.
   - "self" (normal file) : nothing extra.
   Pure planning functions + the header patcher (works on files, not on memory). */
const fs = require('fs');

/* ---------------------------------------------------------------- factor (site: factor()) */
function factor(fps, fx = 'auto', plat = 'tiktok') {
  if (plat !== 'tiktok') return 1;
  if (fx === 'auto') { const k = fps >= 110 ? 6 : 2; return fps / k > 30.5 ? Math.ceil(fps / 30) : k; }
  if (fx === 'to30') { if (!fps) return 2; let k = fps / 30; if (Math.abs(k - Math.round(k)) < 0.02 * k) k = Math.round(k); return k > 1 ? k : 1; }
  return +fx || 1;
}

/* ---------------------------------------------------------------- MP4 box reading (site code, Buffer based) */
const u32 = (m, p) => m[p] * 16777216 + (m[p + 1] << 16) + (m[p + 2] << 8) + m[p + 3];
const s4 = (m, p) => String.fromCharCode(m[p], m[p + 1], m[p + 2], m[p + 3]);
const set32 = (m, p, v) => { m[p] = v >>> 24 & 255; m[p + 1] = v >>> 16 & 255; m[p + 2] = v >>> 8 & 255; m[p + 3] = v & 255; };
function kids(m, s, e, cb) {
  for (let p = s; p + 8 <= e;) {
    let z = u32(m, p), h = 8;
    if (z === 1) { z = u32(m, p + 8) * 4294967296 + u32(m, p + 12); h = 16; } else if (z === 0) z = e - p;
    if (z < h || p + z > e) return;
    cb(s4(m, p + 4), p + h, p + z); p += z;
  }
}
function readAt(fd, pos, len) { const b = Buffer.alloc(len); let got = 0; while (got < len) { const n = fs.readSync(fd, b, got, len - got, pos + got); if (!n) break; got += n; } return b.subarray(0, got); }
function locateMoov(fd, size) {
  let pos = 0, first = true;
  while (pos + 8 <= size) {
    const h = readAt(fd, pos, 16); let z = u32(h, 0), hl = 8; const ty = s4(h, 4);
    if (first && !/^(ftyp|moov|mdat|free|skip|wide|pnot|uuid)$/.test(ty)) throw new Error('notMp4'); first = false;
    if (z === 1) { z = u32(h, 8) * 4294967296 + u32(h, 12); hl = 16; } else if (z === 0) z = size - pos;
    if (z < hl) throw new Error('notMp4');
    if (ty === 'moov') { if (z > 268435456) throw new Error('notMp4'); return { pos, size: z }; }
    pos += z;
  }
  throw new Error('notMp4');
}
function readMoov(m) {
  const r = { mv: null, tr: [] };
  kids(m, u32(m, 0) === 1 ? 16 : 8, m.length, (ty, cs, ce) => {
    if (ty === 'mvhd') r.mv = cs;
    else if (ty === 'trak') {
      const t = { md: null, hd: '', stts: null }; r.tr.push(t);
      kids(m, cs, ce, (ty, cs, ce) => {
        if (ty === 'mdia') kids(m, cs, ce, (ty, cs, ce) => {
          if (ty === 'mdhd') t.md = cs; else if (ty === 'hdlr') t.hd = s4(m, cs + 8);
          else if (ty === 'minf') kids(m, cs, ce, (ty, cs, ce) => { if (ty === 'stbl') kids(m, cs, ce, (ty, cs) => { if (ty === 'stts') t.stts = cs; }); });
        });
      });
    }
  });
  return r;
}
const hdrPos = (m, cs) => (m[cs] === 1 ? { ts: cs + 20, dur: cs + 24, big: 1 } : { ts: cs + 12, dur: cs + 16, big: 0 });
function durOf(m, cs) { const h = hdrPos(m, cs); return { ts: u32(m, h.ts), d: h.big ? u32(m, h.dur) * 4294967296 + u32(m, h.dur + 4) : u32(m, h.dur) }; }
function fpsOf(m, r) {
  const v = r.tr.find(t => t.hd === 'vide'); if (!v || v.md == null || v.stts == null) return 0;
  const ts = durOf(m, v.md).ts, c = u32(m, v.stts + 4); let n = 0, tot = 0;
  for (let i = 0; i < c; i++) { const p = v.stts + 8 + i * 8; if (p + 8 > m.length) break; const a = u32(m, p); n += a; tot += a * u32(m, p + 4); }
  return tot ? n * ts / tot : 0;
}
/* fps + duration straight from the MP4 header (site: probeMp4) */
function probeMp4(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const { pos, size } = locateMoov(fd, fs.fstatSync(fd).size);
    const m = readAt(fd, pos, size), r = readMoov(m); if (r.mv == null) return null;
    const mv = durOf(m, r.mv); return { fps: fpsOf(m, r), dur: mv.ts ? mv.d / mv.ts : 0 };
  } catch (e) { return null; } finally { fs.closeSync(fd); }
}
/* PATCH: copy `src` to `out` (unless they are the same file) and divide every timescale by k in place.
   Verified: the duration must really be multiplied by k (±2 %), as on the site. */
function patchTS(src, out, k) {
  if (src !== out) fs.copyFileSync(src, out);
  const fd = fs.openSync(out, 'r+');
  try {
    const { pos, size } = locateMoov(fd, fs.fstatSync(fd).size);
    const m = readAt(fd, pos, size), r = readMoov(m);
    if (r.mv == null || !r.tr.some(t => t.md != null)) throw new Error('notMp4');
    const d0 = durOf(m, r.mv);
    for (const cs of [r.mv, ...r.tr.map(t => t.md).filter(x => x != null)]) { const h = hdrPos(m, cs); set32(m, h.ts, Math.max(1, Math.round(u32(m, h.ts) / k))); }
    const d1 = durOf(m, r.mv), dur = d1.ts ? d1.d / d1.ts : 0;
    if (d0.ts && d0.d && Math.abs(dur / (d0.d / d0.ts) - k) / k > 0.02) throw new Error('notApplied');
    fs.writeSync(fd, m, 0, m.length, pos);
    return { dur, before: d0.ts ? d0.d / d0.ts : 0 };
  } finally { fs.closeSync(fd); }
}

/* ---------------------------------------------------------------- plans
   opts.platform: 'self'|'tiktok'|'instagram'|'youtube'; opts.fx: 'auto'|'to30'|'2'|'4'|'6'; opts.tech: 'krypton'|'patch'
   Returns steps understood by jobs.js: {kind:'ffmpeg'} {kind:'patch'} {kind:'move'} {kind:'verify'} */

/* "No re-encoding" mode — the site's copy path, step for step */
function copyPlan(input, outPath, info, opts, ffmpeg) {
  const plat = opts.platform || 'tiktok';
  const fps = info.fpsNum || 0;
  const k = factor(fps, opts.fx || 'auto', plat);
  const steps = [];
  if (plat === 'tiktok') {
    // site: lowFps ("to30" on a clip that is already 30 fps or less)
    if (k <= 1) { const e = new Error('lowFps'); e.code = 'lowFps'; throw e; }
    if (opts.tech === 'patch') {
      if (!/\.(mp4|mov|m4v)$/i.test(input)) { const e = new Error('notMp4'); e.code = 'notMp4'; throw e; }
      steps.push({ kind: 'patch', src: input, out: outPath, k });
    } else {
      steps.push({ kind: 'ffmpeg', ffmpeg: [ffmpeg, '-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-itsscale', String(k), '-i', input, '-c:v', 'copy', '-c:a', 'copy', outPath] });
    }
  } else {
    // Instagram / YouTube / normal file: plain copy, no disguise
    steps.push({ kind: 'ffmpeg', ffmpeg: [ffmpeg, '-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-i', input, '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart', outPath] });
  }
  steps.push({ kind: 'verify', file: outPath, expectDur: info.duration * (plat === 'tiktok' ? k : 1), tol: 0.05, w: info.w, h: info.h, audio: info.hasAudio });
  return { steps, k, method: plat === 'tiktok' ? (opts.tech === 'patch' ? 'patch' : 'krypton') : 'copy', finalDur: info.duration * (plat === 'tiktok' ? k : 1) };
}

/* After a re-encode: the site applies the disguise by editing the header of the encoded file */
function postEncode(encodedPath, outPath, fps, dur, opts) {
  const plat = opts.platform || 'self';
  const k = factor(fps, opts.fx || 'auto', plat);
  if (plat === 'tiktok' && k > 1) return { steps: [{ kind: 'patch', src: encodedPath, out: outPath, k, cleanup: encodedPath !== outPath }], k, finalDur: dur * k, method: 'patch' };
  if (encodedPath !== outPath) return { steps: [{ kind: 'move', from: encodedPath, to: outPath }], k: 1, finalDur: dur, method: 'none' };
  return { steps: [], k: 1, finalDur: dur, method: 'none' };
}

module.exports = { factor, probeMp4, patchTS, copyPlan, postEncode, locateMoov };
