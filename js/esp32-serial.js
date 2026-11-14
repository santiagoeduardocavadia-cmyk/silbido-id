/**
 * La ESP32 como micrófono: lee por USB (Web Serial, Chrome/Edge) el audio que la placa ya filtró.
 *
 * Trama del firmware (esp32/silbido_id), una cada 10 ms:
 *   A5 5A | secuencia (u8) | n (u8, = 160) | estado (bit0 recorte, bit1 canal derecho)
 *         | n × int16 little endian | suma de verificación (u8, suma de los bytes de datos)
 * Fuera de las tramas, la placa puede mandar líneas de texto (la respuesta JSON a "I").
 */

export const BAUDIOS = 921600;

/** Separa tramas de audio y líneas de texto de un flujo de bytes. No depende del navegador. */
export class FrameParser {
  constructor({ onSamples, onLine } = {}) {
    this.onSamples = onSamples || (() => {});
    this.onLine = onLine || (() => {});
    this.buf = new Uint8Array(0);
    this.text = '';
    this.lastSeq = -1;
    this.stats = { frames: 0, bad: 0, lost: 0, clipped: 0, channel: 0 };
  }

  push(bytes) {
    const b = new Uint8Array(this.buf.length + bytes.length);
    b.set(this.buf);
    b.set(bytes, this.buf.length);
    let i = 0;
    while (i < b.length) {
      if (b[i] === 0xa5) {
        if (i + 1 >= b.length) break;
        if (b[i + 1] === 0x5a) {
          if (i + 5 > b.length) break;
          const n = b[i + 3];
          const total = 6 + 2 * n;
          if (i + total > b.length) break;
          let chk = 0;
          for (let k = 0; k < 2 * n; k++) chk = (chk + b[i + 5 + k]) & 0xff;
          if (n > 0 && chk === b[i + 5 + 2 * n]) {
            const seq = b[i + 2];
            if (this.lastSeq >= 0) this.stats.lost += (seq - this.lastSeq - 1 + 256) & 0xff;
            this.lastSeq = seq;
            const st = b[i + 4];
            if (st & 1) this.stats.clipped++;
            this.stats.channel = st & 2 ? 1 : 0;
            const out = new Float32Array(n);
            const dv = new DataView(b.buffer, b.byteOffset + i + 5, 2 * n);
            for (let k = 0; k < n; k++) out[k] = dv.getInt16(2 * k, true) / 32768;
            this.stats.frames++;
            this.onSamples(out);
            i += total;
            continue;
          }
          this.stats.bad++;
          i++;
          continue;
        }
      }
      const c = b[i];
      if (c === 10) {
        const line = this.text.trim();
        this.text = '';
        if (line) this.onLine(line);
      } else if (c >= 32 || c === 9) {
        if (this.text.length < 400) this.text += String.fromCharCode(c);
      }
      i++;
    }
    this.buf = b.slice(i);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Esp32Serial {
  static supported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.info = null;
    this.parser = null;
    this.onSamples = null;
    this.reading = false;
  }

  get connected() {
    return !!this.port;
  }

  async send(text) {
    if (this.writer) await this.writer.write(new TextEncoder().encode(text));
  }

  /** Pide el puerto al usuario, lo abre, saluda a la placa y empieza a recibir audio. */
  async connect(onSamples) {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: BAUDIOS, bufferSize: 1 << 16 });
    // Muchas DevKit se reinician al abrir el puerto (DTR/RTS); se sueltan las líneas y se espera el arranque.
    try {
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch {
      /* no todos los adaptadores lo permiten */
    }
    this.port = port;
    this.writer = port.writable.getWriter();
    this.onSamples = onSamples;
    let infoResolve;
    const gotInfo = new Promise((r) => (infoResolve = r));
    this.parser = new FrameParser({
      onSamples: (x) => this.onSamples && this.onSamples(x),
      onLine: (line) => {
        if (line.startsWith('{')) {
          try {
            const j = JSON.parse(line);
            if (j.dispositivo === 'silbido-id') infoResolve(j);
          } catch {
            /* línea incompleta */
          }
        }
      },
    });
    this.readLoop();
    await sleep(900);
    await this.send('X');
    await sleep(80);
    for (let k = 0; k < 4 && !this.info; k++) {
      await this.send('I');
      this.info = await Promise.race([gotInfo, sleep(700).then(() => null)]);
    }
    if (!this.info) {
      await this.disconnect();
      throw new Error('La placa no respondió como Silbido ID. ¿Subiste esp32/silbido_id a la ESP32? (921600 baudios)');
    }
    await this.send('S');
    return this.info;
  }

  async readLoop() {
    this.reading = true;
    while (this.port && this.port.readable && this.reading) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) this.parser.push(value);
        }
      } catch {
        /* error de lectura (cable desconectado): se sale */
        break;
      } finally {
        try {
          this.reader.releaseLock();
        } catch {
          /* ya liberado */
        }
      }
    }
    const lost = this.reading && this.port;
    this.reading = false;
    if (lost && this.onClose) this.onClose();
  }

  async disconnect() {
    const port = this.port;
    if (!port) return;
    try {
      await this.send('X');
    } catch {
      /* puerto ya cerrado */
    }
    this.reading = false;
    try {
      if (this.reader) await this.reader.cancel();
    } catch {
      /* nada que cancelar */
    }
    try {
      if (this.writer) this.writer.releaseLock();
    } catch {
      /* ya liberado */
    }
    this.port = null;
    this.writer = null;
    this.reader = null;
    this.info = null;
    try {
      await port.close();
    } catch {
      /* ya cerrado */
    }
  }
}
