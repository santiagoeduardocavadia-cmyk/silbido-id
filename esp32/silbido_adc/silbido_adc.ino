// =====================================================================================
//  Silbido ID · ESP32 + micrófono comercial (módulo de sonido + LM358)
//
//  Circuito: hardware/electret.html. La salida del amplificador entra a GPIO34 (ADC1 canal 6),
//  centrada en 1,65 V. La ESP32 hace todo el filtrado fino en digital y manda el audio por USB
//  con el mismo protocolo que el firmware del INMP441, así que la web no cambia.
//
//    GPIO34 ─ ADC 12 bits a 64 kHz (DMA)
//      → pasa-bajos FIR de 63 coeficientes (corte 7 kHz) y diezmado ×4 → 16 kHz
//      → bloqueo de DC → pasa-banda de filtro.h → ganancia + limitador suave → USB (921600)
//
//  Sobremuestrear a 64 kHz es lo que permite no poner un filtro anti-aliasing analógico de
//  2.º orden: lo que hay entre 8 y 32 kHz lo quita el FIR antes de bajar a 16 kHz.
//
//  Comandos (921600 baudios): N nivel · S enviar audio · X detener · I info JSON · +/- ganancia · H ayuda
//  Placa: "ESP32 Dev Module" (núcleo esp32 de Espressif 3.x).
// =====================================================================================
#include <Arduino.h>
#include "esp_adc/adc_continuous.h"

#include "filtro.h"

static_assert(SILBIDO_FS == 16000, "filtro.h debe estar diseñado para 16 kHz");

// ------------------------------------------------------------------ configuración
constexpr int PIN_LED = 2;
constexpr uint32_t BAUDIOS = 921600;
constexpr uint32_t FS_ADC = 64000;  // muestreo del ADC
constexpr int DIEZMA = 4;           // 64 kHz / 4 = 16 kHz
constexpr int FS = FS_ADC / DIEZMA;
constexpr int BLOQUE = 160;         // 10 ms por trama USB
constexpr int NTAPS = 63;           // pasa-bajos anti-aliasing digital
constexpr float R_DC = 0.995f;
constexpr float LIM = 0.8f;

static float gananciaDb = 0.0f;  // el LM358 ya amplifica ×47; ajusta con +/− si hace falta

// ------------------------------------------------------------------ estado
enum Modo { REPOSO, AUDIO, NIVEL };
static Modo modo = REPOSO;
static adc_continuous_handle_t adc = nullptr;
static uint8_t bufAdc[1024];
static float h[NTAPS];
static float linea[NTAPS];
static int posLinea = 0, faseDiezmado = 0;
static float dcX1 = 0, dcY1 = 0;
static int16_t pcm[BLOQUE];
static int nPcm = 0;
static uint8_t trama[6 + 2 * BLOQUE];
static uint8_t secuencia = 0;
static bool recorteBloque = false;

// medidas
static double potEntrada = 0, potSalida = 0, sumaRaw = 0;
static uint32_t nRaw = 0;
static uint32_t nNivel = 0, recortes = 0, crudasSeg = 0, fsMedida = 0, tSeg = 0;

// ------------------------------------------------------------------ pasa-bajos FIR (ventana de Hamming)
static void disenarFir() {
  const float fc = 7000.0f / FS_ADC;  // corte normalizado
  float suma = 0;
  for (int n = 0; n < NTAPS; n++) {
    const int m = n - (NTAPS - 1) / 2;
    const float ideal = m == 0 ? 2 * fc : sinf(2 * PI * fc * m) / (PI * m);
    const float w = 0.54f - 0.46f * cosf(2 * PI * n / (NTAPS - 1));
    h[n] = ideal * w;
    suma += h[n];
  }
  for (int n = 0; n < NTAPS; n++) h[n] /= suma;  // ganancia 1 en continua
}

// ------------------------------------------------------------------ ADC continuo (DMA)
static bool iniciarAdc() {
  adc_continuous_handle_cfg_t hc = {};
  hc.max_store_buf_size = 8192;
  hc.conv_frame_size = sizeof(bufAdc);
  if (adc_continuous_new_handle(&hc, &adc) != ESP_OK) return false;
  adc_digi_pattern_config_t pat = {};
  pat.atten = ADC_ATTEN_DB_12;  // rango ~0,15 – 3,1 V
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

// ------------------------------------------------------------------ cadena a 16 kHz
static inline float limitar(float x) {
  const float a = fabsf(x);
  if (a <= LIM) return x;
  recorteBloque = true;
  const float y = LIM + (1.0f - LIM) * tanhf((a - LIM) / (1.0f - LIM));
  return x < 0 ? -y : y;
}

static void enviarBloque() {
  if (modo == AUDIO) {
    trama[0] = 0xA5;
    trama[1] = 0x5A;
    trama[2] = secuencia++;
    trama[3] = BLOQUE;
    trama[4] = recorteBloque ? 1 : 0;
    memcpy(trama + 5, pcm, 2 * BLOQUE);
    uint8_t chk = 0;
    for (int i = 0; i < 2 * BLOQUE; i++) chk += trama[5 + i];
    trama[5 + 2 * BLOQUE] = chk;
    Serial.write(trama, 6 + 2 * BLOQUE);
  }
  if (recorteBloque) recortes++;
  recorteBloque = false;
}

// Una muestra ya diezmada a 16 kHz (valor del ADC centrado, −1…1).
static void procesar16k(float x) {
  const float d = x - dcX1 + R_DC * dcY1;  // bloqueo de DC: quita los 1,65 V de VREF
  dcX1 = x;
  dcY1 = d;
  static float g = 1, gDb = -1000;
  if (gDb != gananciaDb) {
    gDb = gananciaDb;
    g = powf(10.0f, gananciaDb / 20.0f);
  }
  const float y = limitar(g * silbido_filtrar(d));
  pcm[nPcm++] = (int16_t)lrintf(y * 32767.0f);
  potEntrada += (double)d * d;
  potSalida += (double)y * y;
  nNivel++;
  if (nPcm == BLOQUE) {
    enviarBloque();
    nPcm = 0;
  }
}

// Una muestra cruda del ADC a 64 kHz: FIR + diezmado ×4 (solo se calcula 1 de cada 4 salidas).
static inline void entrada64k(uint16_t raw) {
  sumaRaw += raw;
  nRaw++;
  crudasSeg++;
  linea[posLinea] = (raw - 2048.0f) / 2048.0f;
  posLinea = (posLinea + 1) % NTAPS;
  if (++faseDiezmado < DIEZMA) return;
  faseDiezmado = 0;
  float acc = 0;
  int j = posLinea;  // muestra más antigua
  for (int k = NTAPS - 1; k >= 0; k--) {
    acc += h[k] * linea[j];
    j = (j + 1) % NTAPS;
  }
  procesar16k(acc);
}

// ------------------------------------------------------------------ mensajes
static void info() {
  Serial.printf("{\"dispositivo\":\"silbido-id\",\"version\":1,\"fuente\":\"adc\",\"fs\":%d,\"fs_adc\":%lu,\"filtro\":\"%s\",\"fl\":%.0f,\"fh\":%.0f,"
                "\"ganancia_db\":%.0f,\"canal\":\"izq\",\"baudios\":%lu}\n",
                FS, (unsigned long)FS_ADC, SILBIDO_FILTRO, (double)SILBIDO_FL, (double)SILBIDO_FH, gananciaDb, (unsigned long)BAUDIOS);
}

static void ayuda() {
  Serial.println(F("Silbido ID · ESP32 + módulo de sonido + LM358 (GPIO34)"));
  Serial.printf("ADC a %lu Hz -> FIR 7 kHz y diezmado x%d -> %d Hz -> %s · ganancia %+.0f dB\n", (unsigned long)FS_ADC, DIEZMA, FS, SILBIDO_FILTRO, gananciaDb);
  Serial.println(F("Comandos: N = nivel · S = audio a la web · X = detener · I = info · +/- = ganancia · H = ayuda"));
}

void setup() {
  Serial.setTxBufferSize(8192);
  Serial.setRxBufferSize(256);
  Serial.begin(BAUDIOS);
  pinMode(PIN_LED, OUTPUT);
  delay(200);
  disenarFir();
  if (!iniciarAdc()) {
    Serial.println(F("ERROR: no se pudo iniciar el ADC continuo"));
    while (true) {
      digitalWrite(PIN_LED, !digitalRead(PIN_LED));
      delay(100);
    }
  }
  tSeg = millis();
  ayuda();
}

void loop() {
  while (Serial.available()) {
    const char c = (char)toupper(Serial.read());
    if (c == 'S') modo = AUDIO;
    else if (c == 'X') modo = REPOSO;
    else if (c == 'N') modo = NIVEL;
    else if (c == 'I' && modo != AUDIO) info();
    else if (c == 'H' && modo != AUDIO) ayuda();
    else if (c == '+' || c == '-') {
      gananciaDb = constrain(gananciaDb + (c == '+' ? 3.0f : -3.0f), -12.0f, 30.0f);
      if (modo != AUDIO) Serial.printf("Ganancia %+.0f dB\n", gananciaDb);
    }
  }

  uint32_t n = 0;
  if (adc_continuous_read(adc, bufAdc, sizeof(bufAdc), &n, 100) == ESP_OK) {
    for (uint32_t i = 0; i + SOC_ADC_DIGI_RESULT_BYTES <= n; i += SOC_ADC_DIGI_RESULT_BYTES) {
      const adc_digi_output_data_t *p = (const adc_digi_output_data_t *)&bufAdc[i];
      if (p->type1.channel == ADC_CHANNEL_6) entrada64k(p->type1.data);
    }
  }

  digitalWrite(PIN_LED, modo == AUDIO ? HIGH : (millis() / 500) % 4 == 0);

  // frecuencia de muestreo real (para comprobar que el ADC va a 64 kHz)
  if (millis() - tSeg >= 1000) {
    fsMedida = crudasSeg;
    crudasSeg = 0;
    tSeg += 1000;
  }
  // medidor cada 50 ms: nivel de entrada (tras quitar la continua) y de salida filtrada, y tensión media del ADC
  if (nNivel >= (uint32_t)FS / 20) {
    if (modo == NIVEL) {
      const double ein = 10 * log10(potEntrada / nNivel + 1e-12);
      const double eout = 10 * log10(potSalida / nNivel + 1e-12);
      const double mediaRaw = nRaw ? sumaRaw / nRaw : 0;
      Serial.printf("entrada:%.1f filtrada:%.1f recorte:%d adc_crudo:%.0f fs_adc:%lu\n", ein, eout, recortes ? -3 : -60, mediaRaw,
                    (unsigned long)fsMedida);
    }
    potEntrada = potSalida = 0;
    nNivel = 0;
    recortes = 0;
    sumaRaw = 0;
    nRaw = 0;
  }
}
