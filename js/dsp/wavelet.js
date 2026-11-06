/**
 * Wavelets: CWT con Morlet (escalograma) y DWT multinivel Daubechies-4 (banco de filtros).
 *
 * CWT:  W(a, b) = ∫ x(t) · (1/√a) · ψ*((t − b)/a) dt
 *  Se calcula en frecuencia: W_a = IFFT{ X(ω) · Ψ*(aω) }, con Ψ(ω) = e^{−(ω − ω0)²/2} (ω > 0).
 *  Escala ↔ frecuencia: a = ω0 / (2π f).
 *
 * DWT:  x → (A1, D1),  A1 → (A2, D2), ...   con filtros h (pasa-bajos) y g (pasa-altos) + diezmado ×2.
 */
import { fft, nextPow2 } from './fft.js';

export function logspace(a, b, n) {
  const out = new Float64Array(n);
  const la = Math.log(a);
  const lb = Math.log(b);
  for (let i = 0; i < n; i++) out[i] = Math.exp(la + ((lb - la) * i) / Math.max(1, n - 1));
  return out;
}

/**
 * Escalograma (magnitud en dB). Para cada frecuencia se aplica un filtro gaussiano analítico
 * con ganancia 1 en su centro, de modo que una sinusoide de amplitud A da |W| ≈ A.
 * Para no guardar millones de valores, el tiempo se reduce tomando el máximo de cada bloque.
 */
export function cwtMorlet(x, fs, { fmin = 250, fmax = 7000, nScales = 64, w0 = 6, decim = 40, onProgress = null } = {}) {
  const n = x.length;
  const nfft = nextPow2(n + Math.ceil(0.05 * fs));
  const Xr = new Float64Array(nfft);
  const Xi = new Float64Array(nfft);
  for (let i = 0; i < n; i++) Xr[i] = x[i];
  fft(Xr, Xi);
  const freqs = logspace(fmin, Math.min(fmax, fs * 0.49), nScales);
  const cols = Math.ceil(n / decim);
  const data = new Float32Array(cols * nScales);
  const Wr = new Float64Array(nfft);
  const Wi = new Float64Array(nfft);
  const domega = (2 * Math.PI * fs) / nfft;
  for (let r = 0; r < nScales; r++) {
    const s = w0 / (2 * Math.PI * freqs[r]);
    Wr.fill(0);
    Wi.fill(0);
    // Solo donde la gaussiana es apreciable: |s·ω − ω0| < 7
    const kmin = Math.max(1, Math.floor((w0 - 7) / s / domega));
    const kmax = Math.min(nfft / 2 - 1, Math.ceil((w0 + 7) / s / domega));
    for (let k = kmin; k <= kmax; k++) {
      const d = s * k * domega - w0;
      const g = 2 * Math.exp(-0.5 * d * d);
      Wr[k] = g * Xr[k];
      Wi[k] = g * Xi[k];
    }
    fft(Wr, Wi, true);
    for (let c = 0; c < cols; c++) {
      let m = 0;
      const end = Math.min(n, (c + 1) * decim);
      for (let i = c * decim; i < end; i++) {
        const v = Wr[i] * Wr[i] + Wi[i] * Wi[i];
        if (v > m) m = v;
      }
      data[c * nScales + r] = m > 1e-20 ? 10 * Math.log10(m) : -200;
    }
    if (onProgress) onProgress((r + 1) / nScales);
  }
  return {
    data,
    cols,
    rows: nScales,
    freqs,
    fs,
    x0: 0,
    x1: (cols * decim) / fs,
    // bordes de fila en escala logarítmica (medio paso por encima/debajo)
    y0: freqs[0] / Math.sqrt(freqs[1] / freqs[0]),
    y1: freqs[nScales - 1] * Math.sqrt(freqs[1] / freqs[0]),
    w0,
  };
}

// Daubechies-4 (8 coeficientes), filtro pasa-bajos de descomposición (convención PyWavelets 'db4').
export const DB4_LO = [
  -0.010597401784997278, 0.032883011666982945, 0.030841381835986965, -0.18703481171888114, -0.02798376941698385,
  0.6308807679295904, 0.7148465705525415, 0.23037781330885523,
];
// Filtro espejo en cuadratura: g[n] = (−1)^(n+1) · h[L−1−n]
export const DB4_HI = DB4_LO.map((_, n) => (n % 2 === 0 ? -1 : 1) * DB4_LO[DB4_LO.length - 1 - n]);

/**
 * DWT multinivel con extensión periódica (transformada ortogonal → se conserva la energía).
 */
export function dwt(x, fs, levels = 5) {
  const block = 2 ** levels;
  const len = Math.ceil(x.length / block) * block;
  let a = new Float64Array(len);
  a.set(x);
  const lo = DB4_LO;
  const hi = DB4_HI;
  const L = lo.length;
  const details = [];
  for (let l = 1; l <= levels; l++) {
    const n = a.length;
    const half = n >> 1;
    const ca = new Float64Array(half);
    const cd = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      let sa = 0;
      let sd = 0;
      for (let m = 0; m < L; m++) {
        const v = a[(2 * k + m) % n];
        sa += lo[m] * v;
        sd += hi[m] * v;
      }
      ca[k] = sa;
      cd[k] = sd;
    }
    details.push(cd);
    a = ca;
  }
  const energy = (arr) => arr.reduce((s, v) => s + v * v, 0);
  const bands = details.map((d, i) => ({
    name: `D${i + 1}`,
    fLo: fs / 2 ** (i + 2),
    fHi: fs / 2 ** (i + 1),
    coeffs: d,
    dt: 2 ** (i + 1) / fs,
    energy: energy(d),
  }));
  bands.push({
    name: `A${levels}`,
    fLo: 0,
    fHi: fs / 2 ** (levels + 1),
    coeffs: a,
    dt: 2 ** levels / fs,
    energy: energy(a),
  });
  const total = bands.reduce((s, b) => s + b.energy, 0) || 1;
  for (const b of bands) b.share = b.energy / total;
  return { bands, levels, totalEnergy: total, signalEnergy: energy(x), length: len };
}
