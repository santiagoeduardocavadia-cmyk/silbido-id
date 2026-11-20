/**
 * Detector de "levantaron el celular" a partir del acelerómetro (accelerationIncludingGravity).
 * Sin DOM: recibe muestras {x, y, z, t} y decide.
 *
 *  1. Calibración: al armar, promedia ~1 s de muestras → vector de reposo a0 (la gravedad).
 *  2. Dispara si, durante al menos `minMs`, la aceleración se aparta de a0 más de `umbral` m/s²
 *     o la orientación gira más de `anguloMax` grados.
 *  Una vibración breve de la mesa no dura lo suficiente; levantarlo o girarlo sí.
 */

const norma = (v) => Math.hypot(v.x, v.y, v.z);

export function crearDetectorMovimiento({ umbral = 1.5, anguloMax = 20, minMs = 200, calibracionMs = 1000 } = {}) {
  let suma = { x: 0, y: 0, z: 0 };
  let n = 0;
  let t0 = null;
  let reposo = null;
  let desde = null;

  return {
    get calibrado() {
      return !!reposo;
    },
    reiniciar() {
      suma = { x: 0, y: 0, z: 0 };
      n = 0;
      t0 = null;
      reposo = null;
      desde = null;
    },
    /** Devuelve { disparo, desvio, angulo }. */
    procesar({ x, y, z, t }) {
      if (![x, y, z].every(Number.isFinite)) return { disparo: false, desvio: 0, angulo: 0 };
      if (!reposo) {
        if (t0 === null) t0 = t;
        suma = { x: suma.x + x, y: suma.y + y, z: suma.z + z };
        n++;
        if (t - t0 >= calibracionMs && n >= 5) reposo = { x: suma.x / n, y: suma.y / n, z: suma.z / n };
        return { disparo: false, desvio: 0, angulo: 0 };
      }
      const desvio = Math.hypot(x - reposo.x, y - reposo.y, z - reposo.z);
      const na = norma({ x, y, z });
      const nr = norma(reposo);
      const cos = na && nr ? (x * reposo.x + y * reposo.y + z * reposo.z) / (na * nr) : 1;
      const angulo = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
      const fuera = desvio > umbral || angulo > anguloMax;
      if (!fuera) desde = null;
      else if (desde === null) desde = t;
      return { disparo: fuera && t - desde >= minMs, desvio, angulo };
    },
  };
}
