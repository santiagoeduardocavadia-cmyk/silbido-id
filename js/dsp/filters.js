/**
 * Diseño y aplicación de filtros pasa-banda.
 *
 *  - IIR Butterworth: prototipo analógico pasa-bajos → transformación pasa-banda
 *    s → (s² + Ω0²)/(B·s) → transformación bilineal con pre-distorsión (prewarping)
 *    → secciones de segundo orden (SOS / biquads).
 *  - FIR de fase lineal: sinc ideal pasa-banda truncada y suavizada con una ventana.
 *
 *  Ecuación en diferencias de cada biquad (forma directa II transpuesta):
 *    y[n] = b0·x[n] + b1·x[n−1] + b2·x[n−2] − a1·y[n−1] − a2·y[n−2]
 */
import { makeWindow } from './fft.js';

// ---------- aritmética compleja mínima ----------
const C = (re, im = 0) => ({ re, im });
const cadd = (a, b) => C(a.re + b.re, a.im + b.im);
const csub = (a, b) => C(a.re - b.re, a.im - b.im);
const cmul = (a, b) => C(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const cdiv = (a, b) => {
  const d = b.re * b.re + b.im * b.im;
  return C((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
};
const cscale = (a, k) => C(a.re * k, a.im * k);
const cabs = (a) => Math.hypot(a.re, a.im);
function csqrt(a) {
  const r = cabs(a);
  const re = Math.sqrt(Math.max(0, (r + a.re) / 2));
  let im = Math.sqrt(Math.max(0, (r - a.re) / 2));
  if (a.im < 0) im = -im;
  return C(re, im);
}

function checkBand(fl, fh, fs) {
  if (!(fl > 0 && fh > fl && fh < fs / 2)) {
    throw new Error(`Banda inválida: ${fl}–${fh} Hz con fs = ${fs} Hz`);
  }
}

/** Evalúa P(e^{jω}) = Σ c_k e^{−jωk}; devuelve módulo, fase y retardo de grupo Re(Σk·c_k e^{−jωk} / P). */
function polyEval(c, w) {
  let pr = 0;
  let pi = 0;
  let qr = 0;
  let qi = 0;
  for (let k = 0; k < c.length; k++) {
    const cw = Math.cos(w * k);
    const sw = Math.sin(w * k);
    pr += c[k] * cw;
    pi -= c[k] * sw;
    qr += k * c[k] * cw;
    qi -= k * c[k] * sw;
  }
  const d = pr * pr + pi * pi;
  return { abs: Math.sqrt(d), arg: Math.atan2(pi, pr), gd: d > 1e-24 ? (qr * pr + qi * pi) / d : NaN };
}

function biquadMag(s, w) {
  return polyEval([s[0], s[1], s[2]], w).abs / polyEval([s[3], s[4], s[5]], w).abs;
}

/**
 * Butterworth pasa-banda de orden 2N (N = orden del prototipo pasa-bajos).
 * Devuelve las secciones SOS [b0, b1, b2, 1, a1, a2], polos y ceros en z.
 */
export function butterBandpass(N, fl, fh, fs) {
  checkBand(fl, fh, fs);
  const fs2 = 2 * fs;
  // Pre-distorsión: Ω = 2·fs·tan(ω/2), con ω = 2πf/fs
  const wl = fs2 * Math.tan((Math.PI * fl) / fs);
  const wh = fs2 * Math.tan((Math.PI * fh) / fs);
  const B = wh - wl;
  const w0 = Math.sqrt(wl * wh);

  // Polos del prototipo Butterworth (semiplano izquierdo, |p| = 1)
  const polesS = [];
  for (let k = 0; k < N; k++) {
    const th = (Math.PI * (2 * k + N + 1)) / (2 * N);
    const p = C(Math.cos(th), Math.sin(th));
    // Cada polo p genera dos polos pasa-banda: raíces de s² − p·B·s + Ω0² = 0
    const pb = cscale(p, B);
    const sq = csqrt(csub(cmul(pb, pb), C(4 * w0 * w0)));
    polesS.push(cscale(cadd(pb, sq), 0.5), cscale(csub(pb, sq), 0.5));
  }

  // Transformación bilineal: z = (2fs + s) / (2fs − s)
  const polesZ = polesS.map((s) => cdiv(cadd(C(fs2), s), csub(C(fs2), s)));

  // Agrupar polos conjugados en biquads. Ceros: N en z = +1 (s = 0) y N en z = −1 (s = ∞)
  // → cada sección tiene numerador (1 − z⁻²) = [1, 0, −1].
  const sos = [];
  for (const p of polesZ) {
    if (p.im > 1e-10) sos.push([1, 0, -1, 1, -2 * p.re, p.re * p.re + p.im * p.im]);
  }
  const reals = polesZ
    .filter((p) => Math.abs(p.im) <= 1e-10)
    .map((p) => p.re)
    .sort((a, b) => a - b);
  for (let i = 0; i + 1 < reals.length; i += 2) {
    sos.push([1, 0, -1, 1, -(reals[i] + reals[i + 1]), reals[i] * reals[i + 1]]);
  }

  // Ganancia unitaria en la frecuencia central digital (|H| = 1 en Ω0 en el prototipo)
  const wc = 2 * Math.atan(w0 / fs2);
  for (const s of sos) {
    const g = biquadMag(s, wc);
    s[0] /= g;
    s[1] /= g;
    s[2] /= g;
  }
  // Ordenar de menor a mayor radio de polo (secciones más "agudas" al final)
  sos.sort((a, b) => a[5] - b[5]);

  return {
    kind: 'iir',
    name: `Butterworth IIR orden ${2 * N}`,
    N,
    order: 2 * N,
    fl,
    fh,
    fs,
    sos,
    poles: polesZ,
    zeros: [
      { re: 1, im: 0, mult: N },
      { re: -1, im: 0, mult: N },
    ],
    centerHz: (wc * fs) / (2 * Math.PI),
    analog: { wl, wh, w0, B },
  };
}

/** Magnitud teórica del Butterworth pasa-banda analógico, evaluada en la frecuencia pre-distorsionada. */
export function butterAnalogMag(design, f) {
  const { w0, B } = design.analog;
  const W = 2 * design.fs * Math.tan((Math.PI * f) / design.fs);
  const x = (W * W - w0 * w0) / (B * W);
  return 1 / Math.sqrt(1 + x ** (2 * design.N));
}

/**
 * FIR pasa-banda de fase lineal por el método de ventanas (numTaps impar → tipo I).
 *   h_ideal[m] = [sin(2π·fh·m/fs) − sin(2π·fl·m/fs)] / (π·m)
 *   h[n] = h_ideal[n − (M−1)/2] · w[n], normalizado a ganancia 1 en (fl+fh)/2
 */
export function firBandpass(numTaps, fl, fh, fs, win = 'hamming') {
  checkBand(fl, fh, fs);
  const M = numTaps % 2 === 0 ? numTaps + 1 : numTaps;
  const h = new Float64Array(M);
  const c = (M - 1) / 2;
  const w = makeWindow(win, M, true);
  const a = fl / fs;
  const b = fh / fs;
  for (let n = 0; n < M; n++) {
    const m = n - c;
    const ideal = m === 0 ? 2 * (b - a) : (Math.sin(2 * Math.PI * b * m) - Math.sin(2 * Math.PI * a * m)) / (Math.PI * m);
    h[n] = ideal * w[n];
  }
  const g = polyEval(h, (2 * Math.PI * ((fl + fh) / 2)) / fs).abs;
  for (let n = 0; n < M; n++) h[n] /= g;
  return {
    kind: 'fir',
    name: `FIR ${M} coeficientes (${win})`,
    numTaps: M,
    order: M - 1,
    fl,
    fh,
    fs,
    win,
    taps: h,
    delay: c,
  };
}

export function designFilter(cfg, fs) {
  return cfg.type === 'fir'
    ? firBandpass(cfg.taps, cfg.fl, cfg.fh, fs, cfg.win)
    : butterBandpass(cfg.order, cfg.fl, cfg.fh, fs);
}

/** Filtrado causal con biquads en cascada (forma directa II transpuesta). */
export function sosfilt(sos, x) {
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i];
  for (const s of sos) {
    const [b0, b1, b2, , a1, a2] = s;
    let z1 = 0;
    let z2 = 0;
    for (let n = 0; n < y.length; n++) {
      const xn = y[n];
      const yn = b0 * xn + z1;
      z1 = b1 * xn - a1 * yn + z2;
      z2 = b2 * xn - a2 * yn;
      y[n] = yn;
    }
  }
  return Float32Array.from(y);
}

/** Convolución directa y[n] = Σ h[k]·x[n−k] (FIR causal). */
export function firFilter(h, x) {
  const M = h.length;
  const n = x.length;
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    const kmax = i < M - 1 ? i : M - 1;
    for (let k = 0; k <= kmax; k++) acc += h[k] * x[i - k];
    y[i] = acc;
  }
  return y;
}

export function applyFilter(design, x) {
  return design.kind === 'fir' ? firFilter(design.taps, x) : sosfilt(design.sos, x);
}

/** Respuesta en frecuencia: magnitud (dB), fase y retardo de grupo (muestras). */
export function freqResponse(design, nPoints = 1024) {
  const fs = design.fs;
  const freqs = new Float64Array(nPoints);
  const magDb = new Float64Array(nPoints);
  const phase = new Float64Array(nPoints);
  const gd = new Float64Array(nPoints);
  for (let i = 0; i < nPoints; i++) {
    const f = ((i + 0.5) * (fs / 2)) / nPoints;
    const w = (2 * Math.PI * f) / fs;
    let mag = 1;
    let arg = 0;
    let tau = 0;
    if (design.kind === 'iir') {
      for (const s of design.sos) {
        const b = polyEval([s[0], s[1], s[2]], w);
        const a = polyEval([s[3], s[4], s[5]], w);
        mag *= b.abs / a.abs;
        arg += b.arg - a.arg;
        tau += b.gd - a.gd;
      }
    } else {
      const b = polyEval(design.taps, w);
      mag = b.abs;
      arg = b.arg;
      tau = b.gd;
    }
    freqs[i] = f;
    magDb[i] = 20 * Math.log10(Math.max(mag, 1e-12));
    phase[i] = arg;
    gd[i] = tau;
  }
  return { freqs, magDb, phase, gd };
}

export function impulseResponse(design, n = 200) {
  if (design.kind === 'fir') {
    const h = new Float32Array(Math.max(n, design.taps.length));
    h.set(design.taps);
    return h.subarray(0, Math.max(n, design.taps.length));
  }
  const d = new Float32Array(n);
  d[0] = 1;
  return sosfilt(design.sos, d);
}

/** Convierte SOS a la función de transferencia global B(z)/A(z) (convolución de polinomios). */
export function sosToTf(sos) {
  const conv = (p, q) => {
    const r = new Array(p.length + q.length - 1).fill(0);
    for (let i = 0; i < p.length; i++) for (let j = 0; j < q.length; j++) r[i + j] += p[i] * q[j];
    return r;
  };
  let b = [1];
  let a = [1];
  for (const s of sos) {
    b = conv(b, [s[0], s[1], s[2]]);
    a = conv(a, [s[3], s[4], s[5]]);
  }
  return { b, a };
}

/**
 * Raíces de un polinomio real (coeficientes de mayor a menor grado) por el método de Aberth–Ehrlich.
 * Se usa para dibujar los ceros del FIR en el plano z.
 */
export function polyRoots(coeffs, { maxIter = 600, tol = 1e-12 } = {}) {
  const a = Array.from(coeffs);
  while (a.length > 1 && Math.abs(a[0]) < 1e-300) a.shift();
  const atOrigin = [];
  while (a.length > 1 && Math.abs(a[a.length - 1]) < 1e-300) {
    a.pop();
    atOrigin.push(C(0, 0));
  }
  const n = a.length - 1;
  if (n < 1) return atOrigin;
  const c = a.map((v) => v / a[0]);
  // Radio inicial: media geométrica de |raíces| = |c_n|^(1/n)
  const r0 = Math.abs(c[n]) ** (1 / n) || 1;
  const z = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n + 0.4;
    z.push(C(r0 * Math.cos(t), r0 * Math.sin(t)));
  }
  for (let it = 0; it < maxIter; it++) {
    let maxStep = 0;
    for (let i = 0; i < n; i++) {
      // Horner: p(z) y p'(z)
      let p = C(1, 0);
      let dp = C(0, 0);
      for (let k = 1; k <= n; k++) {
        dp = cadd(cmul(dp, z[i]), p);
        p = cadd(cmul(p, z[i]), C(c[k], 0));
      }
      if (cabs(dp) === 0) continue;
      const ratio = cdiv(p, dp);
      let sum = C(0, 0);
      for (let j = 0; j < n; j++) {
        if (j !== i) sum = cadd(sum, cdiv(C(1, 0), csub(z[i], z[j])));
      }
      const denom = csub(C(1, 0), cmul(ratio, sum));
      const w = cdiv(ratio, denom);
      if (!Number.isFinite(w.re) || !Number.isFinite(w.im)) continue;
      z[i] = csub(z[i], w);
      maxStep = Math.max(maxStep, cabs(w) / (1 + cabs(z[i])));
    }
    if (maxStep < tol) break;
  }
  return z.concat(atOrigin);
}

/** Ceros y polos del FIR: H(z) = Σ h[n] z⁻ⁿ = z^−(M−1) · P(z) → M−1 polos en el origen. */
export function firZerosPoles(design) {
  const zeros = polyRoots(design.taps);
  return { zeros, poles: [{ re: 0, im: 0, mult: design.taps.length - 1 }] };
}

/** Genera un encabezado C para usar el filtro en el ESP32. */
export function toCHeader(design) {
  const f = (v) => {
    const s = v.toPrecision(9);
    return (s.includes('e') || s.includes('.') ? s : `${s}.0`) + 'f';
  };
  const lines = [];
  lines.push('// ===========================================================');
  lines.push('//  Filtro pasa-banda para el silbido — generado por Silbido ID');
  lines.push(`//  fs = ${design.fs} Hz · banda = ${Math.round(design.fl)}–${Math.round(design.fh)} Hz`);
  lines.push(`//  ${design.name}`);
  lines.push('// ===========================================================');
  lines.push('#pragma once');
  lines.push(`#define SILBIDO_FS ${design.fs}`);
  lines.push(`#define SILBIDO_FL ${f(design.fl)}`);
  lines.push(`#define SILBIDO_FH ${f(design.fh)}`);
  lines.push(`#define SILBIDO_FILTRO "${design.name.replace(/"/g, '')} · ${Math.round(design.fl)}-${Math.round(design.fh)} Hz"`);
  if (design.kind === 'iir') {
    const n = design.sos.length;
    lines.push(`#define SILBIDO_NUM_SECCIONES ${n}`);
    lines.push('');
    lines.push('// Cada fila: { b0, b1, b2, a1, a2 }  (a0 = 1)');
    lines.push('static const float SILBIDO_SOS[SILBIDO_NUM_SECCIONES][5] = {');
    for (const s of design.sos) lines.push(`  { ${[s[0], s[1], s[2], s[4], s[5]].map(f).join(', ')} },`);
    lines.push('};');
    lines.push('');
    lines.push('// Estado de cada sección (forma directa II transpuesta)');
    lines.push('static float silbido_z[SILBIDO_NUM_SECCIONES][2] = {{0}};');
    lines.push('');
    lines.push('static inline float silbido_filtrar(float x) {');
    lines.push('  for (int i = 0; i < SILBIDO_NUM_SECCIONES; i++) {');
    lines.push('    const float *c = SILBIDO_SOS[i];');
    lines.push('    float y = c[0] * x + silbido_z[i][0];');
    lines.push('    silbido_z[i][0] = c[1] * x - c[3] * y + silbido_z[i][1];');
    lines.push('    silbido_z[i][1] = c[2] * x - c[4] * y;');
    lines.push('    x = y;');
    lines.push('  }');
    lines.push('  return x;');
    lines.push('}');
  } else {
    const M = design.taps.length;
    lines.push(`#define SILBIDO_NUM_TAPS ${M}`);
    lines.push('');
    lines.push('static const float SILBIDO_H[SILBIDO_NUM_TAPS] = {');
    for (let i = 0; i < M; i += 6) {
      lines.push(`  ${Array.from(design.taps.slice(i, i + 6)).map(f).join(', ')},`);
    }
    lines.push('};');
    lines.push('');
    lines.push('// Línea de retardo circular');
    lines.push('static float silbido_buf[SILBIDO_NUM_TAPS] = {0};');
    lines.push('static int silbido_pos = 0;');
    lines.push('');
    lines.push('static inline float silbido_filtrar(float x) {');
    lines.push('  silbido_buf[silbido_pos] = x;');
    lines.push('  float acc = 0.0f;');
    lines.push('  int j = silbido_pos;');
    lines.push('  for (int k = 0; k < SILBIDO_NUM_TAPS; k++) {');
    lines.push('    acc += SILBIDO_H[k] * silbido_buf[j];');
    lines.push('    j = (j == 0) ? SILBIDO_NUM_TAPS - 1 : j - 1;');
    lines.push('  }');
    lines.push('  silbido_pos = (silbido_pos + 1) % SILBIDO_NUM_TAPS;');
    lines.push('  return acc;');
    lines.push('}');
  }
  lines.push('');
  return lines.join('\n');
}
