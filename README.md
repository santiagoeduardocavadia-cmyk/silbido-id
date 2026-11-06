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
| **3 · Filtro** | Diseño del pasa-banda: **IIR Butterworth** (transformación bilineal) o **FIR por ventanas** (Hamming, Hann, Blackman, rectangular/Gibbs). Respuesta en magnitud, retardo de grupo, respuesta al impulso, **polos y ceros** y exportación a **C para el ESP32**. |
| **4 · Perfiles** | Cada persona guarda su huella. Se puede **exportar/importar en `.json`** para compartirla. Incluye perfiles de demostración. |
| **5 · Verificar** | Alguien silba 5 s y la web decide: **verificación 1:1** ("¿es Ana?") o **identificación 1:N** ("¿quién silbó?"). Muestra la similitud, por qué decidió así, los contornos superpuestos, la **matriz DTW** y los espectrogramas lado a lado. |

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

## Ejecutar en tu computador

Necesitas [Node.js](https://nodejs.org/) (no hay dependencias que instalar):

```bash
npm start          # abre http://localhost:8000
npm test           # 48 pruebas del núcleo DSP
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
  synth.js            silbidos sintéticos para la demostración
js/audio.js           micrófono (getUserMedia + AudioWorklet), re-muestreo, archivos, reproducción
js/ui/                gráficas en canvas y vista en vivo
js/views/             lógica de cada pestaña
tests/dsp.test.mjs    pruebas: FFT vs DFT, Butterworth vs fórmula analógica, Parseval en DWT, DTW, verificación
```

## Próximo paso: ESP32 + INMP441

En la pestaña **Filtro**, el botón **Exportar para ESP32 (.h)** genera los coeficientes del filtro activo y una función `silbido_filtrar(x)` lista para el sketch. Con el micrófono I2S INMP441 a 16 kHz se puede repetir la misma cadena (filtro → energía y tono en la banda → comparación) para encender un LED o un relé cuando se reconozca el silbido.

## Limitaciones

Es una **demostración académica, no un sistema de seguridad**. Un silbido no es tan único como una huella dactilar: alguien que imite bien la melodía y el tono podría ser aceptado. El ruido fuerte, la saturación o silbidos muy cortos (< 0,3 s con tono) reducen la precisión.

---

Hecho para Procesamiento de Señales II · 2026.
