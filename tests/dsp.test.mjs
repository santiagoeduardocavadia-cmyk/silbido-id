// Pruebas del núcleo DSP (sin navegador):  node tests/dsp.test.mjs
import { fft, spectrum } from '../js/dsp/fft.js';
import { butterBandpass, butterAnalogMag, firBandpass, freqResponse, sosfilt, firFilter, polyRoots, firZerosPoles, toCHeader } from '../js/dsp/filters.js';
import { stft } from '../js/dsp/stft.js';
import { cwtMorlet, dwt, DB4_LO, DB4_HI } from '../js/dsp/wavelet.js';
import { analyzeSignal, hzToMidi, noteName } from '../js/dsp/features.js';
import { dtw, rankTakes, buildProfile, compareToProfile } from '../js/dsp/matcher.js';
import { synthWhistle, DEMO_PEOPLE } from '../js/dsp/synth.js';
import { autoTuneFilter } from '../js/dsp/autofilter.js';
import { profilesToHeader, testAudioHeader } from '../js/esp32.js';
import { trainModel, predict, explain, aiThreshold } from '../js/dsp/ai.js';
import { splitTakes } from '../js/audio.js';
import { FrameParser } from '../js/esp32-serial.js';
import { designFilter } from '../js/dsp/filters.js';

let fails = 0;
let passes = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passes++;
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fails++;
    console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const section = (s) => console.log(`\n${s}`);
const fs = 16000;

section('FFT');
{
  const N = 64;
  const x = Array.from({ length: N }, (_, i) => Math.sin(i * 0.37) + 0.3 * Math.cos(i * 1.7) + ((i * 7919) % 13) / 13);
  const re = Float64Array.from(x);
  const im = new Float64Array(N);
  fft(re, im);
  let err = 0;
  for (let k = 0; k < N; k++) {
    let sr = 0;
    let si = 0;
    for (let n = 0; n < N; n++) {
      sr += x[n] * Math.cos((2 * Math.PI * k * n) / N);
      si -= x[n] * Math.sin((2 * Math.PI * k * n) / N);
    }
    err = Math.max(err, Math.hypot(sr - re[k], si - im[k]));
  }
  check('FFT = DFT directa (N = 64)', err < 1e-9, `error máx ${err.toExponential(2)}`);
  fft(re, im, true);
  let err2 = 0;
  for (let n = 0; n < N; n++) err2 = Math.max(err2, Math.abs(re[n] - x[n]), Math.abs(im[n]));
  check('IFFT(FFT(x)) = x', err2 < 1e-12, `error máx ${err2.toExponential(2)}`);
  const sig = Float32Array.from({ length: 16000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / fs));
  const sp = spectrum(sig, fs);
  let kmax = 0;
  for (let k = 0; k < sp.bins; k++) if (sp.mag[k] > sp.mag[kmax]) kmax = k;
  check('Espectro: pico en 1 kHz con amplitud 0,5', Math.abs(kmax * sp.df - 1000) < 1 && Math.abs(sp.mag[kmax] - 0.5) < 0.02, `${(kmax * sp.df).toFixed(2)} Hz, A = ${sp.mag[kmax].toFixed(3)}`);
}

section('Butterworth IIR pasa-banda');
for (const N of [2, 3, 4, 5]) {
  const d = butterBandpass(N, 1000, 4000, fs);
  const r = freqResponse(d, 400);
  let err = 0;
  for (let i = 0; i < r.freqs.length; i++) {
    const ref = 20 * Math.log10(butterAnalogMag(d, r.freqs[i]));
    if (ref > -120) err = Math.max(err, Math.abs(ref - r.magDb[i]));
  }
  const at = (f) => {
    const w = (2 * Math.PI * f) / fs;
    let m = 1;
    for (const s of d.sos) {
      const ev = (c0, c1, c2) => Math.hypot(c0 + c1 * Math.cos(w) + c2 * Math.cos(2 * w), c1 * Math.sin(w) + c2 * Math.sin(2 * w));
      m *= ev(s[0], s[1], s[2]) / ev(s[3], s[4], s[5]);
    }
    return 20 * Math.log10(m);
  };
  const maxPole = Math.max(...d.poles.map((p) => Math.hypot(p.re, p.im)));
  check(`orden ${2 * N}: |H| digital = Butterworth analógico pre-distorsionado`, err < 1e-6, `error máx ${err.toExponential(2)} dB`);
  check(`orden ${2 * N}: −3,01 dB en 1000 y 4000 Hz, 0 dB en el centro`, Math.abs(at(1000) + 3.0103) < 1e-3 && Math.abs(at(4000) + 3.0103) < 1e-3 && Math.abs(at(d.centerHz)) < 1e-9, `${at(1000).toFixed(4)} / ${at(4000).toFixed(4)} / ${at(d.centerHz).toFixed(6)} dB`);
  check(`orden ${2 * N}: estable (polos dentro del círculo unitario)`, maxPole < 1, `|p|máx = ${maxPole.toFixed(5)}`);
}
{
  const d = butterBandpass(4, 1000, 4000, fs);
  const t = Float32Array.from({ length: 16000 }, (_, i) => Math.sin((2 * Math.PI * 2000 * i) / fs) + Math.sin((2 * Math.PI * 60 * i) / fs));
  const y = sosfilt(d.sos, t);
  let a = 0;
  for (let i = 8000; i < 16000; i++) a = Math.max(a, Math.abs(y[i]));
  check('sosfilt: deja pasar 2 kHz y elimina 60 Hz', Math.abs(a - 1) < 0.05, `amplitud de salida ${a.toFixed(3)}`);
}

section('FIR por ventanas');
{
  const d = firBandpass(101, 1000, 4000, fs, 'hamming');
  let sym = 0;
  for (let i = 0; i < d.taps.length; i++) sym = Math.max(sym, Math.abs(d.taps[i] - d.taps[d.taps.length - 1 - i]));
  check('coeficientes simétricos (fase lineal)', sym < 1e-15);
  const r = freqResponse(d, 800);
  const near = (f) => r.magDb[Math.round((f / (fs / 2)) * 800 - 0.5)];
  check('ganancia ≈ 0 dB en la banda de paso', Math.abs(near(2500)) < 0.1 && Math.abs(near(1600)) < 0.2, `${near(1600).toFixed(3)} dB en 1,6 kHz`);
  check('atenuación > 40 dB en 300 Hz y 6 kHz', near(300) < -40 && near(6000) < -40, `${near(300).toFixed(1)} / ${near(6000).toFixed(1)} dB`);
  const gdIn = r.gd[Math.round((2500 / (fs / 2)) * 800)];
  check('retardo de grupo constante = (M−1)/2 = 50 muestras', Math.abs(gdIn - 50) < 1e-6, `${gdIn.toFixed(6)}`);
  const rect = freqResponse(firBandpass(101, 1000, 4000, fs, 'rect'), 800);
  const rip = Math.max(...Array.from(rect.magDb).slice(Math.round((1150 / 8000) * 800), Math.round((3850 / 8000) * 800)));
  check('ventana rectangular muestra rizado de Gibbs en la banda de paso', rip > 0.3, `rizado máx +${rip.toFixed(2)} dB`);
  const y = firFilter(d.taps, Float32Array.from({ length: 4000 }, (_, i) => Math.sin((2 * Math.PI * 2500 * i) / fs)));
  let a = 0;
  for (let i = 2000; i < 4000; i++) a = Math.max(a, Math.abs(y[i]));
  check('firFilter: 2,5 kHz sale con amplitud ≈ 1', Math.abs(a - 1) < 0.02, a.toFixed(4));
}

section('Raíces (ceros del FIR)');
{
  const roots = polyRoots([1, 0, -7, 6]).map((z) => z.re).sort((a, b) => a - b);
  check('raíces de z³ − 7z + 6 = {−3, 1, 2}', Math.abs(roots[0] + 3) < 1e-9 && Math.abs(roots[1] - 1) < 1e-9 && Math.abs(roots[2] - 2) < 1e-9, roots.map((v) => v.toFixed(6)).join(', '));
  const d = firBandpass(101, 1000, 4000, fs, 'hamming');
  const t0 = performance.now();
  const { zeros } = firZerosPoles(d);
  const ms = performance.now() - t0;
  let worst = 0;
  for (const z of zeros) {
    let pr = d.taps[0];
    let pi = 0;
    for (let k = 1; k < d.taps.length; k++) {
      const nr = pr * z.re - pi * z.im + d.taps[k];
      const ni = pr * z.im + pi * z.re;
      pr = nr;
      pi = ni;
    }
    worst = Math.max(worst, Math.hypot(pr, pi) / Math.max(1, Math.hypot(z.re, z.im) ** 100));
  }
  check('100 ceros del FIR encontrados (|P(z)| ≈ 0)', zeros.length === 100 && worst < 1e-8, `residuo máx ${worst.toExponential(2)}, ${ms.toFixed(0)} ms`);
}

section('Wavelets');
{
  let orth = 0;
  for (let k = 1; k < 4; k++) {
    let s = 0;
    for (let n = 0; n + 2 * k < 8; n++) s += DB4_LO[n] * DB4_LO[n + 2 * k];
    orth = Math.max(orth, Math.abs(s));
  }
  const norm = DB4_LO.reduce((s, v) => s + v * v, 0);
  check('db4 ortonormal (Σh² = 1, Σh[n]h[n+2k] = 0)', Math.abs(norm - 1) < 1e-10 && orth < 1e-10);
  check('db4 pasa-altos con media cero (Σg = 0)', Math.abs(DB4_HI.reduce((s, v) => s + v, 0)) < 1e-10);
  const x = synthWhistle(DEMO_PEOPLE.ana, { seed: 3 });
  const w = dwt(x, fs, 5);
  check('DWT conserva la energía (Parseval)', Math.abs(w.totalEnergy - w.signalEnergy) / w.signalEnergy < 1e-9, `${w.totalEnergy.toFixed(6)} vs ${w.signalEnergy.toFixed(6)}`);
  const top = [...w.bands].sort((a, b) => b.energy - a.energy)[0];
  check('energía del silbido (≈1,6–2,5 kHz) cae en D2/D3', top.name === 'D2' || top.name === 'D3', `${top.name}: ${Math.round(top.fLo)}–${Math.round(top.fHi)} Hz (${(top.share * 100).toFixed(1)} %)`);
  const s = Float32Array.from({ length: 16000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 2000 * i) / fs));
  const t0 = performance.now();
  const c = cwtMorlet(Float32Array.from({ length: 80000 }, (_, i) => s[i % 16000]), fs, { nScales: 64 });
  const ms = performance.now() - t0;
  const mid = Math.floor(c.cols / 2);
  let rmax = 0;
  for (let r = 0; r < c.rows; r++) if (c.data[mid * c.rows + r] > c.data[mid * c.rows + rmax]) rmax = r;
  check('CWT Morlet: máximo en ≈ 2 kHz con |W| ≈ 0,5', Math.abs(c.freqs[rmax] / 2000 - 1) < 0.04 && Math.abs(c.data[mid * c.rows + rmax] - 20 * Math.log10(0.5)) < 0.6, `${c.freqs[rmax].toFixed(0)} Hz, ${c.data[mid * c.rows + rmax].toFixed(2)} dB, ${ms.toFixed(0)} ms (5 s, 64 escalas)`);
}

section('STFT');
{
  const x = synthWhistle(DEMO_PEOPLE.ana, { seed: 5 });
  const t0 = performance.now();
  const S = stft(x, fs, { N: 512, overlap: 0.75 });
  check('dimensiones del espectrograma', S.cols === 1 + Math.floor((80000 - 512) / 128) && S.rows === 257, `${S.cols} tramas × ${S.rows} bins, ${(performance.now() - t0).toFixed(0)} ms`);
}

section('Seguimiento de tono');
{
  const tone = Float32Array.from({ length: 80000 }, (_, i) => (i > 16000 && i < 64000 ? 0.4 * Math.sin((2 * Math.PI * 1800 * i) / fs) : 0) + 0.002 * Math.sin(i * 12.9898));
  const a = analyzeSignal(tone, fs, butterBandpass(4, 1000, 4000, fs));
  check('tono puro de 1800 Hz', Math.abs(a.features.pitchHz - 1800) < 3, `${a.features.pitchHz.toFixed(2)} Hz (${noteName(a.features.pitchMidi)})`);
  check('duración detectada ≈ 3 s', Math.abs(a.features.durVoiced - 3) < 0.1, `${a.features.durVoiced.toFixed(2)} s, ${a.features.segments} segmento(s)`);
  const sub = Float32Array.from({ length: 80000 }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 900 * i) / fs) + 0.05 * Math.sin((2 * Math.PI * 1800 * i) / fs));
  const b = analyzeSignal(sub, fs, butterBandpass(4, 1000, 4000, fs));
  check('no confunde el 2º armónico con el fundamental (900 Hz bajo la banda)', Math.abs(b.features.pitchHz - 900) < 10, `${b.features.pitchHz.toFixed(1)} Hz`);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  const noise = Float32Array.from({ length: 80000 }, () => rnd() * 0.1);
  const c = analyzeSignal(noise, fs, butterBandpass(4, 1000, 4000, fs));
  check('ruido sin silbido → toma no válida', !c.features.valid, `${c.features.durVoiced.toFixed(2)} s con tono`);
}

section('DTW');
{
  const a = Float32Array.from({ length: 50 }, (_, i) => 90 + Math.sin(i / 5));
  check('DTW(a, a) = 0', dtw(a, a).distance === 0);
  const b = a.map((v) => v + 2);
  check('DTW(a, a + 2 st) = 2', Math.abs(dtw(a, b).distance - 2) < 1e-12);
  const slow = Float32Array.from({ length: 80 }, (_, i) => 90 + Math.sin(i / 8));
  check('DTW tolera cambios de tempo', dtw(a, slow).distance < 0.1, dtw(a, slow).distance.toFixed(4));
}

section('Perfil y verificación (silbidos sintéticos)');
{
  const design = butterBandpass(4, 1000, 4000, fs);
  const t0 = performance.now();
  const takes = [1, 2, 3, 4, 5].map((seed) => analyzeSignal(synthWhistle(DEMO_PEOPLE.ana, { seed }), fs, design));
  const perTake = (performance.now() - t0) / 5;
  const rank = rankTakes(takes);
  check('las 5 tomas de Ana son válidas', rank.validCount === 5, `análisis ${perTake.toFixed(0)} ms por toma`);
  console.log('    ranking:', rank.list.map((r) => `T${r.idx + 1}=${r.score}`).join('  '), '→ mejor T' + (rank.best + 1));
  const f = takes[0].features;
  check('las 5 notas de Ana se separan en 5 segmentos', takes.every((t) => t.features.segments === 5), takes.map((t) => t.features.segments).join(', '));
  console.log(`    huella T1: ${f.pitchHz.toFixed(0)} Hz (${noteName(f.pitchMidi)}), rango ${f.rangeSt.toFixed(1)} st, ${f.durVoiced.toFixed(2)} s, ${f.segments} segm., pureza ${(f.purity * 100).toFixed(0)} %, SNR ${f.snrDb.toFixed(1)} dB, jitter ${f.jitterCents.toFixed(1)} c`);
  const profile = buildProfile({ name: 'Ana', analyses: takes, filterCfg: { type: 'iir', fl: 1000, fh: 4000, order: 4 }, fs });
  console.log('    tolerancias:', Object.entries(profile.tolerances).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' '));
  for (const seed of [11, 12, 13, 14]) {
    const q = analyzeSignal(synthWhistle(DEMO_PEOPLE.ana, { seed }), fs, design);
    const r = compareToProfile(q, profile);
    check(`Ana (nueva toma ${seed}) es aceptada`, r.accepted, `D = ${r.D.toFixed(2)}, similitud ${r.similarity.toFixed(0)} %`);
  }
  for (const seed of [21, 22, 23]) {
    const q = analyzeSignal(synthWhistle(DEMO_PEOPLE.beto, { seed }), fs, design);
    const r = compareToProfile(q, profile);
    check(`Beto (toma ${seed}) es rechazado`, !r.accepted, `D = ${r.D.toFixed(2)}, similitud ${r.similarity.toFixed(1)} %`);
  }
  const imit = { ...DEMO_PEOPLE.ana, baseHz: DEMO_PEOPLE.ana.baseHz * 2 ** (2.5 / 12), breath: 0.08, vibratoCents: 35 };
  const q = analyzeSignal(synthWhistle(imit, { seed: 31 }), fs, design);
  const r = compareToProfile(q, profile);
  check('imitador (misma melodía, 2,5 st más agudo y con más soplido) es rechazado', !r.accepted, `D = ${r.D.toFixed(2)}, similitud ${r.similarity.toFixed(1)} %`);
  check('encabezado C para ESP32 generado', toCHeader(design).includes('SILBIDO_SOS[SILBIDO_NUM_SECCIONES][5]'));
  void hzToMidi;
}

section('Auto-sintonía del filtro');
{
  const DEF = { type: 'iir', fl: 1000, fh: 4000, order: 4, taps: 101, win: 'hamming' };
  for (const who of ['ana', 'beto']) {
    const takes = [1, 2, 3, 4, 5].map((seed) => synthWhistle(DEMO_PEOPLE[who], { seed }));
    const r = autoTuneFilter(takes, fs, DEF);
    const c = r.cfg;
    check(`${who}: elige un filtro`, r.status === 'ok' && c.auto && ['iir', 'fir'].includes(c.type), `${c.type.toUpperCase()} ${c.fl}–${c.fh} Hz`);
    check(`${who}: la banda cubre todo el rango silbado`, c.fl < r.survey.lo && c.fh > r.survey.hi, `rango ${r.survey.lo.toFixed(0)}–${r.survey.hi.toFixed(0)} Hz`);
    check(`${who}: comparó IIR contra FIR con tomas reales`, r.finalists.iir.valid === 5 && r.finalists.fir.valid === 5);
    check(`${who}: el elegido no corta el rango (caída en bordes < 1 dB)`, r.finalists[r.winner].metrics.edgeDb < 1);
    check(`${who}: es determinista`, JSON.stringify(autoTuneFilter(takes, fs, DEF).cfg) === JSON.stringify(c));
  }
  const noise = new Float32Array(5 * fs);
  for (let i = 0; i < noise.length; i++) noise[i] = (((i * 2654435761) >>> 0) / 4294967296 - 0.5) * 0.01;
  check('sin silbido mantiene el filtro provisional', autoTuneFilter([noise], fs, DEF).status === 'no-whistle');
  check('sin tomas no hace nada', autoTuneFilter([], fs, DEF).status === 'empty');
}

section('Inteligencia (red neuronal propia)');
{
  const DEF = { type: 'iir', fl: 1000, fh: 4000, order: 4, taps: 101, win: 'hamming' };
  const mk = (person, base) => {
    const takes = [1, 2, 3, 4, 5].map((i) => synthWhistle(person, { seed: base + i }));
    const t = autoTuneFilter(takes, fs, DEF);
    return { ...buildProfile({ name: person.name, analyses: t.analyses, filterCfg: t.cfg, fs }), id: person.name, createdAt: 'x' };
  };
  const ana = mk(DEMO_PEOPLE.ana, 100);
  const beto = mk(DEMO_PEOPLE.beto, 200);
  const m = trainModel([ana, beto]);
  check('la red se entrena y reconoce las tomas reales de los perfiles', m.refAccuracy === 1, `${m.arch}, ${m.samples} ejemplos, ${m.ms.toFixed(0)} ms`);
  check('el entrenamiento es determinista', JSON.stringify(trainModel([ana, beto]).history) === JSON.stringify(m.history));
  const probOf = (x, p, k) => predict(m, analyzeSignal(x, fs, designFilter(p.filter, fs))).probs[k];
  const thr = aiThreshold(1);
  for (const seed of [11, 12, 13]) check(`IA: Ana (toma ${seed}) es Ana`, probOf(synthWhistle(DEMO_PEOPLE.ana, { seed }), ana, 0) >= thr);
  for (const seed of [21, 22]) check(`IA: Beto (toma ${seed}) es Beto`, probOf(synthWhistle(DEMO_PEOPLE.beto, { seed }), beto, 1) >= thr);
  for (const seed of [21, 22]) check(`IA: Beto (toma ${seed}) no es Ana`, probOf(synthWhistle(DEMO_PEOPLE.beto, { seed }), ana, 0) < thr);
  const imit = { ...DEMO_PEOPLE.ana, baseHz: DEMO_PEOPLE.ana.baseHz * 2 ** (2.5 / 12), breath: 0.08, vibratoCents: 35 };
  for (const seed of [31, 32]) {
    const p = probOf(synthWhistle(imit, { seed }), ana, 0);
    check(`IA: el imitador (toma ${seed}) es rechazado`, p < thr, `${(p * 100).toFixed(1)} %`);
  }
  const ex = explain(m, analyzeSignal(synthWhistle(DEMO_PEOPLE.ana, { seed: 11 }), fs, designFilter(ana.filter, fs)), 0);
  check('la explicación reparte el 100 % entre los datos', Math.abs(ex.reduce((s, g) => s + Math.abs(g.contribution), 0) - 1) < 1e-9);
  check('un solo perfil también entrena (perfil vs desconocido)', trainModel([ana]).refAccuracy === 1);
}

section('Audios largos');
{
  const x = new Float32Array(16000 * 12.3);
  const parts = splitTakes(x, fs, 5);
  check('un audio de 12,3 s se parte en 3 tomas de 5 s', parts.length === 3 && parts.every((p) => p.length === 80000));
  check('un trozo final de menos de 1,5 s se descarta', splitTakes(new Float32Array(16000 * 6), fs, 5).length === 1);
  check('nunca más tomas que las pedidas', splitTakes(new Float32Array(16000 * 40), fs, 5, 2).length === 2);
}

section('ESP32 por USB (tramas)');
{
  const frame = (seq, vals, status = 0, corrupt = false) => {
    const n = vals.length;
    const b = new Uint8Array(6 + 2 * n);
    b.set([0xa5, 0x5a, seq & 0xff, n, status]);
    const dv = new DataView(b.buffer);
    vals.forEach((v, k) => dv.setInt16(5 + 2 * k, v, true));
    let chk = 0;
    for (let k = 0; k < 2 * n; k++) chk = (chk + b[5 + k]) & 0xff;
    b[5 + 2 * n] = corrupt ? (chk + 1) & 0xff : chk;
    return b;
  };
  const got = [];
  const lines = [];
  const P = new FrameParser({ onSamples: (x) => got.push(...x), onLine: (l) => lines.push(l) });
  const vals = Array.from({ length: 160 }, (_, i) => Math.round(10000 * Math.sin(i / 5)));
  const text = new TextEncoder().encode('{"dispositivo":"silbido-id","fs":16000}\n');
  const stream = [text, frame(0, vals), new Uint8Array([1, 2, 3, 0xa5, 9]), frame(1, vals, 1), frame(2, vals, 0, true), frame(4, vals)];
  const all = new Uint8Array(stream.reduce((s, b) => s + b.length, 0));
  let o = 0;
  for (const b of stream) {
    all.set(b, o);
    o += b.length;
  }
  for (let i = 0; i < all.length; i += 37) P.push(all.subarray(i, i + 37)); // llega en pedazos de cualquier tamaño
  check('lee la línea JSON de información', lines[0] && JSON.parse(lines[0]).fs === 16000);
  check('recupera 3 tramas válidas aunque lleguen partidas y con basura', P.stats.frames === 3 && got.length === 480);
  check('descarta la trama con suma de verificación mala', P.stats.bad >= 1);
  check('cuenta las tramas perdidas por número de secuencia', P.stats.lost === 2, `${P.stats.lost}`);
  check('las muestras llegan exactas (int16 / 32768)', Math.abs(got[7] - vals[7] / 32768) < 1e-9 && P.stats.clipped === 1);
}

section('Exportación ESP32');
{
  const DEF = { type: 'iir', fl: 1000, fh: 4000, order: 4, taps: 101, win: 'hamming' };
  const takes = [1, 2, 3, 4, 5].map((seed) => synthWhistle(DEMO_PEOPLE.beto, { seed: 200 + seed }));
  const tuned = autoTuneFilter(takes, fs, DEF);
  const p = buildProfile({ name: 'Beto "demo"', analyses: tuned.analyses, filterCfg: tuned.cfg, fs });
  const h = profilesToHeader([p], fs);
  check('perfil.h declara PERFILES y NUM_PERFILES', h.includes('silbido::PerfilDef PERFILES[]') && h.includes('NUM_PERFILES'));
  check('perfil.h escapa el nombre', h.includes('"Beto \\"demo\\""'));
  check('perfil.h incluye las 3 referencias', /P0_REF2\[\d+\]/.test(h));
  const t = testAudioHeader(takes[0], [p], { fs });
  check('prueba_audio.h trae 80000 muestras y el valor esperado', t.includes('PRUEBA_AUDIO[80000]') && t.includes('PRUEBA_ESPERADO[]'));
}

console.log(`\n${passes} pruebas correctas, ${fails} fallidas`);
process.exit(fails ? 1 : 0);
