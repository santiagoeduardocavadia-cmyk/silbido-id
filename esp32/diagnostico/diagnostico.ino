// =====================================================================================
//  Silbido ID · diagnóstico del INMP441 (Monitor Serie a 115200)
//
//  1. Prueba de pines: con las resistencias internas pull-up y pull-down de la ESP32 se ve si
//     SCK (GPIO26), WS (GPIO25) o SD (GPIO32) están en corto a GND, a 3V3 o entre ellos.
//  2. Datos crudos del I2S: cuántas muestras distintas de cero llegan por cada canal.
//  Se repite cada 4 s. Después vuelve a subir esp32/silbido_id.
// =====================================================================================
#include <Arduino.h>
#include <driver/i2s_std.h>
#include "lectura.h"

const int PINS[3] = {26, 25, 32};
const char *NOMBRES[3] = {"SCK (GPIO26)", "WS  (GPIO25)", "SD  (GPIO32)"};
i2s_chan_handle_t rx = nullptr;

static const char *estadoPin(int pin) {
  pinMode(pin, INPUT_PULLUP);
  delay(3);
  const int up = digitalRead(pin);
  pinMode(pin, INPUT_PULLDOWN);
  delay(3);
  const int down = digitalRead(pin);
  pinMode(pin, INPUT);
  if (up == 1 && down == 0) return "libre (bien)";
  if (up == 0 && down == 0) return "EN CORTO A GND";
  if (up == 1 && down == 1) return "EN CORTO A 3V3 / VDD";
  return "raro (cambia al revés)";
}

static void pruebaPines() {
  Serial.println(F("--- 1) Pines (micrófono conectado y alimentado)"));
  for (int i = 0; i < 3; i++) Serial.printf("  %s: %s\n", NOMBRES[i], estadoPin(PINS[i]));
  // cortos entre señales: se fuerza un pin y se mira si los otros lo siguen
  for (int i = 0; i < 3; i++) {
    for (int j = 0; j < 3; j++) {
      if (i == j) continue;
      pinMode(PINS[j], INPUT_PULLDOWN);
      pinMode(PINS[i], OUTPUT);
      digitalWrite(PINS[i], HIGH);
      delay(3);
      const int a = digitalRead(PINS[j]);
      pinMode(PINS[j], INPUT_PULLUP);
      digitalWrite(PINS[i], LOW);
      delay(3);
      const int b = digitalRead(PINS[j]);
      pinMode(PINS[i], INPUT);
      pinMode(PINS[j], INPUT);
      if (a == 1 && b == 0 && i < j) Serial.printf("  CORTO entre %s y %s\n", NOMBRES[i], NOMBRES[j]);
    }
  }
}

static bool iniciarI2S() {
  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  if (i2s_new_channel(&chan, nullptr, &rx) != ESP_OK) return false;
  i2s_std_config_t cfg = {
      .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(16000),
      .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
      .gpio_cfg = {.mclk = I2S_GPIO_UNUSED, .bclk = GPIO_NUM_26, .ws = GPIO_NUM_25, .dout = I2S_GPIO_UNUSED, .din = GPIO_NUM_32,
                   .invert_flags = {.mclk_inv = false, .bclk_inv = false, .ws_inv = false}},
  };
  if (i2s_channel_init_std_mode(rx, &cfg) != ESP_OK) return false;
  return i2s_channel_enable(rx) == ESP_OK;
}

static void pruebaI2S() {
  Serial.println(F("--- 2) Datos crudos del I2S (0,5 s)"));
  if (!iniciarI2S()) {
    Serial.println(F("  No se pudo iniciar el I2S"));
    return;
  }
  static int32_t buf[512];
  uint32_t nz[2] = {0, 0}, total = 0;
  int32_t mn[2] = {INT32_MAX, INT32_MAX}, mx[2] = {INT32_MIN, INT32_MIN};
  uint32_t first[2][4] = {{0}};
  int nf[2] = {0, 0};
  const uint32_t t0 = millis();
  while (millis() - t0 < 500) {
    size_t n = 0;
    i2s_channel_read(rx, buf, sizeof(buf), &n, 1000);
    for (size_t k = 0; k + 1 < n / 4; k += 2) {
      for (int c = 0; c < 2; c++) {
        const int32_t v = buf[k + c] >> 8;
        if (v != 0) nz[c]++;
        if (v < mn[c]) mn[c] = v;
        if (v > mx[c]) mx[c] = v;
        if (nf[c] < 4 && total > 2000) first[c][nf[c]++] = (uint32_t)buf[k + c];
      }
      total++;
    }
  }
  for (int c = 0; c < 2; c++) {
    Serial.printf("  Canal %s: %lu de %lu muestras distintas de 0 · min %ld · max %ld · crudo %08lx %08lx %08lx %08lx\n", c ? "der" : "izq",
                  (unsigned long)nz[c], (unsigned long)total, (long)mn[c], (long)mx[c], (unsigned long)first[c][0], (unsigned long)first[c][1],
                  (unsigned long)first[c][2], (unsigned long)first[c][3]);
  }
  i2s_channel_disable(rx);
  i2s_del_channel(rx);
  rx = nullptr;
  if (nz[0] + nz[1] == 0) Serial.println(F("  => El micrófono NO responde: falta alimentación (VDD/GND) o no le llega el reloj (SCK/WS)."));
  else if (mn[0] == mx[0] && mn[1] == mx[1]) Serial.println(F("  => Llega un valor fijo: la línea SD está pegada; revisa SD y la soldadura."));
  else Serial.println(F("  => ¡Llegan datos! El micrófono funciona. Vuelve a subir esp32/silbido_id."));
}

// 3) Por si los cables quedaron cruzados del lado del micrófono: prueba las 6 formas de asignar
//    GPIO26, GPIO25 y GPIO32 a SCK, WS y SD, y dice con cuál llegan datos.
static uint32_t probar(int bclk, int ws, int din) {
  i2s_chan_handle_t h = nullptr;
  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  if (i2s_new_channel(&chan, nullptr, &h) != ESP_OK) return 0;
  i2s_std_config_t cfg = {
      .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(16000),
      .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
      .gpio_cfg = {.mclk = I2S_GPIO_UNUSED, .bclk = (gpio_num_t)bclk, .ws = (gpio_num_t)ws, .dout = I2S_GPIO_UNUSED, .din = (gpio_num_t)din,
                   .invert_flags = {.mclk_inv = false, .bclk_inv = false, .ws_inv = false}},
  };
  uint32_t nz = 0;
  if (i2s_channel_init_std_mode(h, &cfg) == ESP_OK && i2s_channel_enable(h) == ESP_OK) {
    static int32_t buf[512];
    const uint32_t t0 = millis();
    uint32_t vistos = 0;
    while (millis() - t0 < 400) {
      size_t n = 0;
      i2s_channel_read(h, buf, sizeof(buf), &n, 1000);
      for (size_t k = 0; k < n / 4; k++) {
        if (++vistos < 2000) continue;  // se ignora el arranque del micrófono
        if ((buf[k] >> 8) != 0 && (buf[k] >> 8) != -1) nz++;
      }
    }
    i2s_channel_disable(h);
  }
  i2s_del_channel(h);
  return nz;
}

static void pruebaCruces() {
  Serial.println(F("--- 3) ¿Cables cruzados? (SCK, WS, SD)"));
  const int p[3] = {26, 25, 32};
  const int perm[6][3] = {{0, 1, 2}, {1, 0, 2}, {0, 2, 1}, {2, 0, 1}, {1, 2, 0}, {2, 1, 0}};
  bool alguna = false;
  for (auto &q : perm) {
    const uint32_t nz = probar(p[q[0]], p[q[1]], p[q[2]]);
    Serial.printf("  SCK=GPIO%d WS=GPIO%d SD=GPIO%d -> %lu muestras con datos%s\n", p[q[0]], p[q[1]], p[q[2]], (unsigned long)nz,
                  nz > 100 ? "  <== FUNCIONA" : "");
    if (nz > 100) alguna = true;
  }
  if (!alguna) Serial.println(F("  => Ninguna combinación da datos: revisa VDD/GND del micrófono o puede estar dañado."));
}

// 4) Autoprueba del firmware (no depende del micrófono):
//    a) ¿salen los relojes por los pines?  b) ¿el código lee bien la línea de datos?
//    c) ¿alguna otra configuración del I2S sí recibe datos del micrófono?

static Lectura leerI2S(uint32_t fs, bool mono, bool msb, int pull) {
  Lectura L = {0, 0, 0, 0, 0};
  i2s_chan_handle_t h = nullptr;
  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  if (i2s_new_channel(&chan, nullptr, &h) != ESP_OK) return L;
  i2s_std_slot_config_t slot = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, mono ? I2S_SLOT_MODE_MONO : I2S_SLOT_MODE_STEREO);
  if (msb) slot = I2S_STD_MSB_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, mono ? I2S_SLOT_MODE_MONO : I2S_SLOT_MODE_STEREO);
  if (mono) slot.slot_mask = I2S_STD_SLOT_LEFT;
  i2s_std_config_t cfg = {
      .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(fs),
      .slot_cfg = slot,
      .gpio_cfg = {.mclk = I2S_GPIO_UNUSED, .bclk = GPIO_NUM_26, .ws = GPIO_NUM_25, .dout = I2S_GPIO_UNUSED, .din = GPIO_NUM_32,
                   .invert_flags = {.mclk_inv = false, .bclk_inv = false, .ws_inv = false}},
  };
  if (i2s_channel_init_std_mode(h, &cfg) == ESP_OK && i2s_channel_enable(h) == ESP_OK) {
    gpio_set_pull_mode(GPIO_NUM_32, pull > 0 ? GPIO_PULLUP_ONLY : pull < 0 ? GPIO_PULLDOWN_ONLY : GPIO_FLOATING);
    // se habilita también la entrada en los pines de reloj para poder leer lo que sale por ellos
    gpio_set_direction(GPIO_NUM_26, GPIO_MODE_INPUT_OUTPUT);
    gpio_set_direction(GPIO_NUM_25, GPIO_MODE_INPUT_OUTPUT);
    int a = gpio_get_level(GPIO_NUM_26), b = gpio_get_level(GPIO_NUM_25);
    for (int i = 0; i < 200000; i++) {
      const int a2 = gpio_get_level(GPIO_NUM_26), b2 = gpio_get_level(GPIO_NUM_25);
      if (a2 != a) L.cambiosSck++;
      if (b2 != b) L.cambiosWs++;
      a = a2;
      b = b2;
    }
    static int32_t buf[512];
    const uint32_t t0 = millis();
    uint32_t vistos = 0;
    while (millis() - t0 < 350) {
      size_t n = 0;
      i2s_channel_read(h, buf, sizeof(buf), &n, 1000);
      for (size_t k = 0; k < n / 4; k++) {
        if (++vistos < 1500) continue;
        L.total++;
        const int32_t v = buf[k] >> 8;
        if (v != 0) L.noCero++;
        if (v == -1) L.unos++;
      }
    }
    i2s_channel_disable(h);
    gpio_set_pull_mode(GPIO_NUM_32, GPIO_FLOATING);
  }
  i2s_del_channel(h);
  return L;
}

static void autoprueba() {
  Serial.println(F("--- 4) Autoprueba del firmware"));
  Lectura L = leerI2S(16000, false, false, 0);
  Serial.printf("  a) Relojes: SCK (GPIO26) cambió %lu veces, WS (GPIO25) cambió %lu veces en 200000 lecturas -> %s\n", (unsigned long)L.cambiosSck,
                (unsigned long)L.cambiosWs, (L.cambiosSck > 1000 && L.cambiosWs > 50) ? "LOS RELOJES SALEN BIEN" : "FALLA: no hay reloj en el pin");
  Lectura U = leerI2S(16000, false, false, +1);
  Lectura D = leerI2S(16000, false, false, -1);
  Serial.printf("  b) Lectura con pull-up en SD: %lu de %lu distintas de 0 (%lu en alto). Con pull-down: %lu de %lu.\n", (unsigned long)U.noCero,
                (unsigned long)U.total, (unsigned long)U.unos, (unsigned long)D.noCero, (unsigned long)D.total);
  if (U.unos > U.total / 2 && D.noCero == 0)
    Serial.println(F("     -> EL CODIGO LEE BIEN, pero la línea SD está 'al aire': el micrófono no la maneja (no transmite)."));
  else if (U.noCero == 0)
    Serial.println(F("     -> La línea SD está sujeta a 0 por algo externo (el micrófono u otro contacto la mantiene en bajo)."));
  else
    Serial.println(F("     -> Llegan datos variables por SD."));
  struct { const char *n; uint32_t fs; bool mono, msb; } cfgs[] = {
      {"16 kHz estéreo Philips (la del firmware)", 16000, false, false}, {"16 kHz mono izquierdo", 16000, true, false},
      {"48 kHz estéreo", 48000, false, false},                          {"32 kHz estéreo", 32000, false, false},
      {"16 kHz estéreo formato MSB", 16000, false, true},
  };
  bool alguna = false;
  for (auto &c : cfgs) {
    Lectura R = leerI2S(c.fs, c.mono, c.msb, -1);
    const uint32_t datos = R.noCero - R.unos;
    Serial.printf("  c) %s: %lu muestras con datos%s\n", c.n, (unsigned long)datos, datos > 100 ? "  <== FUNCIONA" : "");
    if (datos > 100) alguna = true;
  }
  if (!alguna) Serial.println(F("     -> Ninguna configuración recibe datos del micrófono."));
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println(F("\n=== Diagnóstico INMP441 ==="));
}

void loop() {
  pruebaPines();
  pruebaI2S();
  pruebaCruces();
  autoprueba();
  Serial.println();
  delay(3000);
}
