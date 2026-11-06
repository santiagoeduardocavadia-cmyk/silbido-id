/**
 * STFT y espectrograma.
 *   X(m, k) = Σ_n x[n + m·H] · w[n] · e^(−j2πkn/N)
 * Resultado en dB (amplitud), organizado por columnas (una columna = una trama).
 */
import { fft, makeWindow, nextPow2 } from './fft.js';

export function stft(x, fs, { N = 512, overlap = 0.75, win = 'hann', fmax = fs / 2, zeroPad = 1 } = {}) {
  const hop = Math.max(1, Math.round(N * (1 - overlap)));
  const nfft = nextPow2(N * zeroPad);
  const w = makeWindow(win, N, false);
  let sw = 0;
  for (let i = 0; i < N; i++) sw += w[i];
  const frames = x.length >= N ? 1 + Math.floor((x.length - N) / hop) : 1;
  const bins = Math.min(nfft / 2, Math.floor((fmax / fs) * nfft)) + 1;
  const data = new Float32Array(frames * bins);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const scale = 2 / sw;
  for (let f = 0; f < frames; f++) {
    re.fill(0);
    im.fill(0);
    const off = f * hop;
    for (let n = 0; n < N && off + n < x.length; n++) re[n] = x[off + n] * w[n];
    fft(re, im);
    const base = f * bins;
    for (let k = 0; k < bins; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * scale;
      data[base + k] = m > 1e-10 ? 20 * Math.log10(m) : -200;
    }
  }
  const df = fs / nfft;
  return {
    data,
    cols: frames,
    rows: bins,
    hop,
    N,
    nfft,
    fs,
    df,
    // Bordes de la imagen en unidades físicas
    x0: (N / 2 - hop / 2) / fs,
    x1: (N / 2 - hop / 2 + frames * hop) / fs,
    y0: 0,
    y1: (bins - 0.5) * df,
    timeRes: N / fs,
    freqRes: fs / N,
  };
}

/** Rango dinámico sugerido para pintar: [máximo − rango, máximo]. */
export function dbRange(data, range = 70) {
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) if (data[i] > max) max = data[i];
  if (!Number.isFinite(max)) max = 0;
  return { vmin: max - range, vmax: max };
}
