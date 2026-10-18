"""7krh Studio — lists the graphics cards the way each AI API numbers them.
DirectML (ONNX Runtime, vs-mlrt ORT) uses the DXGI adapter index, ncnn/RIFE use the Vulkan physical-device
index, TensorRT uses the CUDA index (PCI bus order, set by the app). On PCs with two GPUs these differ,
so the app matches the card the user picked by name in every list.
Pure ctypes, no extra packages. Prints one JSON line. Never raises: missing APIs give empty lists."""
import ctypes, json, sys

out = {'dxgi': [], 'vulkan': [], 'errors': []}

# ---------------------------------------------------------------- DXGI (DirectML device_id)
try:
    from ctypes import wintypes

    class GUID(ctypes.Structure):
        _fields_ = [('Data1', ctypes.c_uint32), ('Data2', ctypes.c_uint16), ('Data3', ctypes.c_uint16), ('Data4', ctypes.c_ubyte * 8)]

    class LUID(ctypes.Structure):
        _fields_ = [('LowPart', ctypes.c_uint32), ('HighPart', ctypes.c_int32)]

    class DXGI_ADAPTER_DESC1(ctypes.Structure):
        _fields_ = [('Description', ctypes.c_wchar * 128), ('VendorId', ctypes.c_uint), ('DeviceId', ctypes.c_uint),
                    ('SubSysId', ctypes.c_uint), ('Revision', ctypes.c_uint), ('DedicatedVideoMemory', ctypes.c_size_t),
                    ('DedicatedSystemMemory', ctypes.c_size_t), ('SharedSystemMemory', ctypes.c_size_t), ('AdapterLuid', LUID),
                    ('Flags', ctypes.c_uint)]

    IID_IDXGIFactory1 = GUID(0x770aae78, 0xf26f, 0x4dba, (ctypes.c_ubyte * 8)(0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87))
    dxgi = ctypes.WinDLL('dxgi')
    fac = ctypes.c_void_p()
    dxgi.CreateDXGIFactory1.argtypes = (ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p))
    hr = dxgi.CreateDXGIFactory1(ctypes.byref(IID_IDXGIFactory1), ctypes.byref(fac))
    if hr != 0:
        raise OSError('CreateDXGIFactory1 0x%08x' % (hr & 0xffffffff))

    def vcall(obj, idx, restype, argtypes, *args):
        vt = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        f = ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)(vt[idx])
        return f(obj, *args)

    i = 0
    while i < 16:
        ad = ctypes.c_void_p()
        hr = vcall(fac, 12, ctypes.c_long, (ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p)), i, ctypes.byref(ad))  # IDXGIFactory1::EnumAdapters1
        if hr != 0:
            break
        d = DXGI_ADAPTER_DESC1()
        vcall(ad, 10, ctypes.c_long, (ctypes.POINTER(DXGI_ADAPTER_DESC1),), ctypes.byref(d))  # IDXGIAdapter1::GetDesc1
        vcall(ad, 2, ctypes.c_ulong, ())  # Release
        out['dxgi'].append({'index': i, 'name': d.Description, 'vendor': d.VendorId, 'vramMB': int(d.DedicatedVideoMemory // 1048576),
                            'software': bool(d.Flags & 2)})
        i += 1
    vcall(fac, 2, ctypes.c_ulong, ())
except Exception as e:  # noqa: BLE001
    out['errors'].append('dxgi: %s' % e)

# ---------------------------------------------------------------- Vulkan (ncnn / RIFE gpu_id)
try:
    vk = ctypes.WinDLL('vulkan-1') if sys.platform == 'win32' else ctypes.CDLL('libvulkan.so.1')

    class VkApplicationInfo(ctypes.Structure):
        _fields_ = [('sType', ctypes.c_int), ('pNext', ctypes.c_void_p), ('pApplicationName', ctypes.c_char_p), ('applicationVersion', ctypes.c_uint32),
                    ('pEngineName', ctypes.c_char_p), ('engineVersion', ctypes.c_uint32), ('apiVersion', ctypes.c_uint32)]

    class VkInstanceCreateInfo(ctypes.Structure):
        _fields_ = [('sType', ctypes.c_int), ('pNext', ctypes.c_void_p), ('flags', ctypes.c_uint32), ('pApplicationInfo', ctypes.POINTER(VkApplicationInfo)),
                    ('enabledLayerCount', ctypes.c_uint32), ('ppEnabledLayerNames', ctypes.c_void_p),
                    ('enabledExtensionCount', ctypes.c_uint32), ('ppEnabledExtensionNames', ctypes.c_void_p)]

    app = VkApplicationInfo(0, None, b'7krh', 1, b'7krh', 1, (1 << 22))
    ci = VkInstanceCreateInfo(1, None, 0, ctypes.pointer(app), 0, None, 0, None)
    vk.vkCreateInstance.argtypes = (ctypes.POINTER(VkInstanceCreateInfo), ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))
    vk.vkEnumeratePhysicalDevices.argtypes = (ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p)
    vk.vkGetPhysicalDeviceProperties.argtypes = (ctypes.c_void_p, ctypes.c_void_p)
    vk.vkDestroyInstance.argtypes = (ctypes.c_void_p, ctypes.c_void_p)
    inst = ctypes.c_void_p()
    r = vk.vkCreateInstance(ctypes.byref(ci), None, ctypes.byref(inst))
    if r != 0:
        raise OSError('vkCreateInstance %d' % r)
    n = ctypes.c_uint32(0)
    vk.vkEnumeratePhysicalDevices(inst, ctypes.byref(n), None)
    devs = (ctypes.c_void_p * n.value)()
    vk.vkEnumeratePhysicalDevices(inst, ctypes.byref(n), devs)
    for i in range(n.value):
        props = (ctypes.c_ubyte * 1024)()
        vk.vkGetPhysicalDeviceProperties(ctypes.c_void_p(devs[i]), props)
        raw = bytes(props)
        name = raw[20:276].split(b'\0', 1)[0].decode('utf-8', 'replace')
        dtype = int.from_bytes(raw[16:20], 'little')  # 1 integrated, 2 discrete, 3 virtual, 4 cpu
        out['vulkan'].append({'index': i, 'name': name, 'type': {1: 'integrated', 2: 'discrete', 3: 'virtual', 4: 'cpu'}.get(dtype, 'other')})
    vk.vkDestroyInstance(inst, None)
except Exception as e:  # noqa: BLE001
    out['errors'].append('vulkan: %s' % e)

print(json.dumps(out))
