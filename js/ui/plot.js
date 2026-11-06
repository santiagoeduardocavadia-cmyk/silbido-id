/**
 * Mini motor de gráficas en <canvas>: líneas (con envolvente min/máx para señales largas),
 * mapas de calor (espectrograma, escalograma), tallos, marcadores, bandas, leyenda HTML,
 * cruz + tooltip al pasar el mouse y exportación a PNG / CSV.
 */
import { fmt, download } from '../util.js';

let tokenCache = new Map();
let lutCache = null;
const plots = new Set();

export function tok(name) {
  if (!tokenCache.has(name)) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    tokenCache.set(name, v || '#888888');
  }
  return tokenCache.get(name);
}
export const col = (c) => (c && c.startsWith('--') ? tok(c) : c || tok('--series-1'));

export function themeChanged() {
  tokenCache = new Map();
  lutCache = null;
  for (const p of plots) {
    p._heat = null;
    p.renderLegend();
    p.invalidate();
  }
}

function hexToRgb(hex) {
  let s = hex.replace('#', '').trim();
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Paleta secuencial de un solo tono (azul), de la superficie al extremo. */
export function heatLUT() {
  if (lutCache) return lutCache;
  const stops = [0, 1, 2, 3, 4, 5].map((i) => hexToRgb(tok(`--heat-${i}`)));
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(t));
    const f = t - k;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = stops[k][c] + (stops[k + 1][c] - stops[k][c]) * f;
  }
  lutCache = lut;
  return lut;
}

function niceStep(range, target) {
  const raw = range / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const r = raw / mag;
  return (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * mag;
}

function linearTicks(min, max, target) {
  if (!(max > min)) return [min];
  const step = niceStep(max - min, target);
  const out = [];
  const start = Math.ceil(min / step - 1e-9) * step;
  for (let v = start; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : +v.toPrecision(12));
  return out;
}

function logTicks(min, max) {
  const out = [];
  for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (v >= min * 0.999 && v <= max * 1.001) out.push(v);
    }
  }
  return out;
}

const mergeAxis = (base, o) => Object.assign({}, base, o || {});

export class Plot {
  constructor(el, opts = {}) {
    this.el = el;
    el.classList.add('plot');
    const defAxis = { label: '', min: 0, max: 1, scale: 'linear', format: null, tip: null, ticks: null, grid: true };
    this.opts = {
      height: 240,
      margin: { l: 54, r: 14, t: 10, b: 36 },
      crosshair: 'x',
      tooltip: null,
      onClick: null,
      aspect: null,
      colorbar: null,
      name: 'grafica',
      ...opts,
    };
    this.opts.margin = { l: 54, r: 14, t: 10, b: 36, ...(opts.margin || {}) };
    this.opts.x = mergeAxis(defAxis, opts.x);
    this.opts.y = mergeAxis(defAxis, opts.y);
    this.layers = this._emptyLayers();

    this.legendEl = document.createElement('div');
    this.legendEl.className = 'plot-legend';
    this.wrap = document.createElement('div');
    this.wrap.className = 'plot-wrap';
    this.wrap.style.height = `${this.opts.height}px`;
    this.base = document.createElement('canvas');
    this.overlay = document.createElement('canvas');
    this.base.className = 'plot-canvas';
    this.overlay.className = 'plot-canvas plot-overlay';
    this.tip = document.createElement('div');
    this.tip.className = 'plot-tip';
    this.tip.hidden = true;
    this.empty = document.createElement('div');
    this.empty.className = 'plot-empty';
    this.wrap.append(this.base, this.overlay, this.tip, this.empty);
    el.append(this.legendEl, this.wrap);
    if (opts.ariaLabel) {
      this.base.setAttribute('role', 'img');
      this.base.setAttribute('aria-label', opts.ariaLabel);
    }

    this.ro = new ResizeObserver(() => this.invalidate());
    this.ro.observe(this.wrap);
    this.wrap.addEventListener('pointermove', (e) => this._hover(e));
    this.wrap.addEventListener('pointerleave', () => this._hideTip());
    this.wrap.addEventListener('click', (e) => {
      if (!this.opts.onClick || !this.view) return;
      const p = this._eventData(e);
      if (p) this.opts.onClick(p.x, p.y);
    });
    plots.add(this);
  }

  _emptyLayers() {
    return { heatmap: null, bands: [], lines: [], stems: [], points: [], vlines: [], hlines: [], circles: [], texts: [] };
  }

  setAxes({ x, y } = {}) {
    if (x) Object.assign(this.opts.x, x);
    if (y) Object.assign(this.opts.y, y);
    this.invalidate();
  }

  set(layers) {
    for (const k of Object.keys(layers)) this.layers[k] = layers[k];
    if ('heatmap' in layers) this._heat = null;
    this.setEmpty('');
    this.renderLegend();
    this.invalidate();
  }

  clear(msg = '') {
    this.layers = this._emptyLayers();
    this._heat = null;
    this.renderLegend();
    this.setEmpty(msg);
    this.invalidate();
  }

  setEmpty(msg) {
    this.empty.textContent = msg || '';
    this.empty.hidden = !msg;
  }

  invalidate() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.draw();
    });
  }

  renderLegend() {
    const items = [];
    for (const L of this.layers.lines) if (L.label) items.push({ label: L.label, color: L.color, kind: L.dash ? 'dash' : 'line' });
    for (const S of this.layers.stems) if (S.label) items.push({ label: S.label, color: S.color, kind: 'line' });
    for (const P of this.layers.points) if (P.label) items.push({ label: P.label, color: P.color, kind: P.marker === 'x' ? 'x' : 'o' });
    for (const B of this.layers.bands) if (B.legend) items.push({ label: B.legend, color: B.color, kind: 'band' });
    for (const V of this.layers.vlines) if (V.legend) items.push({ label: V.legend, color: V.color, kind: 'dash' });
    this.legendEl.innerHTML = items
      .map((it) => `<span class="lg lg-${it.kind}"><i style="--c:${col(it.color)}"></i>${it.label}</span>`)
      .join('');
    this.legendEl.hidden = items.length < 2 && !this.opts.forceLegend;
  }

  // ---------- transformaciones ----------
  X(v) {
    const V = this.view;
    const t = V.xs === 'log' ? (Math.log(v) - Math.log(V.xmin)) / (Math.log(V.xmax) - Math.log(V.xmin)) : (v - V.xmin) / (V.xmax - V.xmin);
    return V.px0 + t * (V.px1 - V.px0);
  }
  Y(v) {
    const V = this.view;
    const t = V.ys === 'log' ? (Math.log(v) - Math.log(V.ymin)) / (Math.log(V.ymax) - Math.log(V.ymin)) : (v - V.ymin) / (V.ymax - V.ymin);
    return V.py1 - t * (V.py1 - V.py0);
  }
  invX(px) {
    const V = this.view;
    const t = (px - V.px0) / (V.px1 - V.px0);
    return V.xs === 'log' ? Math.exp(Math.log(V.xmin) + t * (Math.log(V.xmax) - Math.log(V.xmin))) : V.xmin + t * (V.xmax - V.xmin);
  }
  invY(py) {
    const V = this.view;
    const t = (V.py1 - py) / (V.py1 - V.py0);
    return V.ys === 'log' ? Math.exp(Math.log(V.ymin) + t * (Math.log(V.ymax) - Math.log(V.ymin))) : V.ymin + t * (V.ymax - V.ymin);
  }

  draw() {
    const w = this.wrap.clientWidth;
    const hgt = this.wrap.clientHeight;
    if (!w || !hgt) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    for (const c of [this.base, this.overlay]) {
      const W = Math.round(w * dpr);
      const H = Math.round(hgt * dpr);
      if (c.width !== W || c.height !== H) {
        c.width = W;
        c.height = H;
      }
    }
    const ctx = this.base.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    this.overlay.getContext('2d').clearRect(0, 0, this.overlay.width, this.overlay.height);

    const m = this.opts.margin;
    const cbW = this.layers.heatmap && this.opts.colorbar ? 58 : 0;
    const px0 = m.l;
    const px1 = Math.max(px0 + 10, w - m.r - cbW);
    const py0 = m.t;
    const py1 = Math.max(py0 + 10, hgt - m.b);
    let { min: xmin, max: xmax } = this.opts.x;
    let { min: ymin, max: ymax } = this.opts.y;
    if (this.opts.aspect === 'equal') {
      const sx = (px1 - px0) / (xmax - xmin);
      const sy = (py1 - py0) / (ymax - ymin);
      if (sx > sy) {
        const c = (xmin + xmax) / 2;
        const half = (px1 - px0) / sy / 2;
        xmin = c - half;
        xmax = c + half;
      } else {
        const c = (ymin + ymax) / 2;
        const half = (py1 - py0) / sx / 2;
        ymin = c - half;
        ymax = c + half;
      }
    }
    this.view = { px0, px1, py0, py1, xmin, xmax, ymin, ymax, xs: this.opts.x.scale, ys: this.opts.y.scale, w, h: hgt };
    const font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';

    // Rejilla
    const xt = this._ticks(this.opts.x, xmin, xmax, (px1 - px0) / 90);
    const yt = this._ticks(this.opts.y, ymin, ymax, (py1 - py0) / 44);
    ctx.lineWidth = 1;
    ctx.strokeStyle = tok('--grid');
    ctx.beginPath();
    if (this.opts.y.grid !== false) {
      for (const v of yt) {
        const y = Math.round(this.Y(v)) + 0.5;
        ctx.moveTo(px0, y);
        ctx.lineTo(px1, y);
      }
    }
    if (this.opts.x.grid !== false) {
      for (const v of xt) {
        const x = Math.round(this.X(v)) + 0.5;
        ctx.moveTo(x, py0);
        ctx.lineTo(x, py1);
      }
    }
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(px0, py0, px1 - px0, py1 - py0);
    ctx.clip();
    this._drawHeatmap(ctx);
    for (const B of this.layers.bands) this._drawBand(ctx, B);
    for (const C of this.layers.circles) {
      ctx.strokeStyle = col(C.color || '--axis');
      ctx.lineWidth = C.width || 1.2;
      ctx.beginPath();
      ctx.ellipse(this.X(C.cx), this.Y(C.cy), Math.abs(this.X(C.cx + C.r) - this.X(C.cx)), Math.abs(this.Y(C.cy + C.r) - this.Y(C.cy)), 0, 0, 2 * Math.PI);
      ctx.stroke();
    }
    for (const H of this.layers.hlines) this._drawHLine(ctx, H);
    for (const V of this.layers.vlines) this._drawVLine(ctx, V);
    for (const S of this.layers.stems) this._drawStems(ctx, S);
    for (const L of this.layers.lines) this._drawLine(ctx, L);
    for (const P of this.layers.points) this._drawPoints(ctx, P);
    for (const T of this.layers.texts) {
      ctx.font = T.font || font;
      ctx.fillStyle = col(T.color || '--text-secondary');
      ctx.textAlign = T.align || 'left';
      ctx.textBaseline = T.baseline || 'middle';
      ctx.fillText(T.text, this.X(T.x) + (T.dx || 0), this.Y(T.y) + (T.dy || 0));
    }
    ctx.restore();

    // Ejes
    ctx.strokeStyle = tok('--axis');
    ctx.beginPath();
    ctx.moveTo(px0 + 0.5, py0);
    ctx.lineTo(px0 + 0.5, py1 + 0.5);
    ctx.lineTo(px1, py1 + 0.5);
    ctx.stroke();
    ctx.font = font;
    ctx.fillStyle = tok('--text-muted');
    const fx = this.opts.x.format || ((v) => fmt(v, decimalsFor(xt)));
    const fy = this.opts.y.format || ((v) => fmt(v, decimalsFor(yt)));
    if (!this.opts.x.hideTicks) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      let lastRight = -Infinity;
      for (const v of xt) {
        const x = this.X(v);
        const label = fx(v);
        const tw = ctx.measureText(label).width;
        if (x - tw / 2 < lastRight + 6) continue;
        ctx.fillText(label, x, py1 + 6);
        lastRight = x + tw / 2;
      }
    }
    if (!this.opts.y.hideTicks) {
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const v of yt) ctx.fillText(fy(v), px0 - 6, this.Y(v));
    }
    ctx.fillStyle = tok('--text-secondary');
    if (this.opts.x.label) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(this.opts.x.label, (px0 + px1) / 2, hgt - 2);
    }
    if (this.opts.y.label) {
      ctx.save();
      ctx.translate(12, (py0 + py1) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.opts.y.label, 0, 0);
      ctx.restore();
    }
    if (cbW) this._drawColorbar(ctx, px1 + 16, py0, py1);
  }

  _ticks(axis, min, max, target) {
    if (Array.isArray(axis.ticks)) return axis.ticks.filter((v) => v >= min - 1e-9 && v <= max + 1e-9);
    if (typeof axis.ticks === 'function') return axis.ticks(min, max, target);
    return axis.scale === 'log' ? logTicks(min, max) : linearTicks(min, max, Math.max(2, target));
  }

  _drawBand(ctx, B) {
    ctx.fillStyle = col(B.color || '--series-1');
    ctx.globalAlpha = B.alpha ?? 0.1;
    if (B.y0 != null) {
      const y0 = this.Y(B.y1);
      ctx.fillRect(this.view.px0, y0, this.view.px1 - this.view.px0, this.Y(B.y0) - y0);
    } else {
      const x0 = this.X(B.x0);
      ctx.fillRect(x0, this.view.py0, this.X(B.x1) - x0, this.view.py1 - this.view.py0);
    }
    ctx.globalAlpha = 1;
    if (B.label) {
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = tok('--text-muted');
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(B.label, this.X(B.x0) + 4, this.view.py0 + 4);
    }
  }

  _drawVLine(ctx, V) {
    const x = Math.round(this.X(V.x)) + 0.5;
    ctx.strokeStyle = col(V.color || '--text-muted');
    ctx.lineWidth = V.width || 1;
    ctx.setLineDash(V.dash === false ? [] : V.dash || [4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, this.view.py0);
    ctx.lineTo(x, this.view.py1);
    ctx.stroke();
    ctx.setLineDash([]);
    if (V.label) {
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = tok('--text-secondary');
      ctx.textAlign = V.align || 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(V.label, x + (V.align === 'right' ? -4 : 4), this.view.py0 + 4 + (V.labelDy || 0));
    }
  }

  _drawHLine(ctx, H) {
    const y = Math.round(this.Y(H.y)) + 0.5;
    ctx.strokeStyle = col(H.color || '--text-muted');
    ctx.lineWidth = H.width || 1;
    ctx.setLineDash(H.dash === false ? [] : H.dash || [4, 4]);
    ctx.beginPath();
    ctx.moveTo(this.view.px0, y);
    ctx.lineTo(this.view.px1, y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (H.label) {
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = tok('--text-secondary');
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(H.label, this.view.px1 - 4, y - 3);
    }
  }

  _drawLine(ctx, L) {
    const n = L.y.length;
    if (!n) return;
    const getX = L.x ? (i) => L.x[i] : (i) => L.x0 + i * L.dx;
    ctx.strokeStyle = col(L.color);
    ctx.lineWidth = L.width || 2;
    ctx.globalAlpha = L.alpha ?? 1;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash(L.dash || []);
    const V = this.view;
    const pxw = V.px1 - V.px0;
    ctx.beginPath();
    if (n > pxw * 2.5) {
      // Envolvente min/máx por columna de píxel
      let colPx = null;
      let mn = Infinity;
      let mx = -Infinity;
      let started = false;
      const maxOnly = L.envelope === 'max';
      const flush = () => {
        if (colPx === null || mn === Infinity) return;
        const xp = V.px0 + colPx + 0.5;
        const a = this.Y(mn);
        const b = this.Y(mx);
        if (maxOnly) {
          if (!started) {
            ctx.moveTo(xp, b);
            started = true;
          } else ctx.lineTo(xp, b);
          return;
        }
        if (!started) {
          ctx.moveTo(xp, a);
          started = true;
        } else ctx.lineTo(xp, a);
        ctx.lineTo(xp, b === a ? b - 0.5 : b);
      };
      for (let i = 0; i < n; i++) {
        const xv = getX(i);
        if (xv < V.xmin || xv > V.xmax) continue;
        const yv = L.y[i];
        if (!Number.isFinite(yv)) {
          flush();
          colPx = null;
          mn = Infinity;
          mx = -Infinity;
          started = false;
          continue;
        }
        const c = Math.floor(this.X(xv) - V.px0);
        if (c !== colPx) {
          flush();
          colPx = c;
          mn = Infinity;
          mx = -Infinity;
        }
        if (yv < mn) mn = yv;
        if (yv > mx) mx = yv;
      }
      flush();
    } else {
      let pen = false;
      for (let i = 0; i < n; i++) {
        const yv = L.y[i];
        const xv = getX(i);
        if (!Number.isFinite(yv) || !Number.isFinite(xv)) {
          pen = false;
          continue;
        }
        const x = this.X(xv);
        const y = this.Y(yv);
        if (!pen) {
          ctx.moveTo(x, y);
          pen = true;
        } else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  _drawStems(ctx, S) {
    const getX = S.x ? (i) => S.x[i] : (i) => S.x0 + i * S.dx;
    const c = col(S.color);
    const y0 = this.Y(0);
    ctx.strokeStyle = c;
    ctx.fillStyle = c;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < S.y.length; i++) {
      const x = this.X(getX(i));
      const y = this.Y(S.y[i]);
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, S.r || 2.2, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  _drawPoints(ctx, P) {
    const c = col(P.color);
    const s = (P.size || 9) / 2;
    ctx.lineWidth = P.width || 2;
    for (let i = 0; i < P.x.length; i++) {
      const x = this.X(P.x[i]);
      const y = this.Y(P.y[i]);
      ctx.strokeStyle = c;
      ctx.beginPath();
      if (P.marker === 'x') {
        ctx.moveTo(x - s, y - s);
        ctx.lineTo(x + s, y + s);
        ctx.moveTo(x + s, y - s);
        ctx.lineTo(x - s, y + s);
        ctx.stroke();
      } else {
        // anillo de superficie + marcador
        ctx.arc(x, y, s, 0, 2 * Math.PI);
        if (P.fill) {
          ctx.fillStyle = c;
          ctx.fill();
        }
        ctx.stroke();
      }
      if (P.labels && P.labels[i]) {
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.fillStyle = tok('--text-primary');
        const tw = ctx.measureText(P.labels[i]).width;
        const right = x + s + 4 + tw < this.view.px1;
        ctx.textAlign = right ? 'left' : 'right';
        const nearTop = y - s - 14 < this.view.py0;
        ctx.textBaseline = nearTop ? 'top' : 'bottom';
        ctx.fillText(P.labels[i], right ? x + s + 3 : x - s - 3, nearTop ? y + s : y - s);
      }
    }
  }

  _drawHeatmap(ctx) {
    const hm = this.layers.heatmap;
    if (!hm) return;
    if (!this._heat) {
      const { cols, rows, data, vmin, vmax } = hm;
      const off = document.createElement('canvas');
      off.width = cols;
      off.height = rows;
      const octx = off.getContext('2d');
      const img = octx.createImageData(cols, rows);
      const lut = heatLUT();
      const scale = 255 / (vmax - vmin || 1);
      const d = img.data;
      for (let c = 0; c < cols; c++) {
        const base = c * rows;
        for (let r = 0; r < rows; r++) {
          let v = (data[base + r] - vmin) * scale;
          v = v < 0 ? 0 : v > 255 ? 255 : v | 0;
          const o = ((rows - 1 - r) * cols + c) * 4;
          d[o] = lut[v * 3];
          d[o + 1] = lut[v * 3 + 1];
          d[o + 2] = lut[v * 3 + 2];
          d[o + 3] = 255;
        }
      }
      octx.putImageData(img, 0, 0);
      this._heat = off;
    }
    const x0 = this.X(hm.x0);
    const x1 = this.X(hm.x1);
    const yTop = this.Y(hm.y1);
    const yBot = this.Y(hm.y0);
    ctx.imageSmoothingEnabled = hm.smooth !== false;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this._heat, x0, yTop, x1 - x0, yBot - yTop);
  }

  _drawColorbar(ctx, x, y0, y1) {
    const hm = this.layers.heatmap;
    const lut = heatLUT();
    const h = y1 - y0;
    for (let i = 0; i < h; i++) {
      const v = Math.round((1 - i / h) * 255);
      ctx.fillStyle = `rgb(${lut[v * 3]},${lut[v * 3 + 1]},${lut[v * 3 + 2]})`;
      ctx.fillRect(x, y0 + i, 10, 1.5);
    }
    ctx.strokeStyle = tok('--border-strong');
    ctx.strokeRect(x + 0.5, y0 + 0.5, 10, h);
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = tok('--text-muted');
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const f = this.opts.colorbar.format || ((v) => fmt(v, 0));
    ctx.fillText(f(hm.vmax), x + 14, y0 + 5);
    ctx.fillText(f((hm.vmax + hm.vmin) / 2), x + 14, (y0 + y1) / 2);
    ctx.fillText(f(hm.vmin), x + 14, y1 - 5);
    if (this.opts.colorbar.label) {
      ctx.fillStyle = tok('--text-secondary');
      ctx.textBaseline = 'bottom';
      ctx.fillText(this.opts.colorbar.label, x - 2, y0 - 1 < 10 ? 10 : y0 - 1);
    }
  }

  // ---------- interacción ----------
  _eventData(e) {
    if (!this.view) return null;
    const r = this.wrap.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const V = this.view;
    if (px < V.px0 || px > V.px1 || py < V.py0 || py > V.py1) return null;
    return { px, py, x: this.invX(px), y: this.invY(py) };
  }

  _hideTip() {
    this.tip.hidden = true;
    const o = this.overlay.getContext('2d');
    o.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }

  lineValueAt(L, xv) {
    const n = L.y.length;
    if (!n) return null;
    let i;
    if (L.x) {
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (L.x[mid] <= xv) lo = mid;
        else hi = mid;
      }
      i = Math.abs(L.x[hi] - xv) < Math.abs(L.x[lo] - xv) ? hi : lo;
    } else i = Math.max(0, Math.min(n - 1, Math.round((xv - L.x0) / L.dx)));
    const x = L.x ? L.x[i] : L.x0 + i * L.dx;
    return { i, x, y: L.y[i] };
  }

  heatValueAt(xv, yv) {
    const hm = this.layers.heatmap;
    if (!hm) return null;
    const c = Math.floor(((xv - hm.x0) / (hm.x1 - hm.x0)) * hm.cols);
    const t = this.opts.y.scale === 'log' ? (Math.log(yv) - Math.log(hm.y0)) / (Math.log(hm.y1) - Math.log(hm.y0)) : (yv - hm.y0) / (hm.y1 - hm.y0);
    const r = Math.floor(t * hm.rows);
    if (c < 0 || c >= hm.cols || r < 0 || r >= hm.rows) return null;
    return { c, r, value: hm.data[c * hm.rows + r] };
  }

  _hover(e) {
    const p = this._eventData(e);
    if (!p) return this._hideTip();
    const V = this.view;
    let html = '';
    if (this.opts.tooltip) html = this.opts.tooltip(p, this);
    else html = this._defaultTip(p);
    if (!html) return this._hideTip();
    const dpr = this.overlay.width / V.w;
    const o = this.overlay.getContext('2d');
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.clearRect(0, 0, V.w, V.h);
    o.strokeStyle = tok('--text-muted');
    o.lineWidth = 1;
    o.beginPath();
    if (this.opts.crosshair === 'x' || this.opts.crosshair === 'xy') {
      o.moveTo(Math.round(p.px) + 0.5, V.py0);
      o.lineTo(Math.round(p.px) + 0.5, V.py1);
    }
    if (this.opts.crosshair === 'xy') {
      o.moveTo(V.px0, Math.round(p.py) + 0.5);
      o.lineTo(V.px1, Math.round(p.py) + 0.5);
    }
    o.stroke();
    // puntos sobre las líneas
    if (!this.layers.heatmap) {
      for (const L of this.layers.lines) {
        if (!L.label || L.noTip) continue;
        const v = this.lineValueAt(L, p.x);
        if (!v || !Number.isFinite(v.y) || v.y < V.ymin || v.y > V.ymax) continue;
        o.fillStyle = col(L.color);
        o.strokeStyle = tok('--surface-1');
        o.lineWidth = 2;
        o.beginPath();
        o.arc(this.X(v.x), this.Y(v.y), 4.5, 0, 2 * Math.PI);
        o.fill();
        o.stroke();
      }
    }
    this.tip.innerHTML = html;
    this.tip.hidden = false;
    const tw = this.tip.offsetWidth;
    const th = this.tip.offsetHeight;
    let left = p.px + 14;
    if (left + tw > V.w - 4) left = p.px - tw - 14;
    let top = p.py - th - 10;
    if (top < 2) top = p.py + 14;
    this.tip.style.transform = `translate(${Math.max(2, left)}px, ${Math.min(V.h - th - 2, top)}px)`;
  }

  _defaultTip(p) {
    const fx = this.opts.x.tip || this.opts.x.format || ((v) => fmt(v, 3));
    const fy = this.opts.y.tip || this.opts.y.format || ((v) => fmt(v, 2));
    const rows = [];
    if (this.layers.heatmap) {
      const hv = this.heatValueAt(p.x, p.y);
      if (!hv) return '';
      const fv = this.layers.heatmap.tip || ((v) => `${fmt(v, 1)} dB`);
      rows.push(`<div class="tip-h">${fx(p.x)} · ${fy(p.y)}</div>`);
      rows.push(`<div class="tip-v"><b>${fv(hv.value)}</b></div>`);
      if (this.opts.extraTip) rows.push(this.opts.extraTip(p, this));
      return rows.join('');
    }
    rows.push(`<div class="tip-h">${fx(p.x)}</div>`);
    let any = false;
    for (const L of this.layers.lines) {
      if (!L.label || L.noTip) continue;
      const v = this.lineValueAt(L, p.x);
      if (!v || !Number.isFinite(v.y)) continue;
      any = true;
      const fl = L.tip || fy;
      rows.push(`<div class="tip-row"><i style="--c:${col(L.color)}"></i><span>${L.label}</span><b>${fl(v.y)}</b></div>`);
    }
    for (const S of this.layers.stems) {
      if (!S.label) continue;
      const v = this.lineValueAt(S, p.x);
      if (!v) continue;
      any = true;
      rows.push(`<div class="tip-row"><i style="--c:${col(S.color)}"></i><span>${S.label}</span><b>${fy(v.y)}</b></div>`);
    }
    if (!any && !this.opts.extraTip) return '';
    if (this.opts.extraTip) rows.push(this.opts.extraTip(p, this));
    return rows.join('');
  }

  // ---------- exportación ----------
  exportPNG(filename) {
    if (!this.view) return;
    const dpr = this.base.width / this.view.w;
    const items = Array.from(this.legendEl.querySelectorAll('.lg'));
    const legendH = this.legendEl.hidden || !items.length ? 0 : 26;
    const out = document.createElement('canvas');
    out.width = this.base.width;
    out.height = this.base.height + Math.round(legendH * dpr);
    const c = out.getContext('2d');
    c.fillStyle = tok('--surface-1');
    c.fillRect(0, 0, out.width, out.height);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (legendH) {
      let x = this.view.px0;
      c.font = '12px system-ui, sans-serif';
      c.textBaseline = 'middle';
      for (const it of items) {
        const color = it.querySelector('i').style.getPropertyValue('--c');
        c.fillStyle = color;
        c.fillRect(x, 11, 12, 3);
        c.fillStyle = tok('--text-secondary');
        c.fillText(it.textContent, x + 16, 13);
        x += 28 + c.measureText(it.textContent).width;
      }
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(this.base, 0, Math.round(legendH * dpr));
    out.toBlob((b) => b && download(filename || `${this.opts.name}.png`, b));
  }

  toCSV() {
    const lines = ['serie,x,y'];
    const add = (label, L) => {
      for (let i = 0; i < L.y.length; i++) {
        const x = L.x ? L.x[i] : L.x0 + i * L.dx;
        const y = L.y[i];
        if (Number.isFinite(y)) lines.push(`"${label}",${+x.toPrecision(8)},${+y.toPrecision(8)}`);
      }
    };
    this.layers.lines.forEach((L, k) => add(L.label || `serie ${k + 1}`, L));
    this.layers.stems.forEach((S, k) => add(S.label || `tallos ${k + 1}`, S));
    return lines.length > 1 ? lines.join('\n') : null;
  }

  exportCSV(filename) {
    const csv = this.toCSV();
    if (csv) download(filename || `${this.opts.name}.csv`, csv, 'text/csv');
  }
}

function decimalsFor(ticks) {
  if (ticks.length < 2) return 0;
  const step = Math.abs(ticks[1] - ticks[0]);
  if (!step) return 0;
  return Math.max(0, Math.min(4, -Math.floor(Math.log10(step) + 1e-9)));
}

/** Agrega botones PNG/CSV a la cabecera de una tarjeta. */
export function addExportButtons(container, plotOrGetter, name, { csv = true } = {}) {
  const get = typeof plotOrGetter === 'function' ? plotOrGetter : () => plotOrGetter;
  const wrap = document.createElement('div');
  wrap.className = 'export-btns';
  wrap.innerHTML = `<button class="icon-btn sm" type="button" data-act="png" title="Descargar imagen PNG" aria-label="Descargar imagen PNG">PNG</button>${
    csv ? '<button class="icon-btn sm" type="button" data-act="csv" title="Descargar datos CSV" aria-label="Descargar datos CSV">CSV</button>' : ''
  }`;
  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const p = get();
    if (!p) return;
    if (b.dataset.act === 'png') p.exportPNG(`${name}.png`);
    else p.exportCSV(`${name}.csv`);
  });
  container.appendChild(wrap);
  return wrap;
}
