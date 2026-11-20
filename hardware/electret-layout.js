/**
 * Circuito "módulo de sonido + LM358" en baquela perforada (paso 2,54 mm).
 * Coordenadas en agujeros: x hacia la derecha, y hacia abajo, vistas desde el lado de los componentes.
 * Este archivo es la única fuente: el esquemático, el plano de montaje y el validador lo usan.
 */
export const BOARD = { cols: 18, rows: 13 };

export const NETS = {
  GND: { label: 'GND', color: '#2e323d' },
  V5: { label: '5 V (VIN)', color: '#e5484d' },
  V33: { label: '3,3 V', color: '#f59f00' },
  VA: { label: '3,3 V filtrado', color: '#ff8b3d' },
  VDIV: { label: 'Divisor 1,65 V', color: '#9775fa' },
  VREF: { label: 'VREF (1,65 V)', color: '#7950f2' },
  AO: { label: 'Señal del micrófono', color: '#12b886' },
  N1: { label: 'C2–R2', color: '#20c997' },
  IN: { label: 'Entrada − (pin 2)', color: '#4dabf7' },
  OUT: { label: 'Salida amplificada', color: '#1c7ed6' },
  ADC: { label: 'A GPIO34', color: '#0b7285' },
};

// tipo: res (resistencia), cap (cerámico/poliéster), ecap (electrolítico, pad 0 = +), dip8, header
export const PARTS = [
  { id: 'J1', type: 'header', value: 'ESP32', pads: [[17, 3, 'V5', '5V (VIN)'], [17, 4, 'V33', '3V3'], [17, 5, 'ADC', 'GPIO34'], [17, 6, 'GND', 'GND']] },
  { id: 'J2', type: 'header', value: 'Módulo', pads: [[0, 4, 'VA', 'VCC (+)'], [0, 5, 'AO', 'AO'], [0, 6, 'GND', 'GND (G)']] },
  {
    id: 'U1',
    type: 'dip8',
    value: 'LM358',
    // pin 1 abajo a la izquierda (muesca a la izquierda)
    pads: [
      [7, 7, 'OUT', '1'], [8, 7, 'IN', '2'], [9, 7, 'VREF', '3'], [10, 7, 'GND', '4'],
      [10, 4, 'VDIV', '5'], [9, 4, 'VREF', '6'], [8, 4, 'VREF', '7'], [7, 4, 'V5', '8'],
    ],
  },
  { id: 'R1', type: 'res', value: '100 Ω', lbl: 'l', pads: [[16, 4, 'V33'], [16, 0, 'VA']] },
  { id: 'C1', type: 'ecap', value: '100 µF', pads: [[2, 1, 'VA'], [2, 2, 'GND']] },
  { id: 'C4', type: 'cap', value: '150 nF', lbl: 'b', pads: [[1, 1, 'VA'], [1, 3, 'GND']] },
  { id: 'R3', type: 'res', value: '10 kΩ', pads: [[12, 0, 'VA'], [12, 4, 'VDIV']] },
  { id: 'R4', type: 'res', value: '10 kΩ', pads: [[13, 4, 'VDIV'], [13, 8, 'GND']] },
  { id: 'C5', type: 'ecap', value: '10 µF', pads: [[11, 4, 'VDIV'], [11, 5, 'GND']] },
  { id: 'C3', type: 'cap', value: '150 nF', pads: [[6, 2, 'V5'], [6, 4, 'GND']] },
  { id: 'C7', type: 'ecap', value: '10 µF', pads: [[5, 2, 'V5'], [5, 3, 'GND']] },
  { id: 'C2', type: 'cap', value: '47 nF', pads: [[1, 5, 'AO'], [3, 5, 'N1']] },
  { id: 'R2', type: 'res', value: '10 kΩ', pads: [[3, 8, 'N1'], [7, 8, 'IN']] },
  { id: 'R5', type: 'res', value: '470 kΩ', pads: [[4, 10, 'OUT'], [8, 10, 'IN']] },
  { id: 'C6', type: 'cap', value: '47 pF', pads: [[6, 11, 'OUT'], [8, 11, 'IN']] },
  { id: 'R6', type: 'res', value: '1 kΩ', pads: [[11, 10, 'OUT'], [15, 10, 'ADC']] },
];

// Pistas del lado del cobre (puentes de estaño o alambre desnudo). Cada una es una lista de agujeros
// en línea recta (horizontal o vertical) por los que pasa.
export const TRACES = [
  // GND: riel inferior y bajadas
  { net: 'GND', pts: [[0, 12], [17, 12]] },
  { net: 'GND', pts: [[0, 6], [0, 12]] },
  { net: 'GND', pts: [[17, 6], [17, 12]] },
  { net: 'GND', pts: [[10, 7], [10, 9]] },
  { net: 'GND', pts: [[10, 9], [10, 12]] },
  { net: 'GND', pts: [[13, 8], [13, 12]] },
  { net: 'GND', pts: [[2, 2], [2, 3]] },
  { net: 'GND', pts: [[1, 3], [2, 3]] },
  { net: 'GND', pts: [[2, 3], [3, 3]] },
  { net: 'GND', pts: [[3, 3], [3, 4]] },
  { net: 'GND', pts: [[11, 5], [11, 6]] },
  { net: 'GND', pts: [[11, 6], [12, 6]] },
  { net: 'GND', pts: [[12, 6], [12, 9]] },
  { net: 'GND', pts: [[12, 9], [13, 9]] },
  { net: 'GND', pts: [[5, 3], [5, 4]] },
  { net: 'GND', pts: [[5, 4], [6, 4]] },
  { net: 'GND', pts: [[3, 4], [5, 4]] },
  { net: 'GND', pts: [[2, 3], [2, 12]] },
  // VA: riel superior
  { net: 'VA', pts: [[0, 0], [16, 0]] },
  { net: 'VA', pts: [[0, 0], [0, 4]] },
  { net: 'VA', pts: [[1, 0], [1, 1]] },
  { net: 'VA', pts: [[2, 0], [2, 1]] },
  // 5 V hasta el pin 8
  { net: 'V5', pts: [[17, 3], [17, 2]] },
  { net: 'V5', pts: [[17, 2], [5, 2]] },
  { net: 'V5', pts: [[7, 2], [7, 4]] },
  // 3,3 V
  { net: 'V33', pts: [[17, 4], [16, 4]] },
  // VREF: pines 6-7 unidos y bajada por debajo del zócalo hasta el pin 3
  { net: 'VREF', pts: [[8, 4], [9, 4]] },
  { net: 'VREF', pts: [[9, 4], [9, 7]] },
  // VDIV: divisor al pin 5
  { net: 'VDIV', pts: [[10, 4], [13, 4]] },
  // entrada
  { net: 'AO', pts: [[0, 5], [1, 5]] },
  { net: 'N1', pts: [[3, 5], [3, 8]] },
  { net: 'IN', pts: [[8, 7], [8, 11]] },
  { net: 'IN', pts: [[7, 8], [8, 8]] },
  // salida
  { net: 'OUT', pts: [[7, 7], [6, 7]] },
  { net: 'OUT', pts: [[6, 7], [6, 11]] },
  { net: 'OUT', pts: [[4, 10], [4, 11]] },
  { net: 'OUT', pts: [[4, 11], [6, 11]] },
  // ADC
  { net: 'ADC', pts: [[15, 10], [16, 10]] },
  { net: 'ADC', pts: [[16, 10], [16, 5]] },
  { net: 'ADC', pts: [[16, 5], [17, 5]] },
];

// Puentes con cable aislado por el lado de los componentes (pueden pasar por encima de pistas).
export const JUMPERS = [{ net: 'OUT', a: [6, 9], b: [11, 9], via: [[11, 9], [11, 10]] }];

/** Agujeros por los que pasa una pista recta. */
export function holesOf(a, b) {
  const out = [];
  if (a[0] !== b[0] && a[1] !== b[1]) throw new Error(`Pista no recta ${a}→${b}`);
  const dx = Math.sign(b[0] - a[0]);
  const dy = Math.sign(b[1] - a[1]);
  let [x, y] = a;
  out.push([x, y]);
  while (x !== b[0] || y !== b[1]) {
    x += dx;
    y += dy;
    out.push([x, y]);
  }
  return out;
}

/** Revisa que cada agujero tenga una sola red y que cada red quede conectada. */
export function validate() {
  const errors = [];
  const hole = new Map();
  const key = (x, y) => `${x},${y}`;
  const claim = (x, y, net, who) => {
    if (x < 0 || y < 0 || x >= BOARD.cols || y >= BOARD.rows) errors.push(`${who}: (${x},${y}) fuera de la baquela`);
    const k = key(x, y);
    const prev = hole.get(k);
    if (prev && prev.net !== net) errors.push(`Agujero (${x},${y}): ${prev.who} es ${prev.net} pero ${who} es ${net}`);
    if (!prev) hole.set(k, { net, who });
  };
  const leads = new Map();
  for (const p of PARTS) {
    for (const [x, y, net] of p.pads) {
      const k = key(x, y);
      if (leads.has(k)) errors.push(`Agujero (${x},${y}) tiene dos patas: ${leads.get(k)} y ${p.id}`);
      leads.set(k, p.id);
      claim(x, y, net, p.id);
    }
  }
  for (const t of TRACES) for (let i = 1; i < t.pts.length; i++) for (const [x, y] of holesOf(t.pts[i - 1], t.pts[i])) claim(x, y, t.net, `pista ${t.net}`);
  for (const j of JUMPERS) {
    claim(...j.a, j.net, `puente ${j.net}`);
    claim(...j.b, j.net, `puente ${j.net}`);
    for (let i = 1; i < (j.via || []).length; i++) for (const [x, y] of holesOf(j.via[i - 1], j.via[i])) claim(x, y, j.net, `pista ${j.net}`);
  }
  // conectividad: unión de agujeros adyacentes por pista o puente
  const parent = new Map();
  const find = (k) => {
    while (parent.get(k) !== k) k = parent.get(k);
    return k;
  };
  const union = (a, b) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  };
  for (const t of TRACES) for (let i = 1; i < t.pts.length; i++) {
    const hs = holesOf(t.pts[i - 1], t.pts[i]);
    for (let k = 1; k < hs.length; k++) union(key(...hs[k - 1]), key(...hs[k]));
  }
  for (const j of JUMPERS) {
    union(key(...j.a), key(...j.b));
    for (let i = 1; i < (j.via || []).length; i++) {
      const hs = holesOf(j.via[i - 1], j.via[i]);
      for (let k = 1; k < hs.length; k++) union(key(...hs[k - 1]), key(...hs[k]));
    }
  }
  const byNet = {};
  for (const p of PARTS) for (const [x, y, net] of p.pads) (byNet[net] = byNet[net] || []).push(key(x, y));
  for (const [net, ks] of Object.entries(byNet)) {
    for (const k of ks) if (!parent.has(k)) parent.set(k, k);
    const roots = new Set(ks.map(find));
    if (roots.size > 1) errors.push(`La red ${net} quedó partida en ${roots.size} pedazos`);
  }
  return errors;
}
