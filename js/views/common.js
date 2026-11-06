// Configuraciones y dibujos compartidos entre vistas.
import { fmt, fmtFreqTick, fmtHz, sleep } from '../util.js';
import { noteName, midiToHz } from '../dsp/features.js';
import { tok } from '../ui/plot.js';

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
