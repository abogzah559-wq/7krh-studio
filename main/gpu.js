'use strict';
/* Hardware detection: the real graphics cards (with each API's own numbering), which video encoders really
   work on this PC (each one is tested with a short encode), and what the bundled ffmpeg can do. */
const { run } = require('./media');
const rt = require('./runtime');
const fs = require('fs');
const path = require('path');

const ENCODERS = ['h264_nvenc', 'hevc_nvenc', 'av1_nvenc', 'h264_amf', 'hevc_amf', 'av1_amf', 'h264_qsv', 'hevc_qsv', 'av1_qsv', 'vp9_qsv', 'libx264', 'libx265', 'libsvtav1', 'libvpx-vp9'];
const FILTERS = ['perspective', 'sendcmd', 'arnndn', 'afftdn', 'sidechaincompress', 'alimiter', 'loudnorm', 'lut3d', 'vidstabdetect', 'libplacebo', 'zscale'];
const VENDOR = { 0x10de: 'nvidia', 0x1002: 'amd', 0x1022: 'amd', 0x8086: 'intel', 0x1414: 'microsoft' };
const WIN = process.platform === 'win32';

async function wmi() {
  const list = [];
  if (!WIN) return list;
  try {
    const ps = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress'], { timeout: 20000 });
    let j = JSON.parse(ps || '[]'); if (!Array.isArray(j)) j = [j];
    for (const g of j) list.push({ name: g.Name, vramMB: g.AdapterRAM ? Math.round(g.AdapterRAM / 1048576) : 0, driver: g.DriverVersion });
  } catch (e) {}
  return list;
}
async function nvsmi() {
  try {
    const s = await run('nvidia-smi', ['--query-gpu=index,name,memory.total,driver_version,pci.bus_id', '--format=csv,noheader,nounits'], { timeout: 10000 });
    return s.trim().split(/\r?\n/).filter(Boolean).map(l => { const [index, name, mem, drv, bus] = l.split(',').map(x => x.trim()); return { cuda: +index, name, vramMB: +mem, driver: drv, bus }; });
  } catch (e) { return []; }
}
async function apiLists() {
  const P = rt.paths();
  try {
    const s = await run(P.python, ['-X', 'utf8', path.join(P.engineDir, 'gpuinfo.py')], { timeout: 20000 });
    return JSON.parse(s.trim().split(/\r?\n/).pop());
  } catch (e) { return { dxgi: [], vulkan: [], errors: [String(e.message || e).slice(0, 200)] }; }
}
const norm = s => String(s || '').toLowerCase().replace(/\(r\)|\(tm\)|nvidia|amd|intel|corporation|graphics/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const same = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };

/* one entry per physical card, with its index in each API */
async function gpus() {
  const [w, nv, api] = await Promise.all([wmi(), nvsmi(), apiLists()]);
  let list;
  if (api.dxgi && api.dxgi.length) {
    list = api.dxgi.filter(d => !d.software && d.vendor !== 0x1414).map(d => ({ name: d.name, vramMB: d.vramMB, vendor: VENDOR[d.vendor] || 'other', dml: d.index }));
  } else {
    list = w.filter(g => g.name && !/basic display|remote|virtual|parsec|meta/i.test(g.name)).map((g, i) => ({ name: g.name, vramMB: g.vramMB, dml: i, vendor: /nvidia|geforce|rtx|gtx|quadro/i.test(g.name) ? 'nvidia' : /amd|radeon/i.test(g.name) ? 'amd' : /intel|arc|iris|uhd/i.test(g.name) ? 'intel' : 'other' }));
  }
  for (const g of list) {
    const ww = w.find(x => same(x.name, g.name)); if (ww) g.driver = ww.driver;
    const n = nv.find(x => same(x.name, g.name)); if (n) { g.cuda = n.cuda; g.vramMB = n.vramMB || g.vramMB; g.driver = n.driver; g.nvidia = true; }
    const vks = (api.vulkan || []).filter(x => same(x.name, g.name)); if (vks.length) g.vk = vks[0].index;
    if (g.vendor === 'nvidia') g.nvidia = true;
  }
  // a card with no Vulkan match keeps its DXGI position (single-GPU PCs: both are 0)
  list.forEach(g => { if (g.vk == null) g.vk = (api.vulkan || []).length ? -1 : g.dml; if (g.cuda == null && g.nvidia) g.cuda = 0; });
  list.sort((a, b) => (b.nvidia ? 1 : 0) - (a.nvidia ? 1 : 0) || (b.vramMB || 0) - (a.vramMB || 0));
  return { list, apiErrors: api.errors || [], vulkanCount: (api.vulkan || []).length, dxgiCount: (api.dxgi || []).length };
}

async function testEncoder(name) {
  const P = rt.paths();
  try {
    await run(P.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-frames:v', '8', '-pix_fmt', 'yuv420p', '-c:v', name, '-f', 'null', '-'], { timeout: 20000 });
    return true;
  } catch (e) { return false; }
}
async function ffmpegInfo() {
  const P = rt.paths();
  const r = { major: 0, version: '', filters: [] };
  try { const v = await run(P.ffmpeg, ['-hide_banner', '-version'], { timeout: 10000 }); r.version = v.split('\n')[0].trim(); const m = v.match(/version (?:n|N-)?(\d+)/); r.major = m ? +m[1] : 0; if (!r.major && /version N-/.test(v)) r.major = 8; } catch (e) {}
  try { const f = await run(P.ffmpeg, ['-hide_banner', '-filters'], { timeout: 10000 }); r.filters = FILTERS.filter(n => new RegExp('\\s' + n + '\\s').test(f)); } catch (e) {}
  return r;
}

async function codecExtensions() {
  if (!WIN) return {};
  try {
    const s = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-AppxPackage -Name 'Microsoft.HEVCVideoExtension*','Microsoft.AV1VideoExtension*' | Select-Object -ExpandProperty Name"], { timeout: 20000 });
    return { hevcExt: /HEVC/i.test(s), av1Ext: /AV1/i.test(s) };
  } catch (e) { return {}; }
}

let capsPromise = null;
function caps(userData, force = false) {
  if (capsPromise && !force) return capsPromise;
  capsPromise = (async () => {
    const file = path.join(userData, 'caps.json');
    const g = await gpus();
    const key = JSON.stringify(g.list.map(x => [x.name, x.driver]));
    if (!force) {
      try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (c.key === key && c.v === 4) return c; } catch (e) {}
    }
    const enc = [];
    for (const e of ENCODERS) if (await testEncoder(e)) enc.push(e);
    const [ext, ffi] = await Promise.all([codecExtensions(), ffmpegInfo()]);
    const c = { v: 4, key, gpus: g.list, apiErrors: g.apiErrors, encoders: enc, nvidia: g.list.some(x => x.nvidia), ffmpeg: ffi, ffmpegMajor: ffi.major, filters: ffi.filters, ...ext, time: Date.now() };
    try { fs.mkdirSync(userData, { recursive: true }); fs.writeFileSync(file, JSON.stringify(c, null, 1)); } catch (e) {}
    return c;
  })();
  capsPromise.catch(() => { capsPromise = null; });
  return capsPromise;
}

/* the card picked in Settings (by name, so a new card order never silently switches GPUs) */
function device(c, settings) {
  const list = (c && c.gpus) || [];
  const g = list.find(x => x.name === settings.gpuName) || list[settings.gpu || 0] || list[0];
  if (!g) return { name: null, dml: 0, vk: 0, cuda: 0, none: true };
  return { name: g.name, dml: g.dml ?? 0, vk: g.vk == null || g.vk < 0 ? 0 : g.vk, cuda: g.cuda ?? 0, vendor: g.vendor, vramMB: g.vramMB, nvidia: !!g.nvidia, vkMissing: g.vk === -1 };
}

/* AI inference and video encoding are separate questions: NVENC working says nothing about the AI engine */
function summary(c, settings, bench) {
  const d = device(c, settings);
  const hwEnc = (c.encoders || []).filter(e => /nvenc|amf|qsv/.test(e));
  return {
    gpu: d.name, vramMB: d.vramMB,
    encode: hwEnc.length ? [...new Set(hwEnc.map(e => e.split('_')[1].toUpperCase()))].join(' / ') : null,
    ai: bench && bench.best ? { trt: 'TensorRT', ort: 'DirectML', ncnn: 'Vulkan' }[bench.best] : null,
    image: bench && bench.image && bench.image.real_x4_device ? bench.image.real_x4_device : null,
  };
}

module.exports = { gpus, caps, device, summary, testEncoder, ENCODERS, FILTERS };
