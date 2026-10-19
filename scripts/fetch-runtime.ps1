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
  Add-Content $pth.FullName "`r`nLib\site-packages`r`nimport site`r`n"
}

# ---------------------------------------------------------------- Python packages for the image server (ONNX Runtime DirectML)
if (-not (Test-Path "$vs\Lib\site-packages\onnxruntime")) {
  & python -m pip install --disable-pip-version-check --no-compile --target "$vs\Lib\site-packages" --only-binary=:all: --python-version 3.12 --platform win_amd64 `
    'onnxruntime-directml==1.22.0' 'numpy<2.3' 'pillow'
  if ($LASTEXITCODE -ne 0) { throw 'pip failed' }
}

# vs-mlrt's TensorRT-RTX backend reads the model with the "onnx" package before building its engine
if (-not (Test-Path "$vs\Lib\site-packages\onnx")) {
  & python -m pip install --disable-pip-version-check --no-compile --target "$vs\Lib\site-packages" --only-binary=:all: --python-version 3.12 --platform win_amd64 --no-deps `
    'onnx==1.17.0' 'protobuf>=5,<6'
  if ($LASTEXITCODE -ne 0) { throw 'pip onnx failed' }
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
# the RIFE plugin looks for its models in a "models" folder next to librife.dll
$rifeM = Join-Path $plug 'models'
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

# ---------------------------------------------------------------- TensorRT-RTX backend (NVIDIA RTX: fastest AI upscale), optional
if (-not (Test-Path "$plug\vstrt_rtx.dll")) {
  try {
    Get-Gh 'AmusementClub/vs-mlrt' 'VSTRT-RTX-Windows-x64.*.7z' "$dl\trtx"
    $a = Get-ChildItem "$dl\trtx" -Filter 'VSTRT-RTX-*.7z' | Select-Object -First 1
    Write-Host "--- listing $($a.Name)"; & 7z l $a.FullName | Select-Object -Last 15
    Expand-7z $a.FullName "$dl\trtx\x"
    Copy-Item (Find-One "$dl\trtx\x" 'vstrt_rtx.dll') "$plug\vstrt_rtx.dll"
    Get-Gh 'AmusementClub/vs-mlrt' 'vsmlrt-cuda.*.7z.0*' "$dl\cuda"
    $c = Get-ChildItem "$dl\cuda" -Filter '*.7z.001' | Select-Object -First 1
    Write-Host "--- listing $($c.Name) (rtx / cudart)"
    & 7z l $c.FullName | Select-String -Pattern 'rtx|cudart|nvrtc|onnxparser' | Select-Object -First 40
    & 7z x -y "-o$plug" $c.FullName 'vsmlrt-cuda\*rtx*' 'vsmlrt-cuda\cudart64*' -r | Out-Null
    Get-ChildItem "$plug\vsmlrt-cuda" -File | ForEach-Object { '{0,8:N1}  {1}' -f ($_.Length / 1MB), $_.Name }
    Remove-Item -Recurse -Force "$dl\cuda" -ErrorAction SilentlyContinue
  } catch { Write-Host "TensorRT-RTX backend skipped: $_" }
}

# ---------------------------------------------------------------- Real-ESRGAN for real footage/photos (BSD-3): PyTorch weights -> ONNX
$esr = Join-Path $rt 'models\esrgan'
New-Item -ItemType Directory -Force $esr | Out-Null
if (-not (Test-Path "$esr\realesr-general-x4v3.onnx") -or -not (Test-Path "$esr\RealESRGAN_x4plus.onnx")) {
  & python -m pip install --disable-pip-version-check -q torch --index-url https://download.pytorch.org/whl/cpu
  & python -m pip install --disable-pip-version-check -q onnx
  Get-Url 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth' "$dl\realesr-general-x4v3.pth"
  Get-Url 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth' "$dl\RealESRGAN_x4plus.pth"
  & python "$PSScriptRoot\export_esrgan.py" "$dl\realesr-general-x4v3.pth" compact 4 "$esr\realesr-general-x4v3.onnx"
  if ($LASTEXITCODE -ne 0) { throw 'export general-x4v3 failed' }
  & python "$PSScriptRoot\export_esrgan.py" "$dl\RealESRGAN_x4plus.pth" rrdb 4 "$esr\RealESRGAN_x4plus.onnx"
  if ($LASTEXITCODE -ne 0) { throw 'export x4plus failed' }
}

# ---------------------------------------------------------------- RNNoise model for ffmpeg arnndn (AI voice noise removal), BSD-3, optional
$rn = Join-Path $rt 'models\rnnoise'
if (-not (Test-Path "$rn\cb.rnnn")) {
  try {
    New-Item -ItemType Directory -Force $rn | Out-Null
    & git clone --depth 1 -q https://github.com/GregorR/rnnoise-models "$dl\rnnoise"
    Copy-Item "$dl\rnnoise\conjoined-burgers-2018-08-28\cb.rnnn" "$rn\cb.rnnn"
    Copy-Item "$dl\rnnoise\COPYING" "$rn\COPYING" -ErrorAction SilentlyContinue
    Write-Host ('rnnoise model {0:N0} bytes, commit {1}' -f (Get-Item "$rn\cb.rnnn").Length, (& git -C "$dl\rnnoise" rev-parse HEAD))
  } catch { Write-Host "RNNoise model skipped: $_" }
}

# background removal was dropped in v0.3: make sure a cached runtime does not ship its model any more
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $rt 'models\birefnet')

# ---------------------------------------------------------------- trim what the app never uses
Remove-Item -Force -ErrorAction SilentlyContinue "$ff\ffplay.exe", "$plug\vsort\onnxruntime_providers_cuda.dll"
Get-ChildItem $rt -Recurse -Include *.pdb, *.lib | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem "$vs\Lib\site-packages" -Directory -Recurse -Filter '__pycache__' | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem "$vs\Lib\site-packages" -Directory -Filter 'tests' -Recurse | Where-Object { $_.FullName -match 'numpy|PIL' } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# ---------------------------------------------------------------- manifest (paths relative to runtime\)
function Rel($p) { return $p.Substring($rt.Length + 1) }
$vspipe = Get-ChildItem $vs -Recurse -Filter 'vspipe.exe' | Select-Object -First 1
$an = Get-ChildItem "$rt\models\mlrt" -Recurse -Filter '*.onnx'
$man = [ordered]@{
  ffmpeg = 'ffmpeg\ffmpeg.exe'; ffprobe = 'ffmpeg\ffprobe.exe'; python = 'vs\python.exe'; vspipe = (Rel $vspipe.FullName)
  lsmas = 'vs-plugins\LSMASHSource.dll'; rife = 'vs-plugins\librife.dll'; vsort = 'vs-plugins\vsort.dll'; vsncnn = 'vs-plugins\vsncnn.dll'; vstrt = 'vs-plugins\vstrt_rtx.dll'
  models = [ordered]@{
    real_x4 = 'models\esrgan\realesr-general-x4v3.onnx'
    real_x2 = 'models\esrgan\realesr-general-x4v3.onnx'
    photo_x4 = 'models\esrgan\RealESRGAN_x4plus.onnx'
    anime_x4 = (Rel ($an | Where-Object Name -eq 'realesr-animevideov3.onnx' | Select-Object -First 1).FullName)
    anime_x2 = (Rel ($an | Where-Object Name -like '*xsx2.onnx' | Select-Object -First 1).FullName)
    rnnoise = $(if (Test-Path "$rt\models\rnnoise\cb.rnnn") { 'models\rnnoise\cb.rnnn' } else { $null })
  }
}
# size + SHA-256 of every engine binary and model, so the app can check its own files (Settings > Engines)
$files = [ordered]@{}
Get-ChildItem $rt -Recurse -File -Include *.exe, *.dll, *.pyd, *.onnx, *.bin, *.param, *.rnnn | ForEach-Object {
  $files[(Rel $_.FullName)] = [ordered]@{ size = $_.Length; sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower() }
}
$man["files"] = $files
$man | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 "$rt\manifest.json"
Get-Content "$rt\manifest.json"

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
