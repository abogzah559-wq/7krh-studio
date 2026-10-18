/* 7krh Studio — image enhancement: Real-ESRGAN (photo / fast photo / anime) on the GPU through ONNX Runtime +
   DirectML, batch processing, before/after compare with real zoom, strength, format + metadata control. */
(() => {
  'use strict';
  const { $, $$, S, t, h } = App;
  const items = []; let cur = -1, running = false, reqSeq = 0, cancelled = false;
  const opt = { model: 'auto', scale: 4, fmt: 'same', strength: 1, quality: 95, meta: true };

  function seg(id, key, num) {
    const g = $(id);
    g.addEventListener('click', e => { const b = e.target.closest('button'); if (!b || running) return; [...g.children].forEach(x => x.classList.toggle('on', x === b)); opt[key] = num ? +b.dataset.v : b.dataset.v; sync(); });
  }
  seg('#imgModel', 'model'); seg('#imgScale', 'scale', true); seg('#imgFmt', 'fmt');
  $('#imgStrength').addEventListener('input', e => { opt.strength = e.target.value / 100; $('#v-str').textContent = e.target.value + '%'; });
  $('#imgQ').addEventListener('input', e => { opt.quality = +e.target.value; $('#v-iq').textContent = e.target.value; });
  $('#imgMeta').addEventListener('change', e => { opt.meta = e.target.checked; App.saveSet({ imgMeta: opt.meta ? 'keep' : 'strip' }); });
  document.addEventListener('boot', () => { opt.meta = (App.settings.imgMeta || 'keep') === 'keep'; $('#imgMeta').checked = opt.meta; });
  const extOf = it => { if (opt.fmt !== 'same') return opt.fmt; const e = (it.src.match(/\.([a-z0-9]+)$/i) || [, 'png'])[1].toLowerCase(); return e === 'jpeg' ? 'jpg' : ['png', 'jpg', 'webp'].includes(e) ? e : 'png'; };
  function sync() {
    const it = items[cur];
    const e = it ? extOf(it) : opt.fmt;
    $('#imgQBox').hidden = !(e === 'jpg' || e === 'webp');
    const sug = it && it.analysis;
    $('#imgSuggest').textContent = sug ? t('img_suggest', { m: t('img_' + sug.suggest), why: t(sug.suggest === 'anime' ? 'img_why_anime' : 'img_why_photo') }) : '';
    if (it) {
      const s = opt.scale;
      const big = it.w * it.h * s * s;
      $('#imgHint').textContent = big > 150e6 ? t('img_big', { px: Math.round(big / 1e6) }) : it.alpha && e === 'jpg' ? t('img_alpha_jpg') : '';
      $('#imgHint').className = 'hint' + (big > 150e6 || (it.alpha && e === 'jpg') ? ' warn' : '');
    }
    info();
  }

  async function add(paths) {
    for (const p of paths) {
      if (items.some(x => x.src === p)) continue;
      const it = { src: p, name: App.base(p), state: 'new', out: null, w: 0, h: 0 };
      items.push(it);
      try { const i = await S.probe(p); it.w = i.rotation % 180 ? i.height : i.width; it.h = i.rotation % 180 ? i.width : i.height; it.size = i.size; } catch (e) {}
      S.img.analyze(p).then(a => { it.analysis = a; it.alpha = a.alpha; it.icc = a.icc; it.exif = a.exif; it.format = a.format; if (items[cur] === it) sync(); render(); }).catch(() => {});
    }
    render(); if (cur < 0 && items.length) select(0);
    $('#imgGo').disabled = !items.some(x => x.state !== 'done');
  }
  function render() {
    const L = $('#imgList'); L.innerHTML = '';
    items.forEach((it, i) => {
      const sm = h('small', { class: it.state === 'done' ? 'ok' : it.state === 'err' ? 'err' : '', text: it.state === 'done' ? `✓ ${it.ow}×${it.oh} · ${(it.ms / 1000).toFixed(1)}s` : it.state === 'run' ? Math.round((it.p || 0) * 100) + '%' : it.state === 'err' ? '✕ ' + (it.err || '') : it.state === 'wait' ? t('q_waiting') : (it.w ? `${it.w}×${it.h}` : '') });
      L.appendChild(h('button', { class: 'fitem' + (i === cur ? ' on' : ''), onclick: () => select(i) }, h('img', { src: App.fileUrl(it.out || it.src), loading: 'lazy', alt: '' }), h('div', {}, h('b', { text: it.name }), sm)));
    });
    $('#imgEmpty').hidden = !!items.length;
  }
  function info() {
    const it = items[cur], box = $('#imgInfo');
    if (!it) { box.hidden = true; return; }
    box.hidden = false; box.innerHTML = '';
    const s = opt.scale, row = (k, v) => box.appendChild(h('span', {}, t(k) + ' ', h('b', { text: v })));
    row('ii_orig', `${it.w}×${it.h}` + (it.size ? ' · ' + App.fmtSize(it.size) : '') + (it.format ? ' · ' + it.format : ''));
    if (it.state === 'done') { row('ii_new', `${it.ow}×${it.oh} · ${App.fmtSize(it.bytes || 0)} · ${extOf(it).toUpperCase()}`); row('ii_dev', `${it.device === 'gpu' ? 'GPU' : 'CPU'} · ${it.provider || ''} ${it.gpu ? '· ' + it.gpu : ''}`); }
    else row('ii_will', `${it.w * s}×${it.h * s} · ${extOf(it).toUpperCase()}`);
    if (it.alpha) row('ii_alpha', t(extOf(it) === 'jpg' ? 'ii_alpha_lost' : 'ii_alpha_kept'));
    if (it.icc || it.exif) row('ii_meta', [it.icc ? 'ICC' : null, it.exif ? 'EXIF' : null].filter(Boolean).join(' + ') + ' · ' + t(opt.meta ? 'ii_kept' : 'ii_removed'));
  }
  const cv = $('#imgCanvas');
  const V = App.Compare(cv, $('#imgCv'), z => { $('#imgZoom').textContent = z + '%'; });
  $$('#imgZoomBar [data-z]').forEach(b => b.addEventListener('click', () => V.zoomTo(+b.dataset.z)));
  async function select(i) {
    cur = i; render(); sync();
    const it = items[i]; if (!it) return;
    try {
      const A = await img(App.fileUrl(it.src)), B = it.out ? await img(App.fileUrl(it.out) + '?' + it.ms) : null;
      if (items[cur] !== it) return;
      cv.hidden = false; V.set(A, B);
      $('#imgLblA').hidden = $('#imgLblB').hidden = !B; $('#imgZoomBar').hidden = false;
    } catch (e) {}
  }
  const img = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  S.onImg(({ reqId, p }) => { const it = items.find(x => x.req === reqId); if (it) { it.p = p; render(); $('#imgBusyTxt').textContent = t('img_working') + ' ' + Math.round(p * 100) + '%'; } });

  $('#imgGo').addEventListener('click', async () => {
    if (running) return; running = true; cancelled = false; $('#imgGo').disabled = true;
    $('#imgBusy').hidden = false; $('#imgBusyTxt').textContent = t('img_working');
    items.forEach(x => { if (x.state !== 'done') x.state = 'wait'; });
    for (let i = 0; i < items.length && !cancelled; i++) {
      const it = items[i]; if (it.state === 'done') continue;
      it.state = 'run'; it.p = 0; it.req = ++reqSeq; select(i);
      const t0 = Date.now();
      try {
        const out = await S.outName(it.src, '_x' + opt.scale, extOf(it));
        const model = opt.model === 'auto' ? ((it.analysis && it.analysis.suggest) || 'photo') : opt.model;
        const r = await S.img.upscale({ src: it.src, out, model, scale: opt.scale, strength: opt.strength, quality: opt.quality, meta: opt.meta ? 'keep' : 'strip' }, it.req);
        Object.assign(it, { state: 'done', out, ow: r.w, oh: r.h, ms: r.ms || (Date.now() - t0), bytes: r.bytes, device: r.device, provider: r.provider, gpu: r.gpu });
        if (r.device !== 'gpu') App.toast(t('img_on_cpu'), 'err', 7000);
      } catch (e) {
        if (cancelled) { it.state = 'new'; break; }
        it.state = 'err'; it.err = App.errText(e).slice(0, 90);
        App.toast(it.name + ': ' + (e.message && /GPU-only/.test(e.message) ? t('err_gpuOnly') : it.err), 'err', 8000);
      }
      render(); if (cur === i) select(i);
    }
    items.forEach(x => { if (x.state === 'wait') x.state = 'new'; });
    $('#imgBusy').hidden = true; running = false; render();
    $('#imgGo').disabled = !items.some(x => x.state !== 'done');
    const done = items.filter(x => x.state === 'done');
    if (done.length && !cancelled) App.toast(t('img_done') + ' — ' + done.length, 'ok');
  });
  $('#imgCancel').addEventListener('click', async () => { cancelled = true; await S.img.cancel(); });
  $('#imgAdd').addEventListener('click', async () => add(await S.open('image', true)));
  $('#imgClear').addEventListener('click', () => { if (running) return; items.length = 0; cur = -1; V.clear(); cv.hidden = true; $('#imgZoomBar').hidden = true; $('#imgLblA').hidden = $('#imgLblB').hidden = true; render(); info(); $('#imgGo').disabled = true; });
  window.Images = { add: async p => { App.go('images'); await add(p); } };
})();
