/**
 * Anotaciones del mapa de calor: convierte el análisis de una toma en recuadros, líneas y etiquetas
 * que muestran QUÉ toma el sistema (segmentos, contorno f₀, tono medio, rango, ruido y banda del filtro),
 * y en las tarjetas explicativas que se enlazan con esas marcas.
 */
import { midiToHz, noteName } from '../dsp/features.js';
import { fmt } from '../util.js';

/** 1000 → "1 kHz", 1500 → "1,5 kHz", 800 → "800 Hz". */
const fmtK = (v) => (v >= 1000 ? `${fmt(v / 1000, v % 1000 ? 1 : 0)} kHz` : `${fmt(v, 0)} Hz`);

/** Capas anotables. `color` es un token CSS (ver styles.css) y `shape` el icono de la tarjeta. */
export const LAYERS = {
  seg: { color: '--ann-seg', shape: 'box', name: 'Segmentos' },
  f0: { color: '--ann-f0', shape: 'line', name: 'Contorno f₀(t)' },
  pitch: { color: '--ann-pitch', shape: 'dash', name: 'Tono medio' },
  range: { color: '--ann-pitch', shape: 'band', name: 'Rango' },
  noise: { color: '--ann-noise', shape: 'noise', name: 'Ruido de fondo' },
  band: { color: '--ann-band', shape: 'band', name: 'Banda del filtro' },
};

const hz = (m) => (Number.isFinite(m) ? midiToHz(m) : NaN);

/** Tramos sin silbido (ruido de fondo) de al menos `minLen` segundos. */
export function unvoicedGaps(a, minLen = 0.25) {
  const { times, hop, fs } = a.frames;
  const dt = hop / fs;
  const v = a.voiced;
  const out = [];
  let s = -1;
  for (let t = 0; t <= v.length; t++) {
    const off = t < v.length && !v[t];
    if (off && s < 0) s = t;
    if (!off && s >= 0) {
      const t0 = s === 0 ? 0 : times[s] - dt / 2;
      const t1 = t >= v.length ? a.duration : times[t - 1] + dt / 2;
      if (t1 - t0 >= minLen) out.push({ start: t0, end: t1 });
      s = -1;
    }
  }
  return out;
}

/**
 * Capas para un `Plot` con mapa de calor en frecuencia (Hz).
 * `compact` quita las etiquetas largas (miniaturas y vistas pequeñas).
 */
export function buildAnnotations(a, { compact = false, fmax = 8000 } = {}) {
  const f = a.features;
  const fl = a.design.fl;
  const fh = a.design.fh;
  const layers = { bands: [], boxes: [], lines: [], hlines: [] };
  const info = [];

  // Banda del filtro: lo de fuera se oscurece (lo que el filtro descarta)
  layers.bands.push({ y0: 0, y1: fl, color: '#000000', alpha: 0.4, key: 'band' }, { y0: fh, y1: fmax, color: '#000000', alpha: 0.4, key: 'band' });
  layers.hlines.push(
    { y: fl, color: '--ann-band', dash: [6, 4], width: 1.2, key: 'band', chip: compact ? '' : `Filtro · desde ${fmtK(fl)}`, chipAlign: 'left' },
    { y: fh, color: '--ann-band', dash: [6, 4], width: 1.2, key: 'band', chip: compact ? '' : `Filtro · hasta ${fmtK(fh)}`, chipAlign: 'left', chipBelow: true },
  );

  if (!f.valid) return { layers, info };

  // Ruido de fondo: tramos sin silbido, de donde sale la referencia del SNR
  const gaps = unvoicedGaps(a);
  let longest = -1;
  gaps.forEach((g, i) => {
    if (longest < 0 || g.end - g.start > gaps[longest].end - gaps[longest].start) longest = i;
  });
  gaps.forEach((g, i) => {
    layers.boxes.push({
      x0: g.start,
      x1: g.end,
      y0: fl * 1.03,
      y1: fh * 0.97,
      color: '--ann-noise',
      dash: [4, 4],
      width: 1.2,
      fill: 0.06,
      radius: 6,
      key: 'noise',
      chip: !compact && i === longest ? `Ruido de fondo · SNR ${fmt(f.snrDb, 1)} dB` : '',
      chipInside: true,
      chipMinW: 150,
    });
    info.push({ kind: 'noise', x0: g.start, x1: g.end, y0: fl, y1: fh, title: 'Ruido de fondo', text: `${fmt(g.end - g.start, 2)} s sin silbido. De aquí sale la referencia de ruido del SNR (${fmt(f.snrDb, 1)} dB).` });
  });

  // Rango de tono (percentiles 5–95 %)
  const lo = hz(f.pitchLow);
  const hi = hz(f.pitchHigh);
  layers.boxes.push({
    x0: 0,
    x1: a.duration,
    y0: lo,
    y1: hi,
    color: '--ann-pitch',
    dash: [2, 5],
    width: 1,
    fill: 0.07,
    radius: 0,
    key: 'range',
    chip: compact ? '' : `Rango ${fmt(f.rangeSt, 1)} st`,
    chipInside: true,
  });
  layers.hlines.push({
    y: f.pitchHz,
    color: '--ann-pitch',
    dash: [8, 4],
    width: 1.4,
    key: 'pitch',
    chip: compact ? '' : `Tono medio ${fmt(f.pitchHz, 0)} Hz · ${noteName(f.pitchMidi)}`,
    chipAlign: 'right',
  });

  // Segmentos con silbido: un recuadro por tramo, numerado
  const { times } = a.frames;
  a.segments.forEach((s, i) => {
    let mn = Infinity;
    let mx = -Infinity;
    let sum = 0;
    let n = 0;
    for (let t = 0; t < times.length; t++) {
      if (times[t] < s.start || times[t] > s.end) continue;
      const h = hz(a.midi[t]);
      if (!Number.isFinite(h)) continue;
      if (h < mn) mn = h;
      if (h > mx) mx = h;
      sum += h;
      n++;
    }
    if (!n) return;
    const pad = Math.max(140, (mx - mn) * 0.18);
    const dur = s.end - s.start;
    layers.boxes.push({
      x0: s.start,
      x1: s.end,
      y0: Math.max(0, mn - pad),
      y1: mx + pad,
      color: '--ann-seg',
      fill: 0.08,
      width: 1.6,
      radius: 6,
      key: 'seg',
      badge: i + 1,
      chip: compact ? '' : `${fmt(dur, 2)} s · ${fmt(sum / n, 0)} Hz`,
      chipMinW: 96,
    });
    info.push({
      kind: 'seg',
      x0: s.start,
      x1: s.end,
      y0: mn - pad,
      y1: mx + pad,
      title: `Segmento ${i + 1}`,
      text: `${fmt(dur, 2)} s · ${fmt(sum / n, 0)} Hz medios · ${noteName(a.features.pitchMidi)} de referencia`,
    });
  });

  // Contorno f₀(t): la "melodía" que compara el DTW
  layers.lines.push({ x: a.frames.times, y: Float32Array.from(a.midi, hz), color: '--ann-f0', width: 2.2, casing: true, key: 'f0', noTip: true });
  return { layers, info };
}

/** Texto del tooltip si el cursor está dentro de un recuadro anotado. */
export function annotationTip(info, x, y) {
  const hit = info.filter((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
  if (!hit.length) return '';
  const b = hit.find((h) => h.kind === 'seg') || hit[0];
  return `<div class="tip-note"><b>${b.title}</b><br>${b.text}</div>`;
}

const KEY_SVG = {
  box: '<rect x="3" y="4" width="18" height="16" rx="4" fill="currentColor" fill-opacity=".16" stroke="currentColor" stroke-width="2"/>',
  line: '<path d="M2 17c4 0 4-10 8-10s3 8 6 8 3-6 6-6" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
  dash: '<path d="M2 12h20" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="5 4"/>',
  band: '<rect x="2" y="6" width="20" height="12" rx="2" fill="currentColor" fill-opacity=".2" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 3"/>',
  noise: '<rect x="3" y="5" width="18" height="14" rx="4" fill="currentColor" fill-opacity=".14" stroke="currentColor" stroke-width="2" stroke-dasharray="3 3"/>',
};

export const keyIcon = (shape) => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">${KEY_SVG[shape] || KEY_SVG.box}</svg>`;

/** Tarjetas que explican qué toma el sistema; cada una enlaza con una o más capas del mapa. */
export function featureCards(a) {
  const f = a.features;
  const d = a.design;
  const cards = [];
  if (f.valid) {
    cards.push(
      {
        id: 'seg',
        layers: ['seg'],
        shape: 'box',
        color: LAYERS.seg.color,
        label: 'Segmentos',
        value: `${f.segments} · ${fmt(f.durVoiced, 2)} s`,
        note: 'Tramos con un tono claro: un pico que concentra la energía y suena fuerte. Se necesitan al menos 0,3 s.',
      },
      {
        id: 'f0',
        layers: ['f0'],
        shape: 'line',
        color: LAYERS.f0.color,
        label: 'Contorno f₀(t)',
        value: `${fmt(f.jitterCents, 1)} cents`,
        note: 'Frecuencia del pico cada 10 ms. Es la melodía que compara el DTW. El valor es su estabilidad.',
      },
      {
        id: 'pitch',
        layers: ['pitch'],
        shape: 'dash',
        color: LAYERS.pitch.color,
        label: 'Tono medio',
        value: `${fmt(f.pitchHz, 0)} Hz`,
        note: `Mediana de f₀ dentro de los segmentos: ${noteName(f.pitchMidi)} (MIDI ${fmt(f.pitchMidi, 1)}).`,
      },
      {
        id: 'range',
        layers: ['range'],
        shape: 'band',
        color: LAYERS.range.color,
        label: 'Rango',
        value: `${fmt(f.rangeSt, 1)} st`,
        note: `Cuánto sube y baja la melodía (del 5 % al 95 %): ${noteName(f.pitchLow)} → ${noteName(f.pitchHigh)}.`,
      },
      {
        id: 'purity',
        layers: ['seg'],
        shape: 'box',
        color: LAYERS.seg.color,
        label: 'Pureza tonal',
        value: `${fmt(f.purity * 100, 0)} %`,
        note: 'Qué parte de la energía de la banda está en el pico de cada recuadro. Más alta = silbido más limpio.',
      },
      {
        id: 'snr',
        layers: ['noise', 'seg'],
        shape: 'noise',
        color: LAYERS.noise.color,
        label: 'SNR',
        value: `${fmt(f.snrDb, 1)} dB`,
        note: 'Tono de los recuadros frente al ruido de las zonas punteadas. Más alto = más fácil de reconocer.',
      },
    );
  }
  cards.push({
    id: 'band',
    layers: ['band'],
    shape: 'band',
    color: LAYERS.band.color,
    label: 'Banda del filtro',
    value: `${fmtK(d.fl)} – ${fmtK(d.fh)}`,
    note: 'Solo se analiza lo que pasa por el pasa-banda. Las zonas oscuras quedan descartadas.',
  });
  return cards;
}
