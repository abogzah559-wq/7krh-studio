"""7krh Studio — image engine.
Long-lived process that keeps ONNX models on the GPU (DirectML) and answers JSON-line requests:
  {"id":1,"op":"init"}
  {"id":2,"op":"analyze","src":"in.jpg"}                                -> image facts + suggested model
  {"id":3,"op":"upscale","src":"in.jpg","out":"out.png","model":"photo|real|anime","scale":4,
   "strength":1.0,"meta":"keep|strip","quality":95}
  {"id":4,"op":"bench"}
Replies: {"id":..,"ok":true,...} or {"id":..,"ok":false,"err":".."}; progress: {"id":..,"progress":0.4}

GPU policy: the GPU (DirectML) is always tried first. If it fails, the engine steps down to DirectML without
graph fusion, and only then to the CPU — unless "gpu_only" is set, in which case the error is reported instead
of silently running on the CPU. Every reply says which device really did the work.
"""
import sys, os, json, time, traceback, io
import numpy as np
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 400_000_000
os.environ.setdefault('ORT_LOGGING_LEVEL', '3')
import onnxruntime as ort  # noqa: E402

ort.set_default_logger_severity(3)
MANIFEST = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
DEVICE = int(MANIFEST.get('device', 0))
GPU_ONLY = bool(MANIFEST.get('gpu_only', False))
FORCE_CPU = bool(MANIFEST.get('cpu', False))  # tests on machines without a GPU
_sessions = {}
_modes = {}
_out = sys.stdout


class GpuOnlyError(RuntimeError):
    pass


def send(o):
    _out.write(json.dumps(o) + '\n')
    _out.flush()


def has_dml():
    return 'DmlExecutionProvider' in ort.get_available_providers()


def _make(path, mode):
    """mode: 'dml' (all graph fusions), 'dml-safe' (no fusions: avoids DirectML fused-node failures on some
    drivers/models), 'cpu'."""
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    provs = []
    if mode.startswith('dml'):
        if not has_dml():
            raise RuntimeError('DirectML is not available in this ONNX Runtime build')
        provs.append(('DmlExecutionProvider', {'device_id': DEVICE}))
        opts.enable_mem_pattern = False
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        opts.graph_optimization_level = (ort.GraphOptimizationLevel.ORT_ENABLE_ALL if mode == 'dml'
                                         else ort.GraphOptimizationLevel.ORT_ENABLE_BASIC)
        if mode == 'dml-safe':
            opts.add_session_config_entry('ep.dml.disable_graph_fusion', '1')
    else:
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    provs.append('CPUExecutionProvider')
    s = ort.InferenceSession(path, sess_options=opts, providers=provs)
    if mode.startswith('dml') and s.get_providers()[0] != 'DmlExecutionProvider':
        raise RuntimeError('DirectML session could not be created on device %d' % DEVICE)
    return s


def _next(mode):
    if mode == 'dml':
        return 'dml-safe'
    if GPU_ONLY:
        return None
    return 'cpu'


def session(path):
    s = _sessions.get(path)
    if s is not None:
        return s
    mode = _modes.get(path, 'cpu' if FORCE_CPU else 'dml')
    last = None
    while mode:
        try:
            s = _make(path, mode)
            break
        except Exception as e:  # noqa: BLE001
            last = e
            sys.stderr.write(f'{os.path.basename(path)}: {mode} could not start ({str(e)[:200]})\n')
            mode = _next(mode)
    if s is None:
        raise GpuOnlyError('GPU-only mode: the graphics card could not run this model (%s)' % str(last)[:300])
    _modes[path] = mode
    _sessions[path] = s
    return s


def device_of(path):
    m = _modes.get(path, '')
    return 'gpu' if m.startswith('dml') else 'cpu'


def run(path, feeds):
    """Runs a model, stepping down dml -> dml-safe -> cpu (never to cpu in GPU-only mode)."""
    while True:
        s = session(path)
        try:
            return s.run(None, feeds)
        except Exception as e:  # noqa: BLE001
            mode = _modes.get(path, 'dml')
            if is_oom(e):
                raise
            nxt = None if mode == 'cpu' else _next(mode)
            if nxt is None:
                if mode != 'cpu' and GPU_ONLY:
                    raise GpuOnlyError('GPU-only mode: the graphics card failed (%s)' % str(e)[:300])
                raise
            sys.stderr.write(f'{os.path.basename(path)}: {mode} failed ({str(e)[:200]}), trying {nxt}\n')
            _sessions.pop(path, None)
            _modes[path] = nxt


def is_oom(e):
    s = str(e).lower()
    return 'out of memory' in s or 'e_outofmemory' in s or '887a0005' in s or 'not enough memory' in s or '0x8007000e' in s


# ---------------------------------------------------------------- loading / saving
def load(src):
    im = Image.open(src)
    meta = {'icc': im.info.get('icc_profile'), 'exif': None, 'format': im.format, 'mode': im.mode}
    im = ImageOps.exif_transpose(im)  # pixels upright first; Pillow drops the orientation tag from the copy
    try:
        ex = im.getexif()
        if ex:
            if 0x0112 in ex:
                ex[0x0112] = 1
            meta['exif'] = ex.tobytes()
    except Exception:  # noqa: BLE001
        pass
    alpha = None
    if im.mode in ('RGBA', 'LA', 'PA') or (im.mode == 'P' and 'transparency' in im.info):
        im = im.convert('RGBA')
        a = im.getchannel('A')
        if a.getextrema()[0] < 255:
            alpha = a
    return im.convert('RGB'), alpha, meta


def save(img, out, meta, keep_meta, quality):
    ext = os.path.splitext(out)[1].lower()
    kw = {}
    if keep_meta:
        if meta.get('icc'):
            kw['icc_profile'] = meta['icc']
        if meta.get('exif') and ext in ('.jpg', '.jpeg', '.webp', '.png'):
            kw['exif'] = meta['exif']
    tmp = out + '.part'
    if ext in ('.jpg', '.jpeg'):
        img.convert('RGB').save(tmp, format='JPEG', quality=int(quality), subsampling=0, optimize=True, **kw)
    elif ext == '.webp':
        img.save(tmp, format='WEBP', quality=int(quality), method=5, **kw)
    else:
        img.save(tmp, format='PNG', compress_level=3, **kw)
    os.replace(tmp, out)
    return os.path.getsize(out)


# ---------------------------------------------------------------- analysis (suggests a model; the user decides)
def analyze_img(im):
    """Cheap measurements on a 256 px copy: drawings/anime have large flat areas and few colours;
    photos have noise everywhere. Returns facts and a suggestion, never a hidden decision."""
    w, h = im.size
    small = np.asarray(im.resize((256, max(1, round(256 * h / w))), Image.BILINEAR), dtype=np.float32)
    g = small.mean(axis=2)
    dx = np.abs(np.diff(g, axis=1))
    dy = np.abs(np.diff(g, axis=0))
    flat = float(((dx[:-1, :] < 1.5) & (dy[:, :-1] < 1.5)).mean())
    q = (small // 16).astype(np.int32)
    colours = len(np.unique(q[..., 0] * 256 + q[..., 1] * 16 + q[..., 2]))
    noise = float(np.median(np.abs(g[1:-1, 1:-1] * 4 - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:])))
    drawing = flat > 0.55 and colours < 900
    return {'w': w, 'h': h, 'flat': round(flat, 3), 'colours': colours, 'noise': round(noise, 2),
            'suggest': 'anime' if drawing else 'photo'}


def op_analyze(req):
    im, alpha, meta = load(req['src'])
    r = analyze_img(im)
    r.update({'alpha': alpha is not None, 'icc': bool(meta.get('icc')), 'exif': bool(meta.get('exif')), 'format': meta.get('format'),
              'bytes': os.path.getsize(req['src'])})
    return r


# ---------------------------------------------------------------- image upscale (tiled, memory-bounded)
MODEL_KEY = {'photo': 'photo_x4', 'real': 'real_x4', 'anime': 'anime_x4'}


def op_upscale(req):
    t0 = time.time()
    model = req.get('model', 'photo')
    im, alpha, meta = load(req['src'])
    if model == 'auto':
        model = analyze_img(im)['suggest']
    key = MODEL_KEY.get(model, 'photo_x4')
    path = MANIFEST[key]
    s = session(path)
    W, H = im.size
    scale = max(1, min(4, int(req.get('scale', 4))))
    strength = float(np.clip(float(req.get('strength', 1.0)), 0.0, 1.0))
    net = 4
    x = np.asarray(im, dtype=np.float32) / 255.0
    base = im.resize((W * scale, H * scale), Image.LANCZOS) if strength < 0.999 else None
    tile = int(req.get('tile', 384 if key == 'photo_x4' else 640))
    pad = 24 if key == 'photo_x4' else 16
    out = np.zeros((H * scale, W * scale, 3), np.uint8)  # final size only: memory grows with the result, not 16x the input
    inp = s.get_inputs()[0]
    half = 'float16' in inp.type
    while True:
        try:
            ny, nx = (H + tile - 1) // tile, (W + tile - 1) // tile
            n, total = 0, ny * nx
            for ty in range(ny):
                for tx in range(nx):
                    y0, x0 = ty * tile, tx * tile
                    y1, x1 = min(H, y0 + tile), min(W, x0 + tile)
                    py0, px0 = max(0, y0 - pad), max(0, x0 - pad)
                    py1, px1 = min(H, y1 + pad), min(W, x1 + pad)
                    t = x[py0:py1, px0:px1].transpose(2, 0, 1)[None]
                    if half:
                        t = t.astype(np.float16)
                    r = run(path, {inp.name: np.ascontiguousarray(t)})[0][0].astype(np.float32).transpose(1, 2, 0)
                    r = (np.clip(r, 0, 1) * 255 + 0.5).astype(np.uint8)
                    if scale != net:
                        ph, pw = py1 - py0, px1 - px0
                        r = np.asarray(Image.fromarray(r).resize((pw * scale, ph * scale), Image.LANCZOS))
                    oy, ox = (y0 - py0) * scale, (x0 - px0) * scale
                    blk = r[oy:oy + (y1 - y0) * scale, ox:ox + (x1 - x0) * scale]
                    if base is not None:
                        b = np.asarray(base.crop((x0 * scale, y0 * scale, x1 * scale, y1 * scale)), dtype=np.float32)
                        blk = (b * (1 - strength) + blk.astype(np.float32) * strength + 0.5).astype(np.uint8)
                    out[y0 * scale:y1 * scale, x0 * scale:x1 * scale] = blk
                    n += 1
                    send({'id': req['id'], 'progress': n / total})
            break
        except Exception as e:  # noqa: BLE001
            if is_oom(e) and tile > 96:
                tile = max(96, tile // 2)  # out of video memory: smaller tiles, same result
                sys.stderr.write(f'out of memory, retrying with tile {tile}\n')
                continue
            raise
    img = Image.fromarray(out)
    ext = os.path.splitext(req['out'])[1].lower()
    if alpha is not None and ext in ('.png', '.webp'):
        img.putalpha(alpha.resize(img.size, Image.LANCZOS))
    size = save(img, req['out'], meta, req.get('meta', 'keep') == 'keep', req.get('quality', 95))
    return {'w': img.size[0], 'h': img.size[1], 'inW': W, 'inH': H, 'ms': int((time.time() - t0) * 1000), 'bytes': size,
            'model': model, 'device': device_of(path), 'provider': s.get_providers()[0], 'mode': _modes.get(path),
            'tile': tile, 'alphaKept': alpha is not None and ext in ('.png', '.webp'), 'alphaDropped': alpha is not None and ext not in ('.png', '.webp')}


def op_init(req):
    return {'providers': ort.get_available_providers(), 'version': ort.__version__, 'dml': has_dml(), 'gpu_only': GPU_ONLY}


def op_bench(req):
    """Measures the image models on this PC (Settings > Diagnostics). Times include host<->GPU copies."""
    res = {}
    for key, shape, reps in (('real_x4', (1, 3, 540, 960), 5), ('photo_x4', (1, 3, 384, 384), 3)):
        p = MANIFEST.get(key)
        if not p:
            continue
        try:
            s = session(p)
            i = s.get_inputs()[0]
            y = np.random.rand(*shape).astype(np.float16 if 'float16' in i.type else np.float32)
            run(p, {i.name: y})
            t = time.time()
            for _ in range(reps):
                run(p, {i.name: y})
            dt = (time.time() - t) / reps
            res[key + '_ms'] = int(dt * 1000)
            res[key + '_device'] = device_of(p) + ' (' + str(_modes.get(p)) + ')'
        except Exception as e:  # noqa: BLE001
            res[key + '_error'] = str(e)[:300]
    if 'real_x4_ms' in res:
        res['esrgan_960x540_fps'] = round(1000 / max(1, res['real_x4_ms']), 2)
    res['provider'] = res.get('real_x4_device', '')
    return res


OPS = {'init': op_init, 'analyze': op_analyze, 'upscale': op_upscale, 'bench': op_bench}


def main():
    send({'ready': True, 'providers': ort.get_available_providers(), 'dml': has_dml()})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        try:
            r = OPS[req['op']](req)
            r.update({'id': req.get('id'), 'ok': True})
            send(r)
        except Exception as e:  # noqa: BLE001
            send({'id': req.get('id'), 'ok': False, 'err': f'{type(e).__name__}: {e}', 'gpuOnly': isinstance(e, GpuOnlyError),
                  'oom': is_oom(e), 'trace': traceback.format_exc()[-1500:]})


if __name__ == '__main__':
    main()
