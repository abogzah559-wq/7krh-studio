# 7krh Studio — assembles the native runtime (engines + AI models) into .\runtime
# Runs on the GitHub Windows runner. Needs: gh (GH_TOKEN), 7z, Python 3.12 on PATH.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = (Resolve-Path "$PSScriptRoot\..").Path
$rt = Join-Path $root 'runtime'
$dl = Join-Path $root '.dl'
New-Item -ItemType Directory -Force $rt, $dl | Out-Null

function Get-Url($url, $out) {
  if (-not (Test-Path $out)) {
    Write-Host "GET $url"
    & curl.exe -L --fail --retry 4 --retry-delay 3 -s -S -o $out $url
    if ($LASTEXITCODE -ne 0) { throw "download failed: $url" }
  }
}
function Get-Gh($repo, $pattern, $outDir, $tag = '') {
  New-Item -ItemType Directory -Force $outDir | Out-Null
  $tagArg = @(); if ($tag) { $tagArg = @($tag) }
  Write-Host "gh release download $repo $tag -p $pattern"
  & gh release download @tagArg -R $repo -p $pattern -D $outDir --clobber
  if ($LASTEXITCODE -ne 0) { throw "gh download failed: $repo $pattern" }
}
function Expand-7z($archive, $out, [string[]]$filter = @()) {
  New-Item -ItemType Directory -Force $out | Out-Null
  & 7z x -y "-o$out" $archive @filter | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "7z failed: $archive" }
}
function Find-One($dir, $name) {
  $f = Get-ChildItem -Path $dir -Recurse -File -Filter $name | Select-Object -First 1
  if (-not $f) { throw "not found: $name in $dir" }
  return $f.FullName
}

# ---------------------------------------------------------------- FFmpeg (GPL, shared, NVENC/AMF/QSV)
$ff = Join-Path $rt 'ffmpeg'
if (-not (Test-Path "$ff\ffmpeg.exe")) {
  Get-Gh 'BtbN/FFmpeg-Builds' 'ffmpeg-master-latest-win64-gpl-shared.zip' "$dl\ffmpeg" 'latest'
  Expand-7z "$dl\ffmpeg\ffmpeg-master-latest-win64-gpl-shared.zip" "$dl\ffmpeg\x"
  $bin = Split-Path (Find-One "$dl\ffmpeg\x" 'ffmpeg.exe')
  New-Item -ItemType Directory -Force $ff | Out-Null
  Copy-Item "$bin\*" $ff -Recurse -Force
}

# ---------------------------------------------------------------- Python 3.12 embed + VapourSynth R79 portable
$vs = Join-Path $rt 'vs'
if (-not (Test-Path "$vs\python.exe")) {
  Get-Url 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip' "$dl\py.zip"
  Get-Url 'https://github.com/vapoursynth/vapoursynth/releases/download/R79/VapourSynth64-Portable-R79.zip' "$dl\vs.zip"
  Expand-7z "$dl\py.zip" $vs
  Expand-7z "$dl\vs.zip" "$dl\vsp"
  Write-Host '--- VapourSynth portable layout'
  Get-ChildItem "$dl\vsp" -Recurse -File | ForEach-Object { '{0,10}  {1}' -f $_.Length, $_.FullName.Substring("$dl\vsp".Length) } | Select-Object -First 80
  # Everything from the portable package goes next to python.exe (vspipe, VSScript, plugins dir)
  Get-ChildItem "$dl\vsp" | Where-Object { $_.Name -ne 'wheel' } | ForEach-Object { Copy-Item $_.FullName $vs -Recurse -Force }
  $wheel = Get-ChildItem "$dl\vsp\wheel" -Filter *.whl | Select-Object -First 1
  if ($wheel) { Expand-7z $wheel.FullName "$vs\Lib\site-packages" }
  $pth = Get-ChildItem $vs -Filter 'python3*._pth' | Select-Object -First 1
  Add-Content $pth.FullName "`r`nLib\site-packages`r`n..\engine`r`nimport site`r`n"
}

# ---------------------------------------------------------------- Python packages for the image server (ONNX Runtime DirectML)
if (-not (Test-Path "$vs\Lib\site-packages\onnxruntime")) {
  & python -m pip install --disable-pip-version-check --no-compile --target "$vs\Lib\site-packages" --only-binary=:all: --python-version 3.12 --platform win_amd64 `
    'onnxruntime-directml==1.22.0' 'numpy<2.3' 'pillow' 'opencv-python-headless'
  if ($LASTEXITCODE -ne 0) { throw 'pip failed' }
}

# ---------------------------------------------------------------- VapourSynth plugins
$plug = Join-Path $rt 'vs-plugins'
New-Item -ItemType Directory -Force $plug | Out-Null
if (-not (Test-Path "$plug\LSMASHSource.dll")) {
  Get-Gh 'HomeOfAviSynthPlusEvolution/L-SMASH-Works' '*.7z' "$dl\lsmas"
  Get-ChildItem "$dl\lsmas" -Filter *.7z | ForEach-Object { Expand-7z $_.FullName "$dl\lsmas\x" }
  $c = Get-ChildItem "$dl\lsmas\x" -Recurse -Filter 'LSMASHSource.dll' | Where-Object { $_.FullName -match 'x64' } | Select-Object -First 1
  if (-not $c) { $c = Get-ChildItem "$dl\lsmas\x" -Recurse -Filter 'LSMASHSource.dll' | Select-Object -First 1 }
  Copy-Item $c.FullName "$plug\LSMASHSource.dll"
}
if (-not (Test-Path "$plug\librife.dll")) {
  Get-Url 'https://github.com/styler00dollar/VapourSynth-RIFE-ncnn-Vulkan/releases/download/r9_mod_v33/librife_windows_x86-64.dll' "$plug\librife.dll"
}
$rifeM = Join-Path $rt 'models\rife'
foreach ($m in 'rife-v4.6_ensembleFalse', 'rife-v4.22_lite_ensembleFalse', 'rife-v4.25-lite_ensembleFalse', 'rife-v4.26_ensembleFalse') {
  New-Item -ItemType Directory -Force "$rifeM\$m" | Out-Null
  foreach ($f in 'flownet.param', 'flownet.bin') {
    Get-Url "https://raw.githubusercontent.com/styler00dollar/VapourSynth-RIFE-ncnn-Vulkan/c3ec6aabc07c8fa37a4f58d7fed9e2ad1fc1b13f/models/$m/$f" "$rifeM\$m\$f"
  }
}

# vs-mlrt: ONNX Runtime (DirectML) and ncnn (Vulkan) backends + vsmlrt.py + Real-ESRGAN models
if (-not (Test-Path "$plug\vsort")) {
  Get-Gh 'AmusementClub/vs-mlrt' 'VSORT-Windows-x64.*.7z' "$dl\mlrt"
  Get-Gh 'AmusementClub/vs-mlrt' 'VSNCNN-Windows-x64.*.7z' "$dl\mlrt"
  Get-Gh 'AmusementClub/vs-mlrt' 'scripts.*.7z' "$dl\mlrt"
  Get-Gh 'AmusementClub/vs-mlrt' 'models.*.7z' "$dl\mlrt"
  foreach ($a in Get-ChildItem "$dl\mlrt" -Filter '*.7z') {
    Write-Host "--- listing $($a.Name)"
    if ($a.Name -like 'models.*') {
      & 7z l $a.FullName | Select-String -Pattern 'RealESRGAN|rife|onnx$' | Select-Object -First 60
    } else {
      & 7z l $a.FullName | Select-Object -Last 40
    }
  }
  foreach ($a in Get-ChildItem "$dl\mlrt" -Filter 'VS*.7z') { Expand-7z $a.FullName $plug }
  $s = Get-ChildItem "$dl\mlrt" -Filter 'scripts.*.7z' | Select-Object -First 1
  Expand-7z $s.FullName "$dl\mlrt\scripts"
  Copy-Item (Find-One "$dl\mlrt\scripts" 'vsmlrt.py') "$vs\Lib\site-packages\vsmlrt.py"
  $mz = Get-ChildItem "$dl\mlrt" -Filter 'models.*.7z' | Select-Object -First 1
  Expand-7z $mz.FullName "$rt\models\mlrt" @('models\RealESRGANv2\*', 'models\RealESRGAN\*', '-r')
}

# ---------------------------------------------------------------- BiRefNet (background removal), MIT
$bg = Join-Path $rt 'models\birefnet'
New-Item -ItemType Directory -Force $bg | Out-Null
Get-Url 'https://huggingface.co/onnx-community/BiRefNet-ONNX/resolve/main/onnx/model_fp16.onnx' "$bg\birefnet_fp16.onnx"

# ---------------------------------------------------------------- report
Write-Host '--- runtime size by folder (MB)'
Get-ChildItem $rt -Directory | ForEach-Object {
  $s = (Get-ChildItem $_.FullName -Recurse -File | Measure-Object Length -Sum).Sum
  '{0,8:N1}  {1}' -f ($s / 1MB), $_.Name
}
$tot = (Get-ChildItem $rt -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ('TOTAL {0:N1} MB' -f ($tot / 1MB))
Write-Host '--- files over 5 MB'
Get-ChildItem $rt -Recurse -File | Where-Object Length -gt 5MB | Sort-Object Length -Descending | ForEach-Object { '{0,8:N1}  {1}' -f ($_.Length / 1MB), $_.FullName.Substring($rt.Length) }
Write-Host '--- models'
Get-ChildItem "$rt\models" -Recurse -File | ForEach-Object { '{0,8:N1}  {1}' -f ($_.Length / 1MB), $_.FullName.Substring($rt.Length) }
Write-Host '--- vs root + plugins'
Get-ChildItem $vs -File | ForEach-Object { $_.Name }
Get-ChildItem $plug -Recurse -File | ForEach-Object { '{0,8:N1}  {1}' -f ($_.Length / 1MB), $_.FullName.Substring($plug.Length) }
