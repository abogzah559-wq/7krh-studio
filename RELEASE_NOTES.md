# 7krh Studio 0.3.2

- إصلاح TensorRT: كانت حزمة onnx التي يحتاجها ناقصة من المحرك، فكان يفشل دائمًا.
- إذا فشل محرك الذكاء (TensorRT أو Vulkan) أثناء التصدير أو المعاينة، يُعاد العمل تلقائيًا على DirectML مع تنبيه.

# 7krh Studio 0.3.1

- إصلاح اختبار الأداء: كان يظهر «فشل» لكل محركات الفيديو بسبب خطأ في مقطع الاختبار نفسه، والمحركات سليمة. أعد تشغيل الاختبار من الإعدادات.
- حجم FFmpeg يُحسب كاملًا في مدير المحركات.

## 0.3.0

- **Montage**: a real multi-track timeline (video, overlay, text, music and voice tracks). You can split, trim, move, ripple-delete, duplicate, change speed, play clips in reverse, separate audio, copy and paste effects, and use undo/redo. Keyframes work on position, scale, rotation, opacity and volume. There are seven transitions and Arabic and English text layers. Subtitles import from SRT/ASS and export to SRT. Projects save to `.7krh` files, autosave, and are restored after a crash.
- **Preview = export**: the preview and the exported file run on the same timeline and colour maths. A test renders the same frames both ways and compares their pixels.
- **Platform delivery identical to the website tool**: the TikTok disguise uses Krypton or PATCH with an auto, to-30, ×2, ×4 or ×6 factor. Instagram and YouTube get a stream copy. A "No re-encoding" mode is included, and every result's duration is checked afterwards.
- **Exports**: MP4, MOV and WebM with H.264, HEVC, AV1 and VP9. You can choose constant quality or a target bitrate, loudness normalisation, and soft subtitles. Exports run one at a time, and every finished file is checked: it must decode to the end and its duration, size and audio must be correct.
- **GPU**: cards are matched by name across DirectML, Vulkan and TensorRT. A "GPU only" mode is available. The image engine no longer falls back to the processor silently. The performance test only runs when you start it and now includes one complete real export.
- **Images**: an automatic model suggestion, ×2/×3/×4 scaling, AI strength, keep or strip ICC/EXIF, and transparency kept for PNG/WebP. Tiles retry at a smaller size when the card runs out of memory.
- **Audio tool**: RNNoise AI voice cleaning, fades, −14 LUFS loudness, and MP3/M4A/WAV/FLAC output.
- **New interface** in the 7krh website's style, with a "Buy me a coffee" button that opens the website's support page.
- **Removed**: background removal, including the BiRefNet model.## 0.3.3
- TensorRT (NVIDIA): ships onnxconverter-common, which vs-mlrt needs to convert the model to FP16 before building the engine (0.3.2 stopped at "No module named 'modelopt'"). The CI now runs that exact conversion.
- Title bar: stays clear of the window buttons on whichever side Windows draws them (the app name was cut off in Arabic).
- TikTok: the hint now says plainly that the stretched file plays slowed down on a computer, as on the website.


