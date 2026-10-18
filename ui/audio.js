/* 7krh Studio — audio tools: noise removal (light DSP or RNNoise AI), volume, fades, loudness normalisation
   to -14 LUFS, format conversion; also takes the sound out of videos. Runs through the same renderer as the
   montage (an audio-only project), so it behaves exactly like the audio in a montage export. */
(() => {
  'use strict';
  const { $, S, t, h } = App;
  const items = [];
  const o = { denoise: 'off', volume: 1, fmt: 'mp3', fadeIn: 0, fadeOut: 0, norm: false };
  $('#audDen').addEventListener('change', e => { o.denoise = e.target.value; hint(); });
  $('#audVol').addEventListener('input', e => { o.volume = e.target.value / 100; $('#v-avol').textContent = e.target.value + '%'; });
  $('#audFmt').addEventListener('change', e => { o.fmt = e.target.value; });
  $('#audFi').addEventListener('change', e => { o.fadeIn = Math.max(0, +e.target.value || 0); });
  $('#audFo').addEventListener('change', e => { o.fadeOut = Math.max(0, +e.target.value || 0); });
  $('#audNorm').addEventListener('change', e => { o.norm = e.target.checked; });
  function hint() { $('#audHint').textContent = o.denoise === 'ai' ? t('dn_ai_h') : o.denoise === 'light' ? t('dn_light_h') : ''; }

  async function add(paths) {
    for (const p of paths) {
      if (items.some(x => x.src === p)) continue;
      let info; try { info = await S.probe(p); } catch (e) { App.toast(App.base(p) + ': ' + App.errText(e), 'err'); continue; }
      if (!info.hasAudio && info.kind !== 'audio') { App.toast(t('aud_noaudio', { n: App.base(p) }), 'err'); continue; }
      const it = { src: p, info, state: 'new' };
      items.push(it);
      S.peaks(p, 0, info.duration, 500).then(pk => { it.peaks = pk; render(); }).catch(() => {});
    }
    render();
  }
  function render() {
    const L = $('#audList'); L.innerHTML = '';
    if (!items.length) { L.appendChild(h('div', { class: 'empty', id: 'audEmpty' }, App.icon('i-wave'), h('strong', { text: t('aud_drop') }))); $('#audOpts').hidden = true; return; }
    $('#audOpts').hidden = false;
    items.forEach((it, i) => {
      const cv = h('canvas', { width: 600, height: 40 });
      if (it.peaks) { const x = cv.getContext('2d'); x.fillStyle = 'rgba(255,106,169,.8)'; it.peaks.forEach((v, j) => { const hh = Math.max(1, v * 36); x.fillRect(j * 600 / it.peaks.length, 38 - hh, Math.max(1, 600 / it.peaks.length - 0.5), hh); }); }
      L.appendChild(h('div', { class: 'aitem' },
        h('button', { class: 'icbtn', title: t('play'), onclick: () => { const a = new Audio(App.fileUrl(it.src)); a.play().catch(() => {}); setTimeout(() => a.pause(), 15000); } }, App.icon('i-play')),
        h('div', {}, h('b', { text: it.info.name }), h('small', { text: App.facts(it.info).join(' · ') })), cv,
        h('div', { style: 'display:flex;gap:6px;align-items:center' }, h('span', { class: 'st', text: it.state === 'done' ? '✓ ' + t('q_done') : it.state === 'run' ? t('q_waiting') : '' }),
          h('button', { class: 'icbtn sm', title: t('remove'), onclick: () => { items.splice(i, 1); render(); } }, App.icon('i-x')))));
    });
  }
  $('#audAdd').addEventListener('click', async () => add(await S.open('audio', true)));
  $('#audGo').addEventListener('click', async () => {
    for (const it of items) {
      const d = it.info.duration;
      const p = TL.newProject('landscape', it.info.name);
      p.media[it.src] = { kind: it.info.kind === 'audio' ? 'audio' : 'video', w: it.info.width, h: it.info.height, duration: d, hasAudio: true };
      p.clips.push(TL.normClip({ id: 'a', kind: 'audio', track: 'A1', src: it.src, in: 0, out: d, start: 0, volume: o.volume, fadeIn: Math.min(o.fadeIn, d / 2), fadeOut: Math.min(o.fadeOut, d / 2), denoise: o.denoise }));
      const out = await S.outName(it.src, o.denoise !== 'off' ? '_clean' : '_audio', o.fmt);
      try { await App.startJob({ type: 'timeline', audioOnly: true, audioFormat: o.fmt, project: p, outPath: out, output: { loudnorm: o.norm } }, { name: App.base(out) }); it.state = 'run'; }
      catch (e) { App.toast(App.errText(e), 'err', 8000); }
    }
    render(); App.go('queue');
  });
  document.addEventListener('jobev', e => { if (e.detail.type === 'done') { const it = items.find(x => e.detail.out && App.base(e.detail.out).startsWith(App.base(x.src).replace(/\.[^.]+$/, ''))); if (it) { it.state = 'done'; render(); } } });
  document.addEventListener('lang', () => { render(); hint(); });
  window.AudioTools = { add: async p => { App.go('audio'); await add(p); } };
})();
