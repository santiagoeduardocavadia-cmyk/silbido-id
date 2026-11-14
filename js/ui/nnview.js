// Dibujo de la red neuronal de Silbido ID (22 → 24 → K+1) con las activaciones de un silbido,
// y la comparación "huella de la prueba vs huella del perfil".
import { AI_INPUT_LABELS, AI_DIM, AI_HID } from '../dsp/ai.js';
import { midiToHz } from '../dsp/features.js';
import { fmt, escapeHtml } from '../util.js';

const POS = 'var(--series-1)';
const NEG = 'var(--series-2)';

function fmtInput(d, v) {
  if (d === 0) return `${fmt(v, 2)} st (${fmt(midiToHz(v), 0)} Hz)`;
  if (d === 1) return `${fmt(v, 2)} st`;
  if (d === 2) return `${fmt(v, 2)} s`;
  if (d === 3) return fmt(v, 1);
  if (d === 4) return `${fmt(v * 100, 0)} %`;
  if (d === 5) return `${fmt(v * 100, 1)} cents`;
  return `${v >= 0 ? '+' : '−'}${fmt(Math.abs(v), 2)} st`;
}

const nodeFill = (v) => `fill:${v >= 0 ? POS : NEG};fill-opacity:${(0.12 + 0.88 * Math.min(1, Math.abs(v))).toFixed(2)}`;

/**
 * host: elemento donde se dibuja. detail: forwardDetail(). target: índice de la salida a resaltar.
 * names: nombres de las salidas (perfiles). ok: si se aceptó (color del resaltado).
 */
export function renderNetwork(host, model, detail, { target = 0, ok = true, compact = false } = {}) {
  const { W1, W2 } = model.net;
  const C = model.K + 1;
  const names = [...model.names, 'Desconocido'];
  const { x, xn, h, p } = detail;
  const W = 1000;
  const top = 46;
  const span = compact ? 300 : 440;
  const H = top + span + 30;
  const xi = 175;
  const xh = 500;
  const xo = 790;
  const yi = (d) => top + (d * span) / (AI_DIM - 1);
  const yh = (j) => top + (j * span) / (AI_HID - 1);
  const oStep = C > 1 ? Math.min(90, span / (C - 1)) : 0;
  const yo = (c) => top + span / 2 - ((C - 1) * oStep) / 2 + c * oStep;

  const parts = [];
  // conexiones entrada → oculta (solo las que más aportan)
  let maxA = 1e-9;
  const ca = new Float64Array(AI_HID * AI_DIM);
  for (let j = 0; j < AI_HID; j++)
    for (let d = 0; d < AI_DIM; d++) {
      const v = W1[j * AI_DIM + d] * xn[d];
      ca[j * AI_DIM + d] = v;
      maxA = Math.max(maxA, Math.abs(v));
    }
  for (let j = 0; j < AI_HID; j++)
    for (let d = 0; d < AI_DIM; d++) {
      const v = ca[j * AI_DIM + d];
      const r = Math.abs(v) / maxA;
      if (r < 0.18) continue;
      parts.push(
        `<line x1="${xi}" y1="${yi(d).toFixed(1)}" x2="${xh}" y2="${yh(j).toFixed(1)}" style="stroke:${v >= 0 ? POS : NEG};stroke-opacity:${(0.08 + 0.55 * r).toFixed(2)};stroke-width:${(0.4 + 1.8 * r).toFixed(2)}"/>`,
      );
    }
  // conexiones oculta → salida
  let maxB = 1e-9;
  for (let c = 0; c < C; c++) for (let j = 0; j < AI_HID; j++) maxB = Math.max(maxB, Math.abs(W2[c * AI_HID + j] * h[j]));
  for (let c = 0; c < C; c++) {
    const isT = c === target;
    for (let j = 0; j < AI_HID; j++) {
      const v = W2[c * AI_HID + j] * h[j];
      const r = Math.abs(v) / maxB;
      if (!isT && r < 0.35) continue;
      parts.push(
        `<line x1="${xh}" y1="${yh(j).toFixed(1)}" x2="${xo}" y2="${yo(c).toFixed(1)}" style="stroke:${v >= 0 ? POS : NEG};stroke-opacity:${((isT ? 0.15 : 0.04) + (isT ? 0.75 : 0.25) * r).toFixed(2)};stroke-width:${((isT ? 0.6 : 0.4) + (isT ? 2.6 : 1) * r).toFixed(2)}"/>`,
      );
    }
  }
  // capa de entrada
  for (let d = 0; d < AI_DIM; d++) {
    const v = Math.tanh(xn[d]);
    const y = yi(d);
    const lbl = AI_INPUT_LABELS[d];
    parts.push(
      `<g><title>${lbl}: ${fmtInput(d, x[d])} · normalizado ${xn[d] >= 0 ? '+' : '−'}${fmt(Math.abs(xn[d]), 2)}</title><circle cx="${xi}" cy="${y.toFixed(1)}" r="6.5" style="${nodeFill(v)};stroke:var(--border-strong);stroke-width:1"/></g>`,
    );
    if (!compact || d < 6 || d % 3 === 0) {
      parts.push(`<text x="${xi - 12}" y="${(y + 3.5).toFixed(1)}" class="nn-lbl" text-anchor="end">${d >= 6 ? `Mel. ${d - 5}` : lbl}</text>`);
    }
  }
  parts.push(
    `<path d="M${xi - 100} ${yi(6) - 6} v${yi(AI_DIM - 1) - yi(6) + 12}" class="nn-brace"/><text x="${xi - 108}" y="${((yi(6) + yi(AI_DIM - 1)) / 2).toFixed(1)}" class="nn-lbl strong" text-anchor="end" transform="rotate(-90 ${xi - 108} ${((yi(6) + yi(AI_DIM - 1)) / 2).toFixed(1)})">forma de la melodía</text>`,
  );
  // capa oculta
  for (let j = 0; j < AI_HID; j++) {
    parts.push(
      `<g><title>Neurona oculta ${j + 1}: tanh = ${h[j] >= 0 ? '+' : '−'}${fmt(Math.abs(h[j]), 2)}</title><circle cx="${xh}" cy="${yh(j).toFixed(1)}" r="6.5" style="${nodeFill(h[j])};stroke:var(--border-strong);stroke-width:1"/></g>`,
    );
  }
  // salida
  for (let c = 0; c < C; c++) {
    const y = yo(c);
    const isT = c === target;
    const pc = p[c];
    const ring = isT ? (ok ? 'var(--good)' : 'var(--critical)') : 'var(--border-strong)';
    parts.push(
      `<g><title>${escapeHtml(names[c])}: ${fmt(pc * 100, 1)} %</title>
        <circle cx="${xo}" cy="${y.toFixed(1)}" r="${isT ? 17 : 14}" style="fill:var(--good);fill-opacity:${(0.08 + 0.85 * pc).toFixed(2)};stroke:${ring};stroke-width:${isT ? 3 : 1.2}"/>
        <text x="${xo}" y="${(y + 4).toFixed(1)}" class="nn-pct" text-anchor="middle">${fmt(pc * 100, 0)}</text>
        <text x="${xo + 28}" y="${(y - 2).toFixed(1)}" class="nn-out ${isT ? 'on' : ''}">${escapeHtml(names[c])}</text>
        <text x="${xo + 28}" y="${(y + 13).toFixed(1)}" class="nn-lbl">${fmt(pc * 100, pc < 0.1 ? 1 : 0)} %${c === model.K ? ' · nadie conocido' : ''}</text></g>`,
    );
  }
  // títulos de las capas
  parts.push(`<text x="${xi}" y="22" class="nn-head" text-anchor="middle">Entrada · 22 datos</text>`);
  parts.push(`<text x="${xh}" y="22" class="nn-head" text-anchor="middle">Capa oculta · 24 neuronas (tanh)</text>`);
  parts.push(`<text x="${xo}" y="22" class="nn-head" text-anchor="middle">Salida · softmax</text>`);
  host.innerHTML = `<svg class="nn-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Red neuronal: entradas, capa oculta y probabilidad de cada perfil">${parts.join('')}</svg>
    <div class="nn-legend"><span><i style="background:${POS}"></i>activación / aporte positivo</span><span><i style="background:${NEG}"></i>negativo</span><span>Más intenso = más fuerte. Pasa el cursor por un nodo para ver su valor.</span></div>`;
}

/** Huella de la prueba frente a la huella típica del perfil (lo que la red compara). */
export function renderMatch(host, qx, px, profile) {
  const tol = profile.tolerances;
  const rows = [
    { d: 0, tol: tol.pitch, unit: 'st' },
    { d: 2, tol: tol.duration, unit: 's' },
    { d: 3, tol: tol.segments, unit: '' },
    { d: 4, tol: tol.purity, unit: '%' },
    { d: 1, tol: 2, unit: 'st' },
    { d: 5, tol: 0.15, unit: '' },
  ];
  const tr = rows
    .map(({ d, tol: t }) => {
      const diff = Math.abs(qx[d] - px[d]);
      const r = diff / t;
      const cls = r <= 1 ? 'good' : r <= 1.6 ? 'warning' : 'critical';
      return `<tr><td>${AI_INPUT_LABELS[d]}</td><td>${fmtInput(d, qx[d])}</td><td>${fmtInput(d, px[d])}</td><td><span class="status ${cls}">${r <= 1 ? 'parecido' : r <= 1.6 ? 'algo distinto' : 'distinto'}</span></td></tr>`;
    })
    .join('');
  // forma de la melodía (16 puntos)
  const q = Array.from(qx.slice(6));
  const pm = Array.from(px.slice(6));
  const all = [...q, ...pm];
  const lo = Math.min(...all) - 0.5;
  const hi = Math.max(...all) + 0.5;
  const X = (i) => 10 + (i * 280) / 15;
  const Y = (v) => 82 - ((v - lo) / (hi - lo || 1)) * 72;
  const line = (arr) => arr.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const mad = q.reduce((s, v, i) => s + Math.abs(v - pm[i]), 0) / q.length;
  host.innerHTML = `<div class="nn-match">
    <div>
      <h3 class="mini-h">Forma de la melodía <small>diferencia media ${fmt(mad, 2)} st</small></h3>
      <svg viewBox="0 0 300 92" class="nn-shape" role="img" aria-label="Forma de la melodía de la prueba y del perfil">
        <polyline points="${line(pm)}" style="fill:none;stroke:var(--series-1);stroke-width:2.4"/>
        <polyline points="${line(q)}" style="fill:none;stroke:var(--series-2);stroke-width:2.4;stroke-dasharray:5 3"/>
      </svg>
      <div class="nn-legend"><span><i style="background:var(--series-1)"></i>${escapeHtml(profile.name)} (típico)</span><span><i style="background:var(--series-2)"></i>Prueba</span></div>
    </div>
    <div class="table-wrap"><table class="table nn-table"><thead><tr><th>Dato</th><th>Prueba</th><th>${escapeHtml(profile.name)}</th><th></th></tr></thead><tbody>${tr}</tbody></table></div>
  </div>`;
}
