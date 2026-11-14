#!/usr/bin/env node
/**
 * Genera los archivos de perfiles para el firmware del ESP32.
 *
 *   node scripts/esp32-perfiles.mjs                     → perfiles demo (Ana y Beto)
 *   node scripts/esp32-perfiles.mjs mi-perfil.json ...  → perfiles exportados desde la web
 *
 * Escribe esp32/reconocedor_autonomo/perfil.h y esp32/reconocedor_autonomo/prueba_audio.h (audio de prueba con los
 * valores que calcula la web, para el comando "p" del firmware).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profilesToHeader, testAudioHeader } from '../js/esp32.js';
import { synthWhistle, DEMO_PEOPLE } from '../js/dsp/synth.js';
import { autoTuneFilter } from '../js/dsp/autofilter.js';
import { buildProfile } from '../js/dsp/matcher.js';

const FS = 16000;
const DEFAULT_FILTER = { type: 'iir', fl: 1000, fh: 4000, order: 4, taps: 101, win: 'hamming' };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'esp32', 'reconocedor_autonomo');

function demoProfile(person, seedBase) {
  const samples = [1, 2, 3, 4, 5].map((i) => synthWhistle(person, { fs: FS, dur: 5, seed: seedBase + i }));
  const tuned = autoTuneFilter(samples, FS, DEFAULT_FILTER);
  const p = buildProfile({ name: person.name, analyses: tuned.analyses, filterCfg: tuned.cfg, fs: FS });
  console.log(`  ${person.name}: ${tuned.cfg.type.toUpperCase()} ${tuned.cfg.fl}–${tuned.cfg.fh} Hz (auto-sintonía)`);
  return { profile: p, best: samples[p.bestTake - 1] };
}

function b64ToFloat(b64) {
  const buf = Buffer.from(b64, 'base64');
  const i16 = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
  return Float32Array.from(i16, (v) => v / 32767);
}

const files = process.argv.slice(2);
let profiles;
let test;
if (!files.length) {
  console.log('Sin archivos: se generan los perfiles de demostración.');
  const ana = demoProfile(DEMO_PEOPLE.ana, 100);
  const beto = demoProfile(DEMO_PEOPLE.beto, 200);
  profiles = [ana.profile, beto.profile];
  test = { samples: synthWhistle(DEMO_PEOPLE.ana, { fs: FS, dur: 5, seed: 99 }), description: 'silbido sintético nuevo de Ana (semilla 99)' };
} else {
  profiles = [];
  for (const f of files) {
    const data = JSON.parse(readFileSync(f, 'utf8'));
    for (const p of Array.isArray(data) ? data : [data]) {
      if (!p || !Array.isArray(p.refs) || !p.filter) throw new Error(`${f} no es un perfil de Silbido ID`);
      if (!p.filter.auto) console.warn(`  Aviso: ${p.name} se creó antes de la auto-sintonía; vuelve a grabarlo para que el filtro se elija solo.`);
      profiles.push(p);
    }
  }
  const withAudio = profiles.find((p) => p.bestAudio);
  if (withAudio) test = { samples: b64ToFloat(withAudio.bestAudio), description: `mejor toma de ${withAudio.name}` };
}
if (profiles.length > 4) {
  console.warn(`Hay ${profiles.length} perfiles; el firmware admite 4. Se usan los primeros 4.`);
  profiles = profiles.slice(0, 4);
}

writeFileSync(join(outDir, 'perfil.h'), profilesToHeader(profiles, FS));
console.log(`Escrito esp32/reconocedor_autonomo/perfil.h (${profiles.length} perfil(es))`);
if (test) {
  writeFileSync(join(outDir, 'prueba_audio.h'), testAudioHeader(test.samples, profiles, { fs: FS, description: test.description }));
  console.log(`Escrito esp32/reconocedor_autonomo/prueba_audio.h (${test.description})`);
}
