// Persistencia local (localStorage): perfiles y ajustes. Nada se envía a ningún servidor.
const KEY_PROFILES = 'silbido-id:v1:profiles';
const KEY_SETTINGS = 'silbido-id:v1:settings';
const KEY_THEME = 'silbido-id:theme';

export const DEFAULT_FILTER = { type: 'iir', fl: 1000, fh: 4000, order: 4, taps: 101, win: 'hamming' };

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function isValidProfile(p) {
  return (
    p &&
    p.version === 1 &&
    typeof p.name === 'string' &&
    Array.isArray(p.refs) &&
    p.refs.length > 0 &&
    p.refs.every((r) => Array.isArray(r.contour) && r.contour.length > 0) &&
    p.summary &&
    p.tolerances &&
    p.filter &&
    Number.isFinite(p.filter.fl) &&
    Number.isFinite(p.filter.fh)
  );
}

export function loadProfiles() {
  const list = read(KEY_PROFILES, []);
  return Array.isArray(list) ? list.filter(isValidProfile) : [];
}

export function saveProfiles(list) {
  return write(KEY_PROFILES, list);
}

export function loadFilter() {
  const s = read(KEY_SETTINGS, {});
  const f = { ...DEFAULT_FILTER, ...(s.filter || {}) };
  if (!(f.fl > 0 && f.fh > f.fl && f.fh < 8000)) return { ...DEFAULT_FILTER };
  return f;
}

export function saveFilter(filter) {
  const s = read(KEY_SETTINGS, {});
  write(KEY_SETTINGS, { ...s, filter });
}

export function loadTheme() {
  try {
    return localStorage.getItem(KEY_THEME) || 'auto';
  } catch {
    return 'auto';
  }
}

export function saveTheme(t) {
  try {
    if (t === 'auto') localStorage.removeItem(KEY_THEME);
    else localStorage.setItem(KEY_THEME, t);
  } catch {
    /* sin almacenamiento */
  }
}
