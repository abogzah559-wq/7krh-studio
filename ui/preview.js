/* 7krh Studio — montage preview. Draws the project on a canvas with exactly the numbers the export uses:
   TL.stateAt / TL.rect for position, size, rotation, opacity and transitions, TL.colorParams for colour
   (drawn here with an SVG filter: lookup table + saturation matrix + sharpen kernel, in sRGB), TL.gainAt for
   sound. Videos play through hidden <video> elements (or a light proxy when Chromium cannot decode the file);
   sound goes through Web Audio so volumes above 100 % work like in the export. */
(() => {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const FILTERS = new Map(); let fid = 0; // shared by every view (montage preview, single-video player)

  class Preview {
    constructor(canvas, getProject, opts = {}) {
      this.cv = canvas; this.ctx = canvas.getContext('2d', { alpha: false });
      this.get = getProject; this.q = 0.5; this.els = new Map(); this.filters = new Map();
      this.playing = false; this.t = 0; this.raf = 0; this.onTime = opts.onTime || (() => {}); this.onEnd = opts.onEnd || (() => {});
      this.sel = null; this.ac = null; this.dirty = true; this.fileUrl = opts.fileUrl;
      this.overlay = opts.overlay || null;
    }
    /* ---------------- sizing */
    resize(boxW, boxH) {
      const p = this.get(); const { w, h } = p.canvas;
      const fit = Math.min(boxW / w, boxH / h) * 0.96;
      this.cssW = Math.max(40, Math.floor(w * fit)); this.cssH = Math.max(40, Math.floor(h * fit));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      // internal resolution: preview quality × project size, never above what the screen shows
      const k = Math.min(this.q, (this.cssW * dpr) / w);
      this.k = k;
      const W = Math.max(2, Math.round(w * k)), H = Math.max(2, Math.round(h * k));
      if (this.cv.width !== W || this.cv.height !== H) { this.cv.width = W; this.cv.height = H; }
      this.cv.style.width = this.cssW + 'px'; this.cv.style.height = this.cssH + 'px';
      this.draw();
    }
    /* ---------------- media elements */
    audio() { if (!this.ac) { try { this.ac = new AudioContext({ latencyHint: 'playback' }); } catch (e) { this.ac = null; } } return this.ac; }
    el(c) {
      let e = this.els.get(c.id);
      const p = this.get(); const m = p.media[c.src] || {};
      const url = c.kind === 'text' ? null : this.fileUrl(m.proxy || c.src);
      if (e && e.url === url && e.kind === c.kind) return e;
      if (e) this.drop(c.id);
      if (c.kind === 'text') { e = { kind: 'text' }; this.els.set(c.id, e); return e; }
      if (c.kind === 'image') { const img = new Image(); img.decoding = 'async'; img.onload = () => this.redraw(); img.src = url; e = { kind: 'image', node: img, url }; }
      else {
        const v = document.createElement(c.kind === 'audio' ? 'audio' : 'video');
        v.preload = 'auto'; v.playsInline = true; v.src = url;
        v.addEventListener('seeked', () => this.redraw());
        v.addEventListener('loadeddata', () => this.redraw());
        e = { kind: c.kind, node: v, url, gain: null };
        const ac = this.audio();
        if (ac) { try { const src = ac.createMediaElementSource(v); const g = ac.createGain(); g.gain.value = 0; src.connect(g).connect(ac.destination); e.gain = g; } catch (err) { v.muted = true; } }
        else v.muted = true;
      }
      this.els.set(c.id, e);
      return e;
    }
    drop(id) { const e = this.els.get(id); if (!e) return; if (e.node && e.node.pause) { e.node.pause(); e.node.removeAttribute('src'); e.node.load(); } this.els.delete(id); }
    gc() { const p = this.get(); const ids = new Set(p.clips.map(c => c.id)); for (const id of [...this.els.keys()]) if (!ids.has(id)) this.drop(id); }

    /* ---------------- colour: one SVG filter per distinct adjustment */
    filter(adj) {
      if (TL.colorIsIdentity(adj)) return 'none';
      const k = TL.colorParams(adj);
      const key = [k.bm, k.ck, k.ge, k.sa, k.sh].map(x => x.toFixed(4)).join('_');
      if (FILTERS.has(key)) return FILTERS.get(key);
      const id = 'fx' + (fid++);
      const f = document.createElementNS(NS, 'filter');
      f.setAttribute('id', id); f.setAttribute('color-interpolation-filters', 'sRGB'); f.setAttribute('x', '0'); f.setAttribute('y', '0'); f.setAttribute('width', '1'); f.setAttribute('height', '1');
      if (k.bm !== 1 || k.ck !== 1 || k.ge !== 1) {
        const tab = []; for (let i = 0; i < 256; i++) tab.push(TL.transfer(i / 255, k).toFixed(5));
        const ct = document.createElementNS(NS, 'feComponentTransfer');
        for (const ch of ['R', 'G', 'B']) { const fn = document.createElementNS(NS, 'feFunc' + ch); fn.setAttribute('type', 'table'); fn.setAttribute('tableValues', tab.join(' ')); ct.appendChild(fn); }
        f.appendChild(ct);
      }
      if (k.sa !== 1) {
        const m = TL.satMatrix(k.sa);
        const cm = document.createElementNS(NS, 'feColorMatrix'); cm.setAttribute('type', 'matrix');
        cm.setAttribute('values', [m[0], m[1], m[2], 0, 0, m[3], m[4], m[5], 0, 0, m[6], m[7], m[8], 0, 0, 0, 0, 0, 1, 0].map(x => (+x).toFixed(5)).join(' '));
        f.appendChild(cm);
      }
      if (k.sh > 0) {
        const cv = document.createElementNS(NS, 'feConvolveMatrix');
        cv.setAttribute('order', '3'); cv.setAttribute('kernelMatrix', TL.sharpKernel(k.sh).map(x => x.toFixed(5)).join(' '));
        cv.setAttribute('divisor', '1'); cv.setAttribute('preserveAlpha', 'true'); cv.setAttribute('edgeMode', 'duplicate');
        f.appendChild(cv);
      }
      document.getElementById('fxDefs').appendChild(f);
      const url = `url(#${id})`; FILTERS.set(key, url); return url;
    }

    /* ---------------- drawing */
    redraw() { if (!this.playing && !this._rq) { this._rq = requestAnimationFrame(() => { this._rq = 0; this.draw(); }); } }
    active(p, t) { return p.clips.filter(c => t >= c.start - 1e-6 && t < TL.end(c) - 1e-6); }
    draw() {
      const p = this.get(), ctx = this.ctx, k = this.k || 0.5, t = this.t;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.filter = 'none';
      ctx.fillStyle = p.canvas.bg || '#000'; ctx.fillRect(0, 0, this.cv.width, this.cv.height);
      const act = this.active(p, t);
      for (const tr of TL.drawOrder(p)) {
        if (tr.hidden) continue;
        for (const c of act.filter(x => x.track === tr.id && TL.isVisual(x)).sort((a, b) => a.start - b.start)) this.layer(ctx, p, c, t, k);
      }
      if (this.sel) this.outline(ctx, p, this.sel, t, k);
      if (this.overlay) this.overlay(ctx, k);
    }
    source(c) {
      const e = this.el(c);
      if (c.kind === 'text') return TextLayer.canvasOf(c); // a canvas is ready at once (an image would load later)
      if (c.kind === 'image') return e.node.complete && e.node.naturalWidth ? e.node : null;
      return e.node.readyState >= 2 ? e.node : null;
    }
    layer(ctx, p, c, t, k) {
      const src = this.source(c); if (!src) return;
      const st = TL.stateAt(c, t - c.start);
      if (st.o <= 0.001) return;
      const r = TL.rect(p, c, st);
      const w = r.w * k, hh = r.h * k;
      ctx.save();
      ctx.translate(r.cx * k, r.cy * k); if (r.r) ctx.rotate(r.r * Math.PI / 180);
      ctx.globalAlpha = st.o; ctx.imageSmoothingQuality = 'high';
      const f = this.filter(c.adj);
      if (st.black > 0.001) {
        // fade to black acts on the layer's own pixels (like ffmpeg's fade), so it is drawn off-screen first
        const oc = this._oc || (this._oc = document.createElement('canvas'));
        oc.width = Math.max(1, Math.ceil(w)); oc.height = Math.max(1, Math.ceil(hh));
        const ox = oc.getContext('2d'); ox.filter = f; ox.clearRect(0, 0, oc.width, oc.height); ox.drawImage(src, 0, 0, oc.width, oc.height);
        ox.filter = 'none'; ox.globalCompositeOperation = 'source-atop'; ox.globalAlpha = st.black; ox.fillStyle = '#000'; ox.fillRect(0, 0, oc.width, oc.height);
        ox.globalCompositeOperation = 'source-over'; ox.globalAlpha = 1;
        ctx.drawImage(oc, -w / 2, -hh / 2, w, hh);
      } else {
        ctx.filter = f;
        ctx.drawImage(src, -w / 2, -hh / 2, w, hh);
      }
      ctx.restore();
    }
    outline(ctx, p, c, t, k) {
      if (!TL.isVisual(c) || t < c.start || t >= TL.end(c)) return;
      const r = TL.rect(p, c, TL.stateAt(c, t - c.start));
      ctx.save(); ctx.translate(r.cx * k, r.cy * k); if (r.r) ctx.rotate(r.r * Math.PI / 180);
      ctx.strokeStyle = '#ff6aa9'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.strokeRect(-r.w * k / 2, -r.h * k / 2, r.w * k, r.h * k);
      ctx.setLineDash([]); ctx.fillStyle = '#ff6aa9';
      for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) ctx.fillRect(x * r.w * k / 2 - 4, y * r.h * k / 2 - 4, 8, 8);
      ctx.restore();
    }
    /* topmost visual clip under a canvas point (project pixels) */
    hit(px, py) {
      const p = this.get(), t = this.t;
      const order = TL.drawOrder(p).filter(tr => !tr.hidden).reverse();
      for (const tr of order) {
        const list = this.active(p, t).filter(c => c.track === tr.id && TL.isVisual(c)).sort((a, b) => b.start - a.start);
        for (const c of list) {
          const r = TL.rect(p, c, TL.stateAt(c, t - c.start));
          const a = -(r.r || 0) * Math.PI / 180, dx = px - r.cx, dy = py - r.cy;
          const x = dx * Math.cos(a) - dy * Math.sin(a), y = dx * Math.sin(a) + dy * Math.cos(a);
          if (Math.abs(x) <= r.w / 2 && Math.abs(y) <= r.h / 2) return { clip: c, corner: Math.abs(Math.abs(x) - r.w / 2) < 14 / this.k && Math.abs(Math.abs(y) - r.h / 2) < 14 / this.k };
        }
      }
      return null;
    }

    /* ---------------- time */
    seek(t) {
      const p = this.get();
      this.t = Math.max(0, Math.min(t, Math.max(0, TL.duration(p))));
      if (this.playing) { this.base = this.t; this.t0 = performance.now(); }
      this.syncMedia(false);
      this.onTime(this.t);
      this.draw();
    }
    syncMedia(playing) {
      const p = this.get(), t = this.t, fps = p.canvas.fps || 30;
      for (const c of p.clips) {
        if (c.kind !== 'video' && c.kind !== 'audio') continue;
        const near = t >= c.start - 2 && t < TL.end(c) + 0.5;
        if (!near) { const e = this.els.get(c.id); if (e && e.node && !e.node.paused) e.node.pause(); continue; }
        const e = this.el(c), v = e.node;
        const on = t >= c.start && t < TL.end(c);
        const want = TL.srcTime(c, Math.min(Math.max(t, c.start), TL.end(c) - 1e-3));
        const tr = TL.trackOf(p, c) || {};
        const audible = on && playing && TL.hasSound(p, c) && !tr.mute;
        if (e.gain) e.gain.gain.value = audible ? TL.gainAt(p, c, t - c.start) : 0;
        if (playing && on && !c.reverse) {
          if (Math.abs(v.playbackRate - c.speed) > 1e-3) v.playbackRate = Math.min(16, Math.max(0.0625, c.speed));
          if (v.paused) { v.currentTime = want; v.play().catch(() => {}); }
          else if (Math.abs(v.currentTime - want) > 0.25) v.currentTime = want;
        } else {
          if (!v.paused) v.pause();
          if (Math.abs(v.currentTime - want) > 0.5 / fps) v.currentTime = want;
        }
      }
    }
    play() {
      if (this.playing) return;
      const p = this.get(), d = TL.duration(p); if (!d) return;
      if (this.t >= d - 0.02) this.t = 0;
      const ac = this.audio(); if (ac && ac.state === 'suspended') ac.resume();
      this.playing = true; this.base = this.t; this.t0 = performance.now();
      const tick = () => {
        if (!this.playing) return;
        this.t = this.base + (performance.now() - this.t0) / 1000;
        if (this.t >= d) { this.t = d; this.pause(); this.onEnd(); return; }
        this.syncMedia(true); this.draw(); this.onTime(this.t);
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }
    pause() {
      this.playing = false; cancelAnimationFrame(this.raf);
      for (const e of this.els.values()) if (e.node && e.node.pause) { e.node.pause(); if (e.gain) e.gain.gain.value = 0; }
      this.syncMedia(false); this.draw(); this.onTime(this.t);
    }
    toggle() { this.playing ? this.pause() : this.play(); }
  }
  window.Preview = Preview;
  window.svgFilter = adj => Preview.prototype.filter.call({}, adj);
})();
