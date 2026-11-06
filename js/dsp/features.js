/**
 * Extracción de características del silbido ("huella").
 *
 * Cadena: x[n] → filtro pasa-banda → STFT (tramas de 64 ms, salto de 10 ms)
 *         → pico espectral + interpolación parabólica = f0(t)
 *         → detección de actividad (pureza tonal + energía) → segmentos
 *         → características: tono, rango, duración, segmentos, pureza, SNR, estabilidad.
 */
import { fft, makeWindow } from './fft.js';
import { applyFilter } from './filters.js';

export const FRAME = { N: 1024, hop: 160, nfft: 2048 };

const NOTE_NAMES = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];

export const hzToMidi = (f) => 69 + 12 * Math.log2(f / 440);
export const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12);

export function noteName(m) {
  if (!Number.isFinite(m)) return '—';
  const r = Math.round(m);
  return NOTE_NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
}

export function percentile(arr, p) {
  const a = Array.from(arr).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const i = (a.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}
export const median = (a) => percentile(a, 0.5);
export const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
export function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

/** Análisis trama a trama sobre la señal filtrada. */
export function trackFrames(y, fs, fl, fh) {
  const { N, hop, nfft } = FRAME;
  const w = makeWindow('hann', N, false);
  const nFrames = y.length >= N ? 1 + Math.floor((y.length - N) / hop) : 0;
  const kLo = Math.max(2, Math.floor((0.6 * fl * nfft) / fs));
  const kHi = Math.min(nfft / 2 - 2, Math.ceil((Math.min(1.15 * fh, 0.47 * fs) * nfft) / fs));
  const f0 = new Float32Array(nFrames);
  const eDb = new Float32Array(nFrames);
  const eShort = new Float32Array(nFrames);
  const purity = new Float32Array(nFrames);
  const centroid = new Float32Array(nFrames);
  const times = new Float32Array(nFrames);
  const peakE = new Float64Array(nFrames);
  const totE = new Float64Array(nFrames);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const P = new Float64Array(nfft / 2 + 1);
  const ldb = (v) => 10 * Math.log10(v + 1e-30);

  for (let t = 0; t < nFrames; t++) {
    const off = t * hop;
    re.fill(0);
    im.fill(0);
    for (let n = 0; n < N; n++) re[n] = y[off + n] * w[n];
    fft(re, im);
    let tot = 0;
    let fw = 0;
    let kmax = kLo;
    let pmax = -1;
    for (let k = kLo; k <= kHi; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      P[k] = p;
      tot += p;
      fw += p * k;
      if (p > pmax) {
        pmax = p;
        kmax = k;
      }
    }
    // Comprobación de subarmónico: si hay un pico en f/2 a menos de 20 dB, ese es el fundamental.
    const kh = Math.round(kmax / 2);
    if (kh - 2 >= kLo) {
      let best = kh;
      let pb = -1;
      for (let k = kh - 2; k <= kh + 2; k++) {
        if (P[k] > pb) {
          pb = P[k];
          best = k;
        }
      }
      if (pb > pmax * 0.01) {
        kmax = best;
        pmax = pb;
      }
    }
    // Interpolación parabólica del pico (en dB): δ = ½(α − γ)/(α − 2β + γ)
    let delta = 0;
    if (kmax > kLo && kmax < kHi) {
      const a = ldb(P[kmax - 1]);
      const b = ldb(P[kmax]);
      const c = ldb(P[kmax + 1]);
      const den = a - 2 * b + c;
      if (den < 0) delta = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
    }
    f0[t] = ((kmax + delta) * fs) / nfft;
    let pe = 0;
    for (let k = Math.max(kLo, kmax - 4); k <= Math.min(kHi, kmax + 4); k++) pe += P[k];
    peakE[t] = pe;
    totE[t] = tot;
    purity[t] = tot > 0 ? pe / tot : 0;
    eDb[t] = ldb(tot);
    centroid[t] = tot > 0 ? ((fw / tot) * fs) / nfft : 0;
    times[t] = (off + N / 2) / fs;
    // Energía de corto plazo (20 ms) alrededor del centro de la trama: detecta pausas entre notas
    const c0 = off + N / 2 - SHORT_HALF;
    let es = 0;
    for (let n = c0; n < c0 + 2 * SHORT_HALF; n++) es += y[n] * y[n];
    eShort[t] = ldb(es / (2 * SHORT_HALF));
  }
  return { f0, eDb, eShort, purity, centroid, times, peakE, totE, hop, N, fs, nFrames };
}

const SHORT_HALF = 160; // 10 ms a 16 kHz

function fillGaps(v, maxGap) {
  let last = -1;
  for (let t = 0; t < v.length; t++) {
    if (v[t]) {
      if (last >= 0 && t - last - 1 > 0 && t - last - 1 <= maxGap) for (let u = last + 1; u < t; u++) v[u] = 1;
      last = t;
    }
  }
}

export function runs(v) {
  const out = [];
  let a = -1;
  for (let t = 0; t <= v.length; t++) {
    const on = t < v.length && v[t];
    if (on && a < 0) a = t;
    if (!on && a >= 0) {
      out.push({ a, b: t - 1 });
      a = -1;
    }
  }
  return out;
}

/**
 * Trama con silbido = pico dominante (pureza ≥ 0,35), energía de la trama a menos de 35 dB del
 * máximo y energía de corto plazo (20 ms) a menos de 25 dB del máximo (separa notas).
 */
export function detectVoicing(fr, { purityMin = 0.35, relDb = 35, relShortDb = 25, minRun = 5, maxGap = 3 } = {}) {
  const v = new Uint8Array(fr.nFrames);
  if (!fr.nFrames) return v;
  const eMax = percentile(fr.eDb, 0.98);
  const esMax = percentile(fr.eShort, 0.98);
  for (let t = 0; t < fr.nFrames; t++) {
    v[t] = fr.purity[t] >= purityMin && fr.eDb[t] >= eMax - relDb && fr.eShort[t] >= esMax - relShortDb ? 1 : 0;
  }
  fillGaps(v, maxGap);
  for (const r of runs(v)) if (r.b - r.a + 1 < minRun) for (let t = r.a; t <= r.b; t++) v[t] = 0;
  return v;
}

/**
 * Análisis completo de una toma. `design` es el filtro (IIR o FIR) ya diseñado.
 */
export function analyzeSignal(x, fs, design) {
  const y = applyFilter(design, x);
  const fr = trackFrames(y, fs, design.fl, design.fh);
  const voiced = detectVoicing(fr);
  const segIdx = runs(voiced);
  const dt = fr.hop / fs;

  // Contorno de tono suavizado con mediana de 5 tramas dentro de cada segmento
  const midi = new Float32Array(fr.nFrames).fill(NaN);
  for (const s of segIdx) {
    for (let t = s.a; t <= s.b; t++) {
      const vals = [];
      for (let u = Math.max(s.a, t - 2); u <= Math.min(s.b, t + 2); u++) vals.push(fr.f0[u]);
      vals.sort((p, q) => p - q);
      midi[t] = hzToMidi(vals[vals.length >> 1]);
    }
  }

  const vIdx = [];
  const uIdx = [];
  for (let t = 0; t < fr.nFrames; t++) (voiced[t] ? vIdx : uIdx).push(t);

  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
  }

  const durVoiced = vIdx.length * dt;
  const features = {
    valid: durVoiced >= 0.3,
    durVoiced,
    peakDb: 20 * Math.log10(peak + 1e-12),
    clipped: peak >= 0.985,
    segments: segIdx.length,
  };

  if (vIdx.length) {
    const m = vIdx.map((t) => midi[t]);
    features.pitchMidi = median(m);
    features.pitchHz = midiToHz(features.pitchMidi);
    features.pitchLow = percentile(m, 0.05);
    features.pitchHigh = percentile(m, 0.95);
    features.rangeSt = features.pitchHigh - features.pitchLow;
    features.purity = mean(vIdx.map((t) => fr.purity[t]));
    features.centroidHz = mean(vIdx.map((t) => fr.centroid[t]));
    const d = [];
    for (const s of segIdx) for (let t = s.a + 1; t <= s.b; t++) d.push(Math.abs(midi[t] - midi[t - 1]) * 100);
    features.jitterCents = d.length ? median(d) : 0;
    const sig = mean(vIdx.map((t) => fr.peakE[t]));
    const noise =
      uIdx.length >= 0.1 * fr.nFrames
        ? median(uIdx.map((t) => fr.totE[t]))
        : median(vIdx.map((t) => fr.totE[t] - fr.peakE[t]));
    features.snrDb = 10 * Math.log10(sig / Math.max(noise, sig * 1e-6, 1e-30));
    features.start = fr.times[segIdx[0].a] - dt / 2;
    features.end = fr.times[segIdx[segIdx.length - 1].b] + dt / 2;
    features.span = features.end - features.start;
    features.edgeCut = features.start < 0.1 || features.end > x.length / fs - 0.1;
  }

  // Secuencia para DTW: tono (semitonos MIDI) de las tramas con silbido, cada 20 ms
  const contour = Float32Array.from(vIdx.filter((_, i) => i % 2 === 0).map((t) => Math.round(midi[t] * 100) / 100));

  return {
    fs,
    duration: x.length / fs,
    x,
    y,
    frames: fr,
    voiced,
    midi,
    segments: segIdx.map((s) => ({ start: fr.times[s.a] - dt / 2, end: fr.times[s.b] + dt / 2 })),
    features,
    contour,
    design,
  };
}
