'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const rt = require('./runtime');
const media = require('./media');
const gpu = require('./gpu');
const pipeline = require('./pipeline');
const render = require('./render');
const platform = require('./platform');
const engines = require('./engines');
const { Job } = require('./jobs');
const img = require('./imgserver');
const bench = require('./bench');

app.setAppUserModelId('dev.7krh.studio');
if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;
const UD = () => app.getPath('userData');
const SETTINGS = () => path.join(UD(), 'settings.json');
const DEFAULTS = {
  lang: null, outDir: null, gpu: 0, gpuName: null, gpuOnly: false, upBackend: 'auto', quality: 'high', codec: 'h264', tenBit: false,
  platform: 'self', fx: 'auto', tech: 'krypton', firstRun: true, fxPresets: [], exportPresets: [], recent: [], benchAsked: false,
  imgMeta: 'keep', imgQuality: 95,
};
const SUPPORT_URL = { ar: 'https://7krh-hub.pages.dev/ar/support/', en: 'https://7krh-hub.pages.dev/en/support/' };

function readSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS(), 'utf8')) }; } catch (e) { return { ...DEFAULTS }; }
}
function writeSettings(s) {
  fs.mkdirSync(UD(), { recursive: true });
  const tmp = SETTINGS() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(s, null, 1)); fs.renameSync(tmp, SETTINGS());
}
function defaultOutDir() {
  const s = readSettings();
  const d = s.outDir || path.join(app.getPath('videos'), '7krh Studio');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}

/* UI scale follows the window (1440×880 design size); DPI scaling is on top of this, done by Chromium */
let zoom = 1;
function fitZoom() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  const z = Math.round(Math.max(1, Math.min(1.5, Math.min(w / 1440, h / 860))) * 20) / 20;
  if (z === zoom) return;
  zoom = z;
  win.webContents.setZoomFactor(z);
  try { win.setTitleBarOverlay({ height: Math.round(40 * z) }); } catch (e) {}
}

function createWindow() {
  const { screen } = require('electron');
  const wa = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.max(1200, Math.min(wa.width - 60, Math.round(wa.width * 0.86))), height: Math.max(760, Math.min(wa.height - 40, Math.round(wa.height * 0.9))),
    minWidth: 1100, minHeight: 700, show: false, center: true,
    backgroundColor: '#0a090d', title: '7krh Studio',
    icon: path.join(__dirname, '..', 'ui', 'img', 'logo-128.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0a090d', symbolColor: '#e4dce5', height: 40 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  win.once('ready-to-show', () => { zoom = 0; fitZoom(); win.show(); });
  win.on('resize', fitZoom);
  win.webContents.on('did-finish-load', () => { zoom = 0; fitZoom(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
}

app.on('second-instance', (e, argv) => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); const f = argv.find(a => /\.(7krh|mp4|mov|mkv|png|jpe?g|webp)$/i.test(a)); if (f) win.webContents.send('open:file', f); }
});
app.whenReady().then(() => {
  createWindow();
  gpu.caps(UD()).catch(() => {}); // light: lists cards + test-encodes 8 frames per encoder once per driver
  // "7krh Studio.exe --diag": measure this PC (the user asked for it on the command line)
  if (process.argv.includes('--diag')) runDiag().catch(e => {
    try { fs.mkdirSync(path.join(app.getPath('documents'), '7krh Studio'), { recursive: true }); fs.writeFileSync(path.join(app.getPath('documents'), '7krh Studio', 'diagnostics-error.txt'), String(e && e.stack || e)); } catch (_) {}
  });
});
app.on('window-all-closed', () => { img.stop(); queue.length = 0; for (const j of running.values()) j.job.cancel(); app.quit(); });

/* ---------------------------------------------------------------- IPC */
const handle = (ch, fn) => ipcMain.handle(ch, async (e, ...a) => {
  try { return { ok: true, v: await fn(...a) }; } catch (err) { return { ok: false, err: String(err && err.message || err), code: err && err.code }; }
});
const send = (ch, d) => { if (win && !win.isDestroyed()) win.webContents.send(ch, d); };

handle('app:info', async () => ({
  version: app.getVersion(), runtime: rt.status(), platform: process.platform, arch: process.arch,
  locale: app.getLocale(), outDir: defaultOutDir(), cpu: os.cpus()[0] && os.cpus()[0].model, threads: os.cpus().length, ramGB: Math.round(os.totalmem() / 1073741824),
  tmp: media.tmpDir(''), supportUrl: SUPPORT_URL,
}));
handle('settings:get', async () => readSettings());
handle('settings:set', async patch => { const s = { ...readSettings(), ...patch }; writeSettings(s); return s; });
handle('caps', async force => gpu.caps(UD(), !!force));
handle('titlebar', async ({ color, symbol }) => { try { win.setTitleBarOverlay({ color, symbolColor: symbol }); } catch (e) {} return true; });

/* files the user picked or dropped may be read; files the user chose to save to may be written */
const userFiles = new Set();
const allow = ps => { (ps || []).forEach(p => p && userFiles.add(path.resolve(p))); return ps; };
const FILTERS = {
  audio: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma'] }],
  image: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'avif', 'heic', 'gif'] }],
  video: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'ts', 'mts', 'm2ts', 'wmv', 'flv', 'gif', '3gp'] }],
  subs: [{ name: 'Subtitles', extensions: ['srt', 'ass', 'ssa'] }],
  project: [{ name: '7krh project', extensions: ['7krh'] }],
  any: [{ name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'ts', 'mts', 'wmv', 'gif', '3gp', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'avif', 'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', '7krh', 'srt', 'ass'] }],
};
handle('dlg:open', async ({ kind, multi }) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', ...(multi ? ['multiSelections'] : [])], filters: FILTERS[kind] || FILTERS.any });
  return r.canceled ? [] : allow(r.filePaths);
});
handle('dlg:folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: defaultOutDir() });
  return r.canceled ? null : r.filePaths[0];
});
handle('dlg:save', async ({ name, ext, kind }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(defaultOutDir(), name), filters: FILTERS[kind] || [{ name: ext.toUpperCase(), extensions: [ext] }] });
  return r.canceled ? null : allow([r.filePath])[0];
});
handle('files:dropped', async ps => allow(ps));

handle('media:probe', async file => media.probe(file));
handle('media:thumbs', async (file, dur, n, h, start) => media.thumbs(file, dur, n, h, start));
handle('media:frame', async (file, t) => media.frame(file, t, path.join(media.tmpDir('frames'), `f${Date.now()}.png`)));
handle('media:peaks', async (file, start, dur, n) => media.peaks(file, start, dur, n));
handle('media:proxy', async (file, info) => {
  const key = require('crypto').createHash('sha1').update(file + (fs.statSync(file).mtimeMs)).digest('hex').slice(0, 16);
  const out = path.join(media.tmpDir('proxy'), `${key}.mp4`);
  if (fs.existsSync(out)) return out; // cached between sessions
  return media.proxy(file, info, out, p => send('proxy:progress', { file, p }));
});

handle('fs:reveal', async p => { shell.showItemInFolder(p); return true; });
handle('fs:open', async p => shell.openPath(p));
/* writes only into the app's own temporary folder (text images, previews) */
handle('fs:writeTmp', async (name, b64) => {
  const p = path.join(media.tmpDir('layers'), path.basename(name));
  fs.writeFileSync(p, Buffer.from(b64, 'base64')); return p;
});
handle('fs:readText', async p => {
  const r = path.resolve(p);
  if (!userFiles.has(r) && !/\.(srt|ass|ssa|7krh)$/i.test(r)) throw new Error('not allowed');
  const b = fs.readFileSync(r);
  return b[0] === 0xff && b[1] === 0xfe ? b.toString('utf16le') : b.toString('utf8').replace(/^﻿/, '');
});
handle('fs:writeText', async (p, text) => {
  const r = path.resolve(p);
  if (!userFiles.has(r)) throw new Error('not allowed');
  const tmp = r + '.tmp'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, r); return r;
});
handle('fs:exists', async p => fs.existsSync(p));
handle('fs:outName', async (base, suffix, ext) => {
  const dir = defaultOutDir();
  const stem = path.basename(base).replace(/\.[^.]+$/, '');
  let p = path.join(dir, `${stem}${suffix}.${ext}`), i = 2;
  while (fs.existsSync(p)) p = path.join(dir, `${stem}${suffix} (${i++}).${ext}`);
  return p;
});
handle('shell:url', async u => { if (/^https:\/\//.test(u)) await shell.openExternal(u); return true; });

/* ---------------------------------------------------------------- projects: autosave + recovery */
const AUTOSAVE = () => path.join(UD(), 'autosave.7krh');
handle('project:autosave', async json => { const tmp = AUTOSAVE() + '.tmp'; fs.writeFileSync(tmp, json); fs.renameSync(tmp, AUTOSAVE()); return true; });
handle('project:recover', async () => { try { const s = fs.statSync(AUTOSAVE()); return { json: fs.readFileSync(AUTOSAVE(), 'utf8'), at: s.mtimeMs }; } catch (e) { return null; } });
handle('project:clearAutosave', async () => { try { fs.unlinkSync(AUTOSAVE()); } catch (e) {} return true; });

/* ---------------------------------------------------------------- export jobs: one heavy job at a time */
const queue = [];            // waiting: { id, build, meta }
const running = new Map();   // id -> { job, tmp }
let jid = 0;
const LOGS = () => path.join(app.getPath('documents'), '7krh Studio', 'logs');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

async function context(tmp, backend) {
  const c = await gpu.caps(UD());
  const s = readSettings();
  const dev = gpu.device(c, s);
  const be = backend || (s.upBackend === 'auto' || !s.upBackend ? (bench.bestBackend(UD()) || 'ort') : s.upBackend);
  return { c, s, dev, caps: { encoders: c.encoders, gpu: dev.dml, dev, upBackend: be, paths: rt.paths(), tmp, engines: path.join(UD(), 'engines'), ffmpegMajor: c.ffmpegMajor, filters: c.filters } };
}
function lwiFor(input) {
  let st = null; try { st = fs.statSync(input); } catch (e) {}
  const key = require('crypto').createHash('sha1').update(input + '|' + (st ? st.size + '|' + st.mtimeMs : '')).digest('hex').slice(0, 16);
  return path.join(media.tmpDir('index'), key + '.lwi');
}
function gpuOnlyCheck(s, plan) {
  if (s.gpuOnly && plan.encoder && !/nvenc|amf|qsv/.test(plan.encoder)) {
    const e = new Error(`GPU-only mode: this card has no hardware encoder for this codec (${plan.encoder} would run on the processor). Pick H.264/HEVC or turn GPU-only off.`); e.code = 'gpuOnlyEncode'; throw e;
  }
}
const verifyStep = (file, expect, audio) => ({ kind: 'verify', file, expectDur: expect.finalDur || expect.dur, w: expect.w, h: expect.h, audio, tol: 0.03 });

/* builds a full plan for any job type (also used for the live summary) */
async function makePlan(req, tmp) {
  const { s, caps, dev } = await context(tmp, req._backend);
  const plat = { platform: req.platform || 'self', fx: req.fx || 'auto', tech: req.tech || 'krypton' };
  if (req.type === 'copy') {
    const info = req.info;
    const r = platform.copyPlan(req.input, req.outPath, { fpsNum: info.fpsNum || pipeline.parseRate(info.fps), duration: info.duration, w: info.rotation % 180 ? info.height : info.width, h: info.rotation % 180 ? info.width : info.height, hasAudio: info.hasAudio }, plat, caps.paths.ffmpeg);
    return { steps: r.steps, encoder: 'copy', expect: { frames: 1, fps: info.fpsNum, w: info.width, h: info.height, dur: info.duration, kfactor: r.k, finalDur: r.finalDur }, method: r.method };
  }
  if (req.type === 'enhance') {
    const plan = pipeline.buildPlan({ ...req.opts, outPath: path.join(tmp, 'encoded.mp4') }, req.info, { ...caps, lwi: lwiFor(req.opts.input) });
    gpuOnlyCheck(s, plan);
    const post = platform.postEncode(path.join(tmp, 'encoded.mp4'), req.opts.outPath, plan.expect.fps, plan.expect.dur, plat);
    plan.steps.push(...post.steps);
    plan.expect = { ...plan.expect, kfactor: post.k, finalDur: post.finalDur };
    plan.steps.push(verifyStep(req.opts.outPath, plan.expect, req.info.hasAudio && (req.opts.audio || {}).mode !== 'mute'));
    plan.method = post.method; plan.device = dev;
    return plan;
  }
  if (req.type === 'timeline') {
    const enh = req.enhance && ((req.enhance.upscale && req.enhance.upscale.on) || (req.enhance.framegen && req.enhance.framegen.on));
    const ext = (req.output && req.output.container) || 'mp4';
    const audioOnly = !!req.audioOnly;
    const rendered = path.join(tmp, enh ? 'timeline.mkv' : `encoded.${audioOnly ? req.audioFormat || 'wav' : ext}`);
    const plan = render.buildTimelinePlan(req.project, { outPath: rendered, output: req.output || {}, intermediate: enh, audioOnly, audioFormat: req.audioFormat }, caps);
    if (!enh && !audioOnly) gpuOnlyCheck(s, plan);
    if (enh) {
      const info = { width: plan.expect.w, height: plan.expect.h, rotation: 0, fps: `${pipeline.fraction(plan.expect.fps).join('/')}`, duration: plan.expect.dur, hasAudio: plan.expect.audio, colorSpace: 'bt709' };
      const o = req.output || {};
      const p2 = pipeline.buildPlan({ input: rendered, outPath: path.join(tmp, 'encoded.mp4'), enhance: req.enhance, output: { res: o.aiRes || 'source', fps: o.aiFps || 'source', codec: o.codec, quality: o.quality, tenBit: o.tenBit } }, info, { ...caps, lwi: path.join(tmp, 'timeline.lwi') });
      gpuOnlyCheck(s, p2);
      p2.steps.forEach(st => { st.frames = p2.expect.frames; });
      plan.steps.forEach(st => { st.frames = plan.expect.frames; st.phase = 'render'; });
      plan.steps.push(...p2.steps);
      plan.encoder = p2.encoder; plan.up = p2.up; plan.fg = p2.fg; plan.expect = { ...p2.expect, audio: plan.expect.audio };
    }
    const out = req.outPath;
    if (audioOnly) { plan.steps.push({ kind: 'move', from: rendered, to: out }, { kind: 'verify', file: out, expectDur: plan.expect.dur, audio: true, tol: 0.03 }); return plan; }
    const post = platform.postEncode(enh ? path.join(tmp, 'encoded.mp4') : rendered, out, plan.expect.fps, plan.expect.dur, plat);
    plan.steps.push(...post.steps);
    plan.expect = { ...plan.expect, kfactor: post.k, finalDur: post.finalDur };
    plan.steps.push(verifyStep(out, plan.expect, plan.expect.audio));
    plan.method = post.method; plan.device = dev;
    plan.estimateBytes = render.estimateBytes({ output: req.output }, plan.expect.dur, plan.expect.audio);
    return plan;
  }
  throw new Error('unknown job type');
}

handle('job:plan', async req => {
  const p = await makePlan(req, media.tmpDir('plan'));
  return { expect: p.expect, encoder: p.encoder, up: p.up || null, fg: p.fg || null, method: p.method, layers: p.layers, estimateBytes: p.estimateBytes || null, device: p.device && p.device.name };
});
handle('job:start', async (req, meta) => {
  const id = ++jid;
  queue.push({ id, req, meta });
  send('job:event', { id, type: 'queued', pos: queue.length + running.size });
  pump();
  return { id };
});
function pump() {
  if (running.size || !queue.length) return;
  const { id, req } = queue.shift();
  const tmp = media.tmpDir('job' + id + '-' + Date.now());
  const t0 = Date.now();
  let plan = null;
  (async () => {
    plan = await makePlan(req, tmp);
    const j = new Job(id, plan, ev => send('job:event', ev), path.join(LOGS(), `export-${stamp()}-${id}.txt`), { platform, verify: media.verifyOutput });
    running.set(id, { job: j, tmp });
    send('job:event', { id, type: 'start', expect: plan.expect, encoder: plan.encoder, method: plan.method, device: plan.device && plan.device.name, up: plan.up, fg: plan.fg });
    const r = await j.run(tmp);
    const out = req.type === 'enhance' ? req.opts.outPath : req.outPath;
    let size = 0; try { size = fs.statSync(out).size; } catch (e) {}
    send('job:event', { id, type: 'done', out, size, secs: (Date.now() - t0) / 1000, expect: plan.expect, encoder: plan.encoder, verify: r.verify, method: plan.method });
  })().catch(err => {
    const j = running.get(id);
    // the AI engine itself failed (e.g. TensorRT on this PC): run the job again once on DirectML, and say so
    const be = plan && plan.up && plan.up.backend;
    if (be && be !== 'ort' && !req._backend && !(j && j.job.cancelled) && /vsmlrt|tensorrt|trt|ncnn|onnx|Backend|inference|Script evaluation failed/i.test(String(err.message))) {
      queue.unshift({ id, req: { ...req, _backend: 'ort' } });
      send('job:event', { id, type: 'fallback', from: be, to: 'ort', reason: String(err.message).split('\n').filter(l => /Error|error:/.test(l)).slice(-1)[0] || '' });
      return;
    }
    send('job:event', { id, type: 'error', err: String(err.message || err), code: err.code, cancelled: !!(j && j.job.cancelled), log: j ? j.job.log.slice(-40).join('\n') : '' });
    // a cancelled or failed job never leaves a half-written file behind
    const out = req.type === 'enhance' ? req.opts.outPath : req.outPath;
    try { if (out && fs.existsSync(out) && fs.statSync(out).mtimeMs >= t0) fs.unlinkSync(out); } catch (e) {}
  }).finally(() => { running.delete(id); fs.rm(tmp, { recursive: true, force: true }, () => {}); pump(); });
}
handle('job:cancel', async id => {
  const qi = queue.findIndex(q => q.id === id);
  if (qi >= 0) { queue.splice(qi, 1); send('job:event', { id, type: 'error', cancelled: true, err: 'cancelled' }); return true; }
  const r = running.get(id); if (r) r.job.cancel(); return true;
});
handle('job:preview', async (opts, info, t) => {
  try { return await previewOnce(opts, info, t, null); }
  catch (e) { if (/vsmlrt|tensorrt|trt|ncnn|onnx|Script evaluation failed/i.test(String(e.message))) return previewOnce(opts, info, t, 'ort'); throw e; }
});
async function previewOnce(opts, info, t, backend) {
  const { caps } = await context(media.tmpDir('prev' + Date.now()), backend);
  const tmp = caps.tmp;
  const after = path.join(tmp, 'after.png');
  const plan = pipeline.buildPlan({ ...opts, outPath: after, preview: true, trim: { start: t, end: t + 1 } }, info, { ...caps, lwi: lwiFor(opts.input) });
  const j = new Job(0, plan, () => {}, path.join(LOGS(), `preview-${stamp()}.txt`));
  const before = media.frame(opts.input, t, path.join(tmp, 'before.png'));
  const t0 = Date.now();
  await j.run(tmp);
  await before;
  return { before: path.join(tmp, 'before.png'), after, secs: (Date.now() - t0) / 1000, plan: { up: plan.up, fg: plan.fg, w: plan.expect.w, h: plan.expect.h } };
}

/* ---------------------------------------------------------------- images */
handle('img:analyze', async src => { const s = readSettings(); const d = gpu.device(await gpu.caps(UD()), s); return img.call('analyze', { src, device: d.dml }, null, { gpuOnly: s.gpuOnly }); });
handle('img:upscale', async (req, reqId) => {
  const s = readSettings(); const d = gpu.device(await gpu.caps(UD()), s);
  const r = await img.call('upscale', { ...req, device: d.dml }, p => send('img:progress', { reqId, p }), { gpuOnly: s.gpuOnly });
  return { ...r, out: req.out, gpu: d.name };
});
handle('img:cancel', async () => { img.cancelAll(); return true; });

/* ---------------------------------------------------------------- engines, diagnostics, benchmark */
handle('engines:status', async () => engines.status(bench.cached(UD()), await gpu.caps(UD()).catch(() => null)));
handle('engines:verify', async () => engines.verify(p => send('engines:progress', p)));
handle('engines:folder', async () => { shell.openPath(rt.paths().root); return true; });
handle('diag:cached', async () => bench.cached(UD()));
let diagRun = null;
function runDiag(outFile) {
  if (diagRun) return diagRun;
  diagRun = (async () => {
    const report = await bench.run(UD(), readSettings(), p => send('diag:progress', p));
    const file = outFile || path.join(app.getPath('documents'), '7krh Studio', 'diagnostics.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(report, null, 1));
    send('diag:progress', { step: 'done', report, file });
    return { file, report };
  })().finally(() => { diagRun = null; });
  return diagRun;
}
handle('diag:run', async outFile => runDiag(outFile));
