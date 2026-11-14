// Vista 3 · Filtro: auto-sintonía (el sistema elige el filtro; no hay controles manuales), respuesta en
// frecuencia, retardo de grupo, impulso, polos/ceros y exportación.
import { Plot, addExportButtons } from '../ui/plot.js';
import { freqResponse, impulseResponse, firZerosPoles, toCHeader } from '../dsp/filters.js';
import { WINDOW_NAMES } from '../dsp/fft.js';
import { cfgLabel } from '../dsp/autofilter.js';
import { $, $$, fmt, fmtHz, icons, download } from '../util.js';
import { freqAxis } from './common.js';

export function initFilter(app) {
  const el = {
    state: $('#auto-state'),
    decision: $('#auto-decision'),
    reasons: $('#auto-reasons'),
    duel: $('#auto-duel'),
    duelWrap: $('#auto-duel-wrap'),
    all: $('#auto-all'),
    allWrap: $('#auto-all-wrap'),
    summary: $('#filter-summary'),
    exportH: $('#export-h'),
    copy: $('#copy-coefs'),
    coef: $('#coef-view'),
    pzIirInfo: $('#pz-iir-info'),
    pzFirInfo: $('#pz-fir-info'),
  };
  el.exportH.querySelector('.ico').innerHTML = icons.chip;
  el.copy.querySelector('.ico').innerHTML = icons.copy;

  const pzAxis = { min: -1.35, max: 1.35, tip: (v) => fmt(v, 3) };
  const P = {
    mag: new Plot($('#plot-mag'), {
      height: 300,
      x: freqAxis(),
      y: { label: '|H| (dB)', min: -90, max: 6, tip: (v) => `${fmt(v, 2)} dB` },
      name: 'respuesta-magnitud',
    }),
    gd: new Plot($('#plot-gd'), {
      height: 230,
      x: freqAxis(),
      y: { label: 'Retardo (ms)', min: 0, max: 5, tip: (v) => `${fmt(v, 3)} ms` },
      name: 'retardo-grupo',
    }),
    impIir: new Plot($('#plot-imp'), {
      height: 230,
      x: { label: 'n (muestras)', min: -2, max: 120, tip: (v) => `n = ${fmt(v, 0)}` },
      y: { label: 'h[n]', min: -0.5, max: 0.5, tip: (v) => fmt(v, 4) },
      crosshair: 'x',
      name: 'respuesta-impulso',
    }),
    pzIir: new Plot($('#plot-pz-iir'), {
      height: 300,
      aspect: 'equal',
      crosshair: 'xy',
      x: { ...pzAxis, label: 'Re{z}' },
      y: { ...pzAxis, label: 'Im{z}' },
      tooltip: (p, plot) => pzTip(p, plot),
      name: 'polos-ceros-iir',
    }),
    pzFir: new Plot($('#plot-pz-fir'), {
      height: 300,
      aspect: 'equal',
      crosshair: 'xy',
      x: { ...pzAxis, label: 'Re{z}' },
      y: { ...pzAxis, label: 'Im{z}' },
      tooltip: (p, plot) => pzTip(p, plot),
      name: 'polos-ceros-fir',
    }),
  };
  addExportButtons($('#tools-mag'), P.mag, 'respuesta-magnitud');
  addExportButtons($('#tools-gd'), P.gd, 'retardo-grupo');
  addExportButtons($('#tools-imp'), P.impIir, 'respuesta-impulso');
  addExportButtons($('#tools-pz-iir'), P.pzIir, 'polos-ceros-iir', { csv: false });
  addExportButtons($('#tools-pz-fir'), P.pzFir, 'polos-ceros-fir', { csv: false });

  function pzTip(p, plot) {
    let best = null;
    for (const L of plot.layers.points) {
      for (let i = 0; i < L.x.length; i++) {
        const d = Math.hypot(plot.X(L.x[i]) - p.px, plot.Y(L.y[i]) - p.py);
        if (d < 14 && (!best || d < best.d)) best = { d, x: L.x[i], y: L.y[i], kind: L.label };
      }
    }
    const z = best || { x: p.x, y: p.y };
    const r = Math.hypot(z.x, z.y);
    const ang = (Math.atan2(z.y, z.x) / Math.PI) * 180;
    const f = (Math.abs(Math.atan2(z.y, z.x)) / (2 * Math.PI)) * app.FS;
    return `<div class="tip-h">${best ? best.kind.replace(/s$/, '').replace(/ \(.*/, '') : 'z'} = ${fmt(z.x, 3)} ${z.y < 0 ? '−' : '+'} j${fmt(Math.abs(z.y), 3)}</div>
      <div class="tip-row"><span>|z|</span><b>${fmt(r, 4)}</b></div>
      <div class="tip-row"><span>ángulo</span><b>${fmt(ang, 1)}° ≈ ${fmtHz(f)}</b></div>`;
  }

  // ---------- auto-sintonía (solo lectura) ----------
  const auto = () => (app.state.auto && app.state.auto.status === 'ok' ? app.state.auto : null);

  /** Los dos finalistas: el elegido y el mejor de la otra familia. Sin tomas: IIR y FIR provisionales. */
  const designs = () => {
    const au = auto();
    if (au) return { iir: app.getDesign(au.finalists.iir.cfg), fir: app.getDesign(au.finalists.fir.cfg) };
    const c = app.state.filter;
    return {
      iir: app.getDesign({ ...c, type: 'iir' }),
      fir: app.getDesign({ ...c, type: 'fir' }),
    };
  };

  function renderAuto() {
    const au = auto();
    const c = app.state.filter;
    const st = app.state.auto ? app.state.auto.status : 'empty';
    el.state.textContent = au ? 'Elegido por el sistema' : st === 'no-whistle' ? 'Sin silbido detectado' : 'Provisional';
    el.state.className = `pill ${au ? 'auto-ok' : 'auto-wait'}`;
    el.decision.innerHTML = `<span class="fam">${c.type === 'iir' ? 'IIR' : 'FIR'}</span>
      <strong>${cfgLabel(c)}</strong>
      <small>Banda ${fmt(c.fl, 0)}–${fmt(c.fh, 0)} Hz${au ? '' : ' · provisional hasta que grabes tomas'}</small>`;

    if (!app.state.auto) {
      el.reasons.innerHTML = `<li>Todavía no hay tomas. Mientras tanto se usa un filtro provisional de 1–4 kHz.</li>
        <li>Graba tus tomas en <a href="#grabar">Grabar</a> (o usa la demo) y el sistema elegirá el filtro automáticamente.</li>`;
    } else {
      el.reasons.innerHTML = app.state.auto.reasons.map((r) => `<li>${r}</li>`).join('');
    }

    el.duelWrap.hidden = !au;
    el.allWrap.hidden = !au;
    if (!au) return;
    const F = au.finalists;
    const win = au.winner;
    const col = (fam) => (fam === win ? ' class="win"' : '');
    const row = (label, f, d = 1, unit = '') =>
      `<tr><td>${label}</td><td${col('iir')}>${f(F.iir)}${unit}</td><td${col('fir')}>${f(F.fir)}${unit}</td></tr>`;
    const n = (v, d = 1) => fmt(v, d);
    el.duel.innerHTML = `<thead><tr><th>Final</th><th${col('iir')}>${win === 'iir' ? '★ ' : ''}${cfgLabel(F.iir.cfg)}</th><th${col('fir')}>${win === 'fir' ? '★ ' : ''}${cfgLabel(F.fir.cfg)}</th></tr></thead>
      <tbody>
        ${row('Banda', (x) => `${x.cfg.fl}–${x.cfg.fh} Hz`)}
        ${row('Calidad en tus tomas', (x) => `<b>${n(x.quality, 0)}</b> pts`)}
        ${row('Tomas válidas', (x) => `${x.valid}/${au.survey.takes}`)}
        ${row('SNR a la salida', (x) => n(x.metrics.snrDb), 1, ' dB')}
        ${row('Caída en los bordes', (x) => n(x.metrics.edgeDb, 2), 1, ' dB')}
        ${row('Rizado sobre tus notas', (x) => n(x.metrics.rippleDb, 2), 1, ' dB')}
        ${row('Dispersión del retardo', (x) => n(x.metrics.gdSpreadMs, 2), 1, ' ms')}
        ${row('Costo en el ESP32', (x) => `${x.metrics.cost} mult/muestra`)}
        ${row('Puntaje final', (x) => `<b>${n(x.final, 2)}</b>`)}
      </tbody>`;

    const winKey = app.designKey(c);
    const finKeys = new Set([app.designKey(F.iir.cfg), app.designKey(F.fir.cfg)]);
    el.all.innerHTML = `<thead><tr><th>#</th><th>Filtro</th><th>Banda (Hz)</th><th>SNR</th><th>Borde</th><th>Retardo</th><th>Puntaje</th></tr></thead><tbody>${au.candidates
      .map((x, i) => {
        const k = app.designKey(x.cfg);
        const cls = k === winKey ? 'win' : finKeys.has(k) ? 'fin' : '';
        return `<tr class="${cls}"><td>${i + 1}</td><td>${k === winKey ? '★ ' : ''}${cfgLabel(x.cfg)}</td><td>${x.cfg.fl}–${x.cfg.fh}</td><td>${n(x.metrics.snrDb)} dB</td><td>${n(x.metrics.edgeDb, 2)} dB</td><td>${n(x.metrics.gdSpreadMs, 2)} ms</td><td>${n(x.metrics.score, 2)}</td></tr>`;
      })
      .join('')}</tbody>`;
    el.allWrap.querySelector('summary').textContent = `Ver los ${au.candidates.length} candidatos evaluados`;
  }
  const active = () => app.getDesign(app.state.filter);

  el.exportH.addEventListener('click', () => {
    const d = active();
    download('filtro.h', toCHeader(d), 'text/x-c');
    app.toast('filtro.h descargado: reemplaza el de esp32/silbido_id/ y vuelve a subir el sketch. La ESP32 filtrará con este filtro.');
  });
  el.copy.addEventListener('click', async () => {
    const d = active();
    const txt =
      d.kind === 'iir'
        ? `# SOS (b0, b1, b2, a0, a1, a2) · fs = ${d.fs} Hz · ${d.fl}–${d.fh} Hz\n${d.sos.map((s) => s.map((v) => v.toPrecision(10)).join(', ')).join('\n')}`
        : `# h[n] · ${d.numTaps} coeficientes · fs = ${d.fs} Hz · ${d.fl}–${d.fh} Hz\n${Array.from(d.taps, (v) => v.toPrecision(10)).join(', ')}`;
    try {
      await navigator.clipboard.writeText(txt);
      app.toast('Coeficientes copiados al portapapeles.');
    } catch {
      download('coeficientes.txt', txt, 'text/plain');
    }
  });

  // ---------- render ----------
  let dirty = true;
  function render() {
    if (app.state.tab !== 'filtro') {
      dirty = true;
      return;
    }
    dirty = false;
    renderAuto();
    const { iir, fir } = designs();
    const act = app.state.filter.type;
    const actD = act === 'iir' ? iir : fir;
    const ri = freqResponse(iir, 1024);
    const rf = freqResponse(fir, 1024);
    const df = app.FS / 2 / 1024;
    const band = [{ x0: actD.fl, x1: actD.fh, color: '--series-1', alpha: 0.06, legend: 'Banda de paso elegida' }];
    const cut = [
      { x: actD.fl, color: '--text-muted', label: `fL = ${fmt(actD.fl, 0)} Hz`, align: 'right' },
      { x: actD.fh, color: '--text-muted', label: `fH = ${fmt(actD.fh, 0)} Hz` },
    ];
    const lab = (d, isAct) => `${d.kind === 'iir' ? `IIR orden ${d.order}` : `FIR M = ${d.numTaps}`}${isAct ? ' (elegido)' : ''}`;
    const extra = { lines: [], bands: [] };
    const au = auto();
    if (au) {
      // lo que el sistema midió en tus tomas: rango del silbido y espectro del ruido de fondo
      const sv = au.survey;
      extra.bands.push({ x0: sv.lo, x1: sv.hi, color: '--good', alpha: 0.12, legend: 'Rango de tu silbido' });
      let nmax = 1e-30;
      for (const v of sv.noise) nmax = Math.max(nmax, v);
      extra.lines.push({
        x0: 0,
        dx: sv.df,
        y: Float64Array.from(sv.noise, (v) => Math.max(-90, 10 * Math.log10((v + 1e-30) / nmax))),
        color: '--text-muted',
        width: 1.2,
        label: 'Ruido medido (dB rel.)',
      });
    }
    P.mag.set({
      bands: [...band, ...extra.bands],
      vlines: cut,
      hlines: [{ y: -3, color: '--text-muted', label: '−3 dB' }],
      lines: [
        ...extra.lines,
        { x0: df / 2, dx: df, y: ri.magDb, color: '--series-1', width: act === 'iir' ? 2.6 : 1.4, label: lab(iir, act === 'iir') },
        { x0: df / 2, dx: df, y: rf.magDb, color: '--series-2', width: act === 'fir' ? 2.6 : 1.4, label: lab(fir, act === 'fir') },
      ],
    });

    // retardo de grupo (solo en la banda de paso, |H| > −3 dB)
    const toMs = (r) => Float64Array.from(r.gd, (v, i) => (r.magDb[i] > -3 ? (v / app.FS) * 1000 : NaN));
    const gi = toMs(ri);
    const gf = toMs(rf);
    const gmax = Math.max(1, ...Array.from(gi).filter(Number.isFinite), ...Array.from(gf).filter(Number.isFinite));
    P.gd.setAxes({ y: { max: Math.ceil(gmax * 1.15 * 2) / 2 } });
    P.gd.set({
      bands: band,
      lines: [
        { x0: df / 2, dx: df, y: gi, color: '--series-1', width: 2, label: `IIR orden ${iir.order}` },
        { x0: df / 2, dx: df, y: gf, color: '--series-2', width: 2, label: `FIR (${fmt(((fir.numTaps - 1) / 2 / app.FS) * 1000, 2)} ms constantes)` },
      ],
    });

    // respuesta al impulso
    const nImp = Math.max(120, fir.numTaps + 10);
    const hi = impulseResponse(iir, nImp);
    const hf = impulseResponse(fir, nImp);
    let A = 1e-3;
    for (const v of hi) A = Math.max(A, Math.abs(v));
    for (const v of hf) A = Math.max(A, Math.abs(v));
    P.impIir.setAxes({ x: { max: nImp }, y: { min: -A * 1.15, max: A * 1.15 } });
    P.impIir.set({
      stems: [
        { x0: 0, dx: 1, y: hi, color: '--series-1', label: 'IIR h[n]', r: 1.8 },
        { x0: 0, dx: 1, y: hf, color: '--series-2', label: 'FIR h[n]', r: 1.8 },
      ],
    });

    // polos y ceros
    const mult = iir.N;
    P.pzIir.set({
      circles: [{ cx: 0, cy: 0, r: 1, color: '--axis' }],
      hlines: [{ y: 0, color: '--grid', dash: false }],
      vlines: [{ x: 0, color: '--grid', dash: false }],
      points: [
        { x: iir.poles.map((p) => p.re), y: iir.poles.map((p) => p.im), color: '--series-1', marker: 'x', size: 10, label: 'Polos' },
        { x: [1, -1], y: [0, 0], color: '--series-2', marker: 'o', size: 11, label: 'Ceros', labels: [`×${mult}`, `×${mult}`] },
      ],
    });
    const rmax = Math.max(...iir.poles.map((p) => Math.hypot(p.re, p.im)));
    el.pzIirInfo.innerHTML = `${iir.order} polos (en pares conjugados) y ${iir.order} ceros: ${mult} en z = 1 (DC) y ${mult} en z = −1 (Nyquist). Radio máximo |p| = ${fmt(rmax, 4)} &lt; 1, así que el filtro es <b>estable</b>.`;

    const { zeros } = firZerosPoles(fir);
    const zr = Math.max(1.35, Math.min(3, Math.max(...zeros.map((z) => Math.hypot(z.re, z.im))) * 1.08));
    P.pzFir.setAxes({ x: { min: -zr, max: zr }, y: { min: -zr, max: zr } });
    P.pzFir.set({
      circles: [{ cx: 0, cy: 0, r: 1, color: '--axis' }],
      hlines: [{ y: 0, color: '--grid', dash: false }],
      vlines: [{ x: 0, color: '--grid', dash: false }],
      points: [
        { x: zeros.map((z) => z.re), y: zeros.map((z) => z.im), color: '--series-2', marker: 'o', size: 8, width: 1.6, label: 'Ceros' },
        { x: [0], y: [0], color: '--series-1', marker: 'x', size: 10, label: 'Polos', labels: [`×${fir.numTaps - 1}`] },
      ],
    });
    el.pzFirInfo.innerHTML = `${zeros.length} ceros, que en la banda eliminada caen sobre el círculo unitario y en la de paso forman pares recíprocos r y 1/r (eso es la fase lineal), y ${fir.numTaps - 1} polos en el origen. Un FIR <b>siempre es estable</b>.`;

    renderSummary(iir, fir, ri, rf);
    renderCoefs(act === 'iir' ? iir : fir);
  }

  function renderSummary(iir, fir, ri, rf) {
    const d = active();
    const r = d.kind === 'iir' ? ri : rf;
    const at = (f) => r.magDb[Math.min(r.magDb.length - 1, Math.round((f / (app.FS / 2)) * r.magDb.length - 0.5))];
    const ops = d.kind === 'iir' ? `${d.sos.length * 5} multiplicaciones por muestra (${d.sos.length} biquads × 5)` : `${d.numTaps} multiplicaciones por muestra`;
    el.summary.innerHTML = `Filtro activo: <b>${d.kind === 'iir' ? `Butterworth IIR de orden ${d.order}` : `FIR de ${d.numTaps} coeficientes, ventana ${WINDOW_NAMES[d.win]}`}</b><br>
      Banda de paso ${fmt(d.fl, 0)}–${fmt(d.fh, 0)} Hz · atenuación en 60 Hz: <b>${fmt(at(60), 0)} dB</b> · en 300 Hz: <b>${fmt(at(300), 0)} dB</b><br>
      Costo: ${ops}. A 16 kHz son ${fmt(((d.kind === 'iir' ? d.sos.length * 5 : d.numTaps) * 16000) / 1e6, 2)} millones de multiplicaciones por segundo, sin problema para el ESP32 (240 MHz).`;
  }

  function renderCoefs(d) {
    if (d.kind === 'iir') {
      el.coef.innerHTML = `<p class="eq">y[n] = b<sub>0</sub>x[n] + b<sub>1</sub>x[n−1] + b<sub>2</sub>x[n−2] − a<sub>1</sub>y[n−1] − a<sub>2</sub>y[n−2]</p>
        <p class="muted small">${d.sos.length} secciones de segundo orden en cascada, H(z) = Π<sub>i</sub> (b<sub>0i</sub> + b<sub>1i</sub>z<sup>−1</sup> + b<sub>2i</sub>z<sup>−2</sup>) / (1 + a<sub>1i</sub>z<sup>−1</sup> + a<sub>2i</sub>z<sup>−2</sup>). Se implementan en forma directa II transpuesta, más robusta numéricamente que un único polinomio de orden ${d.order}.</p>
        <div class="table-wrap"><table class="table coef-table"><thead><tr><th>Sección</th><th>b0</th><th>b1</th><th>b2</th><th>a1</th><th>a2</th><th>|polo|</th></tr></thead><tbody>${d.sos
          .map(
            (s, i) =>
              `<tr><td>${i + 1}</td>${[s[0], s[1], s[2], s[4], s[5]].map((v) => `<td>${v.toFixed(8)}</td>`).join('')}<td>${Math.sqrt(s[5]).toFixed(5)}</td></tr>`,
          )
          .join('')}</tbody></table></div>`;
    } else {
      el.coef.innerHTML = `<p class="eq">y[n] = Σ<sub>k=0</sub><sup>${d.numTaps - 1}</sup> h[k]·x[n−k]</p>
        <p class="muted small">Convolución directa con ${d.numTaps} coeficientes simétricos h[k] = h[${d.numTaps - 1}−k] (fase lineal, retardo de ${(d.numTaps - 1) / 2} muestras).</p>
        <div class="taps-list">${Array.from(d.taps, (v, i) => `h[${i}] = ${v.toFixed(8)}`).join(' · ')}</div>`;
    }
  }

  app.bus.on('filter-changed', render);
  app.bus.on('auto-changed', render);
  app.bus.on('tab-shown', (name) => {
    if (name === 'filtro' && dirty) render();
  });
  renderAuto();
}
