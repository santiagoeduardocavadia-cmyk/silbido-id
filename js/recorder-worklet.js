// AudioWorklet: copia las muestras del micrófono (mezcla a mono) y las envía en bloques de 2048.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
    this.active = false;
    this.port.onmessage = (e) => {
      if (e.data === 'start') {
        this.n = 0;
        this.active = true;
      } else if (e.data === 'stop') {
        this.flush();
        this.active = false;
      }
    };
  }

  flush() {
    if (this.n > 0) {
      this.port.postMessage(this.buf.slice(0, this.n));
      this.n = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (this.active && input && input.length) {
      const chs = input.length;
      const len = input[0].length;
      for (let i = 0; i < len; i++) {
        let s = 0;
        for (let c = 0; c < chs; c++) s += input[c][i];
        this.buf[this.n++] = s / chs;
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.slice(0));
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);

// Reproduce dentro del grafo de audio un flujo externo a otra frecuencia (la ESP32 manda 16 kHz),
// para que el espectrograma en vivo, el medidor y el monitoreo funcionen igual que con un micrófono.
class StreamPlayer extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.step = (opts.processorOptions.inRate || 16000) / sampleRate;
    this.ring = new Float32Array(16384);
    this.w = 0;
    this.r = 0;
    this.n = 0;
    this.frac = 0;
    this.port.onmessage = (e) => {
      const x = e.data;
      for (let i = 0; i < x.length; i++) {
        this.ring[this.w] = x[i];
        this.w = (this.w + 1) & 16383;
        if (this.n < 16384) this.n++;
        else this.r = (this.r + 1) & 16383;
      }
      // si se acumula más de ~150 ms de retraso, se descarta lo viejo
      while (this.n > 2400) {
        this.r = (this.r + 1) & 16383;
        this.n--;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      if (this.n < 2) {
        out[i] = 0;
        continue;
      }
      const a = this.ring[this.r];
      const b = this.ring[(this.r + 1) & 16383];
      out[i] = a + (b - a) * this.frac;
      this.frac += this.step;
      while (this.frac >= 1 && this.n >= 2) {
        this.frac -= 1;
        this.r = (this.r + 1) & 16383;
        this.n--;
      }
    }
    return true;
  }
}

registerProcessor('stream-player', StreamPlayer);
