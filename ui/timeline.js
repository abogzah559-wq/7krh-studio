/* 7krh Studio — montage editor: media bin, multi-track timeline, inspector, preview, projects, export.
   Every edit goes through mut() so it can be undone; the project autosaves after each change. */
(() => {
  'use strict';
  const { $, $$, S, t, h } = App;
  const ed = {
    p: TL.newProject('landscape', 'مشروع جديد'), sel: null, path: null, saved: true,
    undo: [], redo: [], pps: 60, snap: true, ripple: true, fxClip: null, insTab: 'clip',
  };
  const P = () => ed.p;
  const clip = id => ed.p.clips.find(c => c.id === id);
  const selClip = () => clip(ed.sel);
  const TH = { video: 52, audio: 46, text: 38 };

  /* ---------------------------------------------------------------- history */
  function snapshot() { return JSON.stringify(ed.p); }
  function mut(fn, opts = {}) {
    const before = snapshot();
    const r = fn();
    if (snapshot() === before) return r;
    ed.undo.push(before); if (ed.undo.length > 200) ed.undo.shift();
    ed.redo = []; changed(opts);
    return r;
  }
  function begin() { ed._drag = snapshot(); }
  function end() { if (ed._drag && ed._drag !== snapshot()) { ed.undo.push(ed._drag); ed.redo = []; changed(); } ed._drag = null; }
  function undo() { if (!ed.undo.length) return; ed.redo.push(snapshot()); ed.p = TL.migrate(JSON.parse(ed.undo.pop())); if (!clip(ed.sel)) ed.sel = null; changed({ keepHistory: true }); }
  function redo() { if (!ed.redo.length) return; ed.undo.push(snapshot()); ed.p = TL.migrate(JSON.parse(ed.redo.pop())); changed({ keepHistory: true }); }
  let saveT = 0;
  function changed(opts = {}) {
    ed.saved = false;
    renderAll(opts);
    clearTimeout(saveT);
    saveT = setTimeout(() => { if (ed.p.clips.length) S.project.autosave(JSON.stringify({ path: ed.path, project: ed.p })).catch(() => {}); }, 1200);
  }

  /* ---------------------------------------------------------------- preview */
  const pv = new Preview($('#pv'), P, {
    fileUrl: App.fileUrl,
    onTime: tt => { drawTime(tt); placeHead(tt); if (ed.insTab === 'clip' && selClip()) refreshKfButtons(); },
    onEnd: () => setPlayIcon(),
  });
  const viewer = $('#viewer');
  new ResizeObserver(() => pv.resize(viewer.clientWidth, viewer.clientHeight)).observe(viewer);
  $('#pvScale').addEventListener('change', e => { pv.q = +e.target.value; pv.resize(viewer.clientWidth, viewer.clientHeight); });
  const setPlayIcon = () => $('#tPlay use').setAttribute('href', pv.playing ? '#i-pause' : '#i-play');
  const togglePlay = () => { pv.toggle(); setPlayIcon(); };
  $('#tPlay').addEventListener('click', togglePlay);
  const step = n => { pv.pause(); setPlayIcon(); pv.seek(Math.round((pv.t + n / ed.p.canvas.fps) * ed.p.canvas.fps) / ed.p.canvas.fps); };
  $('#tPrev').addEventListener('click', () => step(-1)); $('#tNext').addEventListener('click', () => step(1));
  $('#tStart').addEventListener('click', () => { pv.pause(); setPlayIcon(); pv.seek(0); });
  function drawTime(tt) { $('#tTime').textContent = App.fmtTime(tt) + ' / ' + App.fmtTime(TL.duration(ed.p)); }

  /* drag the selected layer on the canvas: centre = move, corner = scale (keyframe-aware) */
  const pvc = $('#pv');
  pvc.addEventListener('pointerdown', e => {
    const r = pvc.getBoundingClientRect(); const k = ed.p.canvas.w / r.width;
    const px = (e.clientX - r.left) * k, py = (e.clientY - r.top) * k;
    const hit = pv.hit(px, py);
    if (!hit) { select(null); return; }
    select(hit.clip.id);
    const c = hit.clip, u = pv.t - c.start, st0 = TL.stateAt(c, u);
    const rr = TL.rect(ed.p, c, st0);
    pvc.setPointerCapture(e.pointerId); begin();
    const d0 = Math.hypot(px - rr.cx, py - rr.cy) || 1;
    const s0 = { x: baseVal(c, 'x', u), y: baseVal(c, 'y', u), s: baseVal(c, 's', u) }; // values when the drag started
    const move = ev => {
      const qx = (ev.clientX - r.left) * k, qy = (ev.clientY - r.top) * k;
      if (hit.corner) setProp(c, 's', Math.max(0.02, round3(s0.s * Math.hypot(qx - rr.cx, qy - rr.cy) / d0)), u, true);
      else { setProp(c, 'x', round3(s0.x + (qx - px) / ed.p.canvas.w), u, true); setProp(c, 'y', round3(s0.y + (qy - py) / ed.p.canvas.h), u, true); }
      pv.draw(); if (ed.insTab === 'clip') renderInspector(true);
    };
    const up = () => { pvc.removeEventListener('pointermove', move); pvc.removeEventListener('pointerup', up); end(); renderInspector(); };
    pvc.addEventListener('pointermove', move); pvc.addEventListener('pointerup', up);
  });
  const round3 = v => Math.round(v * 1000) / 1000;
  const baseVal = (c, k, u) => (Array.isArray(c.kf[k]) && c.kf[k].length ? TL.kfValue(c.kf[k], u, c.tf[k]) : c.tf[k]);

  /* ---------------------------------------------------------------- keyframes */
  const KEYS = { x: 'tf', y: 'tf', s: 'tf', r: 'tf', o: 'tf', vol: 'volume' };
  const fpsStep = () => 0.5 / (ed.p.canvas.fps || 30);
  /* sets a property; if the property is animated, writes a keyframe at the playhead instead */
  function setProp(c, k, v, u, live) {
    const arr = c.kf[k];
    if (Array.isArray(arr) && arr.length) {
      u = Math.max(0, Math.min(TL.len(c), u));
      const i = arr.findIndex(x => Math.abs(x.t - u) < fpsStep());
      if (i >= 0) arr[i].v = v; else { arr.push({ t: round3(u), v }); arr.sort((a, b) => a.t - b.t); }
    } else if (k === 'vol') c.volume = v; else c.tf[k] = v;
    if (!live) changed();
  }
  function toggleKf(c, k) {
    const u = Math.max(0, Math.min(TL.len(c), pv.t - c.start));
    mut(() => {
      const arr = c.kf[k] || (c.kf[k] = []);
      const i = arr.findIndex(x => Math.abs(x.t - u) < fpsStep());
      if (i >= 0) { arr.splice(i, 1); if (!arr.length) delete c.kf[k]; }
      else { arr.push({ t: round3(u), v: baseVal(c, k, u) ?? (k === 'vol' ? c.volume : c.tf[k]) }); arr.sort((a, b) => a.t - b.t); }
    });
  }

  /* ---------------------------------------------------------------- media */
  const canPlay = url => new Promise(res => {
    const v = document.createElement('video'); v.muted = true; v.preload = 'auto';
    const done = ok => { clearTimeout(to); v.removeAttribute('src'); v.load(); res(ok); };
    const to = setTimeout(() => done(false), 6000);
    v.onloadeddata = () => done(v.videoWidth > 0 || v.duration > 0); v.onerror = () => done(false); v.src = url;
  });
  const thumbCache = new Map(), peakCache = new Map();
  async function register(src) {
    if (ed.p.media[src] && ed.p.media[src].w !== undefined) return ed.p.media[src];
    const info = await S.probe(src);
    if (info.kind === 'unknown') throw new Error(t('err_open'));
    const m = { kind: info.kind, w: info.width, h: info.height, rotation: info.rotation, fps: info.fps, fpsNum: App.fps(info), duration: info.duration, hasAudio: info.hasAudio, colorSpace: info.colorSpace, vcodec: info.vcodec, hdr: info.hdr, size: info.size, name: info.name };
    ed.p.media[src] = m;
    if (info.kind === 'video') {
      const ok = await canPlay(App.fileUrl(src));
      if (!ok || Math.min(info.width, info.height) > 1500) makeProxy(src, info, !ok);
      S.thumbs(src, Math.min(info.duration, 1), 1, 120).then(l => { m.thumb = l[0]; renderBin(); }).catch(() => {});
    } else if (info.kind === 'image') m.thumb = App.fileUrl(src);
    return m;
  }
  /* light H.264 copy for the preview only; the export always reads the original */
  function makeProxy(src, info, needed) {
    const m = ed.p.media[src]; m.proxying = 0;
    const off = S.onProxy(d => { if (d.file === src) { m.proxying = d.p; const a = $(`.asset[data-src="${CSS.escape(src)}"]`); if (a) a.style.setProperty('--p', Math.round(d.p * 100) + '%'); } });
    renderBin();
    S.proxy(src, info).then(px => { m.proxy = px; delete m.proxying; renderBin(); pv.gc(); pv.els.forEach((e, id) => { const c = clip(id); if (c && c.src === src) pv.drop(id); }); pv.seek(pv.t); })
      .catch(() => { delete m.proxying; if (needed) App.toast(t('err_proxy', { n: App.base(src) }), 'err', 7000); renderBin(); }).finally(off);
  }
  function defaultTrack(kind) {
    const want = kind === 'audio' ? 'audio' : kind === 'text' ? 'text' : 'video';
    const list = ed.p.tracks.filter(x => x.kind === want);
    if (kind === 'audio') return (list.find(x => !x.voice) || list[0] || addTrack('audio')).id;
    return (list[list.length - 1] || addTrack(want)).id; // bottom video track = main
  }
  function addTrack(kind, opts = {}) {
    const n = ed.p.tracks.filter(x => x.kind === kind).length + 1;
    const id = (kind === 'audio' ? 'A' : kind === 'text' ? 'T' : 'V') + TL.uid('').slice(0, 4);
    const tr = { id, kind, name: (kind === 'audio' ? t('tk_audio') : kind === 'text' ? t('tk_text') : t('tk_video')) + ' ' + n, mute: false, hidden: false, volume: 1, ...opts };
    // new visual tracks go on top of the existing ones of that kind
    const first = ed.p.tracks.findIndex(x => x.kind === kind);
    if (kind === 'audio') ed.p.tracks.push(tr); else ed.p.tracks.splice(first < 0 ? 0 : first, 0, tr);
    return tr;
  }
  const trackEnd = id => ed.p.clips.filter(c => c.track === id).reduce((m, c) => Math.max(m, TL.end(c)), 0);
  function makeClip(src, m, track, start) {
    const kind = m.kind === 'audio' ? 'audio' : m.kind;
    const dur = kind === 'image' ? 4 : m.duration || 4;
    return TL.normClip({ id: TL.uid(), kind, src, track, in: 0, out: dur, start, fit: 'contain' });
  }
  /* imports files; adds them in order on the right tracks (or at a given place) */
  async function addFiles(paths, opts = {}) {
    if (opts.newProject && ed.p.clips.length) { if (!(await confirmDiscard())) return; newProject('landscape'); }
    const empty = !ed.p.clips.length;
    busy(t('importing'));
    const added = [];
    try {
      for (const src of paths) {
        if (App.kindOf(src) === 'subs') { await importSubs(src); continue; }
        let m;
        try { m = await register(src); } catch (e) { App.toast(App.base(src) + ': ' + App.errText(e), 'err', 7000); continue; }
        if (empty && !added.length && m.kind === 'video') adoptCanvas(m);
        if (opts.binOnly) continue;
        const tr = opts.track && compatible(ed.p.tracks.find(x => x.id === opts.track), m.kind) ? opts.track : defaultTrack(m.kind);
        // in order: after the last clip on that track, counting the clips added in this same import
        const prevOnTrack = added.filter(c => c.track === tr).reduce((m, c) => Math.max(m, TL.end(c)), 0);
        const start = opts.at != null ? (added.length ? TL.end(added[added.length - 1]) : opts.at) : Math.max(trackEnd(tr), prevOnTrack);
        added.push(makeClip(src, m, tr, start));
      }
      if (added.length) mut(() => { ed.p.clips.push(...added); }); else changed();
      if (added.length) select(added[0].id);
    } finally { busy(''); }
  }
  function adoptCanvas(m) {
    const r = m.rotation % 180 ? [m.h, m.w] : [m.w, m.h];
    let [w, hh] = r; const s = Math.min(1, 3840 / Math.max(w, hh), 2160 / Math.min(w, hh));
    w = Math.round(w * s / 2) * 2; hh = Math.round(hh * s / 2) * 2;
    const f = m.fpsNum || 30, fps = [24, 25, 30, 50, 60, 120].reduce((a, b) => (Math.abs(b - f) < Math.abs(a - f) ? b : a), 30);
    ed.p.canvas = { ...ed.p.canvas, w, h: hh, fps };
  }
  const compatible = (tr, kind) => !!tr && (tr.kind === 'audio' ? kind === 'audio' : tr.kind === 'text' ? kind === 'text' || kind === 'image' : kind === 'video' || kind === 'image');

  /* ---------------------------------------------------------------- bin */
  $$('.bin-tabs button').forEach(b => b.addEventListener('click', () => { $$('.bin-tabs button').forEach(x => x.classList.toggle('on', x === b)); $$('.bin-pane').forEach(x => { x.hidden = x.id !== 'bp-' + b.dataset.bt; }); }));
  $('#binImport').addEventListener('click', async () => { const f = await S.open('any', true); if (f.length) addFiles(f, { binOnly: !!ed.p.clips.length }); });
  $('#binSubs').addEventListener('click', async () => { const f = (await S.open('subs'))[0]; if (f) importSubs(f); });
  function renderBin() {
    const L = $('#binList'); L.innerHTML = '';
    const srcs = Object.keys(ed.p.media);
    if (!srcs.length) L.appendChild(h('div', { class: 'empty sm', style: 'grid-column:1/-1' }, App.icon('i-upload'), h('span', { text: t('bin_empty') })));
    srcs.forEach(src => {
      const m = ed.p.media[src];
      const used = ed.p.clips.some(c => c.src === src);
      const a = h('div', { class: 'asset' + (m.proxying != null ? ' proxying' : ''), draggable: 'true', dataset: { src }, title: App.base(src) },
        m.thumb ? h('img', { src: m.thumb, alt: '' }) : h('div', { class: 'ai' }, App.icon(m.kind === 'audio' ? 'i-music' : m.kind === 'image' ? 'i-image' : 'i-film')),
        h('div', { class: 'meta' }, h('span', { text: App.base(src) }), h('b', { text: m.kind === 'image' ? `${m.w}×${m.h}` : App.fmtTime(m.duration, false) })),
        h('button', { class: 'add', title: t('add_to_tl'), onclick: e => { e.stopPropagation(); addFiles([src]); } }, App.icon('i-plus')));
      if (!used) a.style.opacity = '.8';
      a.addEventListener('dragstart', e => { e.dataTransfer.setData('text/x-7krh-src', src); e.dataTransfer.effectAllowed = 'copy'; });
      a.addEventListener('dblclick', () => addFiles([src]));
      L.appendChild(a);
    });
  }
  /* text presets + transitions */
  function renderPresets() {
    const tp = $('#textPresets'); tp.innerHTML = '';
    TextLayer.PRESETS.forEach(pr => {
      const c = TextLayer.draw({ ...TextLayer.DEF, ...pr, s: t('tp_' + pr.key), size: 30 }, 1).canvas;
      const el = h('div', { class: 'tpre', draggable: 'true', title: t('tp_' + pr.key) }, h('img', { src: c.toDataURL(), style: 'max-width:100%;max-height:44px' }));
      el.addEventListener('dragstart', e => e.dataTransfer.setData('text/x-7krh-text', pr.key));
      el.addEventListener('click', () => addText(pr.key));
      tp.appendChild(el);
    });
    const tl = $('#transList'); tl.innerHTML = '';
    TL.TRANSITIONS.forEach(k => {
      const el = h('div', { class: 'tcard', draggable: 'true', text: t('tr_' + k) });
      el.addEventListener('dragstart', e => e.dataTransfer.setData('text/x-7krh-trans', k));
      el.addEventListener('click', () => { const c = selClip(); if (c && TL.isVisual(c)) setTransition(c, 'tin', k); else App.toast(t('trans_pick')); });
      tl.appendChild(el);
    });
  }
  function addText(key = 'title', at, trackId) {
    const pr = TextLayer.PRESETS.find(x => x.key === key) || TextLayer.PRESETS[0];
    const { key: _k, sub, ...style } = pr; // eslint-disable-line no-unused-vars
    const text = { ...TextLayer.DEF, ...style, s: t('tp_' + pr.key + '_s') };
    let tr = trackId ? ed.p.tracks.find(x => x.id === trackId) : null;
    if (!tr || tr.kind !== 'text') tr = ed.p.tracks.find(x => x.kind === 'text' && !!x.sub === !!sub) || addTrack('text', sub ? { sub: true, name: t('tk_subs') } : {});
    const c = TL.normClip({ id: TL.uid(), kind: 'text', track: tr.id, in: 0, out: 3, start: at != null ? at : pv.t, fit: 'none', text, tf: { x: 0, y: sub ? 0.38 : 0, s: 1, r: 0, o: 1 } });
    mut(() => ed.p.clips.push(c)); select(c.id); setInsTab('text');
  }
  async function importSubs(file) {
    let txt; try { txt = await S.readText(file); } catch (e) { App.toast(App.errText(e), 'err'); return; }
    const items = /\.(ass|ssa)$/i.test(file) ? TL.parseASS(txt) : TL.parseSRT(txt);
    if (!items.length) { App.toast(t('subs_none'), 'err'); return; }
    mut(() => {
      const tr = addTrack('text', { sub: true, name: t('tk_subs') + ' · ' + App.base(file) });
      const pr = TextLayer.PRESETS.find(x => x.key === 'sub');
      const { key: _k, sub: _s, ...style } = pr; // eslint-disable-line no-unused-vars
      items.forEach(it => ed.p.clips.push(TL.normClip({ id: TL.uid(), kind: 'text', track: tr.id, in: 0, out: it.end - it.start, start: it.start, fit: 'none', text: { ...TextLayer.DEF, ...style, s: it.text }, tf: { x: 0, y: 0.38, s: 1, r: 0, o: 1 } })));
    });
    App.toast(t('subs_done', { n: items.length }), 'ok');
  }

  /* ---------------------------------------------------------------- timeline view */
  const scroll = $('#tlScroll'), inner = $('#tlInner'), tracksEl = $('#tracks');
  const x2t = x => Math.max(0, x / ed.pps), t2x = tt => tt * ed.pps;
  function zoomTo(v) { // slider 0..100 → 6..600 px per second
    const old = ed.pps; ed.pps = Math.round(6 * Math.pow(100, v / 100));
    const center = (scroll.scrollLeft + scroll.clientWidth / 2) / old;
    renderTimeline(); scroll.scrollLeft = Math.max(0, center * ed.pps - scroll.clientWidth / 2);
  }
  $('#eZoom').addEventListener('input', e => zoomTo(+e.target.value));
  $('#eZin').addEventListener('click', () => { $('#eZoom').value = Math.min(100, +$('#eZoom').value + 8); zoomTo(+$('#eZoom').value); });
  $('#eZout').addEventListener('click', () => { $('#eZoom').value = Math.max(0, +$('#eZoom').value - 8); zoomTo(+$('#eZoom').value); });
  scroll.addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); $('#eZoom').value = Math.max(0, Math.min(100, +$('#eZoom').value - Math.sign(e.deltaY) * 5)); zoomTo(+$('#eZoom').value); } }, { passive: false });
  scroll.addEventListener('scroll', () => { $('#tlHeads').scrollTop = scroll.scrollTop; });
  function renderTimeline() {
    const p = ed.p, dur = TL.duration(p);
    const width = Math.max(scroll.clientWidth, t2x(dur + 30));
    inner.style.width = width + 'px';
    // ruler
    const ru = $('#ruler'); ru.innerHTML = '';
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const major = steps.find(s => s * ed.pps >= 80) || 600, minor = major / 5;
    for (let x = 0; x * minor * ed.pps < width; x++) {
      const tt = x * minor, isMaj = Math.abs(tt / major - Math.round(tt / major)) < 1e-6;
      ru.appendChild(h('div', { class: 'tick' + (isMaj ? '' : ' minor'), style: `left:${t2x(tt)}px`, text: isMaj ? App.fmtTime(tt, major < 1) : '' }));
    }
    // heads + rows
    const heads = $('#tlHeads'); heads.innerHTML = ''; tracksEl.innerHTML = '';
    p.tracks.forEach(tr => {
      const th = TH[tr.kind];
      heads.appendChild(h('div', { class: 'thead', style: `--th:${th}px` },
        h('span', { class: 'tk', text: tr.kind === 'audio' ? 'A' : tr.kind === 'text' ? (tr.sub ? 'CC' : 'T') : 'V' }),
        h('span', { class: 'tn', text: tr.name, title: tr.name, ondblclick: e => renameTrack(tr, e.target) }),
        tr.kind === 'audio' ? h('button', { class: tr.duck ? '' : 'dim', title: t('duck'), style: tr.duck ? 'color:var(--acc-2)' : '', onclick: () => mut(() => { tr.duck = !tr.duck; }) }, App.icon('i-music')) : null,
        tr.kind !== 'text' ? h('button', { class: tr.mute ? 'off' : '', title: t('mute_track'), onclick: () => mut(() => { tr.mute = !tr.mute; }) }, App.icon(tr.mute ? 'i-mute' : 'i-vol')) : null,
        tr.kind !== 'audio' ? h('button', { class: tr.hidden ? 'off' : '', title: t('hide_track'), onclick: () => mut(() => { tr.hidden = !tr.hidden; }) }, App.icon(tr.hidden ? 'i-eyeoff' : 'i-eye')) : null,
        h('button', { title: t('del_track'), onclick: () => delTrack(tr) }, App.icon('i-x'))));
      const row = h('div', { class: 'trow', style: `--th:${th}px`, dataset: { track: tr.id } });
      p.clips.filter(c => c.track === tr.id).sort((a, b) => a.start - b.start).forEach(c => row.appendChild(clipEl(c)));
      tracksEl.appendChild(row);
    });
    heads.appendChild(h('div', { style: 'padding:6px 8px;display:flex;gap:4px' },
      h('button', { class: 'btn sm ghost', onclick: () => mut(() => addTrack('video')) }, App.icon('i-plus'), 'V'),
      h('button', { class: 'btn sm ghost', onclick: () => mut(() => addTrack('audio')) }, App.icon('i-plus'), 'A'),
      h('button', { class: 'btn sm ghost', onclick: () => mut(() => addTrack('text')) }, App.icon('i-plus'), 'T')));
    placeHead(pv.t);
    $('#pvEmpty').hidden = !!p.clips.length;
  }
  function renameTrack(tr, el) {
    const v = prompt(t('rename'), tr.name); // simple and reliable inside Electron
    if (v && v.trim()) mut(() => { tr.name = v.trim(); });
    void el;
  }
  async function delTrack(tr) {
    const n = ed.p.clips.filter(c => c.track === tr.id).length;
    if (n && !(await App.ask(t('del_track'), t('del_track_q', { n })))) return;
    mut(() => { ed.p.clips = ed.p.clips.filter(c => c.track !== tr.id); ed.p.tracks = ed.p.tracks.filter(x => x !== tr); });
  }
  function clipEl(c) {
    const w = Math.max(6, t2x(TL.len(c)));
    const m = ed.p.media[c.src] || {};
    const label = c.kind === 'text' ? (c.text && c.text.s || '').replace(/\n/g, ' ') : App.base(c.src);
    const el = h('div', { class: `clip ${c.kind}${c.id === ed.sel ? ' sel' : ''}`, style: `left:${t2x(c.start)}px;width:${w}px`, dataset: { id: c.id } },
      h('div', { class: 'cl', text: label }), h('div', { class: 'hdl l' }), h('div', { class: 'hdl r' }));
    const badges = [];
    if (c.speed !== 1) badges.push(c.speed + '×'); if (c.reverse) badges.push('↺'); if (c.mute && c.kind !== 'text') badges.push('🔇');
    if (!TL.colorIsIdentity(c.adj)) badges.push('FX'); if (c.denoise !== 'off' && TL.hasSound(ed.p, { ...c, mute: false })) badges.push('DN');
    if (badges.length) el.appendChild(h('div', { class: 'badges' }, badges.map(b => h('i', { text: b }))));
    if (c.tin && c.tin.dur) el.appendChild(h('div', { class: 'tin', style: `width:${t2x(c.tin.dur)}px`, title: t('tr_' + c.tin.type) }));
    if (c.tout && c.tout.dur) el.appendChild(h('div', { class: 'tout', style: `width:${t2x(c.tout.dur)}px`, title: t('tr_' + c.tout.type) }));
    const kts = new Set(); Object.values(c.kf || {}).forEach(a => (a || []).forEach(k => kts.add(k.t)));
    kts.forEach(k => el.appendChild(h('div', { class: 'kfd', style: `left:${t2x(k)}px` })));
    if (c.kind === 'video' && m.kind === 'video') filmstrip(el, c, w);
    if ((c.kind === 'audio' || (c.kind === 'video' && m.hasAudio)) && TH[(TL.trackOf(ed.p, c) || {}).kind] >= 40) wave(el, c, w);
    return el;
  }
  function filmstrip(el, c, w) {
    const n = Math.max(1, Math.min(14, Math.round(w / 80)));
    const key = `${c.src}|${c.in.toFixed(2)}|${c.out.toFixed(2)}|${n}`;
    const box = h('div', { class: 'film' }); el.prepend(box);
    const fill = list => { box.innerHTML = ''; list.forEach(u => u && box.appendChild(h('img', { src: u, style: `width:${w / n}px` }))); };
    if (thumbCache.has(key)) { const v = thumbCache.get(key); if (Array.isArray(v)) fill(v); else v.then(fill); return; }
    const pr = S.thumbs(c.src, c.out - c.in, n, 44, c.in).then(l => { thumbCache.set(key, l); return l; }).catch(() => []);
    thumbCache.set(key, pr); pr.then(fill);
  }
  function wave(el, c, w) {
    const key = `${c.src}|${c.in.toFixed(2)}|${c.out.toFixed(2)}`;
    const cv = h('canvas', { class: 'wave' }); el.appendChild(cv);
    const paint = pk => {
      const W = Math.max(2, Math.round(w)), H = 40; cv.width = W; cv.height = H; const x = cv.getContext('2d');
      x.fillStyle = c.kind === 'audio' ? 'rgba(91,227,168,.75)' : 'rgba(255,255,255,.35)';
      const g = Math.min(2, TL.gainAt(ed.p, c, 0) || c.volume || 1);
      for (let i = 0; i < W; i++) { const v = pk[Math.floor(i / W * pk.length)] || 0; const hh = Math.max(1, Math.min(1, v * g) * (H - 4)); x.fillRect(i, H - hh - 2, 1, hh); }
    };
    if (peakCache.has(key)) { const v = peakCache.get(key); if (Array.isArray(v)) paint(v); else v.then(paint); return; }
    const pr = S.peaks(c.src, c.in, c.out - c.in, 600).then(l => { peakCache.set(key, l); return l; }).catch(() => []);
    peakCache.set(key, pr); pr.then(paint);
  }
  function placeHead(tt) {
    $('#playhead').style.left = t2x(tt) + 'px';
    if (pv.playing) { const x = t2x(tt); if (x > scroll.scrollLeft + scroll.clientWidth - 40) scroll.scrollLeft = x - 80; }
  }
  /* ruler: click / drag to seek */
  $('#ruler').addEventListener('pointerdown', e => {
    const r = inner.getBoundingClientRect();
    const go = ev => pv.seek(snapT(x2t(ev.clientX - r.left), null, true));
    go(e); $('#ruler').setPointerCapture(e.pointerId);
    const mv = ev => go(ev), up = () => { $('#ruler').removeEventListener('pointermove', mv); $('#ruler').removeEventListener('pointerup', up); };
    $('#ruler').addEventListener('pointermove', mv); $('#ruler').addEventListener('pointerup', up);
  });
  function snapT(tt, skip, quiet) {
    if (!ed.snap) return tt;
    const r = TL.snap(ed.p, tt, 8 / ed.pps, skip, [pv.t]);
    if (!quiet) { const sl = $('#snapline'); sl.hidden = r === tt; sl.style.left = t2x(r) + 'px'; }
    return r;
  }
  /* clip move / trim */
  tracksEl.addEventListener('pointerdown', e => {
    const el = e.target.closest('.clip');
    if (!el) { if (e.target.closest('.trow')) { pv.seek(x2t(e.clientX - inner.getBoundingClientRect().left)); select(null); } return; }
    const c = clip(el.dataset.id); if (!c) return;
    select(c.id);
    const mode = e.target.classList.contains('hdl') ? (e.target.classList.contains('l') ? 'l' : 'r') : 'move';
    const r0 = inner.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
    const o = { start: c.start, in: c.in, out: c.out, track: c.track };
    const m = ed.p.media[c.src] || {};
    const maxSrc = c.kind === 'video' || c.kind === 'audio' ? (m.duration || c.out) : Infinity;
    el.setPointerCapture(e.pointerId); begin();
    let moved = false;
    const mv = ev => {
      const dt = (ev.clientX - x0) / ed.pps;
      if (Math.abs(ev.clientX - x0) > 3 || Math.abs(ev.clientY - y0) > 3) moved = true;
      if (!moved) return;
      if (mode === 'move') {
        let ns = Math.max(0, o.start + dt);
        const e1 = snapT(ns, c.id), e2 = snapT(ns + TL.len(c), c.id);
        if (e1 !== ns) ns = e1; else if (e2 !== ns + TL.len(c)) ns = e2 - TL.len(c);
        c.start = Math.max(0, Math.round(ns * 1000) / 1000);
        const row = document.elementFromPoint(ev.clientX, ev.clientY);
        const tr = row && row.closest && row.closest('.trow');
        if (tr && tr.dataset.track !== c.track) { const T2 = ed.p.tracks.find(x => x.id === tr.dataset.track); if (compatible(T2, c.kind === 'text' ? 'text' : c.kind)) c.track = T2.id; }
      } else if (mode === 'l') {
        // trims the start: timeline start and source in move together
        let ns = snapT(Math.max(0, o.start + dt), c.id);
        let din = (ns - o.start) * c.speed;
        if (c.kind === 'video' || c.kind === 'audio') din = Math.max(-o.in, din);
        din = Math.min(din, (o.out - o.in) - 0.1 * c.speed);
        if (c.reverse) { c.out = o.out - din; } else c.in = o.in + din;
        c.start = o.start + din / c.speed;
      } else {
        let ne = snapT(o.start + (o.out - o.in) / c.speed + dt, c.id);
        let nout = o.in + (ne - o.start) * c.speed;
        nout = Math.max(o.in + 0.1 * c.speed, Math.min(maxSrc, nout));
        if (c.reverse) c.in = Math.max(0, o.out - (nout - o.in)); else c.out = nout;
      }
      if (c.kind === 'image' || c.kind === 'text') { c.in = 0; }
      renderTimeline(); pv.draw();
    };
    const up = () => {
      el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); $('#snapline').hidden = true;
      if (moved && mode === 'move' && ed.ripple && o.track === c.track) { /* free placement on move; ripple only on delete */ }
      end(); renderAll();
    };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  });
  tracksEl.addEventListener('dblclick', e => { const el = e.target.closest('.clip'); if (el) { const c = clip(el.dataset.id); if (c && c.kind === 'text') setInsTab('text'); } });
  /* drops on tracks: bin assets, text presets, transitions, files from Explorer */
  tracksEl.addEventListener('dragover', e => {
    const row = e.target.closest('.trow'); if (!row) return;
    e.preventDefault(); $$('.trow').forEach(r => r.classList.remove('drop-ok')); row.classList.add('drop-ok');
  });
  tracksEl.addEventListener('dragleave', e => { const row = e.target.closest('.trow'); if (row) row.classList.remove('drop-ok'); });
  tracksEl.addEventListener('drop', async e => {
    const row = e.target.closest('.trow'); $$('.trow').forEach(r => r.classList.remove('drop-ok'));
    if (!row) return;
    e.preventDefault(); e._handled = true;
    const at = snapT(x2t(e.clientX - inner.getBoundingClientRect().left), null, true);
    const src = e.dataTransfer.getData('text/x-7krh-src'), tk = e.dataTransfer.getData('text/x-7krh-text'), tr = e.dataTransfer.getData('text/x-7krh-trans');
    if (tr) { const el = e.target.closest('.clip'); const c = el && clip(el.dataset.id); if (c && TL.isVisual(c)) { const x = e.clientX - el.getBoundingClientRect().left; setTransition(c, x > el.offsetWidth / 2 ? 'tout' : 'tin', tr); } return; }
    if (tk) return addText(tk, at, row.dataset.track);
    if (src) return addFiles([src], { at, track: row.dataset.track });
    const files = [...e.dataTransfer.files].map(f => S.pathOf(f)).filter(Boolean);
    if (files.length) { await S.dropped(files); addFiles(files, { at, track: row.dataset.track }); }
  });
  /* canvas accepts files too */
  viewer.addEventListener('dragover', e => e.preventDefault());
  viewer.addEventListener('drop', e => {
    e.preventDefault(); e._handled = true;
    const src = e.dataTransfer.getData('text/x-7krh-src'), tk = e.dataTransfer.getData('text/x-7krh-text');
    if (tk) return addText(tk);
    if (src) return addFiles([src]);
    const files = [...e.dataTransfer.files].map(f => S.pathOf(f)).filter(Boolean);
    if (files.length) S.dropped(files).then(() => addFiles(files));
  });
  /* resize the timeline panel */
  $('#edBottom').addEventListener('pointerdown', e => {
    const b = $('#edBottom'); const r = b.getBoundingClientRect(); if (e.clientY - r.top > 6) return;
    const y0 = e.clientY, h0 = r.height; b.setPointerCapture(e.pointerId);
    const mv = ev => { b.style.height = Math.max(160, Math.min(window.innerHeight * 0.7, h0 - (ev.clientY - y0))) + 'px'; };
    const up = () => { b.removeEventListener('pointermove', mv); b.removeEventListener('pointerup', up); };
    b.addEventListener('pointermove', mv); b.addEventListener('pointerup', up);
  });

  /* ---------------------------------------------------------------- edit commands */
  function select(id) {
    ed.sel = id; pv.sel = selClip() || null;
    $$('.clip').forEach(x => x.classList.toggle('sel', x.dataset.id === id));
    const c = selClip();
    if (c && ed.insTab === 'text' && c.kind !== 'text') ed.insTab = 'clip';
    if (c && c.kind === 'text' && ed.insTab === 'clip' && !c._seen) { c._seen = 1; }
    renderInspector(); pv.draw(); toolbarState();
  }
  function split() {
    const at = pv.t;
    const targets = selClip() ? [selClip()] : ed.p.clips.filter(c => at > c.start && at < TL.end(c));
    mut(() => targets.forEach(c => TL.split(ed.p, c.id, at)));
  }
  function del(rip) {
    const c = selClip(); if (!c) return;
    mut(() => {
      ed.p.clips = ed.p.clips.filter(x => x.id !== c.id);
      if (rip ?? ed.ripple) { const gap = TL.len(c); ed.p.clips.filter(x => x.track === c.track && x.start >= TL.end(c) - 1e-3).forEach(x => { x.start = Math.max(0, x.start - gap); }); }
    });
    select(null);
  }
  function duplicate() {
    const c = selClip(); if (!c) return;
    const d = TL.normClip({ ...JSON.parse(JSON.stringify(c)), id: TL.uid() });
    d.start = TL.end(c);
    mut(() => { ed.p.clips.filter(x => x.track === c.track && x.start >= TL.end(c) - 1e-3).forEach(x => { x.start += TL.len(c); }); ed.p.clips.push(d); });
    select(d.id);
  }
  function detachAudio() {
    const c = selClip(); if (!c || c.kind !== 'video' || !(ed.p.media[c.src] || {}).hasAudio) return App.toast(t('detach_no'));
    const tr = ed.p.tracks.find(x => x.kind === 'audio' && !ed.p.clips.some(y => y.track === x.id && y.start < TL.end(c) && TL.end(y) > c.start)) || addTrack('audio');
    mut(() => { ed.p.clips.push(TL.normClip({ ...JSON.parse(JSON.stringify(c)), id: TL.uid(), kind: 'audio', track: tr.id, tf: undefined, adj: undefined, tin: null, tout: null, kf: c.kf && c.kf.vol ? { vol: c.kf.vol } : {} })); c.mute = true; });
    App.toast(t('detach_done'), 'ok');
  }
  function copyFx() { const c = selClip(); if (!c) return; ed.fxClip = JSON.parse(JSON.stringify({ adj: c.adj, tf: c.tf, tin: c.tin, tout: c.tout, speed: c.speed, denoise: c.denoise, volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut, text: c.kind === 'text' ? { ...c.text, s: undefined } : null })); App.toast(t('fx_copied'), '', 1800); toolbarState(); }
  function pasteFx() {
    const c = selClip(); if (!c || !ed.fxClip) return;
    mut(() => {
      const f = ed.fxClip;
      if (TL.isVisual(c)) { c.adj = { ...f.adj }; c.tf = { ...f.tf }; c.tin = f.tin && { ...f.tin }; c.tout = f.tout && { ...f.tout }; }
      if (c.kind !== 'text' && c.kind !== 'image') { c.denoise = f.denoise; c.volume = f.volume; c.fadeIn = f.fadeIn; c.fadeOut = f.fadeOut; }
      if (c.kind === 'text' && f.text) { const s = c.text.s; c.text = { ...c.text, ...f.text, s }; }
    });
  }
  function setTransition(c, side, type) {
    mut(() => {
      const prevEnd = side === 'tin' ? ed.p.clips.filter(x => x.track === c.track && x.id !== c.id && Math.abs(TL.end(x) - c.start) < 0.05)[0] : null;
      const dur = Math.min(0.6, TL.len(c) / 2);
      c[side] = { type, dur };
      // a crossfade needs the two clips to overlap: the clip (and the ones after it) move left by the duration
      if (prevEnd && ed.ripple && /dissolve|slide|zoom/.test(type)) {
        const shift = Math.min(dur, TL.len(prevEnd) / 2);
        ed.p.clips.filter(x => x.track === c.track && x.start >= c.start - 1e-3).forEach(x => { x.start = Math.max(0, x.start - shift); });
        c[side].dur = shift;
      }
    });
    select(c.id); setInsTab('clip');
  }
  $('#eUndo').addEventListener('click', undo); $('#eRedo').addEventListener('click', redo);
  $('#eSplit').addEventListener('click', split); $('#eDel').addEventListener('click', () => del());
  $('#eDup').addEventListener('click', duplicate); $('#eDetach').addEventListener('click', detachAudio);
  $('#eCopyFx').addEventListener('click', copyFx); $('#ePasteFx').addEventListener('click', pasteFx);
  $('#eText').addEventListener('click', () => addText('title'));
  $('#eSnap').addEventListener('click', () => { ed.snap = !ed.snap; toolbarState(); });
  $('#eRipple').addEventListener('click', () => { ed.ripple = !ed.ripple; toolbarState(); });
  function toolbarState() {
    const c = selClip();
    $('#eUndo').disabled = !ed.undo.length; $('#eRedo').disabled = !ed.redo.length;
    $('#eDel').disabled = $('#eDup').disabled = $('#eCopyFx').disabled = !c;
    $('#eDetach').disabled = !(c && c.kind === 'video' && (ed.p.media[c.src] || {}).hasAudio);
    $('#ePasteFx').disabled = !(c && ed.fxClip);
    $('#eSplit').disabled = !ed.p.clips.some(x => pv.t > x.start && pv.t < TL.end(x));
    $('#eSnap').classList.toggle('on', ed.snap); $('#eRipple').classList.toggle('on', ed.ripple);
    $('#tlHint').textContent = c ? `${App.base(c.kind === 'text' ? (c.text.s || '').slice(0, 24) : c.src)} · ${App.fmtTime(TL.len(c))}` : '';
  }
  const tips = { eUndo: 'k_undo', eRedo: 'k_redo', eSplit: 'k_split', eDel: 'k_del', eDup: 'k_dup', eDetach: 'k_detach', eCopyFx: 'k_copyfx', ePasteFx: 'k_pastefx', eText: 'k_text', eSnap: 'k_snap', eRipple: 'k_ripple', tStart: 'k_start' };
  Object.entries(tips).forEach(([id, k]) => { const el = document.getElementById(id); if (el) el.dataset.it = k; });

  /* keyboard (only while the montage view is open and nothing is being typed) */
  document.addEventListener('keydown', e => {
    if (App.view !== 'edit' || App.typing() || !$('#dlg').hidden) return;
    const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (ctrl && k === 's') { e.preventDefault(); save(e.shiftKey); }
    else if (ctrl && k === 'd') { e.preventDefault(); duplicate(); }
    else if (ctrl && k === 'c') { copyFx(); }
    else if (ctrl && k === 'v') { pasteFx(); }
    else if (ctrl && k === 'e') { e.preventDefault(); exportDialog(); }
    else if (k === 's' || k === 'b') split();
    else if (k === 'delete' || k === 'backspace') { e.preventDefault(); del(e.shiftKey ? !ed.ripple : undefined); }
    else if (k === 'arrowleft') { e.preventDefault(); step(e.shiftKey ? -10 : -1); }
    else if (k === 'arrowright') { e.preventDefault(); step(e.shiftKey ? 10 : 1); }
    else if (k === 'home') pv.seek(0); else if (k === 'end') pv.seek(TL.duration(ed.p));
    else if (k === 't') addText('title');
    else if (k === '+' || k === '=') $('#eZin').click(); else if (k === '-') $('#eZout').click();
    else if (k === 'escape') select(null);
  });

  /* ---------------------------------------------------------------- inspector */
  function setInsTab(tb) { ed.insTab = tb; renderInspector(); }
  const ins = $('#insp');
  function num(label, value, onInput, o = {}) {
    const inp = h('input', { type: 'number', step: o.step || 1, min: o.min, max: o.max, value: Math.round(value * (o.k || 1) * 100) / 100 });
    const rng = o.range !== false ? h('input', { type: 'range', min: o.rmin ?? o.min, max: o.rmax ?? o.max, step: o.step || 1, value: value * (o.k || 1) }) : null;
    const fire = v => { onInput(+v / (o.k || 1)); };
    inp.addEventListener('change', () => { begin(); fire(inp.value); end(); });
    if (rng) { rng.addEventListener('pointerdown', begin); rng.addEventListener('input', () => { inp.value = rng.value; fire(rng.value); }); rng.addEventListener('change', end); }
    const kf = o.kf ? h('button', { class: 'kfbtn', title: t('keyframe'), dataset: { kf: o.kf }, onclick: () => toggleKf(selClip(), o.kf) }, App.icon('i-diamond')) : h('span');
    return h('div', { class: 'prop' }, h('label', {}, h('span', { text: label }), o.unit ? h('small', { text: o.unit }) : null), rng || h('span'), inp, kf);
  }
  function seg(values, cur, onPick, labels) {
    return h('div', { class: 'seg' }, values.map((v, i) => h('button', { class: String(v) === String(cur) ? 'on' : '', text: labels ? labels[i] : String(v), onclick: () => onPick(v) })));
  }
  function refreshKfButtons() {
    const c = selClip(); if (!c) return;
    const u = pv.t - c.start;
    $$('.kfbtn', ins).forEach(b => {
      const arr = c.kf[b.dataset.kf] || [];
      b.classList.toggle('has', arr.length > 0); b.classList.toggle('at', arr.some(x => Math.abs(x.t - u) < fpsStep()));
    });
    // live values while scrubbing animated properties
    $$('.prop[data-live]', ins).forEach(pEl => { const k = pEl.dataset.live; const v = TL.stateAt(c, u)[k]; const mul = +pEl.dataset.mul || 1; const inp = pEl.querySelector('input[type=number]'); if (inp && document.activeElement !== inp) inp.value = Math.round(v * mul * 100) / 100; const r = pEl.querySelector('input[type=range]'); if (r) r.value = v * mul; });
  }
  function renderInspector(soft) {
    if (soft) { refreshKfButtons(); return; }
    ins.innerHTML = '';
    const c = selClip();
    if (!c) return projectPanel();
    const visual = TL.isVisual(c), audible = c.kind === 'audio' || (c.kind === 'video' && (ed.p.media[c.src] || {}).hasAudio);
    const tabs = [['clip', visual ? 'it_clip' : 'it_audio']];
    if (c.kind === 'text') tabs.unshift(['text', 'it_text']);
    if (visual) tabs.push(['color', 'it_color']);
    if (visual && audible) tabs.push(['sound', 'it_audio']);
    if (!tabs.some(x => x[0] === ed.insTab)) ed.insTab = tabs[0][0];
    ins.append(h('div', { class: 'ihead' }, App.icon(c.kind === 'text' ? 'i-text' : c.kind === 'audio' ? 'i-music' : c.kind === 'image' ? 'i-image' : 'i-film'), h('b', { text: c.kind === 'text' ? (c.text.s || '').split('\n')[0] : App.base(c.src) }), h('span', { class: 'sp' }), h('span', { class: 'tag', text: App.fmtTime(TL.len(c)) })));
    ins.append(h('div', { class: 'itabs' }, tabs.map(([k, l]) => h('button', { class: ed.insTab === k ? 'on' : '', text: t(l), onclick: () => setInsTab(k) }))));
    const pane = h('div', { class: 'ipane' }); ins.append(pane);
    const u = () => pv.t - c.start;
    const live = (k, el, m = 1) => { el.dataset.live = k; el.dataset.mul = m; return el; };
    if (ed.insTab === 'text' && c.kind === 'text') return textPanel(pane, c);
    if (ed.insTab === 'color') {
      const s = h('div', { class: 'sect' }, h('h4', {}, h('span', { text: t('adjust') }), h('button', { class: 'btn sm ghost', text: t('reset'), onclick: () => mut(() => { c.adj = { b: 0, c: 0, s: 0, g: 0, sh: 0 }; }) })));
      [['b', 'bright', -100, 100], ['c', 'contrast', -100, 100], ['s', 'sat', -100, 100], ['g', 'gamma', -100, 100], ['sh', 'sharpen', 0, 100]].forEach(([k, l, a, b]) => s.append(num(t(l), c.adj[k] || 0, v => { c.adj[k] = v; pv.draw(); }, { min: a, max: b })));
      s.append(h('p', { class: 'hint', text: t('color_same') }));
      pane.append(s); return;
    }
    if (ed.insTab === 'sound' || (ed.insTab === 'clip' && !visual)) { soundPanel(pane, c); if (!visual) speedPanel(pane, c); return; }
    // clip: transform, fit, speed, transitions
    const tf = h('div', { class: 'sect' }, h('h4', {}, h('span', { text: t('transform') }), h('button', { class: 'btn sm ghost', text: t('reset'), onclick: () => mut(() => { c.tf = { x: 0, y: 0, s: 1, r: 0, o: 1 }; c.kf = c.kf.vol ? { vol: c.kf.vol } : {}; }) })));
    tf.append(live('x', num(t('pos_x'), baseVal(c, 'x', u()), v => setProp(c, 'x', v, u(), true) || pv.draw(), { min: -150, max: 150, k: 100, unit: '%', kf: 'x' }), 100));
    tf.append(live('y', num(t('pos_y'), baseVal(c, 'y', u()), v => setProp(c, 'y', v, u(), true) || pv.draw(), { min: -150, max: 150, k: 100, unit: '%', kf: 'y' }), 100));
    tf.append(live('s', num(t('scale'), baseVal(c, 's', u()), v => setProp(c, 's', Math.max(0.01, v), u(), true) || pv.draw(), { min: 1, max: 400, k: 100, unit: '%', kf: 's' }), 100));
    tf.append(live('r', num(t('rotate'), baseVal(c, 'r', u()), v => setProp(c, 'r', v, u(), true) || pv.draw(), { min: -180, max: 180, unit: '°', kf: 'r' })));
    tf.append(live('o', num(t('opacity'), baseVal(c, 'o', u()), v => setProp(c, 'o', Math.max(0, Math.min(1, v)), u(), true) || pv.draw(), { min: 0, max: 100, k: 100, unit: '%', kf: 'o' }), 100));
    tf.append(h('div', { class: 'field' }, h('label', { text: t('fit') }), seg(['contain', 'cover', 'none'], c.fit, v => mut(() => { c.fit = v; }), [t('fit_contain'), t('fit_cover'), t('fit_none')])));
    tf.append(h('p', { class: 'hint', text: t('kf_hint') }));
    pane.append(tf);
    if (c.kind === 'video') speedPanel(pane, c);
    const tr = h('div', { class: 'sect' }, h('h4', { text: t('transitions') }));
    for (const side of ['tin', 'tout']) {
      const cur = c[side] || {};
      const sel = h('select', {}, h('option', { value: '', text: t('tr_none') }), TL.TRANSITIONS.map(k => h('option', { value: k, text: t('tr_' + k), selected: cur.type === k })));
      sel.addEventListener('change', () => { if (sel.value) setTransition(c, side, sel.value); else mut(() => { c[side] = null; }); });
      const d = h('input', { type: 'number', min: 0.1, max: 3, step: 0.1, value: cur.dur || 0.5, disabled: !cur.type });
      d.addEventListener('change', () => mut(() => { if (c[side]) c[side].dur = Math.max(0.05, Math.min(TL.len(c) / 2, +d.value)); }));
      tr.append(h('div', { class: 'two' }, h('div', { class: 'field' }, h('label', { text: t(side === 'tin' ? 'tr_in' : 'tr_out') }), sel), h('div', { class: 'field' }, h('label', { text: t('seconds') }), d)));
    }
    pane.append(tr);
    refreshKfButtons();
  }
  function speedPanel(pane, c) {
    const s = h('div', { class: 'sect' }, h('h4', { text: t('speed') }));
    s.append(seg([0.25, 0.5, 1, 1.5, 2, 4], c.speed, v => setSpeed(c, v), ['0.25×', '0.5×', '1×', '1.5×', '2×', '4×']));
    s.append(num(t('speed_custom'), c.speed, v => setSpeed(c, v, true), { min: 0.1, max: 16, step: 0.05, range: false }));
    if (c.kind === 'video') {
      const rv = h('input', { type: 'checkbox', checked: !!c.reverse });
      rv.addEventListener('change', () => { if (rv.checked && c.out - c.in > 60) { rv.checked = false; App.toast(t('reverse_long')); return; } mut(() => { c.reverse = rv.checked; }); });
      s.append(h('label', { class: 'toggle', style: 'margin-top:12px' }, rv, h('span', { class: 'sw' }), h('span', {}, h('b', { text: t('reverse') }), h('small', { text: t('reverse_sub') }))));
    }
    pane.append(s);
  }
  function setSpeed(c, v, typed) {
    v = Math.max(0.1, Math.min(16, +v || 1));
    mut(() => { const oldEnd = TL.end(c); c.speed = v; const d = TL.end(c) - oldEnd; if (ed.ripple) ed.p.clips.filter(x => x.track === c.track && x.id !== c.id && x.start >= oldEnd - 1e-3).forEach(x => { x.start = Math.max(0, x.start + d); }); });
    if (!typed) renderInspector();
  }
  function soundPanel(pane, c) {
    const s = h('div', { class: 'sect' }, h('h4', { text: t('it_audio') }));
    const mute = h('input', { type: 'checkbox', checked: !c.mute });
    mute.addEventListener('change', () => mut(() => { c.mute = !mute.checked; }));
    s.append(h('label', { class: 'toggle' }, mute, h('span', { class: 'sw' }), h('span', {}, h('b', { text: t('sound_on') }))));
    s.append(num(t('a_vol'), c.volume, v => { setProp(c, 'vol', Math.max(0, v), pv.t - c.start, true); }, { min: 0, max: 200, k: 100, unit: '%', kf: 'vol' }));
    s.append(h('div', { class: 'two' },
      h('div', { class: 'field' }, h('label', { text: t('fade_in') }), (() => { const i = h('input', { type: 'number', min: 0, step: 0.1, value: c.fadeIn }); i.addEventListener('change', () => mut(() => { c.fadeIn = Math.max(0, Math.min(TL.len(c), +i.value)); })); return i; })()),
      h('div', { class: 'field' }, h('label', { text: t('fade_out') }), (() => { const i = h('input', { type: 'number', min: 0, step: 0.1, value: c.fadeOut }); i.addEventListener('change', () => mut(() => { c.fadeOut = Math.max(0, Math.min(TL.len(c), +i.value)); })); return i; })())));
    const dn = h('select', {}, ['off', 'light', 'ai'].map(v => h('option', { value: v, text: t('dn_' + v), selected: c.denoise === v })));
    dn.addEventListener('change', () => mut(() => { c.denoise = dn.value; }));
    s.append(h('div', { class: 'field' }, h('label', { text: t('aud_denoise') }), dn), h('p', { class: 'hint', text: t('dn_hint') }));
    pane.append(s);
    const tr = TL.trackOf(ed.p, c);
    if (tr && tr.kind === 'audio') {
      const dk = h('input', { type: 'checkbox', checked: !!tr.duck });
      dk.addEventListener('change', () => mut(() => { tr.duck = dk.checked; }));
      pane.append(h('div', { class: 'sect' }, h('label', { class: 'toggle' }, dk, h('span', { class: 'sw' }), h('span', {}, h('b', { text: t('duck') }), h('small', { text: t('duck_sub') })))));
    }
  }
  function textPanel(pane, c) {
    const T = c.text;
    const upd = (k, v, hard) => { T[k] = v; pv.draw(); if (hard) changed(); };
    const s = h('div', { class: 'sect' });
    const ta = h('textarea', { rows: 3 }); ta.value = T.s;
    ta.addEventListener('focus', begin); ta.addEventListener('input', () => { upd('s', ta.value); $(`.clip[data-id="${c.id}"] .cl`) && ($(`.clip[data-id="${c.id}"] .cl`).textContent = ta.value.replace(/\n/g, ' ')); }); ta.addEventListener('blur', end);
    s.append(h('div', { class: 'field', style: 'margin-top:0' }, h('label', { text: t('txt_content') }), ta));
    const font = h('select', {}, TextLayer.FONTS.map(f => h('option', { value: f, text: f, selected: T.font === f, style: `font-family:"${f}"` })));
    font.addEventListener('change', () => mut(() => upd('font', font.value)));
    s.append(h('div', { class: 'field' }, h('label', { text: t('txt_font') }), font));
    s.append(num(t('txt_size'), T.size, v => upd('size', Math.max(6, v)), { min: 12, max: 400 }));
    s.append(h('div', { class: 'field' }, h('label', { text: t('txt_weight') }), seg([400, 600, 800], T.weight, v => mut(() => upd('weight', v)), [t('w_reg'), t('w_semi'), t('w_bold')])));
    s.append(h('div', { class: 'field' }, h('label', { text: t('txt_align') }), seg(['start', 'center', 'end'], T.align, v => mut(() => upd('align', v)), [t('al_start'), t('al_center'), t('al_end')])));
    const color = (label, k) => { const i = h('input', { type: 'color', value: T[k] || '#000000' }); i.addEventListener('input', () => upd(k, i.value)); i.addEventListener('change', () => changed()); return h('div', { class: 'field' }, h('label', { text: label }), i); };
    s.append(h('div', { class: 'three' }, color(t('txt_color'), 'color'), color(t('txt_stroke'), 'stroke'), color(t('txt_bg'), 'bg')));
    s.append(num(t('txt_strokeW'), T.strokeW || 0, v => upd('strokeW', Math.max(0, v)), { min: 0, max: 30 }));
    s.append(num(t('txt_shadow'), T.shadow || 0, v => upd('shadow', Math.max(0, v)), { min: 0, max: 100 }));
    const bgOn = h('input', { type: 'checkbox', checked: !!T.bg });
    bgOn.addEventListener('change', () => mut(() => upd('bg', bgOn.checked ? (T._bg || '#000000') : (T._bg = T.bg, ''))));
    s.append(h('label', { class: 'toggle', style: 'margin-top:12px' }, bgOn, h('span', { class: 'sw' }), h('span', {}, h('b', { text: t('txt_box') }))));
    s.append(num(t('txt_bgAlpha'), T.bgAlpha ?? 0.6, v => upd('bgAlpha', Math.max(0, Math.min(1, v))), { min: 0, max: 100, k: 100 }));
    s.append(h('p', { class: 'hint', text: t('txt_hint') }));
    pane.append(s);
  }
  function projectPanel() {
    const p = ed.p;
    ins.append(h('div', { class: 'ihead' }, App.icon('i-layers'), h('b', { text: t('project') })));
    const pane = h('div', { class: 'ipane' }); ins.append(pane);
    const s = h('div', { class: 'sect' });
    const presets = Object.entries(TL.PRESETS);
    const cur = presets.find(([, v]) => v.w === p.canvas.w && v.h === p.canvas.h);
    const ps = h('select', {}, presets.map(([k, v]) => h('option', { value: k, text: `${t('pr_' + k)} · ${App.ltr(v.w + '×' + v.h)}`, selected: cur && cur[0] === k })), cur ? null : h('option', { value: '', selected: true, text: `${t('pr_custom')} · ${App.ltr(p.canvas.w + '×' + p.canvas.h)}` }));
    ps.addEventListener('change', () => { const v = TL.PRESETS[ps.value]; if (v) mut(() => { p.canvas.w = v.w; p.canvas.h = v.h; }); pv.resize(viewer.clientWidth, viewer.clientHeight); });
    s.append(h('div', { class: 'field', style: 'margin-top:0' }, h('label', { text: t('canvas') }), ps));
    const wI = h('input', { type: 'number', min: 64, max: 4096, step: 2, value: p.canvas.w }), hI = h('input', { type: 'number', min: 64, max: 4096, step: 2, value: p.canvas.h });
    const apply = () => { mut(() => { p.canvas.w = Math.round(Math.max(64, Math.min(4096, +wI.value)) / 2) * 2; p.canvas.h = Math.round(Math.max(64, Math.min(4096, +hI.value)) / 2) * 2; }); pv.resize(viewer.clientWidth, viewer.clientHeight); };
    wI.addEventListener('change', apply); hI.addEventListener('change', apply);
    s.append(h('div', { class: 'two' }, h('div', { class: 'field' }, h('label', { text: t('width') }), wI), h('div', { class: 'field' }, h('label', { text: t('height') }), hI)));
    const fps = h('select', {}, [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120].map(f => h('option', { value: f, text: f + ' fps', selected: Math.abs(p.canvas.fps - f) < 0.01 })));
    fps.addEventListener('change', () => mut(() => { p.canvas.fps = +fps.value; }));
    const bg = h('input', { type: 'color', value: p.canvas.bg || '#000000' }); bg.addEventListener('change', () => mut(() => { p.canvas.bg = bg.value; }));
    s.append(h('div', { class: 'two' }, h('div', { class: 'field' }, h('label', { text: t('fps') }), fps), h('div', { class: 'field' }, h('label', { text: t('bg') }), bg)));
    pane.append(s);
    const k = h('div', { class: 'sect' }, h('div', { class: 'kv' },
      h('span', { text: t('o_dur') }), h('b', { text: App.fmtTime(TL.duration(p)) }),
      h('span', { text: t('clips') }), h('b', { text: String(p.clips.length) }),
      h('span', { text: t('tracks') }), h('b', { text: String(p.tracks.length) })));
    pane.append(k);
    const subs = TL.subtitleItems(p, null);
    pane.append(h('div', { class: 'sect' }, h('h4', { text: t('subtitles') }),
      h('div', { class: 'two', style: 'margin-top:10px' }, h('button', { class: 'btn sm', onclick: async () => { const f = (await S.open('subs'))[0]; if (f) importSubs(f); } }, App.icon('i-sub'), t('subs_import')),
        h('button', { class: 'btn sm', disabled: !subs.length, onclick: exportSrt }, App.icon('i-save'), t('subs_export'))),
      h('p', { class: 'hint', text: t('subs_hint') })));
    pane.append(h('p', { class: 'hint', text: t('shortcuts') }));
  }
  async function exportSrt() {
    const tr = ed.p.tracks.find(x => x.sub) || null;
    const items = TL.subtitleItems(ed.p, tr && tr.id);
    const f = await S.savePath((ed.p.name || 'subtitles') + '.srt', 'srt', 'subs'); if (!f) return;
    await S.writeText(f, '﻿' + TL.toSRT(items)); App.toast(t('saved'), 'ok');
  }

  /* ---------------------------------------------------------------- projects */
  $('#pName').addEventListener('blur', () => { const v = $('#pName').textContent.trim(); if (v && v !== ed.p.name) mut(() => { ed.p.name = v; }); });
  $('#pName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
  $('#pSave').addEventListener('click', () => save(false));
  $('#pSettingsBtn').addEventListener('click', () => select(null));
  function localTrackNames(p) {
    const n = { T1: t('tk_text') + ' 1', V2: t('tk_video') + ' 2', V1: t('tk_video') + ' 1', A1: t('tk_music'), A2: t('tk_voice') };
    p.tracks.forEach(tr => { if (n[tr.id]) tr.name = n[tr.id]; });
  }
  function newProject(preset = 'landscape', name) {
    pv.pause(); for (const id of [...pv.els.keys()]) pv.drop(id);
    ed.p = TL.newProject(preset, name || t('untitled')); ed.path = null;
    localTrackNames(ed.p); ed.sel = null; ed.undo = []; ed.redo = []; ed.saved = true;
    thumbCache.clear(); peakCache.clear(); pv.t = 0; renderAll();
  }
  async function confirmDiscard() { return ed.saved || !ed.p.clips.length || App.ask(t('unsaved'), t('unsaved_q'), t('discard')); }
  async function save(as) {
    let f = ed.path;
    if (!f || as) { f = await S.savePath((ed.p.name || 'project').replace(/[\\/:*?"<>|]/g, '_') + '.7krh', '7krh', 'project'); if (!f) return false; }
    try {
      await S.writeText(f, JSON.stringify(ed.p, null, 1));
      ed.path = f; ed.saved = true; App.toast(t('saved') + ' — ' + App.base(f), 'ok', 2500);
      remember(f);
      return true;
    } catch (e) { App.toast(App.errText(e), 'err'); return false; }
  }
  async function remember(f) {
    const thumb = Object.values(ed.p.media).map(m => m.thumb).find(x => x && x.startsWith('data:')) || null;
    const rec = (App.settings.recent || []).filter(r => r.path !== f);
    rec.unshift({ path: f, name: ed.p.name, at: Date.now(), dur: TL.duration(ed.p), thumb, w: ed.p.canvas.w, h: ed.p.canvas.h });
    await App.saveSet({ recent: rec.slice(0, 12) });
    document.dispatchEvent(new CustomEvent('recent'));
  }
  async function openProject(f) {
    if (!(await confirmDiscard())) return;
    try {
      const p = TL.migrate(JSON.parse(await S.readText(f)));
      newProject(); ed.p = p; ed.path = f; ed.saved = true;
      const missing = [];
      for (const src of Object.keys(p.media)) { if (!(await S.exists(src))) missing.push(src); else { delete p.media[src].proxy; delete p.media[src].proxying; } }
      App.go('edit'); renderAll();
      // re-check proxies + thumbnails for this machine
      for (const src of Object.keys(p.media)) { if (missing.includes(src)) continue; const m = p.media[src]; if (m.kind === 'video') { canPlay(App.fileUrl(src)).then(ok => { if (!ok || Math.min(m.w, m.h) > 1500) makeProxy(src, { width: m.w, height: m.h, duration: m.duration }, !ok); }); } }
      if (missing.length) App.toast(t('missing_media', { n: missing.length }) + ' ' + missing.map(App.base).join(', '), 'err', 10000);
      remember(f);
    } catch (e) { App.toast(t('err_project') + ' ' + App.errText(e), 'err', 8000); }
  }
  async function recover() {
    const r = await S.project.recover(); if (!r) return false;
    try { const o = JSON.parse(r.json); newProject(); ed.p = TL.migrate(o.project); ed.path = o.path || null; ed.saved = false; App.go('edit'); renderAll(); App.toast(t('recovered'), 'ok'); return true; } catch (e) { return false; }
  }

  /* ---------------------------------------------------------------- export */
  $('#pExport').addEventListener('click', () => exportDialog());
  async function exportDialog() {
    const p = ed.p;
    if (!p.clips.length) { App.toast(t('ed_empty')); return; }
    const st = App.settings;
    const o = { container: 'mp4', res: 'project', fps: 'project', codec: st.codec || 'h264', quality: 'high', rateMode: 'quality', mbps: 16, tenBit: false, platform: 'self', fx: st.fx || 'auto', loudnorm: false, softSubs: false, up: false, upModel: 'real', upQ: 'balanced', fg: false, aiRes: 'source', aiFps: 'source', ...(st.lastExport || {}) };
    const box = []; const ui = {};
    const sel = (key, opts, label, cb) => { const s = h('select', {}, opts.map(([v, l]) => h('option', { value: v, text: l, selected: String(o[key]) === String(v) }))); s.addEventListener('change', () => { o[key] = s.value; cb && cb(); summary(); }); ui[key] = s; return h('div', { class: 'field' }, h('label', { text: label }), s); };
    const tog = (key, label, sub) => { const i = h('input', { type: 'checkbox', checked: !!o[key] }); i.addEventListener('change', () => { o[key] = i.checked; sync(); summary(); }); ui[key] = i; return h('label', { class: 'toggle', style: 'margin-top:12px' }, i, h('span', { class: 'sw' }), h('span', {}, h('b', { text: label }), sub ? h('small', { text: sub }) : null)); };
    const enc = (App.caps && App.caps.encoders) || [];
    const hasHw = c => enc.some(e => e.startsWith(c + '_') && /nvenc|amf|qsv/.test(e));
    // WebM: VP9, and AV1 only with a hardware AV1 encoder (software SVT-AV1 inside WebM stalled in Windows tests)
    const codecOpts = () => (o.container === 'webm' ? [['vp9', 'VP9'], ...(hasHw('av1') ? [['av1', 'AV1 · GPU']] : [])] : [['h264', 'H.264' + (hasHw('h264') ? ' · GPU' : '')], ['hevc', 'HEVC' + (hasHw('hevc') ? ' · GPU' : '')], ['av1', 'AV1' + (hasHw('av1') ? ' · GPU' : '')]]);
    const plats = h('div', { class: 'plats' }, [['self', 'i-user'], ['tiktok', 'i-tiktok'], ['instagram', 'i-insta'], ['youtube', 'i-yt']].map(([k, ic]) => h('button', { class: 'plat' + (o.platform === k ? ' on' : ''), dataset: { p: k }, onclick: e => { o.platform = k; $$('.plat', plats).forEach(x => x.classList.toggle('on', x.dataset.p === k)); applyPlatform(); sync(); summary(); void e; } }, App.icon(ic), h('span', { text: t('p_' + k) }))));
    const hintP = h('p', { class: 'hint' }), fxRow = sel('fx', [['auto', t('fxAuto')], ['to30', t('fx30')], ['2', '×2'], ['4', '×4'], ['6', '×6']], t('fxL')), fxHint = h('p', { class: 'hint' });
    const sum = h('div', { class: 'kv', style: 'margin-top:14px' }), err = h('p', { class: 'hint err' });
    const codecField = sel('codec', codecOpts(), t('codec'));
    const mbpsI = h('input', { type: 'number', min: 1, max: 400, step: 1, value: o.mbps }); mbpsI.addEventListener('change', () => { o.mbps = +mbpsI.value; summary(); });
    const mbpsField = h('div', { class: 'field' }, h('label', { text: t('bitrate_mbps') }), mbpsI);
    function applyPlatform() {
      // platform presets (same advice as the website): TikTok/Reels vertical-friendly H.264, YouTube higher res
      if (o.platform === 'youtube' && o.container === 'webm') o.container = 'mp4';
      if (o.platform !== 'self' && o.container !== 'mp4') { o.container = 'mp4'; ui.container.value = 'mp4'; }
      if ((o.platform === 'tiktok' || o.platform === 'instagram') && o.codec === 'av1') { o.codec = 'h264'; }
      refreshCodec();
    }
    function refreshCodec() { const s = ui.codec; s.innerHTML = ''; codecOpts().forEach(([v, l]) => s.appendChild(h('option', { value: v, text: l, selected: o.codec === v }))); if (!codecOpts().some(([v]) => v === o.codec)) { o.codec = codecOpts()[0][0]; s.value = o.codec; } }
    function sync() {
      hintP.textContent = t('p_' + o.platform + '_h');
      fxRow.hidden = fxHint.hidden = o.platform !== 'tiktok';
      mbpsField.hidden = o.rateMode !== 'bitrate';
      aiBox.querySelectorAll('.aiopt').forEach(x => { x.hidden = !o.up && !o.fg; });
      ui.upModel.parentElement.hidden = !o.up; ui.upQ.parentElement.hidden = !o.up;
    }
    const aiBox = h('div', { class: 'sect ai', style: 'margin-top:12px' },
      tog('up', t('ai_up'), t('ai_up_sub_tl')), sel('upModel', [['real', t('m_real')], ['anime', t('m_anime')]], t('ai_model')), sel('upQ', [['fast', t('aq_fast')], ['balanced', t('aq_bal')], ['max', t('aq_max')]], t('ai_q')),
      tog('fg', t('ai_fg'), t('ai_fg_sub')),
      h('div', { class: 'two aiopt' }, sel('aiRes', [['source', t('res_src')], ['1080', '1080p'], ['1440', '2K'], ['2160', '4K']], t('ai_target_res')), sel('aiFps', [['source', t('fps_src')], ['60', '60'], ['120', '120']], t('ai_target_fps'))),
      h('p', { class: 'hint aiopt', text: t('ai_tl_hint') }));
    box.push(h('div', { class: 'cols' },
      h('div', {},
        sel('container', [['mp4', 'MP4'], ['mov', 'MOV'], ['webm', 'WebM']], t('container'), refreshCodec),
        h('div', { class: 'two' }, sel('res', [['project', `${t('res_project')} (${App.ltr(p.canvas.w + '×' + p.canvas.h)})`], ['720', '720p'], ['1080', '1080p'], ['1440', '1440p'], ['2160', '2160p (4K)']], t('res')), sel('fps', [['project', `${t('fps_project')} (${p.canvas.fps})`], ['24', '24'], ['25', '25'], ['30', '30'], ['50', '50'], ['60', '60']], t('fps'))),
        h('div', { class: 'two' }, codecField, sel('quality', [['balanced', t('q_bal')], ['high', t('q_high')], ['max', t('q_max')]], t('quality'))),
        h('div', { class: 'two' }, sel('rateMode', [['quality', t('rate_quality')], ['bitrate', t('rate_bitrate')]], t('rate_mode'), sync), mbpsField),
        tog('tenBit', t('tenbit')), tog('loudnorm', t('loudnorm'), t('loudnorm_sub')), p.tracks.some(x => x.sub) ? tog('softSubs', t('soft_subs'), t('soft_subs_sub')) : null),
      h('div', {}, h('div', { class: 'field' }, h('label', { text: t('platform') }), plats), hintP, fxRow, fxHint, aiBox)));
    box.push(sum, err);
    const d = App.dialog({ title: t('export_title'), wide: true, body: box, actions: [{ label: t('cancel'), ghost: true, value: false }, { label: t('export'), primary: true, icon: 'i-queue', run: () => { go(); return false; } }] });
    sync();
    let sumT = 0;
    function req(outPath, proj) {
      return {
        type: 'timeline', project: proj || ed.p, outPath, platform: o.platform, fx: o.fx,
        output: { container: o.container, res: o.res, fps: o.fps, codec: o.codec, quality: o.quality, tenBit: o.tenBit && o.codec !== 'h264', rate: { mode: o.rateMode, mbps: o.mbps }, loudnorm: o.loudnorm, softSubs: o.softSubs, aiRes: o.aiRes, aiFps: o.aiFps === 'source' ? 'source' : +o.aiFps },
        enhance: { upscale: { on: o.up, model: o.upModel, quality: o.upQ }, framegen: { on: o.fg, model: '4.26' } },
      };
    }
    async function summary() {
      clearTimeout(sumT);
      sumT = setTimeout(async () => {
        sum.innerHTML = ''; err.textContent = '';
        try {
          const proj = await prepared(true);
          const r = await S.plan(req('x.' + o.container, proj));
          const ex = r.expect;
          const kv = [[t('o_res'), `${ex.w}×${ex.h}` + (r.up ? ` · AI ×${r.up.scale}` : '')], [t('o_fps'), (Math.round(ex.fps * 100) / 100) + ' fps' + (r.fg ? ` · RIFE ×${(r.fg.num / r.fg.den).toFixed(r.fg.den === 1 ? 0 : 2)}` : '')],
            [t('o_dur'), App.fmtTime(ex.dur, false) + (ex.kfactor > 1 ? ` → ${App.fmtTime(ex.finalDur, false)} (TikTok ×${ex.kfactor})` : '')], [t('o_enc'), String(r.encoder).replace('_', ' ').toUpperCase() + (/nvenc|amf|qsv/.test(r.encoder) ? ' (GPU)' : ' (CPU)')],
            [t('o_size'), r.estimateBytes ? '≈ ' + App.fmtSize(r.estimateBytes) : t('size_unknown')]];
          if (o.platform === 'tiktok') fxHint.textContent = ex.kfactor > 1 ? t('fxH', { f: Math.round(ex.fps * 100) / 100, d: Math.round(ex.fps / ex.kfactor * 100) / 100, k: ex.kfactor }) + ' ' + t('fxHenh') : t('fxHlow', { f: 30 });
          kv.forEach(([a, b]) => sum.append(h('span', { text: a }), h('b', { text: b })));
        } catch (e) { err.textContent = App.errText(e); }
      }, 150);
    }
    summary();
    async function go() {
      try {
        const ext = o.container;
        const out = await S.outName(ed.p.name || 'project', o.platform !== 'self' ? '_' + o.platform : '', ext);
        const proj = await prepared(false);
        const thumb = Object.values(ed.p.media).map(m => m.thumb).find(Boolean) || null;
        await App.saveSet({ lastExport: { ...o } });
        await App.startJob(req(out, proj), { name: App.base(out), thumb });
        d.close(); App.go('queue');
      } catch (e) { err.textContent = App.errText(e); }
    }
    /* text layers are written as images at the output scale before the plan is made */
    async function prepared(quick) {
      const proj = JSON.parse(JSON.stringify(ed.p));
      const RES = { '720': 720, '1080': 1080, '1440': 1440, '2160': 2160 };
      const K = RES[o.res] ? RES[o.res] / Math.min(proj.canvas.w, proj.canvas.h) : 1;
      for (const c of proj.clips.filter(x => x.kind === 'text')) {
        const orig = clip(c.id);
        if (quick) { TextLayer.image(orig); c.text.pw = orig.text.pw; c.text.ph = orig.text.ph; c.text.png = c.text.png || 'pending.png'; continue; }
        c.text.png = await TextLayer.toFile(orig, K); c.text.pw = orig.text.pw; c.text.ph = orig.text.ph;
      }
      proj.clips.forEach(c => { delete c._seen; });
      return proj;
    }
  }

  /* ---------------------------------------------------------------- render + busy */
  function busy(s) { $('#pvBusy').hidden = !s; $('#pvBusyTxt').textContent = s || ''; }
  function renderAll() {
    $('#pName').textContent = ed.p.name;
    $('#pCanvas').textContent = `${ed.p.canvas.w}×${ed.p.canvas.h} · ${ed.p.canvas.fps} fps`;
    pv.sel = selClip() || null; pv.gc();
    renderBin(); renderTimeline(); renderInspector(); toolbarState();
    pv.resize(viewer.clientWidth, viewer.clientHeight); drawTime(pv.t);
    $('#crumb').textContent = App.view === 'edit' ? t('nav_edit') + ' · ' + ed.p.name + (ed.saved ? '' : ' •') : $('#crumb').textContent;
  }
  document.addEventListener('lang', () => { renderPresets(); renderAll(); });
  document.addEventListener('view', e => { if (e.detail === 'edit') requestAnimationFrame(() => { renderAll(); }); else if (pv.playing) { pv.pause(); setPlayIcon(); } });
  document.addEventListener('boot', async () => {
    renderPresets();
    ed.p.name = t('untitled'); localTrackNames(ed.p);
    zoomTo(+$('#eZoom').value);
    const r = await S.project.recover().catch(() => null);
    if (r) { $('#recoverProject').hidden = false; try { const o = JSON.parse(r.json); if (o.project && o.project.clips && o.project.clips.length) { const ok = await App.ask(t('recover_title'), t('recover_q', { n: o.project.name || '', d: new Date(r.at).toLocaleString() }), t('recover')); if (ok) recover(); else S.project.clear(); } } catch (e) {} }
  });
  window.addEventListener('beforeunload', () => { if (ed.p.clips.length) S.project.autosave(JSON.stringify({ path: ed.path, project: ed.p })); });

  /* ---------------------------------------------------------------- projects page + home recent list */
  const TEMPLATES = [['vertical60', 'tm_tiktok'], ['vertical', 'tm_reels'], ['landscape', 'tm_youtube'], ['landscape60', 'tm_youtube60'], ['uhd', 'tm_4k'], ['portrait', 'tm_insta'], ['square', 'tm_square']];
  function renderProjects() {
    const T = $('#templates'); T.innerHTML = '';
    TEMPLATES.forEach(([k, l]) => {
      const pr = TL.PRESETS[k], sc = 46 / Math.max(pr.w, pr.h);
      T.appendChild(h('button', { class: 'tmpl', onclick: () => window.Timeline.newProject(k, t(l)) }, h('div', { class: 'shape', style: `width:${pr.w * sc}px;height:${pr.h * sc}px` }), h('b', { text: t(l) }), h('small', { text: `${pr.w}×${pr.h} · ${pr.fps} fps` })));
    });
    const rec = App.settings.recent || [];
    for (const [boxId, listId] of [['#recentList', '#recentList'], ['#homeRecent', '#homeRecentList']]) {
      const L = $(listId); L.innerHTML = '';
      if (boxId === '#homeRecent') $('#homeRecent').hidden = !rec.length;
      if (!rec.length && listId === '#recentList') L.appendChild(h('div', { class: 'hint', text: t('no_recent') }));
      rec.slice(0, listId === '#homeRecentList' ? 4 : 12).forEach(r => L.appendChild(h('button', { class: 'rcard', onclick: () => openProject(r.path) },
        h('div', { class: 'th', style: r.thumb ? `background-image:url("${r.thumb}")` : '' }), h('b', { text: r.name || App.base(r.path) }),
        h('small', { text: `${App.ltr(r.w + '×' + r.h)} · ${App.ltr(App.fmtTime(r.dur || 0, false))} · ${new Date(r.at).toLocaleDateString(App.lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB')}` }))));
    }
  }
  $('#openProject').addEventListener('click', async () => { const f = (await S.open('project'))[0]; if (f) openProject(f); });
  $('#recoverProject').addEventListener('click', () => recover());
  document.addEventListener('recent', renderProjects);
  document.addEventListener('view', e => { if (e.detail === 'projects' || e.detail === 'home') renderProjects(); });
  document.addEventListener('lang', renderProjects);

  window.Timeline = { addFiles, openProject, importSubs, newProject: (preset, name) => { confirmDiscard().then(ok => { if (ok) { newProject(preset, name); App.go('edit'); } }); }, recover, save, get project() { return ed.p; }, _ed: ed, _pv: pv };
})();
