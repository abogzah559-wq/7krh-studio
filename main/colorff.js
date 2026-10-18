'use strict';
/* Colour adjustments as ffmpeg filters — the exact maths of TL.colorParams / the editor's SVG preview filter
   (per-channel lookup for brightness, contrast, gamma; W3C saturation matrix; 3x3 sharpen kernel). */
const TL = require('../ui/core/tl-core.js');
const f6 = v => { const s = (Math.round(v * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, ''); return s === '-0' ? '0' : s; };

function colorChain(adj) {
  if (TL.colorIsIdentity(adj)) return [];
  const k = TL.colorParams(adj), out = [];
  if (k.bm !== 1 || k.ck !== 1 || k.ge !== 1) {
    const e = `255*pow(clip((clip(val/255*${f6(k.bm)},0,1)-0.5)*${f6(k.ck)}+0.5,0,1),${f6(k.ge)})`;
    out.push(`lut=c0='${e}':c1='${e}':c2='${e}'`);
  }
  if (k.sa !== 1) {
    const m = TL.satMatrix(k.sa).map(f6);
    out.push(`colorchannelmixer=rr=${m[0]}:rg=${m[1]}:rb=${m[2]}:gr=${m[3]}:gg=${m[4]}:gb=${m[5]}:br=${m[6]}:bg=${m[7]}:bb=${m[8]}`);
  }
  if (k.sh > 0) {
    const kk = TL.sharpKernel(k.sh).map(f6).join(' ');
    out.push(`convolution=0m='${kk}':1m='${kk}':2m='${kk}':0rdiv=1:1rdiv=1:2rdiv=1:0bias=0:1bias=0:2bias=0`);
  }
  return out;
}

/* YUV→RGB matrix of a source: SD → BT.601, UHD/HDR10 → BT.2020, everything else BT.709 */
function matrixOf(m) {
  const cs = (m && m.colorSpace) || '';
  if (/2020/.test(cs)) return 'bt2020';
  if (/470bg|170m|601/.test(cs)) return 'bt601';
  if (!cs && m && m.h && Math.min(m.w, m.h) < 600) return 'bt601';
  return 'bt709';
}

/* the same adjustments for a plain YUV video chain: to RGB with the right matrix, adjust, back to BT.709 */
function yuvColorChain(adj, media) {
  const c = colorChain(adj);
  if (!c.length) return [];
  return [`scale=in_color_matrix=${matrixOf(media)}:in_range=auto`, 'format=gbrp', ...c, 'scale=out_color_matrix=bt709:out_range=tv'];
}

module.exports = { colorChain, yuvColorChain, matrixOf, f6 };
