/**
 * Comparación de silbidos: DTW sobre el contorno de tono + distancias de características,
 * elección de la mejor toma y construcción del perfil (huella) de cada persona.
 */
import { mean, std } from './features.js';

/**
 * Dynamic Time Warping.  D(i,j) = |a_i − b_j| + min{D(i−1,j), D(i,j−1), D(i−1,j−1)}
 * Distancia normalizada = costo total / longitud del camino (semitonos promedio).
 */
export function dtw(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return { distance: Infinity, total: Infinity, path: [] };
  const W = m + 1;
  const D = new Float64Array((n + 1) * W).fill(Infinity);
  D[0] = 0;
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1];
    const row = i * W;
    const prev = (i - 1) * W;
    for (let j = 1; j <= m; j++) {
      const cost = Math.abs(ai - b[j - 1]);
      const p = D[prev + j];
      const q = D[row + j - 1];
      const r = D[prev + j - 1];
      D[row + j] = cost + (p < q ? (p < r ? p : r) : q < r ? q : r);
    }
  }
  let i = n;
  let j = m;
  const path = [[i - 1, j - 1]];
  while (i > 1 || j > 1) {
    if (i === 1) j--;
    else if (j === 1) i--;
    else {
      const r = D[(i - 1) * W + j - 1];
      const p = D[(i - 1) * W + j];
      const q = D[i * W + j - 1];
      if (r <= p && r <= q) {
        i--;
        j--;
      } else if (p < q) i--;
      else j--;
    }
    path.push([i - 1, j - 1]);
  }
  path.reverse();
  const total = D[n * W + m];
  return { distance: total / path.length, total, path };
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

export const SCORE_WEIGHTS = { snr: 0.25, duracion: 0.15, estabilidad: 0.15, pureza: 0.15, consistencia: 0.3 };

export function scoreTake(f, consistency, nValid) {
  if (!f.valid) return { total: 0, parts: null };
  const parts = {
    snr: clamp01((f.snrDb - 6) / 24),
    duracion: clamp01(f.durVoiced / 1.2) * (f.edgeCut ? 0.6 : 1),
    estabilidad: clamp01(1 - (f.jitterCents - 8) / 60),
    pureza: clamp01((f.purity - 0.35) / 0.5),
    consistencia: nValid > 1 && consistency != null ? clamp01(1 - consistency / 3) : 1,
  };
  let total = 0;
  for (const k in SCORE_WEIGHTS) total += SCORE_WEIGHTS[k] * parts[k];
  if (f.clipped) total *= 0.7;
  return { total: Math.round(total * 100), parts };
}

/** Ordena las tomas por puntaje. `analyses` puede tener huecos (null). */
export function rankTakes(analyses) {
  const items = [];
  analyses.forEach((a, idx) => {
    if (a) items.push({ idx, a, valid: a.features.valid });
  });
  const valid = items.filter((it) => it.valid);
  const pair = new Map();
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const d = dtw(valid[i].a.contour, valid[j].a.contour).distance;
      pair.set(`${valid[i].idx}-${valid[j].idx}`, d);
      pair.set(`${valid[j].idx}-${valid[i].idx}`, d);
    }
  }
  for (const it of items) {
    const ds = valid.filter((o) => o !== it).map((o) => pair.get(`${it.idx}-${o.idx}`));
    it.consistency = it.valid && ds.length ? mean(ds) : null;
    const s = scoreTake(it.a.features, it.consistency, valid.length);
    it.score = s.total;
    it.parts = s.parts;
  }
  items.sort((p, q) => q.score - p.score);
  const best = items.find((it) => it.valid);
  return {
    list: items.map(({ a, ...rest }) => rest),
    best: best ? best.idx : null,
    validCount: valid.length,
    pair,
  };
}

export const MIN_VALID_TAKES = 3;
export const REFS_PER_PROFILE = 3;

const FEATURE_KEYS = ['pitchMidi', 'pitchHz', 'rangeSt', 'durVoiced', 'segments', 'purity', 'snrDb', 'jitterCents', 'centroidHz'];
const pick = (f) => Object.fromEntries(FEATURE_KEYS.map((k) => [k, f[k]]));

/** Construye el perfil a partir de las mejores tomas. */
export function buildProfile({ name, analyses, filterCfg, fs }) {
  const rank = rankTakes(analyses);
  const valid = rank.list.filter((r) => r.valid);
  if (valid.length < MIN_VALID_TAKES) {
    throw new Error(`Se necesitan al menos ${MIN_VALID_TAKES} tomas con silbido detectado (hay ${valid.length}).`);
  }
  const refs = valid.slice(0, REFS_PER_PROFILE);
  const feats = refs.map((r) => analyses[r.idx].features);
  const contours = refs.map((r) => analyses[r.idx].contour);
  const intra = [];
  for (let i = 0; i < contours.length; i++) {
    for (let j = i + 1; j < contours.length; j++) intra.push(dtw(contours[i], contours[j]).distance);
  }
  const col = (k) => feats.map((f) => f[k]);
  const intraDtw = mean(intra);
  const summary = Object.fromEntries(FEATURE_KEYS.map((k) => [k, mean(col(k))]));
  const tolerances = {
    contour: Math.min(2, Math.max(0.6, 2.5 * intraDtw)),
    pitch: Math.max(0.6, 3 * std(col('pitchMidi'))),
    duration: Math.max(0.35, 3 * std(col('durVoiced'))),
    segments: Math.max(1, 3 * std(col('segments'))),
    purity: Math.max(0.08, 3 * std(col('purity'))),
  };
  return {
    version: 1,
    id: `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    createdAt: new Date().toISOString(),
    fs,
    filter: { ...filterCfg },
    bestTake: rank.best + 1,
    refs: refs.map((r, i) => ({
      take: r.idx + 1,
      score: r.score,
      contour: Array.from(contours[i]),
      features: pick(feats[i]),
    })),
    ranking: rank.list.map((r) => ({ take: r.idx + 1, score: r.score, valid: r.valid })),
    summary,
    tolerances,
    intraDtw,
  };
}

export const COMPONENTS = [
  { key: 'contour', label: 'Forma de la melodía (DTW)', unit: 'st', weight: 3 },
  { key: 'pitch', label: 'Tono medio', unit: 'st', weight: 2 },
  { key: 'duration', label: 'Duración con silbido', unit: 's', weight: 1 },
  { key: 'segments', label: 'Número de segmentos', unit: '', weight: 1 },
  { key: 'purity', label: 'Pureza tonal', unit: '%', weight: 1 },
];

/**
 * Compara una toma con un perfil. Cada característica se mide en "unidades de tolerancia"
 * (la variabilidad propia de la persona):  D = √( Σ wᵢ·(dᵢ/τᵢ)² / Σ wᵢ )
 * Se acepta si D ≤ T (rigurosidad). Similitud = 100·2^(−(D/T)²)  → 50 % justo en el umbral.
 */
export function compareToProfile(query, profile, strictness = 1) {
  const f = query.features;
  if (!f.valid) {
    return { valid: false, reason: 'No se detectó un silbido claro (se necesita al menos 0,3 s con tono).' };
  }
  let best = null;
  profile.refs.forEach((r, i) => {
    const d = dtw(query.contour, r.contour);
    if (!best || d.distance < best.distance) best = { ...d, refIndex: i };
  });
  const s = profile.summary;
  const tol = profile.tolerances;
  const values = {
    contour: best.distance,
    pitch: Math.abs(f.pitchMidi - s.pitchMidi),
    duration: Math.abs(f.durVoiced - s.durVoiced),
    segments: Math.abs(f.segments - s.segments),
    purity: Math.abs(f.purity - s.purity),
  };
  const components = COMPONENTS.map((c) => ({ ...c, value: values[c.key], tol: tol[c.key], ratio: values[c.key] / tol[c.key] }));
  const wsum = components.reduce((acc, c) => acc + c.weight, 0);
  const D = Math.sqrt(components.reduce((acc, c) => acc + c.weight * c.ratio * c.ratio, 0) / wsum);
  const T = strictness;
  return {
    valid: true,
    D,
    T,
    similarity: 100 * 2 ** (-((D / T) ** 2)),
    accepted: D <= T,
    components,
    dtw: best,
    refContour: profile.refs[best.refIndex].contour,
    refTake: profile.refs[best.refIndex].take,
  };
}
