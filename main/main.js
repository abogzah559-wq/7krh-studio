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
const DEFAULTS = { lang: null, outDir: null, gpu: 0, upBackend: 'auto', quality: 'high', codec: 'h264', tenBit: false, platform: 'self', firstRun: true };

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

/* UI scale follows the window: 1440×880 is the design size; bigger windows (2K/4K, maximized) scale the
   whole interface up instead of leaving empty space. Coordinates stay consistent because it is a real zoom. */
let zoom = 1;
function fitZoom() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  const z = Math.round(Math.max(1, Math.min(1.6, Math.min(w / 1440, h / 860))) * 20) / 20;
  if (z === zoom) return;
  zoom = z;
  win.webContents.setZoomFactor(z);
  try { win.setTitleBarOverlay({ height: Math.round(42 * z) }); } catch (e) {}
}

function createWindow() {
  const { screen } = require('electron');
  const wa = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.max(1180, Math.min(wa.width - 80, Math.round(wa.width * 0.82))), height: Math.max(760, Math.min(wa.height - 60, Math.round(wa.height * 0.86))),
    minWidth: 1120, minHeight: 720, show: false, center: true,
    backgroundColor: '#09070c', title: '7krh Studio',
    icon: path.join(__dirname, '..', 'ui', 'img', 'logo-128.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0c0a10', symbolColor: '#e8e2f0', height: 42 },
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

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  createWindow();
  // warm up hardware detection in the background
  gpu.caps(UD()).catch(() => {});
  // "7krh Studio.exe --diag" measures the PC and writes Documents\7krh Studio\diagnostics.json
  // first start (or new version): measure this PC once in the background so the fastest AI engine is used
  setTimeout(() => {
    const b = bench.cached(UD());
    if (!process.argv.includes('--diag') && (!b || b.benchVersion !== 2 || b.appVersion !== app.getVersion())) runDiag().catch(() => {});
  }, 4000);
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
  return { encoders: c.encoders, gpu: s.gpu ?? 0, upBackend: s.upBackend === 'auto' || !s.upBackend ? (bench.bestBackend(UD()) || 'ort') : s.upBackend,
    paths: rt.paths(), tmp, engines: path.join(UD(), 'engines') };
}
/* one L-SMASH index per source file (indexing a long 4K clip takes seconds; previews reuse it) */
function lwiFor(input) {
  let st = null; try { st = fs.statSync(input); } catch (e) {}
  const key = require('crypto').createHash('sha1').update(input + '|' + (st ? st.size + '|' + st.mtimeMs : '')).digest('hex').slice(0, 16);
  return path.join(media.tmpDir('index'), key + '.lwi');
}
const LOGS = () => path.join(app.getPath('documents'), '7krh Studio', 'logs');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
handle('job:start', async (opts, info) => {
  const c = await gpu.caps(UD());
  const s = readSettings();
  const id = ++jid;
  const tmp = media.tmpDir('job' + id);
  const plan = pipeline.buildPlan(opts, info, { ...capsFor(c, s, tmp), lwi: lwiFor(opts.input) });
  const j = new Job(id, plan, ev => win && win.webContents.send('job:event', ev), path.join(LOGS(), `export-${stamp()}-${id}.txt`));
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
  const plan = pipeline.buildPlan({ ...opts, outPath: after, preview: true, trim: { start: t, end: t + 1 } }, info, { ...capsFor(c, s, tmp), lwi: lwiFor(opts.input) });
  const j = new Job(0, plan, () => {}, path.join(LOGS(), `preview-${stamp()}.txt`));
  const before = media.frame(opts.input, t, path.join(tmp, 'before.png'));
  const t0 = Date.now();
  await j.run(tmp);
  await before;
  return { before: path.join(tmp, 'before.png'), after, secs: (Date.now() - t0) / 1000, plan: { up: plan.up, fg: plan.fg, w: plan.expect.w, h: plan.expect.h } };
});
handle('diag:cached', async () => bench.cached(UD()));
handle('job:cancel', async id => { const j = jobs.get(id); if (j) j.cancel(); return true; });

/* ---------------------------------------------------------------- images */
handle('img:upscale', async (src, out, model, scale, reqId) => {
  const r = await img.call('upscale', { src, out, model, scale, device: readSettings().gpu || 0 }, p => win && win.webContents.send('img:progress', { reqId, p }));
  return { ...r, out };
});
handle('img:warm', async () => img.start(readSettings().gpu || 0));

/* ---------------------------------------------------------------- diagnostics / benchmark */
let diagRun = null;
function runDiag(outFile) {
  if (diagRun) return diagRun;
  diagRun = (async () => {
    const report = await bench.run(UD(), readSettings(), p => win && win.webContents.send('diag:progress', p));
    const file = outFile || path.join(app.getPath('documents'), '7krh Studio', 'diagnostics.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(report, null, 1));
    win && win.webContents.send('diag:progress', { step: 'done', report, file });
    return { file, report };
  })().finally(() => { diagRun = null; });
  return diagRun;
}
handle('diag:run', async outFile => runDiag(outFile));
