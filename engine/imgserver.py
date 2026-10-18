"""7krh Studio — image engine.
Long-lived process that keeps ONNX models on the GPU (DirectML) and answers JSON-line requests:
  {"id":1,"op":"init"}
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


def _make(path, mode):
    """mode: 'dml' (all graph fusions), 'dml-safe' (no fusions: avoids DirectML fused-node failures on some
    drivers/models), 'cpu'."""
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    provs = []
    if mode.startswith('dml') and 'DmlExecutionProvider' in ort.get_available_providers():
        provs.append(('DmlExecutionProvider', {'device_id': DEVICE}))
        opts.enable_mem_pattern = False
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        opts.graph_optimization_level = (ort.GraphOptimizationLevel.ORT_ENABLE_ALL if mode == 'dml'
                                         else ort.GraphOptimizationLevel.ORT_ENABLE_BASIC)
        if mode == 'dml-safe':
            # run the model as many small DirectML ops instead of one fused graph (some drivers fail on fused nodes)
            opts.add_session_config_entry('ep.dml.disable_graph_fusion', '1')
    else:
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    provs.append('CPUExecutionProvider')
    return ort.InferenceSession(path, sess_options=opts, providers=provs)


_modes = {}


def session(path):
    s = _sessions.get(path)
    if s is None:
        mode = _modes.get(path, 'dml')
        try:
            s = _make(path, mode)
        except Exception:
            mode = 'dml-safe' if mode == 'dml' else 'cpu'
            s = _make(path, mode)
        _modes[path] = mode
        _sessions[path] = s
    return s


def run(path, feeds):
    """Runs a model, stepping down dml -> dml-safe -> cpu if the GPU path fails, and remembers what worked."""
    while True:
        s = session(path)
        try:
            return s.run(None, feeds)
        except Exception as e:
            mode = _modes.get(path, 'dml')
            if mode == 'cpu':
                raise
            nxt = 'dml-safe' if mode == 'dml' else 'cpu'
            sys.stderr.write(f'{os.path.basename(path)}: {mode} failed ({str(e)[:200]}), trying {nxt}\n')
            _sessions.pop(path, None)
            _modes[path] = nxt


def load_rgb(src):
    im = Image.open(src)
    im = ImageOps.exif_transpose(im)
    alpha = im.getchannel('A') if im.mode in ('RGBA', 'LA', 'PA') else None
    return im.convert('RGB'), alpha


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
            r = run(MANIFEST[key], {inp.name: np.ascontiguousarray(t)})[0][0].astype(np.float32).transpose(1, 2, 0)
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
    """Measures Real-ESRGAN throughput on this PC (Settings > Diagnostics)."""
    res = {}
    for key in ('real_x4', 'photo_x4'):
        path = MANIFEST.get(key)
        if not path or not os.path.exists(path):
            continue
        s = session(path)
        i = s.get_inputs()[0]
        h, w = (540, 960) if key == 'real_x4' else (256, 256)
        y = np.random.rand(1, 3, h, w).astype(np.float16 if 'float16' in i.type else np.float32)
        run(path, {i.name: y})
        t = time.time()
        for _ in range(3):
            run(path, {i.name: y})
        res[key + '_%dx%d_ms' % (w, h)] = int((time.time() - t) / 3 * 1000)
        res[key + '_provider'] = session(path).get_providers()[0] + ' / ' + _modes.get(path, '')
    return res


OPS = {'init': op_init, 'upscale': op_upscale, 'bench': op_bench}


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
