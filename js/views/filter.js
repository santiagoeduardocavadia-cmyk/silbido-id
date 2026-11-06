// Vista 3 · Filtro: diseño IIR/FIR, respuesta en frecuencia, retardo de grupo, impulso, polos/ceros y exportación.
import { Plot, addExportButtons } from '../ui/plot.js';
import { freqResponse, impulseResponse, firZerosPoles, toCHeader } from '../dsp/filters.js';
import { WINDOW_NAMES } from '../dsp/fft.js';
import { DEFAULT_FILTER } from '../store.js';
import { $, $$, fmt, fmtHz, icons, download } from '../util.js';
import { freqAxis } from './common.js';

export function initFilter(app) {
  const el = {
    type: $('#filter-type'),
    fl: $('#fl'),
    fh: $('#fh'),
    flVal: $('#fl-val'),
    fhVal: $('#fh-val'),
    order: $('#iir-order'),
    win: $('#fir-win'),
    taps: $('#fir-taps'),
    tapsVal: $('#taps-val'),
    summary: $('#filter-summary'),
    exportH: $('#export-h'),
    copy: $('#copy-coefs'),
    reset: $('#filter-reset'),
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

  // ---------- controles ----------
  function readControls() {
    const cfg = { ...app.state.filter };
    cfg.fl = Number(el.fl.value);
    cfg.fh = Number(el.fh.value);
    if (cfg.fh - cfg.fl < 300) {
      if (document.activeElement === el.fl) cfg.fl = Math.max(200, cfg.fh - 300);
      else cfg.fh = Math.min(7500, cfg.fl + 300);
    }
    cfg.order = Number(el.order.value);
    cfg.win = el.win.value;
    cfg.taps = Number(el.taps.value) | 1;
    return cfg;
  }

  function syncControls() {
    const c = app.state.filter;
    el.fl.value = c.fl;
    el.fh.value = c.fh;
    el.order.value = c.order;
    el.win.value = c.win;
    el.taps.value = c.taps;
    el.flVal.textContent = fmtHz(c.fl);
    el.fhVal.textContent = fmtHz(c.fh);
    el.tapsVal.textContent = `${c.taps} (orden ${c.taps - 1})`;
    for (const b of $$('button', el.type)) b.setAttribute('aria-pressed', String(b.dataset.type === c.type));
  }

  let timer = 0;
  function onInput() {
    const cfg = readControls();
    el.flVal.textContent = fmtHz(cfg.fl);
    el.fhVal.textContent = fmtHz(cfg.fh);
    el.tapsVal.textContent = `${cfg.taps} (orden ${cfg.taps - 1})`;
    clearTimeout(timer);
    timer = setTimeout(() => app.setFilter(cfg), 160);
  }
  for (const c of [el.fl, el.fh, el.taps]) c.addEventListener('input', onInput);
  for (const c of [el.order, el.win]) c.addEventListener('change', onInput);
  el.type.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-type]');
    if (!b) return;
    app.setFilter({ ...readControls(), type: b.dataset.type });
  });
  el.reset.addEventListener('click', () => app.setFilter({ ...DEFAULT_FILTER }));

  const designs = () => {
    const c = app.state.filter;
    return {
      iir: app.getDesign({ ...c, type: 'iir' }),
      fir: app.getDesign({ ...c, type: 'fir' }),
    };
  };
  const active = () => app.getDesign(app.state.filter);

  el.exportH.addEventListener('click', () => {
    const d = active();
    download(d.kind === 'iir' ? 'silbido_filtro_iir.h' : 'silbido_filtro_fir.h', toCHeader(d), 'text/x-c');
    app.toast('Encabezado C descargado: inclúyelo en tu sketch del ESP32 y llama a silbido_filtrar(x) por cada muestra.');
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
    syncControls();
    const { iir, fir } = designs();
    const act = app.state.filter.type;
    const ri = freqResponse(iir, 1024);
    const rf = freqResponse(fir, 1024);
    const df = app.FS / 2 / 1024;
    const band = [{ x0: iir.fl, x1: iir.fh, color: '--series-1', alpha: 0.06, legend: 'Banda de paso' }];
    const cut = [
      { x: iir.fl, color: '--text-muted', label: `fL = ${fmt(iir.fl, 0)} Hz`, align: 'right' },
      { x: iir.fh, color: '--text-muted', label: `fH = ${fmt(iir.fh, 0)} Hz` },
    ];
    const lab = (d, isAct) => `${d.kind === 'iir' ? `IIR orden ${d.order}` : `FIR M = ${d.numTaps}`}${isAct ? ' (activo)' : ''}`;
    P.mag.set({
      bands: band,
      vlines: cut,
      hlines: [{ y: -3, color: '--text-muted', label: '−3 dB' }],
      lines: [
        { x0: df / 2, dx: df, y: ri.magDb, color: '--series-1', width: act === 'iir' ? 2.4 : 1.6, label: lab(iir, act === 'iir') },
        { x0: df / 2, dx: df, y: rf.magDb, color: '--series-2', width: act === 'fir' ? 2.4 : 1.6, label: lab(fir, act === 'fir') },
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
  app.bus.on('tab-shown', (name) => {
    if (name === 'filtro' && dirty) render();
  });
  syncControls();
}
