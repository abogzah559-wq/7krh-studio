'use strict';
/* PATCH technique (same as the site's Original-Quality tool): no remux, no re-encode.
   Divides the movie (mvhd) and every track (mdhd) timescale by k, so the file reports a k× longer duration
   and a k× lower frame rate while every sample stays byte-identical. Works on MP4 / MOV / M4V. */
const fs = require('fs');

const u32 = (m, p) => m[p] * 16777216 + (m[p + 1] << 16) + (m[p + 2] << 8) + m[p + 3];
const s4 = (m, p) => String.fromCharCode(m[p], m[p + 1], m[p + 2], m[p + 3]);
const set32 = (m, p, v) => { m[p] = (v >>> 24) & 255; m[p + 1] = (v >>> 16) & 255; m[p + 2] = (v >>> 8) & 255; m[p + 3] = v & 255; };

function kids(m, s, e, cb) {
  for (let p = s; p + 8 <= e;) {
    let z = u32(m, p), h = 8;
    if (z === 1) { z = u32(m, p + 8) * 4294967296 + u32(m, p + 12); h = 16; } else if (z === 0) z = e - p;
    if (z < h || p + z > e) return;
    cb(s4(m, p + 4), p + h, p + z);
    p += z;
  }
}

function readAt(fd, pos, len) { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return b.subarray(0, n); }

/* finds the top-level moov box without loading the file */
function locateMoov(fd, size) {
  let pos = 0, first = true;
  while (pos + 8 <= size) {
    const h = readAt(fd, pos, 16);
    let z = u32(h, 0), hl = 8; const ty = s4(h, 4);
    if (first && !/^(ftyp|moov|mdat|free|skip|wide|pnot|uuid)$/.test(ty)) throw new Error('notMp4');
    first = false;
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
      kids(m, cs, ce, (ty2, cs2, ce2) => {
        if (ty2 === 'mdia') kids(m, cs2, ce2, (ty3, cs3, ce3) => {
          if (ty3 === 'mdhd') t.md = cs3; else if (ty3 === 'hdlr') t.hd = s4(m, cs3 + 8);
          else if (ty3 === 'minf') kids(m, cs3, ce3, (ty4, cs4, ce4) => { if (ty4 === 'stbl') kids(m, cs4, ce4, (ty5, cs5) => { if (ty5 === 'stts') t.stts = cs5; }); });
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

/* { fps, dur } straight from the container header (no ffprobe needed) */
function probe(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const { pos, size } = locateMoov(fd, fs.fstatSync(fd).size);
    const m = readAt(fd, pos, size), r = readMoov(m);
    if (r.mv == null) return null;
    const mv = durOf(m, r.mv);
    return { fps: fpsOf(m, r), dur: mv.ts ? mv.d / mv.ts : 0 };
  } finally { fs.closeSync(fd); }
}

/* copies src → out and rewrites only the moov timescales. Returns the new duration. */
function patch(src, out, k) {
  if (!(k > 1)) throw new Error('lowFps');
  if (src !== out) fs.copyFileSync(src, out);
  const fd = fs.openSync(out, 'r+');
  try {
    const { pos, size } = locateMoov(fd, fs.fstatSync(fd).size);
    const m = readAt(fd, pos, size), r = readMoov(m);
    if (r.mv == null || !r.tr.some(t => t.md != null)) throw new Error('notMp4');
    const d0 = durOf(m, r.mv);
    for (const cs of [r.mv, ...r.tr.map(t => t.md).filter(x => x != null)]) {
      const h = hdrPos(m, cs); set32(m, h.ts, Math.max(1, Math.round(u32(m, h.ts) / k)));
    }
    const d1 = durOf(m, r.mv), dur = d1.ts ? d1.d / d1.ts : 0;
    // verify: the duration must really be multiplied (same 2% rule as the site)
    if (d0.ts && d0.d && Math.abs(dur / (d0.d / d0.ts) - k) / k > 0.02) throw new Error('notApplied');
    fs.writeSync(fd, m, 0, m.length, pos);
    return { dur, before: d0.ts ? d0.d / d0.ts : 0 };
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) {}
    if (src !== out) try { fs.unlinkSync(out); } catch (_) {}
    throw e;
  } finally { try { fs.closeSync(fd); } catch (_) {} }
}

module.exports = { probe, patch, locateMoov };
