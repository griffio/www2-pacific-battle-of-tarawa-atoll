// Visual effects: particles (muzzle flashes, tracers, explosions, splashes, smoke, fire), short-lived lights.
import { K, DK } from '../kinds.js';

const MAXP = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches ? 3000 : 6000;

export class FX {
  constructor(renderer) {
    this.r = renderer;
    this.p = [];          // particles
    this.emit = [];       // burning emitters
    this.planes = [];
    this.flashLights = [];
    this.time = 0;
  }
  add(o) { if (this.p.length < MAXP) this.p.push(o); }
  // kind, x, y, vx, vy, life, size, grow, color[r,g,b,a], add(bool), rot
  P(kind, x, y, vx, vy, life, size, grow, c, add, rot = 0, extra = 0) {
    this.add({ kind, x, y, vx, vy, life, t: 0, size, grow, c, add, rot, extra, seed: Math.random() });
  }
  light(x, y, r, i, c, life) { this.flashLights.push({ x, y, r, i, c, life, t: 0 }); }

  handle(e, g) {
    const T = g.T;
    switch (e.t) {
      case 'shot': {
        const dx = e.tx - e.x, dy = e.ty - e.y, d = Math.hypot(dx, dy) || 1;
        const rot = Math.atan2(dy, dx);
        const big = e.cls === 'mg' || e.cls === 'hmg';
        this.P(K.FLASH, e.x + dx / d * 0.6, e.y + dy / d * 0.6, 0, 0, 0.06, big ? 1.3 : 0.9, 0, [1, 0.85, 0.5, 1], true);
        if (Math.random() < 0.3) this.light(e.x, e.y, big ? 14 : 9, 0.6, [1, 0.8, 0.5], 0.06);
        if (e.tracer) {
          const sp = 750;
          const col = e.side === 'US' ? [1, 0.45, 0.2, 1] : [0.65, 1, 0.55, 1];
          this.add({ kind: K.TRACER, x: e.x, y: e.y, vx: dx / d * sp, vy: dy / d * sp, life: d / sp, t: 0, size: e.cls === 'hmg' ? 4 : 3, grow: 0, c: col, add: true, rot, extra: 0, seed: 0, tracer: true });
        }
        break;
      }
      case 'muzzle': {
        this.P(K.FLASH, e.x, e.y, 0, 0, 0.12, e.big ? 3.5 : 1.6, 4, [1, 0.8, 0.45, 1], true);
        this.light(e.x, e.y, e.big ? 40 : 15, 1.2, [1, 0.75, 0.45], 0.12);
        for (let i = 0; i < (e.big ? 5 : 2); i++) this.P(K.SMOKE, e.x, e.y, (Math.random() - 0.5) * 2 + Math.cos(e.dir) * 3, (Math.random() - 0.5) * 2 + Math.sin(e.dir) * 3, 2 + Math.random() * 2, 1.5, 1.5, [0.75, 0.74, 0.7, 0.5], false);
        break;
      }
      case 'backblast':
        for (let i = 0; i < 6; i++) this.P(K.DUST, e.x, e.y, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, 1.5, 1.2, 2, [0.8, 0.75, 0.6, 0.6], false);
        break;
      case 'impact': {
        if (e.water) { this.P(K.SPLASH, e.x, e.y, 0, 0, 0.45, 0.6, 1.5, [1, 1, 1, 0.8], false); }
        else if (e.hard) { for (let i = 0; i < (e.big ? 6 : 2); i++) this.P(K.SPARK, e.x, e.y, (Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18, 0.25, 0.25, 0, [1, 0.8, 0.4, 1], true); if (e.big) this.P(K.DUST, e.x, e.y, 0, 0, 2, 2.5, 2, [0.6, 0.58, 0.55, 0.7], false); }
        else this.P(K.DUST, e.x + (Math.random() - 0.5), e.y + (Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5), 0.6 + Math.random() * 0.4, 0.45, 1.2, [0.82, 0.77, 0.62, 0.7], false);
        break;
      }
      case 'ricochet':
        for (let i = 0; i < 3; i++) this.P(K.SPARK, e.x + (Math.random() - 0.5) * 2, e.y + (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, 0.2, 0.3, 0, [1, 0.9, 0.6, 1], true);
        break;
      case 'expl': {
        const p = e.power || 1;
        const R = 2 + p * 2.2;
        if (e.water) {
          this.P(K.SPLASH, e.x, e.y, 0, 0, 1.6 + p * 0.2, R * 0.6, R * 0.8, [1, 1, 1, 0.95], false);
          for (let i = 0; i < 6 + p * 3; i++) { const a = Math.random() * 6.28, s = 3 + Math.random() * 6 * p; this.P(K.SPLASH, e.x, e.y, Math.cos(a) * s, Math.sin(a) * s, 0.8 + Math.random() * 0.6, R * 0.2, 1, [1, 1, 1, 0.8], false); }
          this.light(e.x, e.y, R * 6, 0.8, [1, 0.8, 0.5], 0.15);
        } else {
          this.P(K.FLASH, e.x, e.y, 0, 0, 0.18, R * 1.6, R * 4, [1, 0.85, 0.5, 1], true);
          this.P(K.FIRE, e.x, e.y, 0, 0, 0.5 + p * 0.1, R * 0.7, R, [1, 1, 1, 1], true);
          this.light(e.x, e.y, R * 10, 2.2, [1, 0.7, 0.35], 0.35);
          for (let i = 0; i < 3 + p * 2; i++) {
            const a = Math.random() * 6.28, s = 1 + Math.random() * 3 * p;
            this.P(K.SMOKE, e.x + Math.cos(a) * R * 0.3, e.y + Math.sin(a) * R * 0.3, Math.cos(a) * s, Math.sin(a) * s, 4 + Math.random() * 5 + p, R * 0.5, R * 0.35, [0.32, 0.30, 0.28, 0.8], false);
          }
          for (let i = 0; i < 5 + p * 3; i++) {
            const a = Math.random() * 6.28, s = 6 + Math.random() * 14 * Math.sqrt(p);
            this.P(K.DUST, e.x, e.y, Math.cos(a) * s, Math.sin(a) * s, 0.8 + Math.random() * 0.8, R * 0.25, R * 0.5, [0.78, 0.72, 0.58, 0.8], false);
            this.P(K.SPARK, e.x, e.y, Math.cos(a) * s * 2, Math.sin(a) * s * 2, 0.3 + Math.random() * 0.3, 0.3, 0, [1, 0.7, 0.3, 1], true);
          }
        }
        break;
      }
      case 'flame': {
        const dx = e.tx - e.x, dy = e.ty - e.y, d = Math.hypot(dx, dy) || 1;
        this.add({ kind: K.FLAME, x: (e.x + e.tx) / 2, y: (e.y + e.ty) / 2, vx: 0, vy: 0, life: 0.9, t: 0, size: d / 2, size2: Math.max(1.5, d * 0.12), grow: 0, c: [1, 1, 1, 1], add: true, rot: Math.atan2(dy, dx), seed: Math.random() });
        this.light(e.tx, e.ty, 30, 2.5, [1, 0.6, 0.2], 1.0);
        for (let i = 0; i < 10; i++) this.P(K.FIRE, e.tx + (Math.random() - 0.5) * 4, e.ty + (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, 1 + Math.random() * 2, 1.2, 0.5, [1, 1, 1, 1], true);
        for (let i = 0; i < 6; i++) this.P(K.SMOKE, e.tx, e.ty, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, 6, 2, 1.2, [0.15, 0.14, 0.13, 0.75], false);
        break;
      }
      case 'burn': this.emit.push({ x: e.x, y: e.y, life: e.life, t: 0, r: e.r || 2, acc: 0 }); break;
      case 'decal': {
        const DKs = { [DK.CRATER]: 1, [DK.SCORCH]: 1 };
        if (DKs[e.k] !== undefined) this.r.addDecal(e.k, e.x, e.y, e.r, e.r, Math.random() * 6.28, Math.random(), 1);
        break;
      }
      case 'plane': this.planes.push({ ...e, t: 0 }); break;
    }
  }

  update(dt) {
    this.time += dt;
    const p = this.p;
    for (let i = p.length - 1; i >= 0; i--) {
      const o = p[i];
      o.t += dt;
      if (o.t >= o.life) { p[i] = p[p.length - 1]; p.pop(); continue; }
      o.x += o.vx * dt; o.y += o.vy * dt;
      if (!o.tracer) { o.vx *= 1 - dt * 1.5; o.vy *= 1 - dt * 1.5; }
      o.size += o.grow * dt;
    }
    for (let i = this.emit.length - 1; i >= 0; i--) {
      const e = this.emit[i];
      e.t += dt; e.acc += dt;
      if (e.t > e.life) { this.emit.splice(i, 1); continue; }
      const k = 1 - e.t / e.life;
      while (e.acc > 0.12) {
        e.acc -= 0.12;
        this.P(K.SMOKE, e.x + (Math.random() - 0.5) * e.r, e.y + (Math.random() - 0.5) * e.r, 0.8 + Math.random(), -0.4 + Math.random() * 0.4, 8, 1.5, 1.4, [0.12, 0.11, 0.1, 0.55 * k + 0.1], false);
        if (Math.random() < k) this.P(K.FIRE, e.x + (Math.random() - 0.5) * e.r, e.y + (Math.random() - 0.5) * e.r, 0, 0, 0.6, e.r * 0.6, 0.5, [1, 1, 1, 1], true);
      }
    }
    for (let i = this.planes.length - 1; i >= 0; i--) { const pl = this.planes[i]; pl.t += dt; if (pl.t > pl.dur) this.planes.splice(i, 1); }
    for (let i = this.flashLights.length - 1; i >= 0; i--) { const l = this.flashLights[i]; l.t += dt; if (l.t > l.life) this.flashLights.splice(i, 1); }
  }

  build(alphaFx, addFx, view) {
    const [x0, y0, x1, y1] = view;
    for (const o of this.p) {
      if (o.x < x0 - 30 || o.x > x1 + 30 || o.y < y0 - 30 || o.y > y1 + 30) continue;
      const f = o.t / o.life;
      const c = o.c;
      let a = c[3];
      if (o.kind === K.SMOKE || o.kind === K.DUST) a *= f < 0.15 ? f / 0.15 : 1 - (f - 0.15) / 0.85;
      else if (o.kind === K.SPLASH) a *= 1 - f;
      else if (o.kind === K.FLASH || o.kind === K.SPARK) a *= 1 - f;
      else if (o.kind === K.FIRE) a *= 1 - f * f;
      const L = o.add ? addFx : alphaFx;
      if (o.kind === K.TRACER) L.push(o.x, o.y, o.size, 0.18, o.rot, K.TRACER, 0, 0, c[0], c[1], c[2], 1);
      else if (o.kind === K.FLAME) L.push(o.x, o.y, o.size, o.size2, o.rot, K.FLAME, 0, o.seed, 1, 1, 1, 1 - f * f);
      else L.push(o.x, o.y, o.size, o.size, o.rot, o.kind, 0, o.seed, c[0], c[1], c[2], a);
    }
  }
}
