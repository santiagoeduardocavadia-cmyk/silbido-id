# Silbido ID en la ESP32

Hay dos firmwares:

| Carpeta | Qué hace | Cuándo usarlo |
|---|---|---|
| **`silbido_id/`** (principal) | La ESP32 **filtra** la señal del INMP441 (bloqueo de DC + pasa-banda + ganancia con limitador) y la manda por USB. La web identifica. | Siempre que uses la web. |
| `reconocedor_autonomo/` | La ESP32 hace toda la cadena sola (filtro, f₀, huella, DTW) y enciende un LED o un relé. | Si quieres un sistema sin computador. |

El funcionamiento completo, con la teoría de los filtros, está en [`../docs/informe-tecnico.md`](../docs/informe-tecnico.md). Las conexiones están en [`../hardware/index.html`](../hardware/index.html).

## `silbido_id/`: la ESP32 como micrófono filtrado

```
INMP441 ─I2S 16 kHz─► ESP32: bloqueo DC → pasa-banda (filtro.h) → ganancia + limitador ─USB 921600─► web
```

1. Arduino IDE → Gestor de tarjetas → **esp32 de Espressif 3.x**. Placa: **ESP32 Dev Module**.
2. Abre `silbido_id/silbido_id.ino` y súbelo.
3. Para probarlo sin la web, abre el **Trazador Serie a 921600 baudios** y escribe `N`. Verás dos curvas en dBFS: **entrada** (cruda) y **filtrada**. Al silbar deben subir juntas; al hablar o golpear la mesa, la filtrada queda abajo.
4. En la web (Chrome o Edge): **Grabar → Usar ESP32 (USB)**, elige el puerto y listo. Grabar, el espectrograma en vivo, Verificar y el tiempo real usan el audio filtrado por la placa.

### El filtro (`filtro.h`)

- Por defecto trae un **Butterworth de orden 6, 400–7000 Hz**. Atenúa 50 dB a 60 Hz y 32 dB a 120 Hz, y deja intacto todo el rango de silbido.
- Para usar **el filtro que la auto-sintonía eligió para tu silbido**, tienes dos caminos:
  - en la web, *Perfiles → Filtro ESP32* (o *Filtro → Exportar filtro para ESP32*); reemplaza `silbido_id/filtro.h` y vuelve a subir;
  - o por consola: `node scripts/esp32-filtro.mjs silbido-tu-nombre.json`. Sin argumentos regenera el pre-filtro por defecto.

### Comandos (Monitor Serie a 921600)

| Tecla | Acción |
|---|---|
| `N` | Medidor de nivel entrada vs. filtrada (Trazador Serie) |
| `S` / `X` | Empezar / detener el envío de audio (lo hace la web sola) |
| `I` | Información en JSON (filtro, banda, ganancia, canal) |
| `+` / `-` | Ganancia ±3 dB (por defecto +12 dB) |
| `H` | Ayuda |

### Protocolo

Cada 10 ms se envía una trama: `A5 5A | secuencia | n=160 | estado | 160 × int16 LE | suma`. Son 32,6 kB/s, el 35 % de lo que da el enlace a 921600 baudios. La web reconstruye las tramas aunque lleguen partidas, descarta las corruptas y cuenta las perdidas.

## `silbido_adc/`: micrófono comercial (módulo de sonido + LM358)

Es la alternativa al INMP441, con piezas que se consiguen en cualquier tienda. El circuito, con su esquemático y el montaje en baquela perforada, está en [`../hardware/electret.html`](../hardware/electret.html).

```
módulo de sonido (AO) → LM358 ×47, 340 Hz–7,2 kHz → GPIO34 → ADC a 64 kHz → FIR 7 kHz + diezmado ×4 → 16 kHz → DC + filtro.h → USB
```

- Usa el mismo protocolo y los mismos comandos que `silbido_id`: en la web se usa igual, con **Usar ESP32 (USB)**.
- Con `N` en el Monitor Serie, además del nivel, muestra `adc_crudo` (debe rondar el centro, ~1,65 V) y `fs_adc` (debe dar ~64000).
- La ganancia digital empieza en 0 dB, porque el LM358 ya amplifica ×47.

## `reconocedor_autonomo/`

Es el firmware completo de reconocimiento dentro de la ESP32. Incluye la FFT doble (dos pistas en una FFT compleja), el DTW con dos filas y el comando `p` para comparar el resultado con la web usando un audio embebido. Los perfiles se exportan desde la web en *Perfiles → ESP32 autónoma (perfil.h)*, o con `npm run esp32`.
