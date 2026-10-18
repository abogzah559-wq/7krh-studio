import os, sys, time, numpy as np, onnxruntime as ort
from PIL import Image
MOD = {
 'general': ('m/general.onnx', 1024, (0.485,0.456,0.406), (0.229,0.224,0.225), 'sig'),
 'matting': ('m/BiRefNet-matting-epoch_100.onnx', 1024, (0.485,0.456,0.406), (0.229,0.224,0.225), 'sig'),
 'hr': ('m/BiRefNet_HR-general-epoch_130.onnx', 2048, (0.485,0.456,0.406), (0.229,0.224,0.225), 'sig'),
 'hrmat': ('m/BiRefNet_HR-matting-epoch_135.onnx', 2048, (0.485,0.456,0.406), (0.229,0.224,0.225), 'sig'),
 'anime': ('m/anime.onnx', 1024, (0.485,0.456,0.406), (1,1,1), 'mm'),
}
name, fn = sys.argv[1], sys.argv[2]
f, S, mean, std, post = MOD[name]
so = ort.SessionOptions(); so.enable_cpu_mem_arena = False; so.enable_mem_pattern = False
s = ort.InferenceSession(f, so, providers=['CPUExecutionProvider'])
i0 = s.get_inputs()[0]
if isinstance(i0.shape[2], int): S = i0.shape[2]
print(name, os.path.basename(fn), i0.shape, flush=True)
im = Image.open(fn).convert('RGB')
x = np.asarray(im.resize((S,S), Image.BICUBIC), np.float32)/255.
x = ((x-np.array(mean,np.float32))/np.array(std,np.float32)).transpose(2,0,1)[None].astype(np.float32)
t = time.time()
outs = s.run(None, {i0.name: x})
y = outs[-1] if name != 'anime' else outs[0]
y = np.asarray(y, np.float32).reshape(-1, y.shape[-2], y.shape[-1])[0]
if post == 'sig': y = 1/(1+np.exp(-y))
else: y = (y-y.min())/(y.max()-y.min()+1e-6)
b = os.path.basename(fn)[:-4]
Image.fromarray((np.clip(y,0,1)*255).astype(np.uint8)).resize(im.size, Image.BICUBIC).save(f'out/{b}.{name}.png')
print('done', round(time.time()-t,1), 's', flush=True)
