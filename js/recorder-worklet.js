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
