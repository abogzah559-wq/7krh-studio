/* 7krh Studio — core: language, navigation, home, exports queue, settings */
(() => {
  'use strict';
  const S = window.studio;
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const App = window.App = { $, $$, S, lang: 'en', settings: {}, info: null, caps: null };

  /* ---------------- text ---------------- */
  App.t = k => (I18N[App.lang] && I18N[App.lang][k] != null ? I18N[App.lang][k] : (I18N.en[k] != null ? I18N.en[k] : k));
  App.applyLang = () => {
    const d = I18N[App.lang].dir;
    document.documentElement.dir = d; document.documentElement.lang = App.lang;
    $$('[data-i]').forEach(e => { e.textContent = App.t(e.dataset.i); });
    document.dispatchEvent(new CustomEvent('lang'));
  };
  App.fmtTime = (s, cs = true) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60), x = s - m * 60;
    return m + ':' + (cs ? x.toFixed(2).padStart(5, '0') : String(Math.floor(x)).padStart(2, '0'));
  };
  App.fmtDur = s => {
    if (!isFinite(s) || s == null) return App.t('unknown');
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + ' ' + App.t('secs');
    if (s < 3600) return Math.floor(s / 60) + ' ' + App.t('mins') + ' ' + String(s % 60).padStart(2, '0') + ' ' + App.t('secs');
    return Math.floor(s / 3600) + ' ' + App.t('hrs') + ' ' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + ' ' + App.t('mins');
  };
  App.fmtSize = b => b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  App.fileUrl = p => 'file:///' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:');

  /* ---------------- toasts ---------------- */
  App.toast = (msg, kind = '', ms = 4200) => {
    const el = document.createElement('div'); el.className = 'toast ' + kind; el.textContent = msg;
    $('#toasts').appendChild(el); setTimeout(() => el.remove(), ms);
  };

  /* ---------------- navigation ---------------- */
  App.go = v => {
    $$('.nav').forEach(n => n.classList.toggle('on', n.dataset.v === v));
    $$('.view').forEach(x => { x.hidden = x.id !== 'v-' + v; });
    App.view = v;
    $('#crumb').textContent = v === 'home' ? '' : App.t('nav_' + v);
    document.dispatchEvent(new CustomEvent('view', { detail: v }));
  };
  $$('.nav').forEach(n => n.addEventListener('click', () => App.go(n.dataset.v)));
  $$('.card[data-go]').forEach(c => c.addEventListener('click', () => App.go(c.dataset.go)));

  /* ---------------- open files from anywhere ---------------- */
  const IMG = /\.(png|jpe?g|webp|bmp|tiff?|avif|heic)$/i;
  App.openPaths = async (paths, prefer) => {
    if (!paths || !paths.length) return;
    const imgs = paths.filter(p => IMG.test(p)), vids = paths.filter(p => !IMG.test(p));
    if (vids.length && prefer !== 'images') { App.go('edit'); window.Editor && Editor.load(vids[0]); return; }
    if (imgs.length) { App.go('images'); window.Images.add(imgs); }
  };
  $('#homeDrop').addEventListener('click', async () => App.openPaths(await S.open('any', true)));
  let dragN = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); dragN++; $('#dropVeil').hidden = false; });
  window.addEventListener('dragleave', e => { e.preventDefault(); if (--dragN <= 0) { dragN = 0; $('#dropVeil').hidden = true; } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault(); dragN = 0; $('#dropVeil').hidden = true;
    const ps = [...e.dataTransfer.files].map(f => S.pathOf(f)).filter(Boolean);
    App.openPaths(ps, App.view);
  });

  /* ---------------- hardware ---------------- */
  function showCaps(c) {
    App.caps = c;
    const g = (c.gpus || [])[0];
    const enc = c.encoders || [];
    const hw = enc.filter(e => /nvenc|amf|qsv/.test(e));
    const vendor = !g ? '' : /nvidia|geforce|rtx|gtx/i.test(g.name) ? 'NV' : /amd|radeon/i.test(g.name) ? 'AMD' : /intel|arc/i.test(g.name) ? 'INTEL' : 'GPU';
    $('#gpuIco').textContent = vendor || 'CPU';
    $('#gpuIco').style.background = vendor === 'NV' ? 'linear-gradient(135deg,#76b900,#2e7d32)' : vendor === 'AMD' ? 'linear-gradient(135deg,#ed1c24,#8b0000)' : vendor === 'INTEL' ? 'linear-gradient(135deg,#0071c5,#00285a)' : 'var(--grad)';
    $('#gpuName').textContent = g ? g.name : App.t('gpu_none');
    $('#gpuSub').textContent = g && g.vramMB ? (g.vramMB / 1024).toFixed(g.vramMB % 1024 ? 1 : 0) + ' GB VRAM' + (g.driver ? ' · ' + g.driver : '') : '';
    $('#hwEnc').textContent = hw.length ? [...new Set(hw.map(e => e.split('_')[1].toUpperCase()))].join(' / ') + ' · ' + hw.map(e => e.split('_')[0].replace('hevc', 'HEVC').replace('h264', 'H.264').replace('av1', 'AV1')).filter((x, i, a) => a.indexOf(x) === i).join(' · ') : 'CPU';
    $('#hwMiniTxt').innerHTML = '';
    const b = document.createElement('b'); b.textContent = g ? g.name.replace(/^NVIDIA\s+/i, '') : 'CPU';
    const s = document.createElement('span'); s.textContent = hw.length ? 'GPU · ' + (hw.some(e => e.includes('nvenc')) ? 'NVENC' : hw[0].split('_')[1].toUpperCase()) : 'CPU';
    $('#hwMiniTxt').append(b, s);
    const sel = $('#sGpu'); sel.innerHTML = '';
    (c.gpus || []).forEach((x, i) => { const o = document.createElement('option'); o.value = i; o.textContent = x.name; sel.appendChild(o); });
    sel.value = String(App.settings.gpu || 0);
    document.dispatchEvent(new CustomEvent('caps'));
  }
  function showBench(r) {
    if (!r) return;
    App.bench = r;
    const box = $('#benchBox'); box.hidden = false; box.innerHTML = '';
    const rows = [];
    const v = r.vs || {}, im = r.image || {};
    const eng = { trt: 'TensorRT', ort: 'DirectML', ncnn: 'Vulkan' };
    const best = r.best || ['trt', 'ort', 'ncnn'].find(n => v[`esrgan_${n}_720p_fps`]);
    if (best && v[`esrgan_${best}_720p_fps`]) rows.push([`AI 4K (${eng[best]})`, v[`esrgan_${best}_720p_fps`].toFixed(1) + ' fps']);
    if (v['rife_4.26_2160p_fps']) rows.push(['RIFE 4.26 · 4K', v['rife_4.26_2160p_fps'] + ' fps']);
    if (v['rife_4.26_1080p_fps']) rows.push(['RIFE 4.26 · 1080p', v['rife_4.26_1080p_fps'] + ' fps']);
    rows.forEach(([k, val]) => { const d = document.createElement('div'); d.className = 'row'; const a = document.createElement('span'); a.textContent = k; const b = document.createElement('b'); b.textContent = val; d.append(a, b); box.appendChild(d); });
    const errs = Object.keys(v).filter(k => /error/.test(k) && !/not installed/.test(v[k]));
    if (!rows.length || errs.length) { const d = document.createElement('div'); d.className = 'hint warn'; d.textContent = App.t('bench_partial'); box.appendChild(d); }
    document.dispatchEvent(new CustomEvent('bench'));
  }
  App.runBench = async () => {
    const btn = $('#benchBtn'); btn.disabled = true; $('#sDiag').disabled = true;
    btn.querySelector('span').textContent = App.t('hw_benching');
    try {
      const { file, report } = await S.diag();
      showBench(report); showCaps(report.caps);
      $('#sDiagOut').textContent = file;
    } catch (e) { App.toast(String(e.message || e), 'err', 8000); }
    btn.disabled = false; $('#sDiag').disabled = false; btn.querySelector('span').textContent = App.t('hw_bench');
  };
  $('#benchBtn').addEventListener('click', App.runBench);
  // background measurement on first start
  S.onDiag && S.onDiag(p => {
    const btn = $('#benchBtn');
    if (p.step === 'done') { btn.disabled = false; $('#sDiag').disabled = false; btn.querySelector('span').textContent = App.t('hw_bench'); if (p.report) { showBench(p.report); showCaps(p.report.caps); } return; }
    btn.disabled = true; $('#sDiag').disabled = true;
    btn.querySelector('span').textContent = App.t('hw_tuning') + (p.step ? ' · ' + (App.t('st_' + p.step.replace(/_.*/, '')) || '') : '');
  });
  $('#sDiag').addEventListener('click', App.runBench);

  /* ---------------- exports queue ---------------- */
  const Q = App.queue = new Map();
  function qRender(id) {
    const j = Q.get(id); if (!j) return;
    let el = $('#q' + id);
    if (!el) {
      el = document.createElement('div'); el.className = 'qitem'; el.id = 'q' + id;
      el.innerHTML = '<div class="th"></div><div><b></b><div class="st"></div><div class="bar"><i></i></div></div><div class="acts"></div>';
      $('#qlist').prepend(el);
      if (j.thumb) el.querySelector('.th').style.backgroundImage = `url("${j.thumb}")`;
    }
    $('#qEmpty').hidden = true;
    el.querySelector('b').textContent = j.name;
    el.className = 'qitem' + (j.state === 'done' ? ' done' : j.state === 'error' ? ' err' : '');
    const st = el.querySelector('.st'); st.innerHTML = '';
    const add = (txt, ltr) => { const s = document.createElement(ltr ? 'span' : 'em'); s.style.fontStyle = 'normal'; s.textContent = txt; st.appendChild(s); };
    if (j.state === 'run') {
      add(App.t(j.phase === 'ai' ? 'q_ai' : j.phase === 'platform' ? 'q_platform' : 'q_encode'));
      add(Math.round((j.frac || 0) * 100) + '%', 1);
      if (j.fps) add(j.fps.toFixed(1) + ' ' + App.t('q_fps'), 1);
      if (j.eta != null) add(App.fmtDur(j.eta) + ' ' + App.t('q_eta'));
    } else if (j.state === 'done') {
      add(App.t('q_done')); add(`${j.expect.w}×${j.expect.h} · ${Math.round(j.expect.fps * 100) / 100} fps`, 1); add(App.fmtSize(j.size || 0), 1); add(App.t('q_took') + ' ' + App.fmtDur(j.secs));
    } else if (j.state === 'error') add(App.t(j.cancelled ? 'q_cancel' : 'q_err'));
    const bar = el.querySelector('.bar'); bar.className = 'bar' + (j.phase === 'ai' ? ' ai' : '');
    bar.querySelector('i').style.width = (j.state === 'done' ? 100 : (j.frac || 0) * 100) + '%';
    bar.hidden = j.state !== 'run';
    const acts = el.querySelector('.acts'); acts.innerHTML = '';
    if (j.state === 'run') { const c = document.createElement('button'); c.className = 'btn sm'; c.textContent = App.t('cancel'); c.onclick = () => S.cancel(id); acts.appendChild(c); }
    if (j.state === 'done') {
      const o = document.createElement('button'); o.className = 'btn sm primary'; o.textContent = App.t('play'); o.onclick = () => App.play(j.out, j.expect);
      const f = document.createElement('button'); f.className = 'btn sm'; f.textContent = App.t('open_folder'); f.onclick = () => S.reveal(j.out);
      acts.append(o, f);
    }
    let lg = el.querySelector('.errlog');
    if (j.state === 'error' && !j.cancelled && j.err) { if (!lg) { lg = document.createElement('div'); lg.className = 'errlog'; el.appendChild(lg); } lg.textContent = j.err + (j.log ? '\n\n' + j.log : ''); }
    else if (lg) lg.remove();
    const running = [...Q.values()].filter(x => x.state === 'run').length;
    $('#qBadge').hidden = !running; $('#qBadge').textContent = running;
  }
  /* finished exports survive restarts */
  const HK = '7krh.history';
  function saveHist(j) {
    try {
      const h = JSON.parse(localStorage.getItem(HK) || '[]').filter(x => x.out !== j.out);
      h.unshift({ name: j.name, out: j.out, size: j.size, secs: j.secs, expect: j.expect, thumb: j.thumb, at: Date.now() });
      localStorage.setItem(HK, JSON.stringify(h.slice(0, 40)));
    } catch (e) {}
  }
  function loadHist() {
    let h = []; try { h = JSON.parse(localStorage.getItem(HK) || '[]'); } catch (e) {}
    h.slice().reverse().forEach((x, i) => { const id = 'h' + i; Q.set(id, { ...x, id, state: 'done', old: true }); qRender(id); });
  }
  App.addJob = (id, meta) => { Q.set(id, { id, state: 'run', frac: 0, phase: 'encode', ...meta }); qRender(id); };
  S.onJob(ev => {
    const j = Q.get(ev.id); if (!j) return;
    if (ev.type === 'progress') { j.frac = ev.frac; if (ev.fps != null) j.fps = ev.fps; if (ev.eta !== undefined) j.eta = ev.eta; }
    else if (ev.type === 'phase') j.phase = ev.phase;
    else if (ev.type === 'done') { Object.assign(j, { state: 'done', out: ev.out, size: ev.size, secs: ev.secs, expect: ev.expect }); App.toast(App.t('toast_done') + ' — ' + j.name, 'ok'); saveHist(j); }
    else if (ev.type === 'error') Object.assign(j, { state: 'error', err: ev.err, log: ev.log, cancelled: ev.cancelled });
    qRender(ev.id);
    document.dispatchEvent(new CustomEvent('jobev', { detail: ev }));
  });

  /* ---------------- built-in player (plays H.264/HEVC/AV1 with the GPU decoder, no Windows extension needed) ---------------- */
  const pv = $('#pvVid'); let pvPath = null;
  App.play = (p, ex) => {
    pvPath = p; $('#pv').hidden = false; $('#pvErr').hidden = true;
    $('#pvName').textContent = p.split(/[\\/]/).pop();
    $('#pvInfo').textContent = ex ? `${ex.w}×${ex.h} · ${Math.round(ex.fps * 100) / 100} fps` : '';
    pv.src = App.fileUrl(p); pv.play().catch(() => {});
  };
  pv.addEventListener('error', () => { $('#pvErr').hidden = false; });
  const pvClose = () => { pv.pause(); pv.removeAttribute('src'); pv.load(); $('#pv').hidden = true; };
  $('#pvClose').addEventListener('click', pvClose);
  $('#pv').addEventListener('click', e => { if (e.target.id === 'pv') pvClose(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#pv').hidden) pvClose(); });
  $('#pvFolder').addEventListener('click', () => pvPath && S.reveal(pvPath));
  $('#pvSys').addEventListener('click', () => pvPath && S.openPath(pvPath));

  /* ---------------- settings ---------------- */
  async function saveSet(p) { App.settings = await S.settings.set(p); }
  $('#sLang').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; App.lang = b.dataset.v; saveSet({ lang: App.lang }); syncSettings(); App.applyLang(); });
  $('#sOutBtn').addEventListener('click', async () => { const f = await S.folder(); if (f) { await saveSet({ outDir: f }); $('#sOut').value = f; } });
  $('#sGpu').addEventListener('change', e => saveSet({ gpu: +e.target.value }));
  $('#sBackend').addEventListener('change', e => saveSet({ upBackend: e.target.value }));
  $('#sSite').addEventListener('click', e => { e.preventDefault(); S.url('https://7krh-hub.pages.dev/'); });
  function syncSettings() {
    $$('#sLang button').forEach(b => b.classList.toggle('on', b.dataset.v === App.lang));
    $('#sBackend').value = App.settings.upBackend || 'auto';
  }

  /* ---------------- boot ---------------- */
  (async () => {
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
    App.go('home');
    loadHist();
    S.caps().then(showCaps).catch(() => {});
    S.diagCached && S.diagCached().then(showBench).catch(() => {});
  })();
})();
