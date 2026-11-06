/**
 * Vista en vivo del micrófono: nivel (dBFS), frecuencia dominante y espectrograma que se desplaza.
 */
import { heatLUT, tok } from './plot.js';
import { fmt } from '../util.js';
import { noteName, hzToMidi } from '../dsp/features.js';

export class LiveView {
  constructor({ canvas, meterFill, meterText, readout }) {
    this.canvas = canvas;
    this.meterFill = meterFill;
    this.meterText = meterText;
    this.readout = readout;
    this.analyser = null;
    this.raf = 0;
    this.fmax = 8000;
    this.peakHold = -100;
    this.lastCol = 0;
  }

  attach(analyser) {
    this.analyser = analyser;
    this.freq = new Float32Array(analyser.frequencyBinCount);
    this.time = new Float32Array(analyser.fftSize);
    this.clear();
    if (!this.raf) this.loop();
  }

  detach() {
    this.analyser = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.meterFill.style.width = '0%';
    this.meterText.textContent = '— dBFS';
    this.readout.textContent = 'Frecuencia dominante: —';
  }

  clear() {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth || 300;
    const h = c.clientHeight || 120;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d');
    ctx.fillStyle = tok('--heat-0');
    ctx.fillRect(0, 0, c.width, c.height);
  }

  loop() {
    this.raf = requestAnimationFrame(() => this.loop());
    const an = this.analyser;
    if (!an) return;
    const c = this.canvas;
    if (!c.clientWidth) return;
    if (Math.abs(c.width - c.clientWidth * Math.min(window.devicePixelRatio || 1, 2)) > 2) this.clear();
    an.getFloatTimeDomainData(this.time);
    an.getFloatFrequencyData(this.freq);
    let sum = 0;
    let pk = 0;
    for (let i = 0; i < this.time.length; i++) {
      const v = this.time[i];
      sum += v * v;
      const a = Math.abs(v);
      if (a > pk) pk = a;
    }
    const rms = Math.sqrt(sum / this.time.length);
    const db = 20 * Math.log10(rms + 1e-9);
    const pkDb = 20 * Math.log10(pk + 1e-9);
    this.peakHold = Math.max(pkDb, this.peakHold - 0.8);
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    this.meterFill.style.width = `${pct}%`;
    this.meterFill.classList.toggle('clip', this.peakHold > -1);
    this.meterText.textContent = `${fmt(Math.max(-99, db), 0)} dBFS`;

    const sr = an.context.sampleRate;
    const binHz = sr / an.fftSize;
    const kmax = Math.min(this.freq.length - 1, Math.floor(this.fmax / binHz));
    // frecuencia dominante entre 500 Hz y 6 kHz
    let best = -Infinity;
    let kb = 0;
    for (let k = Math.floor(500 / binHz); k <= Math.min(kmax, Math.floor(6000 / binHz)); k++) {
      if (this.freq[k] > best) {
        best = this.freq[k];
        kb = k;
      }
    }
    if (best > -75 && db > -60) {
      const f = kb * binHz;
      this.readout.innerHTML = `Frecuencia dominante: <b>${fmt(f, 0)} Hz</b> <span class="muted">(${noteName(hzToMidi(f))})</span>`;
    } else this.readout.innerHTML = 'Frecuencia dominante: <span class="muted">silencio</span>';

    // desplazar y pintar una columna nueva
    const ctx = c.getContext('2d');
    const W = c.width;
    const H = c.height;
    const step = 2;
    ctx.drawImage(c, step, 0, W - step, H, 0, 0, W - step, H);
    const lut = heatLUT();
    const img = ctx.createImageData(step, H);
    for (let y = 0; y < H; y++) {
      const k = Math.round(((H - 1 - y) / (H - 1)) * kmax);
      let v = (this.freq[k] + 100) / 70; // −100 dB … −30 dB
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      const li = Math.round(v * 255) * 3;
      for (let s = 0; s < step; s++) {
        const o = (y * step + s) * 4;
        img.data[o] = lut[li];
        img.data[o + 1] = lut[li + 1];
        img.data[o + 2] = lut[li + 2];
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, W - step, 0);
  }
}
