/**
 * Página de la alarma: une el enlace Bluetooth con la ESP32, la verificación de los mensajes,
 * los sensores del celular (movimiento, cargador, pantalla) y la sirena.
 */
import { crearAlarma, ESTADOS, EVENTOS } from './estado.js';
import { verificarMensaje, crearMensaje } from './firma.js';
import { crearDetectorMovimiento } from './movimiento.js';
import { crearEnlace, bleDisponible } from './ble.js';
import { crearSirena } from './sirena.js';

const $ = (s) => document.querySelector(s);
const K = { secreto: 'silbido-alarma:secreto', ultimoN: 'silbido-alarma:ultimoN', estado: 'silbido-alarma:estado', sens: 'silbido-alarma:sens' };
const leer = (k, d) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const guardar = (k, v) => {
  try {
    localStorage.setItem(k, String(v));
  } catch {
    /* sin almacenamiento */
  }
};

const demo = new URLSearchParams(location.search).has('demo');
const SECRETO_DEMO = 'demo-secreto-silbido';
let secreto = leer(K.secreto, '') || (demo ? SECRETO_DEMO : '');
let ultimoN = Number(leer(K.ultimoN, 0)) || 0;
let ultimoValido = null; // para el botón "Repetir el último" del simulador
let sensoresActivos = false;
let cargando = null;
let wakeLock = null;

const sirena = crearSirena();
const detector = crearDetectorMovimiento({ umbral: Number(leer(K.sens, 1.5)) || 1.5 });

// ---------------------------------------------------------------- registro
function registrar(texto, tipo = '') {
  const li = document.createElement('li');
  if (tipo) li.className = tipo;
  const hora = new Date().toLocaleTimeString('es-CO', { hour12: false });
  li.innerHTML = `<time>${hora}</time><span></span>`;
  li.querySelector('span').textContent = texto;
  const ol = $('#registro');
  ol.prepend(li);
  while (ol.children.length > 30) ol.lastChild.remove();
}

function avisar(texto) {
  const p = $('#aviso');
  p.textContent = texto || '';
  p.hidden = !texto;
}

// ---------------------------------------------------------------- alarma
const alarma = crearAlarma({
  alCambiar({ estado, antes, motivo }) {
    guardar(K.estado, estado);
    registrar(`${antes} → ${estado}${motivo ? ` (${motivo})` : ''}`, estado === ESTADOS.SONANDO || estado === ESTADOS.ALERTA ? 'mal' : 'ok');
    document.body.classList.toggle('sonando', estado === ESTADOS.SONANDO);
    switch (estado) {
      case ESTADOS.ARMANDO:
        sirena.confirmarArmado();
        break;
      case ESTADOS.ARMADA:
        detector.reiniciar();
        if (!sensoresActivos) avisar('Los sensores no están activos: toca "Conectar con la ESP32" (o un botón del simulador) para activarlos.');
        break;
      case ESTADOS.ALERTA:
        sirena.pitar();
        break;
      case ESTADOS.SONANDO:
        sirena.callar();
        sirena.sonar();
        break;
      case ESTADOS.DESARMADA:
        sirena.callar();
        sirena.confirmarDesarmado();
        break;
      default:
        break;
    }
    enlace.enviarEstado(estado);
    pintar();
  },
});

// ---------------------------------------------------------------- mensajes de la ESP32
async function alMensaje(texto) {
  if (!secreto) {
    registrar('Llegó un mensaje, pero falta el secreto (Ajustes).', 'mal');
    $('#ajustes').open = true;
    return;
  }
  const r = await verificarMensaje(texto, { secreto, ultimoN });
  if (!r.ok) {
    registrar(`Mensaje rechazado: ${r.motivo}`, 'mal');
    sirena.error();
    return;
  }
  ultimoN = r.n;
  guardar(K.ultimoN, ultimoN);
  ultimoValido = texto;
  registrar(`ESP32: ${r.ev} (n = ${r.n}${r.d ? `, D = ${r.d.toFixed(2)}` : ''})`, 'ok');
  if (!alarma.evento(r.ev)) registrar(`(${r.ev} no cambia nada en estado ${alarma.estado})`);
  pintar();
}

// Al conectar se lee el último mensaje guardado en la ESP32: solo sirve para sincronizar el contador.
async function alInicial(texto) {
  if (!secreto || !texto || texto === '{}') return;
  const r = await verificarMensaje(texto, { secreto, soloFirma: true });
  if (!r.ok) {
    if (r.n) registrar(`El último mensaje de la ESP32 no tiene una firma válida: ${r.motivo}`, 'mal');
    return;
  }
  if (r.n > ultimoN || (r.n < ultimoN && alarma.estado === ESTADOS.DESARMADA)) {
    if (r.n < ultimoN) registrar(`El contador de la ESP32 (${r.n}) es menor que el guardado (${ultimoN}): se sincronizó.`);
    ultimoN = r.n;
    guardar(K.ultimoN, ultimoN);
    pintar();
  }
}

const enlace = crearEnlace({
  alMensaje,
  alInicial,
  alEstado(conectado, info) {
    registrar(conectado ? `Bluetooth conectado (${info})` : `Bluetooth: ${info}`, conectado ? 'ok' : 'mal');
    if (conectado) enlace.enviarEstado(alarma.estado);
    pintar();
  },
});

// ---------------------------------------------------------------- sensores del celular
async function activarSensores() {
  sirena.activar();
  if (!sensoresActivos) {
    // iPhone pide permiso para el acelerómetro desde un toque
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        await DeviceMotionEvent.requestPermission();
      } catch {
        /* sin permiso */
      }
    }
    window.addEventListener('devicemotion', alMovimiento);
    if (navigator.getBattery) {
      try {
        const b = await navigator.getBattery();
        cargando = b.charging;
        b.addEventListener('chargingchange', () => {
          cargando = b.charging;
          registrar(cargando ? 'Cargador conectado' : 'Cargador desconectado', cargando ? '' : 'mal');
          if (!cargando && $('#usar-cargador').checked) alarma.evento(EVENTOS.CARGADOR);
          pintar();
        });
      } catch {
        cargando = null;
      }
    }
    sensoresActivos = true;
  }
  await pedirPantalla();
  pintar();
}

let ultimaMuestra = 0;
function alMovimiento(e) {
  const a = e.accelerationIncludingGravity;
  if (!a) return;
  ultimaMuestra = performance.now();
  if (alarma.estado !== ESTADOS.ARMADA) return;
  const r = detector.procesar({ x: a.x, y: a.y, z: a.z, t: e.timeStamp || performance.now() });
  if (r.disparo) alarma.evento(EVENTOS.MOVIMIENTO, `movieron el celular (${r.desvio.toFixed(1)} m/s², ${r.angulo.toFixed(0)}°)`);
}

async function pedirPantalla() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
      pintar();
    });
  } catch {
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (sensoresActivos) pedirPantalla();
  } else if (alarma.estado !== ESTADOS.DESARMADA) {
    registrar('La página quedó en segundo plano: mientras no esté al frente no vigila.', 'mal');
  }
});

// ---------------------------------------------------------------- pantalla
const TEXTOS = {
  DESARMADA: ['Desarmada', 'Silba “Armar” al micrófono de la ESP32 para vigilar'],
  ARMANDO: ['Armando…', 'Deja el celular quieto y aléjate'],
  ARMADA: ['Armada', 'Vigilando. Silba “Desarmar” antes de tomar el celular'],
  ALERTA: ['¡Alerta!', 'Silba “Desarmar” ya o sonará la sirena'],
  SONANDO: ['¡Robo!', ''],
};

function chip(id, clase, texto) {
  const el = $(id);
  el.className = `al-chip ${clase}`;
  el.lastChild.textContent = texto;
}

function pintar() {
  const est = alarma.estado;
  const [titulo, sub] = TEXTOS[est];
  const s = Math.ceil(alarma.restante() / 1000);
  $('#estado').dataset.estado = est;
  $('#estado-titulo').textContent = est === ESTADOS.ARMANDO || est === ESTADOS.ALERTA ? `${titulo} ${s}` : titulo;
  $('#estado-sub').textContent = est === ESTADOS.SONANDO || est === ESTADOS.ALERTA ? `${alarma.motivo}. ${sub}`.replace(/\. $/, '') : sub;

  const con = enlace.conectado;
  chip('#chip-ble', con ? 'ok' : demo ? 'aviso' : 'mal', con ? 'Bluetooth conectado' : demo ? 'Simulador' : 'Bluetooth desconectado');
  const movOk = sensoresActivos && performance.now() - ultimaMuestra < 3000;
  chip('#chip-mov', movOk ? 'ok' : sensoresActivos ? 'aviso' : '', movOk ? 'Movimiento' : sensoresActivos ? 'Sin acelerómetro' : 'Movimiento');
  chip('#chip-carga', cargando === null ? '' : cargando ? 'ok' : 'mal', cargando === null ? 'Cargador (no disponible)' : cargando ? 'Cargando' : 'Sin cargador');
  chip('#chip-pantalla', wakeLock ? 'ok' : sensoresActivos ? 'aviso' : '', wakeLock ? 'Pantalla encendida' : 'Pantalla');
  $('#contador').textContent = ultimoN;
  $('#btn-conectar').textContent = con ? 'Conectado a la ESP32' : 'Conectar con la ESP32';
  $('#btn-probar').disabled = est !== ESTADOS.DESARMADA;

  if (!bleDisponible() && !demo) avisar('Este navegador no tiene Bluetooth web. Abre esta página en Chrome (Android) o prueba el simulador con ?demo=1.');
  else if (!secreto) avisar('Falta el secreto: escríbelo en Ajustes (es el mismo de secreto.h en la ESP32).');
  else if (est !== ESTADOS.DESARMADA && !con && !demo) avisar('Sin conexión con la ESP32: la alarma sigue en su estado y se reconecta sola.');
  else avisar('');
}

// ---------------------------------------------------------------- botones
$('#btn-conectar').addEventListener('click', async () => {
  await activarSensores();
  if (enlace.conectado) return;
  try {
    await enlace.conectar();
  } catch (e) {
    if (e && e.name !== 'NotFoundError') registrar(`No se pudo conectar: ${e.message || e}`, 'mal');
  }
  pintar();
});

$('#btn-pantalla').addEventListener('click', async () => {
  await activarSensores();
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    registrar('Este navegador no permite pantalla completa.');
  }
});

$('#btn-probar').addEventListener('click', () => {
  sirena.activar();
  sirena.sonar();
  setTimeout(() => sirena.callar(), 1000);
});

$('#btn-secreto').addEventListener('click', () => {
  const v = $('#secreto').value.trim();
  if (v.length < 16) {
    registrar('El secreto debe tener al menos 16 caracteres.', 'mal');
    return;
  }
  secreto = v;
  guardar(K.secreto, v);
  $('#secreto').value = '';
  registrar('Secreto guardado en este celular.', 'ok');
  pintar();
});

$('#btn-contador').addEventListener('click', () => {
  if (alarma.estado !== ESTADOS.DESARMADA) {
    registrar('Solo se puede reiniciar el contador con la alarma desarmada.', 'mal');
    return;
  }
  if (!confirm('¿Reiniciar el contador? Hazlo solo si volviste a cargar el firmware de la ESP32.')) return;
  ultimoN = 0;
  guardar(K.ultimoN, 0);
  registrar('Contador reiniciado.');
  pintar();
});

$('#sensibilidad').value = leer(K.sens, '1.5');
$('#sensibilidad').addEventListener('change', (e) => {
  guardar(K.sens, e.target.value);
  location.reload();
});

// ---------------------------------------------------------------- simulador (?demo=1)
if (demo) {
  $('#demo').hidden = false;
  if (!leer(K.secreto, '')) registrar(`Simulador: se usa el secreto de prueba "${SECRETO_DEMO}".`);
  $('#demo').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-demo]');
    if (!b) return;
    await activarSensores();
    const accion = b.dataset.demo;
    if (accion === 'armar' || accion === 'desarmar') {
      await alMensaje(await crearMensaje(secreto, accion.toUpperCase(), ultimoN + 1, 0.3));
    } else if (accion === 'falso') {
      await alMensaje(JSON.stringify({ ev: 'DESARMAR', n: ultimoN + 1, d: 0.2, tok: '0123456789abcdef' }));
    } else if (accion === 'repetir') {
      if (ultimoValido) await alMensaje(ultimoValido);
      else registrar('Todavía no hay un mensaje válido para repetir.');
    } else if (accion === 'mover') {
      if (!alarma.evento(EVENTOS.MOVIMIENTO, 'movieron el celular (simulado)')) registrar(`(movimiento ignorado en estado ${alarma.estado})`);
    } else if (accion === 'cargador') {
      if (!alarma.evento(EVENTOS.CARGADOR, 'desconectaron el cargador (simulado)')) registrar(`(cargador ignorado en estado ${alarma.estado})`);
    }
  });
}

// ---------------------------------------------------------------- arranque
// Si la página se recargó con la alarma activa (por ejemplo, alguien intentó cerrarla), se avisa.
const previo = leer(K.estado, ESTADOS.DESARMADA);
if (previo !== ESTADOS.DESARMADA) {
  registrar(`La página se recargó con la alarma en estado ${previo}. Vuelve a conectar y a armarla.`, 'mal');
  guardar(K.estado, ESTADOS.DESARMADA);
}
setInterval(() => {
  alarma.tick();
  pintar();
}, 250);
registrar(demo ? 'Simulador listo.' : 'Listo. Conecta la ESP32 para empezar.');
pintar();
