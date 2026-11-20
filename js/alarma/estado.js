/**
 * Máquina de estados de la alarma (sin DOM: se prueba en Node con un reloj falso).
 *
 *   DESARMADA ──ARMAR──► ARMANDO ──10 s──► ARMADA ──movimiento / cargador──► ALERTA ──3 s──► SONANDO
 *        ▲                  │                 │                                │               │
 *        └─────────────────────── DESARMAR (en cualquier estado) ─────────────┴───────────────┘
 *
 * Perder el Bluetooth NO cambia el estado: si estaba armada, sigue armada.
 */

export const ESTADOS = Object.freeze({
  DESARMADA: 'DESARMADA',
  ARMANDO: 'ARMANDO',
  ARMADA: 'ARMADA',
  ALERTA: 'ALERTA',
  SONANDO: 'SONANDO',
});

export const EVENTOS = Object.freeze({
  ARMAR: 'ARMAR',
  DESARMAR: 'DESARMAR',
  MOVIMIENTO: 'MOVIMIENTO',
  CARGADOR: 'CARGADOR',
});

export function crearAlarma({ tiempoArmado = 10000, tiempoAlerta = 3000, ahora = () => Date.now(), alCambiar = () => {} } = {}) {
  let estado = ESTADOS.DESARMADA;
  let hasta = 0;
  let motivo = '';

  const cambiar = (nuevo, porque = '') => {
    if (nuevo === estado) return;
    const antes = estado;
    estado = nuevo;
    motivo = porque;
    hasta = nuevo === ESTADOS.ARMANDO ? ahora() + tiempoArmado : nuevo === ESTADOS.ALERTA ? ahora() + tiempoAlerta : 0;
    alCambiar({ estado, antes, motivo });
  };

  return {
    get estado() {
      return estado;
    },
    get motivo() {
      return motivo;
    },
    /** Milisegundos que faltan para el siguiente paso automático (ARMANDO y ALERTA). */
    restante() {
      return hasta ? Math.max(0, hasta - ahora()) : 0;
    },
    /** Procesa un evento. Devuelve true si cambió el estado. */
    evento(ev, detalle = '') {
      const antes = estado;
      switch (ev) {
        case EVENTOS.ARMAR:
          if (estado === ESTADOS.DESARMADA) cambiar(ESTADOS.ARMANDO, detalle || 'silbido Armar');
          break;
        case EVENTOS.DESARMAR:
          if (estado !== ESTADOS.DESARMADA) cambiar(ESTADOS.DESARMADA, detalle || 'silbido Desarmar');
          break;
        case EVENTOS.MOVIMIENTO:
        case EVENTOS.CARGADOR:
          if (estado === ESTADOS.ARMADA) cambiar(ESTADOS.ALERTA, detalle || (ev === EVENTOS.MOVIMIENTO ? 'movieron el celular' : 'desconectaron el cargador'));
          break;
        default:
          break;
      }
      return estado !== antes;
    },
    /** Avanza los temporizadores. Llamar seguido (cada 100–250 ms). */
    tick() {
      if (!hasta || ahora() < hasta) return false;
      if (estado === ESTADOS.ARMANDO) cambiar(ESTADOS.ARMADA, 'tiempo para alejarse cumplido');
      else if (estado === ESTADOS.ALERTA) cambiar(ESTADOS.SONANDO, motivo);
      return true;
    },
  };
}
