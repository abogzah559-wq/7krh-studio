import os, time, numpy as np, onnxruntime as ort
from PIL import Image
os.makedirs('out', exist_ok=True)
MOD = [  # name, file, size, mean, std, post
 ('general', 'm/general.onnx', 1024, (0.485,0.456,0.406), (0.229,0.224,0.225), 'sig'),
 ('matting', 'm/BiRefNet-matting-epoch_100.onnx', 1024, (0.485,0.456,0.406), (0.229,0.224,0.225), 'sig'),
 ('hr', 'm/BiRefNet_HR-general-epoch_130.onnx', 2048, (0.485,0.456,0.406), (0.229,0.224,0.225), 'sig'),
 ('hrmat', 'm/BiRefNet_HR-matting-epoch_135.onnx', 2048, (0.485,0.456,0.406), (0.229,0.224,0.225), 'sig'),
 ('anime', 'm/anime.onnx', 1024, (0.485,0.456,0.406), (1,1,1), 'mm'),
]
for name, f, S, mean, std, post in MOD:
    try:
        s = ort.InferenceSession(f, providers=['CPUExecutionProvider'])
        i0 = s.get_inputs()[0]; print(name, i0.name, i0.shape, i0.type, [o.shape for o in s.get_outputs()], flush=True)
        shp = i0.shape
        if isinstance(shp[2], int): S = shp[2]
    except Exception as e:
        print('LOAD FAIL', name, e, flush=True); continue
    for fn in sorted(os.listdir('in')):
        im = Image.open('in/'+fn).convert('RGB')
        x = np.asarray(im.resize((S,S), Image.BICUBIC), np.float32)/255.
        x = ((x-np.array(mean,np.float32))/np.array(std,np.float32)).transpose(2,0,1)[None].astype(np.float32)
        t = time.time()
        try: y = s.run(None, {i0.name: x})[-1 if name!='anime' else 0]
        except Exception as e: print('RUN FAIL', name, fn, e, flush=True); break
        y = np.asarray(y, np.float32).reshape(-1, y.shape[-2], y.shape[-1])[0]
        if post == 'sig': y = 1/(1+np.exp(-y))
        else: y = (y-y.min())/(y.max()-y.min()+1e-6)
        Image.fromarray((np.clip(y,0,1)*255).astype(np.uint8)).resize(im.size, Image.BICUBIC).save(f'out/{fn[:-4]}.{name}.png')
        print(name, fn, round(time.time()-t,1), 's', flush=True)
