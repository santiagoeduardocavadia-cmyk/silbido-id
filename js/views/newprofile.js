// Perfiles · "Nuevo perfil desde audios": subes los silbidos, la web los analiza, elige el filtro
// (auto-sintonía) y crea la huella sin pasar por la pestaña Grabar.
import { decodeFileAll, splitTakes } from '../audio.js';
import { autoTuneFilter, cfgLabel } from '../dsp/autofilter.js';
import { buildProfile, rankTakes, MIN_VALID_TAKES } from '../dsp/matcher.js';
import { noteName } from '../dsp/features.js';
import { DEFAULT_FILTER } from '../store.js';
import { $, fmt, icons, escapeHtml, floatToB64 } from '../util.js';
import { drawHeatThumb, drawWaveSpark } from './common.js';

const MAX = 5;

export function initNewProfile(app) {
  const el = {
    open: $('#np-open'),
    card: $('#new-profile'),
    close: $('#np-close'),
    name: $('#np-name'),
    drop: $('#np-drop'),
    files: $('#np-files'),
    list: $('#np-list'),
    auto: $('#np-auto'),
    create: $('#np-create'),
    clear: $('#np-clear'),
  };
  el.open.querySelector('.ico').innerHTML = icons.plus;
  el.drop.querySelector('.ico').innerHTML = icons.upload;

  let takes = []; // { name, samples }
  let tuned = null;
  let rank = null;
  let busy = false;

  const show = (on) => {
    el.card.hidden = !on;
    if (on) {
      el.card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => el.name.focus(), 250);
    }
  };
  el.open.addEventListener('click', () => show(el.card.hidden));
  el.close.addEventListener('click', () => show(false));

  async function addFiles(files) {
    if (busy || !files.length) return;
    if (takes.length >= MAX) {
      app.toast(`Ya hay ${MAX} tomas. Quita alguna para subir otra.`);
      return;
    }
    busy = true;
    el.auto.hidden = false;
    el.auto.innerHTML = `<span class="spin" aria-hidden="true"></span> Leyendo ${files.length === 1 ? 'el audio' : `${files.length} audios`}…`;
    const bad = [];
    for (const f of files) {
      try {
        const x = await decodeFileAll(f, app.FS);
        const parts = splitTakes(x, app.FS, app.DUR, MAX - takes.length);
        parts.forEach((s, i) => takes.push({ name: parts.length > 1 ? `${f.name} · parte ${i + 1}` : f.name, samples: s }));
      } catch {
        bad.push(f.name);
      }
      if (takes.length >= MAX) break;
    }
    if (bad.length) app.toast(`No se pudo leer: ${bad.join(', ')}.`, 'error');
    await analyze();
    busy = false;
  }

  async function analyze() {
    el.auto.hidden = false;
    el.auto.innerHTML = '<span class="spin" aria-hidden="true"></span> Analizando los silbidos y eligiendo el filtro…';
    await new Promise((r) => setTimeout(r, 30));
    if (!takes.length) {
      tuned = null;
      rank = null;
    } else {
      tuned = autoTuneFilter(
        takes.map((t) => t.samples),
        app.FS,
        DEFAULT_FILTER,
      );
      const analyses = tuned.analyses || [];
      rank = analyses.length ? rankTakes(analyses) : null;
    }
    render();
  }

  function render() {
    const byIdx = new Map(rank ? rank.list.map((r) => [r.idx, r]) : []);
    el.list.innerHTML = takes
      .map((t, i) => {
        const a = tuned && tuned.analyses ? tuned.analyses[i] : null;
        const f = a ? a.features : null;
        const r = byIdx.get(i);
        const best = rank && rank.best === i;
        const info = !a
          ? '<span class="warn">Sin silbido detectado en ninguna toma</span>'
          : f.valid
            ? `${fmt(f.pitchHz, 0)} Hz · ${noteName(f.pitchMidi)} · ${fmt(f.durVoiced, 2)} s con silbido · ${f.segments} segm.`
            : '<span class="warn">No se detectó un silbido claro</span>';
        return `<li class="take np-item ${best ? 'best' : ''}" data-i="${i}">
          <span class="take-num">${i + 1}</span>
          <canvas class="take-thumb" aria-hidden="true"></canvas>
          <div class="take-info"><strong>${escapeHtml(t.name)} ${best ? `<span class="badge">${icons.star}Mejor</span>` : ''}</strong><small>${info}</small></div>
          <div class="take-score">${r ? r.score : '—'}<small>puntos</small></div>
          <div class="take-actions">
            <button type="button" data-act="play" title="Escuchar">${icons.play}</button>
            <button type="button" data-act="del" title="Quitar" aria-label="Quitar ${escapeHtml(t.name)}">${icons.trash}</button>
          </div>
        </li>`;
      })
      .join('');
    for (const li of el.list.querySelectorAll('li[data-i]')) {
      const i = Number(li.dataset.i);
      const a = tuned && tuned.analyses ? tuned.analyses[i] : null;
      const c = li.querySelector('canvas');
      if (a && a.features.valid) drawHeatThumb(c, a);
      else drawWaveSpark(c, takes[i].samples);
    }
    const valid = rank ? rank.validCount : 0;
    if (!takes.length) {
      el.auto.hidden = true;
    } else if (tuned && tuned.status === 'ok') {
      const c = tuned.cfg;
      el.auto.hidden = false;
      el.auto.innerHTML = `${icons.sparkle}<span>Filtro elegido por la auto-sintonía: <b>${cfgLabel(c)}</b>, ${fmt(c.fl, 0)}–${fmt(c.fh, 0)} Hz. ${tuned.reasons[0]}</span>`;
    } else {
      el.auto.hidden = false;
      el.auto.innerHTML = `${icons.alert}<span>${(tuned && tuned.reasons[0]) || 'No se encontró silbido.'}</span>`;
    }
    el.create.disabled = valid < MIN_VALID_TAKES;
    el.create.textContent = valid < MIN_VALID_TAKES ? `Crear perfil (faltan ${MIN_VALID_TAKES - valid} tomas válidas)` : `Crear perfil con ${valid} tomas válidas`;
    el.clear.disabled = !takes.length;
  }

  el.files.addEventListener('change', () => {
    const fs = Array.from(el.files.files);
    el.files.value = '';
    addFiles(fs);
  });
  el.drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      el.files.click();
    }
  });
  for (const ev of ['dragenter', 'dragover']) {
    el.drop.addEventListener(ev, (e) => {
      e.preventDefault();
      el.drop.classList.add('over');
    });
  }
  for (const ev of ['dragleave', 'drop']) {
    el.drop.addEventListener(ev, (e) => {
      e.preventDefault();
      el.drop.classList.remove('over');
    });
  }
  el.drop.addEventListener('drop', (e) => {
    const fs = Array.from(e.dataTransfer.files || []).filter((f) => f.type.startsWith('audio/') || /\.(wav|mp3|m4a|ogg|webm|flac|aac)$/i.test(f.name));
    if (!fs.length) app.toast('Arrastra archivos de audio (WAV, MP3, M4A, OGG…).', 'error');
    else addFiles(fs);
  });

  el.list.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const i = Number(b.closest('li').dataset.i);
    if (b.dataset.act === 'play') app.togglePlay(takes[i].samples, b);
    else if (b.dataset.act === 'del') {
      takes.splice(i, 1);
      analyze();
    }
  });
  el.clear.addEventListener('click', () => {
    takes = [];
    analyze();
  });

  el.create.addEventListener('click', () => {
    const name = el.name.value.trim();
    if (!name) {
      el.name.focus();
      app.toast('Escribe el nombre de la persona que silba.');
      return;
    }
    let profile;
    try {
      profile = buildProfile({ name, analyses: tuned.analyses, filterCfg: tuned.cfg, fs: app.FS });
    } catch (e) {
      app.toast(e.message, 'error');
      return;
    }
    profile.bestAudio = floatToB64(takes[profile.bestTake - 1].samples);
    profile.source = 'archivos';
    const i = app.state.profiles.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
    if (i >= 0) {
      if (!confirm(`Ya existe un perfil llamado "${app.state.profiles[i].name}". ¿Reemplazarlo?`)) return;
      app.state.profiles[i] = profile;
    } else app.state.profiles.push(profile);
    if (app.saveProfiles()) app.toast(`Perfil de ${name} creado con ${takes.length} audios (filtro ${cfgLabel(tuned.cfg)}). Ya puedes probarlo en Verificar.`);
    takes = [];
    tuned = null;
    rank = null;
    el.name.value = '';
    render();
    show(false);
    app.bus.emit('select-profile', profile.id);
  });

  app.bus.on('theme-changed', () => !el.card.hidden && takes.length && render());
  render();
}
