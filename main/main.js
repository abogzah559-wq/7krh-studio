'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const rt = require('./runtime');
const media = require('./media');
const gpu = require('./gpu');
const pipeline = require('./pipeline');
const { Job } = require('./jobs');
const img = require('./imgserver');
const bench = require('./bench');

app.setAppUserModelId('dev.7krh.studio');
if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;
const UD = () => app.getPath('userData');
const SETTINGS = () => path.join(UD(), 'settings.json');
const DEFAULTS = { lang: null, outDir: null, gpu: 0, upBackend: 'auto', quality: 'high', codec: 'hevc', tenBit: false, platform: 'self', firstRun: true };

function readSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS(), 'utf8')) }; } catch (e) { return { ...DEFAULTS }; }
}
function writeSettings(s) {
  fs.mkdirSync(UD(), { recursive: true });
  fs.writeFileSync(SETTINGS(), JSON.stringify(s, null, 1));
}
function defaultOutDir() {
  const s = readSettings();
  const d = s.outDir || path.join(app.getPath('videos'), '7krh Studio');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1120, minHeight: 720, show: false,
    backgroundColor: '#09070c', title: '7krh Studio',
    icon: path.join(__dirname, '..', 'ui', 'img', 'logo-128.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0c0a10', symbolColor: '#e8e2f0', height: 42 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  win.once('ready-to-show', () => { win.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  createWindow();
  // warm up hardware detection in the background
  gpu.caps(UD()).catch(() => {});
  // "7krh Studio.exe --diag" measures the PC and writes Documents\7krh Studio\diagnostics.json
  if (process.argv.includes('--diag')) {
    bench.run(UD(), readSettings()).then(report => {
      const file = path.join(app.getPath('documents'), '7krh Studio', 'diagnostics.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(report, null, 1));
    }).catch(e => {
      try { fs.writeFileSync(path.join(app.getPath('documents'), '7krh Studio', 'diagnostics-error.txt'), String(e && e.stack || e)); } catch (_) {}
    });
  }
});
app.on('window-all-closed', () => { img.stop(); for (const j of jobs.values()) j.cancel(); app.quit(); });

/* ---------------------------------------------------------------- IPC */
const handle = (ch, fn) => ipcMain.handle(ch, async (e, ...a) => {
  try { return { ok: true, v: await fn(...a) }; } catch (err) { return { ok: false, err: String(err && err.message || err) }; }
});

handle('app:info', async () => ({
  version: app.getVersion(), runtime: rt.status(), platform: process.platform, arch: process.arch,
  locale: app.getLocale(), outDir: defaultOutDir(), cpu: os.cpus()[0] && os.cpus()[0].model, threads: os.cpus().length, ramGB: Math.round(os.totalmem() / 1073741824),
}));
handle('settings:get', async () => readSettings());
handle('settings:set', async patch => { const s = { ...readSettings(), ...patch }; writeSettings(s); return s; });
handle('caps', async force => gpu.caps(UD(), !!force));

handle('dlg:open', async ({ kind, multi }) => {
  const filters = kind === 'audio' ? [{ name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'] }]
    : kind === 'image' ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'avif', 'heic'] }]
    : kind === 'video' ? [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'ts', 'mts', 'm2ts', 'wmv', 'flv', 'gif'] }]
    : [{ name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'ts', 'mts', 'wmv', 'gif', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'avif'] }];
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', ...(multi ? ['multiSelections'] : [])], filters });
  return r.canceled ? [] : r.filePaths;
});
handle('dlg:folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: defaultOutDir() });
  return r.canceled ? null : r.filePaths[0];
});
handle('dlg:save', async ({ name, ext }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(defaultOutDir(), name), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  return r.canceled ? null : r.filePath;
});

handle('media:probe', async file => media.probe(file));
handle('media:thumbs', async (file, dur, n, h) => media.thumbs(file, dur, n, h));
handle('media:frame', async (file, t) => media.frame(file, t, path.join(media.tmpDir('frames'), `f${Date.now()}.png`)));
handle('media:proxy', async (file, info) => {
  const out = path.join(media.tmpDir('proxy'), `p${Date.now()}.mp4`);
  return media.proxy(file, info, out, p => win && win.webContents.send('proxy:progress', p));
});

handle('fs:reveal', async p => { shell.showItemInFolder(p); return true; });
handle('fs:open', async p => shell.openPath(p));
handle('fs:writeB64', async (p, b64) => { fs.writeFileSync(p, Buffer.from(b64, 'base64')); return p; });
handle('fs:exists', async p => fs.existsSync(p));
handle('fs:outName', async (base, suffix, ext) => {
  const dir = defaultOutDir();
  const stem = path.basename(base).replace(/\.[^.]+$/, '');
  let p = path.join(dir, `${stem}${suffix}.${ext}`), i = 2;
  while (fs.existsSync(p)) p = path.join(dir, `${stem}${suffix} (${i++}).${ext}`);
  return p;
});
handle('shell:url', async u => { if (/^https:\/\//.test(u)) await shell.openExternal(u); return true; });

/* ---------------------------------------------------------------- export jobs */
const jobs = new Map();
let jid = 0;
handle('job:plan', async (opts, info) => {
  const c = await gpu.caps(UD());
  const s = readSettings();
  return pipeline.buildPlan(opts, info, capsFor(c, s, os.tmpdir()));
});
function capsFor(c, s, tmp) {
  return { encoders: c.encoders, gpu: s.gpu ?? 0, upBackend: s.upBackend === 'auto' ? (bench.bestBackend(UD()) || 'ort') : s.upBackend, paths: rt.paths(), tmp };
}
handle('job:start', async (opts, info) => {
  const c = await gpu.caps(UD());
  const s = readSettings();
  const id = ++jid;
  const tmp = media.tmpDir('job' + id);
  const plan = pipeline.buildPlan(opts, info, capsFor(c, s, tmp));
  const j = new Job(id, plan, ev => win && win.webContents.send('job:event', ev));
  jobs.set(id, j);
  const t0 = Date.now();
  j.run(tmp).then(() => {
    let size = 0; try { size = fs.statSync(opts.outPath).size; } catch (e) {}
    win && win.webContents.send('job:event', { id, type: 'done', out: opts.outPath, size, secs: (Date.now() - t0) / 1000, expect: plan.expect, encoder: plan.encoder });
  }).catch(err => {
    win && win.webContents.send('job:event', { id, type: 'error', err: String(err.message || err), cancelled: j.cancelled, log: j.log.slice(-40).join('\n') });
  }).finally(() => { jobs.delete(id); fs.rm(tmp, { recursive: true, force: true }, () => {}); });
  return { id, expect: plan.expect, encoder: plan.encoder, enhance: plan.enhance };
});
handle('job:preview', async (opts, info, t) => {
  const c = await gpu.caps(UD());
  const s = readSettings();
  const tmp = media.tmpDir('prev' + Date.now());
  const after = path.join(tmp, 'after.png');
  const plan = pipeline.buildPlan({ ...opts, outPath: after, preview: true, trim: { start: t, end: t + 1 } }, info, capsFor(c, s, tmp));
  const j = new Job(0, plan, () => {});
  const before = media.frame(opts.input, t, path.join(tmp, 'before.png'));
  await j.run(tmp);
  await before;
  return { before: path.join(tmp, 'before.png'), after, plan: { up: plan.up, fg: plan.fg, w: plan.expect.w, h: plan.expect.h } };
});
handle('diag:cached', async () => bench.cached(UD()));
handle('job:cancel', async id => { const j = jobs.get(id); if (j) j.cancel(); return true; });

/* ---------------------------------------------------------------- images */
handle('img:bg', async src => {
  const mask = path.join(media.tmpDir('masks'), `m${Date.now()}.png`);
  const r = await img.call('bg', { src, mask, device: readSettings().gpu || 0 });
  return { ...r, mask };
});
handle('img:upscale', async (src, out, model, scale, reqId) => {
  const r = await img.call('upscale', { src, out, model, scale, device: readSettings().gpu || 0 }, p => win && win.webContents.send('img:progress', { reqId, p }));
  return { ...r, out };
});
handle('img:warm', async () => img.start(readSettings().gpu || 0));

/* ---------------------------------------------------------------- diagnostics / benchmark */
handle('diag:run', async outFile => {
  const report = await bench.run(UD(), readSettings(), p => win && win.webContents.send('diag:progress', p));
  const file = outFile || path.join(app.getPath('documents'), '7krh Studio', 'diagnostics.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 1));
  return { file, report };
});
