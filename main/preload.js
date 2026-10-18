'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (ch, ...a) => ipcRenderer.invoke(ch, ...a).then(r => { if (!r.ok) throw new Error(r.err); return r.v; });
const on = (ch, f) => { const h = (_, d) => f(d); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); };

contextBridge.exposeInMainWorld('studio', {
  info: () => call('app:info'),
  settings: { get: () => call('settings:get'), set: p => call('settings:set', p) },
  caps: force => call('caps', force),
  open: (kind, multi) => call('dlg:open', { kind, multi }),
  folder: () => call('dlg:folder'),
  savePath: (name, ext) => call('dlg:save', { name, ext }),
  pathOf: file => webUtils.getPathForFile(file),
  probe: f => call('media:probe', f),
  thumbs: (f, d, n, h) => call('media:thumbs', f, d, n, h),
  frame: (f, t) => call('media:frame', f, t),
  proxy: (f, info) => call('media:proxy', f, info),
  reveal: p => call('fs:reveal', p),
  openPath: p => call('fs:open', p),
  writeB64: (p, b) => call('fs:writeB64', p, b),
  outName: (base, suffix, ext) => call('fs:outName', base, suffix, ext),
  url: u => call('shell:url', u),
  plan: (o, i) => call('job:plan', o, i),
  start: (o, i) => call('job:start', o, i),
  cancel: id => call('job:cancel', id),
  upscaleImage: (src, out, model, scale, reqId) => call('img:upscale', src, out, model, scale, reqId),
  warmImage: () => call('img:warm'),
  diag: f => call('diag:run', f),
  diagCached: () => call('diag:cached'),
  preview: (o, i, t) => call('job:preview', o, i, t),
  onJob: f => on('job:event', f),
  onProxy: f => on('proxy:progress', f),
  onImg: f => on('img:progress', f),
  onDiag: f => on('diag:progress', f),
});
