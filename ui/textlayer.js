/* 7krh Studio — text layers. Titles and subtitles are drawn by Chromium's text engine (correct Arabic shaping,
   right-to-left and mixed-direction lines) into a transparent image. The preview draws that image and the export
   overlays the very same image, so text looks identical in both. */
(() => {
  'use strict';
  const FONTS = ['Segoe UI', 'Segoe UI Black', 'Tahoma', 'Arial', 'Bahnschrift', 'Calibri', 'Sakkal Majalla', 'Traditional Arabic', 'Simplified Arabic', 'Arabic Typesetting', 'Aldhabi', 'Microsoft Uighur', 'Impact', 'Georgia', 'Times New Roman', 'Courier New'];
  const DEF = { s: 'نص جديد', font: 'Segoe UI', size: 96, color: '#ffffff', weight: 800, italic: false, stroke: '#000000', strokeW: 0, shadow: 40, bg: '', bgAlpha: 0.6, align: 'center', lineH: 1.22 };
  const PRESETS = [
    { key: 'title', s: 'عنوان', size: 120, weight: 800, shadow: 50 },
    { key: 'sub', s: 'ترجمة نصية', size: 64, weight: 700, strokeW: 6, shadow: 0, sub: true },
    { key: 'box', s: 'نص مميز', size: 72, weight: 800, bg: '#ff3d8b', bgAlpha: 0.92, shadow: 0 },
    { key: 'outline', s: 'OUTLINE', size: 110, weight: 800, color: '#ffffff', stroke: '#ff3d8b', strokeW: 10, shadow: 0 },
    { key: 'caption', s: 'تعليق صغير', size: 48, weight: 600, bg: '#000000', bgAlpha: 0.55, shadow: 0 },
  ];
  const isRTL = s => /[֐-ࣿיִ-﷿ﹰ-﻿]/.test(s) && !/^[\s\dA-Za-z]/.test(s.trim()) || /^[\s]*[֐-ࣿ]/.test(s);
  const hexA = (hex, a) => { const m = String(hex || '#000').replace('#', ''); const n = parseInt(m.length === 3 ? m.split('').map(x => x + x).join('') : m.slice(0, 6), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };

  /* draws the text; returns { canvas, w, h } with w/h in project pixels (canvas is w*scale × h*scale) */
  function draw(text, scale = 1) {
    const o = { ...DEF, ...(text || {}) };
    const lines = String(o.s || ' ').split(/\r?\n/);
    const size = Math.max(4, o.size) * scale;
    const font = `${o.italic ? 'italic ' : ''}${o.weight || 700} ${size}px "${o.font}", "Segoe UI", Tahoma, sans-serif`;
    const m = document.createElement('canvas').getContext('2d');
    m.font = font;
    const rtl = isRTL(o.s || '');
    const widths = lines.map(l => { m.direction = isRTL(l) || rtl ? 'rtl' : 'ltr'; return m.measureText(l || ' ').width; });
    const lineH = size * (o.lineH || 1.22);
    const sw = (o.strokeW || 0) * scale, sh = (o.shadow || 0) / 100;
    const padX = Math.ceil(sw + size * (o.bg ? 0.35 : 0.08) + sh * size * 0.25), padY = Math.ceil(sw + size * (o.bg ? 0.18 : 0.06) + sh * size * 0.25);
    const W = Math.ceil(Math.max(...widths) + padX * 2), H = Math.ceil(lineH * lines.length + padY * 2);
    const c = document.createElement('canvas'); c.width = Math.max(2, W); c.height = Math.max(2, H);
    const x = c.getContext('2d');
    if (o.bg) { x.fillStyle = hexA(o.bg, o.bgAlpha ?? 0.6); const r = Math.min(size * 0.25, H / 2); x.beginPath(); x.roundRect(0, 0, W, H, r); x.fill(); }
    x.font = font; x.textBaseline = 'middle'; x.lineJoin = 'round'; x.miterLimit = 2;
    lines.forEach((l, i) => {
      const dir = isRTL(l) || (rtl && !/[A-Za-z]/.test(l)) ? 'rtl' : 'ltr';
      x.direction = dir;
      const al = o.align === 'center' ? 'center' : (o.align === 'start') === (dir === 'ltr') ? 'left' : 'right';
      x.textAlign = al;
      const px = al === 'center' ? W / 2 : al === 'left' ? padX : W - padX, py = padY + lineH * (i + 0.5);
      if (sh > 0) { x.save(); x.shadowColor = `rgba(0,0,0,${Math.min(0.9, 0.35 + sh * 0.5)})`; x.shadowBlur = size * 0.18 * sh + 2; x.shadowOffsetY = size * 0.05 * sh; x.fillStyle = o.color; x.fillText(l, px, py); x.restore(); }
      if (sw > 0) { x.strokeStyle = o.stroke; x.lineWidth = sw * 2; x.strokeText(l, px, py); }
      x.fillStyle = o.color; x.fillText(l, px, py);
    });
    return { canvas: c, w: W / scale, h: H / scale };
  }

  /* updates clip.text.pw/ph and returns an Image for the preview */
  const cache = new Map();
  function image(clip) {
    const key = JSON.stringify(clip.text);
    let e = cache.get(clip.id);
    if (e && e.key === key) return e.img;
    const r = draw(clip.text, 1);
    clip.text.pw = Math.round(r.w); clip.text.ph = Math.round(r.h);
    const img = new Image(); img.src = r.canvas.toDataURL('image/png');
    cache.set(clip.id, { key, img, canvas: r.canvas });
    return img;
  }
  function canvasOf(clip) { image(clip); return cache.get(clip.id).canvas; }
  /* writes the PNG for the export at the output scale (sharp text at 4K) */
  async function toFile(clip, scale) {
    image(clip); // keeps pw/ph from the preview so the layout is exactly the one on screen
    const r = draw(clip.text, scale);
    const b64 = r.canvas.toDataURL('image/png').split(',')[1];
    return window.studio.writeTmp(`text-${clip.id}-${Date.now()}.png`, b64);
  }
  window.TextLayer = { FONTS, DEF, PRESETS, draw, image, canvasOf, toFile, isRTL };
})();
