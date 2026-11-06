/**
 * FFT radix-2 iterativa (Cooley–Tukey, decimación en el tiempo) y utilidades espectrales.
 *
 *   X[k] = Σ_{n=0}^{N-1} x[n] · e^(−j2πkn/N)
 *
 * Se implementa "a mano" (sin librerías) para que el código muestre el algoritmo del curso:
 * reordenamiento bit-reverso + etapas de mariposas (butterflies).
 */

const tables = new Map();

function getTables(n) {
  let t = tables.get(n);
  if (t) return t;
  if (!isPow2(n)) throw new Error(`FFT: N = ${n} no es potencia de 2`);
  const levels = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    let x = i;
    for (let b = 0; b < levels; b++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }
  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  t = { rev, cos, sin };
  tables.set(n, t);
  return t;
}

export function isPow2(n) {
  return n >= 2 && (n & (n - 1)) === 0;
}

export function nextPow2(n) {
  let p = 2;
  while (p < n) p <<= 1;
  return p;
}

/**
 * FFT compleja en el lugar. `re` e `im` son Float64Array de longitud potencia de 2.
 * Con inverse = true calcula la IFFT (incluye el factor 1/N).
 */
export function fft(re, im, inverse = false) {
  const n = re.length;
  const { rev, cos, sin } = getTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let tmp = re[i];
      re[i] = re[j];
      re[j] = tmp;
      tmp = im[i];
      im[i] = im[j];
      im[j] = tmp;
    }
  }
  const sgn = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = cos[k];
        const wi = sgn * sin[k];
        const a = i + j;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/**
 * Ventanas clásicas. symmetric = true para diseño de filtros FIR (denominador N−1);
 * false (periódica) para análisis espectral / STFT.
 */
export function makeWindow(type, N, symmetric = false) {
  const w = new Float64Array(N);
  const D = symmetric ? N - 1 : N;
  for (let n = 0; n < N; n++) {
    const t = D > 0 ? (2 * Math.PI * n) / D : 0;
    switch (type) {
      case 'rect':
        w[n] = 1;
        break;
      case 'hamming':
        w[n] = 0.54 - 0.46 * Math.cos(t);
        break;
      case 'blackman':
        w[n] = 0.42 - 0.5 * Math.cos(t) + 0.08 * Math.cos(2 * t);
        break;
      case 'hann':
      default:
        w[n] = 0.5 - 0.5 * Math.cos(t);
    }
  }
  return w;
}

export const WINDOW_NAMES = {
  hann: 'Hann',
  hamming: 'Hamming',
  blackman: 'Blackman',
  rect: 'Rectangular',
};

/**
 * Espectro de amplitud de un solo lado de toda la señal (ventana + zero-padding).
 * Devuelve |X[k]|·2/Σw (amplitud de una sinusoide ≈ su valor de pico).
 */
export function spectrum(x, fs, { win = 'hann', nfft = 0, fmax = fs / 2 } = {}) {
  const N = x.length;
  const n = nfft || nextPow2(N);
  const w = makeWindow(win, N, false);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let sw = 0;
  for (let i = 0; i < N; i++) {
    re[i] = x[i] * w[i];
    sw += w[i];
  }
  fft(re, im);
  const bins = Math.min(n / 2, Math.floor((fmax / fs) * n)) + 1;
  const mag = new Float32Array(bins);
  const scale = 2 / sw;
  for (let k = 0; k < bins; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * scale;
  return { mag, df: fs / n, nfft: n, bins, N };
}

/** Convierte amplitud a dB relativo a `ref`. */
export function toDb(mag, ref = 1, floorDb = -140) {
  const out = new Float32Array(mag.length);
  const r = ref > 0 ? ref : 1;
  for (let i = 0; i < mag.length; i++) {
    const v = mag[i] / r;
    out[i] = v > 0 ? Math.max(floorDb, 20 * Math.log10(v)) : floorDb;
  }
  return out;
}
