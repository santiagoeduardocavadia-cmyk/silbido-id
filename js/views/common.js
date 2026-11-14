// Configuraciones y dibujos compartidos entre vistas.
import { fmt, fmtFreqTick, fmtHz, sleep } from '../util.js';
import { noteName, midiToHz } from '../dsp/features.js';
import { stft, dbRange } from '../dsp/stft.js';
import { buildAnnotations } from '../ui/annotate.js';
import { tok, heatLUT } from '../ui/plot.js';

export const timeAxis = (max = 5, label = 'Tiempo (s)') => ({ label, min: 0, max, tip: (v) => `${fmt(v, 3)} s` });

export const freqAxis = (max = 8000) => ({ label: 'Frecuencia (Hz)', min: 0, max, format: fmtFreqTick, tip: (v) => fmtHz(v) });

export function noteTicks(min, max) {
  const span = max - min;
  const step = span <= 9 ? 1 : span <= 18 ? 2 : span <= 30 ? 3 : 6;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

export const noteAxis = (min, max, label = 'Nota') => ({
  label,
  min,
  max,
  ticks: noteTicks,
  format: (v) => noteName(v),
  tip: (v) => `${noteName(v)} · ${fmt(midiToHz(v), 0)} Hz`,
});

export function midiRange(arrays, pad = 1.5) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const a of arrays) {
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (Number.isFinite(v)) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  if (!Number.isFinite(lo)) return [80, 100];
  if (hi - lo < 4) {
    const c = (hi + lo) / 2;
    lo = c - 2;
    hi = c + 2;
  }
  return [Math.floor(lo - pad), Math.ceil(hi + pad)];
}

function setupCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 96;
  const h = canvas.clientHeight || 44;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/** Miniatura: contorno de tono sobre el tiempo, con los segmentos sombreados. */
export function drawContourSpark(canvas, { times, midi, dur, segments = [] }) {
  const { ctx, w, h } = setupCanvas(canvas);
  const finite = Array.from(midi).filter(Number.isFinite);
  const pad = 4;
  if (!finite.length) {
    ctx.strokeStyle = tok('--axis');
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(pad, h / 2);
    ctx.lineTo(w - pad, h / 2);
    ctx.stroke();
    return;
  }
  let lo = Math.min(...finite);
  let hi = Math.max(...finite);
  if (hi - lo < 3) {
    lo -= 1.5;
    hi += 1.5;
  }
  const X = (t) => pad + (t / dur) * (w - 2 * pad);
  const Y = (m) => h - pad - ((m - lo) / (hi - lo)) * (h - 2 * pad);
  ctx.fillStyle = tok('--series-1');
  ctx.globalAlpha = 0.12;
  for (const s of segments) ctx.fillRect(X(s.start), 0, Math.max(1, X(s.end) - X(s.start)), h);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = tok('--series-1');
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < midi.length; i++) {
    const m = midi[i];
    if (!Number.isFinite(m)) {
      pen = false;
      continue;
    }
    const x = X(times[i]);
    const y = Y(m);
    if (!pen) {
      ctx.moveTo(x, y);
      pen = true;
    } else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

const thumbCache = new WeakMap();
const THUMB_F0 = 400;
const THUMB_F1 = 5200;

function thumbSpec(a) {
  let S = thumbCache.get(a);
  if (!S) {
    const full = stft(a.y, a.fs, { N: 512, overlap: 0.5, fmax: THUMB_F1 });
    const range = dbRange(full.data, 48);
    const r0 = Math.floor(THUMB_F0 / full.df);
    const rows = full.rows - r0;
    const lut = heatLUT();
    const off = document.createElement('canvas');
    off.width = full.cols;
    off.height = rows;
    const octx = off.getContext('2d');
    const img = octx.createImageData(full.cols, rows);
    const scale = 255 / (range.vmax - range.vmin || 1);
    for (let c = 0; c < full.cols; c++) {
      for (let r = 0; r < rows; r++) {
        let v = (full.data[c * full.rows + r0 + r] - range.vmin) * scale;
        v = v < 0 ? 0 : v > 255 ? 255 : v | 0;
        const o = ((rows - 1 - r) * full.cols + c) * 4;
        img.data[o] = lut[v * 3];
        img.data[o + 1] = lut[v * 3 + 1];
        img.data[o + 2] = lut[v * 3 + 2];
        img.data[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    S = { off, x0: full.x0, x1: full.x1, fLo: r0 * full.df, fHi: (full.rows - 0.5) * full.df };
    thumbCache.set(a, S);
  }
  return S;
}

/**
 * Miniatura: mapa de calor de la toma con los tramos detectados (recuadros) y el contorno f₀(t).
 * Es la versión pequeña del mapa anotado de Análisis.
 */
export function drawHeatThumb(canvas, a, { crop = false } = {}) {
  const { ctx, w, h } = setupCanvas(canvas);
  const S = thumbSpec(a);
  // con `crop` se acerca al tramo con silbido (útil en tarjetas anchas y bajas)
  const f = a.features;
  const t0 = crop && f.valid ? Math.max(0, f.start - 0.2) : 0;
  const t1 = crop && f.valid ? Math.min(a.duration, f.end + 0.2) : a.duration;
  const X = (t) => ((t - t0) / (t1 - t0)) * w;
  const Y = (f) => h - ((f - S.fLo) / (S.fHi - S.fLo)) * h;
  ctx.fillStyle = tok('--heat-0');
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(S.off, X(S.x0), 0, X(S.x1) - X(S.x0), h);
  if (!a.features.valid) return;
  const c = tok('--ann-f0');
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1;
  for (const b of buildAnnotations(a, { compact: true }).layers.boxes) {
    if (b.key !== 'seg') continue;
    // dentro del lienzo (1,5 px de margen) para que el contorno no quede cortado en los bordes
    const top = Math.max(1.5, Y(b.y1));
    const bottom = Math.min(h - 1.5, Y(b.y0));
    const left = Math.max(1.5, X(b.x0));
    const right = Math.min(w - 1.5, X(b.x1));
    ctx.beginPath();
    ctx.roundRect(left, top, Math.max(2, right - left), Math.max(4, bottom - top), 3);
    ctx.stroke();
  }
  const trace = (color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < a.midi.length; i++) {
      const m = a.midi[i];
      if (!Number.isFinite(m)) {
        pen = false;
        continue;
      }
      const x = X(a.frames.times[i]);
      const y = Y(midiToHz(m));
      if (!pen) {
        ctx.moveTo(x, y);
        pen = true;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  trace('rgba(6,4,16,0.85)', 3.4);
  trace(c, 1.7);
}

/** Miniatura: envolvente de la forma de onda (para tomas sin silbido detectado). */
export function drawWaveSpark(canvas, samples) {
  const { ctx, w, h } = setupCanvas(canvas);
  let peak = 1e-6;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const step = samples.length / w;
  ctx.fillStyle = tok('--series-neutral');
  for (let x = 0; x < w; x++) {
    let m = 0;
    const end = Math.min(samples.length, Math.floor((x + 1) * step));
    for (let i = Math.floor(x * step); i < end; i++) m = Math.max(m, Math.abs(samples[i]));
    const hh = Math.max(1, (m / peak) * (h / 2 - 3));
    ctx.fillRect(x, h / 2 - hh, 1, hh * 2);
  }
}

/** Cuenta regresiva 3-2-1 en un elemento. Devuelve false si se canceló. */
export async function countdown(el, isCancelled, from = 3, ms = 600) {
  for (let i = from; i >= 1; i--) {
    if (isCancelled()) return false;
    el.textContent = `${i}…`;
    await sleep(ms);
  }
  if (isCancelled()) return false;
  el.textContent = '¡Silba!';
  return true;
}

/** Fila de barra HTML. */
export function barRow({ label, sub = '', pct, valueText, cls = '', mark = null, title = '' }) {
  const p = Math.max(0, Math.min(100, pct));
  return `<div class="bar-row ${cls}" ${title ? `title="${title}"` : ''}>
    <div class="lbl">${label}${sub ? `<small>${sub}</small>` : ''}</div>
    <div class="bar-track"><div class="bar-fill ${cls.includes('hi') ? 'hi' : ''} ${cls}" style="width:${p}%"></div>${
      mark != null ? `<div class="bar-mark" style="left:calc(${mark}% - 1px)"></div>` : ''
    }</div>
    <div class="val">${valueText}</div>
  </div>`;
}

export function micErrorMessage(e) {
  const name = e && e.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Permiso de micrófono denegado. Actívalo en el candado de la barra de direcciones y vuelve a intentar.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No se encontró ese micrófono. Conecta tus audífonos o elige otra entrada.';
  if (name === 'NotReadableError') return 'El micrófono está ocupado por otra aplicación.';
  return `No se pudo abrir el micrófono: ${e && e.message ? e.message : e}`;
}
