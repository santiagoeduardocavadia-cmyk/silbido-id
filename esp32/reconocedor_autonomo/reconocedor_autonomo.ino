// =====================================================================================
//  Silbido ID · ESP32 + micrófono I2S INMP441
//
//  Escucha todo el tiempo. Cuando detecta un silbido, toma una ventana de 5 s (con 0,8 s de
//  antes del inicio), la analiza con la misma cadena que la web y la compara con los perfiles de
//  perfil.h. Si el silbido es de una persona registrada, enciende la salida (LED o relé).
//
//  Conexiones (las mismas de hardware/index.html):
//    INMP441 VDD → 3V3     INMP441 GND → GND     INMP441 L/R → GND
//    INMP441 SCK → GPIO26  INMP441 WS  → GPIO25  INMP441 SD  → GPIO32
//    LED externo o relé (opcional) → GPIO4 (LED con resistencia de 220 Ω a GND)
//
//  Placa: "ESP32 Dev Module" (núcleo esp32 de Espressif 3.x). Monitor Serie a 115200 baudios.
//
//  Perfiles: en la web, pestaña Perfiles → "Exportar para ESP32 (.h)", y reemplaza perfil.h.
//  El filtro de cada perfil ya viene elegido por la auto-sintonía; aquí no se configura.
// =====================================================================================
#include <Arduino.h>
#include <driver/i2s_std.h>

#include "silbido_dsp.h"
#include "perfil.h"
#if __has_include("prueba_audio.h")
#include "prueba_audio.h"
#define HAY_PRUEBA 1
#else
#define HAY_PRUEBA 0
#endif

using namespace silbido;

// ------------------------------------------------------------------ configuración
constexpr int PIN_I2S_SCK = 26;
constexpr int PIN_I2S_WS = 25;
constexpr int PIN_I2S_SD = 32;
constexpr int PIN_LED = 2;      // LED integrado de la DevKit
constexpr int PIN_SALIDA = 4;   // LED externo o módulo relé
constexpr int PIN_BOTON = 0;    // botón BOOT: fuerza una grabación de 5 s

constexpr float RIGUROSIDAD = 1.0f;      // umbral T: 1,3 permisiva · 1,0 normal · 0,8 estricta
constexpr float PRE_ROLL_S = 0.8f;       // audio que se guarda antes de que empiece el silbido
constexpr float DISPARO_DB = 12.0f;      // dB sobre el ruido de fondo para considerar que hay silbido
constexpr float DISPARO_PUREZA = 0.5f;   // pureza tonal mínima de la trama
constexpr int DISPARO_TRAMAS = 4;        // tramas seguidas (40 ms) que deben cumplirlo
constexpr uint32_t SALIDA_MS = 3000;     // tiempo que queda encendida la salida al aceptar
constexpr uint32_t PAUSA_MS = 1500;      // espera después de cada decisión

static_assert(NUM_PERFILES >= 1 && NUM_PERFILES <= 4, "perfil.h debe tener entre 1 y 4 perfiles");

// ------------------------------------------------------------------ estado
static Motor motor;
static i2s_chan_handle_t rx = nullptr;
static int32_t bufI2S[HOP * 2];  // 160 tramas estéreo de 32 bits
static Analisis analisis;

enum Estado { ESCUCHANDO, CAPTURANDO, PAUSA };
static Estado estado = ESCUCHANDO;
static uint32_t inicioVentana = 0;
static uint32_t pausaHasta = 0, salidaHasta = 0;
static float pisoDb = 1e9f;
static int racha = 0;
static bool monitor = false;

// El INMP441 entrega el dato en el canal izquierdo si L/R está a GND (derecho si va a 3V3).
// Se leen los dos y se usa el que tenga señal: así funciona aunque L/R quede al revés.
static int canal = 0;
static double energiaCanal[2] = {0, 0};
static uint32_t muestrasCanal = 0;

// ------------------------------------------------------------------ I2S
static bool iniciarI2S() {
  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  chan.dma_desc_num = 8;
  chan.dma_frame_num = 320;  // 8 × 20 ms de margen mientras se analiza
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

// ------------------------------------------------------------------ salidas
static void led(bool on) { digitalWrite(PIN_LED, on ? HIGH : LOW); }

static void parpadear(int veces, int ms) {
  for (int i = 0; i < veces; i++) {
    led(true);
    delay(ms);
    led(false);
    delay(ms);
  }
}

// ------------------------------------------------------------------ informe
static void imprimirAnalisis(const Analisis &a) {
  if (!a.valido) {
    Serial.printf("  Sin silbido claro (%.2f s con tono; se necesitan 0,3 s)\n", a.durVoiced);
    return;
  }
  Serial.printf("  Tono %.0f Hz (MIDI %.2f) · rango %.1f st · %.2f s con silbido · %d segmentos\n", a.pitchHz, a.pitchMidi,
                a.rangeSt, a.durVoiced, a.segments);
  Serial.printf("  Pureza %.0f %% · SNR %.1f dB · estabilidad %.1f cents · pico %.1f dBFS%s%s\n", a.purity * 100, a.snrDb,
                a.jitterCents, a.peakDb, a.clipped ? " · SATURADO" : "", a.edgeCut ? " · cortado en el borde" : "");
}

static void imprimirResultado(const PerfilDef &p, const Resultado &r) {
  Serial.printf("  → %-18s D = %.2f  similitud %5.1f %%  %s\n", p.nombre, r.D, r.similitud, r.aceptado ? "ACEPTADO" : "rechazado");
  Serial.printf("      melodía (DTW) %.2f/%.2f st · tono %.2f/%.2f st · duración %.2f/%.2f s · segm. %.1f/%.1f · pureza %.3f/%.3f\n",
                r.dtw, p.tolContour, r.dPitch, p.tolPitch, r.dDur, p.tolDuration, r.dSeg, p.tolSegments, r.dPur, p.tolPurity);
}

// Analiza la ventana con el filtro de cada perfil y decide (verificación 1:N).
static void decidir() {
  const uint32_t t0 = millis();
  Serial.println();
  Serial.println(F("=== Silbido capturado ==="));
  int mejor = -1;
  float mejorD = INFINITY;
  for (int i = 0; i < NUM_PERFILES; i++) {
    if (!motor.analizar(i, inicioVentana, analisis)) {
      Serial.println(F("  (la ventana ya no está completa)"));
      return;
    }
    Serial.printf("[%s · filtro %s %.0f–%.0f Hz]\n", PERFILES[i].nombre, PERFILES[i].filtro.tipo == IIR ? "IIR" : "FIR",
                  PERFILES[i].filtro.fl, PERFILES[i].filtro.fh);
    imprimirAnalisis(analisis);
    const Resultado r = comparar(analisis, PERFILES[i], RIGUROSIDAD);
    if (r.valido) {
      imprimirResultado(PERFILES[i], r);
      if (r.aceptado && r.D < mejorD) {
        mejorD = r.D;
        mejor = i;
      }
    }
  }
  Serial.printf("Análisis: %lu ms\n", (unsigned long)(millis() - t0));
  if (mejor >= 0) {
    Serial.printf(">>> ES %s (D = %.2f ≤ T = %.2f)\n\n", PERFILES[mejor].nombre, mejorD, RIGUROSIDAD);
    digitalWrite(PIN_SALIDA, HIGH);
    salidaHasta = millis() + SALIDA_MS;
    parpadear(3, 80);
  } else {
    Serial.println(F(">>> No coincide con ningún perfil\n"));
    led(true);
    delay(700);
    led(false);
  }
}

#if HAY_PRUEBA
// Pasa el audio de prueba embebido por la misma cadena y lo compara con lo que calculó la web.
static void pruebaEmbebida() {
  Serial.println();
  Serial.printf("=== Prueba sin micrófono: %s ===\n", PRUEBA_DESCRIPCION);
  motor.reiniciar();
  const uint32_t t0 = millis();
  for (int n = 0; n < NSAMP; n++) motor.alimentar(PRUEBA_AUDIO[n] / 32768.0f);
  const uint32_t t1 = millis();
  Serial.printf("Filtrado + %lu tramas: %lu ms (tiempo real: 5000 ms)\n", (unsigned long)motor.tramas(), (unsigned long)(t1 - t0));
  int ok = 0, total = 0;
  for (int i = 0; i < NUM_PERFILES; i++) {
    motor.analizar(i, 0, analisis);
    const Resultado r = comparar(analisis, PERFILES[i], RIGUROSIDAD);
    Serial.printf("[%s]\n", PERFILES[i].nombre);
    imprimirAnalisis(analisis);
    imprimirResultado(PERFILES[i], r);
    const PruebaEsperado *e = nullptr;
    for (int j = 0; j < PRUEBA_N; j++)
      if (strcmp(PRUEBA_ESPERADO[j].nombre, PERFILES[i].nombre) == 0) e = &PRUEBA_ESPERADO[j];
    if (!e) {
      Serial.println(F("  (perfil sin valores de referencia: genera prueba_audio.h junto con perfil.h)"));
      continue;
    }
    const bool bien = analisis.segments == e->segments && fabsf(analisis.pitchMidi - e->pitchMidi) < 0.05f &&
                      fabsf(analisis.durVoiced - e->durVoiced) < 0.051f && fabsf(analisis.purity - e->purity) < 0.01f &&
                      fabsf(r.D - e->D) < 0.05f && r.aceptado == e->aceptado;
    Serial.printf("  web:   MIDI %.2f · %.2f s · %d segm. · pureza %.3f · D = %.2f %s\n", e->pitchMidi, e->durVoiced, e->segments,
                  e->purity, e->D, e->aceptado ? "ACEPTADO" : "rechazado");
    Serial.printf("  %s\n", bien ? "COINCIDE con la web" : "DIFIERE de la web");
    ok += bien;
    total++;
  }
  Serial.printf("Resultado de la prueba: %d/%d perfiles coinciden con la web\n\n", ok, total);
  motor.reiniciar();
  estado = ESCUCHANDO;
  pisoDb = 1e9f;
  racha = 0;
}
#endif

static void ayuda() {
  Serial.println(F("Comandos: g = grabar 5 s ahora · m = monitor on/off · i = perfiles · p = prueba sin micrófono · h = ayuda"));
  Serial.println(F("Botón BOOT = grabar 5 s ahora"));
}

static void infoPerfiles() {
  Serial.printf("%d perfil(es) en perfil.h · rigurosidad T = %.2f\n", NUM_PERFILES, RIGUROSIDAD);
  for (int i = 0; i < NUM_PERFILES; i++) {
    const PerfilDef &p = PERFILES[i];
    Serial.printf("  %d. %s · filtro %s %s %.0f–%.0f Hz · tono %.0f Hz · %.2f s · %.1f segm.\n", i + 1, p.nombre,
                  p.filtro.tipo == IIR ? "IIR" : "FIR",
                  p.filtro.tipo == IIR ? (String(p.filtro.n * 2) + " polos").c_str() : (String(p.filtro.n) + " coef.").c_str(),
                  p.filtro.fl, p.filtro.fh, midiToHz(p.pitchMidi), p.durVoiced, p.segments);
  }
}

static void grabarAhora() {
  inicioVentana = motor.tramas();
  estado = CAPTURANDO;
  led(true);
  Serial.println(F("Grabando 5 s: silba ahora…"));
}

// ------------------------------------------------------------------ cada trama (10 ms)
static void alCompletarTrama() {
  const uint32_t t = motor.tramas() - 1;
  const float e = motor.energiaDb(0, t);
  const float pur = motor.pureza(0, t);
  if (monitor && t % 10 == 0) {
    Serial.printf("f0 %6.0f Hz · pureza %3.0f %% · energía %6.1f dB · piso %6.1f dB · canal %s\n", motor.f0(0, t), pur * 100, e,
                  pisoDb, canal ? "der" : "izq");
  }
  switch (estado) {
    case ESCUCHANDO: {
      // piso de ruido: baja de inmediato y sube despacio (2 dB/s)
      if (e < pisoDb) pisoDb = e;
      else pisoDb += 0.02f;
      racha = (pur >= DISPARO_PUREZA && e >= pisoDb + DISPARO_DB) ? racha + 1 : 0;
      if (racha >= DISPARO_TRAMAS && motor.tramas() > 100) {
        const uint32_t pre = (uint32_t)(PRE_ROLL_S / DT) + DISPARO_TRAMAS;
        const uint32_t masViejo = motor.tramas() > (uint32_t)NFRAMES ? motor.tramas() - NFRAMES : 0;
        inicioVentana = t + 1 > pre ? t + 1 - pre : 0;
        if (inicioVentana < masViejo) inicioVentana = masViejo;
        estado = CAPTURANDO;
        led(true);
        Serial.println(F("Silbido detectado: capturando 5 s…"));
      }
      break;
    }
    case CAPTURANDO:
      if (motor.tramas() >= inicioVentana + NFRAMES) {
        led(false);
        decidir();
        estado = PAUSA;
        pausaHasta = millis() + PAUSA_MS;
      }
      break;
    case PAUSA:
      if ((int32_t)(millis() - pausaHasta) >= 0) {
        estado = ESCUCHANDO;
        racha = 0;
        Serial.println(F("Escuchando…"));
      }
      break;
  }
}

// ------------------------------------------------------------------ Arduino
void setup() {
  Serial.begin(115200);
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_SALIDA, OUTPUT);
  pinMode(PIN_BOTON, INPUT_PULLUP);
  digitalWrite(PIN_SALIDA, LOW);
  delay(300);
  Serial.println();
  Serial.println(F("Silbido ID · ESP32 + INMP441"));
  if (!motor.begin(PERFILES, NUM_PERFILES)) {
    Serial.println(F("ERROR: no hay memoria para el motor de análisis"));
    while (true) parpadear(1, 100);
  }
  infoPerfiles();
  if (!iniciarI2S()) {
    Serial.println(F("ERROR: no se pudo iniciar el I2S (revisa los pines)"));
    while (true) parpadear(2, 100);
  }
  Serial.printf("Memoria libre: %u bytes\n", (unsigned)ESP.getFreeHeap());
  ayuda();
  Serial.println(F("Escuchando…"));
}

void loop() {
  size_t leidos = 0;
  if (i2s_channel_read(rx, bufI2S, sizeof(bufI2S), &leidos, portMAX_DELAY) != ESP_OK) return;
  const int pares = leidos / (2 * sizeof(int32_t));
  for (int i = 0; i < pares; i++) {
    // 24 bits útiles en los bits altos de cada palabra de 32 bits
    const float l = (bufI2S[2 * i] >> 8) / 8388608.0f;
    const float r = (bufI2S[2 * i + 1] >> 8) / 8388608.0f;
    energiaCanal[0] += (double)l * l;
    energiaCanal[1] += (double)r * r;
    if (motor.alimentar(canal ? r : l)) alCompletarTrama();
  }
  // cada segundo, mientras solo escucha, se queda con el canal que trae señal
  muestrasCanal += pares;
  if (muestrasCanal >= (uint32_t)FS) {
    if (estado == ESCUCHANDO) {
      const int otro = 1 - canal;
      if (energiaCanal[otro] > 4.0 * energiaCanal[canal] + 1e-9) {
        canal = otro;
        pisoDb = 1e9f;
        Serial.printf("Usando el canal %s del I2S\n", canal ? "derecho (L/R a 3V3)" : "izquierdo (L/R a GND)");
      } else if (energiaCanal[canal] < 1e-9) {
        Serial.println(F("AVISO: el micrófono no entrega datos. Revisa VDD, GND, SCK, WS y SD."));
      }
    }
    energiaCanal[0] = energiaCanal[1] = 0;
    muestrasCanal = 0;
  }

  if (salidaHasta && (int32_t)(millis() - salidaHasta) >= 0) {
    digitalWrite(PIN_SALIDA, LOW);
    salidaHasta = 0;
  }
  // LED: parpadeo lento mientras escucha
  if (estado == ESCUCHANDO) led((millis() / 500) % 4 == 0);

  static uint32_t ultimoBoton = 0;
  if (digitalRead(PIN_BOTON) == LOW && estado != CAPTURANDO && millis() - ultimoBoton > 800) {
    ultimoBoton = millis();
    grabarAhora();
  }
  while (Serial.available()) {
    const char c = (char)tolower(Serial.read());
    if (c == 'g' && estado != CAPTURANDO) grabarAhora();
    else if (c == 'm') {
      monitor = !monitor;
      Serial.printf("Monitor %s\n", monitor ? "activado" : "desactivado");
    } else if (c == 'i') infoPerfiles();
    else if (c == 'h' || c == '?') ayuda();
    else if (c == 'p') {
#if HAY_PRUEBA
      pruebaEmbebida();
#else
      Serial.println(F("No hay prueba_audio.h en la carpeta del sketch."));
#endif
    }
  }
}
