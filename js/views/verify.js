// Vista 5 · Verificar: compara un silbido nuevo con un perfil (1:1) o con todos (1:N).
// Dos modos de identificar: "por filtros" (reglas fijas sobre la huella, D ≤ T) y "por inteligencia"
// (red neuronal propia entrenada con los perfiles), o los dos a la vez. Incluye identificación en
// tiempo real y un recorrido paso a paso que explica cómo se decidió.
import { Plot, addExportButtons } from '../ui/plot.js';
import { compareToProfile } from '../dsp/matcher.js';
import { analyzeSignal } from '../dsp/features.js';
import { predict, explain, aiThreshold, forwardDetail, profileEmbedding } from '../dsp/ai.js';
import { renderNetwork, renderMatch } from '../ui/nnview.js';
import { cfgLabel } from '../dsp/autofilter.js';
import { stft, dbRange } from '../dsp/stft.js';
import { synthWhistle, DEMO_PEOPLE } from '../dsp/synth.js';
import { decodeFile } from '../audio.js';
import { recordClip } from './record.js';
import { $, $$, fmt, icons, escapeHtml } from '../util.js';
import { buildAnnotations } from '../ui/annotate.js';
import { startTour, endTour } from '../ui/tour.js';
import { timeAxis, freqAxis, noteAxis, midiRange, barRow } from './common.js';

const IMITADOR = { ...DEMO_PEOPLE.ana, name: 'Imitador', baseHz: DEMO_PEOPLE.ana.baseHz * 2 ** (2.5 / 12), breath: 0.08, vibratoCents: 35, vibratoHz: 4 };

const METHOD_HELP = {
  filtros: 'Pasa el silbido por el filtro de cada perfil y compara melodía, tono, duración, segmentos y pureza con reglas fijas: se acepta si D ≤ T.',
  ia: 'Una red neuronal hecha aquí, entrenada con tus perfiles, mira la huella completa y dice quién es y con qué probabilidad.',
  ambos: 'Los dos modos opinan por separado y solo se acepta si coinciden en la misma persona. Es el modo más seguro.',
};
// Filtro ancho para encontrar los tramos de silbido en vivo (antes de mirar cada perfil).
const LIVE_SURVEY = { type: 'iir', fl: 400, fh: 7000, order: 2, taps: 101, win: 'hamming' };
const METHOD_NAME = { filtros: 'por filtros', ia: 'por inteligencia', ambos: 'con los dos modos' };

export function initVerify(app) {
  const el = {
    profile: $('#verify-profile'),
    strict: $('#verify-strict'),
    method: $('#verify-method'),
    methodHelp: $('#method-help'),
    rec: $('#verify-rec'),
    file: $('#verify-file'),
    liveBtn: $('#verify-live'),
    verdict: $('#verdict'),
    details: $('#verify-details'),
    comp: $('#comp-bars'),
    ident: $('#ident-bars'),
    aiBars: $('#ai-bars'),
    aiNote: $('#ai-note'),
    aiWhy: $('#ai-why'),
    aiModel: $('#ai-model'),
    mode: $('#contour-mode'),
    playRef: $('#play-ref'),
    playQuery: $('#play-query'),
    analyze: $('#query-analyze'),
    demoAna: $('#demo-ana'),
    demoBeto: $('#demo-beto'),
    demoImit: $('#demo-imit'),
    liveCard: $('#live-id'),
    liveStatus: $('#live-status'),
    liveBarsF: $('#live-bars-f'),
    liveBarsIa: $('#live-bars-ia'),
    liveFreeze: $('#live-freeze'),
    liveStop: $('#live-stop'),
  };
  el.file.closest('label').querySelector('.ico').innerHTML = icons.upload;
  el.playRef.querySelector('.ico').innerHTML = icons.play;
  el.playQuery.querySelector('.ico').innerHTML = icons.play;
  const recUI = { box: $('#verify-progress'), count: $('#verify-count'), bar: $('#verify-bar'), cancel: $('#verify-cancel'), button: el.rec };

  let selected = '*';
  let method = 'filtros';
  let contourMode = 'raw';
  let result = null;
  let demoSeed = 1000;
  let model = null;
  let training = false;

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
    live: new Plot($('#plot-live-id'), { height: 250, x: { ...timeAxis(), max: 5 }, y: freqAxis(), crosshair: null, colorbar: { label: 'dB' }, name: 'en-vivo' }),
  };
  addExportButtons($('#tools-dtw'), P.dtw, 'matriz-dtw', { csv: false });

  // ---------- la inteligencia (se entrena cuando cambian los perfiles) ----------
  function ensureModel(then) {
    if (app.modelReady()) {
      model = app.getModel();
      return true;
    }
    if (!training) {
      training = true;
      setTimeout(() => {
        model = app.getModel();
        training = false;
        then();
      }, 30);
    }
    return false;
  }

  // ---------- selección ----------
  function renderSelect() {
    const ps = app.state.profiles;
    if (selected !== '*' && !ps.some((p) => p.id === selected)) selected = '*';
    el.profile.innerHTML =
      `<option value="*">Todos los perfiles (¿quién silbó?)</option>` +
      ps.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
    el.profile.value = selected;
    const none = !ps.length;
    for (const b of [el.rec, el.demoAna, el.demoBeto, el.demoImit, el.liveBtn]) b.disabled = none;
    el.file.disabled = none;
  }

  function setMethod(m) {
    method = m;
    for (const b of $$('button', el.method)) b.setAttribute('aria-pressed', String(b.dataset.method === m));
    el.methodHelp.textContent = METHOD_HELP[m];
    $('#verify-details').dataset.method = m;
  }

  el.profile.addEventListener('change', () => {
    selected = el.profile.value;
    compute();
  });
  el.strict.addEventListener('change', compute);
  el.method.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-method]');
    if (!b) return;
    setMethod(b.dataset.method);
    compute();
  });
  el.mode.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    contourMode = b.dataset.mode;
    for (const x of $$('button', el.mode)) x.setAttribute('aria-pressed', String(x === b));
    drawContours();
  });

  // ---------- entradas ----------
  el.rec.addEventListener('click', async () => {
    stopLive();
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

  // ---------- decisión con los dos modos ----------
  /** Evalúa un silbido ya analizado por cada perfil con los dos modos. rows: [{p, k, a, r, ai}] */
  function decide(rows, T) {
    const thr = aiThreshold(T);
    const identify = selected === '*';
    const valid = rows.filter((x) => x.r.valid);
    const byD = [...valid].sort((x, y) => x.r.D - y.r.D);
    const byAi = [...valid].sort((x, y) => y.ai.p - x.ai.p);
    const pick = (sorted) => (identify ? sorted[0] || rows[0] : rows.find((x) => x.p.id === selected) || rows[0]);
    const fT = pick(byD);
    const iT = pick(byAi);
    const fOk = !!(fT && fT.r.valid && fT.r.accepted);
    const iOk = !!(iT && iT.r.valid && iT.ai.p >= thr);
    let target;
    let ok;
    if (method === 'filtros') [target, ok] = [fT, fOk];
    else if (method === 'ia') [target, ok] = [iT, iOk];
    else [target, ok] = [fT, fOk && iOk && fT === iT];
    return { rows, valid, byD, byAi, fT, iT, fOk, iOk, target, ok, T, thr, identify, agree: fT === iT };
  }

  function evaluate(a, p, k, T) {
    const r = compareToProfile(a, p, T);
    let ai = null;
    if (r.valid && model) {
      const pr = predict(model, a);
      ai = { p: pr.probs[k] || 0, unknown: pr.unknown, probs: pr.probs };
    }
    return { p, k, a, r, ai };
  }

  function compute() {
    const q = app.state.query;
    const ps = app.state.profiles;
    if (!q || !ps.length) {
      result = null;
      render();
      return;
    }
    if (!ensureModel(compute)) {
      result = null;
      el.verdict.dataset.state = '';
      el.verdict.innerHTML = `<div class="verdict-empty">${icons.brain}<h2>Entrenando la inteligencia…</h2><p>La red neuronal está aprendiendo los ${ps.length} perfil${ps.length === 1 ? '' : 'es'}. Tarda menos de un segundo.</p></div>`;
      el.details.hidden = true;
      return;
    }
    const T = Number(el.strict.value);
    const rows = ps.map((p, k) => evaluate(app.analyze(q, p.filter), p, k, T));
    result = decide(rows, T);
    render();
  }

  // ---------- render ----------
  function gauge(pct, cls, label = 'similitud') {
    const r = 70;
    const L = 2 * Math.PI * r;
    const color = cls === 'good' ? 'var(--good)' : cls === 'critical' ? 'var(--critical)' : 'var(--warning)';
    return `<div class="gauge" role="img" aria-label="${label} ${fmt(pct, 0)} %">
      <svg viewBox="0 0 168 168" style="color:${color}"><circle cx="84" cy="84" r="${r}" fill="none" stroke="var(--surface-3)" stroke-width="14"/>
      <circle cx="84" cy="84" r="${r}" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round" stroke-dasharray="${(L * Math.max(0.5, pct)) / 100} ${L}"/>
      <line x1="${84 - r - 10}" y1="84" x2="${84 - r + 10}" y2="84" stroke="var(--text-secondary)" stroke-width="2.5"/></svg>
      <div class="g-val"><b>${fmt(pct, pct < 10 ? 1 : 0)}%</b><span>${label}</span></div></div>`;
  }

  const pctAi = (x) => (x && x.ai ? x.ai.p * 100 : 0);

  function renderVerdict() {
    el.verdict.dataset.state = '';
    if (!app.state.profiles.length) {
      el.verdict.innerHTML = `<div class="verdict-empty">${icons.user}<h2>Primero crea un perfil</h2><p>Graba tus 5 tomas en <a href="#grabar">Grabar</a>, sube tus audios en <a href="#perfiles">Perfiles → Nuevo perfil desde audios</a>, o crea los perfiles de demostración.</p></div>`;
      return;
    }
    if (!result) {
      el.verdict.innerHTML = `<div class="verdict-empty">${icons.mic}<h2>Silba para comparar</h2><p>Pulsa <b>Silbar ahora</b>, sube un audio o usa <b>Identificar en tiempo real</b> para ver la decisión mientras silbas.</p></div>`;
      return;
    }
    const { target, identify, T, thr, ok, fT, iT, fOk, iOk } = result;
    if (!target.r.valid) {
      el.verdict.dataset.state = 'warning';
      el.verdict.innerHTML = `<div class="verdict-main">${gauge(0, 'warning')}<div class="verdict-text warning"><h2>${icons.alert}No se detectó un silbido</h2><p>${target.r.reason} Acércate al micrófono, silba más fuerte o revisa que la entrada correcta esté seleccionada.</p></div></div>`;
      return;
    }
    const p = target.p;
    const name = escapeHtml(p.name);
    let title;
    let text;
    let pct;
    let glabel = 'similitud';
    if (method === 'filtros') {
      const r = target.r;
      pct = r.similarity;
      if (identify) {
        title = ok ? `Es el silbido de ${name}` : 'No coincide con ningún perfil';
        text = ok
          ? `De ${result.rows.length} perfil${result.rows.length === 1 ? '' : 'es'}, el más cercano es <b>${name}</b> y su distancia está dentro del umbral.`
          : `El más parecido es <b>${name}</b>, pero su distancia D = ${fmt(r.D, 2)} supera el umbral T = ${fmt(T, 1)}.`;
      } else {
        title = ok ? `Es el silbido de ${name}` : `No es el silbido de ${name}`;
        text = ok
          ? `La melodía, el tono y el estilo coinciden con la huella guardada (D = ${fmt(r.D, 2)} ≤ T = ${fmt(T, 1)}).`
          : `La distancia D = ${fmt(r.D, 2)} supera el umbral T = ${fmt(T, 1)}. Mira abajo qué características no coinciden.`;
      }
    } else if (method === 'ia') {
      pct = pctAi(target);
      glabel = 'probabilidad';
      const unk = fmt(target.ai.unknown * 100, 0);
      title = ok ? `Es el silbido de ${name}` : identify ? 'La inteligencia no reconoce a nadie' : `No es el silbido de ${name}`;
      text = ok
        ? `La red neuronal le da <b>${fmt(pct, 0)} %</b> a ${name} (necesita ${fmt(thr * 100, 0)} %). "Desconocido": ${unk} %.`
        : `La probabilidad más alta es ${fmt(pct, 0)} % para <b>${name}</b>, por debajo del ${fmt(thr * 100, 0)} % que pide esta rigurosidad. "Desconocido": ${unk} %.`;
    } else {
      pct = Math.min(fT.r.valid ? fT.r.similarity : 0, pctAi(iT));
      glabel = 'acuerdo';
      title = ok ? `Es el silbido de ${name}` : result.agree || !identify ? `No se confirma${identify ? '' : ` que sea ${name}`}` : 'Los dos modos no coinciden';
      const fLine = `${fOk ? icons.check : icons.x}<b>Filtros:</b> ${escapeHtml(fT.p.name)} · similitud ${fmt(fT.r.similarity, 0)} % (D = ${fmt(fT.r.D, 2)})`;
      const iLine = `${iOk ? icons.check : icons.x}<b>Inteligencia:</b> ${escapeHtml(iT.p.name)} · ${fmt(pctAi(iT), 0)} %`;
      text = `<span class="both ${fOk ? 'good' : 'critical'}">${fLine}</span><span class="both ${iOk ? 'good' : 'critical'}">${iLine}</span>`;
    }
    const cls = ok ? 'good' : 'critical';
    el.verdict.dataset.state = cls;
    const meta =
      method === 'ia'
        ? `<span class="pill">${icons.brain}IA · umbral ${fmt(thr * 100, 0)} %</span>`
        : `<span class="pill">D = ${fmt(target.r.D, 2)}</span><span class="pill">T = ${fmt(T, 1)}</span>`;
    el.verdict.innerHTML = `<div class="verdict-main">${gauge(pct, cls, glabel)}
      <div class="verdict-text ${cls}"><h2>${ok ? icons.check : icons.x}${title}</h2><p>${text}</p>
      <div class="verdict-meta"><span class="pill mode">Modo ${METHOD_NAME[method]}</span>${meta}<span class="pill">${escapeHtml(app.state.query.label)}</span></div>
      <button type="button" class="btn ghost sm tour-btn" data-act="tour">${icons.route}Ver cómo lo identificó, paso a paso</button></div></div>`;
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
    const rows = [...result.byD, ...result.rows.filter((x) => !x.r.valid)];
    el.ident.innerHTML = rows
      .map((x, i) => {
        if (!x.r.valid) return barRow({ label: escapeHtml(x.p.name), pct: 0, valueText: '—' });
        return barRow({
          label: escapeHtml(x.p.name),
          sub: `D = ${fmt(x.r.D, 2)}`,
          pct: x.r.similarity,
          mark: 50,
          valueText: `<span class="status ${x.r.accepted ? 'good' : 'critical'}">${x.r.accepted ? icons.check : icons.x}${fmt(x.r.similarity, x.r.similarity < 10 ? 1 : 0)} %</span>`,
          cls: i === 0 ? 'hi top' : '',
        });
      })
      .join('');
  }

  function aiRows(res) {
    const rows = res.byAi.map((x, i) =>
      barRow({
        label: escapeHtml(x.p.name),
        sub: `visto con su filtro ${x.p.filter.type === 'fir' ? 'FIR' : 'IIR'}`,
        pct: x.ai.p * 100,
        mark: res.thr * 100,
        valueText: `<span class="status ${x.ai.p >= res.thr ? 'good' : 'critical'}">${x.ai.p >= res.thr ? icons.check : icons.x}${fmt(x.ai.p * 100, x.ai.p < 0.1 ? 1 : 0)} %</span>`,
        cls: i === 0 ? 'hi top' : '',
      }),
    );
    if (res.byAi.length) {
      const u = res.byAi[0].ai.unknown;
      rows.push(barRow({ label: '<i>Desconocido</i>', sub: 'nadie de los perfiles', pct: u * 100, valueText: `${fmt(u * 100, u < 0.1 ? 1 : 0)} %`, cls: 'muted-row' }));
    }
    return rows.join('');
  }

  function renderAi() {
    const res = result;
    el.aiBars.innerHTML = aiRows(res);
    el.aiNote.innerHTML = `Umbral de la IA con esta rigurosidad: <b>${fmt(res.thr * 100, 0)} %</b> (la línea vertical). Cada perfil se mira con su propio filtro, como en el modo por filtros, y la red da la probabilidad de cada persona y de "desconocido".`;
    const t = res.iT;
    if (t && t.r.valid) {
      const ex = explain(model, t.a, t.k);
      el.aiWhy.innerHTML =
        `<p class="muted small">Se le "tapa" a la red cada dato y se mide cuánto cambia su confianza en <b>${escapeHtml(t.p.name)}</b>. El porcentaje es la parte de la decisión que aportó cada dato.</p>` +
        ex
          .map((g) => {
            const c = g.contribution;
            const cls = Math.abs(c) < 0.02 ? '' : c > 0 ? 'good' : 'critical';
            return barRow({
              label: g.label,
              sub: Math.abs(c) < 0.02 ? 'casi no influyó' : c > 0 ? `a favor de ${escapeHtml(t.p.name)}` : `en contra de ${escapeHtml(t.p.name)}`,
              pct: Math.min(100, Math.abs(c) * 100),
              valueText: `${c >= 0 ? '+' : '−'}${fmt(Math.abs(c) * 100, 0)} %`,
              cls,
            });
          })
          .join('');
    }
    const m = model;
    const H = m.history;
    const maxL = Math.max(...H.map((h) => h.loss));
    const pts = H.map((h, i) => `${((i / (H.length - 1)) * 300).toFixed(1)},${(70 - (h.loss / maxL) * 64).toFixed(1)}`).join(' ');
    el.aiModel.innerHTML = `<p>Es un <b>perceptrón multicapa</b> programado a mano (sin librerías): <code>${m.arch}</code>. Recibe 22 números del silbido: tono medio, rango, duración, segmentos, pureza, estabilidad y la forma de la melodía en 16 puntos.</p>
      <p>Se entrenó aquí mismo con <b>${m.samples}</b> ejemplos sacados de tus perfiles: tus tomas con variaciones realistas, y como "desconocido" imitadores con otro tono, melodías cambiadas y silbidos al azar. ${m.epochs} épocas de Adam en ${fmt(m.ms, 0)} ms.</p>
      <svg class="loss-curve" viewBox="0 0 300 72" role="img" aria-label="Pérdida durante el entrenamiento"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2"/></svg>
      <p class="muted small">Pérdida de entrenamiento (baja de izquierda a derecha). Exactitud final: ${fmt(m.accuracy * 100, 1)} %. Tomas reales de los perfiles reconocidas: ${fmt(m.refAccuracy * 100, 0)} %.</p>`;
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
      lines: [{ x: Float32Array.from(path, ([i]) => (i + 0.5) * 0.02), y: Float32Array.from(path, ([, j]) => (j + 0.5) * 0.02), color: '--ann-f0', width: 2.2, casing: true, label: 'Camino DTW' }],
    });
  }

  const yBand = (f) => ({ min: Math.max(0, Math.floor((f.fl * 0.55) / 100) * 100), max: Math.min(8000, Math.ceil((f.fh * 1.45) / 100) * 100) });

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
    for (const [plot, spec, an] of [
      [P.ref, sr, ra],
      [P.query, sq, qa],
    ]) {
      plot.setAxes({ x: { max: an.duration }, y: yBand(p.filter) });
      plot.set({ heatmap: { ...spec, vmin: vmax - 58, vmax }, ...buildAnnotations(an, { compact: true }).layers });
    }
  }

  // ---------- red neuronal: dibujo con las activaciones de la prueba ----------
  let nnTarget = null;
  function renderNN() {
    const res = result;
    const valid = res.rows.filter((r) => r.r.valid && r.ai);
    if (!valid.length) return;
    const t = valid.find((r) => r.k === nnTarget) || res.iT;
    if (!t || !t.ai) return;
    const det = forwardDetail(model, t.a);
    const accepted = t.ai.p >= res.thr;
    renderNetwork($('#nn-net'), model, det, { target: t.k, ok: accepted });
    renderMatch($('#nn-match'), det.x, profileEmbedding(t.p), t.p);
    const name = escapeHtml(t.p.name);
    $('#nn-note').innerHTML = `El silbido de prueba, visto con el filtro de <b>${name}</b>, entra a la red como 22 números (izquierda). Pasa por las 24 neuronas ocultas y la neurona de salida de ${name} queda en <b>${fmt(t.ai.p * 100, t.ai.p < 0.1 ? 1 : 0)} %</b> ${
      accepted ? `(supera el ${fmt(res.thr * 100, 0)} %: <span class="status good">${icons.check}sí es ${name}</span>)` : `(no llega al ${fmt(res.thr * 100, 0)} %: <span class="status critical">${icons.x}no se confirma</span>)`
    }. Las líneas gruesas son las conexiones que más empujaron hacia esa salida. Abajo se compara la huella de la prueba con la huella típica de ${name}.`;
    $('#nn-target').innerHTML = valid
      .map((r) => `<button type="button" data-k="${r.k}" aria-pressed="${r === t}">${escapeHtml(r.p.name)} · ${fmt(r.ai.p * 100, 0)} %</button>`)
      .join('');
  }
  $('#nn-target').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    nnTarget = Number(b.dataset.k);
    renderNN();
  });
  app.bus.on('query-changed', () => {
    nnTarget = null;
  });

  function render() {
    renderVerdict();
    const show = result && result.target && result.target.r.valid;
    el.details.hidden = !show;
    if (!show) return;
    renderBars();
    renderAi();
    renderNN();
    drawContours();
    drawDtw();
    drawSpecs();
  }

  // ---------- recorrido paso a paso ----------
  function tour() {
    if (!result || !result.target.r.valid) return;
    const { target, fT, iT, thr, T, ok } = result;
    const card = (id) => $(id).closest('.card');
    const p = target.p;
    const f = target.a.features;
    const name = escapeHtml(p.name);
    const steps = [
      {
        el: card('#plot-vquery'),
        title: '1 · Escucha el silbido y lo filtra',
        html: `<p>El audio pasa por el filtro que la auto-sintonía eligió para ${name}: <b>${cfgLabel(p.filter)}</b>, banda ${fmt(p.filter.fl, 0)}–${fmt(p.filter.fh, 0)} Hz. Todo lo que queda fuera (voz, zumbido, ruido grave) se atenúa.</p>
          <p>En el mapa de calor, cada recuadro es un tramo con silbido: encontró <b>${f.segments} segmento${f.segments === 1 ? '' : 's'}</b> y <b>${fmt(f.durVoiced, 2)} s</b> con tono.</p>`,
      },
      {
        el: card('#plot-vcontour'),
        title: '2 · Saca la melodía f₀(t)',
        html: `<p>En cada trama de 64 ms busca el pico del espectro: esa es la nota. Así obtiene el contorno de tono (naranja) y lo pone junto al de ${name} (azul).</p>
          <p>Tono medio de la prueba: <b>${fmt(f.pitchHz, 0)} Hz</b>. Perfil: <b>${fmt(p.summary.pitchHz, 0)} Hz</b>. Pureza: ${fmt(f.purity * 100, 0)} %.</p>`,
      },
    ];
    if (method !== 'ia') {
      const r = fT.r;
      steps.push(
        {
          el: card('#plot-dtw'),
          title: '3 · Por filtros: alinea las melodías (DTW)',
          html: `<p>Nadie silba dos veces al mismo ritmo, así que el DTW estira y encoge el tiempo para alinear las dos melodías. La línea cian es el mejor alineamiento.</p>
            <p>Diferencia media después de alinear: <b>${fmt(r.dtw.distance, 2)} st</b>. La tolerancia de ${escapeHtml(fT.p.name)} es ${fmt(fT.p.tolerances.contour, 2)} st.</p>`,
        },
        {
          el: card('#comp-bars'),
          title: '4 · Por filtros: suma las diferencias',
          html: `<p>Cada diferencia se divide por la variación normal de la persona (τ) y se combinan con pesos: melodía 3, tono 2 y las demás 1.</p>
            <p class="eq">D = ${fmt(r.D, 2)} ${r.accepted ? '≤' : '>'} T = ${fmt(T, 1)}</p><p>${r.accepted ? `Dentro del umbral: los filtros dicen que <b>sí es ${escapeHtml(fT.p.name)}</b>.` : 'Fuera del umbral: los filtros dicen que <b>no coincide</b>.'}</p>`,
        },
      );
    }
    if (method !== 'filtros') {
      const ex = explain(model, iT.a, iT.k).slice(0, 2);
      steps.push(
        {
          el: card('#ai-bars'),
          title: `${steps.length + 1} · Inteligencia: la red neuronal opina`,
          html: `<p>Los 22 números del silbido entran a la red (${model.arch}) que se entrenó con los perfiles. La salida es una probabilidad por persona y otra para "desconocido".</p>
            <p>Más probable: <b>${escapeHtml(iT.p.name)}</b> con <b>${fmt(iT.ai.p * 100, 0)} %</b>. Para aceptar necesita ${fmt(thr * 100, 0)} %.</p>`,
        },
        {
          el: card('#ai-why'),
          title: `${steps.length + 2} · Inteligencia: qué la convenció`,
          html: `<p>Se tapa cada dato y se mira cuánto cambia la confianza de la red. Lo que más pesó: ${ex.map((g) => `<b>${g.label.toLowerCase()}</b> (${g.contribution >= 0 ? '+' : '−'}${fmt(Math.abs(g.contribution) * 100, 0)} %)`).join(' y ')}.</p>`,
        },
        {
          el: $('#nn-card'),
          title: `${steps.length + 3} · Inteligencia: la red por dentro`,
          html: `<p>Así se ve la red con este silbido. A la izquierda, los 22 datos; en el centro, las 24 neuronas ocultas; a la derecha, una salida por persona y otra para "desconocido". La salida resaltada es <b>${escapeHtml(iT.p.name)}</b>.</p><p>Debajo se compara la huella de la prueba con la huella típica del perfil, dato por dato.</p>`,
        },
      );
    }
    steps.push({
      el: el.verdict,
      title: `${steps.length + 1} · Decisión ${METHOD_NAME[method]}`,
      html:
        method === 'ambos'
          ? `<p>Filtros: ${result.fOk ? 'sí' : 'no'} (${escapeHtml(fT.p.name)}). Inteligencia: ${result.iOk ? 'sí' : 'no'} (${escapeHtml(iT.p.name)}). ${ok ? `Coinciden: <b>es ${name}</b>.` : 'Como no están de acuerdo los dos, <b>no se acepta</b>.'}</p>`
          : `<p>${ok ? `<b>Es el silbido de ${name}.</b>` : '<b>No se acepta.</b>'} Puedes cambiar de modo arriba y repetir el recorrido para comparar cómo decide cada uno.</p>`,
    });
    startTour(steps);
  }
  el.verdict.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="tour"]')) tour();
  });

  // ---------- tiempo real ----------
  let live = null;

  async function startLive() {
    if (!app.state.profiles.length) return;
    if (!app.audio.active) {
      const ok = await app.startMic();
      if (!ok) return;
    }
    ensureModel(() => {}); // si hace falta, la red termina de entrenar en ~1 s y el primer ciclo espera
    const N = app.FS * app.DUR;
    const ring = new Float32Array(N);
    const st = { ring, w: 0, filled: 0, busy: false, last: null, timer: 0, stop: null };
    try {
      st.stop = app.audio.startLive(app.FS, (c) => {
        for (let i = 0; i < c.length; i++) {
          ring[st.w] = c[i];
          st.w = (st.w + 1) % N;
        }
        st.filled = Math.min(N, st.filled + c.length);
      });
    } catch (e) {
      app.toast(e.message, 'error');
      return;
    }
    live = st;
    st.timer = setInterval(liveTick, 600);
    el.liveCard.hidden = false;
    el.liveBtn.classList.add('on');
    el.liveBtn.querySelector('.lbl').textContent = 'Detener tiempo real';
    el.liveFreeze.disabled = true;
    el.liveStatus.className = 'live-status';
    el.liveStatus.innerHTML = `${icons.mic}<span>Escuchando… silba cerca del micrófono.</span>`;
    el.liveBarsF.innerHTML = '';
    el.liveBarsIa.innerHTML = '';
    el.liveCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function stopLive() {
    if (!live) return;
    clearInterval(live.timer);
    if (live.stop) live.stop();
    live = null;
    el.liveBtn.classList.remove('on');
    el.liveBtn.querySelector('.lbl').textContent = 'Identificar en tiempo real';
    el.liveCard.classList.remove('hit');
  }

  function liveTick() {
    const st = live;
    if (!st || st.busy || !app.modelReady()) return;
    model = app.getModel();
    st.busy = true;
    try {
      const N = st.ring.length;
      const win = new Float32Array(N);
      // orden cronológico: de la muestra más vieja (w) a la más nueva
      win.set(st.ring.subarray(st.w), 0);
      win.set(st.ring.subarray(0, st.w), N - st.w);
      // 1) Con un filtro ancho se buscan los tramos de silbido y la última "frase" (tramos separados
      //    por menos de 0,7 s). Así no se compara medio silbido ni el final de uno con el inicio de otro.
      const seg = analyzeSignal(win, app.FS, app.getDesign(LIVE_SURVEY));
      const segs = seg.segments;
      if (!segs.length || !seg.features.valid) {
        if (st.done) renderLive(st.done.res, true, seg, true);
        else renderLiveIdle(seg);
        return;
      }
      let j = segs.length - 1;
      while (j > 0 && segs[j].start - segs[j - 1].end < 0.7) j--;
      const ps = segs[j].start;
      const pe = segs[segs.length - 1].end;
      const complete = pe < seg.duration - 0.35;
      // la frase empieza en el borde de la ventana: ya se está saliendo, se mantiene el último resultado
      if (ps < 0.15) {
        if (st.done) renderLive(st.done.res, true, seg, true);
        else renderLiveIdle(seg);
        return;
      }
      // 2) La frase se recorta y se coloca en una toma de 5 s (empieza en 0,5 s), como al grabar.
      let clip = win;
      const a0 = Math.max(0, Math.floor((ps - 0.3) * app.FS));
      const a1 = Math.min(N, Math.ceil((pe + 0.3) * app.FS));
      if (a1 - a0 <= N - 0.6 * app.FS) {
        clip = new Float32Array(N);
        clip.set(win.subarray(a0, a1), Math.round(0.5 * app.FS));
      }
      const T = Number(el.strict.value);
      const rows = app.state.profiles.map((p, k) => evaluate(analyzeSignal(clip, app.FS, app.getDesign(p.filter)), p, k, T));
      const res = decide(rows, T);
      st.last = { win: clip, res };
      if (complete) st.done = st.last;
      renderLive(res, complete, seg);
    } finally {
      st.busy = false;
    }
  }

  function drawLive(a) {
    const S = stft(a.y, app.FS, { N: 512, overlap: 0.75, fmax: 8000 });
    const rng = dbRange(S.data, 60);
    P.live.setAxes({ x: { max: a.duration }, y: { min: 300, max: 6000 } });
    P.live.set({ heatmap: { ...S, vmin: Math.max(rng.vmin, rng.vmax - 60), vmax: rng.vmax }, ...buildAnnotations(a, { compact: true }).layers });
  }

  function renderLiveIdle(seg) {
    drawLive(seg);
    el.liveStatus.className = 'live-status';
    el.liveStatus.innerHTML = `${icons.mic}<span>Escuchando… todavía no hay un silbido claro en los últimos 5 s.</span>`;
    el.liveBarsF.innerHTML = '';
    el.liveBarsIa.innerHTML = '';
    el.liveFreeze.disabled = true;
    el.liveCard.classList.remove('hit');
  }

  function renderLive(res, complete, seg, held = false) {
    drawLive(seg);
    if (!res.valid.length) {
      renderLiveIdle(seg);
      return;
    }
    el.liveFreeze.disabled = false;
    el.liveBarsF.innerHTML = res.byD
      .map((x, i) =>
        barRow({
          label: escapeHtml(x.p.name),
          sub: `D = ${fmt(x.r.D, 2)}`,
          pct: x.r.similarity,
          mark: 50,
          valueText: `<span class="status ${x.r.accepted ? 'good' : 'critical'}">${fmt(x.r.similarity, 0)} %</span>`,
          cls: i === 0 ? 'hi top' : '',
        }),
      )
      .join('');
    el.liveBarsIa.innerHTML = aiRows(res);
    const name = escapeHtml(res.target.p.name);
    const sim = res.fT.r.valid ? `filtros ${fmt(res.fT.r.similarity, 0)} %` : '';
    const prob = res.iT.ai ? `IA ${fmt(res.iT.ai.p * 100, 0)} %` : '';
    const nums = [sim, prob].filter(Boolean).join(' · ');
    if (!complete) {
      el.liveStatus.className = 'live-status';
      el.liveStatus.innerHTML = `<span class="spin" aria-hidden="true"></span><span><b>Silbando…</b> por ahora se parece a ${name} · ${nums} <small>(provisional hasta que termines)</small></span>`;
      el.liveCard.classList.remove('hit');
      return;
    }
    el.liveStatus.className = `live-status ${res.ok ? 'good' : 'critical'}`;
    const pre = held ? 'Último silbido: ' : '';
    el.liveStatus.innerHTML = res.ok
      ? `${icons.check}<span>${pre}<b>Es ${name}</b> · ${METHOD_NAME[method]} · ${nums}</span>`
      : `${icons.x}<span>${pre}<b>No coincide</b> · el más parecido es ${name} · ${nums}</span>`;
    el.liveCard.classList.toggle('hit', res.ok);
  }

  el.liveBtn.addEventListener('click', () => (live ? stopLive() : startLive()));
  el.liveStop.addEventListener('click', stopLive);
  el.liveFreeze.addEventListener('click', () => {
    const src = live && (live.done || live.last);
    if (!src) return;
    const { win } = src;
    stopLive();
    app.setQuery(win, 'mic', 'Prueba · en vivo');
    el.verdict.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  app.bus.on('tab-shown', (name) => {
    if (name !== 'verificar') {
      stopLive();
      endTour();
    }
  });
  app.bus.on('recording', (on) => on && stopLive());
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
  setMethod('filtros');
  renderSelect();
  render();
}
