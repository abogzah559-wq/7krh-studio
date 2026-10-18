'use strict';
/* Hardware detection: graphics cards and which video encoders really work on this PC. */
const { run } = require('./media');
const rt = require('./runtime');
const fs = require('fs');
const path = require('path');

const ENCODERS = ['h264_nvenc', 'hevc_nvenc', 'av1_nvenc', 'h264_amf', 'hevc_amf', 'av1_amf', 'h264_qsv', 'hevc_qsv', 'av1_qsv', 'libx264', 'libx265', 'libsvtav1'];

async function gpus() {
  const list = [];
  try {
    const ps = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion,VideoProcessor | ConvertTo-Json -Compress'], { timeout: 20000 });
    let j = JSON.parse(ps || '[]'); if (!Array.isArray(j)) j = [j];
    for (const g of j) list.push({ name: g.Name, vramMB: g.AdapterRAM ? Math.round(g.AdapterRAM / 1048576) : 0, driver: g.DriverVersion });
  } catch (e) {}
  // AdapterRAM is capped at 4 GB in WMI: ask nvidia-smi for the real numbers when present
  try {
    const s = await run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], { timeout: 10000 });
    s.trim().split(/\r?\n/).forEach(line => {
      const [name, mem, drv] = line.split(',').map(x => x.trim());
      const g = list.find(x => x.name && x.name.includes(name.replace('NVIDIA ', ''))) || list.find(x => /nvidia/i.test(x.name || ''));
      if (g) { g.vramMB = +mem; g.driver = drv; g.nvidia = true; } else list.push({ name, vramMB: +mem, driver: drv, nvidia: true });
    });
  } catch (e) {}
  const real = list.filter(g => g.name && !/basic display|remote|virtual|parsec|meta/i.test(g.name));
  real.sort((a, b) => (b.nvidia ? 1 : 0) - (a.nvidia ? 1 : 0) || (b.vramMB || 0) - (a.vramMB || 0));
  return real;
}

async function testEncoder(name) {
  const P = rt.paths();
  const pix = /nvenc|amf|qsv/.test(name) ? (name.startsWith('h264') ? 'yuv420p' : 'yuv420p') : 'yuv420p';
  try {
    await run(P.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-frames:v', '8', '-pix_fmt', pix, '-c:v', name, '-f', 'null', '-'], { timeout: 20000 });
    return true;
  } catch (e) { return false; }
}

/* Are the Microsoft Store codec extensions installed? (decides which codec plays in Windows' own players) */
async function codecExtensions() {
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
    const key = JSON.stringify(g.map(x => [x.name, x.driver]));
    if (!force) {
      try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (c.key === key && c.v === 3) return c; } catch (e) {}
    }
    const enc = [];
    for (const e of ENCODERS) if (await testEncoder(e)) enc.push(e);
    const ext = await codecExtensions();
    const c = { v: 3, key, gpus: g, encoders: enc, nvidia: g.some(x => x.nvidia), ...ext, time: Date.now() };
    try { fs.mkdirSync(userData, { recursive: true }); fs.writeFileSync(file, JSON.stringify(c, null, 1)); } catch (e) {}
    return c;
  })();
  return capsPromise;
}

module.exports = { gpus, caps, testEncoder, ENCODERS };
