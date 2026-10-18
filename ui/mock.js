/* Development only: a stand-in engine so the interface can be opened in a plain browser (and screenshot-tested).
   Inside the app, preload.js provides window.studio and this file does nothing. */
if (!window.studio) (() => {
  const L = {}, on = ch => f => { (L[ch] = L[ch] || []).push(f); return () => {}; }, emit = (ch, d) => (L[ch] || []).forEach(f => f(d));
  const q = new URLSearchParams(location.search);
  let set = { lang: q.get('lang') || 'ar', gpu: 0, gpuName: 'NVIDIA GeForce RTX 4070 SUPER', upBackend: 'auto', recent: [], imgMeta: 'keep' };
  let jid = 0;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const MEDIA = window.__MOCK_MEDIA || {};
  const thumb = (i, w = 128, h = 72) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, `hsl(${320 + i * 7},65%,${22 + i}%)`); g.addColorStop(1, `hsl(${20 + i * 5},75%,45%)`); x.fillStyle = g; x.fillRect(0, 0, w, h); return c.toDataURL('image/jpeg', 0.7); };
  window.studio = {
    info: async () => ({ version: '0.3.0', runtime: { ok: true }, locale: 'ar-SA', outDir: 'C:\\Users\\you\\Videos\\7krh Studio', cpu: 'AMD Ryzen 7 7800X3D 8-Core Processor', threads: 16, ramGB: 32, supportUrl: { ar: 'https://7krh-hub.pages.dev/ar/support/', en: 'https://7krh-hub.pages.dev/en/support/' } }),
    settings: { get: async () => set, set: async p => (set = { ...set, ...p }) },
    caps: async () => ({ gpus: [{ name: 'NVIDIA GeForce RTX 4070 SUPER', vramMB: 12282, driver: '581.57', nvidia: true, dml: 0, vk: 0, cuda: 0 }], encoders: ['h264_nvenc', 'hevc_nvenc', 'av1_nvenc', 'libx264', 'libx265', 'libsvtav1', 'libvpx-vp9'], filters: ['arnndn'], hevcExt: true, av1Ext: true }),
    titlebar: async () => true,
    open: async kind => (kind === 'audio' ? ['C:\\music\\song.mp3'] : kind === 'image' ? ['C:\\img\\photo.jpg'] : kind === 'project' ? [] : Object.keys(MEDIA).slice(0, 1)),
    folder: async () => 'D:\\Exports', savePath: async n => 'C:\\Users\\you\\Videos\\' + n, pathOf: f => f.path || f.name, dropped: async p => p,
    probe: async f => MEDIA[f] || (/\.(jpg|png|webp)$/i.test(f) ? { path: f, name: f.split(/[\\/]/).pop(), kind: 'image', width: 1600, height: 1200, rotation: 0, size: 2e6 } : /\.(mp3|wav)$/i.test(f) ? { path: f, name: f.split(/[\\/]/).pop(), kind: 'audio', width: 0, height: 0, duration: 95, hasAudio: true, acodec: 'mp3', sampleRate: 44100, size: 3e6 } : { path: f, name: f.split(/[\\/]/).pop(), kind: 'video', width: 1920, height: 1080, rotation: 0, fps: '30000/1001', fpsNum: 29.97, duration: 12.5, vcodec: 'h264', pixFmt: 'yuv420p', bitDepth: 8, hasAudio: true, acodec: 'aac', size: 48e6 }),
    thumbs: async (f, d, n) => Array.from({ length: n }, (_, i) => thumb(i)),
    peaks: async (f, s, d, n) => Array.from({ length: n }, (_, i) => Math.abs(Math.sin(i / 7)) * 0.7 + Math.random() * 0.2),
    frame: async () => 'x.png', proxy: async f => f,
    reveal: async () => true, openPath: async () => true, writeTmp: async n => n, readText: async () => '1\n00:00:01,000 --> 00:00:03,000\nمرحبا بكم\n\n2\n00:00:03,500 --> 00:00:06,000\nهذه ترجمة تجريبية\n', writeText: async p => p, exists: async () => true,
    outName: async (b, s, e) => 'C:\\Users\\you\\Videos\\7krh Studio\\' + String(b).split(/[\\/]/).pop().replace(/\.[^.]+$/, '') + s + '.' + e, url: async () => true,
    project: { autosave: async () => true, recover: async () => null, clear: async () => true },
    plan: async r => { const p = r.project; const w = p ? p.canvas.w : 1920, h = p ? p.canvas.h : 1080, fps = p ? p.canvas.fps : 29.97, dur = p ? TL.duration(p) : 12.5; const k = r.platform === 'tiktok' ? (fps >= 110 ? 6 : 2) : 1; return { encoder: (r.output && r.output.codec || 'h264') + '_nvenc', method: r.type === 'copy' ? 'krypton' : 'patch', expect: { w, h, fps, dur, kfactor: k, finalDur: dur * k, frames: Math.round(dur * fps) }, up: null, fg: null, estimateBytes: r.output && r.output.rate && r.output.rate.mode === 'bitrate' ? r.output.rate.mbps * 1e6 / 8 * dur : null, device: 'NVIDIA GeForce RTX 4070 SUPER' }; },
    start: async () => { const id = ++jid; (async () => { await wait(200); emit('job:event', { id, type: 'start', expect: { w: 3840, h: 2160, fps: 59.94 }, encoder: 'hevc_nvenc', device: 'RTX 4070 SUPER' }); emit('job:event', { id, type: 'phase', phase: 'ai', step: 1, steps: 1 }); for (let f = 0; f <= 1; f += 0.05) { await wait(150); emit('job:event', { id, type: 'progress', frac: f, fps: 61.2, ms: 16.3, eta: (1 - f) * 40 }); } emit('job:event', { id, type: 'phase', phase: 'verify' }); await wait(200); emit('job:event', { id, type: 'done', out: 'C:\\out.mp4', size: 812e6, secs: 41, expect: { w: 3840, h: 2160, fps: 59.94 }, encoder: 'hevc_nvenc', verify: { ok: true, problems: [], dur: 12.5, audio: true } }); })(); return { id }; },
    cancel: async () => true, preview: async () => { throw new Error('not available in the browser'); },
    img: { analyze: async () => ({ suggest: 'photo', alpha: false, icc: true, exif: true, format: 'JPEG' }), upscale: async (r, req) => { for (let p = 0; p <= 1; p += 0.25) { await wait(120); emit('img:progress', { reqId: req, p }); } return { w: 6400, h: 4800, ms: 2300, out: r.out, bytes: 9e6, device: 'gpu', provider: 'DmlExecutionProvider', gpu: 'RTX 4070 SUPER' }; }, cancel: async () => true },
    engines: {
      status: async () => [['ffmpeg', 'FFmpeg', 'decode_encode', 'GPL-3.0', 'gpu-encode', 'ready', 180e6], ['vsort', 'vs-mlrt · ONNX Runtime DirectML', 'video_ai', 'GPL-3.0', 'gpu-ai', 'ready', 210e6, '720p → ×4: 38.4 fps'], ['vstrt', 'vs-mlrt · TensorRT-RTX (NVIDIA)', 'video_ai', 'GPL-3.0 / NVIDIA', 'gpu-ai', 'ready', 640e6, '720p → ×4: 61.0 fps'], ['rife', 'RIFE ncnn Vulkan', 'frames_ai', 'MIT', 'gpu-ai', 'ready', 120e6, 'RIFE 4.26 1080p ×2: 142 fps'], ['rnnoise', 'RNNoise', 'audio_ai', 'BSD-3', 'cpu', 'missing', -1]].map(([id, name, use, license, device, state, bytes, detail]) => ({ id, name, use, license, device, state, bytes, detail })),
      verify: async () => ({ ok: true, checked: 214, bad: [], hasHashes: true }), folder: async () => true,
    },
    diag: async () => ({ file: 'C:\\Users\\you\\Documents\\7krh Studio\\diagnostics.json', report: { time: new Date().toISOString(), benchVersion: 3, caps: await window.studio.caps(), best: 'trt', vs: { esrgan_trt_720p_fps: 61.0, esrgan_ort_720p_fps: 38.4, 'rife_4.26_1080p_fps': 142.1, 'rife_4.26_2160p_fps': 41.3 }, e2e: { e2e_1080_to_4k_fps: 47.2 }, image: { real_x4_ms: 31, real_x4_device: 'gpu (dml)' } } }),
    diagCached: async () => null,
    onJob: on('job:event'), onProxy: on('proxy:progress'), onImg: on('img:progress'), onDiag: on('diag:progress'), onEngines: on('engines:progress'), onOpenFile: on('open:file'),
  };
})();
