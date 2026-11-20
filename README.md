# Silbido ID 🎵

**Graba tu silbido, fíltralo, analízalo y crea tu huella. Después, cualquiera puede silbar y la web dice si es tu silbido o no.**

Proyecto del reto del silbido de **Procesamiento de Señales II**. Todo el procesamiento de señales (FFT, filtros IIR/FIR, STFT, wavelets, DTW) está programado a mano en JavaScript, sin librerías, y corre en el navegador: el audio nunca sale de tu equipo.

👉 **Pruébala aquí:** https://santiagoeduardocavadia-cmyk.github.io/silbido-id/

---

## ¿Qué hace?

| Pestaña | Qué ves |
|---|---|
| **1 · Grabar** | Eliges el micrófono (por ejemplo, audífonos USB-C), te escuchas en vivo, ves el espectrograma en tiempo real y grabas **5 tomas de 5 s**. La web puntúa cada toma y elige **la mejor**. |
| **2 · Análisis** | Para cualquier toma: señal original vs. filtrada, zoom de 20 ms, **espectro FFT**, **contorno de tono f₀(t)**, **espectrograma STFT** (ventana y solapamiento ajustables), **escalograma CWT (Morlet)** y **DWT Daubechies-4** con la energía por sub-banda. |
| **3 · Filtro** | **Auto-sintonía**: el sistema escucha tus tomas, mide en qué rango silbas y cómo es el ruido, prueba 51 filtros (**IIR Butterworth** de orden 4–12 y **FIR por ventanas** de 61–201 coeficientes) y deja fijo el mejor. No hay controles manuales, para no cortar el rango del silbido. Muestra la final IIR contra FIR, la respuesta en magnitud, el retardo de grupo, la respuesta al impulso, los **polos y ceros** y la exportación a **C para el ESP32**. |
| **4 · Perfiles** | Cada persona guarda su huella. **Nuevo perfil desde audios**: subes (o arrastras) de 3 a 5 silbidos y la web los analiza, elige el filtro y crea el perfil; un audio largo se parte en tomas de 5 s. Se puede **exportar/importar en `.json`** y **exportar para el ESP32**. Incluye perfiles de demostración. |
| **5 · Verificar** | Alguien silba y la web decide, en **verificación 1:1** ("¿es Ana?") o **identificación 1:N** ("¿quién silbó?"), con **dos modos**: **por filtros** (reglas fijas sobre la huella, D ≤ T) o **por inteligencia** (red neuronal propia), o **ambos** (solo acepta si coinciden). Tiene **identificación en tiempo real** mientras silbas y un botón **"Ver cómo lo identificó, paso a paso"** que recorre cada etapa con los números reales. |

¿No tienes micrófono? Usa los botones de **demostración**, que generan silbidos sintéticos de "Ana", "Beto" y un "imitador".

## Cadena de procesamiento

```
Micrófono (48 kHz) → re-muestreo a 16 kHz → filtro pasa-banda (1–4 kHz)
   → STFT (tramas de 64 ms, salto de 10 ms) → pico espectral + interpolación parabólica → f₀(t)
   → detección de actividad (pureza tonal + energía de 20 ms) → segmentos
   → huella: tono, rango, duración, segmentos, pureza, SNR, estabilidad
   → comparación: DTW sobre f₀(t) + distancias normalizadas → decisión
```

- **Filtro IIR Butterworth**: prototipo analógico → pasa-banda `s → (s² + Ω₀²)/(B·s)` → bilineal con pre-distorsión `Ω = 2·fs·tan(ω/2)` → secciones de segundo orden (biquads, forma directa II transpuesta).
- **Filtro FIR**: `h[n] = h_ideal[n − (M−1)/2] · w[n]`, fase lineal y retardo constante de (M−1)/2 muestras.
- **FFT**: radix-2 iterativa (Cooley–Tukey) con reordenamiento bit-reverso.
- **CWT**: Morlet calculada en frecuencia, `W_a = IFFT{X(ω)·Ψ*(aω)}` con `a = ω₀/(2πf)`.
- **DWT**: banco de filtros db4 (h pasa-bajos, g pasa-altos, diezmado ×2), 5 niveles.
- **DTW**: `D(i,j) = |aᵢ − bⱼ| + min{D(i−1,j), D(i,j−1), D(i−1,j−1)}` sobre el tono en semitonos.

### ¿Cómo decide?

El perfil se construye con las **3 mejores tomas** de 5. De ellas salen las **tolerancias τ** (la variabilidad propia de la persona). Cada característica se mide en esas unidades:

```
D = √( Σ wᵢ·(dᵢ/τᵢ)² / Σ wᵢ )      →  se acepta si D ≤ T (T = 1 por defecto)
Similitud = 100 · 2^(−(D/T)²)       →  50 % justo en el umbral
```

Los pesos son 3 para la forma de la melodía (DTW), 2 para el tono medio y 1 para la duración, los segmentos y la pureza tonal.

### Modo por inteligencia

Una red neuronal pequeña (perceptrón multicapa **22 → 24 → K+1**, tanh y softmax) programada a mano en `js/dsp/ai.js`, sin librerías:

- **Entrada**: 22 números por silbido: tono medio, rango, duración, segmentos, pureza, estabilidad y la forma de la melodía (contorno f₀ menos su mediana, re-muestreado a 16 puntos).
- **Salida**: una probabilidad por perfil y otra para **"desconocido"**. Se acepta si supera el 50, 60 o 75 % según la rigurosidad.
- **Entrenamiento** en el navegador, cada vez que cambian los perfiles (menos de 1 s): las tomas de referencia con variaciones realistas como positivos, e imitadores con otro tono, melodías cambiadas y silbidos al azar como "desconocido". Usa Adam, entropía cruzada con pesos por clase y semilla fija.
- **Explicación**: se "tapa" cada grupo de datos y se mide cuánto cambia la confianza de la red. Así se ve qué pesó más (melodía, tono…).

### Tiempo real

El micrófono alimenta un anillo de 5 s (re-muestreado a 16 kHz en el navegador). Cada 0,6 s, un filtro ancho localiza la última **frase** silbada (tramos separados por menos de 0,7 s), la recorta y la compara con los dos modos. Mientras sigues silbando, el resultado es provisional. Al terminar, se fija y se mantiene hasta el siguiente silbido.

## Ejecutar en tu computador

Necesitas [Node.js](https://nodejs.org/) (no hay dependencias que instalar):

```bash
npm start          # abre http://localhost:8000
npm test           # 85 pruebas: núcleo DSP, auto-sintonía, inteligencia, audios largos, USB y exportación al ESP32
npm run esp32:filtro  # regenera esp32/silbido_id/filtro.h (pre-filtro) o: node scripts/esp32-filtro.mjs perfil.json
npm run esp32      # perfiles del reconocedor autónomo: node scripts/esp32-perfiles.mjs perfil.json
```

> Los módulos ES y el micrófono necesitan `http://localhost` o `https://`. Abrir `index.html` con doble clic (`file://`) no funciona.

## Estructura

```
index.html            interfaz (5 pestañas)
css/styles.css        estilos, tema claro/oscuro
js/dsp/               núcleo de señales (sin dependencias, también corre en Node)
  fft.js              FFT radix-2, ventanas, espectro
  filters.js          Butterworth IIR, FIR por ventanas, respuesta en frecuencia, raíces, exportación a C
  stft.js             STFT / espectrograma
  wavelet.js          CWT Morlet y DWT db4
  features.js         seguimiento de tono, detección de actividad, características
  matcher.js          DTW, puntaje de tomas, perfil y verificación
  autofilter.js       auto-sintonía: elige el filtro (IIR o FIR y su banda) a partir de las tomas
  ai.js               inteligencia: red neuronal propia, entrenamiento, predicción y explicación
  synth.js            silbidos sintéticos para la demostración
js/esp32.js           genera perfil.h y prueba_audio.h para el reconocedor autónomo
js/esp32-serial.js    la ESP32 como micrófono por USB (Web Serial, lector de tramas)
esp32/silbido_id/     firmware principal: filtra el INMP441 y manda el audio por USB
esp32/reconocedor_autonomo/  firmware que reconoce dentro de la ESP32
esp32/silbido_adc/    firmware para el micrófono comercial + LM358 (ADC a 64 kHz)
esp32/diagnostico/    prueba de la conexión I2S del INMP441
docs/informe-tecnico.md      informe técnico completo
hardware/             circuito: esquemático, vista 3D, conexiones y montaje
  electret.html       alternativa con módulo de sonido + LM358 en baquela
js/audio.js           micrófono (getUserMedia + AudioWorklet), re-muestreo, archivos, reproducción
js/ui/                gráficas en canvas y vista en vivo
js/views/             lógica de cada pestaña
tests/dsp.test.mjs    pruebas: FFT vs DFT, Butterworth vs fórmula analógica, Parseval en DWT, DTW, verificación
```

## Próximo paso: ESP32 + INMP441

🔌 **Circuito completo** (esquemático, vista 3D, conexiones, materiales y montaje): [`hardware/index.html`](hardware/index.html), o en la web publicada: `/hardware/`.

🎛️ **Firmware**: [`esp32/`](esp32/README.md). La ESP32 **filtra** la señal del INMP441 (bloqueo de DC → pasa-banda Butterworth/FIR → ganancia con limitador suave) y la manda por USB. En la web, **Grabar → Usar ESP32 (USB)** la usa como micrófono. También hay un reconocedor autónomo que decide dentro de la placa.

🎤 **Alternativa con micrófono comercial** (módulo de sonido + amplificador LM358, montaje en baquela): [`hardware/electret.html`](hardware/electret.html) y firmware `esp32/silbido_adc`.

🚨 **Alarma antirrobo para el celular**: armas y desarmas con dos silbidos que reconoce la ESP32 (módulo de sonido + LM358) y llegan por Bluetooth a [`alarma.html`](alarma.html), que suena si alguien levanta el celular o lo desconecta. Guía en [`esp32/README.md`](esp32/README.md#alarma_silbido-alarma-antirrobo-para-el-celular). Simulador: `alarma.html?demo=1`.

📘 **Informe técnico completo** (hardware, I2S, teoría de los filtros, auto-sintonía, DTW, red neuronal): [`docs/informe-tecnico.md`](docs/informe-tecnico.md).

### Auto-sintonía del filtro

1. **Sondeo**: cada toma pasa por un pre-filtro ancho (400–7000 Hz). De las tramas con silbido sale tu rango (percentiles 3–97 de f₀) y de las tramas sin silbido sale el espectro del ruido.
2. **Candidatos**: con 2,5, 4 y 6 semitonos de holgura alrededor del rango se diseñan 15 IIR y 36 FIR.
3. **Puntaje analítico** con la respuesta en frecuencia real: SNR estimada a la salida, pérdida y rizado sobre tus notas, caída en los bordes del rango (penalizada fuerte), dispersión del retardo de grupo, estabilidad en float32 y costo en el ESP32.
4. **Final IIR contra FIR**: el mejor de cada familia analiza de verdad las tomas y gana el de mejor calidad (el mismo puntaje que elige la mejor toma). El empate lo decide el puntaje analítico.

## Limitaciones

Es una **demostración académica, no un sistema de seguridad**. Un silbido no es tan único como una huella dactilar: alguien que imite bien la melodía y el tono podría ser aceptado. El ruido fuerte, la saturación o silbidos muy cortos (< 0,3 s con tono) reducen la precisión.

---

Hecho para Procesamiento de Señales II · 2026.
