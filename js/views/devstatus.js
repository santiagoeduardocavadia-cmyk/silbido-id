// Estado de la ESP32 y del micrófono INMP441: conexión USB, tramas por segundo, pérdidas,
// nivel de la señal, si el micrófono manda datos y si está saturando. Se muestra en la tarjeta
// del micrófono (Grabar) y como un indicador en la cabecera, visible desde cualquier pestaña.
import { $, fmt } from '../util.js';

const USB_CHIPS = { 0x10c4: 'CP210x', 0x1a86: 'CH340', 0x0403: 'FTDI', 0x303a: 'Espressif USB' };

export function createDeviceStatus(app, esp) {
  const el = {
    esp: $('#dev-esp'),
    espTxt: $('#dev-esp-txt'),
    espMeta: $('#dev-esp-meta'),
    mic: $('#dev-mic'),
    micTxt: $('#dev-mic-txt'),
    bar: $('#dev-mic-bar'),
    gain: $('#dev-gain'),
    gainVal: $('#dev-gain-val'),
    chip: $('#dev-chip'),
    chipEsp: $('#dev-chip-esp'),
    chipMic: $('#dev-chip-mic'),
  };

  // medición de la ventana actual (se reinicia cada 0,5 s)
  let m = { sumSq: 0, n: 0, peak: 0 };
  let zeroWindows = 0;
  let lastFrames = 0;
  let lastLost = 0;
  let lastClipped = 0;
  let lastT = 0;
  let timer = 0;
  let gainDb = 12;
  let connecting = false;
  let lossFlash = 0;

  const setRow = (row, state) => {
    row.classList.remove('ok', 'warn', 'bad', 'off', 'wait');
    row.classList.add(state);
  };
  const setChip = (dot, state) => {
    dot.className = `dot ${state}`;
  };

  function usbName() {
    try {
      const i = esp.port && esp.port.getInfo ? esp.port.getInfo() : {};
      return i.usbVendorId != null ? USB_CHIPS[i.usbVendorId] || `USB ${i.usbVendorId.toString(16)}:${(i.usbProductId || 0).toString(16)}` : 'USB';
    } catch {
      return 'USB';
    }
  }

  /** Muestras que llegan de la ESP32 (ya filtradas), para medir el nivel. */
  function feed(x) {
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      m.sumSq += v * v;
      const a = v < 0 ? -v : v;
      if (a > m.peak) m.peak = a;
    }
    m.n += x.length;
  }

  function renderOff() {
    setRow(el.esp, connecting ? 'wait' : 'off');
    el.espTxt.textContent = connecting ? 'Conectando… (elige el puerto de la ESP32)' : 'Desconectada. Conéctala por USB y pulsa "Usar ESP32 (USB)".';
    el.espMeta.textContent = '';
    setRow(el.mic, 'off');
    el.micTxt.textContent = app.audio.active ? 'No se usa: la entrada es el micrófono del equipo.' : 'Sin conexión con la ESP32.';
    el.bar.style.width = '0%';
    el.gain.hidden = true;
    el.chip.classList.remove('on');
    setChip(el.chipEsp, connecting ? 'wait' : 'off');
    setChip(el.chipMic, 'off');
    el.chip.title = 'ESP32 desconectada (clic para ir al micrófono)';
  }

  function tick() {
    if (!esp.connected || !esp.parser) return;
    const now = performance.now();
    const dt = Math.max(0.001, (now - lastT) / 1000);
    lastT = now;
    const st = esp.parser.stats;
    const fps = (st.frames - lastFrames) / dt;
    const lost = st.lost - lastLost;
    const clipped = st.clipped - lastClipped;
    lastFrames = st.frames;
    lastLost = st.lost;
    lastClipped = st.clipped;
    if (lost > 0) lossFlash = 4;
    else if (lossFlash > 0) lossFlash--;

    // ---- ESP32
    const info = esp.info || {};
    const espState = fps < 50 ? 'bad' : fps < 90 || lossFlash ? 'warn' : 'ok';
    setRow(el.esp, espState);
    el.espTxt.textContent =
      espState === 'bad'
        ? 'Conectada, pero no llegan datos de audio. Desconecta y vuelve a conectar.'
        : `Conectada por ${usbName()} · filtra con ${info.filtro || '—'}`;
    el.espMeta.textContent = `${fmt(fps, 0)} tramas/s${st.lost ? ` · ${st.lost} perdidas` : ''}`;
    el.espMeta.title = `Se esperan 100 tramas/s (una cada 10 ms). Tramas recibidas: ${st.frames}. Corruptas: ${st.bad}. Perdidas: ${st.lost}.`;

    // ---- micrófono
    const rms = m.n ? Math.sqrt(m.sumSq / m.n) : 0;
    const db = 20 * Math.log10(rms + 1e-9);
    const silentData = m.n > 0 && m.peak === 0;
    zeroWindows = silentData ? zeroWindows + 1 : 0;
    const canal = st.channel ? 'derecho (L/R a 3V3)' : 'izquierdo (L/R a GND)';
    let micState;
    if (!m.n) {
      micState = 'bad';
      el.micTxt.textContent = 'No llega audio de la ESP32.';
    } else if (zeroWindows >= 2) {
      micState = 'bad';
      el.micTxt.innerHTML =
        '<b>No envía datos.</b> Revisa VDD → 3V3, GND, SD → GPIO32, SCK → GPIO26, WS → GPIO25 y que los pines del micrófono estén soldados.';
    } else if (clipped > 5) {
      micState = 'warn';
      el.micTxt.textContent = `Saturando (${fmt(db, 0)} dBFS): baja la ganancia o aléjate un poco del micrófono.`;
    } else if (db < -75) {
      micState = 'warn';
      el.micTxt.textContent = `Señal muy baja (${fmt(db, 0)} dBFS). Si silbas y no sube, revisa el cable SD.`;
    } else {
      micState = 'ok';
      el.micTxt.textContent = `Funcionando · canal ${canal} · nivel filtrado ${fmt(db, 0)} dBFS`;
    }
    setRow(el.mic, micState);
    el.bar.style.width = `${Math.max(0, Math.min(100, ((db + 80) / 80) * 100))}%`;
    el.bar.className = micState;
    el.gain.hidden = false;
    el.gainVal.textContent = `${gainDb >= 0 ? '+' : ''}${gainDb} dB`;

    el.chip.classList.add('on');
    setChip(el.chipEsp, espState);
    setChip(el.chipMic, micState);
    el.chip.title = `ESP32: ${el.espTxt.textContent}\nMicrófono: ${el.micTxt.textContent}`;
    m = { sumSq: 0, n: 0, peak: 0 };
  }

  el.gain.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-gain]');
    if (!b || !esp.connected) return;
    const up = b.dataset.gain === '+';
    const next = Math.max(0, Math.min(36, gainDb + (up ? 3 : -3)));
    if (next === gainDb) return;
    gainDb = next;
    await esp.send(up ? '+' : '-');
    el.gainVal.textContent = `${gainDb >= 0 ? '+' : ''}${gainDb} dB`;
  });

  el.chip.addEventListener('click', () => {
    app.switchTab('grabar');
    setTimeout(() => $('#mic-card').scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  });

  renderOff();
  app.bus.on('takes-changed', () => !esp.connected && renderOff());

  return {
    feed,
    connecting() {
      connecting = true;
      renderOff();
    },
    connected() {
      connecting = false;
      gainDb = esp.info && Number.isFinite(esp.info.ganancia_db) ? esp.info.ganancia_db : 12;
      m = { sumSq: 0, n: 0, peak: 0 };
      zeroWindows = 0;
      lossFlash = 0;
      const st = esp.parser.stats;
      lastFrames = st.frames;
      lastLost = st.lost;
      lastClipped = st.clipped;
      lastT = performance.now();
      clearInterval(timer);
      timer = setInterval(tick, 500);
    },
    disconnected() {
      connecting = false;
      clearInterval(timer);
      renderOff();
    },
    refresh: renderOff,
  };
}
