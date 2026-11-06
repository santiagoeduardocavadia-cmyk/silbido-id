// Vista 5 · Verificar: compara un silbido nuevo con un perfil (1:1) o con todos (1:N).
import { Plot, addExportButtons } from '../ui/plot.js';
import { compareToProfile } from '../dsp/matcher.js';
import { stft, dbRange } from '../dsp/stft.js';
import { synthWhistle, DEMO_PEOPLE } from '../dsp/synth.js';
import { decodeFile } from '../audio.js';
import { recordClip } from './record.js';
import { $, $$, fmt, icons, escapeHtml } from '../util.js';
import { timeAxis, freqAxis, noteAxis, midiRange, barRow } from './common.js';

const IMITADOR = { ...DEMO_PEOPLE.ana, name: 'Imitador', baseHz: DEMO_PEOPLE.ana.baseHz * 2 ** (2.5 / 12), breath: 0.08, vibratoCents: 35, vibratoHz: 4 };

export function initVerify(app) {
  const el = {
    profile: $('#verify-profile'),
    strict: $('#verify-strict'),
    rec: $('#verify-rec'),
    file: $('#verify-file'),
    verdict: $('#verdict'),
    details: $('#verify-details'),
    comp: $('#comp-bars'),
    ident: $('#ident-bars'),
    mode: $('#contour-mode'),
    playRef: $('#play-ref'),
    playQuery: $('#play-query'),
    analyze: $('#query-analyze'),
    demoAna: $('#demo-ana'),
    demoBeto: $('#demo-beto'),
    demoImit: $('#demo-imit'),
  };
  el.file.closest('label').querySelector('.ico').innerHTML = icons.upload;
  el.playRef.querySelector('.ico').innerHTML = icons.play;
  el.playQuery.querySelector('.ico').innerHTML = icons.play;
  const recUI = { box: $('#verify-progress'), count: $('#verify-count'), bar: $('#verify-bar'), cancel: $('#verify-cancel'), button: el.rec };

  let selected = '*';
  let contourMode = 'raw';
  let result = null;
  let demoSeed = 1000;

  const vAxis = (label) => ({ label, min: 0, max: 3, tip: (v) => `${fmt(v, 2)} s` });
  const P = {
    contour: new Plot($('#plot-vcontour'), { height: 260, x: vAxis('Tiempo con silbido (s)'), y: noteAxis(84, 100), name: 'contornos' }),
    dtw: new Plot($('#plot-dtw'), {
      height: 300,
      x: vAxis('Prueba (s con silbido)'),
      y: vAxis('Referencia (s con silbido)'),
      crosshair: 'xy',
      colorbar: { label: 'st', format: (v) => fmt(v, 0) },
      name: 'matriz-dtw',
    }),
    ref: new Plot($('#plot-vref'), { height: 230, x: timeAxis(), y: freqAxis(), crosshair: 'xy', colorbar: { label: 'dB' }, name: 'espectrograma-referencia' }),
    query: new Plot($('#plot-vquery'), { height: 230, x: timeAxis(), y: freqAxis(), crosshair: 'xy', colorbar: { label: 'dB' }, name: 'espectrograma-prueba' }),
  };
  addExportButtons($('#tools-dtw'), P.dtw, 'matriz-dtw', { csv: false });

  // ---------- selección ----------
  function renderSelect() {
    const ps = app.state.profiles;
    if (selected !== '*' && !ps.some((p) => p.id === selected)) selected = '*';
    el.profile.innerHTML =
      `<option value="*">Todos los perfiles (¿quién silbó?)</option>` +
      ps.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
    el.profile.value = selected;
    const none = !ps.length;
    for (const b of [el.rec, el.demoAna, el.demoBeto, el.demoImit]) b.disabled = none;
    el.file.disabled = none;
  }

  el.profile.addEventListener('change', () => {
    selected = el.profile.value;
    compute();
  });
  el.strict.addEventListener('change', compute);
  el.mode.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    contourMode = b.dataset.mode;
    for (const x of $$('button', el.mode)) x.setAttribute('aria-pressed', String(x === b));
    drawContours();
  });

  // ---------- entradas ----------
  el.rec.addEventListener('click', async () => {
    const x = await recordClip(app, recUI);
    if (x) app.setQuery(x, 'mic', 'Prueba');
  });
  el.file.addEventListener('change', async () => {
    const f = el.file.files[0];
    el.file.value = '';
    if (!f) return;
    try {
      const { samples } = await decodeFile(f, app.FS, app.DUR);
      app.setQuery(samples, 'archivo', `Prueba · ${f.name}`);
    } catch (e) {
      app.toast(`No se pudo leer el archivo de audio (${e.message || e}).`, 'error');
    }
  });
  const demo = (person, label) => app.setQuery(synthWhistle(person, { fs: app.FS, dur: app.DUR, seed: demoSeed++ }), 'demo', label);
  el.demoAna.addEventListener('click', () => demo(DEMO_PEOPLE.ana, 'Prueba · demo Ana'));
  el.demoBeto.addEventListener('click', () => demo(DEMO_PEOPLE.beto, 'Prueba · demo Beto'));
  el.demoImit.addEventListener('click', () => demo(IMITADOR, 'Prueba · imitador'));
  el.playQuery.addEventListener('click', () => app.state.query && app.togglePlay(app.state.query.samples, el.playQuery));
  el.playRef.addEventListener('click', () => result && result.target && app.togglePlay(app.profileItem(result.target.p).samples, el.playRef));
  el.analyze.addEventListener('click', () => {
    app.bus.emit('select-source', 'query');
    app.switchTab('analisis');
  });

  // ---------- cálculo ----------
  function compute() {
    const q = app.state.query;
    const ps = app.state.profiles;
    if (!q || !ps.length) {
      result = null;
      render();
      return;
    }
    const T = Number(el.strict.value);
    const all = ps.map((p) => {
      const a = app.analyze(q, p.filter);
      return { p, a, r: compareToProfile(a, p, T) };
    });
    const valid = all.filter((x) => x.r.valid).sort((x, y) => x.r.D - y.r.D);
    const target = selected === '*' ? valid[0] || all[0] : all.find((x) => x.p.id === selected);
    result = { all, valid, target, identify: selected === '*', T };
    render();
  }

  // ---------- render ----------
  function gauge(pct, cls) {
    const r = 70;
    const L = 2 * Math.PI * r;
    const color = cls === 'good' ? 'var(--good)' : cls === 'critical' ? 'var(--critical)' : 'var(--warning)';
    return `<div class="gauge" role="img" aria-label="Similitud ${fmt(pct, 0)} %">
      <svg viewBox="0 0 168 168"><circle cx="84" cy="84" r="${r}" fill="none" stroke="var(--surface-3)" stroke-width="14"/>
      <circle cx="84" cy="84" r="${r}" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round" stroke-dasharray="${(L * Math.max(0.5, pct)) / 100} ${L}"/>
      <line x1="${84 - r - 10}" y1="84" x2="${84 - r + 10}" y2="84" stroke="var(--text-secondary)" stroke-width="2.5"/></svg>
      <div class="g-val"><b>${fmt(pct, pct < 10 ? 1 : 0)}%</b><span>similitud</span></div></div>`;
  }

  function renderVerdict() {
    if (!app.state.profiles.length) {
      el.verdict.innerHTML = `<div class="verdict-empty">${icons.user}<h2>Primero crea un perfil</h2><p>Graba tus 5 tomas en <a href="#grabar">Grabar</a> y guarda el perfil, o crea los <a href="#perfiles">perfiles de demostración</a>.</p></div>`;
      return;
    }
    if (!result) {
      el.verdict.innerHTML = `<div class="verdict-empty">${icons.mic}<h2>Silba para comparar</h2><p>Pulsa <b>Silbar ahora</b> y silba durante 5 segundos. Puede ser el dueño del perfil u otra persona.</p></div>`;
      return;
    }
    const { target, identify, T } = result;
    if (!target.r.valid) {
      el.verdict.innerHTML = `<div class="verdict-main">${gauge(0, 'warning')}<div class="verdict-text warning"><h2>${icons.alert}No se detectó un silbido</h2><p>${target.r.reason} Acércate al micrófono, silba más fuerte o revisa que la entrada correcta esté seleccionada.</p></div></div>`;
      return;
    }
    const { r, p } = target;
    const ok = r.accepted;
    let title;
    let text;
    if (identify) {
      title = ok ? `Es el silbido de ${escapeHtml(p.name)}` : 'No coincide con ningún perfil';
      text = ok
        ? `De ${result.all.length} perfil${result.all.length === 1 ? '' : 'es'}, el más cercano es <b>${escapeHtml(p.name)}</b> y su distancia está dentro del umbral.`
        : `El más parecido es <b>${escapeHtml(p.name)}</b>, pero su distancia D = ${fmt(r.D, 2)} supera el umbral T = ${fmt(T, 1)}.`;
    } else {
      title = ok ? `Es el silbido de ${escapeHtml(p.name)}` : `No es el silbido de ${escapeHtml(p.name)}`;
      text = ok
        ? `La melodía, el tono y el estilo coinciden con la huella guardada (D = ${fmt(r.D, 2)} ≤ T = ${fmt(T, 1)}).`
        : `La distancia D = ${fmt(r.D, 2)} supera el umbral T = ${fmt(T, 1)}. Mira abajo qué características no coinciden.`;
    }
    const cls = ok ? 'good' : 'critical';
    el.verdict.innerHTML = `<div class="verdict-main">${gauge(r.similarity, cls)}
      <div class="verdict-text ${cls}"><h2>${ok ? icons.check : icons.x}${title}</h2><p>${text}</p>
      <div class="verdict-meta"><span class="pill">D = ${fmt(r.D, 2)}</span><span class="pill">T = ${fmt(T, 1)}</span><span class="pill">DTW ${fmt(r.dtw.distance, 2)} st</span><span class="pill">${escapeHtml(app.state.query.label)}</span></div></div></div>`;
  }

  function fmtComp(c, v) {
    if (c.key === 'purity') return `${fmt(v * 100, 0)} %`;
    if (c.key === 'segments') return fmt(v, 1);
    if (c.key === 'duration') return `${fmt(v, 2)} s`;
    return `${fmt(v, 2)} st`;
  }

  function renderBars() {
    const { target } = result;
    el.comp.innerHTML = target.r.components
      .map((c) => {
        const ratio = c.ratio;
        const cls = ratio <= 1 ? 'good' : ratio <= 1.5 ? 'warning' : 'critical';
        const st = cls === 'good' ? `${icons.check}dentro` : cls === 'warning' ? `${icons.alert}límite` : `${icons.x}fuera`;
        return barRow({
          label: `${c.label} <small>peso ${c.weight}</small>`,
          sub: `d = ${fmtComp(c, c.value)} · τ = ${fmtComp(c, c.tol)}`,
          pct: (Math.min(ratio, 2) / 2) * 100,
          mark: 50,
          valueText: `<span class="status ${cls}">${st}</span>`,
          cls,
          title: `d/τ = ${fmt(ratio, 2)}`,
        });
      })
      .join('');
    const rows = [...result.valid, ...result.all.filter((x) => !x.r.valid)];
    el.ident.innerHTML = rows
      .map((x, i) => {
        if (!x.r.valid) return barRow({ label: escapeHtml(x.p.name), pct: 0, valueText: '—' });
        const top = i === 0;
        return barRow({
          label: escapeHtml(x.p.name),
          sub: `D = ${fmt(x.r.D, 2)}`,
          pct: x.r.similarity,
          mark: 50,
          valueText: `<span class="status ${x.r.accepted ? 'good' : 'critical'}">${x.r.accepted ? icons.check : icons.x}${fmt(x.r.similarity, x.r.similarity < 10 ? 1 : 0)} %</span>`,
          cls: top ? 'hi top' : '',
        });
      })
      .join('');
  }

  function drawContours() {
    if (!result || !result.target.r.valid) return;
    const { r, a, p } = result.target;
    const ref = r.refContour;
    const q = a.contour;
    const [lo, hi] = midiRange([ref, q]);
    if (contourMode === 'raw') {
      P.contour.setAxes({ x: { label: 'Tiempo con silbido (s)', max: Math.max(ref.length, q.length) * 0.02 }, y: { min: lo, max: hi } });
      P.contour.set({
        lines: [
          { x0: 0, dx: 0.02, y: Float32Array.from(ref), color: '--series-1', width: 2.2, label: `Referencia · ${escapeHtml(p.name)}` },
          { x0: 0, dx: 0.02, y: q, color: '--series-2', width: 2.2, label: 'Prueba' },
        ],
      });
    } else {
      const path = r.dtw.path;
      const ra = Float32Array.from(path, ([, j]) => ref[j]);
      const qa = Float32Array.from(path, ([i]) => q[i]);
      P.contour.setAxes({ x: { label: 'Paso del camino DTW (×20 ms)', max: path.length * 0.02 }, y: { min: lo, max: hi } });
      P.contour.set({
        lines: [
          { x0: 0, dx: 0.02, y: ra, color: '--series-1', width: 2.2, label: `Referencia · ${escapeHtml(p.name)}` },
          { x0: 0, dx: 0.02, y: qa, color: '--series-2', width: 2.2, label: 'Prueba' },
        ],
      });
    }
  }

  function drawDtw() {
    const { r, a } = result.target;
    const ref = r.refContour;
    const q = a.contour;
    const n = q.length;
    const m = ref.length;
    const data = new Float32Array(n * m);
    for (let c = 0; c < n; c++) for (let k = 0; k < m; k++) data[c * m + k] = Math.abs(q[c] - ref[k]);
    const path = r.dtw.path;
    P.dtw.setAxes({ x: { max: n * 0.02 }, y: { max: m * 0.02 } });
    P.dtw.set({
      heatmap: { data, cols: n, rows: m, x0: 0, x1: n * 0.02, y0: 0, y1: m * 0.02, vmin: 0, vmax: 6, smooth: false, tip: (v) => `|Δ| = ${fmt(v, 2)} st` },
      lines: [{ x: Float32Array.from(path, ([i]) => (i + 0.5) * 0.02), y: Float32Array.from(path, ([, j]) => (j + 0.5) * 0.02), color: '--series-2', width: 2.2, label: 'Camino DTW' }],
    });
  }

  function drawSpecs() {
    const { p } = result.target;
    const refItem = app.profileItem(p);
    const ra = app.analyze(refItem, p.filter);
    const qa = result.target.a;
    const key = `${app.designKey(p.filter)}|vstft`;
    const get = (item, a) => {
      if (!item.viz.has(key)) item.viz.set(key, stft(a.y, app.FS, { N: 512, overlap: 0.75, fmax: 8000 }));
      return item.viz.get(key);
    };
    const sr = get(refItem, ra);
    const sq = get(app.state.query, qa);
    const r1 = dbRange(sr.data, 70);
    const r2 = dbRange(sq.data, 70);
    const vmax = Math.max(r1.vmax, r2.vmax);
    P.ref.set({ heatmap: { ...sr, vmin: vmax - 70, vmax } });
    P.query.set({ heatmap: { ...sq, vmin: vmax - 70, vmax } });
  }

  function render() {
    renderVerdict();
    const show = result && result.target && result.target.r.valid;
    el.details.hidden = !show;
    if (!show) return;
    renderBars();
    drawContours();
    drawDtw();
    drawSpecs();
  }

  app.bus.on('profiles-changed', () => {
    renderSelect();
    compute();
  });
  app.bus.on('query-changed', compute);
  app.bus.on('select-profile', (id) => {
    selected = id;
    renderSelect();
    compute();
  });
  app.bus.on('theme-changed', () => result && renderVerdict());
  renderSelect();
  render();
}
