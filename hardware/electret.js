/**
 * Circuito con micrófono comercial (módulo de sonido + LM358): esquemático y montaje en baquela.
 * El montaje se dibuja a partir de electret-layout.js, que el validador revisa.
 */
import { icons, download } from '../js/util.js';
import { BOARD, NETS, PARTS, TRACES, JUMPERS, holesOf, validate } from './electret-layout.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const COLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const pos = (x, y) => `${COLS[x]}${y + 1}`;

/* ---------- resaltado de redes ---------- */
let pinned = null;
const listeners = [];
const setActive = (id) => listeners.forEach((f) => f(id));
function bindHover(el, id) {
  el.addEventListener('pointerenter', () => setActive(id));
  el.addEventListener('pointerleave', () => setActive(pinned));
  el.addEventListener('click', () => {
    pinned = pinned === id ? null : id;
    setActive(pinned);
  });
}

/* ---------- tema y navegación ---------- */
function initChrome() {
  for (const el of $$('[data-icon]')) el.innerHTML = icons[el.dataset.icon] || '';
  const btn = $('#theme-btn');
  let mode = 'auto';
  try {
    mode = localStorage.getItem('silbido-id:theme') || 'auto';
  } catch {
    /* sin almacenamiento */
  }
  const apply = () => {
    if (mode === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = mode;
    btn.innerHTML = mode === 'dark' ? icons.moon : mode === 'light' ? icons.sun : icons.auto;
  };
  apply();
  btn.addEventListener('click', () => {
    mode = mode === 'auto' ? 'light' : mode === 'light' ? 'dark' : 'auto';
    try {
      if (mode === 'auto') localStorage.removeItem('silbido-id:theme');
      else localStorage.setItem('silbido-id:theme', mode);
    } catch {
      /* sin almacenamiento */
    }
    apply();
  });
  const tabs = $$('.tabs button[data-go]');
  for (const b of tabs) b.addEventListener('click', () => document.getElementById(b.dataset.go).scrollIntoView({ behavior: 'smooth', block: 'start' }));
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) for (const b of tabs) b.setAttribute('aria-selected', String(b.dataset.go === e.target.id));
    },
    { rootMargin: '-35% 0px -55% 0px' },
  );
  for (const b of tabs) io.observe(document.getElementById(b.dataset.go));
}

/* ---------- chips de redes ---------- */
const SHOWN = ['V5', 'V33', 'VA', 'GND', 'AO', 'IN', 'OUT', 'VREF', 'VDIV', 'ADC'];
function buildChips() {
  for (const host of $$('.net-chips')) {
    host.innerHTML = SHOWN.map((id) => `<button type="button" class="net-chip" data-net="${id}" style="--c:${NETS[id].color}"><i></i>${NETS[id].label}</button>`).join('');
    for (const c of $$('.net-chip', host)) bindHover(c, c.dataset.net);
  }
  listeners.push((id) => {
    for (const c of $$('.net-chip')) c.classList.toggle('active', c.dataset.net === id);
  });
}

/* =============== esquemático =============== */
const W = (net, d) => `<path class="w" data-net="${net}" style="--c:${NETS[net].color}" d="${d}"/>`;
const dot = (x, y) => `<circle class="dot" cx="${x}" cy="${y}" r="3.6"/>`;
const gnd = (x, y) =>
  `<path class="sym" d="M${x} ${y}V${y + 10}M${x - 11} ${y + 10}H${x + 11}M${x - 7} ${y + 16}H${x + 7}M${x - 3} ${y + 22}H${x + 3}"/>`;
/** Etiqueta de red (bandera) que apunta hacia la derecha a partir de (x, y). */
const flag = (x, y, net, text) => {
  const w = text.length * 7 + 18;
  return `<g class="flag" data-net="${net}" style="--c:${NETS[net].color}"><path d="M${x} ${y - 10}H${x + w - 9}L${x + w} ${y}L${x + w - 9} ${y + 10}H${x}Z"/><text x="${x + (w - 9) / 2}" y="${y + 4}" text-anchor="middle">${text}</text></g>`;
};
const resH = (x1, x2, y, name, val) => {
  const m = (x1 + x2) / 2;
  return `<path class="sym" d="M${x1} ${y}H${m - 26}M${m + 26} ${y}H${x2}"/><rect class="sym body" x="${m - 26}" y="${y - 8}" width="52" height="16" rx="2"/><text class="t-sm" x="${m}" y="${y - 14}" text-anchor="middle">${name} · ${val}</text>`;
};
const resV = (x, y1, y2, name, val, side = 'l') => {
  const m = (y1 + y2) / 2;
  return `<path class="sym" d="M${x} ${y1}V${m - 24}M${x} ${m + 24}V${y2}"/><rect class="sym body" x="${x - 8}" y="${m - 24}" width="16" height="48" rx="2"/><text class="t-sm" x="${x + (side === 'l' ? -14 : 14)}" y="${m - 2}" text-anchor="${side === 'l' ? 'end' : 'start'}">${name}</text><text class="t-sm" x="${x + (side === 'l' ? -14 : 14)}" y="${m + 12}" text-anchor="${side === 'l' ? 'end' : 'start'}">${val}</text>`;
};
const capH = (x1, x2, y, name, val) => {
  const m = (x1 + x2) / 2;
  return `<path class="sym" d="M${x1} ${y}H${m - 5}M${m + 5} ${y}H${x2}M${m - 5} ${y - 12}V${y + 12}M${m + 5} ${y - 12}V${y + 12}"/><text class="t-sm" x="${m}" y="${y - 17}" text-anchor="middle">${name} · ${val}</text>`;
};
const capV = (x, y1, y2, name, val, polar = false) => {
  const m = (y1 + y2) / 2;
  const plate2 = polar ? `<path class="sym" d="M${x - 12} ${m + 7}Q${x} ${m + 2} ${x + 12} ${m + 7}"/>` : `<path class="sym" d="M${x - 12} ${m + 5}H${x + 12}"/>`;
  return `<path class="sym" d="M${x} ${y1}V${m - 5}M${x} ${m + (polar ? 4 : 5)}V${y2}M${x - 12} ${m - 5}H${x + 12}"/>${plate2}${polar ? `<text class="t-sm" x="${x - 22}" y="${m - 6}">+</text>` : ''}<text class="t-sm" x="${x + 17}" y="${m - 1}">${name}</text><text class="t-sm" x="${x + 17}" y="${m + 13}">${val}</text>`;
};
/** Amplificador operacional: entrada − en y−25, + en y+25, salida en (x+100, y). */
const opamp = (x, y, name, pins, top = false) => `<path class="sym body" d="M${x} ${y - 50}V${y + 50}L${x + 100} ${y}Z"/>
  <text class="t" x="${x + 9}" y="${y - 20}">−</text><text class="t" x="${x + 9}" y="${y + 30}">+</text>
  <text class="t-sm" x="${x - 5}" y="${y - 29}" text-anchor="end">${pins[0]}</text><text class="t-sm" x="${x - 5}" y="${y + 21}" text-anchor="end">${pins[1]}</text>
  <text class="t-sm" x="${x + 104}" y="${y - 6}">${pins[2]}</text>
  <text class="t-sm" x="${top ? x + 40 : x + 64}" y="${top ? y - 78 : y + 68}" text-anchor="middle">${name}</text>`;

function schematicBody() {
  return `
  <!-- módulo de sonido -->
  <rect class="box" x="30" y="330" width="150" height="190" rx="10"/>
  <text class="t-lg" x="44" y="358">Módulo de sonido</text>
  <text class="t-sm" x="44" y="376">micrófono electret</text>
  <circle cx="72" cy="460" r="20" class="sym"/><circle cx="72" cy="460" r="7" class="dot"/>
  <text class="pin" x="170" y="414" text-anchor="end">VCC</text>
  <text class="pin" x="170" y="439" text-anchor="end">AO</text>
  <text class="pin" x="170" y="489" text-anchor="end">GND</text>
  <text class="t-sm" x="44" y="508">DO: sin conectar</text>
  ${W('VA', 'M180 410H196')}${flag(196, 410, 'VA', 'VA')}
  ${W('GND', 'M180 485H205')}${gnd(205, 485)}

  <!-- fuente filtrada y referencia de 1,65 V -->
  ${flag(30, 90, 'V33', '3V3')}
  ${W('V33', 'M76 90H110')}${resH(110, 190, 90, 'R1', '100 Ω')}
  ${W('VA', 'M190 90H330')}${dot(205, 90)}${dot(258, 90)}
  ${W('VA', 'M205 90V122')}${capV(205, 122, 168, 'C1', '100 µF', true)}${gnd(205, 168)}
  ${W('VA', 'M258 90V122')}${capV(258, 122, 168, 'C4', '150 nF')}${gnd(258, 168)}
  <text class="t-sm" x="200" y="68">VA = 3,3 V filtrado</text>
  ${W('VA', 'M330 90V112')}${resV(330, 112, 178, 'R3', '10 kΩ', 'r')}
  ${W('VDIV', 'M330 178V250')}${dot(330, 205)}${resV(330, 250, 316, 'R4', '10 kΩ', 'r')}${gnd(330, 316)}
  ${W('VDIV', 'M330 205H400V232')}${capV(400, 232, 278, 'C5', '10 µF', true)}${gnd(400, 278)}
  ${W('VDIV', 'M400 205H440V215H470')}${dot(400, 205)}
  ${opamp(470, 190, 'U1B · seguidor (búfer de VREF)', ['6', '5', '7'], true)}
  ${W('VREF', 'M470 165H450V120H610V190')}${W('VREF', 'M570 190H660')}${dot(610, 190)}
  ${flag(660, 190, 'VREF', 'VREF 1,65 V')}

  <!-- amplificador con filtro pasa-banda -->
  ${W('AO', 'M180 435H245')}${capH(245, 290, 435, 'C2', '47 nF')}
  ${W('N1', 'M290 435H300')}${resH(300, 390, 435, 'R2', '10 kΩ')}
  ${W('IN', 'M390 435H470')}${dot(420, 435)}
  ${W('IN', 'M420 435V340M420 380H460M420 340H495')}
  ${resH(460, 590, 380, 'R5', '470 kΩ')}
  ${capH(495, 555, 340, 'C6', '47 pF')}
  ${W('OUT', 'M555 340H640V460M590 380H640')}${dot(640, 380)}${dot(640, 460)}
  ${opamp(470, 460, 'U1A · amplificador ×47', ['2', '3', '1'])}
  ${W('VREF', 'M470 485H440V530')}${flag(440, 540, 'VREF', 'VREF')}
  ${W('OUT', 'M570 460H680')}${resH(680, 770, 460, 'R6', '1 kΩ')}${W('ADC', 'M770 460H900')}
  ${W('V5', 'M520 435V420')}<text class="t-sm" x="527" y="431">8</text>${flag(507, 410, 'V5', '5V')}
  ${W('GND', 'M520 485V500')}<text class="t-sm" x="527" y="497">4</text>${gnd(520, 500)}

  <!-- alimentación del LM358 -->
  ${flag(684, 120, 'V5', '5V')}${W('V5', 'M720 120H900')}${dot(760, 120)}${dot(820, 120)}
  ${W('V5', 'M760 120V150')}${capV(760, 150, 196, 'C7', '10 µF', true)}${gnd(760, 196)}
  ${W('V5', 'M820 120V150')}${capV(820, 150, 196, 'C3', '150 nF')}${gnd(820, 196)}
  ${flag(830, 250, 'V33', '3V3')}${W('V33', 'M876 250H900')}
  ${W('GND', 'M900 520H870V530')}${gnd(870, 530)}

  <!-- ESP32 -->
  <rect class="box" x="900" y="80" width="170" height="480" rx="10"/>
  <text class="t-lg" x="916" y="104">ESP32</text>
  <text class="pin" x="912" y="124">VIN (5 V)</text>
  <text class="pin" x="912" y="254">3V3</text>
  <text class="pin" x="912" y="464">GPIO34</text><text class="t-sm" x="912" y="480">ADC1 · canal 6</text>
  <text class="pin" x="912" y="524">GND</text>

  <!-- cálculos -->
  <rect class="box" x="30" y="572" width="1040" height="52" rx="8" style="stroke-width:1.2"/>
  <text class="t" x="46" y="594">Ganancia = −R5/R2 = −470 kΩ / 10 kΩ = −47 (33 dB)</text>
  <text class="t" x="420" y="594">f<tspan baseline-shift="sub" font-size="9">L</tspan> = 1/(2π·R2·C2) ≈ 339 Hz</text>
  <text class="t" x="680" y="594">f<tspan baseline-shift="sub" font-size="9">H</tspan> = 1/(2π·R5·C6) ≈ 7,2 kHz</text>
  <text class="t-sm" x="46" y="612">La salida queda centrada en 1,65 V (mitad del ADC). El filtrado fino lo hace la ESP32 en digital (ADC a 64 kHz → diezmado a 16 kHz → pasa-banda).</text>`;
}

const SCH_VIEW = '0 0 1100 640';
const SCH_PRINT_STYLE = `<style>text{font-family:Segoe UI,Arial,sans-serif}.bg{fill:#fff}.box{fill:#f8fafc;stroke:#475569;stroke-width:2}
.t{fill:#0f172a;font:600 13px sans-serif}.t-lg{fill:#0f172a;font:700 16px sans-serif}.t-sm{fill:#475569;font:500 11px sans-serif}.pin{fill:#0f172a;font:600 12.5px sans-serif}
.sym{fill:none;stroke:#334155;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.sym.body{fill:#fff}.dot{fill:#0f172a}
.w{fill:none;stroke:var(--c);stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}.flag path{fill:#fff;stroke:var(--c);stroke-width:2}.flag text{fill:#0f172a;font:700 11px sans-serif}</style>`;

function buildSchematic() {
  const host = $('#sch-host');
  host.innerHTML = `<svg class="sch esch" viewBox="${SCH_VIEW}" role="img" aria-label="Esquemático: módulo de sonido, amplificador LM358 con filtro y ESP32">${schematicBody()}</svg>`;
  const svg = $('svg', host);
  for (const el of $$('[data-net]', svg)) bindHover(el, el.dataset.net);
  listeners.push((id) => {
    svg.classList.toggle('has-active', !!id);
    for (const el of $$('[data-net]', svg)) el.classList.toggle('active', el.dataset.net === id);
  });
  $('#sch-dl').addEventListener('click', () => {
    const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${SCH_VIEW}" width="1650" height="960">${SCH_PRINT_STYLE}<rect class="bg" width="1100" height="640"/>${schematicBody()}</svg>`;
    download('esquematico-microfono-lm358.svg', out, 'image/svg+xml');
  });
}

/* =============== baquela =============== */
const P = 34; // píxeles por agujero (2,54 mm)
const M = 46; // margen vertical para las coordenadas
const MX = 130; // margen horizontal (deja sitio a los nombres de J1 y J2)
const bx = (x, mirror) => MX + (mirror ? BOARD.cols - 1 - x : x) * P;
const by = (y) => M + y * P;

function partBody(p, mirror) {
  const [a, b] = p.pads;
  const X = (x) => bx(x, mirror);
  if (p.type === 'res' || p.type === 'cap') {
    const x1 = X(a[0]);
    const y1 = by(a[1]);
    const x2 = X(b[0]);
    const y2 = by(b[1]);
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const horiz = y1 === y2;
    const len = Math.hypot(x2 - x1, y2 - y1);
    const ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    const body =
      p.type === 'res'
        ? `<rect x="${-26}" y="-8" width="52" height="16" rx="7" class="res-body"/>${[-14, -6, 2].map((o) => `<rect x="${o}" y="-8" width="4" height="16" class="band"/>`).join('')}`
        : p.value.includes('pF') || p.value.includes('150')
          ? `<ellipse cx="0" cy="0" rx="${Math.min(15, len / 2 - 3)}" ry="9" class="cer-body"/>`
          : `<rect x="${-Math.min(16, len / 2 - 2)}" y="-8" width="${2 * Math.min(16, len / 2 - 2)}" height="16" rx="3" class="mylar-body"/>`;
    return `<g class="part" data-part="${p.id}">
      <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="lead"/>
      <g transform="translate(${mx} ${my}) rotate(${ang})">${body}</g>
      ${(() => {
        const where = p.lbl || (horiz ? 't' : 'r');
        const lx = where === 'l' ? mx - 18 : where === 'r' ? mx + 18 : mx;
        const ly = where === 't' ? my - 14 : where === 'b' ? Math.max(y1, y2) + 22 : my + 4;
        const anchor = where === 'l' ? 'end' : where === 'r' ? 'start' : 'middle';
        return `<text x="${lx}" y="${ly}" class="pl" text-anchor="${anchor}">${p.id} ${p.value}</text>`;
      })()}</g>`;
  }
  if (p.type === 'ecap') {
    const cx = (X(a[0]) + X(b[0])) / 2;
    const cy = (by(a[1]) + by(b[1])) / 2;
    return `<g class="part" data-part="${p.id}"><circle cx="${cx}" cy="${cy}" r="${p.value === '100 µF' ? 21 : 17}" class="ecap-body"/>
      <path d="M${cx + (p.value === '100 µF' ? 9 : 7)} ${cy - 15}A ${p.value === '100 µF' ? 21 : 17} ${p.value === '100 µF' ? 21 : 17} 0 0 1 ${cx + (p.value === '100 µF' ? 9 : 7)} ${cy + 15}" class="ecap-stripe"/>
      <text x="${X(a[0]) - 10}" y="${by(a[1]) + 4}" class="plus" text-anchor="middle">+</text>
      <text x="${cx + 24}" y="${cy + 4}" class="pl">${p.id} ${p.value}</text></g>`;
  }
  if (p.type === 'dip8') {
    const xs = p.pads.map((q) => X(q[0]));
    const ys = p.pads.map((q) => by(q[1]));
    const x0 = Math.min(...xs) - 16;
    const x1 = Math.max(...xs) + 16;
    const y0 = Math.min(...ys) - 12;
    const y1 = Math.max(...ys) + 12;
    const notchX = mirror ? x1 : x0;
    return `<g class="part" data-part="U1"><rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="4" class="dip-body"/>
      <path d="M${notchX} ${(y0 + y1) / 2 - 9}a9 9 0 0 ${mirror ? 0 : 1} 0 18" class="notch"/>
      <text x="${(x0 + x1) / 2}" y="${(y0 + y1) / 2 + 5}" class="dip-txt" text-anchor="middle">LM358</text>
      ${p.pads.map((q) => `<text x="${X(q[0])}" y="${by(q[1]) + (q[1] === Math.max(...p.pads.map((r) => r[1])) ? 22 : -14)}" class="pn" text-anchor="middle">${q[3]}</text>`).join('')}</g>`;
  }
  if (p.type === 'header') {
    const right = p.pads[0][0] > BOARD.cols / 2;
    const side = mirror ? !right : right;
    return `<g class="part" data-part="${p.id}">${p.pads
      .map(
        (q) =>
          `<rect x="${X(q[0]) - 12}" y="${by(q[1]) - 12}" width="24" height="24" rx="3" class="hdr"/><text x="${X(q[0]) + (side ? 22 : -50)}" y="${by(q[1]) + 4}" class="hl" text-anchor="${side ? 'start' : 'end'}">${q[3]}</text>`,
      )
      .join('')}<text x="${X(p.pads[0][0]) + (side ? 22 : -50)}" y="${by(p.pads[0][1]) - 22}" class="pl strong" text-anchor="${side ? 'start' : 'end'}">${p.id} · ${p.value}</text></g>`;
  }
  return '';
}

function boardSvg(side) {
  const mirror = side === 'bottom';
  const w = MX * 2 + (BOARD.cols - 1) * P;
  const h = M * 2 + (BOARD.rows - 1) * P;
  const parts = [];
  parts.push(`<rect x="${MX - 26}" y="${M - 26}" width="${(BOARD.cols - 1) * P + 52}" height="${(BOARD.rows - 1) * P + 52}" rx="10" class="pcb"/>`);
  // coordenadas
  for (let x = 0; x < BOARD.cols; x++) parts.push(`<text x="${bx(x, mirror)}" y="${M - 32}" class="coord" text-anchor="middle">${COLS[x]}</text>`);
  for (let y = 0; y < BOARD.rows; y++) parts.push(`<text x="${MX - 34}" y="${by(y) + 4}" class="coord" text-anchor="middle">${y + 1}</text>`);
  // pistas (lado de cobre)
  const traceLayer = TRACES.map((t) => {
    const d = t.pts.map((p2, i) => `${i ? 'L' : 'M'}${bx(p2[0], mirror)} ${by(p2[1])}`).join('');
    return `<path d="${d}" class="trace" data-net="${t.net}" style="--c:${NETS[t.net].color}"/>`;
  });
  const viaLayer = JUMPERS.flatMap((j) =>
    (j.via || []).length > 1 ? [`<path d="${j.via.map((p2, i) => `${i ? 'L' : 'M'}${bx(p2[0], mirror)} ${by(p2[1])}`).join('')}" class="trace" data-net="${j.net}" style="--c:${NETS[j.net].color}"/>`] : [],
  );
  // agujeros
  const used = new Set();
  for (const p of PARTS) for (const q of p.pads) used.add(`${q[0]},${q[1]}`);
  for (const t of TRACES) for (let i = 1; i < t.pts.length; i++) for (const [x, y] of holesOf(t.pts[i - 1], t.pts[i])) used.add(`${x},${y}`);
  const holes = [];
  for (let y = 0; y < BOARD.rows; y++)
    for (let x = 0; x < BOARD.cols; x++) holes.push(`<circle cx="${bx(x, mirror)}" cy="${by(y)}" r="8" class="pad${used.has(`${x},${y}`) ? ' used' : ''}"/><circle cx="${bx(x, mirror)}" cy="${by(y)}" r="3.2" class="hole"/>`);
  if (mirror) {
    parts.push(holes.join(''), traceLayer.join(''), viaLayer.join(''));
    // puntos de soldadura de las patas
    for (const p of PARTS) for (const q of p.pads) parts.push(`<circle cx="${bx(q[0], true)}" cy="${by(q[1])}" r="7.5" class="solder" data-net="${q[2]}" style="--c:${NETS[q[2]].color}"/>`);
    for (const j of JUMPERS) for (const e of [j.a, j.b]) parts.push(`<circle cx="${bx(e[0], true)}" cy="${by(e[1])}" r="7.5" class="solder" data-net="${j.net}" style="--c:${NETS[j.net].color}"/>`);
  } else {
    parts.push(holes.join(''));
    parts.push(`<g class="ghost">${traceLayer.join('')}${viaLayer.join('')}</g>`);
    for (const p of PARTS) parts.push(partBody(p, false));
    for (const j of JUMPERS) {
      const x1 = bx(j.a[0], false);
      const y1 = by(j.a[1]);
      const x2 = bx(j.b[0], false);
      const y2 = by(j.b[1]);
      parts.push(`<path d="M${x1} ${y1}C${x1} ${y1 - 26} ${x2} ${y2 - 26} ${x2} ${y2}" class="jumper" data-net="${j.net}" style="--c:${NETS[j.net].color}"/><text x="${(x1 + x2) / 2}" y="${y1 - 24}" class="pl" text-anchor="middle">puente (cable aislado)</text>`);
    }
  }
  return `<svg class="board ${side}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${mirror ? 'Lado de soldadura (visto desde abajo)' : 'Lado de componentes (visto desde arriba)'}">${parts.join('')}</svg>`;
}

function buildBoard() {
  const errors = validate();
  const host = $('#board-host');
  let side = 'top';
  const render = () => {
    host.innerHTML = boardSvg(side);
    const svg = $('svg', host);
    for (const el of $$('[data-net]', svg)) bindHover(el, el.dataset.net);
  };
  render();
  for (const b of $$('#board-side button')) {
    b.addEventListener('click', () => {
      side = b.dataset.side;
      for (const x of $$('#board-side button')) x.setAttribute('aria-pressed', String(x === b));
      $('#board-note').innerHTML =
        side === 'top'
          ? 'Vista desde arriba, el lado donde van los componentes. Las líneas tenues son las pistas que van por debajo.'
          : 'Vista desde abajo, el lado de soldadura, <b>en espejo</b>: la columna A queda a la derecha. Cada línea de color es una pista hecha con estaño o con un alambre desnudo soldado.';
      render();
      setActive(pinned);
    });
  }
  listeners.push((id) => {
    const svg = $('svg', host);
    svg.classList.toggle('has-active', !!id);
    for (const el of $$('[data-net]', svg)) el.classList.toggle('active', el.dataset.net === id);
  });
  $('#board-check').innerHTML = errors.length
    ? `<span class="status critical">${errors.length} errores</span> ${errors.join(' · ')}`
    : `<span class="status good">${icons.check}Validado</span> Ningún agujero tiene dos señales y todas las conexiones del esquemático están unidas.`;
  // tabla de posiciones
  $('#pos-table tbody').innerHTML = PARTS.map(
    (p) =>
      `<tr><td><b>${p.id}</b></td><td>${p.type === 'dip8' ? 'LM358 (en zócalo)' : p.type === 'header' ? p.value : p.value}</td><td>${p.pads
        .map((q) => `${pos(q[0], q[1])}${q[3] && p.type !== 'res' && p.type !== 'cap' ? ` <small>(${q[3]})</small>` : p.type === 'ecap' && q === p.pads[0] ? ' <small>(+)</small>' : ''}`)
        .join(' · ')}</td></tr>`,
  ).join('');
}

function init() {
  initChrome();
  buildChips();
  buildSchematic();
  buildBoard();
}
init();
