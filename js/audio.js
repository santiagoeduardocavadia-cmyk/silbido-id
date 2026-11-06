/**
 * Captura de audio: micrófono (getUserMedia + AudioWorklet), monitoreo por audífonos,
 * re-muestreo a 16 kHz, lectura de archivos y reproducción.
 */

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.analyser = null;
    this.worklet = null;
    this.monitor = null;
    this.deviceId = '';
    this.workletReady = null;
    this.player = null;
    this.onPlayEnd = null;
  }

  get active() {
    return !!this.stream;
  }

  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 0;
  }

  ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  static supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.AudioWorkletNode);
  }

  async start(deviceId = '') {
    const ctx = this.ensureContext();
    if (!this.workletReady) this.workletReady = ctx.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
    await this.workletReady;
    this.stopStream();
    const constraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 1 },
      },
    };
    if (deviceId) constraints.audio.deviceId = { exact: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = this.stream.getAudioTracks()[0];
    this.deviceId = (track && track.getSettings && track.getSettings().deviceId) || deviceId;
    this.trackLabel = track ? track.label : '';
    this.source = ctx.createMediaStreamSource(this.stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    this.worklet = new AudioWorkletNode(ctx, 'recorder-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const mute = ctx.createGain();
    mute.gain.value = 0;
    if (!this.monitor) {
      this.monitor = ctx.createGain();
      this.monitor.gain.value = 0;
      this.monitor.connect(ctx.destination);
    }
    this.source.connect(this.analyser);
    this.source.connect(this.worklet);
    this.worklet.connect(mute).connect(ctx.destination);
    this.source.connect(this.monitor);
    return this.deviceId;
  }

  stopStream() {
    if (this.recording) this.cancelRecording();
    if (this.source) this.source.disconnect();
    if (this.worklet) this.worklet.disconnect();
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.source = null;
    this.worklet = null;
    this.analyser = null;
  }

  async listInputs() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === 'audioinput');
  }

  setMonitor(on) {
    if (!this.monitor || !this.ctx) return;
    this.monitor.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  /** Graba `seconds` segundos a la frecuencia nativa. onProgress(fracción). */
  record(seconds, onProgress) {
    if (!this.worklet) return Promise.reject(new Error('El micrófono no está activo'));
    const sr = this.ctx.sampleRate;
    const target = Math.round(seconds * sr);
    const chunks = [];
    let got = 0;
    return new Promise((resolve, reject) => {
      this.recording = { reject };
      this.worklet.port.onmessage = (e) => {
        chunks.push(e.data);
        got += e.data.length;
        if (onProgress) onProgress(Math.min(1, got / target));
        if (got >= target) {
          this.worklet.port.postMessage('stop');
          this.worklet.port.onmessage = null;
          this.recording = null;
          const out = new Float32Array(target);
          let o = 0;
          for (const c of chunks) {
            const take = Math.min(c.length, target - o);
            out.set(c.subarray(0, take), o);
            o += take;
            if (o >= target) break;
          }
          resolve({ samples: out, sampleRate: sr });
        }
      };
      this.worklet.port.postMessage('start');
    });
  }

  cancelRecording() {
    if (!this.recording) return;
    if (this.worklet) {
      this.worklet.port.postMessage('stop');
      this.worklet.port.onmessage = null;
    }
    const r = this.recording;
    this.recording = null;
    r.reject(new Error('Grabación cancelada'));
  }

  /** Reproduce muestras (a cualquier fs) por la salida actual (tus audífonos). */
  play(samples, fs, onEnd) {
    const ctx = this.ensureContext();
    this.stopPlayback();
    const buf = ctx.createBuffer(1, samples.length, fs);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < samples.length; i++) ch[i] = Math.max(-1, Math.min(1, samples[i]));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const entry = { src, onEnd };
    src.onended = () => {
      if (this.player === entry) {
        this.player = null;
        if (onEnd) onEnd();
      }
    };
    src.start();
    this.player = entry;
    return entry;
  }

  stopPlayback() {
    const p = this.player;
    if (!p) return;
    this.player = null;
    try {
      p.src.stop();
    } catch {
      /* ya terminó */
    }
    if (p.onEnd) p.onEnd();
  }
}

/** Re-muestreo de alta calidad con OfflineAudioContext. */
export async function resample(samples, srcRate, dstRate) {
  if (srcRate === dstRate) return Float32Array.from(samples);
  const len = Math.round((samples.length * dstRate) / srcRate);
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const off = new OAC(1, len, dstRate);
  const buf = off.createBuffer(1, samples.length, srcRate);
  buf.copyToChannel(samples, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return Float32Array.from(out.getChannelData(0));
}

/** Decodifica un archivo de audio, lo mezcla a mono y lo deja en `fs` Hz y `seconds` s. */
export async function decodeFile(file, fs, seconds) {
  const data = await file.arrayBuffer();
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(1, fs, fs);
  const buf = await ctx.decodeAudioData(data);
  const n = buf.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += ch[i] / buf.numberOfChannels;
  }
  const at16 = buf.sampleRate === fs ? mono : await resample(mono, buf.sampleRate, fs);
  const target = Math.round(fs * seconds);
  const out = new Float32Array(target);
  out.set(at16.subarray(0, target));
  return { samples: out, originalSeconds: at16.length / fs };
}
