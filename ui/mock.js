/* Development only: a fake engine so the UI can be opened in a plain browser. Inside the app, preload.js provides window.studio. */
if (!window.studio) (() => {
  const L = {}, on = ch => f => { (L[ch] = L[ch] || []).push(f); return () => {}; }, emit = (ch, d) => (L[ch] || []).forEach(f => f(d));
  let set = { lang: new URLSearchParams(location.search).get('lang') || 'ar', gpu: 0, upBackend: 'auto' };
  let jid = 0;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  window.studio = {
    info: async () => ({ version: '0.1.0', runtime: { ok: true }, locale: 'ar-SA', outDir: 'C:\\Users\\you\\Videos\\7krh Studio', cpu: 'AMD Ryzen 7 7800X3D 8-Core Processor', threads: 16, ramGB: 32 }),
    settings: { get: async () => set, set: async p => (set = { ...set, ...p }) },
    caps: async () => ({ gpus: [{ name: 'NVIDIA GeForce RTX 4070 SUPER', vramMB: 12282, driver: '581.57', nvidia: true }], encoders: ['h264_nvenc', 'hevc_nvenc', 'av1_nvenc', 'libx264', 'libx265', 'libsvtav1'] }),
    open: async kind => (kind === 'audio' ? ['C:\\music\\song.mp3'] : kind === 'image' ? ['test.jpg'] : ['sample.mp4']),
    folder: async () => 'D:\\Exports', savePath: async n => n, pathOf: f => f.name,
    probe: async f => (/\.(jpg|png)$/i.test(f) ? { kind: 'image', width: 1600, height: 1200, name: f } : { path: f, name: f.split(/[\\/]/).pop(), kind: 'video', width: 1920, height: 1080, rotation: 0, fps: '30000/1001', duration: 12.5, vcodec: 'h264', pixFmt: 'yuv420p', bitDepth: 8, hasAudio: true, size: 48e6 }),
    thumbs: async (f, d, n) => Array.from({ length: n }, (_, i) => { const c = document.createElement('canvas'); c.width = 128; c.height = 72; const x = c.getContext('2d'); const g = x.createLinearGradient(0, 0, 128, 72); g.addColorStop(0, `hsl(${300 + i * 6},60%,${25 + i}%)`); g.addColorStop(1, `hsl(${20 + i * 4},70%,45%)`); x.fillStyle = g; x.fillRect(0, 0, 128, 72); return c.toDataURL(); }),
    frame: async () => 'x.png', proxy: async f => f,
    reveal: async () => true, openPath: async () => true, writeB64: async p => p, outName: async (b, s, e) => 'C:\\Users\\you\\Videos\\7krh Studio\\' + b.replace(/\.[^.]+$/, '') + s + '.' + e, url: async () => true,
    plan: async (o, i) => { const res = { source: 1080, '1080': 1080, '1440': 1440, '2160': 2160 }[o.output.res]; const fps = o.output.fps === 'source' ? 29.97 : o.output.fps / 1.001; const d = (o.trim.end - o.trim.start) / (o.speed || 1); const k = o.platform === 'tiktok' ? (fps >= 110 ? 6 : 2) : 1;
      return { encoder: o.output.codec + '_nvenc', expect: { w: Math.round(res * 16 / 9), h: res, fps, dur: d, kfactor: k, finalDur: d * k }, up: o.enhance.upscale.on && res > 1080 ? { scale: 2 } : null, fg: o.enhance.framegen.on && fps > 31 ? { num: Math.round(fps / 29.97), den: 1 } : null }; },
    start: async (o) => { const id = ++jid; (async () => { emit('job:event', { id, type: 'phase', phase: 'ai' }); for (let f = 0; f <= 1; f += 0.05) { await wait(150); emit('job:event', { id, type: 'progress', frac: f, fps: 61.2, eta: (1 - f) * 40 }); } emit('job:event', { id, type: 'done', out: o.outPath, size: 812e6, secs: 41, expect: { w: 3840, h: 2160, fps: 119.88 } }); })(); return { id, expect: { w: 3840, h: 2160, fps: 119.88 } }; },
    cancel: async () => true, preview: async () => { throw new Error('not available in the browser'); },
    removeBg: async () => { await wait(600); return { mask: 'mask.png', ms: 820, w: 1600, h: 1200 }; },
    upscaleImage: async (s, o, m, sc, req) => { for (let p = 0; p <= 1; p += .25) { await wait(120); emit('img:progress', { reqId: req, p }); } return { w: 6400, h: 4800, ms: 2300, out: o }; },
    warmImage: async () => ({}), diag: async () => ({ file: 'C:\\Users\\you\\Documents\\7krh Studio\\diagnostics.json', report: { caps: await window.studio.caps(), vs: { 'esrgan_ort_540p_to_4k_fps': 38.4, 'esrgan_ort_1080p_x4_fps': 9.6, 'rife_4.26_1080p_x2_fps': 142.1, 'rife_4.6_1080p_x2_fps': 210.5 }, image: { birefnet_ms: 160 } } }),
    diagCached: async () => null,
    onJob: on('job:event'), onProxy: on('proxy:progress'), onImg: on('img:progress'), onDiag: on('diag:progress'),
  };
})();
