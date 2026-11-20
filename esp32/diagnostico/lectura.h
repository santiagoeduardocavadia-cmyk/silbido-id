#pragma once
#include <stdint.h>
// Resultado de una lectura de prueba del I2S (autoprueba del diagnóstico)
struct Lectura {
  uint32_t total, noCero, unos;  // muestras leídas, distintas de 0, iguales a -1 (línea en alto)
  uint32_t cambiosSck, cambiosWs;
};
