// Vista 2 · Análisis: señal en el tiempo, FFT, contorno de tono, STFT, CWT y DWT.
import { Plot, addExportButtons } from '../ui/plot.js';
import { spectrum, toDb } from '../dsp/fft.js';
import { stft, dbRange } from '../dsp/stft.js';
import { cwtMorlet, dwt } from '../dsp/wavelet.js';
import { noteName, midiToHz } from '../dsp/features.js';
import { buildAnnotations, annotationTip, featureCards, keyIcon } from '../ui/annotate.js';
import { $, $$, fmt, fmtHz, fmtFreqTick, icons, nextFrame, encodeWav, download, escapeHtml, slug } from '../util.js';
import { timeAxis, freqAxis, noteAxis, midiRange, barRow } from './common.js';

export function initAnalysis(app) {
  // Los perfiles se analizan con el filtro que la auto-sintonía eligió para ellos; las tomas, con el actual.
  const cfgOf = (item) => (item && item.kind === 'profile' ? item.profile.filter : app.state.filter);
  const el = {
    chips: $('#source-chips'),
    empty: $('#analysis-empty'),
    content: $('#analysis-content'),
    status: $('#analysis-status'),
    featGrid: $('#feat-grid'),
    annotSig: $('#annot-sig'),
    annotReset: $('#annot-reset'),
    playO: $('#an-play-orig'),
    playF: $('#an-play-filt'),
    wav: $('#an-wav'),
    stftN: $('#stft-n'),
    stftOv: $('#stft-ov'),
    stftWin: $('#stft-win'),
    stftContour: $('#stft-contour'),
    stftInfo: $('#stft-info'),
    w0: $('#cwt-w0'),
    sigSeg: $('#cwt-sig'),
    dwtBars: $('#dwt-bars'),
    dwtPlots: $('#dwt-plots'),
  };
  el.playO.querySelector('.ico').innerHTML = icons.play;
  el.playF.querySelector('.ico').innerHTML = icons.filter;
  el.wav.querySelector('.ico').innerHTML = icons.download;

  let zoomCenter = null;
  let currentId = null;
  let sig = 'y';
  let annotSig = 'y';
  let annotInfo = [];
  let annotCompact = false;
  const hiddenLayers = new Set();
  let dirty = true;
  let token = 0;
  let cur = null; // { item, a, src }

  const P = {
    annot: new Plot($('#plot-annot'), {
      height: 400,
      margin: { t: 14 },
      x: timeAxis(),
      y: freqAxis(),
      crosshair: 'xy',
      colorbar: { label: 'dB' },
      extraTip: (p) => annotationTip(annotInfo, p.x, p.y),
      ariaLabel: 'Mapa de calor del silbido con los segmentos, el contorno de tono y la banda del filtro marcados',
      name: 'mapa-calor-anotado',
    }),
    time: new Plot($('#plot-time'), {
      height: 220,
      x: timeAxis(),
      y: { label: 'Amplitud', min: -1, max: 1, tip: (v) => fmt(v, 3) },
      name: 'senal-tiempo',
      onClick: (x) => {
        zoomCenter = x;
        drawTime();
        drawZoom();
      },
    }),
    zoom: new Plot($('#plot-zoom'), {
      height: 170,
      x: { label: 'Tiempo (ms)', min: 0, max: 20, tip: (v) => `${fmt(v, 2)} ms` },
      y: { label: 'Amplitud', min: -1, max: 1, tip: (v) => fmt(v, 3) },
      name: 'zoom-20ms',
    }),
    spec: new Plot($('#plot-spec'), {
      height: 260,
      x: freqAxis(),
      y: { label: 'Magnitud (dB)', min: -100, max: 6, tip: (v) => `${fmt(v, 1)} dB` },
      name: 'espectro-fft',
    }),
    contour: new Plot($('#plot-contour'), { height: 260, x: timeAxis(), y: noteAxis(84, 100), name: 'contorno-tono' }),
    stftO: new Plot($('#plot-stft-o'), { height: 240, x: timeAxis(), y: freqAxis(), crosshair: 'xy', colorbar: { label: 'dB' }, name: 'espectrograma-original' }),
    stftF: new Plot($('#plot-stft-f'), { height: 240, x: timeAxis(), y: freqAxis(), crosshair: 'xy', colorbar: { label: 'dB' }, name: 'espectrograma-filtrado' }),
    cwt: new Plot($('#plot-cwt'), {
      height: 290,
      x: timeAxis(),
      y: { label: 'Frecuencia (Hz)', min: 250, max: 7000, scale: 'log', ticks: [250, 500, 1000, 2000, 4000, 7000], format: fmtFreqTick, tip: (v) => fmtHz(v) },
      crosshair: 'xy',
      colorbar: { label: 'dB' },
      name: 'escalograma-cwt',
    }),
  };
  new ResizeObserver(() => {
    if (cur && P.annot.wrap.clientWidth > 0 && (P.annot.wrap.clientWidth < 560) !== annotCompact) drawAnnot();
  }).observe(P.annot.wrap);
  addExportButtons($('#tools-annot'), P.annot, 'mapa-de-calor', { csv: false });
  addExportButtons($('#tools-time'), P.time, 'senal-tiempo', { csv: false });
  addExportButtons($('#tools-spec'), P.spec, 'espectro');
  addExportButtons($('#tools-contour'), P.contour, 'contorno');
  addExportButtons($('#tools-stft'), P.stftF, 'espectrograma-filtrado', { csv: false });
  addExportButtons($('#tools-cwt'), P.cwt, 'escalograma', { csv: false });

  const dwtPlots = [];
  function ensureDwtPlots(n) {
    while (dwtPlots.length < n) {
      const host = document.createElement('div');
      el.dwtPlots.appendChild(host);
      dwtPlots.push(host);
    }
    // se crean al vuelo según sea la última (con eje de tiempo) o no
    return dwtPlots.map((host, i) => {
      if (!host._plot) {
        const last = i === n - 1;
        host._plot = new Plot(host, {
          height: last ? 72 : 50,
          margin: { l: 54, r: 14, t: 4, b: last ? 30 : 4 },
          x: { ...timeAxis(), label: last ? 'Tiempo (s)' : '', hideTicks: !last },
          y: { label: '', min: -1, max: 1, hideTicks: true, grid: false, tip: (v) => fmt(v, 4) },
          name: `dwt-${i}`,
        });
      }
      return host._plot;
    });
  }

  // ---------- fuentes ----------
  function renderChips(srcs) {
    el.chips.innerHTML = srcs
      .map(
        (s) =>
          `<button type="button" class="chip" role="radio" aria-checked="${s.id === currentId}" data-id="${escapeHtml(s.id)}">${s.best ? icons.star : ''}${escapeHtml(s.label)}</button>`,
      )
      .join('');
  }

  el.chips.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b || b.dataset.id === currentId) return;
    currentId = b.dataset.id;
    zoomCenter = null;
    render();
  });

  el.playO.addEventListener('click', () => cur && app.togglePlay(cur.item.samples, el.playO));
  el.playF.addEventListener('click', () => cur && app.togglePlay(cur.a.y, el.playF));
  el.wav.addEventListener('click', () => cur && download(`${slug(cur.src.label)}.wav`, encodeWav(cur.item.samples, app.FS)));

  // ---------- caché de visualizaciones ----------
  function viz(item, key, fn) {
    if (!item.viz.has(key)) {
      item.viz.set(key, fn());
      while (item.viz.size > 10) item.viz.delete(item.viz.keys().next().value);
    }
    return item.viz.get(key);
  }

  // ---------- render principal ----------
  async function render() {
    if (app.state.tab !== 'analisis') {
      dirty = true;
      return;
    }
    dirty = false;
    const my = ++token;
    const srcs = app.sources();
    if (!srcs.some((s) => s.id === currentId)) {
      const best = srcs.find((s) => s.best);
      currentId = (best || srcs[0] || {}).id || null;
      zoomCenter = null;
    }
    renderChips(srcs);
    if (!srcs.length) {
      el.empty.hidden = false;
      el.content.hidden = true;
      cur = null;
      return;
    }
    el.empty.hidden = true;
    el.content.hidden = false;
    const src = srcs.find((s) => s.id === currentId);
    el.status.textContent = 'Analizando…';
    el.status.classList.add('busy');
    await nextFrame();
    if (my !== token) return;
    const a = app.analyze(src.item, cfgOf(src.item));
    cur = { item: src.item, a, src };
    renderFeatures();
    drawAnnot();
    if (zoomCenter == null) zoomCenter = defaultZoom(a);
    await nextFrame();
    if (my !== token) return;
    drawTime();
    drawZoom();
    drawSpectrum();
    drawContour();
    await nextFrame();
    if (my !== token) return;
    drawStft();
    el.status.textContent = 'Calculando wavelets…';
    await nextFrame();
    if (my !== token) return;
    drawWavelets();
    const d = a.design;
    const f = a.features;
    el.status.classList.remove('busy');
    el.status.textContent = `${src.label} · filtro ${d.name}, ${fmt(d.fl, 0)}–${fmt(d.fh, 0)} Hz · fs = ${fmt(app.FS, 0)} Hz · nivel pico ${fmt(f.peakDb, 1)} dBFS${f.clipped ? ' (saturada: aléjate un poco)' : f.peakDb < -40 ? ' (muy bajo: acércate al micrófono)' : ''}`;
  }

  function defaultZoom(a) {
    if (!a.segments.length) return a.duration / 2;
    let best = a.segments[0];
    for (const s of a.segments) if (s.end - s.start > best.end - best.start) best = s;
    return (best.start + best.end) / 2;
  }

  /** Tarjetas "qué mide cada marca": enlazadas con los recuadros del mapa de calor. */
  function renderFeatures() {
    const { a } = cur;
    const cards = featureCards(a);
    const note = a.features.valid
      ? ''
      : `<p class="muted small" style="grid-column: 1 / -1; margin: 0">No se detectó un silbido claro (hacen falta al menos 0,3 s con un tono definido dentro de la banda del filtro). Prueba acercarte al micrófono o ampliar la banda en Filtro.</p>`;
    el.featGrid.innerHTML =
      note +
      cards
        .map(
          (c) => `<button type="button" class="feat" style="--c: var(${c.color})" data-layers="${c.layers.join(' ')}" aria-pressed="${!hiddenLayers.has(c.layers[0])}" title="Clic para mostrar u ocultar en el mapa">
            <span class="feat-key">${keyIcon(c.shape)}</span>
            <span class="feat-body"><span class="feat-label">${c.label}</span><span class="feat-value">${c.value}</span><span class="feat-note">${c.note}</span></span>
          </button>`,
        )
        .join('');
  }

  function syncFeatState() {
    for (const b of el.featGrid.querySelectorAll('.feat')) b.setAttribute('aria-pressed', String(!hiddenLayers.has(b.dataset.layers.split(' ')[0])));
    P.annot.setHidden(hiddenLayers);
  }

  const layersOf = (btn) => new Set(btn.dataset.layers.split(' '));
  el.featGrid.addEventListener('mouseover', (e) => {
    const b = e.target.closest('.feat');
    if (b) P.annot.setHighlight(layersOf(b));
  });
  el.featGrid.addEventListener('mouseout', (e) => {
    if (!e.target.closest('.feat')) return;
    const next = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('.feat') : null;
    P.annot.setHighlight(next ? layersOf(next) : null);
  });
  el.featGrid.addEventListener('focusin', (e) => {
    const b = e.target.closest('.feat');
    if (b) P.annot.setHighlight(layersOf(b));
  });
  el.featGrid.addEventListener('focusout', () => P.annot.setHighlight(null));
  el.featGrid.addEventListener('click', (e) => {
    const b = e.target.closest('.feat');
    if (!b) return;
    const k = b.dataset.layers.split(' ')[0];
    if (hiddenLayers.has(k)) hiddenLayers.delete(k);
    else hiddenLayers.add(k);
    syncFeatState();
  });
  el.annotReset.addEventListener('click', () => {
    hiddenLayers.clear();
    syncFeatState();
  });
  el.annotSig.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sig]');
    if (!b) return;
    annotSig = b.dataset.sig;
    for (const x of $$('button', el.annotSig)) x.setAttribute('aria-pressed', String(x === b));
    drawAnnot();
  });

  function drawAnnot() {
    if (!cur) return;
    const { item, a } = cur;
    const dk = app.designKey(cfgOf(item));
    const S = viz(item, `${dk}|astft|${annotSig}`, () => stft(annotSig === 'y' ? a.y : a.x, app.FS, { N: 512, overlap: 0.875, win: 'hann', fmax: 8000 }));
    const range = dbRange(S.data, annotSig === 'y' ? 58 : 66);
    const d = a.design;
    // Filtrada: se acerca a la banda de interés. Original: se ve todo para notar lo que el filtro descarta.
    const ymin = annotSig === 'y' ? Math.max(0, Math.floor((d.fl * 0.55) / 100) * 100) : 0;
    const ymax = annotSig === 'y' ? Math.min(8000, Math.ceil((d.fh * 1.45) / 100) * 100) : 8000;
    // En pantallas estrechas las etiquetas largas estorban: quedan solo los números y las tarjetas de abajo
    annotCompact = P.annot.wrap.clientWidth < 560;
    const { layers, info } = buildAnnotations(a, { fmax: 8000, compact: annotCompact });
    annotInfo = info;
    P.annot.setAxes({ x: { max: a.duration }, y: { min: ymin, max: ymax } });
    P.annot.set({ heatmap: { ...S, vmin: range.vmin, vmax: range.vmax }, ...layers });
    P.annot.setHidden(hiddenLayers);
  }

  function drawTime() {
    if (!cur) return;
    const { a } = cur;
    let A = 0.02;
    for (let i = 0; i < a.x.length; i++) A = Math.max(A, Math.abs(a.x[i]));
    A *= 1.1;
    const bands = a.segments.map((s, i) => ({ x0: s.start, x1: s.end, color: '--series-1', alpha: 0.09, legend: i === 0 ? 'Silbido detectado' : '' }));
    bands.push({ x0: zoomCenter - 0.01, x1: zoomCenter + 0.01, color: '--series-2', alpha: 0.35 });
    P.time.setAxes({ x: { max: a.duration }, y: { min: -A, max: A } });
    P.time.set({
      bands,
      lines: [
        { x0: 0, dx: 1 / app.FS, y: a.x, color: '--series-neutral', width: 1, label: 'Original x[n]' },
        { x0: 0, dx: 1 / app.FS, y: a.y, color: '--series-1', width: 1, label: 'Filtrada y[n]' },
      ],
    });
  }

  function drawZoom() {
    if (!cur) return;
    const { a } = cur;
    const fs = app.FS;
    const half = Math.round(0.01 * fs);
    let i0 = Math.round(zoomCenter * fs) - half;
    i0 = Math.max(0, Math.min(a.x.length - 2 * half, i0));
    const xs = a.x.subarray(i0, i0 + 2 * half);
    const ys = a.y.subarray(i0, i0 + 2 * half);
    let A = 1e-4;
    for (let i = 0; i < xs.length; i++) A = Math.max(A, Math.abs(xs[i]), Math.abs(ys[i]));
    A *= 1.15;
    const t0 = (i0 / fs) * 1000;
    P.zoom.setAxes({ x: { min: t0, max: t0 + 20 }, y: { min: -A, max: A } });
    P.zoom.set({
      lines: [
        { x0: t0, dx: 1000 / fs, y: xs, color: '--series-neutral', width: 1.5, label: 'Original x[n]' },
        { x0: t0, dx: 1000 / fs, y: ys, color: '--series-1', width: 2, label: 'Filtrada y[n]' },
      ],
    });
  }

  function drawSpectrum() {
    const { item, a } = cur;
    const dk = app.designKey(cfgOf(item));
    const sp = viz(item, `${dk}|spec`, () => {
      const so = spectrum(a.x, app.FS);
      const sf = spectrum(a.y, app.FS);
      let ref = 1e-12;
      for (let k = 0; k < so.bins; k++) ref = Math.max(ref, so.mag[k]);
      const dbo = toDb(so.mag, ref);
      const dbf = toDb(sf.mag, ref);
      let kp = 0;
      const k0 = Math.floor(a.design.fl / so.df);
      const k1 = Math.min(sf.bins - 1, Math.ceil(a.design.fh / so.df));
      for (let k = k0; k <= k1; k++) if (dbf[k] > dbf[kp] || kp < k0) kp = k;
      return { dbo, dbf, df: so.df, fpk: kp * so.df, dpk: dbf[kp], nfft: so.nfft };
    });
    P.spec.set({
      bands: [{ x0: a.design.fl, x1: a.design.fh, color: '--series-1', alpha: 0.07, legend: 'Banda de paso' }],
      lines: [
        { x0: 0, dx: sp.df, y: sp.dbo, color: '--series-neutral', width: 1.5, label: 'Original', envelope: 'max' },
        { x0: 0, dx: sp.df, y: sp.dbf, color: '--series-1', width: 1.5, label: 'Filtrada', envelope: 'max' },
      ],
      points: [{ x: [sp.fpk], y: [sp.dpk], color: '--series-2', marker: 'o', size: 10, labels: [`${fmt(sp.fpk, 0)} Hz`] }],
    });
  }

  function drawContour() {
    const { a } = cur;
    if (!a.features.valid) {
      P.contour.clear('No se detectó un silbido en esta señal');
      return;
    }
    const [lo, hi] = midiRange([a.midi]);
    P.contour.setAxes({ x: { max: a.duration }, y: { min: lo, max: hi } });
    P.contour.set({
      bands: a.segments.map((s) => ({ x0: s.start, x1: s.end, color: '--series-1', alpha: 0.06 })),
      hlines: [{ y: a.features.pitchMidi, color: '--text-muted', label: `mediana ${noteName(a.features.pitchMidi)} · ${fmt(a.features.pitchHz, 0)} Hz` }],
      lines: [{ x: a.frames.times, y: a.midi, color: '--series-1', width: 2.2, label: 'f₀(t)', tip: (v) => `${noteName(v)} · ${fmt(midiToHz(v), 0)} Hz` }],
    });
  }

  function drawStft() {
    if (!cur) return;
    const { item, a } = cur;
    const N = Number(el.stftN.value);
    const ov = Number(el.stftOv.value);
    const win = el.stftWin.value;
    const dk = app.designKey(cfgOf(item));
    const S = viz(item, `${dk}|stft|${N}|${ov}|${win}`, () => {
      const so = stft(a.x, app.FS, { N, overlap: ov, win, fmax: 8000 });
      const sf = stft(a.y, app.FS, { N, overlap: ov, win, fmax: 8000 });
      return { so, sf, range: dbRange(so.data, 65) };
    });
    const f0 = Float32Array.from(a.midi, (m) => (Number.isFinite(m) ? midiToHz(m) : NaN));
    const overlay = el.stftContour.checked && a.features.valid ? [{ x: a.frames.times, y: f0, color: '--ann-f0', width: 1.8, casing: true, label: 'f₀(t)', tip: (v) => fmtHz(v) }] : [];
    for (const [plot, s] of [
      [P.stftO, S.so],
      [P.stftF, S.sf],
    ]) {
      plot.setAxes({ x: { max: a.duration } });
      plot.set({ heatmap: { ...s, vmin: S.range.vmin, vmax: S.range.vmax }, lines: overlay });
    }
    const s = S.so;
    el.stftInfo.textContent = `N = ${N} → Δt = ${fmt((N / app.FS) * 1000, 0)} ms, Δf = f_s/N = ${fmt(app.FS / N, 1)} Hz · salto H = ${s.hop} muestras · ${s.cols} tramas × ${s.rows} bins de frecuencia`;
  }

  function drawWavelets() {
    if (!cur) return;
    const { item, a } = cur;
    const w0 = Number(el.w0.value);
    const dk = app.designKey(cfgOf(item));
    const signal = sig === 'y' ? a.y : a.x;
    const C = viz(item, `${dk}|cwt|${sig}|${w0}`, () => cwtMorlet(signal, app.FS, { fmin: 250, fmax: 7000, nScales: 72, w0 }));
    const r = dbRange(C.data, 60);
    P.cwt.setAxes({ x: { max: a.duration } });
    P.cwt.set({ heatmap: { ...C, vmin: r.vmin, vmax: r.vmax } });

    const W = viz(item, `${dk}|dwt|${sig}`, () => dwt(signal, app.FS, 5));
    const maxShare = Math.max(...W.bands.map((b) => b.share));
    el.dwtBars.innerHTML = W.bands
      .map((b) =>
        barRow({
          label: `<b>${b.name}</b>`,
          sub: `${fmtFreqTick(b.fLo)}–${fmtFreqTick(b.fHi)} Hz`,
          pct: b.share * 100,
          valueText: `${fmt(b.share * 100, 1)} %`,
          cls: b.share === maxShare ? 'hi' : '',
        }),
      )
      .join('');
    const plots = ensureDwtPlots(W.bands.length);
    W.bands.forEach((b, i) => {
      let m = 1e-9;
      for (let k = 0; k < b.coeffs.length; k++) m = Math.max(m, Math.abs(b.coeffs[k]));
      const p = plots[i];
      p.setAxes({ x: { max: a.duration }, y: { min: -m * 1.1, max: m * 1.1 } });
      p.set({
        lines: [{ x0: 0, dx: b.dt, y: b.coeffs, color: b.share === maxShare ? '--series-1' : '--series-neutral', width: 1, label: b.name }],
        texts: [{ x: 0.03, y: m * 0.72, text: `${b.name} · ${fmtFreqTick(b.fLo)}–${fmtFreqTick(b.fHi)} Hz · ${fmt(b.share * 100, 1)} %`, color: '--text-secondary' }],
      });
    });
  }

  // ---------- controles ----------
  for (const s of [el.stftN, el.stftOv, el.stftWin, el.stftContour]) s.addEventListener('change', drawStft);
  el.w0.addEventListener('change', drawWavelets);
  el.sigSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sig]');
    if (!b) return;
    sig = b.dataset.sig;
    for (const x of $$('button', el.sigSeg)) x.setAttribute('aria-pressed', String(x === b));
    drawWavelets();
  });

  const refresh = () => (app.state.tab === 'analisis' ? render() : (dirty = true));
  for (const evt of ['takes-changed', 'profiles-changed', 'query-changed', 'filter-changed']) app.bus.on(evt, refresh);
  app.bus.on('tab-shown', (name) => {
    if (name === 'analisis' && dirty) render();
  });
  app.bus.on('select-source', (id) => {
    currentId = id;
    zoomCenter = null;
    dirty = true;
  });
}
