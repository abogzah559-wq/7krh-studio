/* 7krh Studio — single-video enhance: trim / speed / shape / colour / sound, AI upscale (Real-ESRGAN through
   vs-mlrt on the GPU) and AI frame generation (RIFE), platform delivery identical to the website tool, and the
   website's "no re-encoding" method for uploading the original quality as is. */
(() => {
  'use strict';
  const { $, $$, S, t } = App;
  const vid = $('#vid');
  const st = {
    file: null, info: null, src: null, thumbs: [], tin: 0, tout: 0, speed: 1, crop: 'none', method: 'encode',
    adjust: { b: 0, c: 0, s: 0, g: 0, sh: 0 },
    audio: { mode: 'keep', file: null, volume: 1, musicVolume: 1, musicStart: 0 },
    up: { on: false, model: 'real', quality: 'balanced' }, fg: { on: false, model: '4.26' },
    out: { res: 'source', fps: 'source', codec: 'h264', quality: 'high', tenBit: false }, platform: 'self', fx: 'auto', tech: 'krypton',
  };
  const music = new Audio();
  const fps = () => App.fps(st.info);
  const dur = () => (st.info && st.info.duration) || vid.duration || 0;

  /* ---------------- load ---------------- */
  async function load(path, o = {}) {
    App.go('enhance');
    busy(t('loading'));
    try {
      const info = await S.probe(path);
      if (info.kind !== 'video') { busy(''); App.openPaths([path], 'home'); return; }
      Object.assign(st, { file: path, info, tin: 0, tout: info.duration || 0 });
      $('#eEmpty').hidden = true; vid.hidden = false; $('#cmp').hidden = true;
      $('#eName').textContent = info.name;
      const tags = $('#eTags'); tags.innerHTML = '';
      App.facts(info).forEach(x => tags.appendChild(App.h('span', { class: 'tag', text: x })));
      st.src = path;
      if (!(await canPlay(App.fileUrl(path)))) {
        busy(t('pv_proxy'));
        const off = S.onProxy(d => busy(t('pv_proxy') + ' ' + Math.round(d.p * 100) + '%'));
        try { st.src = await S.proxy(path, info); } finally { off(); }
      }
      vid.src = App.fileUrl(st.src); vid.currentTime = 0;
      busy('');
      $('#vthumbs').innerHTML = '';
      S.thumbs(path, info.duration, 14, 60).then(list => { st.thumbs = list; $('#vthumbs').innerHTML = ''; list.forEach(u => $('#vthumbs').appendChild(App.h('img', u ? { src: u } : {}))); });
      $('#exportBtn').disabled = false;
      if (o.copy) setMethod('copy'); else setMethod('encode');
      if (o.suggest) applySuggest(o.suggest);
      syncAll();
    } catch (e) { busy(''); App.toast(t('err_open') + ' ' + App.errText(e), 'err', 8000); }
  }
  function applySuggest(sg) {
    if (sg.upscale) { st.up.on = true; $('#upOn').checked = true; st.out.res = sg.res; setSeg('#resSeg', sg.res); }
    if (sg.framegen) { st.fg.on = true; $('#fgOn').checked = true; st.out.fps = sg.fps; setSeg('#fpsSeg', sg.fps); }
    if (sg.upscale || sg.framegen) { tab('ai'); App.toast(t('sg_applied'), '', 4000); }
  }
  function canPlay(url) {
    return new Promise(res => {
      const v = document.createElement('video'); v.muted = true; v.preload = 'auto';
      const done = ok => { clearTimeout(to); v.removeAttribute('src'); v.load(); res(ok); };
      const to = setTimeout(() => done(false), 6000);
      v.onloadeddata = () => done(v.videoWidth > 0); v.onerror = () => done(false); v.src = url;
    });
  }
  function busy(s) { $('#pBusy').hidden = !s; $('#pBusyTxt').textContent = s || ''; }

  /* ---------------- transport ---------------- */
  const playIcon = () => { $('#vPlay use').setAttribute('href', vid.paused ? '#i-play' : '#i-pause'); };
  $('#vPlay').addEventListener('click', () => toggle());
  function toggle() {
    if (!st.file) return;
    if (vid.paused) { if (vid.currentTime >= st.tout - 0.03 || vid.currentTime < st.tin) vid.currentTime = st.tin; vid.play(); } else vid.pause();
  }
  $('#vPrev').addEventListener('click', () => { vid.pause(); vid.currentTime = Math.max(0, vid.currentTime - 1 / fps()); });
  $('#vNext').addEventListener('click', () => { vid.pause(); vid.currentTime = Math.min(dur(), vid.currentTime + 1 / fps()); });
  vid.addEventListener('play', () => { playIcon(); syncMusic(true); });
  vid.addEventListener('pause', () => { playIcon(); music.pause(); });
  vid.addEventListener('timeupdate', () => { if (!vid.paused && vid.currentTime >= st.tout) { vid.pause(); vid.currentTime = st.tout; } drawTime(); });
  vid.addEventListener('seeked', () => { drawTime(); syncMusic(!vid.paused); });
  function drawTime() {
    $('#vTime').textContent = App.fmtTime(vid.currentTime) + ' / ' + App.fmtTime(dur());
    $('#vph').style.left = (vid.currentTime / (dur() || 1) * 100) + '%';
  }
  document.addEventListener('keydown', e => {
    if (App.view !== 'enhance' || App.typing() || !$('#dlg').hidden) return;
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
    else if (e.code === 'ArrowLeft') $('#vPrev').click();
    else if (e.code === 'ArrowRight') $('#vNext').click();
    else if (e.key === 'i' || e.key === 'I') setIn(vid.currentTime);
    else if (e.key === 'o' || e.key === 'O') setOut(vid.currentTime);
  });

  /* ---------------- trim bar ---------------- */
  const tl = $('#trimbar');
  let drag = null;
  const tAt = e => { const r = tl.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur(); };
  tl.addEventListener('pointerdown', e => { if (!st.file) return; tl.setPointerCapture(e.pointerId); drag = e.target.id === 'hIn' ? 'in' : e.target.id === 'hOut' ? 'out' : 'seek'; move(e); });
  tl.addEventListener('pointermove', e => { if (drag) move(e); });
  tl.addEventListener('pointerup', () => { drag = null; });
  function move(e) { const x = tAt(e); if (drag === 'in') setIn(x); else if (drag === 'out') setOut(x); else { vid.pause(); vid.currentTime = x; } }
  function setIn(x) { st.tin = Math.max(0, Math.min(x, st.tout - 0.1)); vid.currentTime = st.tin; syncTrim(); }
  function setOut(x) { st.tout = Math.min(dur(), Math.max(x, st.tin + 0.1)); vid.currentTime = st.tout; syncTrim(); }
  function syncTrim() {
    const d = dur() || 1, a = st.tin / d * 100, b = st.tout / d * 100;
    $('#hIn').style.left = a + '%'; $('#hOut').style.left = b + '%';
    $('#tsel').style.left = a + '%'; $('#tsel').style.width = (b - a) + '%';
    $('#shL').style.left = '0'; $('#shL').style.width = a + '%';
    $('#shR').style.left = b + '%'; $('#shR').style.right = '0';
    $('#tIn').value = st.tin.toFixed(2); $('#tOut').value = st.tout.toFixed(2);
    $('#tLen').textContent = App.fmtTime((st.tout - st.tin) / st.speed);
    summarySoon();
  }
  $('#tIn').addEventListener('change', e => setIn(+e.target.value));
  $('#tOut').addEventListener('change', e => setOut(+e.target.value));
  $('#setIn').addEventListener('click', () => setIn(vid.currentTime));
  $('#setOut').addEventListener('click', () => setOut(vid.currentTime));

  /* ---------------- method: re-encode / no re-encoding (website) ---------------- */
  function setMethod(m) {
    st.method = m; setSeg('#methodSeg', m);
    const copy = m === 'copy';
    $('#methodHint').textContent = t(copy ? 'hCopy' : 'hEnh');
    $$('#enhTabs button').forEach(b => { b.disabled = copy && b.dataset.t !== 'export'; });
    if (copy) tab('export');
    $('#encOnly').hidden = copy; $('#aiPrev').disabled = copy;
    if (copy && st.platform === 'self') { st.platform = 'tiktok'; $$('#plats .plat').forEach(x => x.classList.toggle('on', x.dataset.p === 'tiktok')); }
    platHint(); summarySoon();
  }
  seg('#methodSeg', v => setMethod(v));

  /* ---------------- inspector ---------------- */
  function tab(k) { $$('#enhTabs button').forEach(x => x.classList.toggle('on', x.dataset.t === k)); ['edit', 'ai', 'export'].forEach(n => { $('#p-' + n).hidden = n !== k; }); }
  $$('#enhTabs button').forEach(b => b.addEventListener('click', () => { if (!b.disabled) tab(b.dataset.t); }));
  function seg(id, cb) { const g = $(id); g.addEventListener('click', e => { const b = e.target.closest('button'); if (!b || b.disabled) return; [...g.children].forEach(x => x.classList.toggle('on', x === b)); cb(b.dataset.v); }); }
  const setSeg = (id, v) => [...$(id).children].forEach(x => x.classList.toggle('on', x.dataset.v === String(v)));
  seg('#speedSeg', v => { st.speed = +v; vid.playbackRate = st.speed; syncTrim(); });
  seg('#cropSeg', v => { st.crop = v; previewLook(); summarySoon(); });
  $$('[data-adj]').forEach(r => r.addEventListener('input', () => { st.adjust[r.dataset.adj] = +r.value; $('#v-' + r.dataset.adj).textContent = r.value; previewLook(); }));
  $('#adjReset').addEventListener('click', () => { $$('[data-adj]').forEach(r => { r.value = 0; st.adjust[r.dataset.adj] = 0; $('#v-' + r.dataset.adj).textContent = '0'; }); previewLook(); });
  seg('#audSeg', v => { st.audio.mode = v; syncAudio(); });
  $('#musicPick').addEventListener('click', async () => { const f = (await S.open('audio'))[0]; if (f) { st.audio.file = f; music.src = App.fileUrl(f); syncAudio(); } });
  $('#mvol').addEventListener('input', e => { st.audio.musicVolume = e.target.value / 100; $('#v-mvol').textContent = e.target.value + '%'; music.volume = Math.min(1, st.audio.musicVolume); });
  $('#vol').addEventListener('input', e => { st.audio.volume = e.target.value / 100; $('#v-vol').textContent = e.target.value + '%'; vid.volume = Math.min(1, st.audio.volume); });
  $('#mstart').addEventListener('change', e => { st.audio.musicStart = Math.max(0, +e.target.value || 0); syncMusic(!vid.paused); });
  function syncAudio() {
    const m = st.audio.mode;
    $('#musicBox').hidden = !(m === 'replace' || m === 'mix');
    $('#volBox').hidden = m === 'mute' || m === 'replace';
    vid.muted = m === 'mute' || m === 'replace';
    $('#musicName').textContent = st.audio.file ? App.base(st.audio.file) : t('a_pick');
    syncMusic(!vid.paused); summarySoon();
  }
  function syncMusic(play) {
    const on = st.audio.file && (st.audio.mode === 'replace' || st.audio.mode === 'mix');
    if (!on) { music.pause(); return; }
    music.currentTime = st.audio.musicStart + Math.max(0, vid.currentTime - st.tin) / st.speed;
    if (play) music.play().catch(() => {}); else music.pause();
  }
  /* the preview uses the same colour maths as the export (SVG filter = lookup table + matrix + kernel) */
  function previewLook() {
    vid.style.filter = window.svgFilter(st.adjust);
    const info = st.info; if (!info) return;
    const w = info.rotation % 180 ? info.height : info.width, hh = info.rotation % 180 ? info.width : info.height;
    if (st.crop === 'none') { vid.style.clipPath = ''; return; }
    const [x, y] = st.crop.split(':').map(Number), want = x / y, have = w / hh;
    if (have > want) { const k = (1 - want / have) / 2 * 100; vid.style.clipPath = `inset(0 ${k}% 0 ${k}%)`; }
    else { const k = (1 - have / want) / 2 * 100; vid.style.clipPath = `inset(${k}% 0 ${k}% 0)`; }
  }
  $('#upOn').addEventListener('change', e => { st.up.on = e.target.checked; aiHint(); summarySoon(); });
  $('#fgOn').addEventListener('change', e => { st.fg.on = e.target.checked; aiHint(); summarySoon(); });
  seg('#upModel', v => { st.up.model = v; summarySoon(); });
  seg('#upQ', v => { st.up.quality = v; $('#upQHint').textContent = t('aq_' + v + '_h'); summarySoon(); });
  seg('#fgModel', v => { st.fg.model = v; summarySoon(); });
  function aiHint() {
    const hh = $('#aiHint');
    hh.textContent = !st.up.on && !st.fg.on ? t('ai_off_hint') : '';
    if (st.up.on && st.out.res === 'source' && st.info) { const s = Math.min(st.info.width, st.info.height); st.out.res = s < 1000 ? '1080' : '2160'; setSeg('#resSeg', st.out.res); }
    if (st.fg.on && st.out.fps === 'source') { st.out.fps = fps() > 45 ? '120' : '60'; setSeg('#fpsSeg', st.out.fps); }
    $('#upQHint').textContent = t('aq_' + st.up.quality + '_h');
  }
  seg('#resSeg', v => { st.out.res = v; summarySoon(); });
  seg('#fpsSeg', v => { st.out.fps = v; summarySoon(); });
  $('#codec').addEventListener('change', e => { st.out.codec = e.target.value; if (e.target.value === 'h264') { $('#tenBit').checked = false; st.out.tenBit = false; } codecHint(); summarySoon(); });
  function codecHint() {
    const c = App.caps || {}, hh = $('#codecHint');
    const miss = st.out.codec === 'hevc' ? c.hevcExt === false : st.out.codec === 'av1' ? c.av1Ext === false : false;
    hh.hidden = !miss; hh.textContent = miss ? t('codec_ext_' + st.out.codec) : '';
  }
  document.addEventListener('caps', codecHint);
  $('#quality').addEventListener('change', e => { st.out.quality = e.target.value; summarySoon(); });
  $('#tenBit').addEventListener('change', e => { st.out.tenBit = e.target.checked; if (st.out.tenBit && st.out.codec === 'h264') { st.out.codec = 'hevc'; $('#codec').value = 'hevc'; } codecHint(); summarySoon(); });
  $('#plats').addEventListener('click', e => {
    const b = e.target.closest('.plat'); if (!b) return;
    st.platform = b.dataset.p; $$('#plats .plat').forEach(x => x.classList.toggle('on', x === b));
    platHint(); summarySoon();
  });
  $('#fx').addEventListener('change', e => { st.fx = e.target.value; summarySoon(); });
  $('#tech').addEventListener('change', e => { st.tech = e.target.value; summarySoon(); });
  function platHint() {
    $('#platHint').textContent = t('p_' + st.platform + '_h');
    $('#tikBox').hidden = st.platform !== 'tiktok';
    $('#techRow').hidden = st.method !== 'copy';
  }

  /* ---------------- plan / summary ---------------- */
  function opts(outPath, preview) {
    return {
      input: st.file, outPath, preview: !!preview,
      trim: { start: preview ? vid.currentTime : st.tin, end: st.tout }, speed: preview ? 1 : st.speed, crop: st.crop, adjust: { ...st.adjust },
      audio: { ...st.audio },
      enhance: { upscale: { ...st.up }, framegen: { ...st.fg } },
      output: { ...st.out, fps: st.out.fps === 'source' ? 'source' : +st.out.fps },
    };
  }
  const req = outPath => (st.method === 'copy'
    ? { type: 'copy', input: st.file, outPath, info: st.info, platform: st.platform, fx: st.fx, tech: st.tech }
    : { type: 'enhance', opts: opts(outPath), info: st.info, platform: st.platform, fx: st.fx });
  let sumT = 0;
  function summarySoon() { clearTimeout(sumT); sumT = setTimeout(summary, 120); }
  async function summary() {
    if (!st.file) return;
    $('#fpsHint').hidden = !(st.method === 'encode' && st.out.fps !== 'source' && +st.out.fps > fps() * 1.05 && !st.fg.on);
    $('#oErr').hidden = true;
    try {
      const p = await S.plan(req('x.mp4'));
      const ex = p.expect;
      $('#oRes').textContent = st.method === 'copy' ? t('eQv') : `${ex.w}×${ex.h}` + (p.up ? ` · AI ×${p.up.scale}` : '');
      $('#oFps').textContent = (Math.round((ex.fps || fps()) * 100) / 100) + ' fps' + (p.fg ? ` · RIFE ×${(p.fg.num / p.fg.den).toFixed(p.fg.den === 1 ? 0 : 2)}` : '');
      $('#oDur').textContent = App.fmtTime(ex.dur, false) + (ex.kfactor > 1 ? ` → ${App.fmtTime(ex.finalDur, false)} (×${ex.kfactor})` : '');
      $('#oEnc').textContent = st.method === 'copy' ? t('mt_' + p.method) : String(p.encoder).replace('_', ' ').toUpperCase() + (/nvenc|amf|qsv/.test(p.encoder) ? ' (GPU)' : ' (CPU)');
      const f = ex.fps || fps(), k = ex.kfactor || 1;
      $('#fxHint').textContent = st.platform !== 'tiktok' ? '' : k <= 1 ? t('fxHlow', { f: 30 }) : t('fxH', { f: Math.round(f * 100) / 100, d: Math.round(f / k * 100) / 100, k }) + (st.method === 'encode' ? ' ' + t('fxHenh') : '');
      const ui = $('#upInfo');
      if (p.up) {
        let txt = t('up_info', { in: `${p.up.inW}×${p.up.inH}`, out: `${ex.w}×${ex.h}` }) + ' ' + t('up_engine', { e: { trt: 'TensorRT', ort: 'DirectML', ncnn: 'Vulkan', cpu: 'CPU' }[p.up.backend] || p.up.backend, g: p.device || '' });
        const eta = estimate(p); if (eta) txt += ' ' + t('up_info_eta', { t: App.fmtDur(eta) });
        ui.textContent = txt;
      } else ui.textContent = '';
      $('#fgInfo').textContent = p.fg ? t('fg_info', { a: Math.round(fps() * 100) / 100, b: Math.round(ex.fps * 100) / 100 }) : '';
      $('#exportBtn').disabled = false;
    } catch (e) {
      $('#oErr').hidden = false; $('#oErr').textContent = App.errText(e);
      $('#exportBtn').disabled = e.code === 'lowFps' || e.code === 'notMp4' || e.code === 'gpuOnlyEncode';
    }
  }
  /* estimate from this PC's measured speeds (performance test), whole pipeline when measured */
  function estimate(p) {
    const v = App.bench && App.bench.vs; if (!v) return null;
    const srcFrames = (st.tout - st.tin) * fps();
    let secs = 0;
    if (p.up) {
      const short = Math.min(p.up.inW, p.up.inH), key = short <= 600 ? 540 : short <= 900 ? 720 : 1080;
      const f = v[`esrgan_${p.up.backend}_${key}p_fps`] || Math.max(v[`esrgan_ort_${key}p_fps`] || 0, v[`esrgan_ncnn_${key}p_fps`] || 0);
      if (!f) return null;
      // the measured end-to-end run tells how much decode + encode adds on top of the model
      const e2e = App.bench.e2e, model720 = v[`esrgan_${p.up.backend}_720p_fps`];
      const overhead = e2e && e2e.e2e_1080_to_4k_fps && model720 ? Math.max(1, model720 / e2e.e2e_1080_to_4k_fps) : 1.15;
      secs += srcFrames / f * overhead;
    }
    if (p.fg) { const f = v[`rife_4.26_${Math.min(p.expect.w, p.expect.h) > 1300 ? 2160 : 1080}p_fps`]; if (f) secs += p.expect.frames / f; }
    return secs || null;
  }
  function syncAll() { syncTrim(); syncAudio(); previewLook(); platHint(); aiHint(); drawTime(); vid.playbackRate = st.speed; }
  document.addEventListener('lang', () => { if (st.file) { syncAudio(); platHint(); aiHint(); summary(); $('#methodHint').textContent = t(st.method === 'copy' ? 'hCopy' : 'hEnh'); } else platHint(); });
  document.addEventListener('caps', summarySoon);
  document.addEventListener('bench', summarySoon);
  document.addEventListener('view', e => { if (e.detail !== 'enhance' && !vid.paused) vid.pause(); });

  /* ---------------- export ---------------- */
  $('#exportBtn').addEventListener('click', async () => {
    if (!st.file) return;
    const copy = st.method === 'copy';
    const suffix = st.platform !== 'self' ? '_' + st.platform : (st.up.on || st.fg.on ? '_7krh' : '_edit');
    const ext = copy ? ((st.tech === 'patch' && st.platform === 'tiktok' && /\.(mov|m4v)$/i.test(st.file)) ? st.file.split('.').pop().toLowerCase() : 'mp4') : 'mp4';
    const out = await S.outName(st.file, suffix, ext);
    const btn = $('#exportBtn'); btn.disabled = true;
    try {
      await App.startJob(req(out), { name: App.base(out), thumb: st.thumbs[Math.floor(st.thumbs.length / 2)] || null });
      App.go('queue');
    } catch (e) { App.toast(App.errText(e), 'err', 9000); }
    btn.disabled = false;
  });

  /* ---------------- AI preview: one frame through the real export pipeline ---------------- */
  const cmpV = App.Compare($('#cmpCv'), $('#cmp'), z => { $('#cmpZoom').textContent = z + '%'; });
  $$('#cmp .zoombar [data-z]').forEach(b => b.addEventListener('click', () => cmpV.zoomTo(+b.dataset.z)));
  $('#aiPrev').addEventListener('click', async () => {
    if (!st.file) return;
    if (!st.up.on && !st.fg.on) { App.toast(t('ai_off_hint')); return; }
    vid.pause(); busy(t('ai_previewing'));
    try {
      const r = await S.preview(opts(null, true), st.info, vid.currentTime);
      const [a, b] = await Promise.all([loadImg(App.fileUrl(r.before) + '?' + Date.now()), loadImg(App.fileUrl(r.after) + '?' + Date.now())]);
      $('#cmp').hidden = false; cmpV.set(a, b); cmpV.zoomTo(1);
      App.status(t('prev_took', { s: r.secs.toFixed(1) }));
    } catch (e) { App.toast(t('err_preview') + ': ' + App.errText(e), 'err', 9000); }
    busy('');
  });
  const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  $('#cmpClose').addEventListener('click', () => { $('#cmp').hidden = true; cmpV.clear(); });

  const open = async () => { const f = (await S.open('video'))[0]; if (f) load(f); };
  $('#eOpen').addEventListener('click', open); $('#eOpen2').addEventListener('click', open);
  window.Enhance = { load };
})();
