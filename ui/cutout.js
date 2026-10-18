/* 7krh Studio — background remover: native BiRefNet mask + brush touch-ups + backgrounds + export */
(() => {
  'use strict';
  const { $, $$, S, t } = App;
  const items = []; let cur = -1, mode = 'view', split = 0;
  const opt = { smart: true, bg: 'none', color: '#ffffff', blur: 45, sharp: 0, clean: 10, crop: false, fmt: 'png' };
  const COLORS = ['#ffffff', '#000000', '#f2f2f2', '#ff4f9a', '#ff8a3d', '#ffd84f', '#4fe3a2', '#4fa8ff', '#1e3a8a', '#7c3aed'];
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const cx = c => c.getContext('2d');
  const view = $('#bgCv'), disp = $('#bgCanvas'), curEl = $('#bgCur');

  /* per-image working state (only the selected one keeps big buffers) */
  let W = 0, H = 0, MW = 0, MH = 0, srcImg = null, raw = null, baseC = null, addC = null, subC = null, addS = null, subS = null, gray = null, strokes = [], bgImg = null, blurC = null, blurKey = '';

  async function add(paths) {
    for (const p of paths) {
      if (items.some(x => x.src === p)) continue;
      items.push({ src: p, name: p.split(/[\\/]/).pop(), state: 'new' });
    }
    render(); if (cur < 0 && items.length) select(0);
    S.warmImage().catch(() => {});
    processQueue();
  }
  let qRunning = false;
  async function processQueue() {
    if (qRunning) return; qRunning = true;
    for (const it of items) {
      if (it.state !== 'new') continue;
      it.state = 'run'; render();
      if (items[cur] === it) $('#bgBusy').hidden = false;
      try { const r = await S.removeBg(it.src); Object.assign(it, { state: 'ready', mask: r.mask, ms: r.ms, w: r.w, h: r.h }); }
      catch (e) { it.state = 'err'; it.err = String(e.message || e).split('\n')[0].slice(0, 120); App.toast(it.name + ': ' + it.err, 'err', 9000); }
      render();
      if (items[cur] === it) select(cur);
    }
    qRunning = false;
    $('#bgSaveAll').disabled = !items.some(x => x.state === 'ready');
  }
  function render() {
    const L = $('#bgList'); L.innerHTML = '';
    items.forEach((it, i) => {
      const d = document.createElement('div'); d.className = 'fitem' + (i === cur ? ' on' : '');
      const im = document.createElement('img'); im.src = App.fileUrl(it.src); im.loading = 'lazy';
      const tx = document.createElement('div'); const b = document.createElement('b'); b.textContent = it.name;
      const sm = document.createElement('small');
      sm.textContent = it.state === 'ready' ? `✓ ${(it.ms / 1000).toFixed(1)}s${it.saved ? ' · ' + t('saved') : ''}` : it.state === 'run' ? '…' : it.state === 'err' ? '✕ ' + it.err : '';
      if (it.state === 'ready') sm.className = 'ok'; if (it.state === 'err') sm.className = 'err';
      tx.append(b, sm); d.append(im, tx); d.onclick = () => select(i); L.appendChild(d);
    });
    $('#bgEmpty').hidden = !!items.length;
  }
  const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });

  async function select(i) {
    cur = i; render();
    const it = items[i]; if (!it) return;
    $('#bgBusy').hidden = it.state !== 'run' && it.state !== 'new';
    srcImg = await loadImg(App.fileUrl(it.src));
    W = srcImg.naturalWidth; H = srcImg.naturalHeight;
    const k = Math.min(1, 2048 / Math.max(W, H)); MW = Math.max(1, Math.round(W * k)); MH = Math.max(1, Math.round(H * k));
    blurC = null; blurKey = '';
    if (it.state !== 'ready') { baseC = null; disp.hidden = false; draw(); $('#bgSave').disabled = true; return; }
    const m = await loadImg(App.fileUrl(it.mask));
    const mc = mk(m.naturalWidth, m.naturalHeight); cx(mc).drawImage(m, 0, 0);
    // full-resolution matte (red channel of the grey mask)
    const d = cx(mc).getImageData(0, 0, mc.width, mc.height).data;
    raw = new Uint8Array(mc.width * mc.height); for (let p = 0, j = 0; p < raw.length; p++, j += 4) raw[p] = d[j];
    raw.w = mc.width; raw.h = mc.height;
    baseC = mk(MW, MH); addC = mk(MW, MH); subC = mk(MW, MH); addS = mk(MW, MH); subS = mk(MW, MH);
    { const g = mk(MW, MH), gx = cx(g); gx.imageSmoothingQuality = 'high'; gx.drawImage(srcImg, 0, 0, MW, MH); const d = gx.getImageData(0, 0, MW, MH).data;
      gray = new Float32Array(MW * MH); for (let p = 0, j = 0; p < gray.length; p++, j += 4) gray[p] = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) / 255; }
    strokes = it.strokes || []; replay(false);
    levels(); disp.hidden = false; draw(); updUndo();
    $('#bgSave').disabled = false;
  }

  /* matte -> display mask with hardness / cleanup curve */
  function lut() {
    const L = new Uint8Array(256), k = 1 + opt.sharp / 100 * 14, c = opt.clean / 100 * 0.5;
    for (let i = 0; i < 256; i++) { let v = i / 255; v = (v - 0.5) * k + 0.5; v = v < 0 ? 0 : v > 1 ? 1 : v; if (v < c) v = 0; L[i] = Math.round(v * 255); }
    return L;
  }
  function maskCanvas(w, h) {
    // raw matte → canvas (white with alpha) at w×h
    const L = lut(), src = mk(raw.w, raw.h), x = cx(src), id = x.createImageData(raw.w, raw.h), D = id.data;
    for (let p = 0, j = 0; p < raw.length; p++, j += 4) { D[j] = D[j + 1] = D[j + 2] = 255; D[j + 3] = L[raw[p]]; }
    x.putImageData(id, 0, 0);
    if (w === raw.w && h === raw.h) return src;
    const o = mk(w, h), ox = cx(o); ox.imageSmoothingQuality = 'high'; ox.drawImage(src, 0, 0, w, h); return o;
  }
  let lvT = 0;
  function levels() { if (!raw) return; const c = maskCanvas(MW, MH); cx(baseC).clearRect(0, 0, MW, MH); cx(baseC).drawImage(c, 0, 0); }
  function levelsSoon() { clearTimeout(lvT); lvT = setTimeout(() => { levels(); draw(); }, 60); }

  /* brush strokes on add/sub layers (mask resolution) */
  function paintSeg(s, i) {
    const a = s.pts[Math.max(0, i - 1)], b = s.pts[i];
    const pairs = s.m === 'keep' ? [[addC, 'source-over'], [subC, 'destination-out']] : [[subC, 'source-over'], [addC, 'destination-out']];
    for (const [c, op] of pairs) {
      const x = cx(c); x.globalCompositeOperation = op; x.fillStyle = x.strokeStyle = '#fff';
      if (i === 0) { x.beginPath(); x.arc(b[0], b[1], s.r, 0, Math.PI * 2); x.fill(); }
      else { x.lineWidth = s.r * 2; x.lineCap = x.lineJoin = 'round'; x.beginPath(); x.moveTo(a[0], a[1]); x.lineTo(b[0], b[1]); x.stroke(); }
      x.globalCompositeOperation = 'source-over';
    }
  }
  function replay(redraw = true) {
    cx(addC).clearRect(0, 0, MW, MH); cx(subC).clearRect(0, 0, MW, MH);
    for (const s of strokes) for (let i = 0; i < s.pts.length; i++) paintSeg(s, i);
    snapAll();
    if (redraw) { updUndo(); draw(); }
  }

  /* Smart brush: a painted stroke is snapped to the real edges of the photo with a guided filter, so a rough
     stroke over a sleeve or a strand of hair follows the object outline instead of leaving a round blob. */
  function boxBlur(a, w, h, r) {
    const o = new Float32Array(w * h), I = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += a[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; } }
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        o[y * w + x] = (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / ((y1 - y0) * (x1 - x0));
      }
    }
    return o;
  }
  function snapLayer(src, dst) {
    const x = cx(dst); x.clearRect(0, 0, MW, MH);
    if (!opt.smart || !gray) { x.drawImage(src, 0, 0); return; }
    const d = cx(src).getImageData(0, 0, MW, MH), D = d.data, n = MW * MH, p = new Float32Array(n);
    let any = false; for (let i = 0, j = 3; i < n; i++, j += 4) { p[i] = D[j] / 255; if (D[j]) any = true; }
    if (!any) return;
    const r = Math.max(2, Math.round(Math.max(MW, MH) / 320)), eps = 4e-3, I = gray;
    const mI = boxBlur(I, MW, MH, r), mp = boxBlur(p, MW, MH, r);
    const Ip = new Float32Array(n), II = new Float32Array(n); for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
    const mIp = boxBlur(Ip, MW, MH, r), mII = boxBlur(II, MW, MH, r), A = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0; i < n; i++) { const a = (mIp[i] - mI[i] * mp[i]) / (mII[i] - mI[i] * mI[i] + eps); A[i] = a; B[i] = mp[i] - a * mI[i]; }
    const mA = boxBlur(A, MW, MH, r), mB = boxBlur(B, MW, MH, r);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      let q = mA[i] * I[i] + mB[i]; q = q < 0 ? 0 : q > 1 ? 1 : q;
      // stay inside the painted area (slightly feathered), keep the stroke core solid
      q = p[i] > 0.98 && mp[i] > 0.98 ? 1 : Math.min(q, mp[i] > 0.02 ? 1 : 0) * (p[i] > 0 || mp[i] > 0.3 ? 1 : 0);
      D[j] = D[j + 1] = D[j + 2] = 255; D[j + 3] = Math.round(q * 255);
    }
    x.putImageData(d, 0, 0);
  }
  function snapAll() { if (!addS) return; snapLayer(addC, addS); snapLayer(subC, subS); }
  function updUndo() { $('#bgUndo').disabled = $('#bgClearEd').disabled = !strokes.length; if (items[cur]) items[cur].strokes = strokes; }
  $('#bgUndo').addEventListener('click', () => { strokes.pop(); replay(); });
  $('#bgClearEd').addEventListener('click', () => { strokes = []; replay(); });

  /* compose: background + cut-out (+ ghost of the removed part while brushing) */
  function finalMask(c, w, h) {
    const x = cx(c); x.clearRect(0, 0, w, h); x.imageSmoothingQuality = 'high';
    const A = drag && drag.s ? addC : addS, B = drag && drag.s ? subC : subS;
    x.drawImage(baseC, 0, 0, w, h); x.drawImage(A, 0, 0, w, h);
    x.globalCompositeOperation = 'destination-out'; x.drawImage(B, 0, 0, w, h); x.globalCompositeOperation = 'source-over';
  }
  function getBlur() {
    const key = W + ':' + opt.blur; if (blurC && blurKey === key) return blurC;
    const f = Math.max(1.5, opt.blur / 100 * 48), sw = Math.max(2, Math.round(W / f)), sh = Math.max(2, Math.round(H / f));
    let c = srcImg, w = W, h = H;
    while (w / 2 > sw) { const n = mk(Math.round(w / 2), Math.round(h / 2)); cx(n).drawImage(c, 0, 0, n.width, n.height); c = n; w = n.width; h = n.height; }
    const s = mk(sw, sh); cx(s).drawImage(c, 0, 0, sw, sh);
    const bw = Math.min(W, 2048), bh = Math.round(H * bw / W), o = mk(bw, bh), ox = cx(o); ox.imageSmoothingQuality = 'high'; ox.drawImage(s, 0, 0, bw, bh);
    blurC = o; blurKey = key; return o;
  }
  function drawBg(x, w, h, fx, fy, fw, fh) {
    if (opt.bg === 'color') { x.fillStyle = opt.color; x.fillRect(0, 0, w, h); }
    else if (opt.bg === 'blur') { const b = getBlur(), k = b.width / W; x.drawImage(b, fx * k, fy * k, fw * k, fh * k, 0, 0, w, h); }
    else if (opt.bg === 'image' && bgImg) { const s = Math.max(w / bgImg.width, h / bgImg.height); x.drawImage(bgImg, (w - bgImg.width * s) / 2, (h - bgImg.height * s) / 2, bgImg.width * s, bgImg.height * s); }
  }
  let mkC = null, cutC = null, raf = 0;
  function draw() { if (!raf) raf = requestAnimationFrame(drawNow); }
  function drawNow() {
    raf = 0; if (!srcImg) return;
    const vw = view.clientWidth || 800, vh = view.clientHeight || 600, fit = Math.min(vw / W, vh / H) * 0.94;
    const dpr = Math.min(2, devicePixelRatio || 1), pw = Math.max(1, Math.round(W * fit * dpr)), ph = Math.max(1, Math.round(pw * H / W));
    if (disp.width !== pw || disp.height !== ph) { disp.width = pw; disp.height = ph; }
    disp.style.width = Math.round(W * fit) + 'px'; disp.style.height = Math.round(H * fit) + 'px';
    const x = cx(disp); x.clearRect(0, 0, pw, ph); x.imageSmoothingQuality = 'high';
    if (!baseC) { x.drawImage(srcImg, 0, 0, pw, ph); return; }
    drawBg(x, pw, ph, 0, 0, W, H);
    if (mode !== 'view') { x.globalAlpha = .3; x.drawImage(srcImg, 0, 0, pw, ph); x.globalAlpha = 1; }
    if (!mkC || mkC.width !== pw || mkC.height !== ph) { mkC = mk(pw, ph); cutC = mk(pw, ph); }
    finalMask(mkC, pw, ph);
    const c = cx(cutC); c.clearRect(0, 0, pw, ph); c.drawImage(srcImg, 0, 0, pw, ph);
    c.globalCompositeOperation = 'destination-in'; c.drawImage(mkC, 0, 0); c.globalCompositeOperation = 'source-over';
    x.drawImage(cutC, 0, 0);
    if (mode === 'view' && split > 0) {
      const sx = Math.round(pw * split);
      x.save(); x.beginPath(); x.rect(0, 0, sx, ph); x.clip(); x.clearRect(0, 0, sx, ph); x.drawImage(srcImg, 0, 0, pw, ph); x.restore();
      x.fillStyle = '#fff'; x.fillRect(sx - 1, 0, 2, ph);
    }
  }
  new ResizeObserver(draw).observe(view);

  /* pointer: compare line or brush */
  let drag = null;
  const toMask = e => { const r = disp.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * MW, (e.clientY - r.top) / r.height * MH]; };
  function showCur(e) {
    if (mode === 'view' || !baseC) { curEl.hidden = true; return; }
    const vr = view.getBoundingClientRect(), s = +$('#bgSize').value;
    curEl.hidden = false; curEl.className = 'cur ' + mode; curEl.style.width = curEl.style.height = s + 'px';
    curEl.style.left = (e.clientX - vr.left) + 'px'; curEl.style.top = (e.clientY - vr.top) + 'px';
  }
  disp.addEventListener('pointerdown', e => {
    if (!baseC) return; disp.setPointerCapture(e.pointerId);
    if (mode === 'view') { drag = { split: true }; setSplit(e); return; }
    const r = disp.getBoundingClientRect(), s = { m: mode, r: +$('#bgSize').value / 2 * MW / r.width, pts: [toMask(e)] };
    strokes.push(s); drag = { s }; paintSeg(s, 0); draw(); updUndo();
  });
  disp.addEventListener('pointermove', e => {
    showCur(e); if (!drag) return;
    if (drag.split) setSplit(e);
    else { for (const ev of (e.getCoalescedEvents ? e.getCoalescedEvents() : [e])) { drag.s.pts.push(toMask(ev)); paintSeg(drag.s, drag.s.pts.length - 1); } draw(); }
  });
  disp.addEventListener('pointerup', () => { const was = drag && drag.s; drag = null; if (was) { snapAll(); draw(); } });
  disp.addEventListener('pointerleave', () => { if (!drag) curEl.hidden = true; });
  function setSplit(e) { const r = disp.getBoundingClientRect(); split = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); draw(); }
  $$('.mbtn').forEach(b => b.addEventListener('click', () => {
    mode = b.dataset.m; $$('.mbtn').forEach(x => x.classList.toggle('on', x === b));
    $('#brushBox').hidden = mode === 'view'; view.classList.toggle('brush', mode !== 'view'); curEl.hidden = true; hint(); draw();
  }));
  function hint() { $('#bgHint').textContent = t(mode === 'keep' ? 'bg_hKeep' : mode === 'erase' ? 'bg_hErase' : 'bg_hView'); }
  document.addEventListener('lang', hint); hint();

  /* settings */
  function seg(id, cb) { const g = $(id); g.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; [...g.children].forEach(x => x.classList.toggle('on', x === b)); cb(b.dataset.v); }); }
  seg('#bgMode', v => { opt.bg = v; $('#bgColorBox').hidden = v !== 'color'; $('#bgBlurBox').hidden = v !== 'blur'; $('#bgImgBox').hidden = v !== 'image'; if (v === 'image' && !bgImg) pickBg(); draw(); });
  seg('#bgFmt', v => { opt.fmt = v; });
  const pal = $('#bgPal');
  COLORS.forEach(c => { const b = document.createElement('button'); b.style.background = c; b.dataset.c = c; if (c === opt.color) b.classList.add('on'); pal.appendChild(b); });
  const picker = document.createElement('input'); picker.type = 'color'; picker.value = '#ff4f9a'; pal.appendChild(picker);
  pal.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; opt.color = b.dataset.c; $$('#bgPal button').forEach(x => x.classList.toggle('on', x === b)); draw(); });
  picker.addEventListener('input', () => { opt.color = picker.value; $$('#bgPal button').forEach(x => x.classList.remove('on')); draw(); });
  async function pickBg() { const f = (await S.open('image'))[0]; if (f) { bgImg = await loadImg(App.fileUrl(f)); draw(); } }
  $('#bgPickImg').addEventListener('click', pickBg);
  $('#bgBlur').addEventListener('input', e => { opt.blur = +e.target.value; $('#v-blur').textContent = e.target.value; draw(); });
  $('#bgSharp').addEventListener('input', e => { opt.sharp = +e.target.value; $('#v-sharp').textContent = e.target.value; levelsSoon(); });
  $('#bgClean').addEventListener('input', e => { opt.clean = +e.target.value; $('#v-clean').textContent = e.target.value; levelsSoon(); });
  $('#bgCrop').addEventListener('change', e => { opt.crop = e.target.checked; });
  $('#bgSmart').addEventListener('change', e => { opt.smart = e.target.checked; snapAll(); draw(); });

  /* export at full resolution */
  function bbox(m) {
    const d = cx(m).getImageData(0, 0, m.width, m.height).data; let x0 = m.width, y0 = m.height, x1 = -1, y1 = -1;
    for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) if (d[(y * m.width + x) * 4 + 3] > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
  }
  async function renderFull() {
    const M = maskCanvas(W, H), mx = cx(M);
    mx.imageSmoothingQuality = 'high'; mx.drawImage(addS, 0, 0, W, H);
    mx.globalCompositeOperation = 'destination-out'; mx.drawImage(subS, 0, 0, W, H); mx.globalCompositeOperation = 'source-over';
    let fx = 0, fy = 0, fw = W, fh = H;
    if (opt.crop) { const sm = mk(MW, MH); cx(sm).drawImage(M, 0, 0, MW, MH); const b = bbox(sm); if (b) { const k = W / MW, p = Math.round(Math.max(b[2] - b[0], b[3] - b[1]) * k * 0.05); fx = Math.max(0, Math.floor(b[0] * k - p)); fy = Math.max(0, Math.floor(b[1] * k - p)); fw = Math.min(W, Math.ceil(b[2] * k + p)) - fx; fh = Math.min(H, Math.ceil(b[3] * k + p)) - fy; } }
    const cut = mk(W, H), c = cx(cut); c.drawImage(srcImg, 0, 0); c.globalCompositeOperation = 'destination-in'; c.drawImage(M, 0, 0);
    const o = mk(fw, fh), x = cx(o); x.imageSmoothingQuality = 'high';
    if (opt.fmt === 'jpg' && (opt.bg === 'none' || (opt.bg === 'image' && !bgImg))) { x.fillStyle = '#fff'; x.fillRect(0, 0, fw, fh); }
    drawBg(x, fw, fh, fx, fy, fw, fh);
    x.drawImage(cut, fx, fy, fw, fh, 0, 0, fw, fh);
    const type = opt.fmt === 'jpg' ? 'image/jpeg' : opt.fmt === 'webp' ? 'image/webp' : 'image/png';
    const url = o.toDataURL(type, opt.fmt === 'png' ? undefined : 0.95);
    return url.slice(url.indexOf(',') + 1);
  }
  async function saveCurrent() {
    const it = items[cur]; if (!it || it.state !== 'ready') return null;
    const out = await S.outName(it.src, '_nobg', opt.fmt === 'jpg' ? 'jpg' : opt.fmt);
    await S.writeB64(out, await renderFull());
    it.saved = out; render(); return out;
  }
  $('#bgSave').addEventListener('click', async () => { const p = await saveCurrent(); if (p) { App.toast(t('saved') + ' — ' + p.split(/[\\/]/).pop(), 'ok'); S.reveal(p); } });
  $('#bgSaveAll').addEventListener('click', async () => {
    let n = 0, last = null;
    for (let i = 0; i < items.length; i++) { if (items[i].state !== 'ready') continue; await select(i); last = await saveCurrent(); n++; }
    if (n) { App.toast(t('saved') + ' — ' + n, 'ok'); S.reveal(last); }
  });
  $('#bgAdd').addEventListener('click', async () => add(await S.open('image', true)));
  $('#bgClearList').addEventListener('click', () => { if (qRunning) return; items.length = 0; cur = -1; srcImg = raw = baseC = null; disp.hidden = true; render(); $('#bgSave').disabled = $('#bgSaveAll').disabled = true; });
  window.Cutout = { add };
})();
