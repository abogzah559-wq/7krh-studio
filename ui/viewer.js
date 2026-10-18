/* 7krh Studio — before/after viewer with real zoom.
   A 4K result shrunk to fit a window hides exactly the detail the AI adds, so this viewer lets you zoom
   to 100% and beyond (mouse wheel at the cursor, double-click toggles fit ↔ 100%), pan (right/middle drag
   or drag while zoomed with Shift), and drag the split line (left drag). Both images are mapped onto the
   same output pixel grid, so "before" is the source enlarged plainly and "after" is the AI result. */
(() => {
  'use strict';
  App.Compare = function Compare(canvas, box, onZoom) {
    const st = { a: null, b: null, split: 0.5, z: 0, cx: 0, cy: 0 }; // z = 0 means "fit"
    let W = 0, H = 0, raf = 0;
    const ctx = canvas.getContext('2d');
    canvas.style.position = 'absolute'; canvas.style.inset = '0'; canvas.style.width = '100%'; canvas.style.height = '100%';
    canvas.style.maxWidth = 'none'; canvas.style.maxHeight = 'none';
    const dpr = () => Math.min(3, window.devicePixelRatio || 1);
    const fit = () => Math.min(box.clientWidth / W, box.clientHeight / H) * 0.96;
    const scale = () => (st.z ? st.z / dpr() : fit()); // CSS px per image px
    function set(a, b, keep) {
      st.a = a; st.b = b;
      W = (b || a).naturalWidth; H = (b || a).naturalHeight;
      if (!keep) { st.z = 0; st.cx = W / 2; st.cy = H / 2; }
      draw();
    }
    function clampCenter() {
      const s = scale(), vw = box.clientWidth / s, vh = box.clientHeight / s;
      st.cx = vw >= W ? W / 2 : Math.min(W - vw / 2, Math.max(vw / 2, st.cx));
      st.cy = vh >= H ? H / 2 : Math.min(H - vh / 2, Math.max(vh / 2, st.cy));
    }
    function draw() { if (!raf) raf = requestAnimationFrame(now); }
    function now() {
      raf = 0; if (!st.a) return;
      const d = dpr(), bw = box.clientWidth, bh = box.clientHeight;
      if (canvas.width !== Math.round(bw * d) || canvas.height !== Math.round(bh * d)) { canvas.width = Math.round(bw * d); canvas.height = Math.round(bh * d); }
      clampCenter();
      const s = scale() * d; // device px per image px
      const ox = canvas.width / 2 - st.cx * s, oy = canvas.height / 2 - st.cy * s;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
      const smooth = s < 1.5; // past 150% show real pixels, that is where the difference lives
      ctx.imageSmoothingEnabled = smooth; ctx.imageSmoothingQuality = 'high';
      ctx.setTransform(s, 0, 0, s, ox, oy);
      ctx.drawImage(st.b || st.a, 0, 0, W, H);
      if (st.b) {
        const sx = (canvas.width * st.split - ox) / s;
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, Math.max(0, Math.min(W, sx)), H); ctx.clip();
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(st.a, 0, 0, W, H); ctx.restore();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const lx = Math.round(canvas.width * st.split);
        ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(lx - 2, 0, 4, canvas.height);
        ctx.fillStyle = '#fff'; ctx.fillRect(lx - 1, 0, 2, canvas.height);
        ctx.beginPath(); ctx.arc(lx, canvas.height / 2, 14 * d, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#111'; ctx.font = `${12 * d}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('⇆', lx, canvas.height / 2);
      }
      onZoom && onZoom(Math.round(scale() * dpr() * 100));
    }
    // interaction
    let drag = null;
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('pointerdown', e => {
      if (!st.a) return; canvas.setPointerCapture(e.pointerId);
      if (e.button === 1 || e.button === 2 || e.shiftKey) drag = { pan: true, x: e.clientX, y: e.clientY, cx: st.cx, cy: st.cy };
      else { drag = { split: true }; splitAt(e); }
    });
    canvas.addEventListener('pointermove', e => {
      if (!drag) return;
      if (drag.split) splitAt(e);
      else { const s = scale(); st.cx = drag.cx - (e.clientX - drag.x) / s; st.cy = drag.cy - (e.clientY - drag.y) / s; draw(); }
    });
    canvas.addEventListener('pointerup', () => { drag = null; });
    function splitAt(e) { const r = canvas.getBoundingClientRect(); st.split = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); draw(); }
    function zoomTo(z, e) {
      const r = canvas.getBoundingClientRect(), s0 = scale();
      const px = e ? e.clientX - r.left - r.width / 2 : 0, py = e ? e.clientY - r.top - r.height / 2 : 0;
      const ix = st.cx + px / s0, iy = st.cy + py / s0; // image point under the cursor stays put
      const fz = fit() * dpr();
      st.z = z <= fz * 1.001 ? 0 : Math.min(8, z);
      const s1 = scale(); st.cx = ix - px / s1; st.cy = iy - py / s1; draw();
    }
    canvas.addEventListener('wheel', e => {
      if (!st.a) return; e.preventDefault();
      const cur = scale() * dpr(), f = Math.exp(-e.deltaY * 0.0015);
      zoomTo(cur * f, e);
    }, { passive: false });
    canvas.addEventListener('dblclick', e => { if (!st.a) return; zoomTo(st.z ? 0 : 1, e); });
    new ResizeObserver(draw).observe(box);
    return { set, draw, zoomTo: z => zoomTo(z), get has() { return !!st.a; }, clear() { st.a = st.b = null; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); } };
  };
})();
