/**
 * Exportación para el ESP32: genera perfil.h (filtro elegido + huella de cada perfil) y,
 * opcionalmente, prueba_audio.h (un audio de prueba con los valores que calcula la web, para
 * comprobar en la placa que el firmware da exactamente lo mismo).
 * Funciona igual en el navegador y en Node (scripts/esp32-perfiles.mjs).
 */
import { designFilter } from './dsp/filters.js';
import { analyzeSignal } from './dsp/features.js';
import { compareToProfile } from './dsp/matcher.js';

const MAX_PERFILES = 4;

const cf = (v) => {
  if (!Number.isFinite(v)) return '0.0f';
  const s = Number(v).toPrecision(9);
  return (s.includes('e') || s.includes('.') ? s : `${s}.0`) + 'f';
};
const cstr = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;

function arr(values, perLine = 8, fmt = cf) {
  const out = [];
  for (let i = 0; i < values.length; i += perLine) out.push(`  ${Array.from(values.slice(i, i + perLine), fmt).join(', ')},`);
  return out.join('\n');
}

/** perfil.h con 1 a 4 perfiles. */
export function profilesToHeader(profiles, fs = 16000) {
  const list = profiles.slice(0, MAX_PERFILES);
  if (!list.length) throw new Error('No hay perfiles para exportar.');
  const L = [];
  L.push('// =====================================================================================');
  L.push('//  Perfiles de Silbido ID para el ESP32 — generado por la web');
  L.push(`//  ${new Date().toISOString().slice(0, 10)} · ${list.length} perfil(es) · fs = ${fs} Hz`);
  L.push('//  El filtro de cada perfil lo eligió la auto-sintonía con sus propias tomas: no se edita a mano.');
  L.push('// =====================================================================================');
  L.push('#pragma once');
  L.push('#include "silbido_dsp.h"');
  L.push('');
  const defs = [];
  list.forEach((p, i) => {
    const d = designFilter(p.filter, fs);
    const tag = `P${i}`;
    L.push(`// ---- ${p.name.replace(/[\r\n]/g, ' ')} · ${d.name} · ${Math.round(d.fl)}–${Math.round(d.fh)} Hz`);
    let n;
    if (d.kind === 'iir') {
      n = d.sos.length;
      L.push(`static const float ${tag}_COEF[${n} * 5] = {  // { b0, b1, b2, a1, a2 } por sección`);
      for (const s of d.sos) L.push(`  ${[s[0], s[1], s[2], s[4], s[5]].map(cf).join(', ')},`);
    } else {
      n = d.taps.length;
      L.push(`static const float ${tag}_COEF[${n}] = {  // h[k]`);
      L.push(arr(d.taps, 6));
    }
    L.push('};');
    const refs = p.refs.slice(0, 3);
    refs.forEach((r, j) => {
      L.push(`static const float ${tag}_REF${j}[${r.contour.length}] = {  // toma ${r.take}, semitonos MIDI cada 20 ms`);
      L.push(arr(r.contour, 10, (v) => cf(Math.round(v * 100) / 100)));
      L.push('};');
    });
    const s = p.summary;
    const t = p.tolerances;
    const pad = (a, fill) => [...a, ...Array(3 - a.length).fill(fill)].join(', ');
    defs.push(
      `  {${cstr(p.name)},\n` +
        `   {silbido::${d.kind === 'iir' ? 'IIR' : 'FIR'}, ${n}, ${tag}_COEF, ${cf(d.fl)}, ${cf(d.fh)}},\n` +
        `   ${refs.length}, {${pad(refs.map((_, j) => `${tag}_REF${j}`), 'nullptr')}}, {${pad(refs.map((r) => r.contour.length), '0')}},\n` +
        `   ${[s.pitchMidi, s.durVoiced, s.segments, s.purity].map(cf).join(', ')},\n` +
        `   ${[t.contour, t.pitch, t.duration, t.segments, t.purity].map(cf).join(', ')}},`,
    );
    L.push('');
  });
  L.push('// nombre, filtro {tipo, n, coef, fL, fH}, referencias, resumen {tono MIDI, duración, segmentos, pureza},');
  L.push('// tolerancias τ {melodía, tono, duración, segmentos, pureza}');
  L.push('static const silbido::PerfilDef PERFILES[] = {');
  L.push(...defs);
  L.push('};');
  L.push('static constexpr int NUM_PERFILES = sizeof(PERFILES) / sizeof(PERFILES[0]);');
  L.push('');
  return L.join('\n');
}

/**
 * prueba_audio.h: 5 s de audio (int16) y lo que la web obtiene al compararlo con cada perfil.
 * El firmware lo usa con el comando "p" para comprobar que da lo mismo que la web.
 */
export function testAudioHeader(samples, profiles, { fs = 16000, description = 'audio de prueba' } = {}) {
  const n = 5 * fs;
  const q = new Int16Array(n);
  for (let i = 0; i < n; i++) q[i] = Math.max(-32768, Math.min(32767, Math.round((samples[i] || 0) * 32768)));
  const x = Float32Array.from(q, (v) => v / 32768);
  const L = [];
  L.push('// Audio de prueba para el comando "p" del firmware — generado por la web. Se puede borrar.');
  L.push('#pragma once');
  L.push('#include <stdint.h>');
  L.push(`static const char *PRUEBA_DESCRIPCION = ${cstr(description)};`);
  L.push('struct PruebaEsperado { const char *nombre; float pitchMidi, durVoiced; int segments; float purity, D; bool aceptado; };');
  L.push('static const PruebaEsperado PRUEBA_ESPERADO[] = {');
  for (const p of profiles.slice(0, MAX_PERFILES)) {
    const a = analyzeSignal(x, fs, designFilter(p.filter, fs));
    const r = compareToProfile(a, p, 1);
    const f = a.features;
    L.push(
      `  {${cstr(p.name)}, ${cf(f.pitchMidi)}, ${cf(f.durVoiced)}, ${f.segments}, ${cf(f.purity)}, ${cf(r.valid ? r.D : NaN)}, ${r.valid && r.accepted ? 'true' : 'false'}},`,
    );
  }
  L.push('};');
  L.push('static constexpr int PRUEBA_N = sizeof(PRUEBA_ESPERADO) / sizeof(PRUEBA_ESPERADO[0]);');
  L.push(`static const int16_t PRUEBA_AUDIO[${n}] = {`);
  L.push(arr(q, 20, (v) => String(v)));
  L.push('};');
  L.push('');
  return L.join('\n');
}
