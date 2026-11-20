/**
 * Sonidos de la alarma con Web Audio (sin archivos): sirena, pitidos de pre-aviso y confirmaciones.
 * El AudioContext se crea en un toque del usuario (los navegadores bloquean el audio sin un gesto).
 */

export function crearSirena() {
  let ctx = null;
  let sirena = null;
  let pitidos = null;
  let vibrar = null;

  const asegurar = () => {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  };

  function tono(frec, inicio, dur, vol = 0.6, tipo = 'square') {
    const c = asegurar();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = tipo;
    o.frequency.value = frec;
    g.gain.setValueAtTime(0, inicio);
    g.gain.linearRampToValueAtTime(vol, inicio + 0.01);
    g.gain.setValueAtTime(vol, inicio + dur - 0.02);
    g.gain.linearRampToValueAtTime(0, inicio + dur);
    o.connect(g).connect(c.destination);
    o.start(inicio);
    o.stop(inicio + dur + 0.02);
  }

  // El navegador solo deja vibrar después de que el usuario tocó la página.
  const puedeVibrar = () => !!navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive);
  const vibrarCada = (patron, cada) => {
    if (!puedeVibrar()) return null;
    navigator.vibrate(patron);
    return setInterval(() => puedeVibrar() && navigator.vibrate(patron), cada);
  };

  return {
    /** Llamar en un toque del usuario para habilitar el audio. */
    activar() {
      asegurar();
      tono(1, asegurar().currentTime, 0.03, 0.0001, 'sine');
    },
    /** Sirena: barrido entre ~700 y ~1600 Hz, 4 veces por segundo, al máximo volumen. */
    sonar() {
      if (sirena) return;
      const c = asegurar();
      const osc = c.createOscillator();
      const lfo = c.createOscillator();
      const prof = c.createGain();
      const vol = c.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = 1150;
      lfo.type = 'triangle';
      lfo.frequency.value = 4;
      prof.gain.value = 450;
      vol.gain.value = 1;
      lfo.connect(prof).connect(osc.frequency);
      osc.connect(vol).connect(c.destination);
      osc.start();
      lfo.start();
      sirena = { osc, lfo };
      vibrar = vibrarCada([600, 200], 800);
    },
    /** Pre-aviso: pitidos cortos cada medio segundo. */
    pitar() {
      if (pitidos) return;
      const uno = () => {
        const t = asegurar().currentTime;
        tono(2000, t, 0.12, 0.5);
      };
      uno();
      pitidos = setInterval(uno, 500);
      if (puedeVibrar()) navigator.vibrate(150);
    },
    callar() {
      if (sirena) {
        sirena.osc.stop();
        sirena.lfo.stop();
        sirena = null;
      }
      if (pitidos) clearInterval(pitidos);
      pitidos = null;
      if (vibrar) clearInterval(vibrar);
      vibrar = null;
      if (puedeVibrar()) navigator.vibrate(0);
    },
    /** Confirmación al armar: dos tonos que suben. */
    confirmarArmado() {
      const t = asegurar().currentTime;
      tono(880, t, 0.14, 0.4, 'sine');
      tono(1320, t + 0.18, 0.2, 0.4, 'sine');
    },
    /** Confirmación al desarmar: dos tonos que bajan. */
    confirmarDesarmado() {
      const t = asegurar().currentTime;
      tono(1320, t, 0.14, 0.4, 'sine');
      tono(660, t + 0.18, 0.24, 0.4, 'sine');
    },
    /** Error (mensaje rechazado). */
    error() {
      const t = asegurar().currentTime;
      tono(220, t, 0.3, 0.4, 'square');
    },
  };
}
