// Terrain grid: ground height, obstacle heights, vegetation, flags, line of sight & cover.
import { clamp } from '../util.js';

export const F = {
  BUILDING: 1,   // solid building / structure footprint (blocks movement)
  WIRE: 2,       // barbed wire (slows infantry)
  SEAWALL: 4,    // coconut-log seawall (climbable for infantry, blocks vehicles)
  TRAP: 8,       // tank trap / obstacles (blocks vehicles)
  PIER: 16,      // pier deck: walkable over water
  TRENCH: 32,    // trench (cover)
  STRUCT: 64,    // fortification footprint (blocks movement)
  WRECK: 128,    // wrecked vehicle (blocks vehicles, cover for infantry)
};

export class Terrain {
  constructor(w, h, cell = 2) {
    this.w = w; this.h = h; this.cell = cell;
    this.nx = Math.ceil(w / cell); this.ny = Math.ceil(h / cell);
    const n = this.nx * this.ny;
    this.ground = new Float32Array(n);
    this.obj = new Float32Array(n);
    this.veg = new Float32Array(n);
    this.surf = new Float32Array(n); // 0..1 airfield / road / village surface
    this.flags = new Uint8Array(n);
    this.water = 0;       // tide level (m)
    this.pierDeck = 1.3;  // deck height above datum
    this.dirty = null;    // {x0,y0,x1,y1} in cells for GPU re-upload
    this.navDirty = false;
    this.navRect = null;   // {x0,y0,x1,y1} terrain cells changed since the nav grid was built
    this.L = { frac: 1, conceal: 0, blockD: -1 };
  }
  idx(x, y) {
    const cx = clamp((x / this.cell) | 0, 0, this.nx - 1), cy = clamp((y / this.cell) | 0, 0, this.ny - 1);
    return cy * this.nx + cx;
  }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  groundAt(x, y) {
    const c = this.cell;
    const fx = clamp(x / c - 0.5, 0, this.nx - 1.001), fy = clamp(y / c - 0.5, 0, this.ny - 1.001);
    const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy;
    const g = this.ground, i = iy * this.nx + ix;
    const a = g[i], b = g[i + 1], d = g[i + this.nx], e = g[i + this.nx + 1];
    return (a + (b - a) * tx) * (1 - ty) + (d + (e - d) * tx) * ty;
  }
  objAt(x, y) { return this.obj[this.idx(x, y)]; }
  vegAt(x, y) { return this.veg[this.idx(x, y)]; }
  flagsAt(x, y) { return this.flags[this.idx(x, y)]; }
  topAt(x, y) { const i = this.idx(x, y); return this.ground[i] + this.obj[i]; }
  depthAt(x, y) {
    const i = this.idx(x, y);
    if (this.flags[i] & F.PIER) return -1;
    return this.water - this.groundAt(x, y);
  }
  // height of a standing surface (feet)
  baseAt(x, y) {
    const i = this.idx(x, y);
    if (this.flags[i] & F.PIER) return this.pierDeck;
    return this.groundAt(x, y);
  }
  isWater(x, y) { return this.depthAt(x, y) > 0.05; }

  // Line of sight from eye (ax,ay,aEye) to a target body spanning heights [bBase,bTop].
  // Returns this.L = {frac: visible fraction 0..1, conceal: vegetation concealment, blockD}
  los(ax, ay, aEye, bx, by, bBase, bTop, ignoreA = 1.2, ignoreB = 1.2) {
    const L = this.L;
    const dx = bx - ax, dy = by - ay;
    const D = Math.hypot(dx, dy);
    L.frac = 1; L.conceal = 0; L.blockD = -1;
    bBase = Math.max(bBase, this.water);
    if (bTop <= bBase) { L.frac = 0; return L; }
    if (D < 0.5) return L;
    const step = this.cell * 0.85;
    const steps = Math.ceil(D / step);
    const inv = 1 / steps;
    let zmin = bBase;
    const g = this.ground, o = this.obj, v = this.veg, nx = this.nx, ny = this.ny, ic = 1 / this.cell, water = this.water;
    let conceal = 0;
    const stepLen = D * inv;
    // only sample between the two ignore radii
    const i0 = Math.max(1, Math.ceil(ignoreA / stepLen)), i1 = Math.min(steps - 1, Math.floor((D - ignoreB) / stepLen));
    const sx = dx * inv, sy = dy * inv;
    let x = ax + sx * i0, y = ay + sy * i0;
    const maxX = nx - 1, maxY = ny - 1;
    for (let i = i0; i <= i1; i++, x += sx, y += sy) {
      let cx = (x * ic) | 0, cy = (y * ic) | 0;
      if (cx < 0) cx = 0; else if (cx > maxX) cx = maxX;
      if (cy < 0) cy = 0; else if (cy > maxY) cy = maxY;
      const k = cy * nx + cx;
      const gr = g[k];
      let occ = gr + o[k];
      if (occ < water) occ = water;
      if (occ > zmin || occ > aEye) {
        const needed = aEye + (occ - aEye) * steps / i;
        if (needed > zmin) {
          zmin = needed;
          if (zmin >= bTop) { L.frac = 0; L.blockD = i * stepLen; L.conceal = conceal; return L; }
        }
      }
      const vg = v[k];
      if (vg > 0) {
        const rayH = aEye + (zmin - aEye) * i * inv;
        conceal += vg * stepLen * (rayH - gr < 3.2 ? 0.055 : 0.02);
      }
    }
    L.frac = clamp((bTop - zmin) / (bTop - bBase), 0, 1);
    L.conceal = conceal;
    return L;
  }

  // Protection height (m) at (x,y) against fire from direction of (tx,ty).
  coverToward(x, y, tx, ty) {
    const base = this.groundAt(x, y);
    const a = Math.atan2(ty - y, tx - x);
    const ca = Math.cos(a), sa = Math.sin(a);
    let best = 0;
    for (let d = 1; d <= 4.5; d += 1.1) {
      const t = this.topAt(x + ca * d, y + sa * d) - base;
      if (t > best) best = t;
    }
    // depression (crater / trench / foxhole)
    let ring = 0;
    for (let k = 0; k < 6; k++) {
      const an = k * Math.PI / 3;
      ring += this.groundAt(x + Math.cos(an) * 3.5, y + Math.sin(an) * 3.5);
    }
    const hole = ring / 6 - base;
    return Math.max(best, 0) + Math.max(hole, 0) * 0.9 + (this.flags[this.idx(x, y)] & F.TRENCH ? 0.7 : 0);
  }
  // generic cover irrespective of direction
  coverAny(x, y) {
    const base = this.groundAt(x, y);
    let s = 0;
    for (let k = 0; k < 8; k++) {
      const an = k * Math.PI / 4;
      const t = this.topAt(x + Math.cos(an) * 1.8, y + Math.sin(an) * 1.8) - base;
      s += clamp(t, 0, 1.5);
    }
    let ring = 0;
    for (let k = 0; k < 6; k++) {
      const an = k * Math.PI / 3;
      ring += this.groundAt(x + Math.cos(an) * 3.5, y + Math.sin(an) * 3.5);
    }
    return s / 8 + Math.max(ring / 6 - base, 0) + (this.flags[this.idx(x, y)] & F.TRENCH ? 0.7 : 0);
  }

  markDirty(cx0, cy0, cx1, cy1) {
    cx0 = clamp(cx0, 0, this.nx - 1); cx1 = clamp(cx1, 0, this.nx - 1);
    cy0 = clamp(cy0, 0, this.ny - 1); cy1 = clamp(cy1, 0, this.ny - 1);
    const n = this.navRect;
    if (!n) this.navRect = { x0: cx0, y0: cy0, x1: cx1, y1: cy1 };
    else { n.x0 = Math.min(n.x0, cx0); n.y0 = Math.min(n.y0, cy0); n.x1 = Math.max(n.x1, cx1); n.y1 = Math.max(n.y1, cy1); }
    if (!this.dirty) this.dirty = { x0: cx0, y0: cy0, x1: cx1, y1: cy1 };
    else {
      const d = this.dirty;
      d.x0 = Math.min(d.x0, cx0); d.y0 = Math.min(d.y0, cy0);
      d.x1 = Math.max(d.x1, cx1); d.y1 = Math.max(d.y1, cy1);
    }
  }

  // Shell crater: depression with a raised rim; strips vegetation.
  addCrater(x, y, r, depth) {
    const c = this.cell;
    const R = r * 1.45;
    const cx0 = Math.floor((x - R) / c), cx1 = Math.ceil((x + R) / c);
    const cy0 = Math.floor((y - R) / c), cy1 = Math.ceil((y + R) / c);
    if (this.groundAt(x, y) < this.water - 0.4) return false;
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      if (cx < 0 || cy < 0 || cx >= this.nx || cy >= this.ny) continue;
      const k = cy * this.nx + cx;
      if (this.flags[k] & (F.BUILDING | F.STRUCT | F.PIER)) continue;
      const px = (cx + 0.5) * c, py = (cy + 0.5) * c;
      const d = Math.hypot(px - x, py - y) / r;
      if (d < 1) this.ground[k] -= depth * (1 - d * d);
      else if (d < 1.45) this.ground[k] += depth * 0.25 * Math.sin((d - 1) / 0.45 * Math.PI);
      if (d < 1.2) { this.veg[k] *= 0.3; if (!(this.flags[k] & (F.SEAWALL | F.WRECK))) this.obj[k] *= 0.5; this.flags[k] &= ~F.WIRE; }
    }
    this.markDirty(cx0, cy0, cx1, cy1);
    return true;
  }

  // Stamp a rectangular obstacle (rotated) into the grid
  stampRect(x, y, w, h, rot, fn) {
    const c = this.cell;
    const r = Math.hypot(w, h) / 2 + c;
    const ca = Math.cos(-rot), sa = Math.sin(-rot);
    const cx0 = Math.floor((x - r) / c), cx1 = Math.ceil((x + r) / c);
    const cy0 = Math.floor((y - r) / c), cy1 = Math.ceil((y + r) / c);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      if (cx < 0 || cy < 0 || cx >= this.nx || cy >= this.ny) continue;
      const px = (cx + 0.5) * c - x, py = (cy + 0.5) * c - y;
      const lx = px * ca - py * sa, ly = px * sa + py * ca;
      if (Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2) fn(cy * this.nx + cx, lx / (w / 2), ly / (h / 2));
    }
    this.markDirty(cx0, cy0, cx1, cy1);
  }
  stampCircle(x, y, r, fn) {
    const c = this.cell;
    const cx0 = Math.floor((x - r) / c), cx1 = Math.ceil((x + r) / c);
    const cy0 = Math.floor((y - r) / c), cy1 = Math.ceil((y + r) / c);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      if (cx < 0 || cy < 0 || cx >= this.nx || cy >= this.ny) continue;
      const px = (cx + 0.5) * c - x, py = (cy + 0.5) * c - y;
      const d = Math.hypot(px, py);
      if (d <= r) fn(cy * this.nx + cx, d / r);
    }
    this.markDirty(cx0, cy0, cx1, cy1);
  }
  stampLine(ax, ay, bx, by, width, fn) {
    const L = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(L / (this.cell * 0.5)));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      this.stampCircle(ax + (bx - ax) * t, ay + (by - ay) * t, width / 2, fn);
    }
  }
}
