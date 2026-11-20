# Silbido ID en la ESP32

Estos son los firmwares (además de `silbido_adc/` y `diagnostico/`, explicados más abajo):

| Carpeta | Qué hace | Cuándo usarlo |
|---|---|---|
| **`silbido_id/`** (principal) | La ESP32 **filtra** la señal del INMP441 (bloqueo de DC + pasa-banda + ganancia con limitador) y la manda por USB. La web identifica. | Siempre que uses la web. |
| `reconocedor_autonomo/` | La ESP32 hace toda la cadena sola (filtro, f₀, huella, DTW) y enciende un LED o un relé. | Si quieres un sistema sin computador. |
| `alarma_silbido/` | Con el módulo de sonido + LM358: reconoce tus silbidos **Armar** y **Desarmar** y se lo avisa por Bluetooth a la página `alarma.html` del celular. | Alarma antirrobo para el celular ([abajo](#alarma_silbido-alarma-antirrobo-para-el-celular)). |

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

## `alarma_silbido/`: alarma antirrobo para el celular

Dejas el celular cargando, silbas tu melodía **Armar** al micrófono del protoboard y el celular queda vigilando. Si alguien lo levanta o lo desconecta del cargador, suena una sirena. Al volver, silbas **Desarmar** antes de tomarlo.

```
módulo de sonido → LM358 → GPIO34 → ESP32: ADC 64 kHz → 16 kHz → motor de silbido_dsp.h → ¿Armar o Desarmar?
      → mensaje firmado {"ev":"ARMAR","n":42,"d":0.31,"tok":"…"} ─ Bluetooth (BLE) ─► alarma.html en el celular
                                                                                    (movimiento, cargador, sirena)
```

- **La ESP32 reconoce**: el celular no usa su micrófono.
- **El celular decide la alarma**: 10 s para alejarte al armar; si lo mueven, 3 s de pitidos y luego la sirena (más vibración y pantalla roja). Desarmar la apaga en cualquier momento. Si se pierde el Bluetooth, conserva su estado y se reconecta solo.
- **Seguridad**: cada orden va firmada con HMAC-SHA256 y un contador que solo aumenta. Un mensaje inventado o repetido se rechaza. Otra persona silbando no la desarma: la rigurosidad es estricta (T = 0,8) y, si el silbido se parece a los dos perfiles, no se envía nada.

### Paso 1 · El circuito
Es el de [`../hardware/electret.html`](../hardware/electret.html). Antes de seguir, comprueba con `silbido_adc` (comando `N`) que `adc_crudo` esté entre **1900 y 2100** en silencio. Si no está centrado, el reconocimiento falla.

### Paso 2 · Tus dos perfiles, grabados con este micrófono
1. Con `silbido_adc` cargado, en la web: **Grabar → Usar ESP32 (USB)**.
2. Graba 5 tomas de una melodía y guarda el perfil como **`Armar`**. Repite con otra melodía **claramente distinta** y guárdala como **`Desarmar`**. Los nombres deben contener esas palabras.
3. En **Verificar**, con rigurosidad **Estricta**, comprueba que cada melodía se acepta contra su perfil y se rechaza contra el otro.
4. Exporta cada perfil con el botón **Exportar** de su tarjeta en **Perfiles** (descarga `silbido-armar.json` y `silbido-desarmar.json`) y genera el archivo del firmware:
   ```bash
   npm run esp32:alarma -- silbido-armar.json silbido-desarmar.json
   ```
   Escribe `esp32/alarma_silbido/perfil.h`. Sin archivos, `npm run esp32:alarma` genera perfiles demo (Armar = Ana, Desarmar = Beto) solo para compilar y probar.

### Paso 3 · Tu secreto
Copia `alarma_silbido/secreto.ejemplo.h` como **`secreto.h`** en la misma carpeta y cambia el texto (mínimo 16 caracteres). `secreto.h` no se sube a GitHub.

### Paso 4 · Cargar el firmware
Arduino IDE → placa **ESP32 Dev Module** (esp32 de Espressif 3.x) → abre `alarma_silbido/alarma_silbido.ino` → **Subir**. En el Monitor Serie a **115200** debe aparecer `Autoprueba de la firma HMAC: correcta` y los dos perfiles marcados `← ARMAR` y `← DESARMAR`.

| Tecla | Acción |
|---|---|
| `n` | Nivel del micrófono y `adc_crudo` (debe rondar 2000 en silencio) |
| `m` | Monitor de tramas: f0, pureza, energía y piso de ruido |
| `g` (o botón BOOT) | Grabar 5 s ahora, sin esperar a que detecte el silbido |
| `a` / `d` | Enviar ARMAR / DESARMAR sin silbar (para probar el Bluetooth) |
| `i` / `h` | Información / ayuda |

LED de la placa: destello cada 2 s = esperando al celular · destello cada 1 s = conectado y desarmada · fijo = armada · parpadeo rápido = alerta o sirena · 2 parpadeos largos = reconoció Armar · 4 cortos = reconoció Desarmar · 1 largo = no era tu silbido. Un buzzer opcional en GPIO4 pita al reconocer.

### Paso 5 · El celular (Android con Chrome)
1. Abre **https://santiagoeduardocavadia-cmyk.github.io/silbido-id/alarma.html** (o el enlace **Alarma** de la web). Puedes agregarla a la pantalla de inicio desde el menú de Chrome.
2. Con el Bluetooth encendido, toca **Conectar con la ESP32** y elige **SilbidoAlarma**.
3. La primera vez, abre **Ajustes** y escribe el mismo secreto de `secreto.h`.
4. Pon el celular a cargar, sube el volumen, toca **Pantalla completa** y fija la app (*Ajustes → Seguridad → Fijar app*).
5. Silba **Armar** al protoboard. Al volver, silba **Desarmar** antes de tomar el celular.

Para probar sin la ESP32: **alarma.html?demo=1** muestra un simulador con mensajes firmados, un mensaje falso, uno repetido, "levantar el celular" y "desconectar el cargador".

**Límites:** la página debe quedar abierta y con la pantalla encendida (si bloqueas el celular, deja de vigilar). El Bluetooth web no existe en el Safari del iPhone. El alcance del Bluetooth es de unos 10–20 m en interiores. Es una alarma disuasiva de uso personal, no un sistema de seguridad certificado.
