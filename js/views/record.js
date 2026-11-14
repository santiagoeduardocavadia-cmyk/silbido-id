// Vista 1 · Grabar: micrófono, vista en vivo, 5 tomas, ranking y guardado del perfil.
import { AudioEngine, resample, decodeFileAll, splitTakes } from '../audio.js';
import { Esp32Serial } from '../esp32-serial.js';
import { createDeviceStatus } from './devstatus.js';
import { LiveView } from '../ui/live.js';
import { buildProfile, MIN_VALID_TAKES } from '../dsp/matcher.js';
import { noteName } from '../dsp/features.js';
import { synthWhistle, DEMO_PEOPLE } from '../dsp/synth.js';
import { $, fmt, icons, escapeHtml, floatToB64, encodeWav, download } from '../util.js';
import { countdown, drawHeatThumb, drawWaveSpark, micErrorMessage } from './common.js';

/**
 * Flujo de grabación reutilizable: arranca el micrófono si hace falta, cuenta 3-2-1,
 * graba app.DUR segundos y devuelve las muestras a 16 kHz (o null si se canceló).
 */
export async function recordClip(app, ui) {
  if (!app.audio.active) {
    const ok = await app.startMic();
    if (!ok) return null;
  }
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    app.audio.cancelRecording();
  };
  ui.cancel.onclick = cancel;
  ui.box.hidden = false;
  ui.bar.style.width = '0%';
  ui.button.disabled = true;
  ui.button.classList.add('busy');
  app.bus.emit('recording', true);
  try {
    const go = await countdown(ui.count, () => cancelled);
    if (!go) return null;
    const { samples, sampleRate } = await app.audio.record(app.DUR, (p) => {
      ui.bar.style.width = `${p * 100}%`;
      ui.count.textContent = `${fmt(app.DUR * (1 - p), 1)} s`;
    });
    return await resample(samples, sampleRate, app.FS);
  } catch (e) {
    if (!cancelled) app.toast(e.message || String(e), 'error');
    return null;
  } finally {
    ui.box.hidden = true;
    ui.button.disabled = false;
    ui.button.classList.remove('busy');
    app.bus.emit('recording', false);
  }
}

export function initRecord(app) {
  const el = {
    micStart: $('#mic-start'),
    esp: $('#esp32-connect'),
    select: $('#mic-select'),
    monitor: $('#monitor-toggle'),
    status: $('#mic-status'),
    name: $('#person-name'),
    recNext: $('#rec-next'),
    file: $('#file-take'),
    list: $('#takes-list'),
    count: $('#takes-count'),
    save: $('#save-profile'),
    clear: $('#clear-takes'),
    demo: $('#demo-fill'),
    rankCard: $('#ranking-card'),
    rankBody: $('#ranking-table tbody'),
    rankNote: $('#ranking-note'),
  };
  const recUI = { box: $('#rec-progress'), count: $('#rec-count'), bar: $('#rec-bar'), cancel: $('#rec-cancel'), button: el.recNext };
  el.file.closest('label').querySelector('.ico').innerHTML = icons.upload;
  const live = new LiveView({
    canvas: $('#live-canvas'),
    meterFill: $('#meter-fill'),
    meterText: $('#meter-text'),
    readout: $('#live-readout'),
    band: $('#live-band'),
    bandLabel: $('#live-band-label'),
    peak: $('#live-peak'),
    peakLabel: $('#live-peak-label'),
    idle: $('#live-idle'),
  });
  const syncBand = () => live.setBand(app.state.filter.fl, app.state.filter.fh);
  syncBand();
  app.bus.on('filter-changed', syncBand);
  let recordingSlot = null;

  // ---------- micrófono ----------
  function micUI() {
    const on = app.audio.active;
    const ext = !!app.audio.externalLabel;
    el.micStart.innerHTML = `${icons.mic}<span>${on && !ext ? 'Apagar micrófono' : 'Activar micrófono'}</span>`;
    el.micStart.classList.toggle('primary', !on);
    el.micStart.classList.toggle('ghost', on);
    el.esp.querySelector('.lbl').textContent = ext ? 'Desconectar ESP32' : 'Usar ESP32 (USB)';
    el.esp.classList.toggle('on', ext);
    el.status.textContent = ext ? `ESP32 · ${app.audio.externalLabel}` : on ? `Activo · ${fmt(app.audio.sampleRate / 1000, 1)} kHz` : 'Apagado';
    el.status.title = ext ? 'La ESP32 filtra la señal del INMP441 y la manda por USB a 16 kHz' : '';
    el.status.className = `pill ${on ? 'on' : ''}`;
    el.monitor.disabled = !on;
    if (ext) el.select.disabled = true;
    if (!on) el.monitor.checked = false;
    if (!esp.connected) dev.refresh();
  }

  // ---------- ESP32 por USB ----------
  const esp = new Esp32Serial();
  const dev = createDeviceStatus(app, esp);
  el.esp.querySelector('.ico').innerHTML = icons.chip;
  if (!Esp32Serial.supported()) {
    el.esp.disabled = true;
    el.esp.title = 'Tu navegador no permite USB serie. Usa Chrome o Edge en el computador.';
  }
  async function disconnectEsp(msg) {
    await esp.disconnect();
    dev.disconnected();
    if (app.audio.externalLabel) {
      app.audio.stopStream();
      live.detach();
    }
    micUI();
    if (msg) app.toast(msg, 'error');
  }
  esp.onClose = () => disconnectEsp('Se perdió la conexión con la ESP32 (¿se desconectó el cable?).');
  el.esp.addEventListener('click', async () => {
    if (esp.connected) {
      await disconnectEsp();
      return;
    }
    el.esp.disabled = true;
    el.esp.querySelector('.lbl').textContent = 'Conectando…';
    try {
      if (app.audio.active) stopMic();
      dev.connecting();
      let push = null;
      const info = await esp.connect((x) => {
        dev.feed(x);
        if (push) push(x);
      });
      push = await app.audio.startExternal(`${info.filtro}`, info.fs);
      dev.connected();
      live.attach(app.audio.analyser);
      app.audio.setMonitor(el.monitor.checked);
      app.toast(`ESP32 conectada: filtra con ${info.filtro} y manda el audio por USB. Ya puedes grabar o verificar.`);
    } catch (e) {
      await esp.disconnect();
      dev.disconnected();
      if (e && e.name === 'NotFoundError') app.toast('No elegiste ningún puerto. Conecta la ESP32 por USB y vuelve a intentar.');
      else app.toast(e.message || String(e), 'error');
    } finally {
      el.esp.disabled = !Esp32Serial.supported();
      micUI();
    }
  });

  async function refreshDevices() {
    const list = await app.audio.listInputs();
    if (!list.length) return;
    const cur = app.audio.deviceId;
    el.select.innerHTML = list
      .map((d, i) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || `Micrófono ${i + 1}`)}</option>`)
      .join('');
    if (cur && list.some((d) => d.deviceId === cur)) el.select.value = cur;
    el.select.disabled = !app.audio.active;
  }

  app.startMic = async function startMic(deviceId) {
    if (!AudioEngine.supported()) {
      app.toast('Este navegador no permite capturar audio. Usa Chrome, Edge, Firefox o Safari actualizados (y abre la página con https).', 'error');
      return false;
    }
    try {
      await app.audio.start(deviceId || '');
    } catch (e) {
      if (deviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) return app.startMic('');
      app.toast(micErrorMessage(e), 'error');
      micUI();
      return false;
    }
    live.attach(app.audio.analyser);
    app.audio.setMonitor(el.monitor.checked);
    await refreshDevices();
    micUI();
    return true;
  };

  function stopMic() {
    app.audio.stopStream();
    live.detach();
    el.select.disabled = true;
    micUI();
  }

  el.micStart.addEventListener('click', async () => {
    if (app.audio.externalLabel) {
      await disconnectEsp();
      app.startMic('');
    } else if (app.audio.active) stopMic();
    else app.startMic(el.select.disabled ? '' : el.select.value);
  });
  el.select.addEventListener('change', () => app.startMic(el.select.value));
  el.monitor.addEventListener('change', () => app.audio.setMonitor(el.monitor.checked));
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      if (app.audio.active) refreshDevices();
    });
  }
  app.bus.on('theme-changed', () => live.clear());

  // ---------- tomas ----------
  const firstEmpty = () => app.state.takes.findIndex((t) => !t);

  function setTake(slot, samples, source) {
    app.state.takes[slot] = app.makeItem('take', samples, { id: `take-${slot}-${Date.now()}`, slot, source, label: `Toma ${slot + 1}` });
    app.recomputeRanking();
    app.bus.emit('takes-changed');
  }

  async function recordInto(slot) {
    if (slot < 0) {
      app.toast('Ya tienes 5 tomas. Usa "Regrabar" en la que quieras cambiar o borra las tomas.');
      return;
    }
    recordingSlot = slot;
    render();
    const x = await recordClip(app, recUI);
    recordingSlot = null;
    if (x) setTake(slot, x, 'mic');
    else render();
  }

  el.recNext.addEventListener('click', () => recordInto(firstEmpty()));

  // Varios archivos a la vez; un audio largo se parte en tomas de 5 s que llenan los espacios libres.
  el.file.addEventListener('change', async () => {
    const files = Array.from(el.file.files);
    el.file.value = '';
    if (!files.length) return;
    if (firstEmpty() < 0) {
      app.toast('Ya tienes 5 tomas. Borra una para subir otra.');
      return;
    }
    let added = 0;
    const bad = [];
    for (const f of files) {
      try {
        const x = await decodeFileAll(f, app.FS);
        const free = app.state.takes.filter((t) => !t).length;
        for (const chunk of splitTakes(x, app.FS, app.DUR, free)) {
          const slot = firstEmpty();
          if (slot < 0) break;
          app.state.takes[slot] = app.makeItem('take', chunk, { id: `take-${slot}-${Date.now()}-${added}`, slot, source: 'archivo', label: `Toma ${slot + 1}` });
          added++;
        }
      } catch (e) {
        bad.push(f.name);
      }
      if (firstEmpty() < 0) break;
    }
    if (added) {
      app.recomputeRanking();
      app.bus.emit('takes-changed');
    }
    app.toast(
      `${added === 1 ? 'Se cargó 1 toma' : `Se cargaron ${added} tomas`} desde ${files.length === 1 ? 'el archivo' : `${files.length} archivos`}.${bad.length ? ` No se pudo leer: ${bad.join(', ')}.` : ''}`,
      bad.length && !added ? 'error' : '',
    );
  });

  el.demo.addEventListener('click', () => {
    for (let i = 0; i < app.NTAKES; i++) {
      app.state.takes[i] = app.makeItem('take', synthWhistle(DEMO_PEOPLE.ana, { fs: app.FS, dur: app.DUR, seed: i + 1 }), {
        id: `take-${i}-${Date.now()}`,
        slot: i,
        source: 'demo',
        label: `Toma ${i + 1}`,
      });
    }
    if (!el.name.value.trim()) el.name.value = DEMO_PEOPLE.ana.name;
    app.recomputeRanking();
    app.bus.emit('takes-changed');
    app.toast('Se cargaron 5 silbidos sintéticos de "Ana". Revísalos en Análisis o guarda el perfil.');
  });

  el.clear.addEventListener('click', () => {
    if (!app.state.takes.some(Boolean)) return;
    if (!confirm('¿Borrar las 5 tomas de esta sesión? (Los perfiles guardados no se tocan.)')) return;
    app.state.takes = new Array(app.NTAKES).fill(null);
    app.recomputeRanking();
    app.bus.emit('takes-changed');
  });

  el.list.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const slot = Number(b.closest('[data-slot]').dataset.slot);
    const t = app.state.takes[slot];
    const act = b.dataset.act;
    if (act === 'rec') return recordInto(slot);
    if (!t) return;
    if (act === 'play') app.togglePlay(t.samples, b);
    else if (act === 'playf') app.togglePlay(app.analyze(t).y, b);
    else if (act === 'analyze') {
      app.bus.emit('select-source', t.id);
      app.switchTab('analisis');
    } else if (act === 'wav') download(`toma-${slot + 1}.wav`, encodeWav(t.samples, app.FS));
    else if (act === 'del') {
      app.state.takes[slot] = null;
      app.recomputeRanking();
      app.bus.emit('takes-changed');
    }
  });

  el.save.addEventListener('click', () => {
    const name = el.name.value.trim();
    if (!name) {
      el.name.focus();
      app.toast('Escribe el nombre de la persona que silba.');
      return;
    }
    const analyses = app.state.takes.map((t) => (t ? app.analyze(t) : null));
    let profile;
    try {
      profile = buildProfile({ name, analyses, filterCfg: app.state.filter, fs: app.FS });
    } catch (e) {
      app.toast(e.message, 'error');
      return;
    }
    profile.bestAudio = floatToB64(app.state.takes[profile.bestTake - 1].samples);
    const existing = app.state.profiles.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existing >= 0) {
      if (!confirm(`Ya existe un perfil llamado "${app.state.profiles[existing].name}". ¿Reemplazarlo?`)) return;
      app.state.profiles[existing] = profile;
    } else app.state.profiles.push(profile);
    if (app.saveProfiles()) app.toast(`Perfil de ${name} guardado (mejor toma: ${profile.bestTake}). Ya puedes probarlo en Verificar.`);
    app.bus.emit('select-profile', profile.id);
  });

  // ---------- render ----------
  function render() {
    const takes = app.state.takes;
    const rank = app.state.rank;
    const byIdx = new Map(rank ? rank.list.map((r) => [r.idx, r]) : []);
    const n = takes.filter(Boolean).length;
    el.count.textContent = `${n}/${app.NTAKES}`;
    const next = firstEmpty();
    el.recNext.querySelector('.lbl').textContent = next >= 0 ? `Grabar toma ${next + 1} · ${app.DUR} s` : 'Las 5 tomas están listas';
    el.recNext.disabled = next < 0 || recordingSlot !== null;

    el.list.innerHTML = takes
      .map((t, i) => {
        if (recordingSlot === i) {
          return `<li class="take empty recording" data-slot="${i}"><div class="take-num">${i + 1}</div><div class="take-info"><strong>Grabando toma ${i + 1}…</strong><small>Silba durante los 5 segundos</small></div></li>`;
        }
        if (!t) {
          return `<li class="take empty" data-slot="${i}"><div class="take-num">${i + 1}</div><div class="take-info"><strong>Toma ${i + 1}</strong><small>Vacía</small></div></li>`;
        }
        const a = app.analyze(t);
        const f = a.features;
        const r = byIdx.get(i);
        const best = rank && rank.best === i;
        const src = t.source === 'demo' ? ' · demo' : t.source === 'archivo' ? ' · archivo' : '';
        const info = f.valid
          ? `${fmt(f.pitchHz, 0)} Hz · ${noteName(f.pitchMidi)} · ${fmt(f.durVoiced, 2)} s · ${f.segments} segm.${src}`
          : `<span class="warn">No se detectó un silbido claro</span>${src}`;
        const warn = f.valid && (f.clipped || f.edgeCut) ? `<span class="warn"> · ${f.clipped ? 'saturada' : 'cortada en el borde'}</span>` : '';
        return `<li class="take ${best ? 'best' : ''}" data-slot="${i}">
          <div class="take-num">${i + 1}</div>
          <canvas class="take-thumb" aria-hidden="true"></canvas>
          <div class="take-info"><strong>Toma ${i + 1} ${best ? `<span class="badge">${icons.star}Mejor</span>` : ''}</strong><small>${info}${warn}</small></div>
          <div class="take-score" title="Puntaje de calidad">${r ? r.score : '—'}<small>puntos</small></div>
          <div class="take-actions">
            <button type="button" data-act="play" title="Escuchar la toma original">${icons.play}Original</button>
            <button type="button" data-act="playf" title="Escuchar la toma filtrada">${icons.filter}Filtrada</button>
            <button type="button" data-act="analyze" title="Ver el análisis completo">${icons.search}Analizar</button>
            <button type="button" data-act="rec" title="Volver a grabar esta toma">${icons.redo}Regrabar</button>
            <button type="button" data-act="wav" title="Descargar WAV">${icons.download}</button>
            <button type="button" data-act="del" title="Borrar esta toma" aria-label="Borrar toma ${i + 1}">${icons.trash}</button>
          </div>
        </li>`;
      })
      .join('');

    // miniaturas
    for (const li of el.list.querySelectorAll('li[data-slot]')) {
      const t = takes[Number(li.dataset.slot)];
      const c = li.querySelector('canvas');
      if (!t || !c) continue;
      const a = app.analyze(t);
      if (a.features.valid) drawHeatThumb(c, a);
      else drawWaveSpark(c, t.samples);
    }

    const valid = rank ? rank.validCount : 0;
    el.save.disabled = valid < MIN_VALID_TAKES;
    el.save.title = valid < MIN_VALID_TAKES ? `Necesitas al menos ${MIN_VALID_TAKES} tomas con silbido detectado` : 'Guardar el perfil con las 3 mejores tomas';
    renderRanking();
  }

  function renderRanking() {
    const rank = app.state.rank;
    if (!rank || rank.list.length < 2) {
      el.rankCard.hidden = true;
      return;
    }
    el.rankCard.hidden = false;
    const cell = (v) => `<span class="mini-bar"><i style="width:${Math.round((v || 0) * 100)}%"></i></span>${fmt((v || 0) * 100, 0)}`;
    el.rankBody.innerHTML = rank.list
      .map((r) => {
        const f = app.analyze(app.state.takes[r.idx]).features;
        const best = r.idx === rank.best;
        if (!r.valid) {
          return `<tr><td>Toma ${r.idx + 1}</td><td>0</td><td colspan="5" class="muted">Sin silbido detectado</td></tr>`;
        }
        return `<tr class="${best ? 'best' : ''}">
          <td>${best ? '★ ' : ''}Toma ${r.idx + 1}</td>
          <td><b>${r.score}</b></td>
          <td title="${fmt(f.snrDb, 1)} dB">${cell(r.parts.snr)}</td>
          <td title="${fmt(f.durVoiced, 2)} s">${cell(r.parts.duracion)}</td>
          <td title="${fmt(f.jitterCents, 1)} cents">${cell(r.parts.estabilidad)}</td>
          <td title="${fmt(f.purity * 100, 0)} %">${cell(r.parts.pureza)}</td>
          <td title="${r.consistency != null ? `${fmt(r.consistency, 2)} st de DTW promedio` : ''}">${cell(r.parts.consistencia)}</td>
        </tr>`;
      })
      .join('');
    el.rankNote.textContent = rank.best != null ? `Mejor toma: ${rank.best + 1}` : '';
  }

  app.bus.on('takes-changed', render);
  app.bus.on('theme-changed', render);
  micUI();
  if (!AudioEngine.supported()) {
    el.status.textContent = 'No disponible';
  }
}
