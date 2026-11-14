// Vista 4 · Perfiles: lista, importar/exportar JSON, perfiles de demostración.
import { buildProfile } from '../dsp/matcher.js';
import { analyzeSignal, noteName } from '../dsp/features.js';
import { synthWhistle, DEMO_PEOPLE } from '../dsp/synth.js';
import { isValidProfile, normalizeProfile, DEFAULT_FILTER } from '../store.js';
import { designFilter, toCHeader } from '../dsp/filters.js';
import { autoTuneFilter } from '../dsp/autofilter.js';
import { profilesToHeader } from '../esp32.js';
import { initNewProfile } from './newprofile.js';
import { forwardDetail, profileEmbedding, embed } from '../dsp/ai.js';
import { renderNetwork } from '../ui/nnview.js';
import { $, fmt, icons, escapeHtml, download, slug, formatDate, floatToB64 } from '../util.js';
import { drawContourSpark, drawHeatThumb } from './common.js';

export function makeDemoProfile(person, fs, dur, seedBase) {
  const samples = [1, 2, 3, 4, 5].map((i) => synthWhistle(person, { fs, dur, seed: seedBase + i }));
  // El filtro de cada perfil lo elige la auto-sintonía con sus propias tomas.
  const tuned = autoTuneFilter(samples, fs, DEFAULT_FILTER);
  const cfg = tuned.cfg;
  const analyses = tuned.analyses || samples.map((x) => analyzeSignal(x, fs, designFilter(cfg, fs)));
  const profile = buildProfile({ name: person.name, analyses, filterCfg: cfg, fs });
  profile.bestAudio = floatToB64(samples[profile.bestTake - 1]);
  profile.demo = true;
  return profile;
}

export function initProfiles(app) {
  const el = {
    grid: $('#profiles-grid'),
    empty: $('#profiles-empty'),
    import: $('#import-profile'),
    demo: $('#demo-profiles'),
    esp32: $('#export-esp32'),
  };
  el.import.closest('label').querySelector('.ico').innerHTML = icons.upload;
  el.esp32.querySelector('.ico').innerHTML = icons.chip;

  function exportEsp32(list) {
    if (!list.length) {
      app.toast('Primero crea o importa un perfil.');
      return;
    }
    download('perfil.h', profilesToHeader(list.slice(0, 4), app.FS), 'text/x-c');
    app.toast(
      `perfil.h descargado con ${Math.min(4, list.length)} perfil(es)${list.length > 4 ? ' (el firmware admite 4)' : ''}. Es para el reconocedor autónomo: reemplaza el de esp32/reconocedor_autonomo/.`,
    );
  }
  el.esp32.addEventListener('click', () => exportEsp32(app.state.profiles));
  initNewProfile(app);

  function render() {
    const list = app.state.profiles;
    el.empty.hidden = list.length > 0;
    el.grid.innerHTML = list
      .map((p) => {
        const s = p.summary;
        const initial = escapeHtml((p.name.trim()[0] || '?').toUpperCase());
        const filt = `${p.filter.type === 'fir' ? 'FIR' : 'IIR'} ${fmt(p.filter.fl, 0)}–${fmt(p.filter.fh, 0)} Hz`;
        return `<article class="card profile-card" data-id="${escapeHtml(p.id)}">
          <div class="card-head">
            <div class="profile-title"><span class="avatar" aria-hidden="true">${initial}</span>
              <div><h2>${escapeHtml(p.name)}</h2><small>${formatDate(p.createdAt)}${p.demo ? ' · demo' : ''}</small></div>
            </div>
          </div>
          <canvas class="profile-spark" aria-label="Mapa de calor de la mejor toma, con los tramos de silbido y el contorno de tono" role="img"></canvas>
          <dl class="kv">
            <div><dt>Tono</dt><dd>${fmt(s.pitchHz, 0)} Hz</dd></div>
            <div><dt>Nota</dt><dd>${noteName(s.pitchMidi)}</dd></div>
            <div><dt>Duración</dt><dd>${fmt(s.durVoiced, 2)} s</dd></div>
            <div><dt>Segmentos</dt><dd>${fmt(s.segments, 1)}</dd></div>
            <div><dt>Pureza</dt><dd>${fmt(s.purity * 100, 0)} %</dd></div>
            <div><dt>Filtro</dt><dd title="${filt}">${p.filter.type === 'fir' ? 'FIR' : 'IIR'}</dd></div>
          </dl>
          <p class="muted small">Referencias: tomas ${p.refs.map((r) => r.take).join(', ')} · mejor toma ${p.bestTake} · tolerancia de melodía ±${fmt(p.tolerances.contour, 2)} st</p>
          <div class="btn-row">
            <button type="button" class="btn primary sm" data-act="verify">${icons.check}Verificar</button>
            <button type="button" class="btn ghost sm" data-act="play" ${p.bestAudio ? '' : 'disabled'}>${icons.play}Escuchar</button>
            <button type="button" class="btn ghost sm" data-act="analyze" ${p.bestAudio ? '' : 'disabled'}>${icons.search}Analizar</button>
            <button type="button" class="btn ghost sm" data-act="export">${icons.download}Exportar</button>
            <button type="button" class="btn ghost sm" data-act="nn" title="Ver cómo la red neuronal reconoce a esta persona">${icons.brain}Red neuronal</button>
            <button type="button" class="btn ghost sm" data-act="esp32" title="filtro.h con el filtro de esta persona, para que la ESP32 filtre el micrófono">${icons.chip}Filtro ESP32</button>
            <button type="button" class="btn ghost sm" data-act="delete" aria-label="Eliminar perfil de ${escapeHtml(p.name)}">${icons.trash}</button>
          </div>
        </article>`;
      })
      .join('');
    for (const card of el.grid.querySelectorAll('.profile-card')) {
      const p = list.find((x) => x.id === card.dataset.id);
      const canvas = card.querySelector('canvas');
      try {
        if (p.bestAudio) {
          drawHeatThumb(canvas, app.analyze(app.profileItem(p), p.filter), { crop: true });
          continue;
        }
      } catch {
        /* sin audio utilizable: se dibuja solo el contorno */
      }
      const c = p.refs[0].contour;
      const times = c.map((_, i) => i * 0.02);
      drawContourSpark(canvas, { times, midi: c, dur: Math.max(0.2, c.length * 0.02) });
    }
  }

  el.grid.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = b.closest('.profile-card').dataset.id;
    const p = app.state.profiles.find((x) => x.id === id);
    if (!p) return;
    const act = b.dataset.act;
    if (act === 'verify') {
      app.bus.emit('select-profile', p.id);
      app.switchTab('verificar');
    } else if (act === 'play') app.togglePlay(app.profileItem(p).samples, b);
    else if (act === 'analyze') {
      app.bus.emit('select-source', app.profileItem(p).id);
      app.switchTab('analisis');
    } else if (act === 'export') {
      download(`silbido-${slug(p.name)}.json`, JSON.stringify(p, null, 1), 'application/json');
    } else if (act === 'nn') {
      nnSel = p.id;
      renderNNProfiles();
      $('#nn-profiles').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (act === 'esp32') {
      download('filtro.h', toCHeader(designFilter(p.filter, app.FS)), 'text/x-c');
      app.toast(`filtro.h de ${p.name} descargado (${p.filter.type === 'fir' ? 'FIR' : 'IIR'} ${p.filter.fl}–${p.filter.fh} Hz). Reemplaza el de esp32/silbido_id/ y vuelve a subir el sketch.`);
    } else if (act === 'delete') {
      if (!confirm(`¿Eliminar el perfil de "${p.name}" de este navegador? Si no lo exportaste, no se puede recuperar.`)) return;
      app.state.profiles = app.state.profiles.filter((x) => x.id !== id);
      app.saveProfiles();
      app.toast(`Perfil de ${p.name} eliminado.`);
    }
  });

  el.import.addEventListener('change', async () => {
    const files = Array.from(el.import.files);
    el.import.value = '';
    let ok = 0;
    let bad = 0;
    for (const f of files) {
      try {
        const data = JSON.parse(await f.text());
        const arr = Array.isArray(data) ? data : [data];
        for (const p of arr) {
          if (!isValidProfile(p)) {
            bad++;
            continue;
          }
          normalizeProfile(p);
          if (!p.id) p.id = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
          const i = app.state.profiles.findIndex((x) => x.id === p.id);
          if (i >= 0) app.state.profiles[i] = p;
          else app.state.profiles.push(p);
          ok++;
        }
      } catch {
        bad++;
      }
    }
    if (ok) app.saveProfiles();
    const msg = ok === 1 ? 'Se importó 1 perfil.' : `Se importaron ${ok} perfiles.`;
    app.toast(ok ? `${msg}${bad ? ` ${bad} archivo(s) no eran perfiles válidos.` : ''}` : 'El archivo no es un perfil válido de Silbido ID.', ok ? '' : 'error');
  });

  el.demo.addEventListener('click', async () => {
    el.demo.disabled = true;
    el.demo.textContent = 'Creando…';
    await new Promise((r) => setTimeout(r, 30));
    try {
      const made = [makeDemoProfile(DEMO_PEOPLE.ana, app.FS, app.DUR, 100), makeDemoProfile(DEMO_PEOPLE.beto, app.FS, app.DUR, 200)];
      for (const p of made) {
        const i = app.state.profiles.findIndex((x) => x.name === p.name);
        if (i >= 0) app.state.profiles[i] = p;
        else app.state.profiles.push(p);
      }
      app.saveProfiles();
      app.toast('Perfiles de demostración creados: Ana y Beto. Prueba en Verificar con los botones de demo.');
    } finally {
      el.demo.disabled = false;
      el.demo.textContent = 'Crear perfiles demo';
    }
  });

  // ---------- red neuronal de los perfiles ----------
  let nnSel = null;
  let nnTimer = 0;
  function renderNNProfiles() {
    const card = $('#nn-profiles');
    const ps = app.state.profiles;
    card.hidden = !ps.length;
    if (!ps.length || app.state.tab !== 'perfiles') return;
    if (!app.modelReady()) {
      $('#nn-prof-note').textContent = 'Entrenando la red neuronal con los perfiles…';
      $('#nn-prof-net').innerHTML = '';
      clearTimeout(nnTimer);
      nnTimer = setTimeout(() => {
        app.getModel();
        renderNNProfiles();
      }, 40);
      return;
    }
    const m = app.getModel();
    let k = ps.findIndex((p) => p.id === nnSel);
    if (k < 0) k = 0;
    const p = ps[k];
    const det = forwardDetail(m, profileEmbedding(p));
    renderNetwork($('#nn-prof-net'), m, det, { target: k, ok: det.p[k] >= 0.6 });
    const rec = p.refs.map((r) => forwardDetail(m, embed({ ...r.features, contour: r.contour })).p[k] * 100);
    const name = escapeHtml(p.name);
    $('#nn-prof-note').innerHTML = `Cada perfil tiene su propia <b>neurona de salida</b>. Aquí entra a la red la huella típica de <b>${name}</b> (el promedio de sus ${p.refs.length} tomas de referencia) y su neurona marca <b>${fmt(det.p[k] * 100, 0)} %</b>. Sus tomas reales, una por una, salen entre ${fmt(Math.min(...rec), 0)} % y ${fmt(Math.max(...rec), 0)} %. La red se entrenó con ${m.samples} ejemplos (${m.arch}) en ${fmt(m.ms, 0)} ms.`;
    $('#nn-prof-pick').innerHTML = ps.map((q, i) => `<button type="button" data-id="${escapeHtml(q.id)}" aria-pressed="${i === k}">${escapeHtml(q.name)}</button>`).join('');
  }
  $('#nn-prof-pick').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    nnSel = b.dataset.id;
    renderNNProfiles();
  });
  app.bus.on('tab-shown', (name) => name === 'perfiles' && renderNNProfiles());

  app.bus.on('profiles-changed', render);
  app.bus.on('profiles-changed', renderNNProfiles);
  app.bus.on('theme-changed', render);
}
