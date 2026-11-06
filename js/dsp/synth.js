/**
 * Silbidos sintéticos para probar la web sin micrófono.
 * Cada "persona" tiene su melodía, tono base, vibrato y cantidad de soplido (ruido de aire).
 * Se añade ruido de fondo y zumbido de la red eléctrica (60 Hz y armónicos) para que se vea
 * el efecto del filtro pasa-banda.
 */

function mulberry32(seed) {
  let s = seed >>> 0;
  return function rand() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussFactory(rand) {
  return () => {
    const u = Math.max(rand(), 1e-12);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

export const DEMO_PEOPLE = {
  ana: {
    name: 'Ana (demo)',
    baseHz: 1650,
    // [semitonos respecto al tono base, duración en s]
    notes: [
      [0, 0.32],
      [4, 0.32],
      [7, 0.45],
      [4, 0.28],
      [0, 0.55],
    ],
    gap: 0.07,
    start: 0.9,
    vibratoHz: 5.5,
    vibratoCents: 18,
    breath: 0.03,
  },
  beto: {
    name: 'Beto (demo)',
    baseHz: 1250,
    notes: [
      [0, 0.5],
      [-2, 0.3],
      [3, 0.3],
      [5, 0.7],
    ],
    gap: 0.1,
    start: 1.1,
    vibratoHz: 4.2,
    vibratoCents: 35,
    breath: 0.09,
  },
};

export function synthWhistle(person, { fs = 16000, dur = 5, seed = 1, variation = 1 } = {}) {
  const rand = mulberry32(seed * 7919 + 13);
  const gauss = gaussFactory(rand);
  const n = Math.round(fs * dur);
  const x = new Float32Array(n);

  const transpose = gauss() * 0.15 * variation;
  const tempo = 1 + gauss() * 0.05 * variation;
  let t = person.start + gauss() * 0.12 * variation;
  const sched = [];
  for (const [st, d] of person.notes) {
    const dd = d * tempo * (1 + gauss() * 0.04 * variation);
    sched.push({ t0: t, t1: t + dd, st: st + transpose + gauss() * 0.05 * variation });
    t += dd + person.gap * tempo;
  }

  const attack = 0.015;
  const release = 0.025;
  const glide = 0.03;
  const amp = 0.32 * (1 + gauss() * 0.08 * variation);
  let phase = 0;
  let k = 0;
  let prevSt = sched[0].st;
  let hpY = 0;
  let hpX = 0;
  for (let i = 0; i < n; i++) {
    const ti = i / fs;
    while (k < sched.length - 1 && ti >= sched[k].t1 + person.gap * tempo * 0.5) {
      prevSt = sched[k].st;
      k++;
    }
    const note = sched[k];
    let env = 0;
    if (ti >= note.t0 && ti <= note.t1) {
      env = Math.min(1, (ti - note.t0) / attack, (note.t1 - ti) / release);
    }
    const g = Math.min(1, Math.max(0, (ti - note.t0) / glide));
    const st = prevSt + (note.st - prevSt) * g;
    const vib = (person.vibratoCents / 1200) * Math.sin(2 * Math.PI * person.vibratoHz * ti);
    const f = person.baseHz * 2 ** (st / 12 + vib);
    phase += (2 * Math.PI * f) / fs;
    if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    // ruido de soplido (pasa-altos de 1er orden sobre ruido blanco)
    const wn = gauss();
    hpY = 0.9 * (hpY + wn - hpX);
    hpX = wn;
    const tone = Math.sin(phase) + 0.06 * Math.sin(2 * phase);
    x[i] = amp * env * (tone + person.breath * 4 * hpY);
  }

  // Fondo: zumbido de 60 Hz + armónicos, retumbo grave y ruido blanco
  const humPhase = rand() * 2 * Math.PI;
  for (let i = 0; i < n; i++) {
    const ti = i / fs;
    x[i] +=
      0.03 * Math.sin(2 * Math.PI * 60 * ti + humPhase) +
      0.015 * Math.sin(2 * Math.PI * 120 * ti + 1 + humPhase) +
      0.008 * Math.sin(2 * Math.PI * 180 * ti + 2) +
      0.012 * Math.sin(2 * Math.PI * 7 * ti) +
      0.004 * gauss();
  }
  return x;
}
