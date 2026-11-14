/**
 * Silbido ID · aplicación principal: estado compartido, pestañas, tema y utilidades comunes.
 */
import { designFilter } from './dsp/filters.js';
import { analyzeSignal } from './dsp/features.js';
import { rankTakes } from './dsp/matcher.js';
import { AudioEngine } from './audio.js';
import { DEFAULT_FILTER, loadProfiles, saveProfiles, loadTheme, saveTheme } from './store.js';
import { autoTuneFilter } from './dsp/autofilter.js';
import { trainModel, modelKey } from './dsp/ai.js';
import { themeChanged, Plot } from './ui/plot.js';
import { enhanceControls } from './ui/controls.js';
import { stft, dbRange } from './dsp/stft.js';
import { synthWhistle, DEMO_PEOPLE } from './dsp/synth.js';
import { buildAnnotations } from './ui/annotate.js';
import { timeAxis, freqAxis } from './views/common.js';
import { Emitter, $, $$, icons, b64ToFloat } from './util.js';
import { initRecord } from './views/record.js';
import { initAnalysis } from './views/analysis.js';
import { initFilter } from './views/filter.js';
import { initProfiles } from './views/profiles.js';
import { initVerify } from './views/verify.js';

const FS = 16000;
const DUR = 5;
const NTAKES = 5;
const TABS = ['grabar', 'analisis', 'filtro', 'perfiles', 'verificar'];

const designCache = new Map();
const profileItems = new Map();

export const designKey = (c) => (c.type === 'fir' ? `fir|${c.fl}|${c.fh}|${c.taps}|${c.win}` : `iir|${c.fl}|${c.fh}|${c.order}`);

function limitCache(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
}

const app = {
  FS,
  DUR,
  NTAKES,
  designKey,
  bus: new Emitter(),
  audio: new AudioEngine(),
  state: {
    // El filtro no se ajusta a mano: lo elige la auto-sintonía a partir de las tomas.
    filter: { ...DEFAULT_FILTER },
    auto: null,
    takes: new Array(NTAKES).fill(null),
    rank: null,
    profiles: loadProfiles(),
    query: null,
    tab: 'grabar',
  },

  getDesign(cfg = app.state.filter) {
    const k = designKey(cfg);
    if (!designCache.has(k)) {
      designCache.set(k, designFilter(cfg, FS));
      limitCache(designCache, 24);
    }
    return designCache.get(k);
  },

  /** Análisis (cacheado) de una toma, la prueba o la mejor toma de un perfil. */
  analyze(item, cfg = app.state.filter) {
    const k = designKey(cfg);
    let a = item.cache.get(k);
    if (!a) {
      a = analyzeSignal(item.samples, FS, app.getDesign(cfg));
      item.cache.set(k, a);
      limitCache(item.cache, 3);
    }
    return a;
  },

  makeItem(kind, samples, extra = {}) {
    return { kind, samples, cache: new Map(), viz: new Map(), createdAt: Date.now(), ...extra };
  },

  profileItem(p) {
    let it = profileItems.get(p.id);
    if (!it || it.profile !== p) {
      let decoded = null;
      it = {
        id: `profile-${p.id}`,
        kind: 'profile',
        profile: p,
        label: p.name,
        cache: new Map(),
        viz: new Map(),
        get samples() {
          if (!decoded) decoded = p.bestAudio ? b64ToFloat(p.bestAudio) : new Float32Array(FS * DUR);
          return decoded;
        },
      };
      profileItems.set(p.id, it);
    }
    return it;
  },

  /** Fuentes que se pueden ver en Análisis. */
  sources() {
    const out = [];
    const best = app.state.rank ? app.state.rank.best : null;
    app.state.takes.forEach((t, i) => {
      if (t) out.push({ id: t.id, label: `Toma ${i + 1}`, best: i === best, item: t });
    });
    if (app.state.query) out.push({ id: 'query', label: 'Prueba', item: app.state.query });
    for (const p of app.state.profiles) {
      const it = app.profileItem(p);
      if (p.bestAudio) out.push({ id: it.id, label: `Perfil · ${p.name}`, item: it });
    }
    return out;
  },

  /** Auto-sintonía: vuelve a elegir el filtro con las tomas actuales. */
  retune() {
    const items = app.state.takes.filter(Boolean);
    const prevKey = designKey(app.state.filter);
    const res = autoTuneFilter(
      items.map((t) => t.samples),
      FS,
      DEFAULT_FILTER,
    );
    app.state.auto = res.status === 'empty' ? null : res;
    app.state.filter = res.cfg;
    if (res.analyses) {
      const k = designKey(res.cfg);
      items.forEach((t, i) => {
        t.cache.set(k, res.analyses[i]);
        limitCache(t.cache, 3);
      });
    }
    if (designKey(res.cfg) !== prevKey) app.bus.emit('filter-changed');
    app.bus.emit('auto-changed');
  },

  /** Red neuronal entrenada con los perfiles actuales (se re-entrena solo si cambian). */
  getModel() {
    const ps = app.state.profiles;
    if (!ps.length) return null;
    const k = modelKey(ps);
    if (!app._model || app._modelKey !== k) {
      app._model = trainModel(ps);
      app._modelKey = k;
    }
    return app._model;
  },
  modelReady() {
    return !!app._model && app._modelKey === modelKey(app.state.profiles);
  },

  /** Cambiaron las tomas: se re-sintoniza el filtro y se vuelve a ordenar. */
  recomputeRanking() {
    app.retune();
    const analyses = app.state.takes.map((t) => (t ? app.analyze(t) : null));
    app.state.rank = analyses.some(Boolean) ? rankTakes(analyses) : null;
  },

  saveProfiles() {
    const ok = saveProfiles(app.state.profiles);
    if (!ok) app.toast('No se pudo guardar en este navegador (almacenamiento lleno o bloqueado). Exporta el perfil para no perderlo.', 'error');
    app.bus.emit('profiles-changed');
    return ok;
  },

  setQuery(samples, source, label) {
    app.state.query = app.makeItem('query', samples, { id: 'query', source, label: label || 'Prueba' });
    app.bus.emit('query-changed');
  },

  toast(msg, kind = '') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast ${kind}`;
    t.hidden = false;
    clearTimeout(app._toastTimer);
    app._toastTimer = setTimeout(() => {
      t.hidden = true;
    }, kind === 'error' ? 6000 : 3800);
  },

  /** Reproduce/detiene y refleja el estado en el botón. */
  togglePlay(samples, btn) {
    if (btn && btn.classList.contains('playing')) {
      app.audio.stopPlayback();
      return;
    }
    app.audio.stopPlayback();
    if (btn) btn.classList.add('playing');
    try {
      app.audio.play(samples, FS, () => btn && btn.classList.remove('playing'));
    } catch (e) {
      if (btn) btn.classList.remove('playing');
      app.toast(`No se pudo reproducir: ${e.message}`, 'error');
    }
  },

  switchTab(name) {
    if (!TABS.includes(name)) name = 'grabar';
    if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
    showTab(name);
  },
};

function showTab(name) {
  app.state.tab = name;
  for (const t of TABS) {
    const panel = $(`#tab-${t}`);
    const btn = $(`#tabbtn-${t}`);
    const on = t === name;
    panel.hidden = !on;
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
  }
  app.bus.emit('tab-shown', name);
  window.scrollTo(0, 0);
}

function initTabs() {
  const list = $('.tabs');
  list.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) app.switchTab(b.dataset.tab);
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = TABS.indexOf(app.state.tab);
    const n = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    app.switchTab(n);
    $(`#tabbtn-${n}`).focus();
  });
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
  // Enlaces internos (#grabar, #verificar, ...)
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    const name = a.getAttribute('href').slice(1);
    if (TABS.includes(name)) {
      e.preventDefault();
      app.switchTab(name);
    }
  });
  showTab(TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'grabar');
}

function initTheme() {
  const btn = $('#theme-btn');
  const labels = { auto: 'Tema: automático', light: 'Tema: claro', dark: 'Tema: oscuro' };
  const apply = (mode) => {
    if (mode === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = mode;
    btn.innerHTML = mode === 'dark' ? icons.moon : mode === 'light' ? icons.sun : icons.auto;
    btn.title = `${labels[mode]} (clic para cambiar)`;
    btn.setAttribute('aria-label', `${labels[mode]}. Cambiar tema`);
    themeChanged();
    app.bus.emit('theme-changed');
  };
  let mode = loadTheme();
  apply(mode);
  btn.addEventListener('click', () => {
    mode = mode === 'auto' ? 'light' : mode === 'light' ? 'dark' : 'auto';
    saveTheme(mode);
    apply(mode);
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (mode === 'auto') apply('auto');
  });
}

function fillIcons() {
  for (const el of $$('[data-icon]')) el.innerHTML = icons[el.dataset.icon] || '';
}

/** Contadores en las pestañas: tomas grabadas (n/5) y perfiles guardados. */
function initBadges() {
  const takes = $('#badge-grabar');
  const profiles = $('#badge-perfiles');
  app.bus.on('takes-changed', () => {
    const n = app.state.takes.filter(Boolean).length;
    takes.textContent = n ? `${n}/${NTAKES}` : '';
    takes.classList.toggle('done', n === NTAKES);
  });
  app.bus.on('profiles-changed', () => {
    const n = app.state.profiles.length;
    profiles.textContent = n ? String(n) : '';
    profiles.classList.toggle('done', n > 0);
  });
}

/** Mapa de calor de ejemplo en la portada: un silbido sintético con sus recuadros, hecho con el mismo motor. */
function initHeroPreview() {
  const host = $('#hero-plot');
  if (!host) return;
  const plot = new Plot(host, {
    height: 250,
    margin: { l: 42, r: 12, t: 14, b: 28 },
    x: { ...timeAxis(), label: '' },
    y: { ...freqAxis(), label: '', min: 500, max: 5500 },
    crosshair: null,
    tooltip: () => '',
    name: 'ejemplo',
  });
  const draw = () => {
    const a = app.analyze(app.makeItem('demo', synthWhistle(DEMO_PEOPLE.ana, { fs: FS, dur: DUR, seed: 7 })));
    const S = stft(a.y, FS, { N: 512, overlap: 0.875, win: 'hann', fmax: 8000 });
    const r = dbRange(S.data, 56);
    const d = a.design;
    plot.setAxes({ x: { max: a.duration }, y: { min: Math.max(0, d.fl * 0.55), max: Math.min(8000, d.fh * 1.45) } });
    plot.set({ heatmap: { ...S, vmin: r.vmin, vmax: r.vmax }, ...buildAnnotations(a, { compact: true }).layers });
  };
  setTimeout(draw, 60);
  app.bus.on('filter-changed', draw);
}

function boot() {
  initTheme();
  fillIcons();
  enhanceControls();
  initBadges();
  initRecord(app);
  initAnalysis(app);
  initFilter(app);
  initProfiles(app);
  initVerify(app);
  initTabs();
  initHeroPreview();
  app.bus.emit('takes-changed');
  app.bus.emit('profiles-changed');
}

boot();

export default app;
