// Pruebas de la alarma por silbidos (sin navegador):  node tests/alarma.test.mjs
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { crearAlarma, ESTADOS as E, EVENTOS as V } from '../js/alarma/estado.js';
import { calcularToken, crearMensaje, verificarMensaje } from '../js/alarma/firma.js';
import { crearDetectorMovimiento } from '../js/alarma/movimiento.js';
import { UUID_SERVICIO, UUID_EVENTO, UUID_ESTADO } from '../js/alarma/ble.js';

let pasa = 0;
let falla = 0;
function check(nombre, cond, detalle = '') {
  if (cond) pasa++;
  else falla++;
  console.log(`  ${cond ? '✔' : '✘'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
}
const seccion = (s) => console.log(`\n${s}`);

// reloj falso
let ahora = 0;
const nueva = () => {
  ahora = 0;
  const cambios = [];
  const a = crearAlarma({ ahora: () => ahora, alCambiar: (c) => cambios.push(c) });
  return { a, cambios };
};
const avanzar = (a, ms) => {
  for (let t = 0; t < ms; t += 100) {
    ahora += 100;
    a.tick();
  }
};

seccion('Máquina de estados');
{
  const { a } = nueva();
  check('empieza desarmada', a.estado === E.DESARMADA);
  check('el movimiento no hace nada desarmada', !a.evento(V.MOVIMIENTO) && a.estado === E.DESARMADA);
  check('ARMAR → ARMANDO', a.evento(V.ARMAR) && a.estado === E.ARMANDO);
  check('el movimiento no dispara mientras arma', !a.evento(V.MOVIMIENTO) && a.estado === E.ARMANDO);
  avanzar(a, 9000);
  check('a los 9 s sigue armando', a.estado === E.ARMANDO, `faltan ${a.restante()} ms`);
  avanzar(a, 1100);
  check('a los 10 s queda ARMADA', a.estado === E.ARMADA);
  check('ARMAR otra vez no cambia nada', !a.evento(V.ARMAR) && a.estado === E.ARMADA);
  check('movimiento → ALERTA', a.evento(V.MOVIMIENTO) && a.estado === E.ALERTA);
  avanzar(a, 2900);
  check('a los 2,9 s sigue en alerta', a.estado === E.ALERTA);
  avanzar(a, 200);
  check('a los 3 s suena', a.estado === E.SONANDO);
  check('DESARMAR apaga la sirena', a.evento(V.DESARMAR) && a.estado === E.DESARMADA);
}
{
  const { a } = nueva();
  a.evento(V.ARMAR);
  avanzar(a, 10100);
  a.evento(V.CARGADOR);
  check('desconectar el cargador → ALERTA', a.estado === E.ALERTA, a.motivo);
  a.evento(V.DESARMAR);
  check('DESARMAR durante el pre-aviso evita la sirena', a.estado === E.DESARMADA);
  avanzar(a, 5000);
  check('y no vuelve a sonar sola', a.estado === E.DESARMADA);
}
{
  const { a, cambios } = nueva();
  a.evento(V.ARMAR);
  a.evento(V.DESARMAR);
  check('DESARMAR mientras arma cancela', a.estado === E.DESARMADA);
  check('cada cambio se notifica una vez', cambios.length === 2, cambios.map((c) => `${c.antes}→${c.estado}`).join(', '));
}

seccion('Firma de los mensajes (HMAC-SHA256)');
{
  const tok = await calcularToken('secreto-de-prueba-123', 'ARMAR', 1);
  check('vector de prueba = el del firmware (bdab41943d25082d)', tok === 'bdab41943d25082d', tok);
  const ref = createHmac('sha256', 'otro-secreto-largo-xyz').update('DESARMAR:77').digest('hex').slice(0, 16);
  check('coincide con node:crypto', (await calcularToken('otro-secreto-largo-xyz', 'DESARMAR', 77)) === ref);
  const s = 'mi-secreto-de-prueba-1';
  const m = await crearMensaje(s, 'DESARMAR', 5, 0.42);
  const ok = await verificarMensaje(m, { secreto: s, ultimoN: 4 });
  check('mensaje válido se acepta', ok.ok && ok.ev === 'DESARMAR' && ok.n === 5 && ok.d === 0.42);
  check('mensaje repetido se rechaza', !(await verificarMensaje(m, { secreto: s, ultimoN: 5 })).ok);
  check('contador viejo se rechaza', !(await verificarMensaje(m, { secreto: s, ultimoN: 9 })).ok);
  check('con soloFirma se acepta aunque sea viejo (sincronización)', (await verificarMensaje(m, { secreto: s, ultimoN: 9, soloFirma: true })).ok);
  check('otro secreto → firma incorrecta', !(await verificarMensaje(m, { secreto: 'otro-secreto-distinto', ultimoN: 0 })).ok);
  const alterado = JSON.stringify({ ...JSON.parse(m), ev: 'ARMAR' });
  check('cambiar el evento invalida la firma', !(await verificarMensaje(alterado, { secreto: s })).ok);
  const masN = JSON.stringify({ ...JSON.parse(m), n: 6 });
  check('cambiar el contador invalida la firma', !(await verificarMensaje(masN, { secreto: s, ultimoN: 0 })).ok);
  check('texto basura se rechaza', !(await verificarMensaje('hola', { secreto: s })).ok);
  check('evento desconocido se rechaza', !(await verificarMensaje('{"ev":"ABRIR","n":9,"tok":"0123456789abcdef"}', { secreto: s })).ok);
  check('sin secreto no se acepta nada', !(await verificarMensaje(m, { secreto: '' })).ok);
}

seccion('Detector de movimiento');
{
  const g = { x: 0.1, y: 0.2, z: 9.8 };
  const d = crearDetectorMovimiento();
  let t = 0;
  let disparos = 0;
  for (; t <= 1100; t += 20) d.procesar({ ...g, t });
  check('se calibra en ~1 s', d.calibrado);
  for (let i = 0; i < 100; i++, t += 20) if (d.procesar({ x: g.x + 0.05 * Math.sin(i), y: g.y, z: g.z + 0.05, t }).disparo) disparos++;
  check('quieto no dispara', disparos === 0);
  for (let i = 0; i < 5; i++, t += 20) if (d.procesar({ x: g.x + 3, y: g.y, z: g.z, t }).disparo) disparos++;
  for (let i = 0; i < 50; i++, t += 20) d.procesar({ ...g, t });
  check('un golpe de 80 ms en la mesa no dispara', disparos === 0);
  let primero = null;
  for (let i = 0; i < 30; i++, t += 20) {
    const ang = Math.min(60, i * 4) * (Math.PI / 180);
    const r = d.procesar({ x: 9.8 * Math.sin(ang), y: g.y, z: 9.8 * Math.cos(ang), t });
    if (r.disparo && primero === null) primero = { i, ...r };
  }
  check('levantarlo e inclinarlo dispara', primero !== null, primero ? `${primero.angulo.toFixed(0)}°, ${primero.desvio.toFixed(1)} m/s²` : '');
}

seccion('Firmware y página usan el mismo protocolo');
{
  const ino = readFileSync(new URL('../esp32/alarma_silbido/alarma_silbido.ino', import.meta.url), 'utf8');
  check('UUID del servicio', ino.includes(UUID_SERVICIO));
  check('UUID de evento', ino.includes(UUID_EVENTO));
  check('UUID de estado', ino.includes(UUID_ESTADO));
  check('el firmware prueba el mismo vector HMAC', ino.includes('"bdab41943d25082d"') && ino.includes('"secreto-de-prueba-123"'));
  const dspA = readFileSync(new URL('../esp32/alarma_silbido/silbido_dsp.h', import.meta.url), 'utf8');
  const dspB = readFileSync(new URL('../esp32/reconocedor_autonomo/silbido_dsp.h', import.meta.url), 'utf8');
  check('silbido_dsp.h de la alarma es igual al del reconocedor', dspA === dspB);
  const perfil = readFileSync(new URL('../esp32/alarma_silbido/perfil.h', import.meta.url), 'utf8');
  check('perfil.h trae un perfil Armar y uno Desarmar', /\{"[^"]*Desarmar[^"]*",/i.test(perfil) && /\{"(?![^"]*Desarm)[^"]*Armar[^"]*",/i.test(perfil));
  const ign = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  check('secreto.h está en .gitignore', ign.includes('secreto.h'));
}

console.log(`\n${pasa} pruebas correctas, ${falla} fallidas`);
process.exit(falla ? 1 : 0);
