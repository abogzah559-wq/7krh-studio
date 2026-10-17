"""7krh Studio — image engine.
Long-lived process that keeps ONNX models on the GPU (DirectML) and answers JSON-line requests:
  {"id":1,"op":"init"}
  {"id":2,"op":"bg","src":"in.jpg","mask":"out_mask.png"}                 -> background removal mask (BiRefNet)
  {"id":3,"op":"upscale","src":"in.jpg","out":"out.png","model":"photo|real|anime","scale":4}
Replies: {"id":..,"ok":true,...} or {"id":..,"ok":false,"err":".."}; progress: {"id":..,"progress":0.4}
"""
import sys, os, json, time, traceback
import numpy as np
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 400_000_000
os.environ.setdefault('ORT_LOGGING_LEVEL', '3')
import onnxruntime as ort  # noqa: E402

ort.set_default_logger_severity(3)
MANIFEST = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
DEVICE = int(MANIFEST.get('device', 0))
_sessions = {}
_out = sys.stdout


def send(o):
    _out.write(json.dumps(o) + '\n')
    _out.flush()


def session(path):
    s = _sessions.get(path)
    if s is None:
        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        provs = []
        if 'DmlExecutionProvider' in ort.get_available_providers():
            provs.append(('DmlExecutionProvider', {'device_id': DEVICE}))
            opts.enable_mem_pattern = False
            opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        provs.append('CPUExecutionProvider')
        s = ort.InferenceSession(path, sess_options=opts, providers=provs)
        _sessions[path] = s
    return s


def load_rgb(src):
    im = Image.open(src)
    im = ImageOps.exif_transpose(im)
    alpha = im.getchannel('A') if im.mode in ('RGBA', 'LA', 'PA') else None
    return im.convert('RGB'), alpha


# ---------------------------------------------------------------- background removal
def box(a, r):
    """Mean filter with an integral image (edge-clamped), float32."""
    h, w = a.shape
    p = np.pad(a, ((r + 1, r), (r + 1, r)), mode='edge').astype(np.float64)
    c = p.cumsum(0).cumsum(1)
    s = c[2 * r + 1:, 2 * r + 1:] - c[:-2 * r - 1, 2 * r + 1:] - c[2 * r + 1:, :-2 * r - 1] + c[:-2 * r - 1, :-2 * r - 1]
    return (s / ((2 * r + 1) ** 2)).astype(np.float32)


def guided(I, p, r, eps):
    """Guided filter (He et al.): snaps the soft AI matte to the real edges of the photo."""
    mI, mp = box(I, r), box(p, r)
    cov = box(I * p, r) - mI * mp
    var = box(I * I, r) - mI * mI
    a = cov / (var + eps)
    b = mp - a * mI
    q = box(a, r) * I + box(b, r)
    return np.clip(q, 0, 1)


def op_bg(req):
    t0 = time.time()
    path = MANIFEST['birefnet']
    s = session(path)
    im, src_alpha = load_rgb(req['src'])
    W, H = im.size
    x = np.asarray(im.resize((1024, 1024), Image.BICUBIC), dtype=np.float32) / 255.0
    x = (x - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([0.229, 0.224, 0.225], np.float32)
    x = x.transpose(2, 0, 1)[None]
    inp = s.get_inputs()[0]
    if 'float16' in inp.type:
        x = x.astype(np.float16)
    y = s.run(None, {inp.name: x})[0].astype(np.float32)[0, 0]
    if y.min() < -0.01 or y.max() > 1.01:
        y = 1.0 / (1.0 + np.exp(-y))
    m = Image.fromarray((np.clip(y, 0, 1) * 255).astype(np.uint8)).resize((W, H), Image.BICUBIC)
    a = np.asarray(m, dtype=np.float32) / 255.0
    if req.get('refine', True):
        # refine at up to 2048 px on the long side, then scale to full size
        k = min(1.0, 2048.0 / max(W, H))
        gw, gh = max(1, int(W * k)), max(1, int(H * k))
        g = np.asarray(im.resize((gw, gh), Image.BILINEAR).convert('L'), dtype=np.float32) / 255.0
        pa = np.asarray(Image.fromarray((a * 255).astype(np.uint8)).resize((gw, gh), Image.BILINEAR), dtype=np.float32) / 255.0
        r = max(2, round(max(gw, gh) / 420))
        q = guided(g, pa, r, 6e-4)
        mp = box(pa, r)
        wgt = np.clip(np.minimum(mp, 1 - mp) * 6, 0, 1)
        band = (mp > 0.015) & (mp < 0.985)
        ref = np.where(band, q * wgt + pa * (1 - wgt), pa)
        a = np.asarray(Image.fromarray((ref * 255).astype(np.uint8)).resize((W, H), Image.BICUBIC), dtype=np.float32) / 255.0
    if src_alpha is not None:
        a = a * (np.asarray(src_alpha, dtype=np.float32) / 255.0)
    Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8), 'L').save(req['mask'], compress_level=1)
    return {'w': W, 'h': H, 'ms': int((time.time() - t0) * 1000), 'provider': s.get_providers()[0]}


# ---------------------------------------------------------------- image upscale (tiled)
def op_upscale(req):
    t0 = time.time()
    key = {'photo': 'photo_x4', 'real': 'real_x4', 'anime': 'anime_x4'}.get(req.get('model', 'photo'), 'photo_x4')
    s = session(MANIFEST[key])
    im, src_alpha = load_rgb(req['src'])
    W, H = im.size
    scale = int(req.get('scale', 4))
    net = 4
    x = np.asarray(im, dtype=np.float32) / 255.0
    tile = int(req.get('tile', 384 if key == 'photo_x4' else 640))
    pad = 16
    out = np.zeros((H * net, W * net, 3), np.float32)
    inp = s.get_inputs()[0]
    ny, nx = (H + tile - 1) // tile, (W + tile - 1) // tile
    n, total = 0, ny * nx
    for ty in range(ny):
        for tx in range(nx):
            y0, x0 = ty * tile, tx * tile
            y1, x1 = min(H, y0 + tile), min(W, x0 + tile)
            py0, px0 = max(0, y0 - pad), max(0, x0 - pad)
            py1, px1 = min(H, y1 + pad), min(W, x1 + pad)
            t = x[py0:py1, px0:px1].transpose(2, 0, 1)[None]
            if 'float16' in inp.type:
                t = t.astype(np.float16)
            r = s.run(None, {inp.name: np.ascontiguousarray(t)})[0][0].astype(np.float32).transpose(1, 2, 0)
            oy, ox = (y0 - py0) * net, (x0 - px0) * net
            out[y0 * net:y1 * net, x0 * net:x1 * net] = r[oy:oy + (y1 - y0) * net, ox:ox + (x1 - x0) * net]
            n += 1
            send({'id': req['id'], 'progress': n / total})
    img = Image.fromarray((np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8))
    if scale != net:
        img = img.resize((W * scale, H * scale), Image.LANCZOS)
    if src_alpha is not None:
        img.putalpha(src_alpha.resize(img.size, Image.LANCZOS))
    ext = os.path.splitext(req['out'])[1].lower()
    if ext in ('.jpg', '.jpeg'):
        img.convert('RGB').save(req['out'], quality=96, subsampling=0)
    elif ext == '.webp':
        img.save(req['out'], quality=96, method=5)
    else:
        img.save(req['out'], compress_level=3)
    return {'w': img.size[0], 'h': img.size[1], 'ms': int((time.time() - t0) * 1000), 'provider': s.get_providers()[0]}


def op_init(req):
    return {'providers': ort.get_available_providers(), 'version': ort.__version__}


def op_bench(req):
    """Measures the GPU on this PC: BiRefNet and Real-ESRGAN timings (used by Settings > Diagnostics)."""
    res = {}
    s = session(MANIFEST['birefnet'])
    inp = s.get_inputs()[0]
    x = np.random.rand(1, 3, 1024, 1024).astype(np.float16 if 'float16' in inp.type else np.float32)
    s.run(None, {inp.name: x})
    t = time.time()
    for _ in range(3):
        s.run(None, {inp.name: x})
    res['birefnet_ms'] = int((time.time() - t) / 3 * 1000)
    s2 = session(MANIFEST['real_x4'])
    i2 = s2.get_inputs()[0]
    y = np.random.rand(1, 3, 540, 960).astype(np.float32)
    s2.run(None, {i2.name: y})
    t = time.time()
    for _ in range(5):
        s2.run(None, {i2.name: y})
    res['esrgan_960x540_fps'] = round(5 / (time.time() - t), 2)
    res['provider'] = s.get_providers()[0]
    return res


OPS = {'init': op_init, 'bg': op_bg, 'upscale': op_upscale, 'bench': op_bench}


def main():
    send({'ready': True, 'providers': ort.get_available_providers()})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        try:
            r = OPS[req['op']](req)
            r.update({'id': req.get('id'), 'ok': True})
            send(r)
        except Exception as e:
            send({'id': req.get('id'), 'ok': False, 'err': f'{type(e).__name__}: {e}', 'trace': traceback.format_exc()[-1500:]})


if __name__ == '__main__':
    main()
