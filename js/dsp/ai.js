/**
 * Inteligencia de Silbido ID: una red neuronal pequeña (perceptrón multicapa) escrita a mano,
 * sin librerías, que se entrena en el navegador con los perfiles guardados.
 *
 * Entrada (22 números por silbido):
 *   tono medio, rango, duración con silbido, segmentos, pureza, estabilidad (jitter)
 *   + la forma de la melodía: el contorno f0(t) menos su mediana, re-muestreado a 16 puntos.
 * Red: 22 → 24 (tanh) → K + 1 (softmax), una salida por perfil y una para "desconocido".
 *
 * Datos de entrenamiento (todo sale de los perfiles, no hace falta grabar más):
 *   · positivos: cada toma de referencia con variaciones realistas (±tono dentro de la tolerancia
 *     de la persona, más rápido/lento, ruido en el contorno, ±1 segmento…);
 *   · "desconocido": la misma melodía transpuesta fuera de la tolerancia (imitadores), melodías
 *     cambiadas con el mismo tono, y silbidos al azar.
 * Entrenamiento: Adam sobre la entropía cruzada, lote completo, semilla fija (siempre igual).
 */

const SHAPE = 16;
export const AI_GROUPS = [
  { key: 'melodia', label: 'Forma de la melodía', dims: Array.from({ length: SHAPE }, (_, i) => 6 + i) },
  { key: 'tono', label: 'Tono medio', dims: [0] },
  { key: 'rango', label: 'Rango', dims: [1] },
  { key: 'duracion', label: 'Duración', dims: [2] },
  { key: 'segmentos', label: 'Segmentos', dims: [3] },
  { key: 'pureza', label: 'Pureza tonal', dims: [4] },
  { key: 'estabilidad', label: 'Estabilidad', dims: [5] },
];
const DIM = 6 + SHAPE;
const HID = 24;
// escala de cada entrada (unidades "típicas" de variación)
const SCALE = [1.5, 2, 0.4, 1, 0.08, 0.15, ...Array(SHAPE).fill(1.5)];

/** Umbral de probabilidad para aceptar, según la rigurosidad T de la pestaña Verificar. */
export function aiThreshold(T) {
  return T >= 1.25 ? 0.5 : T <= 0.85 ? 0.75 : 0.6;
}

function rng(seed) {
  let s = seed >>> 0;
  const r = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.normal = () => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-12))) * Math.cos(2 * Math.PI * r());
  r.uni = (a, b) => a + (b - a) * r();
  return r;
}

function resampleTo(c, n) {
  const out = new Float64Array(n);
  if (!c.length) return out;
  for (let i = 0; i < n; i++) {
    const p = n === 1 ? 0 : (i * (c.length - 1)) / (n - 1);
    const a = Math.floor(p);
    const b = Math.min(c.length - 1, a + 1);
    out[i] = c[a] + (c[b] - c[a]) * (p - a);
  }
  return out;
}

const median = (arr) => {
  const a = Array.from(arr).sort((x, y) => x - y);
  return a.length ? a[a.length >> 1] : 0;
};

/** Huella numérica de un silbido: { contour, pitchMidi, rangeSt, durVoiced, segments, purity, jitterCents } → 22 números. */
export function embed(s) {
  const c = Array.from(s.contour || []);
  const m = median(c);
  const shape = resampleTo(
    c.map((v) => v - m),
    SHAPE,
  );
  return Float64Array.from([s.pitchMidi, s.rangeSt, s.durVoiced, s.segments, s.purity, (s.jitterCents || 0) / 100, ...shape]);
}

export const embedAnalysis = (a) => embed({ ...a.features, contour: a.contour });

// ---------- aumento de datos ----------
function variant(base, r, { shift = 0, stretch = 1, noise = 0.12, segJitter = true, tol }) {
  let c = Array.from(base.contour);
  if (stretch !== 1) c = Array.from(resampleTo(c, Math.max(4, Math.round(c.length * stretch))));
  c = c.map((v) => v + shift + noise * r.normal());
  let seg = base.segments;
  if (segJitter && r() < 0.2) seg = Math.max(1, seg + (r() < 0.5 ? -1 : 1));
  return {
    contour: c,
    pitchMidi: base.pitchMidi + shift,
    rangeSt: Math.max(0, base.rangeSt + 0.3 * r.normal()),
    durVoiced: Math.max(0.3, base.durVoiced * stretch),
    segments: seg,
    purity: Math.min(1, Math.max(0, base.purity + 0.3 * tol.purity * r.normal())),
    jitterCents: Math.max(0, (base.jitterCents || 10) * r.uni(0.8, 1.25)),
  };
}

function randomWhistle(r, pitchCenter) {
  const nNotes = 2 + Math.floor(r() * 5);
  const c = [];
  let note = 0;
  for (let k = 0; k < nNotes; k++) {
    note += Math.round(r.uni(-5, 5));
    const len = 8 + Math.floor(r() * 20);
    for (let i = 0; i < len; i++) c.push(pitchCenter + note + 0.1 * r.normal());
  }
  const m = median(c);
  const lo = Math.min(...c);
  const hi = Math.max(...c);
  return { contour: c, pitchMidi: m, rangeSt: hi - lo, durVoiced: c.length * 0.02, segments: nNotes, purity: r.uni(0.5, 0.97), jitterCents: r.uni(5, 40) };
}

/** Construye el conjunto de entrenamiento a partir de los perfiles. */
export function buildDataset(profiles, seed = 7) {
  const r = rng(seed);
  const K = profiles.length;
  const X = [];
  const Y = [];
  const PER_REF = 60;
  profiles.forEach((p, k) => {
    const tol = p.tolerances;
    for (const ref of p.refs) {
      const base = { ...ref.features, contour: ref.contour };
      X.push(embed(base));
      Y.push(k);
      for (let i = 0; i < PER_REF; i++) {
        const v = variant(base, r, { shift: 0.35 * tol.pitch * r.normal(), stretch: r.uni(0.85, 1.15), tol });
        X.push(embed(v));
        Y.push(k);
      }
      // "desconocido": imitadores (misma melodía, otro tono)
      for (let i = 0; i < PER_REF / 2; i++) {
        const sh = (r() < 0.5 ? -1 : 1) * Math.max(1.1, 1.8 * tol.pitch) * r.uni(1, 3.5);
        X.push(embed(variant(base, r, { shift: sh, stretch: r.uni(0.85, 1.15), tol })));
        Y.push(K);
      }
      // "desconocido": mismo tono, otra melodía (invertida, al revés o al azar)
      for (let i = 0; i < PER_REF / 3; i++) {
        const m = median(base.contour);
        const kind = i % 3;
        let c;
        if (kind === 0) c = base.contour.map((v) => 2 * m - v);
        else if (kind === 1) c = Array.from(base.contour).reverse();
        else c = randomWhistle(r, m).contour;
        const v = variant({ ...base, contour: c }, r, { stretch: r.uni(0.8, 1.2), tol });
        if (kind === 1 && Math.abs(v.contour[0] - v.contour[v.contour.length - 1]) < 1) continue; // melodía simétrica: no sirve como negativo
        X.push(embed(v));
        Y.push(K);
      }
    }
  });
  // "desconocido": silbidos al azar en todo el rango humano
  const nRand = Math.max(60, Math.round(X.length * 0.15));
  for (let i = 0; i < nRand; i++) {
    X.push(embed(randomWhistle(r, r.uni(80, 101))));
    Y.push(K);
  }
  return { X, Y, K };
}

// ---------- red neuronal ----------
function forward(net, x) {
  const { W1, b1, W2, b2, mu, C } = net;
  const xn = new Float64Array(DIM);
  for (let d = 0; d < DIM; d++) xn[d] = (x[d] - mu[d]) / SCALE[d];
  const h = new Float64Array(HID);
  for (let j = 0; j < HID; j++) {
    let s = b1[j];
    for (let d = 0; d < DIM; d++) s += W1[j * DIM + d] * xn[d];
    h[j] = Math.tanh(s);
  }
  const z = new Float64Array(C);
  let zmax = -Infinity;
  for (let c = 0; c < C; c++) {
    let s = b2[c];
    for (let j = 0; j < HID; j++) s += W2[c * HID + j] * h[j];
    z[c] = s;
    if (s > zmax) zmax = s;
  }
  let sum = 0;
  for (let c = 0; c < C; c++) {
    z[c] = Math.exp(z[c] - zmax);
    sum += z[c];
  }
  for (let c = 0; c < C; c++) z[c] /= sum;
  return { xn, h, p: z };
}

/** Entrena la red. Devuelve el modelo con su historial de pérdida y exactitud. */
export function trainModel(profiles, { epochs = 260, lr = 0.02, l2 = 1e-4, seed = 7 } = {}) {
  if (!profiles.length) return null;
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { X, Y, K } = buildDataset(profiles, seed);
  const C = K + 1;
  const n = X.length;
  const mu = new Float64Array(DIM);
  for (const x of X) for (let d = 0; d < DIM; d++) mu[d] += x[d] / n;
  const r = rng(seed + 1);
  const net = {
    W1: Float64Array.from({ length: HID * DIM }, () => r.normal() * Math.sqrt(1 / DIM)),
    b1: new Float64Array(HID),
    W2: Float64Array.from({ length: C * HID }, () => r.normal() * Math.sqrt(1 / HID)),
    b2: new Float64Array(C),
    mu,
    C,
  };
  // pesos por clase para que "desconocido" (muy numerosa) no domine
  const count = new Float64Array(C);
  for (const y of Y) count[y]++;
  const cw = Float64Array.from(count, (c) => (c ? n / (C * c) : 0));
  const params = ['W1', 'b1', 'W2', 'b2'];
  const m1 = Object.fromEntries(params.map((k) => [k, new Float64Array(net[k].length)]));
  const m2 = Object.fromEntries(params.map((k) => [k, new Float64Array(net[k].length)]));
  const g = Object.fromEntries(params.map((k) => [k, new Float64Array(net[k].length)]));
  const history = [];
  const b1m = 0.9;
  const b2m = 0.999;
  for (let ep = 1; ep <= epochs; ep++) {
    for (const k of params) g[k].fill(0);
    let loss = 0;
    let wsum = 0;
    let correct = 0;
    for (let i = 0; i < n; i++) {
      const { xn, h, p } = forward(net, X[i]);
      const y = Y[i];
      const w = cw[y];
      loss -= w * Math.log(p[y] + 1e-12);
      wsum += w;
      let am = 0;
      for (let c = 1; c < C; c++) if (p[c] > p[am]) am = c;
      if (am === y) correct++;
      const dz = new Float64Array(C);
      for (let c = 0; c < C; c++) dz[c] = w * (p[c] - (c === y ? 1 : 0));
      const dh = new Float64Array(HID);
      for (let c = 0; c < C; c++) {
        g.b2[c] += dz[c];
        for (let j = 0; j < HID; j++) {
          g.W2[c * HID + j] += dz[c] * h[j];
          dh[j] += dz[c] * net.W2[c * HID + j];
        }
      }
      for (let j = 0; j < HID; j++) {
        const da = dh[j] * (1 - h[j] * h[j]);
        g.b1[j] += da;
        for (let d = 0; d < DIM; d++) g.W1[j * DIM + d] += da * xn[d];
      }
    }
    for (const k of params) {
      const P = net[k];
      const G = g[k];
      const A = m1[k];
      const B = m2[k];
      const decay = k[0] === 'W' ? l2 : 0;
      for (let i = 0; i < P.length; i++) {
        const gi = G[i] / wsum + decay * P[i];
        A[i] = b1m * A[i] + (1 - b1m) * gi;
        B[i] = b2m * B[i] + (1 - b2m) * gi * gi;
        const ah = A[i] / (1 - b1m ** ep);
        const bh = B[i] / (1 - b2m ** ep);
        P[i] -= (lr * ah) / (Math.sqrt(bh) + 1e-8);
      }
    }
    if (ep === 1 || ep % 10 === 0 || ep === epochs) history.push({ epoch: ep, loss: loss / wsum, acc: correct / n });
  }
  // comprobación: las tomas reales de cada perfil deben salir con su nombre
  let refOk = 0;
  let refN = 0;
  profiles.forEach((p, k) => {
    for (const ref of p.refs) {
      const out = forward(net, embed({ ...ref.features, contour: ref.contour })).p;
      refN++;
      if (out.indexOf(Math.max(...out)) === k) refOk++;
    }
  });
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    net,
    names: profiles.map((p) => p.name),
    ids: profiles.map((p) => p.id),
    K,
    samples: n,
    epochs,
    history,
    accuracy: history[history.length - 1].acc,
    loss: history[history.length - 1].loss,
    refAccuracy: refN ? refOk / refN : 0,
    ms: t1 - t0,
    arch: `${DIM} → ${HID} (tanh) → ${C} (softmax)`,
  };
}

/** Probabilidades para un silbido ya analizado: { probs: [K], unknown }. */
export function predict(model, a) {
  const p = forward(model.net, embedAnalysis(a)).p;
  return { probs: Array.from(p.slice(0, model.K)), unknown: p[model.K] };
}

/**
 * Explicación por oclusión: para la clase k, cuánto cambia la confianza de la red (log-odds,
 * log(p/(1−p))) si se le "tapa" cada grupo de entradas (se reemplaza por el promedio del
 * entrenamiento). `contribution` es la parte de la decisión que aporta cada grupo (suma de
 * |aportes| = 1): positivo = empuja a favor de k; negativo = en contra.
 */
export function explain(model, a, k) {
  const x = embedAnalysis(a);
  const lo = (p) => {
    const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
    return Math.log(q / (1 - q));
  };
  const base = lo(forward(model.net, x).p[k]);
  const raw = AI_GROUPS.map((g) => {
    const xo = Float64Array.from(x);
    for (const d of g.dims) xo[d] = model.net.mu[d];
    return { ...g, logit: base - lo(forward(model.net, xo).p[k]) };
  });
  const tot = raw.reduce((s, g) => s + Math.abs(g.logit), 0) || 1;
  return raw.map((g) => ({ ...g, contribution: g.logit / tot })).sort((p, q) => Math.abs(q.contribution) - Math.abs(p.contribution));
}

/** Todo lo que pasa dentro de la red para un silbido: entradas, capa oculta y salidas. */
export function forwardDetail(model, a) {
  const x = a.length === DIM ? a : embedAnalysis(a);
  const { xn, h, p } = forward(model.net, x);
  return { x, xn, h, p };
}

/** Entrada "típica" de un perfil: el promedio de las huellas de sus tomas de referencia. */
export function profileEmbedding(p) {
  const acc = new Float64Array(DIM);
  for (const r of p.refs) {
    const e = embed({ ...r.features, contour: r.contour });
    for (let d = 0; d < DIM; d++) acc[d] += e[d] / p.refs.length;
  }
  return acc;
}

export const AI_INPUT_LABELS = ['Tono medio', 'Rango', 'Duración', 'Segmentos', 'Pureza', 'Estabilidad', ...Array.from({ length: SHAPE }, (_, i) => `Melodía ${i + 1}`)];
export const AI_SCALE = SCALE;
export const AI_DIM = DIM;
export const AI_HID = HID;

/** Clave para saber si hay que re-entrenar (cambiaron los perfiles). */
export const modelKey = (profiles) => profiles.map((p) => `${p.id}@${p.createdAt}`).join('|');
