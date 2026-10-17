/* 7krh Studio — batch image upscaling (Real-ESRGAN on the GPU) with before/after compare */
(() => {
  'use strict';
  const { $, $$, S, t } = App;
  const items = []; let cur = -1, running = false, reqSeq = 0;
  const opt = { model: 'photo', scale: 4, fmt: 'png' };

  function seg(id, key, num) {
    const g = $(id);
    g.addEventListener('click', e => { const b = e.target.closest('button'); if (!b || running) return; [...g.children].forEach(x => x.classList.toggle('on', x === b)); opt[key] = num ? +b.dataset.v : b.dataset.v; });
  }
  seg('#imgModel', 'model'); seg('#imgScale', 'scale', true); seg('#imgFmt', 'fmt');

  async function add(paths) {
    for (const p of paths) {
      if (items.some(x => x.src === p)) continue;
      const it = { src: p, name: p.split(/[\\/]/).pop(), state: 'new', out: null, w: 0, h: 0 };
      items.push(it);
      try { const info = await S.probe(p); it.w = info.width; it.h = info.height; } catch (e) {}
    }
    render(); if (cur < 0 && items.length) select(0);
    $('#imgGo').disabled = !items.some(x => x.state !== 'done');
  }
  function render() {
    const L = $('#imgList'); L.innerHTML = '';
    items.forEach((it, i) => {
      const d = document.createElement('div'); d.className = 'fitem' + (i === cur ? ' on' : '');
      const im = document.createElement('img'); im.src = App.fileUrl(it.out || it.src); im.loading = 'lazy';
      const tx = document.createElement('div'); const b = document.createElement('b'); b.textContent = it.name;
      const sm = document.createElement('small');
      sm.textContent = it.state === 'done' ? `✓ ${it.ow}×${it.oh} · ${(it.ms / 1000).toFixed(1)}s` : it.state === 'run' ? Math.round((it.p || 0) * 100) + '%' : it.state === 'err' ? '✕ ' + (it.err || '') : (it.w ? `${it.w}×${it.h}` : '');
      if (it.state === 'done') sm.className = 'ok'; if (it.state === 'err') sm.className = 'err';
      tx.append(b, sm); d.append(im, tx); d.onclick = () => select(i); L.appendChild(d);
    });
    $('#imgEmpty').hidden = !!items.length;
  }
  /* compare view: after on the right of the line, before on the left */
  const cv = $('#imgCanvas'); let A = null, B = null, split = 0.5, sdrag = false;
  async function select(i) {
    cur = i; render();
    const it = items[i]; if (!it) return;
    A = await img(App.fileUrl(it.src)); B = it.out ? await img(App.fileUrl(it.out) + '?' + it.ms) : null;
    cv.hidden = false; draw();
  }
  const img = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  function draw() {
    if (!A) return;
    const W = B ? B.naturalWidth : A.naturalWidth, H = B ? B.naturalHeight : A.naturalHeight;
    const k = Math.min(1, 4096 / Math.max(W, H)); cv.width = Math.round(W * k); cv.height = Math.round(H * k);
    const x = cv.getContext('2d'); x.imageSmoothingQuality = 'high';
    if (!B) { x.drawImage(A, 0, 0, cv.width, cv.height); $('#imgLbl').hidden = true; return; }
    x.drawImage(B, 0, 0, cv.width, cv.height);
    const sx = Math.round(cv.width * split);
    x.save(); x.beginPath(); x.rect(0, 0, sx, cv.height); x.clip(); x.drawImage(A, 0, 0, cv.width, cv.height); x.restore();
    x.fillStyle = '#fff'; x.fillRect(sx - 1, 0, 2, cv.height);
    $('#imgLbl').hidden = false; $('#imgLbl').textContent = `${t('before')} | ${t('after')}`;
  }
  cv.addEventListener('pointerdown', e => { sdrag = true; cv.setPointerCapture(e.pointerId); smove(e); });
  cv.addEventListener('pointermove', e => { if (sdrag) smove(e); });
  cv.addEventListener('pointerup', () => { sdrag = false; });
  function smove(e) { const r = cv.getBoundingClientRect(); split = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); draw(); }

  S.onImg(({ reqId, p }) => { const it = items.find(x => x.req === reqId); if (it) { it.p = p; render(); $('#imgBusyTxt').textContent = t('img_working') + ' ' + Math.round(p * 100) + '%'; } });

  $('#imgGo').addEventListener('click', async () => {
    if (running) return; running = true; $('#imgGo').disabled = true;
    $('#imgBusy').hidden = false; $('#imgBusyTxt').textContent = t('img_working');
    for (let i = 0; i < items.length; i++) {
      const it = items[i]; if (it.state === 'done') continue;
      it.state = 'run'; it.p = 0; it.req = ++reqSeq; select(i);
      try {
        const out = await S.outName(it.src, '_x' + opt.scale, opt.fmt);
        const r = await S.upscaleImage(it.src, out, opt.model, opt.scale, it.req);
        Object.assign(it, { state: 'done', out, ow: r.w, oh: r.h, ms: r.ms });
      } catch (e) { it.state = 'err'; it.err = String(e.message || e).split('\n')[0].slice(0, 80); App.toast(it.name + ': ' + it.err, 'err', 8000); }
      render(); if (cur === i) select(i);
    }
    $('#imgBusy').hidden = true; running = false;
    $('#imgGo').disabled = !items.some(x => x.state !== 'done');
    const done = items.filter(x => x.state === 'done');
    if (done.length) App.toast(t('img_done') + ' — ' + done.length, 'ok');
  });
  $('#imgAdd').addEventListener('click', async () => add(await S.open('image', true)));
  $('#imgClear').addEventListener('click', () => { if (running) return; items.length = 0; cur = -1; A = B = null; cv.hidden = true; render(); $('#imgGo').disabled = true; });
  $('#imgCv').addEventListener('dblclick', () => { const it = items[cur]; if (it && it.out) S.reveal(it.out); });
  window.Images = { add };
})();
