<div align="center">

<img src="ui/img/logo-128.png" width="96" alt="7krh Studio">

# 7krh Studio

**مونتاج وتحسين فيديو وصور بالذكاء الاصطناعي — على جهازك وبقوة كرت الشاشة**

[⬇️ تحميل النسخة 0.3.3 (Windows)](https://github.com/abogzah559-wq/7krh-studio/releases/download/v0.3.3-beta/7krh-Studio-Setup-0.3.3.exe) · [الإصدارات](https://github.com/abogzah559-wq/7krh-studio/releases) · [الموقع](https://7krh-hub.pages.dev/ar/) · [☕ اشترِ لي كوب قهوة](https://7krh-hub.pages.dev/ar/support/)

</div>

---

## المميزات

### 🎬 المونتاج
- خط زمني حقيقي متعدد المسارات: فيديو وتراكبات ونصوص وموسيقى وتعليق صوتي.
- قص وتقسيم وسحب وتكرار وحذف مع إغلاق الفراغ أو بدونه، وتراجع وإعادة.
- السرعة والتشغيل العكسي وفصل الصوت عن الفيديو ونسخ التأثيرات ولصقها.
- إطارات مفتاحية للموضع والحجم والدوران والشفافية والصوت، و7 انتقالات.
- نصوص عربية وإنجليزية بتشكيل صحيح، واستيراد ترجمة SRT / ASS وتصدير SRT.
- خفض الموسيقى تلقائيًا تحت الكلام، وإزالة ضوضاء الكلام بالذكاء الاصطناعي (RNNoise).
- حفظ المشاريع بصيغة `.7krh`، وحفظ تلقائي، واستعادة بعد التعطل.
- **المعاينة تطابق التصدير**: الاثنان يعتمدان على الحسابات نفسها، ويتحقق اختبار آلي من ذلك بمقارنة البكسلات.

### ✨ تحسين الفيديو
- رفع الدقة حتى 4K بـ Real-ESRGAN عبر TensorRT أو DirectML أو Vulkan، ويُختار الأسرع حسب القياس على جهازك.
- توليد الإطارات حتى 120 بـ RIFE 4.26، مع اكتشاف تغيّر المشهد.
- ترميز عتادي بـ NVENC / AMF / QSV، ومعاينة الذكاء على إطار واحد قبل التصدير.

### 📤 التصدير للمنصات (مطابق لخدمة الجودة الأصلية في الموقع)
- **تيك توك**: تمويه الإطارات بطريقة Krypton أو PATCH، مع معامل تلقائي أو إلى 30 أو ×2 / ×4 / ×6.
- **إنستغرام ويوتيوب**: نسخ كما هو، أو وضع «بدون إعادة ترميز».
- صيغ MP4 / MOV / WebM، وترميز H.264 / HEVC / AV1 / VP9، وفحص كل ملف بعد التصدير.

### 🖼️ تحسين الصور
- Real-ESRGAN بنماذج للصور والأنمي، وتكبير ×2 / ×3 / ×4، ومعالجة دفعية.
- قوة التحسين قابلة للتعديل، ومقارنة قبل/بعد مع تكبير حقيقي.
- حفظ الشفافية وملف الألوان وEXIF، أو حذفها للخصوصية.

### 🎧 الصوت
- تنقية الكلام والتلاشي وتوحيد مستوى الصوت (−14 LUFS)، والتحويل إلى MP3 / M4A / WAV / FLAC.

## المتطلبات
- Windows 10 / 11 (64-bit).
- كرت شاشة يدعم DirectX 12 للذكاء الاصطناعي. كروت NVIDIA RTX تحصل على TensorRT، وهو الأسرع.
- لا يحتاج إنترنت، ولا تُرفع ملفاتك إلى أي خادم.

## بعد التثبيت
افتح **الإعدادات ← اختبار الأداء** مرة واحدة. يقيس البرنامج كل محرك على كرتك، فيختار الأسرع ويعرض أوقاتًا حقيقية.

---

## English

**7krh Studio** is a Windows desktop editor that runs entirely on your PC. It combines a multi-track timeline (keyframes, transitions, Arabic/English text, subtitles, ducking, AI voice denoise), AI video upscaling to 4K (Real-ESRGAN via TensorRT, DirectML or Vulkan), AI frame generation up to 120 fps (RIFE), batch AI image upscaling, and platform delivery identical to the 7krh website's original-quality tool (TikTok Krypton/PATCH disguise, Instagram, YouTube). The preview and the export run on the same maths, and every exported file is checked after encoding.

[Download 0.3.3 for Windows](https://github.com/abogzah559-wq/7krh-studio/releases/download/v0.3.3-beta/7krh-Studio-Setup-0.3.3.exe)

### Development
```
npm install
npm start          # needs the Windows runtime in ./runtime (scripts/fetch-runtime.ps1)
npm test           # unit tests + timeline renderer end-to-end (any OS with ffmpeg)
```
Builds, tests and installers run on GitHub Actions (`.github/workflows/build.yml`).

<div align="center"><sub>© 2026 7krh · MIT</sub></div>
