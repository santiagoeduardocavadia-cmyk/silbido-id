// =====================================================================================
//  Silbido ID · Alarma antirrobo por silbidos (ESP32 + módulo de sonido + LM358)
//
//  La ESP32 escucha todo el tiempo con el micrófono del protoboard. Cuando reconoce el
//  silbido "Armar" o el silbido "Desarmar" del dueño, se lo avisa al celular por Bluetooth
//  (BLE). La página alarma.html, abierta en el celular que está cargando, hace el resto:
//  vigila si lo levantan o lo desconectan y hace sonar la sirena.
//
//    GPIO34 ─ ADC 12 bits a 64 kHz (DMA) → FIR 7 kHz + diezmado ×4 → 16 kHz → bloqueo de DC
//      → motor de silbido_dsp.h (filtro de cada perfil, f0, huella, DTW)
//      → ¿"Armar" o "Desarmar"? (rigurosidad estricta, sin ambigüedad)
//      → mensaje {"ev":"ARMAR","n":42,"d":0.31,"tok":"…"} firmado con HMAC-SHA256 → BLE notify
//
//  Conexiones: las del circuito hardware/electret.html (salida del LM358 por R6 a GPIO34).
//    LED de la placa (GPIO2): estado. Buzzer opcional en GPIO4 (pita al reconocer).
//
//  Archivos de esta carpeta:
//    perfil.h        los perfiles "Armar" y "Desarmar" exportados desde la web (sus nombres
//                    deben contener "armar" y "desarmar")
//    secreto.h       tu secreto (copia secreto.ejemplo.h); no se sube a GitHub
//    silbido_dsp.h   copia del motor de reconocimiento de esp32/reconocedor_autonomo
//
//  Placa: "ESP32 Dev Module" (núcleo esp32 de Espressif 3.x). Monitor Serie a 115200 baudios.
//  Comandos: n = nivel del micrófono · m = monitor de tramas · i = info · g = grabar 5 s ahora
//            a / d = enviar ARMAR / DESARMAR sin silbar (prueba del enlace) · h = ayuda
// =====================================================================================
#include <Arduino.h>
#include <Preferences.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLE2902.h>
#include "esp_adc/adc_continuous.h"
#include "mbedtls/md.h"

#include "silbido_dsp.h"
#include "perfil.h"
#if __has_include("secreto.h")
#include "secreto.h"
#else
#include "secreto.ejemplo.h"
#define SECRETO_DE_EJEMPLO 1
#endif

using namespace silbido;

// ------------------------------------------------------------------ configuración
constexpr int PIN_LED = 2;
constexpr int PIN_BUZZER = 4;   // opcional
constexpr int PIN_BOTON = 0;    // BOOT: graba 5 s ahora

constexpr uint32_t FS_ADC = 64000;  // muestreo del ADC
constexpr int DIEZMA = 4;           // 64 kHz / 4 = 16 kHz
constexpr int NTAPS_AA = 63;        // pasa-bajos anti-aliasing digital
constexpr float R_DC = 0.995f;

constexpr float RIGUROSIDAD = 0.8f;    // estricta
constexpr float MARGEN = 0.6f;         // si los dos perfiles aceptan, el ganador debe tener D < 0,6 · D del otro
constexpr float PRE_ROLL_S = 0.8f;
constexpr float DISPARO_DB = 12.0f;
constexpr float DISPARO_PUREZA = 0.5f;
constexpr int DISPARO_TRAMAS = 4;
constexpr uint32_t PAUSA_MS = 1500;

// Servicio BLE propio (los mismos UUID están en js/alarma/ble.js)
#define UUID_SERVICIO "a7c1f0e2-3b54-4c6d-8e9f-51b1d0a1a000"
#define UUID_EVENTO "a7c1f0e2-3b54-4c6d-8e9f-51b1d0a1a001"
#define UUID_ESTADO "a7c1f0e2-3b54-4c6d-8e9f-51b1d0a1a002"
#define NOMBRE_BLE "SilbidoAlarma"

static_assert(NUM_PERFILES >= 2 && NUM_PERFILES <= 4, "perfil.h debe traer los perfiles Armar y Desarmar");
static_assert(FS == 16000, "el motor trabaja a 16 kHz");

// ------------------------------------------------------------------ estado
static Motor motor;
static Analisis analisis;
static adc_continuous_handle_t adc = nullptr;
static uint8_t bufAdc[1024];
static float firAA[NTAPS_AA];
static float lineaAA[NTAPS_AA];
static int posAA = 0, faseDiezmado = 0;
static float dcX1 = 0, dcY1 = 0;

enum Escucha { ESCUCHANDO, CAPTURANDO, PAUSA };
static Escucha escucha = ESCUCHANDO;
static uint32_t inicioVentana = 0, pausaHasta = 0;
static float pisoDb = 1e9f;
static int racha = 0;
static bool monitorTramas = false, monitorNivel = false;
static double sumaRaw = 0, potNivel = 0;
static uint32_t nRaw = 0, nNivel = 0;

static int perfilArmar = -1, perfilDesarmar = -1;

static Preferences prefs;
static uint32_t contador = 0;

static BLEServer *servidor = nullptr;
static BLECharacteristic *chEvento = nullptr;
static volatile bool conectado = false, reanunciar = false;
static String estadoCelular = "DESARMADA";
static uint32_t ledHasta = 0;  // mientras millis() < ledHasta, el LED lo controla un parpadeo de confirmación

// ------------------------------------------------------------------ utilidades
static void led(bool on) { digitalWrite(PIN_LED, on ? HIGH : LOW); }

static void parpadear(int veces, int ms) {
  for (int i = 0; i < veces; i++) {
    led(true);
    delay(ms);
    led(false);
    delay(ms);
  }
  ledHasta = millis() + 50;
}

static void pitar(int veces, int ms, int hz) {
  for (int i = 0; i < veces; i++) {
    tone(PIN_BUZZER, hz, ms);
    delay(ms + 60);
  }
}

static bool contiene(const char *texto, const char *buscado) {
  String t(texto);
  t.toLowerCase();
  return t.indexOf(buscado) >= 0;
}

// ------------------------------------------------------------------ firma de los mensajes
// tok = primeros 8 bytes (hex) de HMAC-SHA256(SECRETO_ALARMA, "<ev>:<n>")
static String token(const char *ev, uint32_t n, const char *secreto = SECRETO_ALARMA) {
  char msg[32];
  snprintf(msg, sizeof(msg), "%s:%lu", ev, (unsigned long)n);
  uint8_t out[32];
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), (const uint8_t *)secreto, strlen(secreto),
                  (const uint8_t *)msg, strlen(msg), out);
  char hex[17];
  for (int i = 0; i < 8; i++) snprintf(hex + 2 * i, 3, "%02x", out[i]);
  return String(hex);
}

static void enviar(const char *ev, float d) {
  contador++;
  prefs.putUInt("n", contador);
  char json[128];
  snprintf(json, sizeof(json), "{\"ev\":\"%s\",\"n\":%lu,\"d\":%.2f,\"tok\":\"%s\"}", ev, (unsigned long)contador, d,
           token(ev, contador).c_str());
  chEvento->setValue((uint8_t *)json, strlen(json));
  if (conectado) chEvento->notify();
  Serial.printf(">>> Enviado %s %s\n", json, conectado ? "" : "(no hay celular conectado: quedará como último evento)");
}

// ------------------------------------------------------------------ BLE
class AlServidor : public BLEServerCallbacks {
  void onConnect(BLEServer *) override {
    conectado = true;
    Serial.println(F("Celular conectado por Bluetooth"));
  }
  void onDisconnect(BLEServer *) override {
    conectado = false;
    reanunciar = true;
    Serial.println(F("Celular desconectado"));
  }
};

class AlEstado : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    String v = c->getValue();
    v.trim();
    if (v.length() && v.length() < 16) {
      estadoCelular = v;
      Serial.printf("El celular está %s\n", v.c_str());
    }
  }
};

static void iniciarBle() {
  BLEDevice::init(NOMBRE_BLE);
  servidor = BLEDevice::createServer();
  servidor->setCallbacks(new AlServidor());
  BLEService *s = servidor->createService(UUID_SERVICIO);
  chEvento = s->createCharacteristic(UUID_EVENTO, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  chEvento->addDescriptor(new BLE2902());
  chEvento->setValue("{}");
  BLECharacteristic *chEstado =
      s->createCharacteristic(UUID_ESTADO, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  chEstado->setCallbacks(new AlEstado());
  s->start();
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(UUID_SERVICIO);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
}

// ------------------------------------------------------------------ ADC continuo (de silbido_adc)
static void disenarFirAA() {
  const float fc = 7000.0f / FS_ADC;
  float suma = 0;
  for (int n = 0; n < NTAPS_AA; n++) {
    const int m = n - (NTAPS_AA - 1) / 2;
    const float ideal = m == 0 ? 2 * fc : sinf(2 * PI * fc * m) / (PI * m);
    firAA[n] = ideal * (0.54f - 0.46f * cosf(2 * PI * n / (NTAPS_AA - 1)));
    suma += firAA[n];
  }
  for (int n = 0; n < NTAPS_AA; n++) firAA[n] /= suma;
}

static bool iniciarAdc() {
  adc_continuous_handle_cfg_t hc = {};
  hc.max_store_buf_size = 8192;
  hc.conv_frame_size = sizeof(bufAdc);
  if (adc_continuous_new_handle(&hc, &adc) != ESP_OK) return false;
  adc_digi_pattern_config_t pat = {};
  pat.atten = ADC_ATTEN_DB_12;
  pat.channel = ADC_CHANNEL_6;  // GPIO34
  pat.unit = ADC_UNIT_1;
  pat.bit_width = SOC_ADC_DIGI_MAX_BITWIDTH;
  adc_continuous_config_t cc = {};
  cc.pattern_num = 1;
  cc.adc_pattern = &pat;
  cc.sample_freq_hz = FS_ADC;
  cc.conv_mode = ADC_CONV_SINGLE_UNIT_1;
  cc.format = ADC_DIGI_OUTPUT_FORMAT_TYPE1;
  if (adc_continuous_config(adc, &cc) != ESP_OK) return false;
  return adc_continuous_start(adc) == ESP_OK;
}

// ------------------------------------------------------------------ decisión
static void decidir() {
  const uint32_t t0 = millis();
  Serial.println();
  Serial.println(F("=== Silbido capturado ==="));
  float D[4] = {INFINITY, INFINITY, INFINITY, INFINITY};
  bool ok[4] = {false, false, false, false};
  for (int i = 0; i < NUM_PERFILES; i++) {
    if (!motor.analizar(i, inicioVentana, analisis)) {
      Serial.println(F("  (la ventana ya no está completa)"));
      return;
    }
    const Resultado r = comparar(analisis, PERFILES[i], RIGUROSIDAD);
    if (r.valido) {
      D[i] = r.D;
      ok[i] = r.aceptado;
      Serial.printf("  %-20s D = %.2f · similitud %.0f %% · %s\n", PERFILES[i].nombre, r.D, r.similitud,
                    r.aceptado ? "ACEPTADO" : "rechazado");
    } else {
      Serial.printf("  %-20s sin silbido claro\n", PERFILES[i].nombre);
    }
  }
  int mejor = -1, segundo = -1;
  for (int i = 0; i < NUM_PERFILES; i++) {
    if (mejor < 0 || D[i] < D[mejor]) {
      segundo = mejor;
      mejor = i;
    } else if (segundo < 0 || D[i] < D[segundo]) {
      segundo = i;
    }
  }
  Serial.printf("Análisis: %lu ms\n", (unsigned long)(millis() - t0));
  const bool claro = mejor >= 0 && ok[mejor] && (segundo < 0 || !ok[segundo] || D[mejor] < MARGEN * D[segundo]);
  if (!claro) {
    Serial.println(mejor >= 0 && ok[mejor] ? F(">>> Ambiguo: se parece a dos perfiles. No se envía nada.\n")
                                            : F(">>> No es un silbido del dueño. No se envía nada.\n"));
    led(true);
    delay(700);
    led(false);
    ledHasta = millis() + 50;
    return;
  }
  if (mejor == perfilDesarmar) {
    Serial.printf(">>> DESARMAR (%s, D = %.2f)\n", PERFILES[mejor].nombre, D[mejor]);
    enviar("DESARMAR", D[mejor]);
    pitar(1, 300, 1200);
    parpadear(4, 90);
  } else if (mejor == perfilArmar) {
    Serial.printf(">>> ARMAR (%s, D = %.2f)\n", PERFILES[mejor].nombre, D[mejor]);
    enviar("ARMAR", D[mejor]);
    pitar(2, 120, 2400);
    parpadear(2, 300);
  } else {
    Serial.printf(">>> Es %s, que no es ni Armar ni Desarmar. No se envía nada.\n", PERFILES[mejor].nombre);
  }
}

// ------------------------------------------------------------------ cada trama (10 ms)
static void alCompletarTrama() {
  const uint32_t t = motor.tramas() - 1;
  const float e = motor.energiaDb(0, t);
  const float pur = motor.pureza(0, t);
  if (monitorTramas && t % 10 == 0) {
    Serial.printf("f0 %6.0f Hz · pureza %3.0f %% · energía %6.1f dB · piso %6.1f dB\n", motor.f0(0, t), pur * 100, e, pisoDb);
  }
  switch (escucha) {
    case ESCUCHANDO: {
      if (e < pisoDb) pisoDb = e;
      else pisoDb += 0.02f;  // sube despacio (2 dB/s)
      racha = (pur >= DISPARO_PUREZA && e >= pisoDb + DISPARO_DB) ? racha + 1 : 0;
      if (racha >= DISPARO_TRAMAS && motor.tramas() > 100) {
        const uint32_t pre = (uint32_t)(PRE_ROLL_S / DT) + DISPARO_TRAMAS;
        const uint32_t masViejo = motor.tramas() > (uint32_t)NFRAMES ? motor.tramas() - NFRAMES : 0;
        inicioVentana = t + 1 > pre ? t + 1 - pre : 0;
        if (inicioVentana < masViejo) inicioVentana = masViejo;
        escucha = CAPTURANDO;
        Serial.println(F("Silbido detectado: capturando 5 s…"));
      }
      break;
    }
    case CAPTURANDO:
      if (motor.tramas() >= inicioVentana + NFRAMES) {
        decidir();
        escucha = PAUSA;
        pausaHasta = millis() + PAUSA_MS;
      }
      break;
    case PAUSA:
      if ((int32_t)(millis() - pausaHasta) >= 0) {
        escucha = ESCUCHANDO;
        racha = 0;
        Serial.println(F("Escuchando…"));
      }
      break;
  }
}

// Una muestra cruda del ADC a 64 kHz: FIR + diezmado ×4 → bloqueo de DC → motor a 16 kHz.
static inline void entrada64k(uint16_t raw) {
  sumaRaw += raw;
  nRaw++;
  lineaAA[posAA] = (raw - 2048.0f) / 2048.0f;
  posAA = (posAA + 1) % NTAPS_AA;
  if (++faseDiezmado < DIEZMA) return;
  faseDiezmado = 0;
  float acc = 0;
  int j = posAA;
  for (int k = NTAPS_AA - 1; k >= 0; k--) {
    acc += firAA[k] * lineaAA[j];
    j = (j + 1) % NTAPS_AA;
  }
  const float d = acc - dcX1 + R_DC * dcY1;  // quita los 1,65 V de VREF
  dcX1 = acc;
  dcY1 = d;
  potNivel += (double)d * d;
  nNivel++;
  if (motor.alimentar(d)) alCompletarTrama();
}

// ------------------------------------------------------------------ indicador LED
static void actualizarLed() {
  if ((int32_t)(millis() - ledHasta) < 0) return;
  const uint32_t ms = millis();
  if (escucha == CAPTURANDO) return led(true);
  if (!conectado) return led(ms % 2000 < 60);           // destello cada 2 s: esperando al celular
  if (estadoCelular == "SONANDO" || estadoCelular == "ALERTA") return led((ms / 100) % 2);
  if (estadoCelular == "ARMADA" || estadoCelular == "ARMANDO") return led(true);
  led(ms % 1000 < 60);                                   // conectado y desarmada
}

// ------------------------------------------------------------------ mensajes
static void info() {
  Serial.printf("Perfiles (rigurosidad T = %.2f):\n", RIGUROSIDAD);
  for (int i = 0; i < NUM_PERFILES; i++) {
    const PerfilDef &p = PERFILES[i];
    Serial.printf("  %d. %s · %s %.0f–%.0f Hz · tono %.0f Hz · %.2f s%s\n", i + 1, p.nombre, p.filtro.tipo == IIR ? "IIR" : "FIR",
                  p.filtro.fl, p.filtro.fh, midiToHz(p.pitchMidi), p.durVoiced,
                  i == perfilArmar ? "  ← ARMAR" : i == perfilDesarmar ? "  ← DESARMAR" : "");
  }
  Serial.printf("Bluetooth: %s · %s · contador %lu\n", NOMBRE_BLE, conectado ? "celular conectado" : "esperando al celular",
                (unsigned long)contador);
}

static void ayuda() {
  Serial.println(F("Comandos: n = nivel del micrófono · m = monitor de tramas · i = info · g = grabar 5 s ahora"));
  Serial.println(F("          a / d = enviar ARMAR / DESARMAR sin silbar (prueba del enlace) · h = ayuda"));
}

// ------------------------------------------------------------------ Arduino
void setup() {
  Serial.begin(115200);
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_BOTON, INPUT_PULLUP);
  delay(300);
  Serial.println();
  Serial.println(F("Silbido ID · Alarma por silbidos (módulo de sonido + LM358 en GPIO34)"));

  for (int i = 0; i < NUM_PERFILES; i++) {
    if (contiene(PERFILES[i].nombre, "desarm")) perfilDesarmar = i;
    else if (contiene(PERFILES[i].nombre, "arm")) perfilArmar = i;
  }
  if (perfilArmar < 0 || perfilDesarmar < 0) {
    Serial.println(F("ERROR: perfil.h necesita un perfil cuyo nombre contenga \"Armar\" y otro con \"Desarmar\"."));
    while (true) parpadear(3, 100);
  }
#ifdef SECRETO_DE_EJEMPLO
  Serial.println(F("AVISO: usas el secreto de ejemplo. Copia secreto.ejemplo.h como secreto.h y cámbialo."));
#endif
  if (strlen(SECRETO_ALARMA) < 16) Serial.println(F("AVISO: el secreto tiene menos de 16 caracteres."));
  // autoprueba de la firma (el mismo vector está en tests/alarma.test.mjs)
  const bool hmacOk = token("ARMAR", 1, "secreto-de-prueba-123") == "bdab41943d25082d";
  Serial.printf("Autoprueba de la firma HMAC: %s\n", hmacOk ? "correcta" : "FALLA");

  prefs.begin("alarma", false);
  contador = prefs.getUInt("n", 0);

  if (!motor.begin(PERFILES, NUM_PERFILES)) {
    Serial.println(F("ERROR: no hay memoria para el motor de análisis"));
    while (true) parpadear(1, 100);
  }
  disenarFirAA();
  if (!iniciarAdc()) {
    Serial.println(F("ERROR: no se pudo iniciar el ADC continuo"));
    while (true) parpadear(2, 100);
  }
  iniciarBle();
  info();
  Serial.printf("Memoria libre: %u bytes\n", (unsigned)ESP.getFreeHeap());
  ayuda();
  Serial.println(F("Escuchando…"));
}

void loop() {
  while (Serial.available()) {
    const char c = (char)tolower(Serial.read());
    if (c == 'n') {
      monitorNivel = !monitorNivel;
      Serial.printf("Nivel %s\n", monitorNivel ? "activado (adc_crudo debe rondar 2000 en silencio)" : "desactivado");
    } else if (c == 'm') {
      monitorTramas = !monitorTramas;
    } else if (c == 'i') {
      info();
    } else if (c == 'g' && escucha != CAPTURANDO) {
      inicioVentana = motor.tramas();
      escucha = CAPTURANDO;
      Serial.println(F("Grabando 5 s: silba ahora…"));
    } else if (c == 'a') {
      enviar("ARMAR", 0);
    } else if (c == 'd') {
      enviar("DESARMAR", 0);
    } else if (c == 'h') {
      ayuda();
    }
  }

  uint32_t n = 0;
  if (adc_continuous_read(adc, bufAdc, sizeof(bufAdc), &n, 100) == ESP_OK) {
    for (uint32_t i = 0; i + SOC_ADC_DIGI_RESULT_BYTES <= n; i += SOC_ADC_DIGI_RESULT_BYTES) {
      const adc_digi_output_data_t *p = (const adc_digi_output_data_t *)&bufAdc[i];
      if (p->type1.channel == ADC_CHANNEL_6) entrada64k(p->type1.data);
    }
  }

  if (monitorNivel && nNivel >= (uint32_t)FS / 5) {
    Serial.printf("nivel:%.1f dB · adc_crudo:%.0f\n", 10 * log10(potNivel / nNivel + 1e-12), nRaw ? sumaRaw / nRaw : 0.0);
  }
  if (nNivel >= (uint32_t)FS / 5) {
    potNivel = sumaRaw = 0;
    nNivel = nRaw = 0;
  }

  if (reanunciar) {
    reanunciar = false;
    delay(200);
    BLEDevice::startAdvertising();
  }

  static uint32_t ultimoBoton = 0;
  if (digitalRead(PIN_BOTON) == LOW && escucha != CAPTURANDO && millis() - ultimoBoton > 800) {
    ultimoBoton = millis();
    inicioVentana = motor.tramas();
    escucha = CAPTURANDO;
    Serial.println(F("Grabando 5 s: silba ahora…"));
  }
  actualizarLed();
}
