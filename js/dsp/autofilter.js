/**
 * Auto-sintonía del filtro: el sistema escucha las tomas y elige solo el filtro pasa-banda.
 *
 * 1. Sondeo: cada toma se analiza con un pre-filtro muy ancho (400–7000 Hz) para encontrar
 *    en qué rango silba la persona (f0 de las tramas con silbido) y cómo es el ruido de fondo
 *    (espectro medio de las tramas sin silbido).
 * 2. Candidatos: para 3 márgenes alrededor de ese rango se diseñan Butterworth IIR (orden 4–12)
 *    y FIR por ventanas (61–201 coeficientes × Hamming, Hann, Blackman).
 * 3. Puntaje analítico de cada candidato con su respuesta en frecuencia real:
 *      SNR estimada a la salida, pérdida y rizado sobre las notas del silbido, caída en los
 *      bordes del rango (nunca se puede cortar el rango), dispersión del retardo de grupo,
 *      margen de estabilidad en float32 y costo en el ESP32.
 * 4. Final IIR contra FIR: el mejor de cada familia analiza de verdad todas las tomas y gana el
 *    que obtiene mejor puntaje de calidad (el mismo que la web usa para elegir la mejor toma).
 *
 * Todo es determinista: las mismas tomas dan siempre el mismo filtro.
 */
import { trackFrames, detectVoicing, analyzeSignal, percentile, hzToMidi } from './features.js';
import { butterBandpass, designFilter, freqResponse, applyFilter } from './filters.js';
import { fft, makeWindow } from './fft.js';
import { rankTakes } from './matcher.js';

const NPSD = 1024; // FFT del sondeo de ruido → bins de 15,6 Hz a 16 kHz
const NB = NPSD / 2; // puntos de la respuesta en frecuencia (mismos bins)
const WHISTLE_MIN = 400;
const WHISTLE_MAX = 6000;
const MARGINS = [2.5, 4, 6]; // semitonos de holgura a cada lado del rango
const IIR_ORDERS = [2, 3, 4, 5, 6]; // orden del prototipo → pasa-banda de orden 4–12
const FIR_TAPS = [61, 101, 151, 201];
const FIR_WINS = ['hamming', 'hann', 'blackman'];

export const AUTO_WEIGHTS = {
  snr: 1, // dB de SNR a la salida
  loss: 2, // por dB de pérdida media sobre las notas
  ripple: 1, // por dB de rizado sobre las notas
  edge: 3, // por dB de caída en los bordes del rango (más de 1 dB)
  gd: 0.5, // por ms de dispersión del retardo de grupo
  cost: 0.002, // por multiplicación por muestra
  unstable: 3, // si algún polo |p| > 0,995 (riesgo en float32)
};

const round50 = (f) => Math.round(f / 50) * 50;

/** Etiqueta corta de una configuración. */
export function cfgLabel(c) {
  return c.type === 'iir' ? `IIR Butterworth orden ${2 * c.order}` : `FIR ${c.taps} coef. · ${c.win}`;
}

/** Paso 1: qué rango silba la persona y cómo es el ruido. */
export function surveyTakes(signals, fs) {
  const pre = butterBandpass(2, WHISTLE_MIN, Math.min(7000, 0.44 * fs), fs);
  const w = makeWindow('hann', NPSD, false);
  const re = new Float64Array(NPSD);
  const im = new Float64Array(NPSD);
  const sig = new Float64Array(NB + 1);
  const noise = new Float64Array(NB + 1);
  let nSig = 0;
  let nNoise = 0;
  const f0s = [];
  let takesUsed = 0;
  for (const x of signals) {
    const y = applyFilter(pre, x);
    const fr = trackFrames(y, fs, WHISTLE_MIN / 0.6, Math.min(7000, 0.44 * fs));
    const v = detectVoicing(fr);
    let nv = 0;
    for (let t = 0; t < fr.nFrames; t++) {
      if (v[t] && fr.f0[t] >= WHISTLE_MIN && fr.f0[t] <= WHISTLE_MAX) {
        f0s.push(fr.f0[t]);
        nv++;
      }
    }
    if (nv * (fr.hop / fs) >= 0.3) takesUsed++;
    // espectro de potencia de la señal original, cada 2 tramas
    let mu = 0;
    for (let i = 0; i < x.length; i++) mu += x[i];
    mu /= x.length || 1;
    for (let t = 0; t < fr.nFrames; t += 2) {
      const off = t * fr.hop;
      if (off + NPSD > x.length) break;
      for (let n = 0; n < NPSD; n++) {
        re[n] = (x[off + n] - mu) * w[n];
        im[n] = 0;
      }
      fft(re, im);
      const dst = v[t] ? sig : noise;
      for (let k = 0; k <= NB; k++) dst[k] += re[k] * re[k] + im[k] * im[k];
      if (v[t]) nSig++;
      else nNoise++;
    }
  }
  if (nSig) for (let k = 0; k <= NB; k++) sig[k] /= nSig;
  if (nNoise) for (let k = 0; k <= NB; k++) noise[k] /= nNoise;
  else {
    // sin tramas de silencio: el ruido se estima como el piso del espectro con silbido
    const floor = percentile(sig, 0.2);
    noise.fill(floor > 0 ? floor : 1e-12);
  }
  // componente del silbido = espectro con silbido − ruido
  const whistle = Float64Array.from(sig, (p, k) => Math.max(0, p - noise[k]));
  // histograma de f0 en los mismos bins (suavizado ±1 bin)
  const hist = new Float64Array(NB + 1);
  for (const f of f0s) {
    const k = Math.min(NB, Math.round((f * NPSD) / fs));
    hist[k] += 0.5;
    if (k > 0) hist[k - 1] += 0.25;
    if (k < NB) hist[k + 1] += 0.25;
  }
  const hs = hist.reduce((a, b) => a + b, 0);
  if (hs > 0) for (let k = 0; k <= NB; k++) hist[k] /= hs;
  return {
    frames: f0s.length,
    takesUsed,
    takes: signals.length,
    lo: f0s.length ? percentile(f0s, 0.03) : NaN,
    hi: f0s.length ? percentile(f0s, 0.97) : NaN,
    median: f0s.length ? percentile(f0s, 0.5) : NaN,
    hist,
    noise,
    whistle,
    df: fs / NPSD,
  };
}

function bandsFor(sv, fs) {
  const out = [];
  const seen = new Set();
  for (const m of MARGINS) {
    let fl = round50(sv.lo * 2 ** (-m / 12));
    let fh = round50(sv.hi * 2 ** (m / 12));
    fl = Math.max(250, fl);
    fh = Math.min(round50(0.46 * fs), fh);
    if (fh - fl < 600) {
      const c = (fl + fh) / 2;
      fl = Math.max(250, round50(c - 300));
      fh = Math.min(round50(0.46 * fs), fl + 600);
    }
    const k = `${fl}|${fh}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ margin: m, fl, fh });
    }
  }
  return out;
}

/** Paso 3: puntaje analítico de un diseño contra lo que se midió en las tomas. */
export function scoreDesign(design, sv) {
  const fs = design.fs;
  const r = freqResponse(design, NB);
  const at = (k) => r.magDb[Math.max(0, Math.min(NB - 1, k))];
  const kLo = Math.round(sv.lo / sv.df);
  const kHi = Math.round(sv.hi / sv.df);
  let keep = 0;
  let meanDb = 0;
  let sOut = 0;
  let nOut = 0;
  let sIn = 0;
  let nIn = 0;
  for (let k = 0; k <= NB; k++) {
    const db = Math.max(-60, at(k));
    const g = 10 ** (at(k) / 10);
    keep += sv.hist[k] * g;
    meanDb += sv.hist[k] * db;
    sOut += g * sv.whistle[k];
    nOut += g * sv.noise[k];
    sIn += sv.whistle[k];
    nIn += sv.noise[k];
  }
  let ripVar = 0;
  for (let k = 0; k <= NB; k++) ripVar += sv.hist[k] * (Math.max(-60, at(k)) - meanDb) ** 2;
  const edgeDb = Math.max(0, -Math.min(at(kLo), at(kHi)));
  let gdMin = Infinity;
  let gdMax = -Infinity;
  let gdSum = 0;
  let gdN = 0;
  for (let k = Math.max(0, kLo); k <= Math.min(NB - 1, kHi); k++) {
    const g = r.gd[k];
    gdMin = Math.min(gdMin, g);
    gdMax = Math.max(gdMax, g);
    gdSum += g;
    gdN++;
  }
  const cost = design.kind === 'iir' ? 5 * design.sos.length : design.taps.length;
  const poleR = design.kind === 'iir' ? Math.max(...design.sos.map((s) => Math.sqrt(Math.abs(s[5])))) : 0;
  const m = {
    snrDb: 10 * Math.log10((sOut + 1e-30) / (nOut + 1e-30)),
    snrInDb: 10 * Math.log10((sIn + 1e-30) / (nIn + 1e-30)),
    lossDb: -10 * Math.log10(Math.max(keep, 1e-12)),
    rippleDb: Math.sqrt(ripVar),
    edgeDb,
    gdSpreadMs: gdN ? ((gdMax - gdMin) / fs) * 1000 : 0,
    latencyMs: gdN ? (gdSum / gdN / fs) * 1000 : 0,
    cost,
    poleR,
  };
  const W = AUTO_WEIGHTS;
  m.score =
    W.snr * m.snrDb -
    W.loss * m.lossDb -
    W.ripple * m.rippleDb -
    W.edge * Math.max(0, m.edgeDb - 1) -
    W.gd * m.gdSpreadMs -
    W.cost * m.cost -
    (poleR > 0.995 ? W.unstable : 0);
  return m;
}

/** Paso 4: el filtro analiza de verdad las tomas; calidad = puntaje medio (tomas inválidas = 0). */
function evaluateOnTakes(design, signals, fs) {
  const analyses = signals.map((x) => analyzeSignal(x, fs, design));
  const rank = rankTakes(analyses);
  const q = rank.list.reduce((s, r) => s + r.score, 0) / Math.max(1, signals.length);
  return { analyses, quality: q, valid: rank.validCount };
}

/**
 * Elige el filtro para un conjunto de tomas (Float32Array a fs).
 * Devuelve { status, cfg, survey, candidates, finalists, winner, reasons, analyses }.
 */
export function autoTuneFilter(signals, fs, fallback) {
  const list = signals.filter(Boolean);
  if (!list.length) return { status: 'empty', cfg: { ...fallback }, reasons: [] };
  const sv = surveyTakes(list, fs);
  if (sv.frames < 30 || !Number.isFinite(sv.lo)) {
    return {
      status: 'no-whistle',
      cfg: { ...fallback },
      survey: sv,
      reasons: ['No encontré suficiente silbido en las tomas: se mantiene el filtro provisional (1–4 kHz).'],
    };
  }
  const base = { ...fallback };
  const candidates = [];
  for (const b of bandsFor(sv, fs)) {
    for (const order of IIR_ORDERS) {
      const cfg = { ...base, type: 'iir', fl: b.fl, fh: b.fh, order };
      candidates.push({ cfg, margin: b.margin, family: 'iir', metrics: scoreDesign(designFilter(cfg, fs), sv) });
    }
    for (const taps of FIR_TAPS) {
      for (const win of FIR_WINS) {
        const cfg = { ...base, type: 'fir', fl: b.fl, fh: b.fh, taps, win };
        candidates.push({ cfg, margin: b.margin, family: 'fir', metrics: scoreDesign(designFilter(cfg, fs), sv) });
      }
    }
  }
  candidates.sort((a, b) => b.metrics.score - a.metrics.score);
  const finalists = {};
  for (const fam of ['iir', 'fir']) {
    const c = candidates.find((x) => x.family === fam);
    const ev = evaluateOnTakes(designFilter(c.cfg, fs), list, fs);
    finalists[fam] = { ...c, quality: ev.quality, valid: ev.valid, analyses: ev.analyses };
    // puntaje final: calidad real en las tomas + desempate con el puntaje analítico
    finalists[fam].final = ev.quality + 0.3 * c.metrics.score;
  }
  const winner = finalists.iir.final >= finalists.fir.final ? 'iir' : 'fir';
  const W = finalists[winner];
  const L = finalists[winner === 'iir' ? 'fir' : 'iir'];
  const cfg = { ...W.cfg, auto: true };

  const fmt = (v, d = 0) => v.toFixed(d).replace('.', ',');
  const reasons = [
    `Escuché ${sv.takes} toma${sv.takes > 1 ? 's' : ''} (${sv.takesUsed} con silbido claro): silbas entre ${fmt(sv.lo)} y ${fmt(sv.hi)} Hz, con centro en ${fmt(sv.median)} Hz.`,
    `Probé ${candidates.length} filtros (${candidates.filter((c) => c.family === 'iir').length} IIR y ${candidates.filter((c) => c.family === 'fir').length} FIR) con bandas de ${fmt(MARGINS[0], 1)} a ${MARGINS[MARGINS.length - 1]} semitonos de holgura alrededor de tu rango.`,
    `Elegí la banda ${fmt(cfg.fl)}–${fmt(cfg.fh)} Hz: deja pasar todas tus notas (caída en los bordes de ${fmt(W.metrics.edgeDb, 1)} dB) y sube la relación señal/ruido de ${fmt(W.metrics.snrInDb, 1)} a ${fmt(W.metrics.snrDb, 1)} dB.`,
    Math.abs(W.quality - L.quality) < 1
      ? `En la final, ${cfgLabel(W.cfg)} y ${cfgLabel(L.cfg)} empataron en calidad sobre tus tomas (${fmt(W.quality)} puntos). Desempató la respuesta en frecuencia: ${fmt(W.metrics.score, 2)} contra ${fmt(L.metrics.score, 2)}.`
      : `En la final, ${cfgLabel(W.cfg)} obtuvo ${fmt(W.quality)} puntos de calidad con ${W.valid} toma${W.valid === 1 ? '' : 's'} válida${W.valid === 1 ? '' : 's'}, contra ${fmt(L.quality)} puntos de ${cfgLabel(L.cfg)}.`,
  ];
  return { status: 'ok', cfg, survey: sv, candidates, finalists, winner, reasons, analyses: W.analyses };
}
