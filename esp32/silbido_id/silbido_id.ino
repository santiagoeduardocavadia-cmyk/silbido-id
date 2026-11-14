// =====================================================================================
//  Silbido ID · ESP32 como micrófono filtrado
//
//  La ESP32 hace UNA sola cosa: acondicionar la señal del micrófono para que a la web llegue el
//  silbido lo más limpio posible. La identificación (filtros + inteligencia) la hace la web.
//
//    INMP441 ──I2S 16 kHz / 24 bits──► ESP32 ──USB 921600 baudios──► web (Grabar → "Usar ESP32")
//
//    1. Lectura I2S (estéreo de 32 bits; se usa el canal que trae señal).
//    2. Bloqueo de DC:  y[n] = x[n] − x[n−1] + R·y[n−1],  R = 0,995  (fc ≈ 12,7 Hz).
//    3. Pasa-banda de filtro.h (Butterworth en biquads o FIR; lo genera la web).
//    4. Ganancia digital + limitador suave (no hay recortes bruscos que creen armónicos).
//    5. Envío por USB en tramas binarias de 10 ms (160 muestras int16).
//
//  Conexiones (las mismas de hardware/index.html):
//    INMP441 VDD → 3V3   GND → GND   L/R → GND   SCK → GPIO26   WS → GPIO25   SD → GPIO32
//
//  Placa: "ESP32 Dev Module" (núcleo esp32 de Espressif 3.x).
//
//  Comandos por el puerto serie (921600 baudios):
//    N  medidor de nivel en texto (para el Trazador Serie: entrada vs filtrada)
//    S  empezar a enviar audio binario (lo usa la web)      X  detener
//    I  información en JSON                                  +/−  ganancia ±3 dB
//    H  ayuda
// =====================================================================================
#include <Arduino.h>
#include <driver/i2s_std.h>

#include "filtro.h"

static_assert(SILBIDO_FS == 16000, "filtro.h debe estar diseñado para 16 kHz");

// ------------------------------------------------------------------ configuración
constexpr int PIN_I2S_SCK = 26;
constexpr int PIN_I2S_WS = 25;
constexpr int PIN_I2S_SD = 32;
constexpr int PIN_LED = 2;
constexpr uint32_t BAUDIOS = 921600;   // 16 000 muestras/s × 2 bytes ≈ 33 kB/s (el enlace da ~92 kB/s)
constexpr int FS = SILBIDO_FS;
constexpr int BLOQUE = 160;            // 10 ms por trama
constexpr float R_DC = 0.995f;         // polo del bloqueo de DC
constexpr float LIM = 0.8f;            // a partir de aquí actúa el limitador suave

static float gananciaDb = 12.0f;       // el INMP441 da −26 dBFS a 94 dB SPL: +12 dB deja el silbido cerca de −10 dBFS

// ------------------------------------------------------------------ estado
enum Modo { REPOSO, AUDIO, NIVEL };
static Modo modo = REPOSO;
static i2s_chan_handle_t rx = nullptr;
static int32_t bufI2S[BLOQUE * 2];
static uint8_t trama[5 + BLOQUE * 2 + 1];
static uint8_t secuencia = 0;

static int canal = 0;  // 0 = izquierdo (L/R a GND), 1 = derecho (L/R a 3V3)
static double energiaCanal[2] = {0, 0};
static uint32_t muestrasCanal = 0;

static float dcX1 = 0, dcY1 = 0;       // memoria del bloqueo de DC
static double potEntrada = 0, potSalida = 0;
static uint32_t nNivel = 0, recortes = 0;

// ------------------------------------------------------------------ I2S
static bool iniciarI2S() {
  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  chan.dma_desc_num = 8;
  chan.dma_frame_num = BLOQUE;
  if (i2s_new_channel(&chan, nullptr, &rx) != ESP_OK) return false;
  i2s_std_config_t cfg = {
      .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(FS),
      .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
      .gpio_cfg =
          {
              .mclk = I2S_GPIO_UNUSED,
              .bclk = (gpio_num_t)PIN_I2S_SCK,
              .ws = (gpio_num_t)PIN_I2S_WS,
              .dout = I2S_GPIO_UNUSED,
              .din = (gpio_num_t)PIN_I2S_SD,
              .invert_flags = {.mclk_inv = false, .bclk_inv = false, .ws_inv = false},
          },
  };
  if (i2s_channel_init_std_mode(rx, &cfg) != ESP_OK) return false;
  return i2s_channel_enable(rx) == ESP_OK;
}

// ------------------------------------------------------------------ acondicionamiento
// Limitador suave: lineal hasta LIM y luego se curva con tanh hasta ±1 sin recortar en seco.
static inline float limitar(float x, bool &recorte) {
  const float a = fabsf(x);
  if (a <= LIM) return x;
  recorte = true;
  const float y = LIM + (1.0f - LIM) * tanhf((a - LIM) / (1.0f - LIM));
  return x < 0 ? -y : y;
}

// Una muestra cruda de 24 bits → muestra filtrada (−1…1).
static inline float acondicionar(float x, bool &recorte) {
  // 1) bloqueo de DC: H(z) = (1 − z⁻¹) / (1 − R·z⁻¹)
  const float d = x - dcX1 + R_DC * dcY1;
  dcX1 = x;
  dcY1 = d;
  // 2) pasa-banda del silbido
  const float y = silbido_filtrar(d);
  // 3) ganancia + limitador
  static float g = 0;
  static float gDb = -1000;
  if (gDb != gananciaDb) {
    gDb = gananciaDb;
    g = powf(10.0f, gananciaDb / 20.0f);
  }
  return limitar(g * y, recorte);
}

// ------------------------------------------------------------------ mensajes
static void info() {
  Serial.printf("{\"dispositivo\":\"silbido-id\",\"version\":1,\"fs\":%d,\"filtro\":\"%s\",\"fl\":%.0f,\"fh\":%.0f,"
                "\"ganancia_db\":%.0f,\"canal\":\"%s\",\"baudios\":%lu}\n",
                FS, SILBIDO_FILTRO, (double)SILBIDO_FL, (double)SILBIDO_FH, gananciaDb, canal ? "der" : "izq",
                (unsigned long)BAUDIOS);
}

static void ayuda() {
  Serial.println(F("Silbido ID · ESP32 como micrófono filtrado"));
  Serial.printf("Filtro: %s · ganancia %+.0f dB\n", SILBIDO_FILTRO, gananciaDb);
  Serial.println(F("Comandos: N = nivel (Trazador Serie) · S = enviar audio a la web · X = detener · I = info · +/- = ganancia · H = ayuda"));
  Serial.println(F("En la web: pestaña Grabar → \"Usar ESP32 (USB)\"."));
}

// ------------------------------------------------------------------ Arduino
void setup() {
  Serial.setTxBufferSize(8192);
  Serial.setRxBufferSize(256);
  Serial.begin(BAUDIOS);
  pinMode(PIN_LED, OUTPUT);
  delay(200);
  if (!iniciarI2S()) {
    Serial.println(F("ERROR: no se pudo iniciar el I2S (revisa los pines)"));
    while (true) {
      digitalWrite(PIN_LED, !digitalRead(PIN_LED));
      delay(100);
    }
  }
  ayuda();
}

void loop() {
  // --- comandos (de la web o del Monitor Serie)
  while (Serial.available()) {
    const char c = (char)toupper(Serial.read());
    if (c == 'S') modo = AUDIO;
    else if (c == 'X') modo = REPOSO;
    else if (c == 'N') modo = NIVEL;
    else if (c == 'I' && modo != AUDIO) info();
    else if (c == 'H' && modo != AUDIO) ayuda();
    else if (c == '+' || c == '-') {
      gananciaDb = constrain(gananciaDb + (c == '+' ? 3.0f : -3.0f), 0.0f, 36.0f);
      if (modo != AUDIO) Serial.printf("Ganancia %+.0f dB\n", gananciaDb);
    }
  }

  // --- 10 ms de audio
  size_t leidos = 0;
  if (i2s_channel_read(rx, bufI2S, sizeof(bufI2S), &leidos, portMAX_DELAY) != ESP_OK) return;
  const int n = leidos / (2 * sizeof(int32_t));
  bool recorte = false;
  int16_t *pcm = (int16_t *)(trama + 5);
  for (int i = 0; i < n; i++) {
    const float l = (bufI2S[2 * i] >> 8) / 8388608.0f;  // 24 bits útiles, alineados a la izquierda
    const float r = (bufI2S[2 * i + 1] >> 8) / 8388608.0f;
    energiaCanal[0] += (double)l * l;
    energiaCanal[1] += (double)r * r;
    const float x = canal ? r : l;
    const float y = acondicionar(x, recorte);
    pcm[i] = (int16_t)lrintf(y * 32767.0f);
    potEntrada += (double)x * x;
    potSalida += (double)y * y;
  }
  nNivel += n;
  if (recorte) recortes++;

  // --- canal: cada segundo se queda con el que trae señal
  muestrasCanal += n;
  if (muestrasCanal >= (uint32_t)FS) {
    const int otro = 1 - canal;
    if (energiaCanal[otro] > 4.0 * energiaCanal[canal] + 1e-9) {
      canal = otro;
      dcX1 = dcY1 = 0;
    }
    energiaCanal[0] = energiaCanal[1] = 0;
    muestrasCanal = 0;
  }

  if (modo == AUDIO) {
    // trama: A5 5A | secuencia | n | estado | n × int16 (little endian) | suma de verificación
    trama[0] = 0xA5;
    trama[1] = 0x5A;
    trama[2] = secuencia++;
    trama[3] = (uint8_t)n;
    trama[4] = (recorte ? 1 : 0) | (canal ? 2 : 0);
    uint8_t chk = 0;
    for (int i = 0; i < 2 * n; i++) chk += trama[5 + i];
    trama[5 + 2 * n] = chk;
    Serial.write(trama, 6 + 2 * n);
    digitalWrite(PIN_LED, HIGH);
  } else {
    digitalWrite(PIN_LED, (millis() / 500) % 4 == 0);
  }

  // --- medidor de nivel cada 50 ms (dBFS): compara la entrada cruda con la salida filtrada
  if (nNivel >= (uint32_t)FS / 20) {
    if (modo == NIVEL) {
      const double ein = 10 * log10(potEntrada / nNivel + 1e-12);
      const double eout = 10 * log10(potSalida / nNivel + 1e-12);
      Serial.printf("entrada:%.1f filtrada:%.1f recorte:%d\n", ein, eout, recortes ? -3 : -60);
    }
    potEntrada = potSalida = 0;
    nNivel = 0;
    recortes = 0;
  }
}
