// Shared math / helpers
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
export const dist2 = (ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; };
export const TAU = Math.PI * 2;
export function normAngle(a) { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; }
export function angleTo(ax, ay, bx, by) { return Math.atan2(by - ay, bx - ax); }
export function turnToward(cur, target, maxStep) {
  const d = normAngle(target - cur);
  if (Math.abs(d) <= maxStep) return target;
  return cur + Math.sign(d) * maxStep;
}

// Deterministic RNG (mulberry32)
export function makeRng(seed) {
  let s = seed >>> 0;
  const r = () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (a, b) => a + (b - a) * r();
  r.int = (a, b) => Math.floor(a + (b - a + 1) * r());
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  r.chance = (p) => r() < p;
  r.gauss = () => { let u = 0; for (let i = 0; i < 4; i++) u += r(); return (u - 2) / 0.577; };
  return r;
}
export const rng = makeRng(1943);
export const rnd = () => rng();

// value noise for terrain generation (CPU)
function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function vnoise(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed), c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}
export function fbm(x, y, oct = 4, seed = 0) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f, seed + i * 17); n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}

// polygon helpers
export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi + 1e-9) + xi)) inside = !inside;
  }
  return inside;
}
export function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy || 1e-9;
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
export function distToPoly(x, y, poly, closed = true) {
  let d = Infinity;
  const n = poly.length;
  for (let i = 0; i < n - (closed ? 0 : 1); i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    d = Math.min(d, distToSeg(x, y, a[0], a[1], b[0], b[1]));
  }
  return d;
}
// Catmull-Rom resample of a closed/open polyline for smoother coastlines
export function smoothPoly(pts, steps = 6, closed = true) {
  const out = [];
  const n = pts.length;
  const get = (i) => closed ? pts[(i + n) % n] : pts[clamp(i, 0, n - 1)];
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let s = 0; s < steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}

// float32 -> float16 bits
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
export function f16(v) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >> (1 - exp);
    return sign | (mant >> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | (mant >> 13);
}

// Simple uniform grid spatial hash for entities
export class SpatialHash {
  constructor(cell, w, h) {
    this.cell = cell; this.nx = Math.ceil(w / cell) + 1; this.ny = Math.ceil(h / cell) + 1;
    this.buckets = new Array(this.nx * this.ny);
    for (let i = 0; i < this.buckets.length; i++) this.buckets[i] = [];
    this.used = [];
  }
  clear() { for (const b of this.used) b.length = 0; this.used.length = 0; }
  insert(o, x, y) {
    const cx = clamp(Math.floor(x / this.cell), 0, this.nx - 1), cy = clamp(Math.floor(y / this.cell), 0, this.ny - 1);
    const b = this.buckets[cy * this.nx + cx];
    if (b.length === 0) this.used.push(b);
    b.push(o);
  }
  query(x, y, r, cb) {
    const c = this.cell;
    const x0 = clamp(Math.floor((x - r) / c), 0, this.nx - 1), x1 = clamp(Math.floor((x + r) / c), 0, this.nx - 1);
    const y0 = clamp(Math.floor((y - r) / c), 0, this.ny - 1), y1 = clamp(Math.floor((y + r) / c), 0, this.ny - 1);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const b = this.buckets[cy * this.nx + cx];
      for (let i = 0; i < b.length; i++) cb(b[i]);
    }
  }
}

export function fmtClock(startMin, gameSec) {
  const m = Math.floor(startMin + gameSec / 60);
  const hh = Math.floor(m / 60) % 24, mm = m % 60;
  return String(hh).padStart(2, '0') + String(mm).padStart(2, '0');
}
