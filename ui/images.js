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
  /* compare view with zoom: after on the right of the line, before on the left */
  const cv = $('#imgCanvas'); let A = null, B = null;
  const V = App.Compare(cv, $('#imgCv'), z => { $('#imgZoom').textContent = z + '%'; });
  $$('#imgZoomBar [data-z]').forEach(b => b.addEventListener('click', () => V.zoomTo(+b.dataset.z)));
  async function select(i) {
    cur = i; render();
    const it = items[i]; if (!it) return;
    A = await img(App.fileUrl(it.src)); B = it.out ? await img(App.fileUrl(it.out) + '?' + it.ms) : null;
    cv.hidden = false;
    V.set(B ? A : A, B);
    $('#imgLblA').hidden = $('#imgLblB').hidden = !B; $('#imgZoomBar').hidden = false;
  }
  const img = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });

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
  $('#imgClear').addEventListener('click', () => { if (running) return; items.length = 0; cur = -1; A = B = null; V.clear(); cv.hidden = true; $('#imgZoomBar').hidden = true; $('#imgLblA').hidden = $('#imgLblB').hidden = true; render(); $('#imgGo').disabled = true; });
  window.Images = { add };
})();
