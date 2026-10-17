# 7krh Studio — smoke tests of the bundled engines on the CI runner (no GPU there: DirectML falls back to WARP)
$ErrorActionPreference = 'Continue'
$rt = (Resolve-Path "$PSScriptRoot\..\runtime").Path
$py = "$rt\vs\python.exe"
$fail = 0
function Check($name, [scriptblock]$b) {
  Write-Host "=== $name"
  try { & $b; if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "exit $LASTEXITCODE" }; Write-Host "OK  $name" }
  catch { Write-Host "FAIL $name : $_"; $script:fail++ }
}
Check 'ffmpeg encoders' { & "$rt\ffmpeg\ffmpeg.exe" -hide_banner -encoders | Select-String 'nvenc|amf|qsv|libx264|libx265|svtav1' }
Check 'python + onnxruntime' { & $py -c "import onnxruntime as o, numpy, PIL, cv2; print(o.__version__, o.get_available_providers())" }
Check 'vapoursynth core' { & $py -c "import vapoursynth as vs; print(vs.core.version())" }
$vspipe = Get-ChildItem "$rt\vs" -Recurse -Filter 'vspipe.exe' | Select-Object -First 1
Write-Host "vspipe: $($vspipe.FullName)"
Check 'vspipe' { & $vspipe.FullName --version }
# a 2-second test clip, then L-SMASH source + resize through vspipe -> ffmpeg
& "$rt\ffmpeg\ffmpeg.exe" -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=640x360:rate=30 -t 2 -c:v libx264 -pix_fmt yuv420p "$env:TEMP\t.mp4"
$vpy = @"
import vapoursynth as vs
core = vs.core
core.std.LoadPlugin(r'$rt\vs-plugins\LSMASHSource.dll')
c = core.lsmas.LWLibavSource(r'$env:TEMP\t.mp4', cachefile=r'$env:TEMP\t.lwi')
c = core.resize.Spline36(c, 1280, 720)
c.set_output()
"@
Set-Content "$env:TEMP\t.vpy" $vpy
Check 'vspipe -> ffmpeg' {
  cmd /c "`"$($vspipe.FullName)`" -c y4m `"$env:TEMP\t.vpy`" - | `"$rt\ffmpeg\ffmpeg.exe`" -hide_banner -loglevel error -y -i - -c:v libx264 `"$env:TEMP\o.mp4`""
  & "$rt\ffmpeg\ffprobe.exe" -v error -show_entries stream=width,height,nb_frames -of csv=p=0 "$env:TEMP\o.mp4"
}
Check 'vs-mlrt plugins load' { & $py -c "import vapoursynth as vs, glob, os; c=vs.core; [c.std.LoadPlugin(p) for p in glob.glob(r'$rt\vs-plugins\**\vs*.dll', recursive=True)]; print([n for n in ('ort','ncnn') if hasattr(c,n)])" }
Check 'ORT DirectML session (BiRefNet)' { & $py -c @"
import onnxruntime as o, time
t=time.time()
s=o.InferenceSession(r'$rt\models\birefnet\birefnet_fp16.onnx', providers=['DmlExecutionProvider','CPUExecutionProvider'])
print('providers', s.get_providers(), 'inputs', [(i.name,i.shape,i.type) for i in s.get_inputs()], 'outputs', [(i.name,i.shape,i.type) for i in s.get_outputs()], round(time.time()-t,1),'s')
"@ }
if ($fail) { Write-Host "$fail smoke test(s) failed" } else { Write-Host 'all smoke tests passed' }
exit 0
