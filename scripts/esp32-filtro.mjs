#!/usr/bin/env node
/**
 * Genera esp32/silbido_id/filtro.h, el filtro que aplica la ESP32 a la señal del micrófono.
 *
 *   node scripts/esp32-filtro.mjs                 → pre-filtro por defecto (Butterworth orden 6, 400–7000 Hz)
 *   node scripts/esp32-filtro.mjs mi-perfil.json  → el filtro que la auto-sintonía eligió para ese perfil
 *
 * Desde la web es lo mismo: Filtro → "Exportar filtro para ESP32", o el botón "ESP32" de cada perfil.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { designFilter, toCHeader } from '../js/dsp/filters.js';

const FS = 16000;
export const PREFILTRO = { type: 'iir', fl: 400, fh: 7000, order: 3, taps: 101, win: 'hamming' };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'esp32', 'silbido_id', 'filtro.h');

const file = process.argv[2];
let cfg = PREFILTRO;
let origin = 'pre-filtro por defecto (no corta ningún silbido humano)';
if (file) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const p = Array.isArray(data) ? data[0] : data;
  if (!p || !p.filter) throw new Error(`${file} no es un perfil de Silbido ID`);
  cfg = p.filter;
  origin = `filtro de ${p.name}${p.filter.auto ? ' (auto-sintonía)' : ''}`;
}
writeFileSync(out, toCHeader(designFilter(cfg, FS)));
console.log(`Escrito esp32/silbido_id/filtro.h: ${origin} · ${cfg.type.toUpperCase()} ${cfg.fl}–${cfg.fh} Hz`);
