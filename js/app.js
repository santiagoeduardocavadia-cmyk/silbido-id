/**
 * Silbido ID · aplicación principal: estado compartido, pestañas, tema y utilidades comunes.
 */
import { designFilter } from './dsp/filters.js';
import { analyzeSignal } from './dsp/features.js';
import { rankTakes } from './dsp/matcher.js';
import { AudioEngine } from './audio.js';
import { loadFilter, saveFilter, loadProfiles, saveProfiles, loadTheme, saveTheme } from './store.js';
import { themeChanged } from './ui/plot.js';
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
    filter: loadFilter(),
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

  recomputeRanking() {
    const analyses = app.state.takes.map((t) => (t ? app.analyze(t) : null));
    app.state.rank = analyses.some(Boolean) ? rankTakes(analyses) : null;
  },

  setFilter(cfg) {
    app.state.filter = { ...cfg };
    saveFilter(app.state.filter);
    app.recomputeRanking();
    app.bus.emit('filter-changed');
    app.bus.emit('takes-changed');
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

function boot() {
  initTheme();
  fillIcons();
  initRecord(app);
  initAnalysis(app);
  initFilter(app);
  initProfiles(app);
  initVerify(app);
  initTabs();
  app.bus.emit('takes-changed');
  app.bus.emit('profiles-changed');
}

boot();

export default app;
