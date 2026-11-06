// Vista 4 · Perfiles: lista, importar/exportar JSON, perfiles de demostración.
import { buildProfile } from '../dsp/matcher.js';
import { analyzeSignal, noteName } from '../dsp/features.js';
import { synthWhistle, DEMO_PEOPLE } from '../dsp/synth.js';
import { isValidProfile, DEFAULT_FILTER } from '../store.js';
import { designFilter } from '../dsp/filters.js';
import { $, fmt, icons, escapeHtml, download, slug, formatDate, floatToB64 } from '../util.js';
import { drawContourSpark } from './common.js';

export function makeDemoProfile(person, fs, dur, seedBase) {
  const cfg = { ...DEFAULT_FILTER };
  const design = designFilter(cfg, fs);
  const samples = [1, 2, 3, 4, 5].map((i) => synthWhistle(person, { fs, dur, seed: seedBase + i }));
  const analyses = samples.map((x) => analyzeSignal(x, fs, design));
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
  };
  el.import.closest('label').querySelector('.ico').innerHTML = icons.upload;

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
          <canvas class="profile-spark" aria-label="Contorno de tono de la mejor toma" role="img"></canvas>
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
            <button type="button" class="btn ghost sm" data-act="delete" aria-label="Eliminar perfil de ${escapeHtml(p.name)}">${icons.trash}</button>
          </div>
        </article>`;
      })
      .join('');
    for (const card of el.grid.querySelectorAll('.profile-card')) {
      const p = list.find((x) => x.id === card.dataset.id);
      const c = p.refs[0].contour;
      const times = c.map((_, i) => i * 0.02);
      drawContourSpark(card.querySelector('canvas'), { times, midi: c, dur: Math.max(0.2, c.length * 0.02) });
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
    app.toast(ok ? `Se importaron ${ok} perfil${ok === 1 ? '' : 'es'}.${bad ? ` ${bad} archivo(s) no eran perfiles válidos.` : ''}` : 'El archivo no es un perfil válido de Silbido ID.', ok ? '' : 'error');
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

  app.bus.on('profiles-changed', render);
  app.bus.on('theme-changed', render);
}
