// ===========================================================
//  Filtro pasa-banda para el silbido — generado por Silbido ID
//  fs = 16000 Hz · banda = 400–7000 Hz
//  Butterworth IIR orden 6
// ===========================================================
#pragma once
#define SILBIDO_FS 16000
#define SILBIDO_FL 400.000000f
#define SILBIDO_FH 7000.00000f
#define SILBIDO_FILTRO "Butterworth IIR orden 6 · 400-7000 Hz"
#define SILBIDO_NUM_SECCIONES 3

// Cada fila: { b0, b1, b2, a1, a2 }  (a0 = 1)
static const float SILBIDO_SOS[SILBIDO_NUM_SECCIONES][5] = {
  { 0.780013454f, 0.00000000f, -0.780013454f, -0.190514318f, -0.560026908f },
  { 1.27583883f, 0.00000000f, -1.27583883f, 1.55335509f, 0.683359547f },
  { 0.575657720f, 0.00000000f, -0.575657720f, -1.83392341f, 0.857132016f },
};

// Estado de cada sección (forma directa II transpuesta)
static float silbido_z[SILBIDO_NUM_SECCIONES][2] = {{0}};

static inline float silbido_filtrar(float x) {
  for (int i = 0; i < SILBIDO_NUM_SECCIONES; i++) {
    const float *c = SILBIDO_SOS[i];
    float y = c[0] * x + silbido_z[i][0];
    silbido_z[i][0] = c[1] * x - c[3] * y + silbido_z[i][1];
    silbido_z[i][1] = c[2] * x - c[4] * y;
    x = y;
  }
  return x;
}
