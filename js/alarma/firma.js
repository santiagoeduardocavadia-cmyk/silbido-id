/**
 * Mensajes de la ESP32: {"ev":"ARMAR","n":42,"d":0.31,"tok":"…"}
 *   tok = primeros 8 bytes (hex) de HMAC-SHA256(secreto, "<ev>:<n>")
 * Se rechaza el mensaje si la firma no coincide o si n no es mayor que el último aceptado
 * (así no sirve repetir un mensaje grabado). Funciona en el navegador y en Node (crypto.subtle).
 */

const enc = new TextEncoder();
const VALIDOS = ['ARMAR', 'DESARMAR'];

export async function calcularToken(secreto, ev, n) {
  const clave = await crypto.subtle.importKey('raw', enc.encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const firma = new Uint8Array(await crypto.subtle.sign('HMAC', clave, enc.encode(`${ev}:${n}`)));
  return Array.from(firma.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function crearMensaje(secreto, ev, n, d = 0) {
  return JSON.stringify({ ev, n, d: Math.round(d * 100) / 100, tok: await calcularToken(secreto, ev, n) });
}

/**
 * Verifica un mensaje. Devuelve { ok, motivo, ev, n, d }.
 * Con { soloFirma: true } no exige que n sea nuevo (se usa al conectar para sincronizar el contador).
 */
export async function verificarMensaje(texto, { secreto, ultimoN = 0, soloFirma = false } = {}) {
  let m;
  try {
    m = JSON.parse(texto);
  } catch {
    return { ok: false, motivo: 'mensaje ilegible' };
  }
  if (!m || typeof m !== 'object' || !VALIDOS.includes(m.ev)) return { ok: false, motivo: 'evento desconocido' };
  if (!Number.isInteger(m.n) || m.n < 1) return { ok: false, motivo: 'contador inválido' };
  if (typeof m.tok !== 'string' || !/^[0-9a-f]{16}$/.test(m.tok)) return { ok: false, motivo: 'sin firma' };
  if (!secreto) return { ok: false, motivo: 'falta el secreto' };
  const esperado = await calcularToken(secreto, m.ev, m.n);
  if (esperado !== m.tok) return { ok: false, motivo: 'firma incorrecta (¿el secreto es el mismo de la ESP32?)', ev: m.ev, n: m.n };
  if (!soloFirma && m.n <= ultimoN) return { ok: false, motivo: `mensaje repetido (n = ${m.n}, último = ${ultimoN})`, ev: m.ev, n: m.n };
  return { ok: true, motivo: '', ev: m.ev, n: m.n, d: Number(m.d) || 0 };
}
