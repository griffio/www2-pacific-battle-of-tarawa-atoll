// Navigation grid (4 m cells) and A* pathfinding for infantry, tanks, amphibians and boats.
import { F } from '../world/terrain.js';
import { clamp } from '../util.js';

export const MC = { INF: 0, TRACK: 1, AMPH: 2, BOAT: 3 };

export class Nav {
  constructor(T, k = 2) {
    this.T = T; this.k = k; this.cell = T.cell * k;
    this.nx = Math.ceil(T.nx / k); this.ny = Math.ceil(T.ny / k);
    const n = this.nx * this.ny;
    this.dMax = new Float32Array(n); this.dMin = new Float32Array(n);
    this.veg = new Float32Array(n); this.fl = new Uint8Array(n); this.blk = new Uint8Array(n);
    this.g = new Float32Array(n); this.f = new Float32Array(n); this.par = new Int32Array(n);
    this.stamp = new Uint32Array(n); this.closed = new Uint32Array(n); this.gen = 1;
    this.heap = new Int32Array(n); this.hn = 0;
    this.build();
  }
  build(r = null) {
    const T = this.T, k = this.k;
    const X0 = r ? Math.floor(r.x0 / k) : 0, Y0 = r ? Math.floor(r.y0 / k) : 0;
    const X1 = r ? Math.min(this.nx - 1, Math.ceil(r.x1 / k)) : this.nx - 1, Y1 = r ? Math.min(this.ny - 1, Math.ceil(r.y1 / k)) : this.ny - 1;
    for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
      let dmax = -99, dmin = 99, v = 0, fl = 0, blk = 0, cnt = 0;
      for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) {
        const cx = Math.min(x * k + i, T.nx - 1), cy = Math.min(y * k + j, T.ny - 1);
        const t = cy * T.nx + cx;
        const pier = T.flags[t] & F.PIER;
        const d = pier ? -1 : T.water - T.ground[t];
        dmax = Math.max(dmax, d); dmin = Math.min(dmin, pier ? -1 : d);
        v += T.veg[t]; fl |= T.flags[t];
        if (T.flags[t] & (F.BUILDING | F.STRUCT)) blk++;
        cnt++;
      }
      const n = y * this.nx + x;
      this.dMax[n] = dmax; this.dMin[n] = dmin; this.veg[n] = v / cnt; this.fl[n] = fl; this.blk[n] = blk;
    }
    this.T.navRect = null;
  }
  idx(x, y) { return clamp((y / this.cell) | 0, 0, this.ny - 1) * this.nx + clamp((x / this.cell) | 0, 0, this.nx - 1); }

  // movement cost of a nav cell for class, 0 = impassable
  cost(cls, n, o) {
    const fl = this.fl[n], d = this.dMax[n];
    switch (cls) {
      case MC.INF: {
        if (this.blk[n] >= 2) return 0;
        const pier = fl & F.PIER;
        const dd = pier ? 0 : d;
        if (dd > 1.5) return 0;
        let c = 1 + this.veg[n] * 0.7;
        if (dd > 0.1) c += 0.6 + dd * 2.4;
        if (fl & F.WIRE) c += 5;
        if (fl & F.SEAWALL) c += 2.5;
        if (pier) c += 0.3;
        return c;
      }
      case MC.TRACK: {
        if (this.blk[n] || fl & (F.SEAWALL | F.TRAP | F.PIER | F.WRECK)) return 0;
        if (d > (o.wade || 1.2)) return 0;
        return 1 + this.veg[n] * 0.5 + (d > 0 ? 0.5 + d * 1.5 : 0);
      }
      case MC.AMPH: {
        if (this.blk[n] || fl & (F.SEAWALL | F.TRAP | F.PIER | F.WRECK)) return 0;
        return d > 0.3 ? 1 : 1.4 + this.veg[n] * 0.5;
      }
      case MC.BOAT: {
        if (this.blk[n] || fl & (F.TRAP | F.PIER | F.WRECK)) return 0;
        if (this.dMin[n] < (o.draft || 1)) return 0;
        return 1;
      }
    }
    return 1;
  }
  passable(cls, x, y, o = {}) { return this.cost(cls, this.idx(x, y), o) > 0; }

  nearestPassable(cls, x, y, o = {}, maxR = 30) {
    const cx = clamp((x / this.cell) | 0, 0, this.nx - 1), cy = clamp((y / this.cell) | 0, 0, this.ny - 1);
    if (this.cost(cls, cy * this.nx + cx, o) > 0) return [x, y];
    for (let r = 1; r <= maxR; r++) {
      let best = null, bd = Infinity;
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
        if (Math.abs(i) !== r && Math.abs(j) !== r) continue;
        const X = cx + i, Y = cy + j;
        if (X < 0 || Y < 0 || X >= this.nx || Y >= this.ny) continue;
        if (this.cost(cls, Y * this.nx + X, o) > 0) {
          const d = i * i + j * j;
          if (d < bd) { bd = d; best = [(X + 0.5) * this.cell, (Y + 0.5) * this.cell]; }
        }
      }
      if (best) return best;
    }
    return null;
  }

  // heap helpers
  push(n) {
    const h = this.heap, f = this.f;
    let i = this.hn++;
    h[i] = n;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (f[h[p]] <= f[n]) break;
      h[i] = h[p]; i = p;
    }
    h[i] = n;
  }
  pop() {
    const h = this.heap, f = this.f;
    const top = h[0];
    const last = h[--this.hn];
    let i = 0;
    const N = this.hn;
    while (true) {
      let l = i * 2 + 1;
      if (l >= N) break;
      const r = l + 1;
      if (r < N && f[h[r]] < f[h[l]]) l = r;
      if (f[h[l]] >= f[last]) break;
      h[i] = h[l]; i = l;
    }
    h[i] = last;
    return top;
  }

  // A*. Returns array of [x,y] waypoints (world) or null. o: {danger, dangerW, draft, wade, maxNodes}
  find(cls, sx, sy, tx, ty, o = {}) {
    if (this.T.navRect) this.build(this.T.navRect);
    const nx = this.nx, ny = this.ny, cell = this.cell;
    let s = this.idx(sx, sy);
    const goalP = this.nearestPassable(cls, tx, ty, o, 12);
    if (!goalP) return null;
    const t = this.idx(goalP[0], goalP[1]);
    if (this.cost(cls, s, o) === 0) {
      const p = this.nearestPassable(cls, sx, sy, o, 6);
      if (p) s = this.idx(p[0], p[1]);
    }
    const gen = ++this.gen;
    const g = this.g, f = this.f, par = this.par, stamp = this.stamp, closed = this.closed;
    const tX = t % nx, tY = (t / nx) | 0;
    const H = (n) => { const dx = Math.abs(n % nx - tX), dy = Math.abs(((n / nx) | 0) - tY); return (dx + dy + (1.4142 - 2) * Math.min(dx, dy)); };
    this.hn = 0;
    g[s] = 0; f[s] = H(s); par[s] = -1; stamp[s] = gen; this.push(s);
    const danger = o.danger, dw = o.dangerW || 0;
    let best = s, bestH = H(s), expanded = 0;
    const maxNodes = o.maxNodes || 60000;
    const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1], DC = [1, 1, 1, 1, 1.4142, 1.4142, 1.4142, 1.4142];
    let found = false;
    while (this.hn > 0) {
      const n = this.pop();
      if (closed[n] === gen) continue;
      closed[n] = gen;
      if (n === t) { found = true; break; }
      const hcur = f[n] - g[n];
      if (hcur < bestH) { bestH = hcur; best = n; }
      if (++expanded > maxNodes) break;
      const x = n % nx, y = (n / nx) | 0;
      for (let k = 0; k < 8; k++) {
        const X = x + DX[k], Y = y + DY[k];
        if (X < 0 || Y < 0 || X >= nx || Y >= ny) continue;
        const m = Y * nx + X;
        if (closed[m] === gen) continue;
        let c = this.cost(cls, m, o);
        if (c === 0) continue;
        if (k >= 4) { // no corner cutting
          if (this.cost(cls, y * nx + X, o) === 0 || this.cost(cls, Y * nx + x, o) === 0) continue;
        }
        if (danger && dw) c += danger[m] * dw;
        const ng = g[n] + c * DC[k];
        if (stamp[m] !== gen || ng < g[m]) {
          stamp[m] = gen; g[m] = ng; f[m] = ng + H(m); par[m] = n;
          this.push(m);
        }
      }
    }
    const end = found ? t : best;
    const cells = [];
    for (let n = end; n !== -1; n = par[n]) { cells.push(n); if (cells.length > 20000) break; }
    cells.reverse();
    if (cells.length === 0) return null;
    const pts = this.smooth(cls, cells, o);
    if (found) pts[pts.length - 1] = [goalP[0], goalP[1]];
    pts.partial = !found;
    return pts;
  }

  lineCost(cls, a, b, o) {
    const nx = this.nx;
    let x0 = a % nx, y0 = (a / nx) | 0;
    const x1 = b % nx, y1 = (b / nx) | 0;
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, sum = 0;
    const danger = o.danger, dw = o.dangerW || 0;
    while (true) {
      const n = y0 * nx + x0;
      const c = this.cost(cls, n, o);
      if (c === 0) return Infinity;
      sum += c + (danger && dw ? danger[n] * dw : 0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
    return sum * Math.hypot(x1 - (a % nx), y1 - ((a / nx) | 0)) / Math.max(1, Math.max(dx, dy));
  }
  smooth(cls, cells, o) {
    const nx = this.nx, cell = this.cell;
    const cum = [0];
    for (let i = 1; i < cells.length; i++) {
      const a = cells[i - 1], b = cells[i];
      const d = (a % nx !== b % nx && ((a / nx) | 0) !== ((b / nx) | 0)) ? 1.4142 : 1;
      let c = this.cost(cls, b, o); if (o.danger && o.dangerW) c += o.danger[b] * o.dangerW;
      cum.push(cum[i - 1] + c * d);
    }
    const out = [];
    let i = 0;
    const toW = (n) => [((n % nx) + 0.5) * cell, (((n / nx) | 0) + 0.5) * cell];
    out.push(toW(cells[0]));
    while (i < cells.length - 1) {
      let j = Math.min(cells.length - 1, i + 50);
      for (; j > i + 1; j--) {
        const lc = this.lineCost(cls, cells[i], cells[j], o);
        if (lc <= (cum[j] - cum[i]) * 1.04 + 0.5) break;
      }
      out.push(toW(cells[j]));
      i = j;
    }
    return out;
  }
}
