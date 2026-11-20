/**
 * Conexión con la ESP32 por Bluetooth Low Energy (Web Bluetooth: Chrome/Edge en Android y computador).
 * Los UUID son los mismos de esp32/alarma_silbido/alarma_silbido.ino.
 */

export const UUID_SERVICIO = 'a7c1f0e2-3b54-4c6d-8e9f-51b1d0a1a000';
export const UUID_EVENTO = 'a7c1f0e2-3b54-4c6d-8e9f-51b1d0a1a001';
export const UUID_ESTADO = 'a7c1f0e2-3b54-4c6d-8e9f-51b1d0a1a002';

const dec = new TextDecoder();
const enc = new TextEncoder();

export const bleDisponible = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

/**
 * Crea el enlace. Callbacks:
 *   alMensaje(texto)          cada notificación de la ESP32
 *   alInicial(texto)          el valor guardado en la ESP32 al conectar (para sincronizar el contador)
 *   alEstado(conectado, info) cambios de conexión
 */
export function crearEnlace({ alMensaje, alInicial, alEstado }) {
  let dispositivo = null;
  let chEstado = null;
  let reintento = 0;
  let cerrado = false;

  async function conectarGatt() {
    const server = await dispositivo.gatt.connect();
    const servicio = await server.getPrimaryService(UUID_SERVICIO);
    const chEvento = await servicio.getCharacteristic(UUID_EVENTO);
    chEstado = await servicio.getCharacteristic(UUID_ESTADO);
    chEvento.addEventListener('characteristicvaluechanged', (e) => alMensaje(dec.decode(e.target.value)));
    await chEvento.startNotifications();
    try {
      alInicial(dec.decode(await chEvento.readValue()));
    } catch {
      /* sin valor inicial */
    }
    reintento = 0;
    alEstado(true, dispositivo.name || 'ESP32');
  }

  async function reconectar() {
    if (cerrado || !dispositivo) return;
    alEstado(false, 'reconectando…');
    const espera = Math.min(15000, 1000 * 2 ** reintento++);
    await new Promise((r) => setTimeout(r, espera));
    if (cerrado) return;
    try {
      await conectarGatt();
    } catch {
      reconectar();
    }
  }

  return {
    get conectado() {
      return !!(dispositivo && dispositivo.gatt && dispositivo.gatt.connected);
    },
    /** Debe llamarse desde un toque del usuario (el navegador muestra la lista de dispositivos). */
    async conectar() {
      if (!bleDisponible()) throw new Error('Este navegador no tiene Bluetooth web. Usa Chrome en Android.');
      cerrado = false;
      dispositivo = await navigator.bluetooth.requestDevice({
        filters: [{ services: [UUID_SERVICIO] }, { namePrefix: 'Silbido' }],
        optionalServices: [UUID_SERVICIO],
      });
      dispositivo.addEventListener('gattserverdisconnected', () => {
        alEstado(false, 'se perdió la conexión');
        reconectar();
      });
      await conectarGatt();
    },
    /** Le dice a la ESP32 en qué estado está la alarma (para su LED). */
    async enviarEstado(estado) {
      if (!chEstado || !this.conectado) return;
      try {
        await chEstado.writeValueWithoutResponse(enc.encode(estado));
      } catch {
        /* no es crítico */
      }
    },
    desconectar() {
      cerrado = true;
      if (dispositivo && dispositivo.gatt.connected) dispositivo.gatt.disconnect();
    },
  };
}
