/* 7krh Studio — core: language, navigation, smart file opening, dialogs, export queue, status bar,
   settings, engine manager, hardware panel. Views register themselves on window.* (Timeline, Enhance, …). */
(() => {
  'use strict';
  const S = window.studio;
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const App = window.App = { $, $$, S, lang: 'ar', settings: {}, info: null, caps: null, bench: null };

  /* ---------------- DOM helper (never innerHTML with file names) ---------------- */
  App.h = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'dataset') Object.assign(e.dataset, v); else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  };
  const h = App.h;
  App.icon = (id, cls = '') => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', 'ic ' + cls); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#' + id); s.appendChild(u); return s; };

  /* ---------------- text ---------------- */
  App.t = (k, vars) => {
    let s = (I18N[App.lang] && I18N[App.lang][k] != null ? I18N[App.lang][k] : (I18N.en[k] != null ? I18N.en[k] : k));
    if (vars) s = s.replace(/\{(\w+)\}/g, (_, x) => (vars[x] != null ? vars[x] : ''));
    return s;
  };
  const t = App.t;
  App.applyLang = () => {
    const d = I18N[App.lang].dir;
    document.documentElement.dir = d; document.documentElement.lang = App.lang;
    $$('[data-i]').forEach(e => { e.textContent = t(e.dataset.i); });
    $$('[data-it]').forEach(e => { e.title = t(e.dataset.it); });
    document.dispatchEvent(new CustomEvent('lang'));
  };
  App.fmtTime = (s, cs = true) => {
    if (!isFinite(s) || s < 0) s = 0;
    const hh = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s - hh * 3600 - m * 60;
    const sec = cs ? x.toFixed(2).padStart(5, '0') : String(Math.floor(x)).padStart(2, '0');
    return (hh ? hh + ':' + String(m).padStart(2, '0') : m) + ':' + sec;
  };
  App.fmtDur = s => {
    if (!isFinite(s) || s == null) return t('unknown');
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + ' ' + t('secs');
    if (s < 3600) return Math.floor(s / 60) + ' ' + t('mins') + ' ' + String(s % 60).padStart(2, '0') + ' ' + t('secs');
    return Math.floor(s / 3600) + ' ' + t('hrs') + ' ' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + ' ' + t('mins');
  };
  App.fmtSize = b => (b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round((b || 0) / 1024)) + ' KB');
  App.fileUrl = p => 'file:///' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:');
  App.base = p => String(p).split(/[\\/]/).pop();
  App.ltr = s => '\u2066' + s + '\u2069'; // keeps 1920×1080 in order inside Arabic text
  App.fps = info => { const r = String(info && info.fps || '30').split('/'); const v = r.length === 2 ? r[0] / r[1] : +r[0]; return isFinite(v) && v > 0 ? v : 30; };
  App.errText = e => { const m = String(e && e.message || e); const k = 'err_' + ((e && e.code) || m); return I18N.en[k] ? t(k) : m.split('\n')[0]; };

  /* ---------------- toasts + status line ---------------- */
  App.toast = (msg, kind = '', ms = 4200) => {
    const el = h('div', { class: 'toast ' + kind }, kind === 'err' ? App.icon('i-alert') : kind === 'ok' ? App.icon('i-check') : null, h('span', { text: msg }));
    $('#toasts').appendChild(el); setTimeout(() => el.remove(), ms);
  };
  App.status = msg => { $('#stMsg').textContent = msg || ''; };

  /* ---------------- dialogs ---------------- */
  App.dialog = ({ title, body = [], actions = [], wide = false, onClose }) => {
    const box = $('#dlgBox'); box.innerHTML = ''; box.className = 'dlg' + (wide ? ' wide' : '');
    const close = v => { $('#dlg').hidden = true; box.innerHTML = ''; document.removeEventListener('keydown', esc); onClose && onClose(v); };
    const esc = e => { if (e.key === 'Escape') close(null); };
    box.append(h('h2', {}, h('span', { text: title }), h('span', { class: 'sp' }), h('button', { class: 'icbtn sm', onclick: () => close(null) }, App.icon('i-x'))), ...[].concat(body));
    if (actions.length) box.append(h('div', { class: 'acts' }, actions.map(a => h('button', { class: 'btn ' + (a.primary ? 'primary' : a.ghost ? 'ghost' : ''), onclick: () => { const r = a.run ? a.run() : a.value; if (r !== false) close(a.value ?? r); } }, a.icon ? App.icon(a.icon) : null, h('span', { text: a.label })))));
    $('#dlg').hidden = false; document.addEventListener('keydown', esc);
    return { close };
  };
  $('#dlg').addEventListener('mousedown', e => { if (e.target.id === 'dlg') $('#dlgBox h2 .icbtn').click(); });
  App.ask = (title, text, okLabel, cancelLabel) => new Promise(res => App.dialog({ title, body: [h('p', { class: 'lead', text })], actions: [{ label: cancelLabel || t('cancel'), ghost: true, value: false }, { label: okLabel || t('ok'), primary: true, value: true }], onClose: v => res(!!v) }));

  /* ---------------- navigation ---------------- */
  App.go = v => {
    if (App.view === v) return;
    $$('.nav').forEach(n => n.classList.toggle('on', n.dataset.v === v));
    $$('.view').forEach(x => { x.hidden = x.id !== 'v-' + v; });
    App.view = v;
    $('#crumb').textContent = v === 'home' ? '' : t('nav_' + v);
    document.dispatchEvent(new CustomEvent('view', { detail: v }));
  };
  $$('.nav').forEach(n => n.addEventListener('click', () => App.go(n.dataset.v)));
  $$('.card[data-go]').forEach(c => c.addEventListener('click', () => App.go(c.dataset.go)));

  /* ---------------- smart file opening ---------------- */
  const KIND = p => /\.7krh$/i.test(p) ? 'project' : /\.(srt|ass|ssa)$/i.test(p) ? 'subs' : /\.(png|jpe?g|webp|bmp|tiff?|avif|heic)$/i.test(p) ? 'image'
    : /\.(mp3|m4a|aac|wav|flac|ogg|opus|wma)$/i.test(p) ? 'audio' : 'video';
  App.kindOf = KIND;
  /* facts that matter for the next step, from a real probe */
  App.facts = info => {
    const w = info.rotation % 180 ? info.height : info.width, hh = info.rotation % 180 ? info.width : info.height;
    const f = [];
    if (w) f.push(`${w}×${hh}`);
    if (info.kind === 'video') f.push((Math.round(App.fps(info) * 100) / 100) + ' fps');
    if (info.duration && info.kind !== 'image') f.push(App.fmtTime(info.duration, false));
    if (info.vcodec && info.kind !== 'image') f.push(info.vcodec.toUpperCase() + (info.bitDepth > 8 ? ' 10-bit' : ''));
    if (info.hdr) f.push('HDR');
    if (info.kind === 'audio' && info.acodec) f.push(info.acodec.toUpperCase() + (info.sampleRate ? ' ' + Math.round(info.sampleRate / 1000) + ' kHz' : ''));
    if (info.hasAudio && info.kind === 'video') f.push('♪ ' + (info.acodec || '').toUpperCase());
    if (info.size) f.push(App.fmtSize(info.size));
    return f;
  };
  /* what we would suggest for this file, and why */
  App.suggest = info => {
    const short = Math.min(info.width, info.height), fps = App.fps(info);
    const s = { upscale: short && short < 1000, framegen: info.kind === 'video' && fps < 50, res: short < 600 ? '1080' : short < 1000 ? '1080' : short < 1500 ? '2160' : 'source', fps: fps < 50 ? '60' : 'source' };
    s.text = [s.upscale ? t('sg_up', { to: s.res === '2160' ? '4K' : s.res + 'p' }) : null, s.framegen ? t('sg_fg', { f: Math.round(fps), to: 60 }) : null, info.hdr ? t('sg_hdr') : null].filter(Boolean);
    return s;
  };
  App.openPaths = async (paths, from) => {
    if (!paths || !paths.length) return;
    try { await S.dropped(paths); } catch (e) {}
    const kinds = paths.map(KIND);
    const one = paths.length === 1;
    if (kinds.includes('project')) return window.Timeline.openProject(paths[kinds.indexOf('project')]);
    if (kinds.every(k => k === 'subs')) { App.go('edit'); return window.Timeline.importSubs(paths[0]); }
    // inside a tool, files go to that tool
    if (from === 'edit') { App.go('edit'); return window.Timeline.addFiles(paths.filter((p, i) => kinds[i] !== 'subs')); }
    if (from === 'images' && kinds.every(k => k === 'image')) return window.Images.add(paths);
    if (from === 'audio' && kinds.every(k => k === 'audio' || k === 'video')) return window.AudioTools.add(paths);
    if (from === 'enhance' && one && kinds[0] === 'video') return window.Enhance.load(paths[0]);
    if (kinds.every(k => k === 'image')) { App.go('images'); return window.Images.add(paths); }
    if (kinds.every(k => k === 'audio')) { App.go('audio'); return window.AudioTools.add(paths); }
    if (one && kinds[0] === 'video') return videoChooser(paths[0]);
    // several files of mixed kinds: build a project or batch
    multiChooser(paths, kinds);
  };
  async function videoChooser(p) {
    let info;
    try { info = await S.probe(p); } catch (e) { App.toast(t('err_open') + ' ' + App.errText(e), 'err', 8000); return; }
    if (info.kind === 'image') { App.go('images'); return window.Images.add([p]); }
    if (info.kind === 'audio') { App.go('audio'); return window.AudioTools.add([p]); }
    const sg = App.suggest(info);
    const choice = (icon, title, text, run, rec) => h('button', { class: 'choice' + (rec ? ' rec' : ''), onclick: () => { d.close(); run(); } }, rec ? h('span', { class: 'rtag', text: t('recommended') }) : null, App.icon(icon), h('b', { text: title }), h('p', { text }));
    const d = App.dialog({
      title: App.base(p), wide: true,
      body: [h('div', { class: 'facts' }, App.facts(info).map(f => h('span', { class: 'tag', text: f }))),
        sg.text.length ? h('p', { class: 'hint', text: t('sg_title') + ' ' + sg.text.join(' · ') }) : null,
        h('div', { class: 'choices' },
          choice('i-spark', t('ch_enh'), t('ch_enh_sub'), () => { App.go('enhance'); window.Enhance.load(p, { suggest: sg }); }, sg.upscale || sg.framegen),
          choice('i-timeline', t('ch_edit'), t('ch_edit_sub'), () => { App.go('edit'); window.Timeline.addFiles([p]); }, !(sg.upscale || sg.framegen)),
          choice('i-tiktok', t('ch_copy'), t('ch_copy_sub'), () => { App.go('enhance'); window.Enhance.load(p, { copy: true }); }),
          info.hasAudio ? choice('i-wave', t('ch_audio'), t('ch_audio_sub'), () => { App.go('audio'); window.AudioTools.add([p]); }) : null)],
    });
  }
  function multiChooser(paths, kinds) {
    const n = k => kinds.filter(x => x === k).length;
    const imgs = paths.filter((p, i) => kinds[i] === 'image');
    const d = App.dialog({
      title: t('multi_title', { n: paths.length }),
      body: [h('div', { class: 'facts' }, [['video', 'k_video'], ['image', 'k_image'], ['audio', 'k_audio']].filter(([k]) => n(k)).map(([k, l]) => h('span', { class: 'tag', text: n(k) + ' ' + t(l) }))),
        h('div', { class: 'choices' },
          h('button', { class: 'choice rec', onclick: () => { d.close(); App.go('edit'); window.Timeline.addFiles(paths.filter((p, i) => kinds[i] !== 'subs'), { newProject: true }); } }, h('span', { class: 'rtag', text: t('recommended') }), App.icon('i-timeline'), h('b', { text: t('ch_project') }), h('p', { text: t('ch_project_sub') })),
          imgs.length ? h('button', { class: 'choice', onclick: () => { d.close(); App.go('images'); window.Images.add(imgs); } }, App.icon('i-image'), h('b', { text: t('ch_batch_img', { n: imgs.length }) }), h('p', { text: t('ch_batch_img_sub') })) : null)],
    });
  }
  $('#homeDrop').addEventListener('click', async () => App.openPaths(await S.open('any', true), 'home'));
  let dragN = 0;
  const isFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', e => { if (!isFiles(e)) return; e.preventDefault(); dragN++; $('#dropVeil').hidden = App.view === 'edit'; });
  window.addEventListener('dragleave', e => { if (!isFiles(e)) return; e.preventDefault(); if (--dragN <= 0) { dragN = 0; $('#dropVeil').hidden = true; } });
  window.addEventListener('dragover', e => { if (isFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', e => {
    if (!isFiles(e)) return;
    e.preventDefault(); dragN = 0; $('#dropVeil').hidden = true;
    const ps = [...e.dataTransfer.files].map(f => S.pathOf(f)).filter(Boolean);
    if (!e._handled) App.openPaths(ps, App.view);
  });
  S.onOpenFile && S.onOpenFile(f => App.openPaths([f], 'home'));

  /* ---------------- hardware ---------------- */
  function showCaps(c) {
    App.caps = c;
    const g = (c.gpus || []).find(x => x.name === App.settings.gpuName) || (c.gpus || [])[0];
    const hw = (c.encoders || []).filter(e => /nvenc|amf|qsv/.test(e));
    $('#gpuName').textContent = g ? g.name : t('gpu_none');
    $('#gpuSub').textContent = g && g.vramMB ? (g.vramMB / 1024).toFixed(g.vramMB % 1024 ? 1 : 0) + ' GB VRAM' + (g.driver ? ' · ' + g.driver : '') : '';
    $('#hwEnc').textContent = hw.length ? [...new Set(hw.map(e => e.split('_')[1].toUpperCase()))].join(' / ') + ' · ' + [...new Set(hw.map(e => e.split('_')[0].replace('hevc', 'HEVC').replace('h264', 'H.264').replace('av1', 'AV1').replace('vp9', 'VP9')))].join(' · ') : t('cpu_only');
    $('#stHw').textContent = (g ? g.name.replace(/^NVIDIA\s+/i, '') : 'CPU') + (hw.length ? ' · ' + [...new Set(hw.map(e => e.split('_')[1].toUpperCase()))].join('/') : '');
    const sel = $('#sGpu'); sel.innerHTML = '';
    (c.gpus || []).forEach(x => sel.appendChild(h('option', { value: x.name, text: x.name + (x.vramMB ? ` (${(x.vramMB / 1024).toFixed(0)} GB)` : '') })));
    if (!(c.gpus || []).length) sel.appendChild(h('option', { value: '', text: t('gpu_none') }));
    sel.value = g ? g.name : '';
    document.dispatchEvent(new CustomEvent('caps'));
  }
  function showBench(r) {
    App.bench = r;
    const box = $('#benchBox');
    $('#benchAsk').hidden = !!r;
    if (!r) { box.hidden = true; $('#hwAi').textContent = t('not_measured'); return; }
    box.hidden = false; box.innerHTML = '';
    const v = r.vs || {}, im = r.image || {};
    const eng = { trt: 'TensorRT', ort: 'DirectML', ncnn: 'Vulkan' };
    const best = r.best;
    $('#hwAi').textContent = best ? eng[best] + ' (GPU)' : t('ai_none');
    const rows = [];
    if (best && v[`esrgan_${best}_720p_fps`]) rows.push([t('b_up', { e: eng[best] }), v[`esrgan_${best}_720p_fps`].toFixed(1) + ' fps']);
    if (v['rife_4.26_1080p_fps']) rows.push(['RIFE 4.26 · 1080p ×2', v['rife_4.26_1080p_fps'] + ' fps']);
    if (v['rife_4.26_2160p_fps']) rows.push(['RIFE 4.26 · 4K ×2', v['rife_4.26_2160p_fps'] + ' fps']);
    if (r.e2e && r.e2e.e2e_1080_to_4k_fps) rows.push([t('b_e2e'), r.e2e.e2e_1080_to_4k_fps + ' fps']);
    if (im.real_x4_ms) rows.push([t('b_img'), im.real_x4_ms + ' ms · ' + (im.real_x4_device || '')]);
    rows.forEach(([k, val]) => box.appendChild(h('div', { class: 'row' }, h('span', { text: k }), h('b', { text: val }))));
    const errs = Object.keys(v).filter(k => /error/.test(k) && !/not installed|not an NVIDIA/.test(v[k]));
    if (!rows.length || errs.length || (r.e2e && r.e2e.e2e_error)) box.appendChild(h('div', { class: 'hint warn', text: t('bench_partial') }));
    box.appendChild(h('div', { class: 'hint', text: t('bench_when', { d: new Date(r.time).toLocaleString(App.lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB') }) }));
    document.dispatchEvent(new CustomEvent('bench'));
  }
  App.runBench = async () => {
    const ok = await App.ask(t('bench_title'), t('bench_warn'), t('bench_start'));
    if (!ok) return;
    S.settings.set({ benchAsked: true });
    setBenchBusy(true);
    try {
      const { file, report } = await S.diag();
      showBench(report); showCaps(report.caps);
      $('#sDiagOut').textContent = file;
      refreshEngines();
    } catch (e) { App.toast(App.errText(e), 'err', 8000); }
    setBenchBusy(false);
  };
  function setBenchBusy(b, step) {
    $('#benchBtn').disabled = b; $('#sDiag').disabled = b;
    $('#benchBtn span').textContent = b ? t('hw_benching') + (step ? ' · ' + t('st_' + step.replace(/_.*/, '')) : '') : t('hw_bench');
    App.status(b ? t('hw_benching') + (step ? ' · ' + t('st_' + step.replace(/_.*/, '')) : '') : '');
  }
  $('#benchBtn').addEventListener('click', App.runBench);
  $('#sDiag').addEventListener('click', App.runBench);
  S.onDiag && S.onDiag(p => { if (p.step === 'done') { setBenchBusy(false); if (p.report) { showBench(p.report); showCaps(p.report.caps); } } else setBenchBusy(true, p.step); });

  /* ---------------- export queue ---------------- */
  const Q = App.queue = new Map();
  App.qRender = qRender;
  function qRender(id) {
    const j = Q.get(id); if (!j) return;
    let el = document.getElementById('q' + id);
    if (!el) {
      el = h('div', { class: 'qitem', id: 'q' + id }, h('div', { class: 'th' }), h('div', {}, h('b'), h('div', { class: 'st' }), h('div', { class: 'bar' }, h('i'))), h('div', { class: 'acts' }));
      $('#qlist').prepend(el);
      if (j.thumb) el.querySelector('.th').style.backgroundImage = `url("${j.thumb}")`;
    }
    $('#qEmpty').hidden = true;
    el.querySelector('b').textContent = j.name;
    el.className = 'qitem' + (j.state === 'done' ? ' done' : j.state === 'error' ? ' err' : '');
    const st = el.querySelector('.st'); st.innerHTML = '';
    const add = (txt, ltr) => st.appendChild(h(ltr ? 'span' : 'em', { style: 'font-style:normal', text: txt }));
    if (j.state === 'queued') add(t('q_waiting'));
    else if (j.state === 'run') {
      add(t('q_' + (j.phase || 'encode')) + (j.steps > 1 ? ` (${j.step}/${j.steps})` : ''));
      add(Math.round((j.frac || 0) * 100) + '%', 1);
      if (j.fps) add(j.fps.toFixed(1) + ' ' + t('q_fps') + (j.ms ? ` · ${j.ms.toFixed(0)} ms/f` : ''), 1);
      if (j.eta != null) add(App.fmtDur(j.eta) + ' ' + t('q_eta'));
      if (j.device) add(j.device, 1);
    } else if (j.state === 'done') {
      add(t('q_done'));
      if (j.expect && j.expect.w) add(`${j.expect.w}×${j.expect.h} · ${Math.round(j.expect.fps * 100) / 100} fps`, 1);
      add(App.fmtSize(j.size || 0), 1); if (j.secs) add(t('q_took') + ' ' + App.fmtDur(j.secs));
      if (j.encoder) add(String(j.encoder).replace('_', ' ').toUpperCase(), 1);
    } else if (j.state === 'error') add(t(j.cancelled ? 'q_cancel' : 'q_err'));
    const bar = el.querySelector('.bar'); bar.querySelector('i').style.width = ((j.state === 'done' ? 1 : j.frac || 0) * 100) + '%';
    bar.hidden = j.state !== 'run';
    const acts = el.querySelector('.acts'); acts.innerHTML = '';
    if (j.state === 'run' || j.state === 'queued') acts.appendChild(h('button', { class: 'btn sm', text: t('cancel'), onclick: () => S.cancel(id) }));
    if (j.state === 'done' && j.out) {
      if (/\.(mp4|mov|webm|mkv)$/i.test(j.out)) acts.appendChild(h('button', { class: 'btn sm primary', text: t('play'), onclick: () => App.play(j.out, j.expect) }));
      acts.appendChild(h('button', { class: 'btn sm', text: t('open_folder'), onclick: () => S.reveal(j.out) }));
    }
    el.querySelectorAll('.errlog,.vfy').forEach(x => x.remove());
    if (j.state === 'error' && !j.cancelled && j.err) el.appendChild(h('div', { class: 'errlog', text: App.errText({ message: j.err, code: j.code }) + (j.log ? '\n\n' + j.log : '') }));
    if (j.state === 'done' && j.verify) el.appendChild(h('div', { class: 'vfy' + (j.verify.ok ? '' : ' bad') }, App.icon(j.verify.ok ? 'i-check' : 'i-alert'), h('span', { text: j.verify.ok ? t('q_verified', { d: (j.verify.dur || 0).toFixed(2), a: j.verify.audio ? t('with_audio') : t('no_audio') }) : j.verify.problems.join(' · ') })));
    statusJob();
  }
  function statusJob() {
    const run = [...Q.values()].find(x => x.state === 'run');
    const waiting = [...Q.values()].filter(x => x.state === 'queued').length;
    const n = [...Q.values()].filter(x => x.state === 'run' || x.state === 'queued').length;
    $('#qBadge').hidden = !n; $('#qBadge').textContent = n;
    $('#stJob').hidden = !run;
    if (run) { $('#stJobTxt').textContent = `${run.name} · ${Math.round((run.frac || 0) * 100)}%` + (run.eta != null ? ' · ' + App.fmtDur(run.eta) : '') + (waiting ? ' · +' + waiting : ''); $('#stJobBar').style.width = ((run.frac || 0) * 100) + '%'; }
  }
  $('#stJob').addEventListener('click', () => App.go('queue'));
  const HK = '7krh.history';
  function saveHist(j) {
    try {
      const hs = JSON.parse(localStorage.getItem(HK) || '[]').filter(x => x.out !== j.out);
      hs.unshift({ name: j.name, out: j.out, size: j.size, secs: j.secs, expect: j.expect, thumb: j.thumb, verify: j.verify, encoder: j.encoder, at: Date.now() });
      localStorage.setItem(HK, JSON.stringify(hs.slice(0, 40)));
    } catch (e) {}
  }
  function loadHist() {
    let hs = []; try { hs = JSON.parse(localStorage.getItem(HK) || '[]'); } catch (e) {}
    hs.slice().reverse().forEach((x, i) => { const id = 'h' + i; Q.set(id, { ...x, id, state: 'done', old: true }); qRender(id); });
  }
  /* starts a job of any kind; meta = { name, thumb } */
  App.startJob = async (req, meta) => {
    const r = await S.start(req, meta);
    Q.set(r.id, { id: r.id, state: 'queued', frac: 0, ...meta });
    qRender(r.id);
    App.toast(t('toast_queued', { n: meta.name }), '', 2500);
    return r.id;
  };
  S.onJob(ev => {
    const j = Q.get(ev.id); if (!j) return;
    if (ev.type === 'start') Object.assign(j, { state: 'run', expect: ev.expect, encoder: ev.encoder, device: ev.device });
    else if (ev.type === 'progress') { j.state = 'run'; j.frac = ev.frac; if (ev.fps != null) j.fps = ev.fps; if (ev.ms != null) j.ms = ev.ms; if (ev.eta !== undefined) j.eta = ev.eta; }
    else if (ev.type === 'phase') { j.phase = ev.phase; j.step = ev.step || j.step; j.steps = ev.steps || j.steps; }
    else if (ev.type === 'done') { Object.assign(j, { state: 'done', out: ev.out, size: ev.size, secs: ev.secs, expect: ev.expect, verify: ev.verify, encoder: ev.encoder }); App.toast(t('toast_done') + ' — ' + j.name, 'ok'); saveHist(j); }
    else if (ev.type === 'error') Object.assign(j, { state: 'error', err: ev.err, code: ev.code, log: ev.log, cancelled: ev.cancelled });
    qRender(ev.id);
    document.dispatchEvent(new CustomEvent('jobev', { detail: ev }));
  });

  /* ---------------- built-in player ---------------- */
  const pv = $('#pvVid'); let pvPath = null;
  App.play = (p, ex) => {
    pvPath = p; $('#pvModal').hidden = false; $('#pvErr').hidden = true;
    $('#pvName').textContent = App.base(p);
    $('#pvInfo').textContent = ex && ex.w ? `${ex.w}×${ex.h} · ${Math.round(ex.fps * 100) / 100} fps` : '';
    pv.src = App.fileUrl(p); pv.play().catch(() => {});
  };
  pv.addEventListener('error', () => { $('#pvErr').hidden = false; });
  const pvClose = () => { pv.pause(); pv.removeAttribute('src'); pv.load(); $('#pvModal').hidden = true; };
  $('#pvClose').addEventListener('click', pvClose);
  $('#pvModal').addEventListener('click', e => { if (e.target.id === 'pvModal') pvClose(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#pvModal').hidden) pvClose(); });
  $('#pvFolder').addEventListener('click', () => pvPath && S.reveal(pvPath));
  $('#pvSys').addEventListener('click', () => pvPath && S.openPath(pvPath));

  /* ---------------- support (same page as the website's "Buy me a coffee") ---------------- */
  const coffee = () => S.url((App.info && App.info.supportUrl && App.info.supportUrl[App.lang]) || 'https://7krh-hub.pages.dev/ar/support/');
  $('#coffee').addEventListener('click', coffee); $('#sCoffee').addEventListener('click', coffee);
  $('#sSite').addEventListener('click', () => S.url(`https://7krh-hub.pages.dev/${App.lang}/`));

  /* ---------------- settings ---------------- */
  App.saveSet = async p => { App.settings = await S.settings.set(p); return App.settings; };
  $('#sLang').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; App.lang = b.dataset.v; App.saveSet({ lang: App.lang }); syncSettings(); App.applyLang(); });
  $('#sOutBtn').addEventListener('click', async () => { const f = await S.folder(); if (f) { await App.saveSet({ outDir: f }); $('#sOut').value = f; } });
  $('#sGpu').addEventListener('change', async e => { await App.saveSet({ gpuName: e.target.value }); if (App.caps) showCaps(App.caps); App.toast(t('gpu_changed'), '', 3000); });
  $('#sGpuOnly').addEventListener('change', e => App.saveSet({ gpuOnly: e.target.checked }));
  $('#sBackend').addEventListener('change', e => App.saveSet({ upBackend: e.target.value }));
  function syncSettings() {
    $$('#sLang button').forEach(b => b.classList.toggle('on', b.dataset.v === App.lang));
    $('#sBackend').value = App.settings.upBackend || 'auto';
    $('#sGpuOnly').checked = !!App.settings.gpuOnly;
  }

  /* ---------------- engine manager ---------------- */
  async function refreshEngines() {
    let list = [];
    try { list = await S.engines.status(); } catch (e) { return; }
    const box = $('#engines'); box.innerHTML = '';
    list.forEach(c => box.appendChild(h('div', { class: 'eng' },
      h('div', {}, h('b', { text: c.name }), h('small', { text: t('use_' + c.use) + ' · ' + c.license })),
      h('small', { text: c.detail || t('dev_' + c.device) }),
      h('span', { class: 'tag ' + ({ ready: 'ok', missing: 'bad', damaged: 'bad', failed: 'bad', incompatible: 'warn' }[c.state] || ''), text: t('es_' + c.state) }),
      h('span', { class: 'sz', text: c.bytes > 0 ? App.fmtSize(c.bytes) : '—' }))));
  }
  document.addEventListener('view', e => { if (e.detail === 'settings') refreshEngines(); });
  $('#sEngFolder').addEventListener('click', () => S.engines.folder());
  $('#sEngVerify').addEventListener('click', async () => {
    const out = $('#engVerifyOut'); out.className = 'hint'; out.textContent = t('eng_verifying');
    const off = S.onEngines(p => { out.textContent = t('eng_verifying') + ' ' + Math.round(p * 100) + '%'; });
    try {
      const r = await S.engines.verify();
      out.className = 'hint ' + (r.ok ? 'ok' : 'err');
      out.textContent = !r.hasHashes ? t('eng_nohash') : r.ok ? t('eng_ok', { n: r.checked }) : t('eng_bad', { n: r.bad.length }) + ' ' + r.bad.slice(0, 5).map(b => b.file).join(', ');
    } catch (e) { out.className = 'hint err'; out.textContent = App.errText(e); }
    off();
  });

  /* ---------------- keyboard: global ---------------- */
  App.typing = () => { const a = document.activeElement; return a && (/INPUT|SELECT|TEXTAREA/.test(a.tagName) || a.isContentEditable); };

  /* ---------------- boot ---------------- */
  (async () => {
    // every view script registers its listeners first
    await new Promise(r => (document.readyState === 'complete' ? r() : window.addEventListener('load', r, { once: true })));
    App.settings = await S.settings.get();
    App.info = await S.info();
    App.lang = App.settings.lang || (/^ar/i.test(App.info.locale || navigator.language) ? 'ar' : 'en');
    App.applyLang(); syncSettings();
    $('#ver').textContent = 'v' + App.info.version;
    $('#sAbout').textContent = '7krh Studio v' + App.info.version;
    $('#sOut').value = App.settings.outDir || App.info.outDir;
    $('#hwCpu').textContent = (App.info.cpu || '').replace(/\(R\)|\(TM\)|CPU|Processor/gi, '').replace(/\s+/g, ' ').trim() + ` · ${App.info.threads}T`;
    $('#hwRam').textContent = App.info.ramGB + ' GB';
    $('#rtBad').hidden = App.info.runtime.ok;
    App.view = null; App.go('home');
    loadHist();
    S.caps().then(showCaps).catch(() => {});
    S.diagCached().then(r => showBench(r && r.benchVersion >= 4 ? r : null)).catch(() => showBench(null));
    document.dispatchEvent(new CustomEvent('boot'));
  })();
})();
