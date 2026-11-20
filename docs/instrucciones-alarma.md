# Instrucciones: alarma antirrobo para el celular activada por silbidos

> **Estado: implementado** en `esp32/alarma_silbido/`, `alarma.html`, `js/alarma/` y `tests/alarma.test.mjs`. La guía de uso está en [`esp32/README.md`](../esp32/README.md#alarma_silbido-alarma-antirrobo-para-el-celular). Este documento queda como la especificación con la que se construyó. Decisiones tomadas: Android + Bluetooth, ESP32 junto al celular o con el dueño (el firmware es el mismo), sin clave de emergencia.

Este documento es para quien va a implementar la alarma dentro del proyecto **Silbido ID**. Explica qué hay que construir, qué partes del repositorio se reutilizan, cómo deben comportarse el firmware y la página web, y cómo saber que el trabajo está terminado.

- Repositorio: https://github.com/santiagoeduardocavadia-cmyk/silbido-id
- Web publicada: https://santiagoeduardocavadia-cmyk.github.io/silbido-id/

---

## 1. Objetivo

Proteger un celular que se deja cargando en un lugar público (por ejemplo, la zona de cargadores de la universidad) mientras el dueño está lejos.

1. El dueño **silba una melodía "Armar"** al micrófono del protoboard. La ESP32 reconoce que es **su** silbido de armar y le avisa al celular **sin cables** (Bluetooth; WiFi si el celular es iPhone, ver §4).
2. El celular queda **armado**. Si alguien **lo levanta** o **lo desconecta del cargador**, suena una **sirena fuerte**.
3. Cuando el dueño vuelve, **silba otra melodía distinta, "Desarmar"**. La ESP32 la reconoce y le avisa al celular, que se desarma. Ahora el dueño puede tomarlo sin que suene.

Reglas clave:

- **El celular NO escucha**: no usa su micrófono. Todo el reconocimiento lo hace la ESP32 con el micrófono del protoboard.
- Solo los silbidos **del dueño** arman y desarman. Otra persona que silbe, aunque imite la melodía, **no** debe poder desarmarla (se usa la verificación del proyecto en modo estricto).
- Nadie debe poder desarmarla **fingiendo el mensaje** desde otro aparato Bluetooth (los mensajes van firmados, ver §6.4).

---

## 2. Qué existe hoy en el repositorio

Leer primero: `README.md`, `esp32/README.md` y `docs/informe-tecnico.md`.

| Pieza | Dónde está | Qué hace | Cómo se usa en la alarma |
|---|---|---|---|
| Web Silbido ID | `index.html`, `js/` | Graba silbidos, crea perfiles (huellas), verifica con DTW + red neuronal, tiempo real. | Para **crear los dos perfiles** (Armar y Desarmar) y **exportarlos** a la ESP32. |
| Exportación a ESP32 | `js/esp32.js` (`profilesToHeader`) y botón *Perfiles → ESP32 autónoma (perfil.h)* | Genera `perfil.h` con 1 a 4 perfiles (filtro + huella). | Se exportan los perfiles **Armar** y **Desarmar**. |
| Reconocedor autónomo | `esp32/reconocedor_autonomo/` (`reconocedor_autonomo.ino`, `silbido_dsp.h`, `perfil.h`) | Escucha todo el tiempo, detecta un silbido, lo analiza con la misma cadena que la web y lo compara con los perfiles. **Lee del INMP441 por I2S.** | Se reutiliza **toda la lógica de reconocimiento** (`silbido_dsp.h`, la función `decidir()`, el disparo por energía y pureza). |
| Firmware ADC | `esp32/silbido_adc/silbido_adc.ino` | Lee el micrófono comercial + LM358 por el **ADC (GPIO34) a 64 kHz**, FIR anti-aliasing y diezmado ×4 a 16 kHz. | Se reutiliza **la entrada de audio**: `iniciarAdc()`, `disenarFir()`, `entrada64k()`. |
| Circuito del micrófono | `hardware/electret.html` | Módulo de sonido + LM358 ×47, VREF 1,65 V, salida a GPIO34. | Es el hardware que se usa. **Ver requisito previo §5.** |
| Pruebas | `tests/dsp.test.mjs` (`npm test`, 85 pruebas) | Núcleo DSP, exportación, etc. | No deben romperse. Se agregan pruebas nuevas. |

El micrófono que se usa es el **módulo de sonido + LM358** (el INMP441 del dueño se dañó). La ESP32 es una **ESP32 clásica (ESP32-WROOM-32, "ESP32 Dev Module")**: en Arduino IDE hay que elegir exactamente esa placa, no S2/S3/C3.

---

## 3. Arquitectura

```
                        ESP32 (protoboard)                                       Celular (cargando)
┌──────────────────────────────────────────────────────────┐          ┌──────────────────────────────────┐
│ módulo de sonido → LM358 ×47 → GPIO34                     │          │ página alarma.html (Chrome)       │
│   → ADC 64 kHz → FIR 7 kHz + diezmado ×4 → 16 kHz         │          │                                  │
│   → motor de silbido_dsp.h (filtro, f0, huella, DTW)      │   BLE    │  recibe ARMAR / DESARMAR firmado │
│   → ¿es "Armar" o "Desarmar" del dueño? (rigurosidad 0,8) │ ───────► │  sensor de movimiento            │
│   → mensaje firmado (HMAC + contador)                     │          │  desconexión del cargador        │
│   → LED de la placa confirma                              │          │  pantalla siempre encendida      │
└──────────────────────────────────────────────────────────┘          │  🔊 sirena + vibración           │
                                                                       └──────────────────────────────────┘
```

La ESP32 **solo reconoce y avisa**. La lógica de la alarma (estados, sensores, sirena) vive en el celular.

---

## 4. Decisiones pendientes (confirmar con el dueño antes de empezar)

| Pregunta | Valor por defecto si no hay respuesta | Alternativa |
|---|---|---|
| ¿El celular es Android o iPhone? | **Android + Chrome → Bluetooth (BLE) con Web Bluetooth.** La página puede quedar en GitHub Pages (HTTPS). | **iPhone**: Safari no tiene Web Bluetooth. Se usa **WiFi**: la ESP32 crea su propia red (`SilbidoAlarma`), sirve la página desde la propia ESP32 y manda los eventos por *Server-Sent Events*. El celular pierde internet mientras está conectado. Implementar solo si el dueño confirma que es iPhone. |
| ¿Dónde se deja la ESP32? | **Junto al celular**, con alimentación USB o power bank. El dueño silba al protoboard al irse y al volver. | **Con el dueño, como control remoto**: funciona igual mientras esté a menos de ~10–20 m (alcance de BLE en interiores). El firmware no cambia. |
| ¿Clave de emergencia en el celular? | **No** (solo se desarma con el silbido). | Clave de **8 o más dígitos** para desarmar si la ESP32 se queda sin batería. Si se agrega, después de 3 intentos fallidos debe sonar la sirena. |

---

## 5. Requisito previo de hardware (lo hace el dueño, pero hay que verificarlo)

El reconocimiento no funciona si la señal llega recortada. Con el firmware `silbido_adc` cargado y el Monitor Serie a 921600 baudios, comando `N`:

- **En silencio:** `adc_crudo` debe estar entre **1900 y 2100** (≈ 1,65 V). Hoy está en ~3570 (≈ 2,8 V): **mal centrado**.
- Causa más probable: la continua del pin AO entra al amplificador. Revisar que **C2 (47 nF) esté en serie: AO → C2 → R2 → pin 2**, sin puentes, y que los pines 1, 2 y 3 del LM358 midan ~1,65 V.
- Al silbar, `entrada` y `filtrada` suben juntas y `recorte` se queda en −60.

**No empezar las pruebas de reconocimiento hasta que `adc_crudo` esté centrado.**

---

## 6. Tareas

Trabajar en una rama nueva: `feat/alarma-silbido`. **No subir directo a `main`**; al final se abre un Pull Request (§9).

### 6.1 Perfiles "Armar" y "Desarmar"

1. Cargar `esp32/silbido_adc` en la ESP32 y, en la web, usar **Grabar → Usar ESP32 (USB)**. Los perfiles se graban **con el mismo micrófono** que va a usar la alarma (es importante: la pureza y la SNR cambian entre micrófonos).
2. Grabar 5 tomas de la melodía **Armar** y guardar el perfil con el nombre `Armar`. Repetir con una melodía **claramente distinta** (otro ritmo y otra forma, por ejemplo una que sube y otra que baja) y guardarla como `Desarmar`.
3. Comprobar en **Verificar** (1:1, rigurosidad **Estricta**) que:
   - la melodía Armar se acepta contra `Armar` y se **rechaza** contra `Desarmar`;
   - la melodía Desarmar se acepta contra `Desarmar` y se **rechaza** contra `Armar`;
   - otra persona silbando cualquiera de las dos se rechaza.
   Si las dos melodías se confunden, cambiar una de ellas.
4. Exportar los dos perfiles con **Perfiles → ESP32 autónoma (perfil.h)** (o `node scripts/esp32-perfiles.mjs armar.json desarmar.json`). Guardar el resultado como `esp32/alarma_silbido/perfil.h`.

### 6.2 Firmware nuevo `esp32/alarma_silbido/`

Crear la carpeta con `alarma_silbido.ino`, una copia de `silbido_dsp.h` (o incluirlo con ruta relativa si compila) y `perfil.h`.

**Entrada de audio (del firmware ADC):**
- Copiar de `silbido_adc.ino`: `iniciarAdc()`, `disenarFir()` y la lógica de `entrada64k()` (ADC a 64 kHz, FIR de 63 coeficientes, diezmado ×4).
- Cada muestra diezmada a 16 kHz, **después de quitarle la continua** (el mismo bloqueo de DC de `procesar16k()`), se pasa a `motor.alimentar(x)` en lugar de la muestra del I2S. El motor espera valores en el rango −1…1, igual que la conversión `(raw >> 8) / 8388608.0f` del I2S. Ajustar la escala si hace falta para que un silbido normal quede entre 0,05 y 0,5 de pico.
- Quitar todo lo de I2S y la selección de canal del reconocedor autónomo.

**Reconocimiento (del reconocedor autónomo):**
- Reutilizar el disparo (`DISPARO_DB`, `DISPARO_PUREZA`, `DISPARO_TRAMAS`), la ventana de 5 s con pre-roll y `decidir()`.
- `RIGUROSIDAD = 0.8f` (estricta).
- En `decidir()`: se acepta un perfil solo si **es aceptado y es el único aceptado**, o si su distancia `D` es claramente menor que la del otro (por ejemplo `D_mejor < 0,6 · D_otro`). Si los dos se aceptan con distancias parecidas, **no se envía nada** (es ambiguo).
- Según el nombre del perfil ganador (`PERFILES[i].nombre`), el evento es `ARMAR` o `DESARMAR`.

**Bluetooth (BLE):** usar la librería BLE que trae el núcleo esp32 de Espressif 3.x (`BLEDevice.h`). No agregar librerías externas.
- Nombre del dispositivo: `SilbidoAlarma`.
- Un servicio propio con dos características (generar los UUID una vez y dejarlos como constantes documentadas):
  - **`evento`** (read + notify): el último mensaje, en JSON corto (ver §6.4).
  - **`estado`** (write): el celular escribe `ARMADA`, `DESARMADA` o `SONANDO` para que la ESP32 lo muestre con el LED.
- Al desconectarse el celular, volver a anunciarse (advertising) automáticamente.

**Indicadores en la placa (LED de GPIO2):**
- Silbido reconocido como Armar: 2 parpadeos largos. Como Desarmar: 4 parpadeos cortos. No reconocido: 1 parpadeo de 700 ms.
- Sin celular conectado: un destello breve cada 2 s. Estado `ARMADA`: encendido fijo. `SONANDO`: parpadeo rápido.
- Opcional: un buzzer en GPIO4 que pite al reconocer (útil si la ESP32 está con el dueño).

**Monitor Serie a 115200 baudios** con mensajes en texto para depurar: piso de ruido, disparos, distancias D de cada perfil, evento enviado, estado del enlace. Mantener el comando `N` de nivel (como en `silbido_adc`) para revisar `adc_crudo`.

### 6.3 Página del celular `alarma.html`

Página nueva en la raíz del repo (`alarma.html` + `js/alarma/*.js` + estilos en `css/`), en español, con el mismo estilo visual del proyecto (tokens de `css/styles.css`, tema claro/oscuro). Enlazarla desde el encabezado de `index.html`. **Sin librerías externas**, igual que el resto del proyecto.

**Pantalla:**
- Botón grande **"Conectar con la ESP32"** (Web Bluetooth, filtro por nombre `SilbidoAlarma`).
- Estado enorme y legible de lejos: **DESARMADA** (gris), **ARMANDO… 10** (cuenta atrás), **ARMADA** (azul), **¡ALERTA! 3** (pre-aviso), **SONANDO** (rojo parpadeante).
- Indicadores pequeños: Bluetooth conectado/desconectado, cargador conectado/desconectado, batería, último evento recibido con hora.
- Registro de eventos (últimos 20).
- Instrucciones para **fijar la pantalla**: Android, *Ajustes → Seguridad → Fijar app*.

**Máquina de estados** (un módulo puro, sin DOM, para poder probarlo en Node):

| Estado | Evento | Siguiente estado |
|---|---|---|
| DESARMADA | `ARMAR` válido | ARMANDO (10 s para alejarse) |
| ARMANDO | pasan 10 s | ARMADA |
| ARMANDO | `DESARMAR` válido | DESARMADA |
| ARMADA | movimiento **o** cargador desconectado | ALERTA (3 s de pre-aviso con pitidos) |
| ALERTA | pasan 3 s | SONANDO |
| ALERTA / SONANDO / ARMADA | `DESARMAR` válido | DESARMADA (la sirena se apaga) |
| cualquiera | se pierde el Bluetooth | **se mantiene el estado**, se muestra el aviso y se intenta reconectar |

Mientras está en ARMANDO, el movimiento **no** dispara (el dueño puede estar acomodando el celular).

**Detección de robo:**
- **Movimiento** con `DeviceMotionEvent`: comparar la aceleración con la de reposo medida al armar. Dispara si `|a − a_reposo| > 1,5 m/s²` durante más de 200 ms, o si la orientación cambia más de 20°. Ajustar para que una vibración de la mesa no dispare. En iPhone hay que pedir permiso con `DeviceMotionEvent.requestPermission()` desde un toque del usuario.
- **Cargador** con `navigator.getBattery()` y el evento `chargingchange` (en Android/Chrome; si la API no existe, ocultar el indicador).
- **Pantalla encendida** con `navigator.wakeLock.request('screen')`, y volver a pedirla al regresar la pestaña al frente (`visibilitychange`).

**Sirena:**
- Web Audio: oscilador que barre entre ~700 y ~1600 Hz unas 4 veces por segundo, ganancia al máximo. El `AudioContext` se crea en el toque del botón "Conectar" (los navegadores bloquean el audio sin un gesto del usuario).
- `navigator.vibrate([500, 200, 500…])` en bucle (Android).
- La pantalla parpadea en rojo.
- Pre-aviso (ALERTA): pitidos cortos.
- Pedir al dueño que suba el volumen al máximo; mostrar un aviso si el estado es ARMADA y la página no está a pantalla completa.

### 6.4 Formato y seguridad de los mensajes

Cada evento que envía la ESP32 es un JSON corto:

```json
{"ev":"ARMAR","n":42,"d":0.31,"tok":"9f2c1a7be04d33aa"}
```

- `ev`: `ARMAR` o `DESARMAR`.
- `n`: contador que **siempre aumenta**. Se guarda en la memoria no volátil de la ESP32 (`Preferences`) para que no se repita después de un reinicio.
- `d`: distancia D del perfil ganador (para mostrarla en el registro).
- `tok`: los primeros 8 bytes, en hexadecimal, de **HMAC-SHA256(secreto, `ev + ":" + n`)**. En la ESP32 se calcula con mbedTLS (incluido en el núcleo); en la página, con `crypto.subtle`.

El **secreto** es un texto de al menos 16 caracteres que se define en el firmware (constante en un archivo `secreto.h` que **no** se sube al repositorio: agregarlo a `.gitignore` y dejar un `secreto.ejemplo.h`) y que el dueño escribe una sola vez en la página (se guarda en `localStorage`).

La página **rechaza** un mensaje si el `tok` no coincide o si `n` no es mayor que el último aceptado (también guardado en `localStorage`). Así nadie puede desarmarla repitiendo un mensaje grabado o enviando uno inventado.

### 6.5 Simulador para probar sin hardware

En `alarma.html?demo=1` mostrar botones para simular: "ESP32: ARMAR", "ESP32: DESARMAR", "mensaje falso", "levantar el celular" y "desconectar el cargador". Los mensajes simulados deben pasar por la misma verificación de §6.4, firmados con el secreto. El de "mensaje falso" va mal firmado y debe ser rechazado.

---

## 7. Pruebas

1. **Node** (`tests/alarma.test.mjs`, y agregarlo a `npm test`):
   - todas las transiciones de la tabla de §6.3, con un reloj falso;
   - el movimiento no dispara en ARMANDO ni en DESARMADA;
   - un `tok` incorrecto se rechaza; un `n` repetido o menor se rechaza; un mensaje válido se acepta;
   - el HMAC calculado en JS coincide con un vector de prueba fijo (documentar el mismo vector en el firmware).
   - **Las 85 pruebas existentes deben seguir pasando.**
2. **Compilar el firmware** sin abrir el IDE, con el `arduino-cli` que trae Arduino IDE:
   `"%LOCALAPPDATA%\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe" compile --fqbn esp32:esp32:esp32 esp32/alarma_silbido`
   Comprobar que tampoco se rompen `silbido_adc` ni `reconocedor_autonomo`.
3. **Navegador** con `?demo=1`: recorrer todos los estados y comprobar que la sirena suena y se apaga.
4. **Prueba real** (con el circuito ya centrado):
   - silbar Armar → el LED de la ESP32 confirma y el celular pasa a ARMANDO y luego ARMADA;
   - levantar el celular → pre-aviso de 3 s → sirena;
   - silbar Desarmar durante la sirena → se apaga;
   - otra persona silba las melodías → no arma ni desarma;
   - hablar, aplaudir o poner música cerca → no arma ni desarma;
   - alejarse con la ESP32 hasta perder el Bluetooth → el celular mantiene el estado y avisa que perdió la conexión; al volver, reconecta solo.
   Anotar en el PR los resultados (cuántos intentos de cada caso y cuántos funcionaron).

---

## 8. Criterios de aceptación (checklist)

- [ ] `esp32/alarma_silbido/` compila para "ESP32 Dev Module" (núcleo esp32 3.x) y lee el micrófono por GPIO34.
- [ ] Reconoce las melodías Armar y Desarmar del dueño y envía el evento por BLE en menos de ~2 s después de terminar de silbar.
- [ ] Rechaza silbidos de otra persona, voz, aplausos y música.
- [ ] `alarma.html` se conecta a la ESP32 desde Chrome en Android y muestra el estado de forma legible a 2 m.
- [ ] Armada, levantar el celular o desconectarlo del cargador dispara el pre-aviso y luego la sirena.
- [ ] El silbido Desarmar apaga la sirena en cualquier momento.
- [ ] Los mensajes mal firmados o repetidos se rechazan (prueba con el simulador).
- [ ] Si se pierde el Bluetooth, la alarma no se desarma sola.
- [ ] `npm test` pasa completo (las 85 pruebas actuales + las nuevas).
- [ ] El secreto no está en el repositorio.
- [ ] Documentación actualizada: sección nueva en `esp32/README.md` (conexión, carga, uso) y enlace en `README.md`.

---

## 9. Entrega

1. Commits pequeños y descriptivos en español en la rama `feat/alarma-silbido`.
2. Abrir un **Pull Request hacia `main`** con: qué se hizo, cómo probarlo, los resultados de la prueba real (§7.4) y las decisiones tomadas de §4.
3. No fusionar sin que el dueño lo pruebe. Al fusionar, GitHub Pages publica `alarma.html` solo (tarda 1–2 minutos).

---

## 10. Limitaciones que hay que dejar claras al dueño

- Es una **alarma disuasiva para uso personal**, no un sistema de seguridad certificado.
- La página debe quedar **abierta, al frente y con la pantalla encendida**; si el celular se bloquea, deja de vigilar. Por eso se recomienda fijar la pantalla.
- El alcance del Bluetooth es corto (~10–20 m en interiores).
- En ambientes muy ruidosos hay que silbar cerca del micrófono del protoboard (10–30 cm).
- Un silbido no es tan único como una huella dactilar: alguien que imite muy bien la melodía y el tono podría ser aceptado. La rigurosidad estricta y las dos melodías distintas reducen ese riesgo.
