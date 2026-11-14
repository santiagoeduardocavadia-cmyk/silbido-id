# Silbido ID: informe técnico

**Reconocimiento de silbidos con ESP32 + INMP441 y procesamiento digital de señales en el navegador**
Procesamiento de Señales II · 2026

---

## Contenido

1. [Resumen](#1-resumen)
2. [Arquitectura del sistema](#2-arquitectura-del-sistema)
3. [Hardware: INMP441, I2S y ESP32](#3-hardware-inmp441-i2s-y-esp32)
4. [Firmware de la ESP32: acondicionamiento de la señal](#4-firmware-de-la-esp32-acondicionamiento-de-la-señal)
5. [Teoría de los filtros](#5-teoría-de-los-filtros)
6. [Auto-sintonía: cómo se elige el filtro](#6-auto-sintonía-cómo-se-elige-el-filtro)
7. [Análisis del silbido: de la señal a la huella](#7-análisis-del-silbido-de-la-señal-a-la-huella)
8. [Modo 1: identificación por filtros (reglas + DTW)](#8-modo-1-identificación-por-filtros-reglas--dtw)
9. [Modo 2: identificación por inteligencia (red neuronal)](#9-modo-2-identificación-por-inteligencia-red-neuronal)
10. [Identificación en tiempo real](#10-identificación-en-tiempo-real)
11. [Herramientas de visualización: STFT, CWT y DWT](#11-herramientas-de-visualización-stft-cwt-y-dwt)
12. [Verificación y pruebas](#12-verificación-y-pruebas)
13. [Limitaciones y trabajo futuro](#13-limitaciones-y-trabajo-futuro)
14. [Guía rápida de uso](#14-guía-rápida-de-uso)

---

## 1. Resumen

El sistema reconoce a una persona por su forma de silbar. La cadena tiene dos partes:

- **ESP32 + INMP441 (hardware)**: captura el sonido con un micrófono MEMS digital (I2S, 24 bits, 16 kHz), **lo acondiciona** (bloqueo de DC, filtro pasa-banda del silbido, ganancia con limitador suave) y lo envía por USB al computador.
- **Web (software)**: recibe el audio ya filtrado, extrae la **huella** del silbido (melodía f₀(t), tono, duración, segmentos, pureza) y decide quién silbó con **dos métodos independientes**:
  1. **Por filtros**: distancias normalizadas por la variabilidad de la persona, con **DTW** para la melodía.
  2. **Por inteligencia**: un **perceptrón multicapa** propio, entrenado en el navegador con los perfiles.

Todo el procesamiento (FFT, filtros IIR/FIR, STFT, wavelets, DTW, red neuronal) está programado a mano, sin librerías. El filtro no lo ajusta el usuario: lo elige un algoritmo de **auto-sintonía** a partir de las grabaciones, para no cortar nunca el rango del silbido.

---

## 2. Arquitectura del sistema

```mermaid
flowchart LR
  A[Silbido] --> B[INMP441<br/>MEMS + ADC ΣΔ<br/>24 bits]
  B -- I2S 16 kHz --> C[ESP32]
  subgraph C[ESP32 · acondicionamiento]
    C1[Bloqueo de DC] --> C2[Pasa-banda<br/>Butterworth / FIR] --> C3[Ganancia +<br/>limitador] --> C4[Tramas USB<br/>int16]
  end
  C4 -- USB 921600 baud --> D[Web · Grabar / Verificar]
  D --> E[Filtro del perfil]
  E --> F[STFT → f0(t)<br/>actividad → huella]
  F --> G1[Modo filtros<br/>DTW + D ≤ T]
  F --> G2[Modo IA<br/>red 22→24→K+1]
  G1 --> H[Decisión]
  G2 --> H
```

**Reparto de tareas.** La ESP32 hace lo que conviene hacer cerca del sensor: quitar componentes que no son silbido (DC, zumbido de la red, ruido grave, ruido de alta frecuencia) y adaptar el nivel. La web hace lo que necesita memoria, gráficas y comparación con perfiles. Con este reparto el microcontrolador queda con una carga muy baja: el filtro usa menos del 0,1 % de su capacidad de cálculo. Hay además un **reconocedor autónomo** (`esp32/reconocedor_autonomo/`) que hace toda la cadena dentro de la ESP32, por si se quiere un sistema sin computador.

---

## 3. Hardware: INMP441, I2S y ESP32

### 3.1 Micrófono INMP441

Es un micrófono **MEMS omnidireccional con salida digital**. Dentro del encapsulado tiene la membrana MEMS, un preamplificador, un **ADC sigma-delta** con filtro de diezmado y la interfaz **I2S**. Así, la señal sale digitalizada desde el sensor y no recoge ruido analógico en los cables.

| Parámetro | Valor típico (hoja de datos) |
|---|---|
| Alimentación | 1,8 – 3,3 V (aquí 3,3 V de la ESP32) |
| Sensibilidad | −26 dBFS a 94 dB SPL (1 kHz) |
| SNR | 61 dBA |
| Punto de sobrecarga acústica | 120 dB SPL |
| Respuesta en frecuencia | ≈ 60 Hz – 15 kHz |
| Formato | I2S, 24 bits en ranura de 32, MSB primero |

Para hacerse una idea de los niveles: un silbido a 10–20 cm produce unos 80–90 dB SPL. Eso equivale a unos −30 a −40 dBFS en la salida del micrófono, así que sobra margen antes de saturar.

### 3.2 Bus I2S

El I2S usa tres líneas: **SCK** (reloj de bit), **WS** (selección de palabra: izquierda/derecha) y **SD** (datos serie). La ESP32 es **maestro**: genera SCK y WS, y el micrófono responde por SD.

- Frecuencia de muestreo: $f_s = 16\ \text{kHz}$.
- Dos ranuras (izquierda/derecha) de 32 bits por trama: $f_{SCK} = 2 \cdot 32 \cdot f_s = 1{,}024\ \text{MHz}$, $f_{WS} = f_s$.
- Formato Philips: el MSB llega un ciclo de SCK después del flanco de WS.
- El pin **L/R** del INMP441 elige en qué ranura transmite: a GND → izquierda, a VDD → derecha. En la otra ranura deja SD en alta impedancia.

Los 24 bits útiles van alineados a la izquierda en la palabra de 32 bits. Por eso el firmware hace un desplazamiento aritmético de 8 bits y normaliza:

$$x = \frac{\text{palabra} \gg 8}{2^{23}} \in [-1, 1)$$

El firmware lee **las dos ranuras** y se queda con la que tiene energía. Así el sistema funciona aunque L/R quede conectado al revés.

### 3.3 Conexiones

| INMP441 | ESP32 DevKit V1 | Función |
|---|---|---|
| VDD | 3V3 | Alimentación (nunca 5 V) |
| GND | GND | Referencia |
| L/R | GND | Canal izquierdo |
| SCK | GPIO26 | Reloj de bit |
| WS | GPIO25 | Selección de palabra |
| SD | GPIO32 | Datos |

El detalle (esquemático, vista 3D y montaje) está en [`hardware/index.html`](../hardware/index.html). Se recomienda un condensador de desacoplo de 100 nF entre VDD y GND, junto al micrófono, y cables cortos (< 15 cm), porque SCK es una señal de 1 MHz.

---

## 4. Firmware de la ESP32: acondicionamiento de la señal

Archivo: [`esp32/silbido_id/silbido_id.ino`](../esp32/silbido_id/silbido_id.ino) + `filtro.h`.

```mermaid
flowchart LR
  I[I2S<br/>32 bits estéreo] --> S[Selección<br/>de canal] --> N[÷2²³<br/>a flotante] --> DC["Bloqueo DC<br/>H(z)=(1−z⁻¹)/(1−Rz⁻¹)"] --> BP["Pasa-banda<br/>filtro.h"] --> G["× 10^(G/20)"] --> L[Limitador<br/>suave] --> Q["× 32767<br/>int16"] --> U[Trama USB]
```

### 4.1 Bloqueo de DC

Los micrófonos MEMS tienen un pequeño desplazamiento de continua, y la ganancia lo amplificaría. Se elimina con un filtro de primer orden con un cero en $z = 1$ y un polo en $z = R$:

$$H_{DC}(z) = \frac{1 - z^{-1}}{1 - R\,z^{-1}}, \qquad y[n] = x[n] - x[n-1] + R\,y[n-1]$$

Con $R = 0{,}995$ la frecuencia de corte es

$$f_c \approx \frac{(1 - R)\, f_s}{2\pi} = \frac{0{,}005 \cdot 16000}{2\pi} \approx 12{,}7\ \text{Hz}$$

El pasa-banda también tiene ceros en $z = 1$, pero el bloqueo de DC actúa primero y evita que el estado interno de los biquads cargue un valor de continua grande.

### 4.2 Filtro pasa-banda (`filtro.h`)

Es el corazón del acondicionamiento. Por defecto, la ESP32 trae un **pre-filtro Butterworth de orden 6 (3 biquads) con banda de 400 a 7000 Hz**. Es lo bastante ancho para cualquier silbido humano y elimina lo que no lo es:

| Frecuencia | Atenuación | Qué se elimina |
|---|---|---|
| 60 Hz | **−50,1 dB** | Zumbido de la red eléctrica |
| 120 Hz | −31,9 dB | 2.º armónico del zumbido |
| 300 Hz | −8,4 dB | Voz grave, golpes, viento |
| 1 – 5 kHz | 0,0 dB | **Silbido (intacto)** |
| 7,5 kHz | −18,7 dB | Ruido de alta frecuencia, siseo del aire |

Cuando ya tienes tu perfil, puedes cargar en la ESP32 **el filtro que la auto-sintonía eligió para tu silbido** (por ejemplo, IIR orden 8 de 1300 a 3150 Hz). Ese filtro es más angosto y saca más ruido. Se exporta desde la web (pestaña *Filtro* o botón *Filtro ESP32* del perfil) o con `node scripts/esp32-filtro.mjs perfil.json`.

Implementación en **forma directa II transpuesta** por sección (sección 5.4):

```c
float y = b0*x + z1;
z1 = b1*x - a1*y + z2;
z2 = b2*x - a2*y;
```

Cuesta 5 multiplicaciones por sección y por muestra: $3 \times 5 \times 16000 = 240\,000$ MAC/s, menos del 0,1 % de la capacidad del procesador a 240 MHz con FPU.

### 4.3 Ganancia y limitador suave

El silbido llega a unos −30 dBFS, así que se aplica una ganancia digital $G = 12$ dB (ajustable con `+`/`−` en pasos de 3 dB). Para que un silbido fuerte no se **recorte en seco** se usa un limitador suave. Un recorte brusco crearía armónicos que confundirían al detector de tono.

$$y = \begin{cases} x & |x| \le L \\ \operatorname{sgn}(x)\left[L + (1-L)\tanh\!\left(\dfrac{|x|-L}{1-L}\right)\right] & |x| > L \end{cases}, \qquad L = 0{,}8$$

La curva es continua y de pendiente 1 en $|x| = L$, y tiende a ±1 sin superarlo. Cada trama lleva un bit que avisa si actuó el limitador.

### 4.4 Protocolo USB

Cada 10 ms (160 muestras) se envía una trama binaria:

| Bytes | Campo |
|---|---|
| 2 | Sincronía `A5 5A` |
| 1 | Número de secuencia (detecta tramas perdidas) |
| 1 | $n$ = 160 muestras |
| 1 | Estado: bit 0 = limitador activo, bit 1 = canal derecho |
| $2n$ | Muestras int16 little-endian |
| 1 | Suma de verificación (suma de los bytes de datos, módulo 256) |

**Presupuesto de ancho de banda**: $326\ \text{B} / 10\ \text{ms} = 32{,}6\ \text{kB/s}$. A 921 600 baudios (10 bits por byte con start y stop) el enlace da 92,2 kB/s, así que se usa el **35 %**. La web reconstruye las tramas aunque lleguen partidas, descarta las que tienen mala suma de verificación y cuenta las perdidas por la secuencia.

Comandos de texto: `S` empieza a enviar, `X` detiene, `I` responde la información en JSON (filtro, banda, ganancia, canal), `N` muestra un medidor de nivel **entrada vs. filtrada** para el Trazador Serie de Arduino. Con `N` se ve el filtro en acción: al hablar, la curva filtrada queda muy por debajo de la de entrada; al silbar, las dos casi coinciden.

---

## 5. Teoría de los filtros

### 5.1 Especificación

Un silbido humano es casi una sinusoide pura entre ~500 Hz y ~5 kHz, con algo de "soplido" (ruido de banda ancha). El filtro debe:

1. **Dejar pasar todo el rango del silbido** con ganancia plana (cortar el rango sesgaría el tono medido).
2. **Rechazar** zumbido (50/60 Hz y armónicos), voz grave, golpes y siseo de alta frecuencia.
3. Ser **estable y barato** en un microcontrolador de 32 bits en coma flotante simple.

### 5.2 Butterworth IIR

El prototipo pasa-bajos de orden $N$ es **máximamente plano** en la banda de paso:

$$|H(j\Omega)|^2 = \frac{1}{1 + (\Omega/\Omega_c)^{2N}}$$

Sus polos normalizados ($\Omega_c = 1$) están sobre la circunferencia unidad del plano $s$, en el semiplano izquierdo:

$$p_k = e^{\,j\pi(2k + N + 1)/(2N)}, \qquad k = 0, \dots, N-1$$

**Transformación pasa-bajos → pasa-banda.** Con $\Omega_0 = \sqrt{\Omega_L \Omega_H}$ (centro geométrico) y $B = \Omega_H - \Omega_L$ (ancho de banda):

$$s \;\to\; \frac{s^2 + \Omega_0^2}{B\, s}$$

Cada polo $p$ del prototipo genera dos polos pasa-banda, raíces de $s^2 - pB\,s + \Omega_0^2 = 0$. El orden final es $2N$.

**Transformación bilineal con pre-distorsión.** Para pasar al dominio discreto:

$$s = 2 f_s \frac{1 - z^{-1}}{1 + z^{-1}}$$

La bilineal deforma el eje de frecuencias ($\Omega = 2 f_s \tan(\omega/2)$). Por eso las frecuencias de corte se **pre-distorsionan** antes de diseñar:

$$\Omega_{L,H} = 2 f_s \tan\!\left(\frac{\pi f_{L,H}}{f_s}\right)$$

Así, en el filtro digital la ganancia vale exactamente −3 dB en $f_L$ y $f_H$. La bilineal convierte el semiplano izquierdo en el interior del círculo unidad, de modo que **un analógico estable da un digital estable**. Los ceros quedan $N$ en $z = 1$ (DC) y $N$ en $z = -1$ (Nyquist), y cada biquad tiene numerador $b_0(1 - z^{-2})$.

### 5.3 Por qué secciones de segundo orden (SOS)

Un IIR de orden 8–12 escrito como un único cociente de polinomios es **numéricamente frágil**. Los polos están cerca del círculo unidad, y un error relativo minúsculo en un coeficiente del polinomio mueve mucho las raíces; en float32 el filtro puede volverse inestable. Factorizarlo en biquads:

$$H(z) = \prod_{i=1}^{N} \frac{b_{0i} + b_{1i} z^{-1} + b_{2i} z^{-2}}{1 + a_{1i} z^{-1} + a_{2i} z^{-2}}$$

mantiene cada par de polos conjugados en su propia sección, con coeficientes de sensibilidad baja. Las secciones se ordenan de menor a mayor radio de polo y cada una se normaliza a ganancia unitaria en la frecuencia central, para no saturar etapas intermedias.

### 5.4 Forma directa II transpuesta

Por sección se usan dos estados, $z_1$ y $z_2$:

$$y[n] = b_0 x[n] + z_1,\quad z_1 \leftarrow b_1 x[n] - a_1 y[n] + z_2,\quad z_2 \leftarrow b_2 x[n] - a_2 y[n]$$

Comparada con la forma directa I, necesita la mitad de memoria. En coma flotante es la estructura de mejor comportamiento, porque sus sumas internas no crecen tanto.

### 5.5 FIR por el método de ventanas

La respuesta ideal pasa-banda es la diferencia de dos sinc:

$$h_d[m] = \frac{\sin(2\pi f_H m / f_s) - \sin(2\pi f_L m / f_s)}{\pi m}, \qquad h_d[0] = \frac{2(f_H - f_L)}{f_s}$$

Se trunca a $M$ coeficientes (impar, tipo I), se centra y se multiplica por una ventana: $h[n] = h_d[n - \tfrac{M-1}{2}]\,w[n]$. Luego se normaliza a ganancia 1 en $(f_L + f_H)/2$. La respuesta es **simétrica**, por lo que el filtro tiene **fase lineal**: retardo de grupo constante de $(M-1)/2$ muestras y ninguna distorsión de fase.

Truncar con la ventana rectangular produce el **fenómeno de Gibbs** (rizado que no baja al aumentar $M$). Las ventanas suaves cambian rizado por ancho de transición:

| Ventana | Lóbulo lateral | Atenuación en la banda eliminada | Ancho de transición ≈ |
|---|---|---|---|
| Rectangular | −13 dB | ~21 dB | $0{,}9\,f_s/M$ |
| Hann | −31 dB | ~44 dB | $3{,}1\,f_s/M$ |
| Hamming | −41 dB | ~53 dB | $3{,}3\,f_s/M$ |
| Blackman | −57 dB | ~74 dB | $5{,}5\,f_s/M$ |

### 5.6 IIR frente a FIR

| | Butterworth IIR | FIR por ventanas |
|---|---|---|
| Costo (orden 8 vs 101 coef.) | 20 mult/muestra | 101 mult/muestra |
| Fase | No lineal (retardo variable) | **Lineal** (retardo constante) |
| Estabilidad | Requiere polos dentro del círculo | **Siempre estable** |
| Banda de paso | Máximamente plana | Pequeño rizado según ventana |
| Transición | Abrupta con poco orden | Requiere muchos coeficientes |

Ninguno gana siempre: depende del ruido y del rango de cada persona. Por eso el sistema **mide** y elige solo (sección 6).

---

## 6. Auto-sintonía: cómo se elige el filtro

Archivo: [`js/dsp/autofilter.js`](../js/dsp/autofilter.js). El usuario **no** ajusta el filtro: si lo hiciera, podría cortar parte de su rango y el sistema perdería información.

**Paso 1: sondeo.** Cada toma pasa por un pre-filtro muy ancho (400–7000 Hz) y por el detector de tono (sección 7). Se recogen:

- la f₀ de todas las tramas con silbido → el **rango** de la persona (percentiles 3 y 97) y un histograma $w[k]$ de dónde están sus notas;
- el espectro medio de las tramas **sin** silbido → el **espectro del ruido** $N[k]$;
- el espectro medio con silbido menos el ruido → el espectro del **silbido** $S[k]$.

**Paso 2: candidatos.** Con holguras de 2,5, 4 y 6 semitonos alrededor del rango ($f_L = f_{lo}\,2^{-m/12}$, $f_H = f_{hi}\,2^{m/12}$, redondeadas a 50 Hz) se diseñan 15 Butterworth (orden 4 a 12) y 36 FIR (61 a 201 coeficientes × Hamming, Hann y Blackman): **51 filtros**.

**Paso 3: puntaje analítico** con la respuesta en frecuencia real $|H(k)|^2$:

$$\text{SNR}_{out} = 10\log_{10}\frac{\sum_k |H(k)|^2 S[k]}{\sum_k |H(k)|^2 N[k]}$$

$$\text{puntaje} = \text{SNR}_{out} - 2\,P - R - 3\max(0, C - 1) - 0{,}5\,\Delta\tau - 0{,}002\,\text{costo} - 3\cdot[\,|p|_{max} > 0{,}995\,]$$

Los términos son:

- $P$: pérdida media sobre las notas, en dB, $-10\log_{10}\sum_k w[k]|H(k)|^2$.
- $R$: rizado (desviación de la ganancia en dB sobre las notas).
- $C$: caída en los bordes del rango, en dB. Tiene la penalización más fuerte, porque **nunca se debe cortar el rango**.
- $\Delta\tau$: dispersión del retardo de grupo dentro del rango, en ms.
- Costo: multiplicaciones por muestra.
- Último término: riesgo de inestabilidad en float32 (algún polo con $|p| > 0{,}995$).

**Paso 4: final IIR contra FIR.** El mejor IIR y el mejor FIR **analizan de verdad todas las tomas**. Gana el que obtiene mayor calidad media, con el mismo puntaje que elige la mejor toma (SNR, duración, estabilidad, pureza y consistencia entre tomas). Si empatan, decide el puntaje analítico. El resultado es determinista: las mismas tomas dan siempre el mismo filtro.

Ejemplo con los perfiles demo: para "Ana" (rango 1623–2486 Hz) se eligió **FIR de 61 coeficientes, Hamming, 1150–3500 Hz**, y la SNR estimada subió de 18,1 a 28,7 dB. Para "Beto" (1095–1702 Hz) se eligió **IIR Butterworth de orden 6, 750–2400 Hz**.

---

## 7. Análisis del silbido: de la señal a la huella

Archivo: [`js/dsp/features.js`](../js/dsp/features.js).

### 7.1 STFT y tono fundamental

| Parámetro | Valor | Motivo |
|---|---|---|
| Trama $N$ | 1024 muestras = 64 ms | Resolución en frecuencia para notas cercanas |
| Salto | 160 muestras = 10 ms | Seguir cambios rápidos de nota |
| FFT | 2048 puntos (relleno de ceros) | Bins de $f_s/2048 = 7{,}8$ Hz |
| Ventana | Hann periódica | Lóbulos laterales a −31 dB |

En cada trama se busca el **pico del espectro de potencia** $P[k]$ entre $0{,}6 f_L$ y $1{,}15 f_H$. Luego se hacen dos correcciones:

1. **Subarmónico**: si hay un pico en $k/2$ a menos de 20 dB del máximo, el fundamental es ese. Así se evita confundir el 2.º armónico con la nota.
2. **Interpolación parabólica** en dB. Con $\alpha, \beta, \gamma$ los valores en $k-1, k, k+1$, la parábola que pasa por los tres puntos tiene su vértice en

$$\delta = \frac{1}{2}\,\frac{\alpha - \gamma}{\alpha - 2\beta + \gamma}, \qquad f_0 = (k + \delta)\frac{f_s}{N_{FFT}}$$

Esto mejora la resolución muy por debajo del tamaño del bin. Con ventana Hann, el error queda en pocos hercios.

### 7.2 Detección de actividad (¿hay silbido en esta trama?)

Una trama tiene silbido si cumple las tres condiciones:

- **Pureza tonal** $\geq 0{,}35$: fracción de la energía de la banda concentrada en ±4 bins del pico. Un silbido se acerca a 1; el ruido, a valores bajos.
- Energía de la trama a menos de 35 dB del máximo de la toma (percentil 98).
- **Energía de corto plazo** (20 ms centrados) a menos de 25 dB de su máximo. Esto separa notas consecutivas aunque la trama de 64 ms abarque la pausa.

Después se rellenan huecos de hasta 3 tramas y se descartan tramos de menos de 5 tramas (50 ms). Cada tramo continuo es un **segmento**, o nota.

### 7.3 Huella

El tono se expresa en **semitonos MIDI** para que las distancias sean musicales (logarítmicas):

$$m = 69 + 12\log_2\frac{f}{440}$$

Dentro de cada segmento, el contorno se suaviza con una mediana de 5 tramas. Con eso se obtiene:

- **Tono medio**: mediana de $m$. **Rango**: percentil 95 − percentil 5.
- **Duración con silbido** y **número de segmentos**.
- **Pureza** media, **SNR** (energía del pico con silbido frente a energía sin silbido), **estabilidad**: mediana de $|\Delta m|$ entre tramas, en cents.
- **Contorno** para comparar: $m$ de las tramas con silbido, una de cada dos (cada 20 ms).

### 7.4 Calidad de cada toma

Para elegir las 3 mejores de 5 tomas se usa un puntaje de 0 a 100. Pondera la SNR (25 %), la duración (15 %), la estabilidad (15 %), la pureza (15 %) y la **consistencia** con las demás tomas, medida con DTW (30 %). Si la toma está saturada, el puntaje se multiplica por 0,7.

---

## 8. Modo 1: identificación por filtros (reglas + DTW)

Archivo: [`js/dsp/matcher.js`](../js/dsp/matcher.js).

### 8.1 Dynamic Time Warping

Nadie silba dos veces al mismo ritmo, así que comparar los contornos punto a punto fallaría. El DTW busca el alineamiento temporal de costo mínimo:

$$D(i,j) = |a_i - b_j| + \min\{D(i-1,j),\ D(i,j-1),\ D(i-1,j-1)\}$$

La distancia es $D(n,m)$ dividida entre la longitud del camino. Así se obtiene el **error medio en semitonos** después de alinear.

### 8.2 Tolerancias propias y decisión

El perfil guarda las 3 mejores tomas. De su variabilidad salen las **tolerancias** $\tau$ de la persona (por ejemplo, $\tau_{tono} = \max(0{,}6;\ 3\sigma)$). Cada diferencia se mide en esas unidades, y se combinan con pesos 3 (melodía), 2 (tono), 1 (duración), 1 (segmentos) y 1 (pureza):

$$D = \sqrt{\frac{\sum_i w_i (d_i/\tau_i)^2}{\sum_i w_i}}, \qquad \text{se acepta si } D \le T$$

$$\text{similitud} = 100 \cdot 2^{-(D/T)^2} \quad (50\ \% \text{ justo en el umbral})$$

$T$ es la rigurosidad: 1,3 permisiva, 1,0 normal, 0,8 estricta. Cada perfil se analiza con **su propio filtro**, el de la auto-sintonía.

---

## 9. Modo 2: identificación por inteligencia (red neuronal)

Archivo: [`js/dsp/ai.js`](../js/dsp/ai.js).

### 9.1 Entrada

Cada silbido se resume en un vector de 22 números:

$$\mathbf{x} = [\,m_{med},\ \text{rango},\ \text{duración},\ \text{segmentos},\ \text{pureza},\ \text{jitter},\ c_1,\dots,c_{16}\,]$$

donde $c_1 \dots c_{16}$ es la **forma de la melodía**: el contorno menos su mediana, re-muestreado a 16 puntos. Así la forma queda separada del tono absoluto. Cada entrada se centra con la media del entrenamiento y se divide por una escala típica (1,5 st, 0,4 s, 0,08 de pureza…).

### 9.2 Arquitectura

Es un perceptrón multicapa **22 → 24 → K+1**, con una salida por perfil y otra para "desconocido":

$$\mathbf{h} = \tanh(W_1 \mathbf{x} + \mathbf{b}_1), \qquad \mathbf{z} = W_2 \mathbf{h} + \mathbf{b}_2, \qquad p_c = \frac{e^{z_c}}{\sum_j e^{z_j}}$$

### 9.3 Datos de entrenamiento

No hace falta grabar más: los datos salen de los perfiles.

- **Positivos**: cada toma de referencia y 60 variaciones realistas. El tono se desplaza con $\mathcal{N}(0,\ 0{,}35\,\tau_{tono})$, el tiempo se estira entre ×0,85 y ×1,15, se agrega ruido al contorno, ±1 segmento con probabilidad 0,2, y se varían la pureza y el jitter.
- **"Desconocido"**:
  - *imitadores*: la misma melodía transpuesta fuera de la tolerancia, entre ±1,1 y ±3,8 st o más;
  - *otra melodía con el mismo tono*: invertida, al revés o al azar;
  - *silbidos al azar* en todo el rango humano.

### 9.4 Entrenamiento

Se minimiza la **entropía cruzada** con pesos por clase $\omega_y = \frac{n}{C\,n_y}$, para que "desconocido", la clase más numerosa, no domine:

$$\mathcal{L} = -\frac{1}{\sum \omega_{y_i}}\sum_i \omega_{y_i}\log p_{y_i}$$

Retropropagación, con $\mathbf{y}$ el vector one-hot de la clase correcta:

$$\frac{\partial \mathcal{L}}{\partial \mathbf{z}} = \omega\,(\mathbf{p} - \mathbf{y}), \quad \frac{\partial \mathcal{L}}{\partial W_2} = \frac{\partial \mathcal{L}}{\partial \mathbf{z}}\,\mathbf{h}^\top, \quad \frac{\partial \mathcal{L}}{\partial \mathbf{a}_1} = (W_2^\top \tfrac{\partial \mathcal{L}}{\partial \mathbf{z}}) \odot (1 - \mathbf{h}^2), \quad \frac{\partial \mathcal{L}}{\partial W_1} = \frac{\partial \mathcal{L}}{\partial \mathbf{a}_1}\,\mathbf{x}^\top$$

El optimizador es **Adam** ($\beta_1 = 0{,}9$, $\beta_2 = 0{,}999$, tasa 0,02), con regularización L2 de $10^{-4}$, 260 épocas de lote completo y semilla fija (resultado reproducible). Con 2 perfiles son 742 ejemplos y unos 0,7 s en el navegador.

### 9.5 Decisión y explicación

Se acepta si la probabilidad de la persona supera el **umbral**: 50, 60 o 75 % según la rigurosidad.

Para explicar la decisión se usa **oclusión**. Se "tapa" cada grupo de entradas (se reemplaza por la media del entrenamiento) y se mide el cambio en la confianza, en log-odds:

$$\Delta_g = \operatorname{logit}\, p_k(\mathbf{x}) - \operatorname{logit}\, p_k(\mathbf{x}_{\setminus g}), \qquad \text{aporte}_g = \frac{\Delta_g}{\sum_{g'} |\Delta_{g'}|}$$

En los perfiles demo, la decisión sobre Ana se reparte entre el tono medio (~50 %) y la forma de la melodía (~48 %).

### 9.6 Los dos modos juntos

| | Por filtros | Por inteligencia |
|---|---|---|
| Criterio | Reglas fijas, explicables una a una | Aprendido de los datos |
| Melodía | DTW (alineamiento exacto) | Forma re-muestreada a 16 puntos |
| Salida | Distancia $D$ y similitud | Probabilidad por persona |
| Fortaleza | Transparente, no necesita entrenamiento | Combina rasgos de forma no lineal; modela "desconocido" |

El modo **Ambos** acepta solo si los dos coinciden en la misma persona. Es el más conservador.

Con las demos: Ana sale aceptada con D ≈ 0,2–0,3 y una probabilidad de 99–100 %. El imitador (misma melodía, 2,5 st más agudo) sale rechazado con D ≈ 2,2–2,5 y 0,1 %.

---

## 10. Identificación en tiempo real

El audio (de la ESP32 o del micrófono del equipo) llena un **búfer circular de 5 s** a 16 kHz. Cada 0,6 s se hace lo siguiente:

1. Un filtro ancho localiza los tramos de silbido y la **última frase**: tramos separados por menos de 0,7 s.
2. La frase se recorta y se coloca en una toma de 5 s, empezando en 0,5 s. Así se analiza igual que una grabación y nunca se compara medio silbido, ni el final de uno pegado al inicio de otro.
3. Se evalúa con los dos modos. Mientras la frase sigue (termina a menos de 0,35 s del final de la ventana), el resultado se marca **provisional**. Al terminar, se fija y se mantiene hasta el siguiente silbido.

---

## 11. Herramientas de visualización: STFT, CWT y DWT

La pestaña *Análisis* muestra además:

- **Espectrograma STFT** (mapa de calor magma) con recuadros que anotan qué toma el sistema: segmentos, contorno f₀, banda del filtro, rango y ruido.
- **Escalograma CWT con ondita de Morlet**, calculado en frecuencia: $W_a = \mathcal{F}^{-1}\{X(\omega)\,\Psi^*(a\omega)\}$ con $a = \omega_0/(2\pi f)$. Tiene mejor resolución temporal en altas frecuencias que la STFT.
- **DWT Daubechies-4**, 5 niveles con banco de filtros (pasa-bajos $h$, pasa-altos $g$, diezmado ×2), y la energía por sub-banda (se comprueba Parseval en las pruebas).

---

## 12. Verificación y pruebas

`npm test` ejecuta **85 pruebas** automáticas. Las principales:

- FFT contra la DFT directa, Butterworth contra la fórmula analógica y polos dentro del círculo unidad.
- Parseval en la DWT, simetría y fase lineal del FIR.
- Seguimiento de tono, segmentación de las 5 notas, aceptación de Ana y rechazo de Beto y del imitador.
- Auto-sintonía: cubre todo el rango, caída en los bordes < 1 dB y resultado determinista.
- Red neuronal: reconoce las tomas reales, acepta y rechaza correctamente, y la explicación suma 100 %.
- Lector de tramas USB: tramas partidas, basura entre tramas, suma de verificación y tramas perdidas.

El firmware compila con `arduino-cli` (núcleo esp32 3.3.12). El sketch de filtrado ocupa 295 KB de flash (22 %) y 24 KB de RAM. Para el reconocedor autónomo, el comando `p` compara en la placa el resultado con los valores de la web.

---

## 13. Limitaciones y trabajo futuro

- **No es un sistema de seguridad**: un silbido es menos único que una huella dactilar, y un imitador muy bueno podría pasar.
- Los perfiles demo son **sintéticos**. Con silbidos reales, las tolerancias y la red se ajustan solas a partir de las tomas, pero conviene grabar en condiciones parecidas a las de uso.
- **Doble filtrado**: la ESP32 filtra y la web vuelve a aplicar el filtro del perfil. Si ambos son el mismo filtro, en los bordes la atenuación pasa de −3 a −6 dB. No afecta, porque la auto-sintonía deja holgura de 2,5 a 6 semitonos alrededor del rango.
- **Pendiente de probar con hardware real**: el firmware compila, pero falta medir en la placa (comando `N`) el nivel real del silbido y ajustar la ganancia si hace falta.
- Mejoras posibles:
  - un AGC lento en la ESP32;
  - el filtro de cada perfil directamente en la ESP32 con conmutación por comando;
  - un dataset real con varias personas para validar tasas de falsa aceptación y falso rechazo (FAR/FRR).

---

## 14. Guía rápida de uso

1. **Montar** el circuito (sección 3.3).
2. **Subir** `esp32/silbido_id` a la ESP32 (placa *ESP32 Dev Module*).
3. **Probar** con el Monitor/Trazador Serie a 921 600 baudios y el comando `N`.
4. **Abrir la web** en Chrome o Edge, ir a *Grabar* → **Usar ESP32 (USB)** y elegir el puerto.
5. **Grabar** 5 tomas y guardar el perfil (o subir audios en *Perfiles → Nuevo perfil desde audios*).
6. Opcional: **cargar tu filtro** en la ESP32 (*Filtro ESP32* en tu perfil → reemplazar `filtro.h` → subir de nuevo).
7. **Verificar**: elegir el modo (*Por filtros*, *Inteligencia* o *Ambos*), silbar o usar **Identificar en tiempo real**, y pulsar **"Ver cómo lo identificó, paso a paso"**.
