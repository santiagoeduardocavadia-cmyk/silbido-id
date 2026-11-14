/**
 * Página de hardware: esquemático SVG, vista 3D (three.js), tabla de conexiones, materiales y montaje.
 * Todo sale de un solo modelo de datos (NETS), así que esquemático, 3D y tabla siempre coinciden.
 */
import { icons, download } from '../js/util.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* =============== modelo de datos =============== */
// `ui` = color en la interfaz, `c3d` = color real del cable en la vista 3D
const NETS = [
  { id: 'vdd', name: 'Alimentación', mic: 'VDD', esp: '3V3', ui: '#ef4444', c3d: '#e53935', wire: 'Rojo', lbl: '3V3 → VDD', use: 'Alimenta el micrófono con 3,3 V.' },
  { id: 'gnd', name: 'Tierra', mic: 'GND', esp: 'GND', ui: '#9aa3b5', c3d: '#2e323d', wire: 'Negro', lbl: 'GND', use: 'Referencia común de todo el circuito.' },
  { id: 'sck', name: 'Reloj de bits (BCLK)', mic: 'SCK', esp: 'GPIO26', ui: '#facc15', c3d: '#f5c518', wire: 'Amarillo', lbl: 'SCK · BCLK', use: 'La ESP32 genera el reloj que marca cada bit de audio.' },
  { id: 'ws', name: 'Selección de canal (LRCLK)', mic: 'WS', esp: 'GPIO25', ui: '#60a5fa', c3d: '#3b82f6', wire: 'Azul', lbl: 'WS · LRCLK', use: 'Indica al micrófono cuándo empieza cada muestra.' },
  { id: 'sd', name: 'Datos de audio', mic: 'SD', esp: 'GPIO32', ui: '#4ade80', c3d: '#22c55e', wire: 'Verde', lbl: 'SD · DATOS', use: 'El micrófono envía las muestras de 24 bits a la ESP32.' },
  { id: 'lr', name: 'Canal izquierdo', mic: 'L/R', esp: 'GND (puente)', ui: '#d1d5db', c3d: '#e5e7eb', wire: 'Gris o blanco', lbl: 'L/R a GND', use: 'L/R a GND hace que el micrófono hable por el canal izquierdo.' },
];
const netById = Object.fromEntries(NETS.map((n) => [n.id, n]));

let active = null; // red resaltada
let pinned = null;
const listeners = [];
function setActive(id) {
  active = id;
  listeners.forEach((f) => f(id));
}
function bindHover(el, id) {
  el.addEventListener('pointerenter', () => setActive(id));
  el.addEventListener('pointerleave', () => setActive(pinned));
  el.addEventListener('focus', () => setActive(id));
  el.addEventListener('blur', () => setActive(pinned));
  el.addEventListener('click', () => {
    pinned = pinned === id ? null : id;
    setActive(pinned);
  });
}

/* =============== tema y navegación =============== */
function initChrome() {
  for (const el of $$('[data-icon]')) el.innerHTML = icons[el.dataset.icon] || '';
  const btn = $('#theme-btn');
  const labels = { auto: 'Tema: automático', light: 'Tema: claro', dark: 'Tema: oscuro' };
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
    btn.title = labels[mode];
    btn.setAttribute('aria-label', `${labels[mode]}. Cambiar tema`);
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
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        for (const b of tabs) b.setAttribute('aria-selected', String(b.dataset.go === e.target.id));
      }
    },
    { rootMargin: '-35% 0px -55% 0px' },
  );
  for (const b of tabs) io.observe(document.getElementById(b.dataset.go));
}

/* =============== chips de redes =============== */
function buildChips() {
  for (const host of [$('#nets-sch'), $('#nets-3d')]) {
    host.innerHTML = NETS.map((n) => `<button type="button" class="net-chip" data-net="${n.id}" style="--c:${n.ui}"><i></i>${n.wire} · ${n.mic}</button>`).join('');
    for (const c of $$('.net-chip', host)) bindHover(c, c.dataset.net);
  }
  listeners.push((id) => {
    for (const c of $$('.net-chip')) c.classList.toggle('active', c.dataset.net === id);
  });
}

/* =============== esquemático =============== */
const PIN_ESP = [
  { n: 'GPIO25', sub: 'I²S · WS', y: 290, net: 'ws' },
  { n: 'GPIO26', sub: 'I²S · SCK', y: 350, net: 'sck' },
  { n: 'GPIO32', sub: 'I²S · SD', y: 410, net: 'sd' },
  { n: '3V3', sub: 'alimentación', y: 170, net: 'vdd' },
  { n: 'GND', sub: 'tierra', y: 230, net: 'gnd' },
];
const PIN_MIC = [
  { n: 'VDD', sub: '1,8 – 3,3 V', y: 170 },
  { n: 'GND', sub: 'tierra', y: 230 },
  { n: 'WS', sub: 'word select', y: 290 },
  { n: 'SCK', sub: 'bit clock', y: 350 },
  { n: 'SD', sub: 'datos', y: 410 },
  { n: 'L/R', sub: 'canal', y: 470 },
];

const gnd = (x, y) => `<path class="sym" d="M${x - 11} ${y}H${x + 11}M${x - 7} ${y + 6}H${x + 7}M${x - 3} ${y + 12}H${x + 3}"/>`;

function schematicBody() {
  const wires = ['vdd', 'gnd', 'ws', 'sck', 'sd']
    .map((id) => {
      const n = netById[id];
      const y = PIN_ESP.find((p) => p.net === id).y;
      return `<g class="net" data-net="${id}" style="--c:${n.ui}" tabindex="0" role="button" aria-label="${n.name}: ${n.esp} a ${n.mic}">
        <path class="w" d="M320 ${y}H740"/>
        <circle class="tag" cx="320" cy="${y}" r="5"/><circle class="tag" cx="740" cy="${y}" r="5"/>
        <text class="lbl" x="${id === 'vdd' || id === 'gnd' ? 485 : 530}" y="${y - 11}">${n.lbl} · ${n.wire.toLowerCase()}</text>
        <path d="M320 ${y}H740" stroke="transparent" stroke-width="22" fill="none"/>
      </g>`;
    })
    .join('');
  const lr = `<g class="net" data-net="lr" style="--c:${netById.lr.ui}" tabindex="0" role="button" aria-label="L/R conectado a GND">
      <path class="w" d="M740 470H700V510"/><circle class="tag" cx="740" cy="470" r="5"/>
      <text class="lbl" x="682" y="498" style="text-anchor:end">L/R a GND · gris</text>
      <path d="M740 470H700V510" stroke="transparent" stroke-width="22" fill="none"/>
    </g>${gnd(700, 510)}`;
  const espPins = PIN_ESP.map((p) => `<text class="pin" x="308" y="${p.y + 4}" text-anchor="end">${p.n}</text><text class="t-sm" x="308" y="${p.y + 18}" text-anchor="end">${p.sub}</text>`).join('');
  const micPins = PIN_MIC.map((p) => `<text class="pin" x="752" y="${p.y + 4}">${p.n}</text><text class="t-sm" x="752" y="${p.y + 18}">${p.sub}</text>`).join('');
  return `
    <rect class="box" x="70" y="70" width="250" height="490" rx="12"/>
    <text class="t-lg" x="94" y="104">ESP32 DevKit V1</text>
    <text class="t-sm" x="94" y="122">ESP-WROOM-32 · 30 pines</text>
    ${espPins}
    <text class="pin" x="308" y="514" text-anchor="end">GPIO4</text><text class="t-sm" x="308" y="528" text-anchor="end">salida (opcional)</text>
    <path class="sym" d="M320 510H350" stroke-dasharray="5 4"/>
    <text class="t-sm" x="94" y="470">USB 5 V → regulador → 3V3</text>
    <text class="t-sm" x="94" y="488">GPIO2 → LED azul de la placa</text>
    <circle cx="86" cy="484" r="4" fill="#3b82f6"/>

    <rect class="box" x="740" y="110" width="220" height="430" rx="12"/>
    <text class="t-lg" x="762" y="144">INMP441</text>
    <text class="t-sm" x="762" y="162">Micrófono MEMS · salida I²S</text>
    ${micPins}
    <text class="t-sm" x="762" y="510">24 bits · canal izquierdo</text>

    ${wires}${lr}

    <g class="opt">
      <path class="sym" d="M350 510H400"/>
      <rect class="sym" x="400" y="502" width="60" height="16" rx="3"/>
      <path class="sym" d="M460 510H520M520 497V523L545 510ZM545 497V523M545 510H590V540"/>
      <path class="sym" d="M552 498l7-7M558 504l7-7"/>
      ${gnd(590, 540)}
      <text class="t-sm" x="430" y="494" text-anchor="middle">R1 · 220 Ω</text>
      <text class="t-sm" x="535" y="486" text-anchor="middle">LED</text>
      <text class="t-sm" x="470" y="578" text-anchor="middle">salida externa (opcional)</text>
    </g>

    <g class="opt">
      <path class="sym" d="M650 170V193M650 207V230M638 193H662M638 207H662"/>
      <circle class="dot" cx="650" cy="170" r="3.5"/><circle class="dot" cx="650" cy="230" r="3.5"/>
      <text class="t-sm" x="672" y="204">C1 · 100 nF</text>
      <text class="t-sm" x="672" y="218">(opcional, junto al micrófono)</text>
    </g>

    <rect class="box" x="640" y="572" width="380" height="50" rx="8" style="stroke-width:1.2"/>
    <text class="t" x="656" y="593">Silbido ID · ESP32 + INMP441</text>
    <text class="t-sm" x="656" y="611">Esquema de conexión · VDD = 3,3 V · hoja 1/1</text>`;
}

const SCH_VIEW = '0 0 1040 640';
const SCH_STANDALONE_STYLE = `<style>
  text{font-family:Segoe UI,Arial,sans-serif}
  .bg{fill:#fff}.box{fill:#f8fafc;stroke:#475569;stroke-width:2}
  .t{fill:#0f172a;font:600 13px sans-serif}.t-lg{fill:#0f172a;font:700 17px sans-serif}.t-sm{fill:#64748b;font:500 11px sans-serif}
  .pin{fill:#0f172a;font:600 12.5px sans-serif}.sym{fill:none;stroke:#475569;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  .opt{opacity:.85}.opt .sym{stroke-dasharray:5 4}.dot{fill:#0f172a}
  .net path.w{fill:none;stroke-width:3.2;stroke-linecap:round;stroke-linejoin:round}.net text.lbl{fill:#0f172a;font:600 12px sans-serif;text-anchor:middle}
</style>`;

function buildSchematic() {
  const host = $('#sch-host');
  host.innerHTML = `<svg class="sch" viewBox="${SCH_VIEW}" role="img" aria-label="Esquemático: ESP32 conectada al micrófono INMP441 con seis conexiones">${schematicBody()}</svg>`;
  const svg = $('.sch', host);
  for (const g of $$('.net', svg)) bindHover(g, g.dataset.net);
  listeners.push((id) => {
    svg.classList.toggle('has-active', !!id);
    for (const g of $$('.net', svg)) g.classList.toggle('active', g.dataset.net === id);
  });
  $('#sch-dl').addEventListener('click', () => {
    // versión independiente: colores fijos (más oscuros, para fondo blanco) para que se vea igual en cualquier visor
    const PRINT = { vdd: '#dc2626', gnd: '#334155', sck: '#ca8a04', ws: '#2563eb', sd: '#16a34a', lr: '#6b7280' };
    const withStroke = schematicBody().replace(/<g class="net" data-net="(\w+)" style="--c:#[0-9a-f]+"[^>]*>([\s\S]*?)<\/g>/g, (m, id, inner) => {
      const colored = inner.replace(/class="w"/g, `class="w" stroke="${PRINT[id]}"`).replace(/class="tag"/g, `class="tag" fill="${PRINT[id]}"`);
      return `<g class="net" data-net="${id}">${colored}</g>`;
    });
    const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${SCH_VIEW}" width="1560" height="960">${SCH_STANDALONE_STYLE}<rect class="bg" width="1040" height="640"/>${withStroke}</svg>`;
    download('esquematico-esp32-inmp441.svg', out, 'image/svg+xml');
  });
}

/* =============== tabla, código y materiales =============== */
function buildTable() {
  $('#conn-table tbody').innerHTML = NETS.map(
    (n, i) => `<tr data-net="${n.id}" style="--c:${n.ui}" tabindex="0">
      <td>${i + 1}</td>
      <td><b>${n.name}</b></td>
      <td><span class="pin-tag">${n.mic}</span></td>
      <td><span class="pin-tag">${n.esp}</span></td>
      <td><span class="wire-dot"></span>${n.wire}</td>
      <td>${n.use}</td></tr>`,
  ).join('');
  for (const tr of $$('#conn-table tbody tr')) bindHover(tr, tr.dataset.net);
  listeners.push((id) => {
    for (const tr of $$('#conn-table tbody tr')) tr.classList.toggle('active', tr.dataset.net === id);
  });
}

const CODE_PINS = `// Pines I2S del micrófono INMP441 (ESP32 DevKit V1)
#define I2S_WS    25   // WS  (LRCLK)  -> cable azul
#define I2S_SCK   26   // SCK (BCLK)   -> cable amarillo
#define I2S_SD    32   // SD  (datos)  -> cable verde
#define LED_PIN    2   // LED azul integrado de la placa

#define SAMPLE_RATE 16000   // igual que la web

// Además: VDD -> 3V3, GND -> GND y L/R -> GND (canal izquierdo)`;

const CODE_TEST = `// Prueba del micrófono (núcleo esp32 3.x). Abre el Trazador Serie a 115200:
// al silbar debe subir la curva del canal izquierdo (L/R a GND).
#include <driver/i2s_std.h>
#include <math.h>

#define I2S_WS   25
#define I2S_SCK  26
#define I2S_SD   32

i2s_chan_handle_t rx;

void setup() {
  Serial.begin(115200);
  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  i2s_new_channel(&chan, NULL, &rx);
  i2s_std_config_t cfg = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(16000),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED,
      .bclk = (gpio_num_t)I2S_SCK,
      .ws = (gpio_num_t)I2S_WS,
      .dout = I2S_GPIO_UNUSED,
      .din = (gpio_num_t)I2S_SD,
      .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false },
    },
  };
  i2s_channel_init_std_mode(rx, &cfg);
  i2s_channel_enable(rx);
}

void loop() {
  int32_t buf[512];   // 256 pares izquierdo/derecho
  size_t bytes = 0;
  i2s_channel_read(rx, buf, sizeof(buf), &bytes, portMAX_DELAY);
  int n = bytes / 8;
  double l = 0, r = 0;
  for (int i = 0; i < n; i++) {
    double a = buf[2 * i] >> 8, b = buf[2 * i + 1] >> 8;   // 24 bits útiles
    l += a * a;
    r += b * b;
  }
  Serial.printf("izq:%.0f der:%.0f\\n", sqrt(l / n), sqrt(r / n));
}`;

function buildCode() {
  $('#code-pins').textContent = CODE_PINS;
  $('#code-test').textContent = CODE_TEST;
  const copy = async (btn, text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = document.createElement('textarea');
      t.value = text;
      document.body.appendChild(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
    const old = btn.innerHTML;
    btn.innerHTML = `${icons.check}Copiado`;
    setTimeout(() => (btn.innerHTML = old), 1600);
  };
  $('#copy-pins').addEventListener('click', (e) => copy(e.currentTarget, CODE_PINS));
  $('#copy-test').addEventListener('click', (e) => copy(e.currentTarget, CODE_TEST));
}

const BOM = [
  { id: 'esp', name: 'ESP32 DevKit V1 (30 pines)', note: 'Placa con ESP-WROOM-32', qty: '1', tag: 'have', def: true },
  { id: 'mic', name: 'Micrófono INMP441 (I²S)', note: 'Incluye la tira de 6 pines sueltos', qty: '1', tag: 'have', def: true },
  { id: 'usb', name: 'Cable USB de datos', note: 'Micro-USB o USB-C según tu placa. Que no sea solo de carga', qty: '1', tag: 'need' },
  { id: 'bb', name: 'Protoboard de 400 puntos', note: 'Media protoboard. Una de 830 puntos también sirve', qty: '1', tag: 'need' },
  { id: 'jmp', name: 'Cables dupont macho-macho', note: 'Compra un paquete de 20 por si acaso', qty: '6+', tag: 'need' },
  { id: 'sol', name: 'Soldador y estaño', note: 'Para los 6 pines del micrófono. O pide que te los suelden', qty: '1', tag: 'need' },
  { id: 'led', name: 'LED 5 mm + resistencia 220 Ω', note: 'Para una salida externa. Con el LED de la placa ya puedes empezar', qty: '1 + 1', tag: 'opt' },
  { id: 'cap', name: 'Condensador cerámico 100 nF', note: 'Filtra la alimentación junto al micrófono', qty: '1', tag: 'opt' },
  { id: 'mm', name: 'Multímetro', note: 'Para revisar que 3V3 y GND no estén en corto', qty: '1', tag: 'opt' },
];
const TAGS = { have: 'Ya lo tienes', need: 'Falta', opt: 'Opcional' };

function buildBom() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem('silbido-id:hw-bom') || '{}');
  } catch {
    saved = {};
  }
  const host = $('#bom');
  host.innerHTML = BOM.map((b) => {
    const on = b.id in saved ? saved[b.id] : !!b.def;
    return `<li class="${on ? 'done' : ''}"><label class="check"><input type="checkbox" data-id="${b.id}" ${on ? 'checked' : ''} aria-label="Ya tengo: ${b.name}"><span></span></label>
      <div><b>${b.name}<span class="tagline ${b.tag}">${TAGS[b.tag]}</span></b><small>${b.note}</small></div><span class="qty">${b.qty}</span></li>`;
  }).join('');
  host.addEventListener('change', (e) => {
    const i = e.target.closest('input[data-id]');
    if (!i) return;
    saved[i.dataset.id] = i.checked;
    i.closest('li').classList.toggle('done', i.checked);
    try {
      localStorage.setItem('silbido-id:hw-bom', JSON.stringify(saved));
    } catch {
      /* sin almacenamiento */
    }
  });
}

/* =============== vista 3D =============== */
function init3D() {
  const stage = $('#stage');
  const msg = $('#stage-msg');
  const THREE = window.THREE;
  if (!THREE) {
    msg.innerHTML = '<b>No se pudo cargar la librería 3D.</b><span>Revisa tu conexión a internet y recarga la página.</span>';
    return;
  }
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    msg.innerHTML = '<b>Tu navegador no permite gráficos 3D (WebGL).</b>';
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  stage.insertBefore(renderer.domElement, stage.firstChild);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 1, 1000);

  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a1c24, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 0.85);
  sun.position.set(60, 130, 90);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x9db6ff, 0.35);
  fill.position.set(-90, 60, -70);
  scene.add(fill);

  const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, ...o });
  const box = (w, h, d, color, pos, parent, o) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, o));
    m.position.set(pos[0], pos[1], pos[2]);
    parent.add(m);
    return m;
  };
  const cyl = (r, h, color, pos, parent, o) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 20), mat(color, o));
    m.position.set(pos[0], pos[1], pos[2]);
    parent.add(m);
    return m;
  };

  /* ---- protoboard ---- */
  const ROW = { a: -13.97, b: -11.43, c: -8.89, d: -6.35, e: -3.81, f: 3.81, g: 6.35, h: 8.89, i: 11.43, j: 13.97 };
  const colX = (c) => (c - 15.5) * 2.54;
  function breadboardTexture() {
    const ppm = 14;
    const W = Math.round(82.55 * ppm);
    const H = Math.round(54.61 * ppm);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#ece9e0';
    g.fillRect(0, 0, W, H);
    const X = (mm) => W / 2 + mm * ppm;
    const Z = (mm) => H / 2 + mm * ppm;
    g.fillStyle = '#d6d2c5';
    g.fillRect(0, Z(-3.2), W, Z(3.2) - Z(-3.2));
    const hole = (x, z) => {
      g.fillStyle = '#2a2d34';
      g.fillRect(X(x) - 0.55 * ppm, Z(z) - 0.55 * ppm, 1.1 * ppm, 1.1 * ppm);
    };
    for (let col = 1; col <= 30; col++) for (const z of Object.values(ROW)) hole(colX(col), z);
    // rieles
    for (const [z, color] of [
      [-26.2, '#e04848'],
      [-19.7, '#3b6fe0'],
      [19.7, '#e04848'],
      [26.2, '#3b6fe0'],
    ]) {
      g.fillStyle = color;
      g.fillRect(X(-37), Z(z) - 0.7, 74 * ppm, 1.4);
    }
    for (const z of [-24.13, -21.59, 21.59, 24.13]) {
      for (let k = -14; k <= 14; k++) if ((k + 14) % 6 !== 5) hole(k * 2.54 * 1 + 0.01, z);
    }
    g.fillStyle = '#7c7a72';
    g.font = `${1.9 * ppm}px system-ui`;
    g.textAlign = 'center';
    for (let col = 5; col <= 30; col += 5) g.fillText(String(col), X(colX(col)), Z(-16.9));
    g.textAlign = 'left';
    for (const [k, z] of Object.entries(ROW)) g.fillText(k, X(colX(0.2)), Z(z) + 0.7 * ppm);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 8;
    return t;
  }
  const side = mat('#d9d5ca', { roughness: 0.8 });
  const bb = new THREE.Mesh(new THREE.BoxGeometry(82.55, 8.5, 54.61), [side, side, mat('#ffffff', { map: breadboardTexture(), roughness: 0.75 }), side, side, side]);
  bb.position.y = -4.25;
  scene.add(bb);
  // sombra suave
  {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 8, 64, 64, 62);
    gr.addColorStop(0, 'rgba(0,0,0,0.55)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 128);
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(190, 150), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
    sh.rotation.x = -Math.PI / 2;
    sh.position.y = -8.6;
    scene.add(sh);
  }

  const labelTexture = (text, w, h, font, color = '#e8ecf5', bg = null) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    if (bg) {
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
    }
    g.fillStyle = color;
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    return t;
  };
  const decal = (tex, w, h, pos, parent) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(pos[0], pos[1], pos[2]);
    parent.add(m);
  };

  /* ---- ESP32 DevKit V1 (30 pines), USB hacia la izquierda ---- */
  const PITCH = 2.54;
  const pinX = (i) => 3.81 - i * PITCH;
  const espCx = (pinX(0) + pinX(14)) / 2;
  const esp = new THREE.Group();
  scene.add(esp);
  for (const z of [-11.43, 11.43]) {
    box(38.1, 2.5, 2.54, '#14161b', [espCx, 1.25, z], esp);
    for (let i = 0; i < 15; i++) cyl(0.42, 0.25, '#d9b44a', [pinX(i), 4.2, z], esp, { metalness: 0.9, roughness: 0.3 });
  }
  box(51.5, 1.6, 27, '#141a2a', [espCx, 3.3, 0], esp, { roughness: 0.45 });
  box(19.5, 3.1, 18, '#b3b9c4', [-4.17, 5.65, 0], esp, { metalness: 0.85, roughness: 0.32 });
  box(6.2, 0.7, 18, '#0e1420', [8.68, 4.45, 0], esp);
  decal(labelTexture('ESP-WROOM-32', 256, 96, '600 30px system-ui', '#3a3f4a'), 14, 5.2, [-4.17, 7.23, 0], esp);
  box(5.6, 2.6, 7.5, '#cfd4dc', [-37.7, 5.4, 0], esp, { metalness: 0.85, roughness: 0.3 });
  box(5, 0.9, 5, '#1b1b1d', [-30, 4.55, 0], esp);
  box(6.5, 1.5, 3.5, '#25262a', [-24, 4.85, -8], esp);
  for (const z of [-9, 9]) {
    box(6, 3.5, 6, '#e9eaee', [-33.5, 5.85, z], esp, { metalness: 0.5 });
    cyl(1.6, 1, '#16171a', [-33.5, 7.9, z], esp);
  }
  box(1.8, 0.6, 1, '#3aa0ff', [-27, 4.4, 8.5], esp, { emissive: '#2c7cff', emissiveIntensity: 0.9 });
  for (const [x, z] of [
    [-21, -9],
    [-18.5, 9],
    [-14, -9.5],
  ]) box(2, 1, 1.2, '#b08a4f', [x, 4.6, z], esp);

  /* ---- INMP441 ---- */
  const MIC_ORDER = ['SCK', 'WS', 'SD', 'VDD', 'L/R', 'GND']; // columnas 22..27 (ejemplo)
  const micX = (name) => colX(22 + MIC_ORDER.indexOf(name));
  const micCx = (micX('SCK') + micX('GND')) / 2;
  const mic = new THREE.Group();
  scene.add(mic);
  box(15.24, 2.5, 2.54, '#14161b', [micCx, 1.25, ROW.a], mic);
  box(14.2, 1.6, 15, '#0c0e13', [micCx, 3.3, -20.47], mic, { roughness: 0.4 });
  for (const n of MIC_ORDER) box(1.7, 0.2, 1.7, '#d9b44a', [micX(n), 4.15, -14.5], mic, { metalness: 0.9, roughness: 0.3 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.3, 0.3, 10, 32), mat('#d9b44a', { metalness: 0.9, roughness: 0.3 }));
  ring.rotation.x = Math.PI / 2;
  ring.position.set(micCx, 4.22, -21.6);
  mic.add(ring);
  cyl(2, 0.1, '#020203', [micCx, 4.16, -21.6], mic);
  box(3.2, 0.8, 3.2, '#232428', [micCx + 4.2, 4.5, -25], mic);
  box(1.6, 0.6, 0.9, '#b08a4f', [micCx - 4.4, 4.4, -17.2], mic);
  box(1.6, 0.6, 0.9, '#b08a4f', [micCx - 4.4, 4.4, -25.4], mic);
  decal(labelTexture('INMP441', 192, 64, '700 28px system-ui', '#e8ecf5'), 8, 2.7, [micCx, 4.15, -17.8], mic);

  /* ---- cables ---- */
  const WIRES = {
    vdd: { s: [pinX(14), ROW.j], e: [micX('VDD'), ROW.b], lane: 0, H: 34 },
    gnd: { s: [pinX(13), ROW.a], e: [micX('GND'), ROW.b], lane: -25, H: 22 },
    sck: { s: [pinX(8), ROW.a], e: [micX('SCK'), ROW.b], lane: -21, H: 18 },
    ws: { s: [pinX(7), ROW.a], e: [micX('WS'), ROW.b], lane: -18.5, H: 15 },
    sd: { s: [pinX(5), ROW.a], e: [micX('SD'), ROW.b], lane: -16.5, H: 12 },
    lr: { s: [micX('L/R'), ROW.c], e: [micX('GND'), ROW.d], lane: null, H: 8 },
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  const wireMeshes = {};
  for (const [id, w] of Object.entries(WIRES)) {
    const [sx, sz] = w.s;
    const [ex, ez] = w.e;
    const P = (x, y, z) => new THREE.Vector3(x, y, z);
    const pts =
      w.lane == null
        ? [P(sx, 0.6, sz), P(sx, w.H - 2, sz), P((sx + ex) / 2, w.H, (sz + ez) / 2), P(ex, w.H - 2, ez), P(ex, 0.6, ez)]
        : [
            P(sx, 0.6, sz),
            P(sx, 6, sz),
            P(lerp(sx, ex, 0.16), w.H * 0.8, lerp(sz, w.lane, 0.75)),
            P(lerp(sx, ex, 0.5), w.H, w.lane),
            P(lerp(sx, ex, 0.84), w.H * 0.8, lerp(ez, w.lane, 0.75)),
            P(ex, 6, ez),
            P(ex, 0.6, ez),
          ];
    const m = mat(netById[id].c3d, { roughness: 0.42 });
    m.transparent = true;
    const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'centripetal'), 90, 0.75, 10, false), m);
    scene.add(tube);
    const plugs = [];
    for (const [x, z] of [w.s, w.e]) {
      const p = cyl(1.05, 3.2, netById[id].c3d, [x, 1.6, z], scene, { roughness: 0.4 });
      p.material.transparent = true;
      plugs.push(p);
    }
    wireMeshes[id] = { mats: [m, ...plugs.map((p) => p.material)] };
  }

  /* ---- etiquetas HTML sobre el 3D ---- */
  const tagLayer = $('#tags3d');
  const tags = [];
  const addTag = (text, pos, { net = null, cls = '' } = {}) => {
    const el = document.createElement('span');
    el.className = `tag3d ${cls}`;
    if (net) el.style.setProperty('--c', netById[net].ui);
    el.textContent = text;
    tagLayer.appendChild(el);
    tags.push({ el, v: new THREE.Vector3(...pos), net, cls });
  };
  const ESP_TOP = ['EN', 'VP', 'VN', '34', '35', '32', '33', '25', '26', '27', '14', '12', '13', 'GND', 'VIN'];
  const ESP_BOT = ['23', '22', 'TX0', 'RX0', '21', '19', '18', '5', 'TX2', 'RX2', '4', '2', '15', 'GND', '3V3'];
  const used = { 'top:5': 'sd', 'top:7': 'ws', 'top:8': 'sck', 'top:13': 'gnd', 'bot:14': 'vdd' };
  ESP_TOP.forEach((n, i) => addTag(n, [pinX(i), 6.4, -11.43], { cls: 'dim all' + (used[`top:${i}`] ? ' used' : '') }));
  ESP_BOT.forEach((n, i) => addTag(n, [pinX(i), 6.4, 11.43], { cls: 'dim all' + (used[`bot:${i}`] ? ' used' : '') }));
  addTag('GPIO32 · SD', [pinX(5), 9, ROW.a - 1], { net: 'sd' });
  addTag('GPIO25 · WS', [pinX(7), 21, ROW.a - 1], { net: 'ws' });
  addTag('GPIO26 · SCK', [pinX(8), 15, ROW.a - 1], { net: 'sck' });
  addTag('GND', [pinX(13), 9, ROW.a - 1], { net: 'gnd' });
  addTag('3V3', [pinX(14), 9, ROW.j + 1], { net: 'vdd' });
  MIC_ORDER.forEach((n, i) => {
    const net = { SCK: 'sck', WS: 'ws', SD: 'sd', VDD: 'vdd', 'L/R': 'lr', GND: 'gnd' }[n];
    addTag(n, [micX(n), 11 + (i % 3) * 6.5, -15.5], { net });
  });
  addTag('ESP32 DevKit V1', [espCx + 8, 13, 4], { cls: 'part' });
  addTag('INMP441', [micCx, 8, -27], { cls: 'part' });
  addTag('USB', [-37.7, 10, 0], { cls: 'part' });
  addTag('Protoboard', [-30, -2, 27], { cls: 'part' });

  /* ---- cámara ---- */
  const VIEWS = {
    iso: { az: 0.7, el: 0.58, r: 158, t: [-2, 2, -3] },
    top: { az: 0, el: 1.5, r: 140, t: [0, 0, -3] },
    front: { az: 0, el: 0.2, r: 150, t: [0, 6, -4] },
    mic: { az: 2.65, el: 0.55, r: 88, t: [20, 3, -14] },
  };
  const cam = { az: 0, el: 0, r: 0, t: new THREE.Vector3() };
  const goal = { az: 0, el: 0, r: 0, t: new THREE.Vector3() };
  const setView = (name, instant = false) => {
    const v = VIEWS[name];
    goal.az = v.az;
    goal.el = v.el;
    goal.r = v.r;
    goal.t.set(...v.t);
    if (instant) {
      cam.az = goal.az;
      cam.el = goal.el;
      cam.r = goal.r;
      cam.t.copy(goal.t);
    }
  };
  setView('iso', true);
  for (const b of $$('[data-view]')) b.addEventListener('click', () => setView(b.dataset.view));

  const pointers = new Map();
  let lastPinch = 0;
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastPinch = 0;
  });
  const endPtr = (e) => pointers.delete(e.pointerId);
  stage.addEventListener('pointerup', endPtr);
  stage.addEventListener('pointercancel', endPtr);
  stage.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    if (pointers.size === 1) {
      goal.az -= (e.clientX - p.x) * 0.008;
      goal.el = Math.max(0.05, Math.min(1.52, goal.el + (e.clientY - p.y) * 0.008));
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d0 = Math.hypot(a.x - b.x, a.y - b.y);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a2, b2] = [...pointers.values()];
      const d1 = Math.hypot(a2.x - b2.x, a2.y - b2.y);
      if (d0 > 0) goal.r = Math.max(35, Math.min(320, goal.r * (d0 / d1)));
      return;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      goal.r = Math.max(35, Math.min(320, goal.r * Math.exp(e.deltaY * 0.0012)));
    },
    { passive: false },
  );

  const optTags = $('#opt-tags');
  const optAll = $('#opt-allpins');
  const optSpin = $('#opt-spin');
  $('#shot3d').addEventListener('click', () => {
    render();
    renderer.domElement.toBlob((b) => b && download('circuito-3d-esp32-inmp441.png', b));
  });

  listeners.push((id) => {
    for (const [nid, w] of Object.entries(wireMeshes)) for (const m of w.mats) m.opacity = !id || nid === id ? 1 : 0.14;
    for (const t of tags) t.el.classList.toggle('off', !!id && !!t.net && t.net !== id);
  });

  /* ---- bucle ---- */
  const size = { w: 0, h: 0 };
  const resize = () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h || (w === size.w && h === size.h)) return;
    size.w = w;
    size.h = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(stage);
  let visible = true;
  new IntersectionObserver((e) => (visible = e[0].isIntersecting)).observe(stage);

  const tmp = new THREE.Vector3();
  function render() {
    resize();
    const k = 0.14;
    if (optSpin.checked) goal.az += 0.004;
    cam.az += (goal.az - cam.az) * k;
    cam.el += (goal.el - cam.el) * k;
    cam.r += (goal.r - cam.r) * k;
    cam.t.lerp(goal.t, k);
    camera.position.set(cam.t.x + cam.r * Math.sin(cam.az) * Math.cos(cam.el), cam.t.y + cam.r * Math.sin(cam.el), cam.t.z + cam.r * Math.cos(cam.az) * Math.cos(cam.el));
    camera.lookAt(cam.t);
    renderer.render(scene, camera);
    const showTags = optTags.checked;
    const showAll = optAll.checked;
    for (const t of tags) {
      const isAll = t.cls.includes('all');
      // con "Todos los pines" se muestran los 30 nombres, salvo los usados (ya tienen su etiqueta con color)
      const show = showTags && (!isAll || (showAll && !t.cls.includes('used')));
      if (!show) {
        t.el.style.display = 'none';
        continue;
      }
      tmp.copy(t.v).project(camera);
      if (tmp.z > 1) {
        t.el.style.display = 'none';
        continue;
      }
      t.el.style.display = '';
      t.el.style.transform = `translate(${(tmp.x * 0.5 + 0.5) * size.w}px, ${(-tmp.y * 0.5 + 0.5) * size.h}px) translate(-50%, -100%)`;
    }
  }
  for (const t of tags) t.el.style.transform = 'translate(-9999px,-9999px)';
  const loop = () => {
    requestAnimationFrame(loop);
    if (visible && !document.hidden) render();
  };
  loop();
  msg.remove();
}

/* =============== arranque =============== */
initChrome();
buildChips();
buildSchematic();
buildTable();
buildCode();
buildBom();
init3D();
