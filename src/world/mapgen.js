// Map generation helpers: polygon rasterisation, distance transforms, coast queries, scatter.
import { clamp } from '../util.js';

// Fill mask (Uint8Array nx*ny) with polygon (world coords) using scanlines.
export function rasterPoly(mask, nx, ny, cell, poly, value = 1) {
  const n = poly.length;
  const xs = [];
  for (let cy = 0; cy < ny; cy++) {
    const y = (cy + 0.5) * cell;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = poly[i][1], yj = poly[j][1];
      if ((yi > y) !== (yj > y)) xs.push(poly[i][0] + (y - yi) / (yj - yi) * (poly[j][0] - poly[i][0]));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = clamp(Math.ceil(xs[k] / cell - 0.5), 0, nx), b = clamp(Math.floor(xs[k + 1] / cell - 0.5), -1, nx - 1);
      for (let cx = a; cx <= b; cx++) mask[cy * nx + cx] = value;
    }
  }
}

// Felzenszwalb–Huttenlocher exact Euclidean distance transform.
// feature(i) true → distance 0. Returns Float32Array distances in cells.
export function edt(nx, ny, isFeature) {
  const INF = 1e20;
  const f = new Float64Array(Math.max(nx, ny));
  const d = new Float64Array(Math.max(nx, ny));
  const v = new Int32Array(Math.max(nx, ny));
  const z = new Float64Array(Math.max(nx, ny) + 1);
  const g = new Float64Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) g[i] = isFeature(i) ? 0 : INF;
  const pass = (n) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
  };
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) f[y] = g[y * nx + x];
    pass(ny);
    for (let y = 0; y < ny; y++) g[y * nx + x] = d[y];
  }
  const out = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) f[x] = g[y * nx + x];
    pass(nx);
    for (let x = 0; x < nx; x++) out[y * nx + x] = Math.sqrt(d[x]);
  }
  return out;
}

// Signed distance (metres) to polygon set: negative inside land.
export function signedField(nx, ny, cell, polys) {
  const mask = new Uint8Array(nx * ny);
  for (const p of polys) rasterPoly(mask, nx, ny, cell, p, 1);
  const dOut = edt(nx, ny, (i) => mask[i] === 1);
  const dIn = edt(nx, ny, (i) => mask[i] === 0);
  const s = new Float32Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) s[i] = (mask[i] ? -dIn[i] + 0.5 : dOut[i] - 0.5) * cell;
  return { s, mask };
}

// Vertical-line intersections with polygon → [minY, maxY]
export function polyYRange(poly, x) {
  let lo = Infinity, hi = -Infinity;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0], xj = poly[j][0];
    if ((xi > x) !== (xj > x)) {
      const y = poly[i][1] + (x - xi) / (xj - xi) * (poly[j][1] - poly[i][1]);
      lo = Math.min(lo, y); hi = Math.max(hi, y);
    }
  }
  return [lo, hi];
}
export function polyXRange(poly, y) {
  let lo = Infinity, hi = -Infinity;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = poly[i][1], yj = poly[j][1];
    if ((yi > y) !== (yj > y)) {
      const x = poly[i][0] + (y - yi) / (yj - yi) * (poly[j][0] - poly[i][0]);
      lo = Math.min(lo, x); hi = Math.max(hi, x);
    }
  }
  return [lo, hi];
}

// Poisson-ish scatter with min spacing via grid
export function scatter(rng, x0, y0, x1, y1, count, minDist, accept) {
  const out = [];
  const gc = minDist / Math.SQRT2;
  const gw = Math.ceil((x1 - x0) / gc) + 1, gh = Math.ceil((y1 - y0) / gc) + 1;
  const grid = new Int32Array(gw * gh).fill(-1);
  for (let t = 0; t < count; t++) {
    const x = x0 + rng() * (x1 - x0), y = y0 + rng() * (y1 - y0);
    if (!accept(x, y)) continue;
    const gx = ((x - x0) / gc) | 0, gy = ((y - y0) / gc) | 0;
    let ok = true;
    for (let yy = Math.max(0, gy - 2); yy <= Math.min(gh - 1, gy + 2) && ok; yy++)
      for (let xx = Math.max(0, gx - 2); xx <= Math.min(gw - 1, gx + 2); xx++) {
        const k = grid[yy * gw + xx];
        if (k >= 0 && Math.hypot(out[k][0] - x, out[k][1] - y) < minDist) { ok = false; break; }
      }
    if (!ok) continue;
    grid[gy * gw + gx] = out.length;
    out.push([x, y]);
  }
  return out;
}

// Offset a polyline along its left/right normal
export function offsetPolyline(pts, off) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    out.push([pts[i][0] - dy / l * off, pts[i][1] + dx / l * off]);
  }
  return out;
}
export function resamplePolyline(pts, spacing) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let d = spacing - carry;
    while (d <= L) { const t = d / L; out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); d += spacing; }
    carry = L - (d - spacing);
  }
  return out;
}
