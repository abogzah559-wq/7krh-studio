/* 7krh Studio — video studio: player, timeline, edit / AI / export inspector */
(() => {
  'use strict';
  const { $, $$, S, t } = App;
  const vid = $('#vid');
  const st = {
    file: null, info: null, src: null, thumbs: [], tin: 0, tout: 0, speed: 1, crop: 'none',
    adjust: { brightness: 0, contrast: 0, saturation: 0, sharpen: 0 },
    audio: { mode: 'keep', file: null, volume: 1, musicVolume: 1, musicStart: 0 },
    up: { on: false, model: 'real', quality: 'balanced' }, fg: { on: false, model: '4.26' },
    out: { res: 'source', fps: 'source', codec: 'h264', quality: 'high', tenBit: false }, platform: 'self',
  };
  const music = new Audio();
  const fps = () => { const r = String(st.info && st.info.fps || '30').split('/'); return r.length === 2 ? r[0] / r[1] : +r[0] || 30; };
  const dur = () => (st.info && st.info.duration) || vid.duration || 0;

  /* ---------------- load ---------------- */
  async function load(path) {
    busy(t('home_drop'));
    try {
      const info = await S.probe(path);
      if (info.kind !== 'video') { busy(''); if (info.kind === 'image') { App.openPaths([path], 'images'); } else App.toast(t('err_open'), 'err'); return; }
      st.file = path; st.info = info; st.tin = 0; st.tout = info.duration || 0;
      $('#eEmpty').hidden = true; vid.hidden = false; $('#cmp').hidden = true;
      $('#eName').textContent = info.name;
      const tags = $('#eTags'); tags.innerHTML = '';
      [`${info.rotation % 180 ? info.height : info.width}×${info.rotation % 180 ? info.width : info.height}`, (Math.round(fps() * 100) / 100) + ' fps', '⏱ ' + App.fmtTime(info.duration, false), (info.vcodec || '').toUpperCase() + (info.bitDepth > 8 ? ' 10-bit' : '') + (info.hdr ? ' HDR' : ''), App.fmtSize(info.size)]
        .forEach(x => { const s = document.createElement('span'); s.className = 'tag'; s.textContent = x; tags.appendChild(s); });
      // Chromium plays H.264/VP9/AV1 (+HEVC with the HW decoder); anything else gets a light proxy for preview only
      st.src = path;
      const ok = await canPlay(App.fileUrl(path));
      if (!ok) {
        busy('Preview…');
        const off = S.onProxy(p => busy('Preview… ' + Math.round(p * 100) + '%'));
        try { st.src = await S.proxy(path, info); } finally { off(); }
      }
      vid.src = App.fileUrl(st.src);
      vid.currentTime = 0;
      busy('');
      st.thumbs = [];
      $('#thumbs').innerHTML = '';
      S.thumbs(path, info.duration, 14, 72).then(list => { st.thumbs = list; $('#thumbs').innerHTML = ''; list.forEach(u => { const i = document.createElement('img'); if (u) i.src = u; $('#thumbs').appendChild(i); }); });
      $('#exportBtn').disabled = false;
      syncAll();
    } catch (e) { busy(''); App.toast(t('err_open') + ' ' + (e.message || e), 'err', 8000); }
  }
  function canPlay(url) {
    return new Promise(res => {
      const v = document.createElement('video'); v.muted = true; v.preload = 'auto';
      const done = ok => { clearTimeout(to); v.removeAttribute('src'); v.load(); res(ok); };
      const to = setTimeout(() => done(false), 6000);
      v.onloadeddata = () => done(v.videoWidth > 0);
      v.onerror = () => done(false);
      v.src = url;
    });
  }
  function busy(s) { $('#pBusy').hidden = !s; $('#pBusyTxt').textContent = s || ''; }

  /* ---------------- transport ---------------- */
  const playIcon = () => { $('#tPlay use').setAttribute('href', vid.paused ? '#i-play' : '#i-pause'); };
  $('#tPlay').addEventListener('click', () => toggle());
  function toggle() {
    if (!st.file) return;
    if (vid.paused) { if (vid.currentTime >= st.tout - 0.03 || vid.currentTime < st.tin) vid.currentTime = st.tin; vid.play(); } else vid.pause();
  }
  $('#tPrev').addEventListener('click', () => { vid.pause(); vid.currentTime = Math.max(0, vid.currentTime - 1 / fps()); });
  $('#tNext').addEventListener('click', () => { vid.pause(); vid.currentTime = Math.min(dur(), vid.currentTime + 1 / fps()); });
  vid.addEventListener('play', () => { playIcon(); syncMusic(true); });
  vid.addEventListener('pause', () => { playIcon(); music.pause(); });
  vid.addEventListener('timeupdate', () => {
    if (!vid.paused && vid.currentTime >= st.tout) { vid.pause(); vid.currentTime = st.tout; }
    drawTime();
  });
  vid.addEventListener('seeked', () => { drawTime(); syncMusic(!vid.paused); });
  function drawTime() {
    $('#tTime').textContent = App.fmtTime(vid.currentTime) + ' / ' + App.fmtTime(dur());
    const d = dur() || 1;
    $('#ph').style.left = (vid.currentTime / d * 100) + '%';
  }
  document.addEventListener('keydown', e => {
    if (App.view !== 'edit' || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
    else if (e.code === 'ArrowLeft') { $('#tPrev').click(); }
    else if (e.code === 'ArrowRight') { $('#tNext').click(); }
    else if (e.key === 'i' || e.key === 'I') setIn(vid.currentTime);
    else if (e.key === 'o' || e.key === 'O') setOut(vid.currentTime);
  });

  /* ---------------- timeline ---------------- */
  const tl = $('#tl');
  let drag = null;
  const tAt = e => { const r = tl.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur(); };
  tl.addEventListener('pointerdown', e => {
    if (!st.file) return;
    tl.setPointerCapture(e.pointerId);
    drag = e.target.id === 'hIn' ? 'in' : e.target.id === 'hOut' ? 'out' : 'seek';
    move(e);
  });
  tl.addEventListener('pointermove', e => { if (drag) move(e); });
  tl.addEventListener('pointerup', () => { drag = null; });
  function move(e) {
    const x = tAt(e);
    if (drag === 'in') setIn(x); else if (drag === 'out') setOut(x); else { vid.pause(); vid.currentTime = x; }
  }
  function setIn(x) { st.tin = Math.max(0, Math.min(x, st.tout - 0.1)); vid.currentTime = st.tin; syncTrim(); }
  function setOut(x) { st.tout = Math.min(dur(), Math.max(x, st.tin + 0.1)); vid.currentTime = st.tout; syncTrim(); }
  function syncTrim() {
    const d = dur() || 1, a = st.tin / d * 100, b = st.tout / d * 100;
    $('#hIn').style.left = a + '%'; $('#hOut').style.left = b + '%';
    $('#tsel').style.left = a + '%'; $('#tsel').style.width = (b - a) + '%';
    $('#shL').style.left = '0'; $('#shL').style.width = a + '%';
    $('#shR').style.left = b + '%'; $('#shR').style.right = '0';
    $('#tIn').value = st.tin.toFixed(2); $("#tOut").value = st.tout.toFixed(2);
    $('#tLen').textContent = App.fmtTime((st.tout - st.tin) / st.speed);
    summarySoon();
  }
  $('#tIn').addEventListener('change', e => setIn(+e.target.value));
  $('#tOut').addEventListener('change', e => setOut(+e.target.value));
  $('#setIn').addEventListener('click', () => setIn(vid.currentTime));
  $('#setOut').addEventListener('click', () => setOut(vid.currentTime));

  /* ---------------- inspector ---------------- */
  $$('.tabs button').forEach(b => b.addEventListener('click', () => {
    $$('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    ['edit', 'ai', 'export'].forEach(k => { $('#p-' + k).hidden = k !== b.dataset.t; });
  }));
  function seg(id, cb) {
    const g = $(id);
    g.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; [...g.children].forEach(x => x.classList.toggle('on', x === b)); cb(b.dataset.v); });
  }
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
    $('#musicName').textContent = st.audio.file ? st.audio.file.split(/[\\/]/).pop() : t('a_pick');
    $('#alane').hidden = !(st.audio.file && (m === 'replace' || m === 'mix'));
    $('#alaneTxt').textContent = st.audio.file ? st.audio.file.split(/[\\/]/).pop() : '';
    syncMusic(!vid.paused); summarySoon();
  }
  function syncMusic(play) {
    const on = st.audio.file && (st.audio.mode === 'replace' || st.audio.mode === 'mix');
    if (!on) { music.pause(); return; }
    music.currentTime = st.audio.musicStart + Math.max(0, vid.currentTime - st.tin) / st.speed;
    if (play) music.play().catch(() => {}); else music.pause();
  }
  function previewLook() {
    const a = st.adjust;
    vid.style.filter = `brightness(${1 + a.brightness / 100 * 0.35}) contrast(${1 + a.contrast / 100 * 0.6}) saturate(${1 + a.saturation / 100})`;
    // crop preview: clip the frame to the chosen shape
    const info = st.info; if (!info) return;
    const w = info.rotation % 180 ? info.height : info.width, h = info.rotation % 180 ? info.width : info.height;
    if (st.crop === 'none') { vid.style.clipPath = ''; return; }
    const [x, y] = st.crop.split(':').map(Number), want = x / y, have = w / h;
    if (have > want) { const k = (1 - want / have) / 2 * 100; vid.style.clipPath = `inset(0 ${k}% 0 ${k}%)`; }
    else { const k = (1 - have / want) / 2 * 100; vid.style.clipPath = `inset(${k}% 0 ${k}% 0)`; }
  }

  $('#upOn').addEventListener('change', e => { st.up.on = e.target.checked; aiHint(); summarySoon(); });
  $('#fgOn').addEventListener('change', e => { st.fg.on = e.target.checked; aiHint(); summarySoon(); });
  seg('#upModel', v => { st.up.model = v; summarySoon(); });
  seg('#upQ', v => { st.up.quality = v; summarySoon(); });
  seg('#fgModel', v => { st.fg.model = v; summarySoon(); });
  function aiHint() {
    const h = $('#aiHint');
    if (!st.up.on && !st.fg.on) { h.textContent = t('ai_off_hint'); return; }
    h.textContent = '';
    // suggest sensible targets the first time AI is enabled
    if (st.up.on && st.out.res === 'source' && st.info) { const s = Math.min(st.info.width, st.info.height); st.out.res = s < 1000 ? '1080' : s < 1400 ? '2160' : '2160'; setSeg('#resSeg', st.out.res); }
    if (st.fg.on && st.out.fps === 'source') { st.out.fps = fps() > 45 ? '120' : '60'; setSeg('#fpsSeg', st.out.fps); }
  }
  seg('#resSeg', v => { st.out.res = v; summarySoon(); });
  seg('#fpsSeg', v => { st.out.fps = v; summarySoon(); });
  $('#codec').addEventListener('change', e => { st.out.codec = e.target.value; if (e.target.value === 'h264') { $('#tenBit').checked = false; st.out.tenBit = false; } codecHint(); summarySoon(); });
  /* HEVC/AV1 files only play in Windows' own players when the matching (free/paid) extension is installed */
  function codecHint() {
    const c = App.caps || {}, h = $('#codecHint');
    const miss = st.out.codec === 'hevc' ? c.hevcExt === false : st.out.codec === 'av1' ? c.av1Ext === false : false;
    h.hidden = !miss; h.textContent = miss ? t('codec_ext_' + st.out.codec) : '';
  }
  document.addEventListener('caps', codecHint);
  $('#quality').addEventListener('change', e => { st.out.quality = e.target.value; summarySoon(); });
  $('#tenBit').addEventListener('change', e => { st.out.tenBit = e.target.checked; if (st.out.tenBit && st.out.codec === 'h264') { st.out.codec = 'hevc'; $('#codec').value = 'hevc'; } codecHint(); summarySoon(); });
  $('#plats').addEventListener('click', e => {
    const b = e.target.closest('.plat'); if (!b) return;
    st.platform = b.dataset.p; $$('#plats .plat').forEach(x => x.classList.toggle('on', x === b));
    platHint(); summarySoon();
  });
  function platHint() { $('#platHint').textContent = t('p_' + st.platform + '_h'); }

  /* ---------------- plan / summary ---------------- */
  function opts(outPath, preview) {
    return {
      input: st.file, outPath, preview: !!preview,
      trim: { start: preview ? vid.currentTime : st.tin, end: st.tout }, speed: preview ? 1 : st.speed, crop: st.crop, adjust: { ...st.adjust },
      audio: { ...st.audio },
      enhance: { upscale: { ...st.up }, framegen: { ...st.fg } },
      output: { ...st.out, fps: st.out.fps === 'source' ? 'source' : +st.out.fps },
      platform: st.platform,
    };
  }
  let sumT = 0;
  function summarySoon() { clearTimeout(sumT); sumT = setTimeout(summary, 120); }
  async function summary() {
    if (!st.file) return;
    $('#fpsHint').hidden = !(st.out.fps !== 'source' && +st.out.fps > fps() * 1.05 && !st.fg.on);
    try {
      const p = await S.plan(opts('x.mp4'), st.info);
      $('#oRes').textContent = `${p.expect.w}×${p.expect.h}` + (p.up ? ` · AI ×${p.up.scale}` : '');
      $('#oFps').textContent = (Math.round(p.expect.fps * 100) / 100) + ' fps' + (p.fg ? ` · RIFE ×${(p.fg.num / p.fg.den).toFixed(p.fg.den === 1 ? 0 : 2)}` : '');
      $('#oDur').textContent = App.fmtTime(p.expect.dur, false) + (p.expect.kfactor > 1 ? ` → ${App.fmtTime(p.expect.finalDur, false)} (TikTok ×${p.expect.kfactor})` : '');
      $('#oEnc').textContent = p.encoder.replace('_', ' ').toUpperCase();
      const ui = $('#upInfo');
      if (p.up) {
        let txt = t('up_info').replace('{in}', `${p.up.inW}×${p.up.inH}`).replace('{out}', `${p.expect.w}×${p.expect.h}`);
        const eta = estimate(p); if (eta) txt += ' ' + t('up_info_eta').replace('{t}', App.fmtDur(eta));
        ui.textContent = txt;
      } else ui.textContent = '';
    } catch (e) { /* plan errors show at export */ }
  }
  /* rough time estimate from this PC's measured speeds (Settings > Diagnostics) */
  function estimate(p) {
    const v = App.bench && App.bench.vs; if (!v) return null;
    const srcFrames = (st.tout - st.tin) * fps();
    let secs = 0;
    if (p.up) {
      const short = Math.min(p.up.inW, p.up.inH), key = short <= 600 ? 540 : short <= 900 ? 720 : 1080;
      const f = v[`esrgan_${p.up.backend}_${key}p_fps`] || Math.max(v[`esrgan_ort_${key}p_fps`] || 0, v[`esrgan_ncnn_${key}p_fps`] || 0);
      if (!f) return null;
      secs += srcFrames / f;
    }
    if (p.fg) {
      const f = v[`rife_4.26_${Math.min(p.expect.w, p.expect.h) > 1300 ? 2160 : 1080}p_fps`];
      if (f) secs += p.expect.frames / f;
    }
    return secs || null;
  }
  function syncAll() {
    syncTrim(); syncAudio(); previewLook(); platHint(); aiHint(); drawTime();
    vid.playbackRate = st.speed;
  }
  document.addEventListener('lang', () => { if (st.file) { syncAudio(); platHint(); aiHint(); summary(); } else platHint(); });
  document.addEventListener('caps', summarySoon);
  document.addEventListener('bench', summarySoon);

  /* ---------------- export ---------------- */
  $('#exportBtn').addEventListener('click', async () => {
    if (!st.file) return;
    const suffix = st.platform !== 'self' ? '_' + st.platform : (st.up.on || st.fg.on ? '_7krh' : '_edit');
    const out = await S.outName(st.file, suffix, 'mp4');
    const btn = $('#exportBtn'); btn.disabled = true;
    try {
      const r = await S.start(opts(out), st.info);
      App.addJob(r.id, { name: out.split(/[\\/]/).pop(), thumb: st.thumbs[Math.floor(st.thumbs.length / 2)] || null, expect: r.expect });
      App.go('queue');
    } catch (e) { App.toast(String(e.message || e), 'err', 9000); }
    btn.disabled = false;
  });

  /* ---------------- AI preview (one frame through the real pipeline) ---------------- */
  const cmpV = App.Compare($('#cmpCv'), $('#cmp'), z => { $('#cmpZoom').textContent = z + '%'; });
  $$('#cmp .zoombar [data-z]').forEach(b => b.addEventListener('click', () => cmpV.zoomTo(+b.dataset.z)));
  $('#aiPrev').addEventListener('click', async () => {
    if (!st.file) return;
    if (!st.up.on && !st.fg.on) { App.toast(t('ai_off_hint')); return; }
    vid.pause(); busy(t('ai_previewing'));
    try {
      const r = await S.preview(opts(null, true), st.info, vid.currentTime);
      const [a, b] = await Promise.all([loadImg(App.fileUrl(r.before) + '?' + Date.now()), loadImg(App.fileUrl(r.after) + '?' + Date.now())]);
      $('#cmp').hidden = false;
      cmpV.set(a, b);
      cmpV.zoomTo(1); // open at 100%: the detail the AI adds is invisible when a 4K frame is shrunk to fit
    } catch (e) { App.toast(t('err_preview') + ': ' + String(e.message || e).split('\n')[0], 'err', 9000); }
    busy('');
  });
  const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  $('#cmpClose').addEventListener('click', () => { $('#cmp').hidden = true; cmpV.clear(); });

  const open = async () => { const f = (await S.open('video'))[0]; if (f) load(f); };
  $('#eOpen').addEventListener('click', open); $('#eOpen2').addEventListener('click', open);
  window.Editor = { load };
})();
