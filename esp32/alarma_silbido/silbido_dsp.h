// =====================================================================================
//  Silbido ID · núcleo de procesamiento para el ESP32
//
//  Es la misma cadena que la web (js/dsp/features.js y js/dsp/matcher.js), traducida a C++
//  y reorganizada para trabajar en flujo continuo, muestra a muestra, con poca memoria:
//
//    x[n] → filtro pasa-banda del perfil (IIR en biquads o FIR) → anillo de 1024 muestras
//      → cada 160 muestras (10 ms): ventana Hann + FFT de 2048 → pico espectral con
//        comprobación de subarmónico e interpolación parabólica = f0, pureza, energía
//      → ventana de 494 tramas (5 s) → detección de actividad → segmentos → huella
//      → DTW contra las referencias del perfil + distancias normalizadas → decisión
//
//  No depende de Arduino: solo <math.h> y <stdlib.h>.
// =====================================================================================
#pragma once
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

namespace silbido {

constexpr int FS = 16000;                       // Hz
constexpr int N = 1024;                         // muestras por trama (64 ms)
constexpr int HOP = 160;                        // salto entre tramas (10 ms)
constexpr int NFFT = 2048;                      // FFT con relleno de ceros
constexpr int SHORT_HALF = 160;                 // energía de corto plazo: ±10 ms
constexpr int DUR_S = 5;                        // duración de una toma
constexpr int NSAMP = FS * DUR_S;               // 80000 muestras
constexpr int NFRAMES = 1 + (NSAMP - N) / HOP;  // 494 tramas por toma (igual que la web)
constexpr int MAX_CONTOUR = NFRAMES / 2 + 1;    // contorno cada 20 ms
constexpr int MAX_REFS = 3;
constexpr float DT = (float)HOP / FS;

enum TipoFiltro : uint8_t { IIR = 0, FIR = 1 };

// IIR: n secciones, coef = n × {b0, b1, b2, a1, a2} (a0 = 1).  FIR: n coeficientes h[k].
struct FiltroDef {
  TipoFiltro tipo;
  uint16_t n;
  const float *coef;
  float fl, fh;
};

// Lo que exporta la web (perfil.h): filtro elegido, contornos de referencia, resumen y tolerancias.
struct PerfilDef {
  const char *nombre;
  FiltroDef filtro;
  uint8_t nRefs;
  const float *refs[MAX_REFS];
  uint16_t refLen[MAX_REFS];
  float pitchMidi, durVoiced, segments, purity;                       // resumen
  float tolContour, tolPitch, tolDuration, tolSegments, tolPurity;   // tolerancias τ
};

struct Analisis {
  bool valido;          // al menos 0,3 s con silbido
  float durVoiced;      // s
  int segments;
  float pitchMidi, pitchHz, pitchLow, pitchHigh, rangeSt;
  float purity, snrDb, jitterCents;
  float start, end;     // s, dentro de la ventana
  float peakDb;
  bool clipped, edgeCut;
  int nContour;
  float contour[MAX_CONTOUR];  // semitonos MIDI cada 20 ms
};

struct Resultado {
  bool valido;
  float D, T, similitud;
  bool aceptado;
  float dtw, dPitch, dDur, dSeg, dPur;  // diferencias crudas
  int refMejor;
};

static inline float ldb(float v) { return 10.0f * log10f(v + 1e-30f); }
static inline float hzToMidi(float f) { return 69.0f + 12.0f * log2f(f / 440.0f); }
static inline float midiToHz(float m) { return 440.0f * powf(2.0f, (m - 69.0f) / 12.0f); }

static int cmpFloat(const void *a, const void *b) {
  const float x = *(const float *)a, y = *(const float *)b;
  return (x > y) - (x < y);
}

// Percentil con interpolación lineal (igual que percentile() de la web). Ordena `tmp`.
static float percentil(float *tmp, int n, float p) {
  if (n <= 0) return NAN;
  qsort(tmp, n, sizeof(float), cmpFloat);
  const float i = (n - 1) * p;
  const int lo = (int)floorf(i), hi = (int)ceilf(i);
  return tmp[lo] + (tmp[hi] - tmp[lo]) * (i - lo);
}

// ------------------------------------------------------------------ filtro
class Filtro {
 public:
  bool begin(const FiltroDef &d) {
    def_ = d;
    free(est_);
    est_ = (float *)calloc(d.tipo == IIR ? 2 * d.n : d.n, sizeof(float));
    pos_ = 0;
    return est_ != nullptr;
  }
  void reset() {
    memset(est_, 0, (def_.tipo == IIR ? 2 * def_.n : def_.n) * sizeof(float));
    pos_ = 0;
  }
  inline float procesar(float x) {
    if (def_.tipo == IIR) {
      // biquads en cascada, forma directa II transpuesta
      for (int i = 0; i < def_.n; i++) {
        const float *c = def_.coef + 5 * i;
        float *z = est_ + 2 * i;
        const float y = c[0] * x + z[0];
        z[0] = c[1] * x - c[3] * y + z[1];
        z[1] = c[2] * x - c[4] * y;
        x = y;
      }
      return x;
    }
    // FIR: y[n] = Σ h[k]·x[n−k] con línea de retardo circular
    est_[pos_] = x;
    float acc = 0.0f;
    int j = pos_;
    for (int k = 0; k < def_.n; k++) {
      acc += def_.coef[k] * est_[j];
      j = (j == 0) ? def_.n - 1 : j - 1;
    }
    pos_ = (pos_ + 1) % def_.n;
    return acc;
  }

 private:
  FiltroDef def_{};
  float *est_ = nullptr;
  int pos_ = 0;
};

// ------------------------------------------------------------------ FFT radix-2
class FFT {
 public:
  bool begin() {
    cos_ = (float *)malloc(NFFT / 2 * sizeof(float));
    sin_ = (float *)malloc(NFFT / 2 * sizeof(float));
    rev_ = (uint16_t *)malloc(NFFT * sizeof(uint16_t));
    if (!cos_ || !sin_ || !rev_) return false;
    for (int k = 0; k < NFFT / 2; k++) {
      cos_[k] = (float)cos(2.0 * M_PI * k / NFFT);
      sin_[k] = (float)sin(2.0 * M_PI * k / NFFT);
    }
    int bits = 0;
    while ((1 << bits) < NFFT) bits++;
    for (int i = 0; i < NFFT; i++) {
      int r = 0;
      for (int b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev_[i] = (uint16_t)r;
    }
    return true;
  }
  void run(float *re, float *im) const {
    for (int i = 0; i < NFFT; i++) {
      const int j = rev_[i];
      if (j > i) {
        float t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (int size = 2; size <= NFFT; size <<= 1) {
      const int half = size >> 1, step = NFFT / size;
      for (int i = 0; i < NFFT; i += size) {
        for (int j = 0, k = 0; j < half; j++, k += step) {
          const float wr = cos_[k], wi = -sin_[k];
          const int a = i + j, b = a + half;
          const float xr = re[b] * wr - im[b] * wi;
          const float xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }

 private:
  float *cos_ = nullptr, *sin_ = nullptr;
  uint16_t *rev_ = nullptr;
};

// ------------------------------------------------------------------ DTW
// D(i,j) = |a_i − b_j| + min{D(i−1,j), D(i,j−1), D(i−1,j−1)}; distancia = D(n,m) / largo del camino.
// La web guarda la matriz completa para recorrer el camino hacia atrás. Aquí basta con dos filas:
// el largo del camino que elegiría ese recorrido se propaga hacia adelante con la misma regla.
static float dtwDistancia(const float *a, int n, const float *b, int m) {
  if (n <= 0 || m <= 0) return INFINITY;
  static double Dp[MAX_CONTOUR + 1], Dc[MAX_CONTOUR + 1];
  static int Lp[MAX_CONTOUR + 1], Lc[MAX_CONTOUR + 1];
  if (m > MAX_CONTOUR) m = MAX_CONTOUR;
  Dp[0] = 0;
  for (int j = 1; j <= m; j++) Dp[j] = INFINITY;
  memset(Lp, 0, sizeof(Lp));
  for (int i = 1; i <= n; i++) {
    Dc[0] = INFINITY;
    Lc[0] = 0;
    const double ai = a[i - 1];
    for (int j = 1; j <= m; j++) {
      const double cost = fabs(ai - (double)b[j - 1]);
      const double p = Dp[j], q = Dc[j - 1], r = Dp[j - 1];
      Dc[j] = cost + (p < q ? (p < r ? p : r) : (q < r ? q : r));
      int L;
      if (i == 1 && j == 1) L = 1;
      else if (i == 1) L = Lc[j - 1] + 1;
      else if (j == 1) L = Lp[j] + 1;
      else if (r <= p && r <= q) L = Lp[j - 1] + 1;
      else if (p < q) L = Lp[j] + 1;
      else L = Lc[j - 1] + 1;
      Lc[j] = L;
    }
    memcpy(Dp, Dc, (m + 1) * sizeof(double));
    memcpy(Lp, Lc, (m + 1) * sizeof(int));
  }
  return (float)(Dp[m] / Lp[m]);
}

// D = √( Σ wᵢ·(dᵢ/τᵢ)² / Σ wᵢ ), pesos 3 (melodía), 2 (tono), 1, 1, 1.  Similitud = 100·2^(−(D/T)²).
static Resultado comparar(const Analisis &q, const PerfilDef &p, float T) {
  Resultado r{};
  r.T = T;
  if (!q.valido) return r;
  r.valido = true;
  r.dtw = INFINITY;
  for (int i = 0; i < p.nRefs; i++) {
    const float d = dtwDistancia(q.contour, q.nContour, p.refs[i], p.refLen[i]);
    if (d < r.dtw) {
      r.dtw = d;
      r.refMejor = i;
    }
  }
  r.dPitch = fabsf(q.pitchMidi - p.pitchMidi);
  r.dDur = fabsf(q.durVoiced - p.durVoiced);
  r.dSeg = fabsf((float)q.segments - p.segments);
  r.dPur = fabsf(q.purity - p.purity);
  const float c = r.dtw / p.tolContour, pi = r.dPitch / p.tolPitch, du = r.dDur / p.tolDuration,
              se = r.dSeg / p.tolSegments, pu = r.dPur / p.tolPurity;
  r.D = sqrtf((3 * c * c + 2 * pi * pi + du * du + se * se + pu * pu) / 8.0f);
  r.similitud = 100.0f * powf(2.0f, -(r.D / T) * (r.D / T));
  r.aceptado = r.D <= T;
  return r;
}

// ------------------------------------------------------------------ motor en flujo continuo
// Una "pista" por perfil (cada perfil tiene su propio filtro). Las tramas se guardan en un
// anillo de NFRAMES, así que siempre están disponibles los últimos 5 s.
class Motor {
 public:
  bool begin(const PerfilDef *perfiles, int n) {
    nP_ = n;
    perf_ = perfiles;
    if (!fft_.begin()) return false;
    win_ = (float *)malloc(N * sizeof(float));
    re_ = (float *)malloc(NFFT * sizeof(float));
    im_ = (float *)malloc(NFFT * sizeof(float));
    PA_ = (float *)malloc((NFFT / 2 + 1) * sizeof(float));
    PB_ = (float *)malloc((NFFT / 2 + 1) * sizeof(float));
    pico_ = (float *)calloc(NFRAMES, sizeof(float));
    tmp_ = (float *)malloc(NFRAMES * sizeof(float));
    midi_ = (float *)malloc(NFRAMES * sizeof(float));
    voz_ = (uint8_t *)malloc(NFRAMES);
    pistas_ = new Pista[n];
    if (!win_ || !re_ || !im_ || !PA_ || !PB_ || !pico_ || !tmp_ || !midi_ || !voz_ || !pistas_) return false;
    for (int i = 0; i < N; i++) win_[i] = (float)(0.5 - 0.5 * cos(2.0 * M_PI * i / N));  // Hann periódica
    for (int i = 0; i < n; i++) {
      Pista &s = pistas_[i];
      const FiltroDef &f = perfiles[i].filtro;
      if (!s.filtro.begin(f)) return false;
      s.anillo = (float *)calloc(N, sizeof(float));
      for (int k = 0; k < 7; k++) {
        s.dat[k] = (float *)calloc(NFRAMES, sizeof(float));
        if (!s.dat[k]) return false;
      }
      if (!s.anillo) return false;
      s.kLo = (int)floor(0.6 * f.fl * NFFT / FS);
      if (s.kLo < 2) s.kLo = 2;
      double fhs = 1.15 * f.fh;
      if (fhs > 0.47 * FS) fhs = 0.47 * FS;
      s.kHi = (int)ceil(fhs * NFFT / FS);
      if (s.kHi > NFFT / 2 - 2) s.kHi = NFFT / 2 - 2;
    }
    reiniciar();
    return true;
  }

  void reiniciar() {
    for (int i = 0; i < nP_; i++) {
      pistas_[i].filtro.reset();
      memset(pistas_[i].anillo, 0, N * sizeof(float));
    }
    nIn_ = 0;
    nTr_ = 0;
    pos_ = 0;
    picoHop_ = 0;
  }

  // Entra una muestra (−1…1). Devuelve true cuando se completa una trama nueva.
  bool alimentar(float x) {
    const float ax = fabsf(x);
    if (ax > picoHop_) picoHop_ = ax;
    for (int i = 0; i < nP_; i++) pistas_[i].anillo[pos_] = pistas_[i].filtro.procesar(x);
    pos_ = (pos_ + 1) & (N - 1);
    nIn_++;
    if (nIn_ < (uint32_t)N || (nIn_ - N) % HOP != 0) return false;
    const int f = nTr_ % NFRAMES;
    for (int i = 0; i < nP_; i += 2) calcularTramas(i, i + 1 < nP_ ? i + 1 : -1, f);
    pico_[f] = picoHop_;
    picoHop_ = 0;
    nTr_++;
    return true;
  }

  uint32_t tramas() const { return nTr_; }
  // Datos de una trama absoluta t (debe estar entre las últimas NFRAMES).
  float f0(int p, uint32_t t) const { return pistas_[p].dat[F0][t % NFRAMES]; }
  float energiaDb(int p, uint32_t t) const { return pistas_[p].dat[EDB][t % NFRAMES]; }
  float pureza(int p, uint32_t t) const { return pistas_[p].dat[PUR][t % NFRAMES]; }

  // Analiza la ventana de NFRAMES tramas que empieza en la trama absoluta `inicio` con la pista `p`.
  bool analizar(int p, uint32_t inicio, Analisis &out) {
    memset(&out, 0, sizeof(out));
    if (inicio + NFRAMES > nTr_ || nTr_ - inicio > (uint32_t)NFRAMES) return false;
    const Pista &s = pistas_[p];
    auto at = [&](int k, int t) { return s.dat[k][(inicio + t) % NFRAMES]; };

    // detección de actividad (detectVoicing)
    for (int t = 0; t < NFRAMES; t++) tmp_[t] = at(EDB, t);
    const float eMax = percentil(tmp_, NFRAMES, 0.98f);
    for (int t = 0; t < NFRAMES; t++) tmp_[t] = at(ESH, t);
    const float esMax = percentil(tmp_, NFRAMES, 0.98f);
    for (int t = 0; t < NFRAMES; t++) {
      voz_[t] = at(PUR, t) >= 0.35f && at(EDB, t) >= eMax - 35.0f && at(ESH, t) >= esMax - 25.0f;
    }
    // rellenar huecos de hasta 3 tramas
    int last = -1;
    for (int t = 0; t < NFRAMES; t++) {
      if (!voz_[t]) continue;
      const int gap = t - last - 1;
      if (last >= 0 && gap > 0 && gap <= 3)
        for (int u = last + 1; u < t; u++) voz_[u] = 1;
      last = t;
    }
    // quitar tramos de menos de 5 tramas y listar segmentos
    static int segA[NFRAMES / 2 + 1], segB[NFRAMES / 2 + 1];
    int nSeg = 0;
    for (int t = 0, a = -1; t <= NFRAMES; t++) {
      const bool on = t < NFRAMES && voz_[t];
      if (on && a < 0) a = t;
      if (!on && a >= 0) {
        if (t - a < 5) {
          for (int u = a; u < t; u++) voz_[u] = 0;
        } else {
          segA[nSeg] = a;
          segB[nSeg] = t - 1;
          nSeg++;
        }
        a = -1;
      }
    }

    // contorno de tono: mediana de 5 tramas dentro de cada segmento
    for (int t = 0; t < NFRAMES; t++) midi_[t] = NAN;
    for (int sI = 0; sI < nSeg; sI++) {
      for (int t = segA[sI]; t <= segB[sI]; t++) {
        float v[5];
        int nv = 0;
        const int u0 = t - 2 > segA[sI] ? t - 2 : segA[sI];
        const int u1 = t + 2 < segB[sI] ? t + 2 : segB[sI];
        for (int u = u0; u <= u1; u++) v[nv++] = at(F0, u);
        qsort(v, nv, sizeof(float), cmpFloat);
        midi_[t] = hzToMidi(v[nv >> 1]);
      }
    }

    int nV = 0, nU = 0;
    for (int t = 0; t < NFRAMES; t++) (voz_[t] ? nV : nU)++;
    float peak = 0;
    for (int t = 0; t < NFRAMES; t++) {
      const float v = pico_[(inicio + t) % NFRAMES];
      if (v > peak) peak = v;
    }
    out.durVoiced = nV * DT;
    out.valido = out.durVoiced >= 0.3f;
    out.peakDb = 20.0f * log10f(peak + 1e-12f);
    out.clipped = peak >= 0.985f;
    out.segments = nSeg;

    if (nV) {
      int k = 0;
      for (int t = 0; t < NFRAMES; t++) if (voz_[t]) tmp_[k++] = midi_[t];
      out.pitchMidi = percentil(tmp_, nV, 0.5f);
      out.pitchLow = percentil(tmp_, nV, 0.05f);
      out.pitchHigh = percentil(tmp_, nV, 0.95f);
      out.pitchHz = midiToHz(out.pitchMidi);
      out.rangeSt = out.pitchHigh - out.pitchLow;
      double sp = 0, sig = 0;
      for (int t = 0; t < NFRAMES; t++)
        if (voz_[t]) {
          sp += at(PUR, t);
          sig += at(PKE, t);
        }
      out.purity = (float)(sp / nV);
      sig /= nV;
      // jitter: mediana de |Δf0| entre tramas consecutivas (cents)
      k = 0;
      for (int sI = 0; sI < nSeg; sI++)
        for (int t = segA[sI] + 1; t <= segB[sI]; t++) tmp_[k++] = fabsf(midi_[t] - midi_[t - 1]) * 100.0f;
      out.jitterCents = k ? percentil(tmp_, k, 0.5f) : 0;
      // SNR: energía del pico con silbido contra energía sin silbido
      float noise;
      k = 0;
      if (nU >= 0.1f * NFRAMES) {
        for (int t = 0; t < NFRAMES; t++) if (!voz_[t]) tmp_[k++] = at(TOT, t);
      } else {
        for (int t = 0; t < NFRAMES; t++) if (voz_[t]) tmp_[k++] = at(TOT, t) - at(PKE, t);
      }
      noise = percentil(tmp_, k, 0.5f);
      double den = noise;
      if (den < sig * 1e-6) den = sig * 1e-6;
      if (den < 1e-30) den = 1e-30;
      out.snrDb = (float)(10.0 * log10(sig / den));
      out.start = tiempo(segA[0]) - DT / 2;
      out.end = tiempo(segB[nSeg - 1]) + DT / 2;
      out.edgeCut = out.start < 0.1f || out.end > DUR_S - 0.1f;
    }

    // secuencia para DTW: tramas con silbido, una de cada dos (20 ms), redondeada a centésimas
    int i = 0;
    out.nContour = 0;
    for (int t = 0; t < NFRAMES; t++) {
      if (!voz_[t]) continue;
      if (i % 2 == 0 && out.nContour < MAX_CONTOUR) out.contour[out.nContour++] = floorf(midi_[t] * 100.0f + 0.5f) / 100.0f;
      i++;
    }
    return true;
  }

 private:
  enum { F0 = 0, EDB, ESH, PUR, CEN, PKE, TOT };
  struct Pista {
    Filtro filtro;
    float *anillo = nullptr;  // últimas N muestras filtradas
    float *dat[7] = {};       // f0, eDb, eShort, pureza, centroide, energía del pico, energía total
    int kLo = 2, kHi = 2;
  };

  static float tiempo(int t) { return (t * HOP + N / 2) / (float)FS; }

  // FFT de dos pistas a la vez: z = a + j·b, y luego A[k] = (Z[k] + Z*[N−k])/2, B[k] = (Z[k] − Z*[N−k])/(2j).
  void calcularTramas(int a, int b, int f) {
    for (int n = 0; n < N; n++) {
      const int idx = (pos_ + n) & (N - 1);  // pos_ apunta a la muestra más antigua
      re_[n] = pistas_[a].anillo[idx] * win_[n];
      im_[n] = b >= 0 ? pistas_[b].anillo[idx] * win_[n] : 0.0f;
    }
    for (int n = N; n < NFFT; n++) re_[n] = im_[n] = 0.0f;
    fft_.run(re_, im_);
    for (int k = 0; k <= NFFT / 2; k++) {
      const int kk = (NFFT - k) & (NFFT - 1);
      if (b < 0) {
        PA_[k] = re_[k] * re_[k] + im_[k] * im_[k];
        continue;
      }
      const float ar = 0.5f * (re_[k] + re_[kk]), ai = 0.5f * (im_[k] - im_[kk]);
      const float br = 0.5f * (im_[k] + im_[kk]), bi = -0.5f * (re_[k] - re_[kk]);
      PA_[k] = ar * ar + ai * ai;
      PB_[k] = br * br + bi * bi;
    }
    estadisticas(pistas_[a], PA_, f);
    if (b >= 0) estadisticas(pistas_[b], PB_, f);
  }

  // Igual que trackFrames() de la web para una trama.
  void estadisticas(Pista &s, const float *P, int f) {
    const int kLo = s.kLo, kHi = s.kHi;
    double tot = 0, fw = 0;
    int kmax = kLo;
    float pmax = -1;
    for (int k = kLo; k <= kHi; k++) {
      const float p = P[k];
      tot += p;
      fw += (double)p * k;
      if (p > pmax) {
        pmax = p;
        kmax = k;
      }
    }
    // subarmónico: si hay un pico en f/2 a menos de 20 dB, ese es el fundamental
    const int kh = (kmax + 1) / 2;  // Math.round(kmax / 2)
    if (kh - 2 >= kLo) {
      int best = kh;
      float pb = -1;
      for (int k = kh - 2; k <= kh + 2; k++)
        if (P[k] > pb) {
          pb = P[k];
          best = k;
        }
      if (pb > pmax * 0.01f) {
        kmax = best;
        pmax = pb;
      }
    }
    // interpolación parabólica del pico en dB
    float delta = 0;
    if (kmax > kLo && kmax < kHi) {
      const float al = ldb(P[kmax - 1]), be = ldb(P[kmax]), ga = ldb(P[kmax + 1]);
      const float den = al - 2 * be + ga;
      if (den < 0) {
        delta = 0.5f * (al - ga) / den;
        if (delta > 0.5f) delta = 0.5f;
        if (delta < -0.5f) delta = -0.5f;
      }
    }
    double pe = 0;
    const int k0 = kmax - 4 > kLo ? kmax - 4 : kLo, k1 = kmax + 4 < kHi ? kmax + 4 : kHi;
    for (int k = k0; k <= k1; k++) pe += P[k];
    // energía de corto plazo (20 ms) alrededor del centro de la trama
    double es = 0;
    for (int n = N / 2 - SHORT_HALF; n < N / 2 + SHORT_HALF; n++) {
      const float y = s.anillo[(pos_ + n) & (N - 1)];
      es += (double)y * y;
    }
    s.dat[F0][f] = (kmax + delta) * FS / (float)NFFT;
    s.dat[PKE][f] = (float)pe;
    s.dat[TOT][f] = (float)tot;
    s.dat[PUR][f] = tot > 0 ? (float)(pe / tot) : 0.0f;
    s.dat[EDB][f] = ldb((float)tot);
    s.dat[CEN][f] = tot > 0 ? (float)(fw / tot) * FS / NFFT : 0.0f;
    s.dat[ESH][f] = ldb((float)(es / (2 * SHORT_HALF)));
  }

  int nP_ = 0;
  const PerfilDef *perf_ = nullptr;
  Pista *pistas_ = nullptr;
  FFT fft_;
  float *win_ = nullptr, *re_ = nullptr, *im_ = nullptr, *PA_ = nullptr, *PB_ = nullptr;
  float *pico_ = nullptr, *tmp_ = nullptr, *midi_ = nullptr;
  uint8_t *voz_ = nullptr;
  uint32_t nIn_ = 0, nTr_ = 0;
  int pos_ = 0;
  float picoHop_ = 0;
};

}  // namespace silbido
