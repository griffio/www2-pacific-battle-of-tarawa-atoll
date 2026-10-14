// Builds per-frame sprite instance lists from map + game state.
import { InstanceList } from './renderer.js';
import { FX } from './fx.js';
import { K } from '../kinds.js';
import { STRUCT_SPECS } from '../world/betio.js';
import { normAngle } from '../util.js';

const SH = [0.42, 0.3]; // shadow offset per metre of height
const WEP = { rifle: 0, mg: 1, hmg: 1, auto: 1, at: 2, flame: 3, smg: 4, mortar: 5, pistol: 6, cannon: 5, coastal: 5 };
const TALL = { [K.BUILDING]: 3.5, [K.HUT]: 2.5, [K.HULK]: 6, [K.TRUCK]: 1.6, [K.CRATE]: 1.2, [K.TRAP]: 1, [K.SEAWALL]: 1.1, [K.RUBBLE]: 0.6 };

export class Scene {
  constructor(renderer, map) {
    this.r = renderer; this.map = map;
    this.low = new InstanceList(4096); this.canopy = new InstanceList(4096);
    this.alpha = new InstanceList(16384); this.add = new InstanceList(4096);
    this.fx = new FX(renderer);
    this.staticBuilt = false;
  }
  buildStatic(g) {
    const L = this.low, C = this.canopy, map = this.map;
    L.clear(); C.clear();
    const shadow = (x, y, hw, hh, rot, h, rect) => L.push(x + SH[0] * h, y + SH[1] * h, hw, hh, rot, K.SHADOW, rect ? 1 : 0, 0, 1, 1, 1, 1);
    for (const p of map.props) { const h = TALL[p.k]; if (h) shadow(p.x, p.y, p.hw, p.hh, p.rot, h, true); }
    const structs = g ? g.structures : map.structures;
    for (const s of structs) if (s.type !== 'hulk') { const sp = STRUCT_SPECS[s.type]; shadow(s.x, s.y, s.h / 2, s.w / 2, s.dir, sp.height * 0.8, true); }
    for (const c of map.canopy) L.push(c.x + SH[0] * 8, c.y + SH[1] * 8, c.hw * 0.9, c.hh * 0.9, 0, K.SHADOW, 0, 0, 1, 1, 1, 0.7);
    for (const p of map.positions) {
      if (p.type === 'mgnest') L.push(p.x, p.y, 3.4, 3.4, p.dir, K.MGNEST, 0, 0, 1, 1, 1, 1);
      else if (p.type === 'gunpit') L.push(p.x, p.y, 5.6, 5.6, p.dir, K.SANDBAG, 0, 0, 1, 1, 1, 1);
      else if (p.type === 'revet') L.push(p.x, p.y, 6, 6, p.dir, K.REVET, 0, 0, 1, 1, 1, 1);
    }
    for (const p of map.props) L.push(p.x, p.y, p.hw, p.hh, p.rot, p.k, p.p0, p.p1, 1, 1, 1, 1, p.p2, p.p3);
    for (const s of structs) {
      if (s.type === 'hulk') continue;
      const sp = STRUCT_SPECS[s.type];
      L.push(s.x, s.y, s.h / 2, s.w / 2, s.dir, sp.sprite, s.destroyed ? 1 : 0, 0, 1, 1, 1, 1);
    }
    for (const c of map.canopy) C.push(c.x, c.y, c.hw, c.hh, c.rot, K.PALM, c.p0, c.p1, 1, 1, 1, 1);
    this.staticBuilt = true;
  }

  build(g, cam, viewRect, interp, zoomCss, dt) {
    if (!this.staticBuilt || (g && g.staticDirty)) { this.buildStatic(g); if (g) g.staticDirty = false; }
    const A = this.alpha, D = this.add;
    A.clear(); D.clear();
    const [x0, y0, x1, y1] = viewRect;
    const inView = (x, y, m) => x > x0 - m && x < x1 + m && y > y0 - m && y < y1 + m;
    const copyCulled = (src, dst, m) => {
      const d = src.data;
      for (let i = 0; i < src.n; i++) {
        const o = i * 16;
        const r = Math.max(d[o + 2], d[o + 3]) + m;
        if (d[o] < x0 - r || d[o] > x1 + r || d[o + 1] < y0 - r || d[o + 1] > y1 + r) continue;
        dst.ensure(1);
        dst.data.set(d.subarray(o, o + 16), dst.n * 16); dst.n++;
      }
    };
    copyCulled(this.low, A, 4);
    if (!g) { copyCulled(this.canopy, A, 2); return; }
    const T = g.T;
    const lerp = (a, b) => a + (b - a) * interp;
    const sz = Math.max(1.15, 4.2 / zoomCss);
    const time = g.time;
    // bodies & incapacitated
    for (const s of g.soldiers) {
      if (s.state !== 'dead' && s.state !== 'incap') continue;
      if (s.inVeh || (s.inStruct)) continue;
      if (!inView(s.x, s.y, 3)) continue;
      if (s.side === 'JP' && s.lastSeen[0] === 0 && s.visT[0] < time) continue;
      const depth = T.depthAt(s.x, s.y);
      if (depth > 0.9) continue;
      L_soldier(A, s, s.x, s.y, sz * 1.25, s.state === 'dead' ? 4 : 3, time, depth, 0.95);
    }
    // vehicles
    for (const v of g.vehicles) {
      if (v.carried && !v.cargoVehOf) { /* drawn inside its LCM */ }
      const x = lerp(v.px, v.x), y = lerp(v.py, v.y);
      if (!inView(x, y, 12)) continue;
      if (v.side === 'JP' && v.visT[0] < time && v.state !== 'destroyed') continue;
      const spec = v.spec;
      const vs = Math.min(3, Math.max(1, 1.6 / zoomCss));
      const dead = v.state === 'destroyed';
      let a = 1 - v.sinking * 0.75;
      v._phase = (v._phase || 0) + v.speed * dt * 1.2;
      const depth = T.depthAt(x, y);
      if (!dead || depth < 1) A.push(x + SH[0] * 1.5 * vs, y + SH[1] * 1.5 * vs, spec.len / 2 * vs, spec.wid / 2 * vs, v.dir, K.SHADOW, 1, 0, 1, 1, 1, a * (depth > 0.2 ? 0.4 : 1));
      if (v.wake > 0.3 && !dead) A.push(x - Math.cos(v.dir) * spec.len * 0.9 * vs, y - Math.sin(v.dir) * spec.len * 0.9 * vs, spec.len * 0.9 * vs, spec.wid * 1.6 * vs, v.dir, K.WAKE, 0, 0, 1, 1, 1, Math.min(1, v.wake / 2));
      const cargo = v.cargo.length > 0 ? 1 : 0;
      if (spec.sprite === K.LVT) A.push(x, y, spec.len / 2 * vs, spec.wid / 2 * vs, v.dir, K.LVT, dead ? 1 : 0, cargo, 1, 1, 1, a, v._phase, spec.variant || 0);
      else if (spec.sprite === K.LCVP || spec.sprite === K.LCM) A.push(x, y, spec.len / 2 * vs, spec.wid / 2 * vs, v.dir, spec.sprite, dead ? 1 : 0, cargo, 1, 1, 1, a, 0, v.ramp);
      else if (spec.sprite === K.RAFT) A.push(x, y, spec.len / 2 * vs, spec.wid / 2 * vs, v.dir, K.RAFT, dead ? 1 : 0, cargo, 1, 1, 1, a);
      else A.push(x, y, spec.len / 2 * vs, spec.wid / 2 * vs, v.dir, spec.sprite, dead ? 1 : 0, normAngle(v.tdir - v.dir), 1, 1, 1, a, v._phase, 0);
      if (dead && v.burnT < 50 && Math.random() < dt * 4) this.fx.P(K.SMOKE, x, y, 0.8, -0.3, 7, 1.8, 1.3, [0.1, 0.1, 0.1, 0.5], false);
    }
    // crew-served guns in the open
    for (const t of g.teams) {
      if (t.struct || t.vehicle || t.embarked) continue;
      for (const s of t.soldiers) {
        if (!(s.wk === 'type94' || s.wk === 'type41' || s.wk === 'pack75') || s.state === 'dead') continue;
        if (s.side === 'JP' && s.visT[0] < time && s.lastSeen[0] === 0) continue;
        if (!inView(s.x, s.y, 4)) continue;
        A.push(s.x + Math.cos(s.dir) * 1.2, s.y + Math.sin(s.dir) * 1.2, 2.4, 1.2, s.dir, K.FIELDGUN, 0, 0, 1, 1, 1, 1);
      }
    }
    // living soldiers
    const startSoldiers = A.n;
    for (const s of g.soldiers) {
      if (s.state === 'dead' || s.state === 'incap' || s.inVeh || s.inStruct) continue;
      if (s.side === 'JP' && s.visT[0] < time) continue;
      const x = lerp(s.px, s.x), y = lerp(s.py, s.y);
      if (!inView(x, y, 3)) continue;
      const depth = T.depthAt(x, y);
      const st = s.stance;
      L_soldier(A, s, x, y, st === 2 ? sz * 1.25 : sz, st, s.moving ? s.anim : 0, depth, 1);
    }
    const endSoldiers = A.n;
    // tracked-vehicle tread marks
    for (const v of g.vehicles) if (v.spec.kind === 'track' && v.speed > 0.5 && !v.carried && T.depthAt(v.x, v.y) < 0) {
      v._trk = (v._trk || 0) + v.speed * dt;
      if (v._trk > 3) { v._trk = 0; this.r.addDecal(2, v.x, v.y, 2, v.spec.wid / 2, v.dir, 0, 0.8); }
    }
    // palm canopy
    copyCulled(this.canopy, A, 2);
    // x-ray pass so units under the canopy stay readable
    for (let i = startSoldiers; i < endSoldiers; i++) {
      const o = i * 16;
      A.ensure(1);
      A.data.set(A.data.subarray(o, o + 16), A.n * 16);
      A.data[A.n * 16 + 11] = 0.32;
      A.n++;
    }
    // smoke screens (match the LOS model)
    for (let i = 0; i < g.smokes.length; i++) {
      const m = g.smokes[i];
      if (!inView(m.x, m.y, m.r * 2)) continue;
      const fade = Math.min(1, m.t / 3) * Math.min(1, (m.life - m.t) / 10);
      for (let k = 0; k < 7; k++) {
        const a = k * 2.4 + i, rr = k === 0 ? 0 : m.r * 0.55;
        A.push(m.x + Math.cos(a + time * 0.03) * rr, m.y + Math.sin(a + time * 0.03) * rr, m.r * 0.75, m.r * 0.75, a, K.SMOKE, 0, k * 0.13 + i, 0.88, 0.88, 0.86, 0.55 * fade);
      }
    }
    this.fx.update(dt);
    this.fx.build(A, D, viewRect);
    // projectiles
    for (const p of g.projectiles) {
      if (p.invisible || !inView(p.x, p.y, 10)) continue;
      if (p.kind === 'grenade' || p.kind === 'satchel') {
        const f = Math.min(1, p.t / Math.max(0.01, p.T));
        const hgt = p.kind === 'grenade' ? Math.sin(f * Math.PI) * 4 : 0;
        A.push(p.x, p.y - hgt * 0.4, 0.28 + hgt * 0.03, 0.28 + hgt * 0.03, 0, K.FOXHOLE, 0, 0, 0.3, 0.3, 0.25, 1);
      } else if (p.kind === 'mortar') {
        const f = p.t / p.T;
        if (f > 0.85) D.push(p.x, p.y, 0.6, 0.6, 0, K.ROCKET, 0, 0, 1, 0.8, 0.5, 0.8);
      } else D.push(p.x, p.y, p.kind === 'rocket' ? 1.2 : 0.8, 0.5, Math.atan2(p.ty - p.y0, p.tx - p.x0), K.ROCKET, 0, 0, 1, 0.75, 0.4, 1);
    }
    // aircraft
    for (const pl of this.fx.planes) {
      const f = pl.t / pl.dur;
      const x = pl.x0 + (pl.x1 - pl.x0) * f, y = pl.y0 + (pl.y1 - pl.y0) * f;
      const rot = Math.atan2(pl.y1 - pl.y0, pl.x1 - pl.x0);
      A.push(x + 25, y + 18, 8, 8, rot, K.SHADOW, 0, 0, 1, 1, 1, 0.5);
      A.push(x, y, 8, 8, rot, K.PLANE, 0, 0, 1, 1, 1, 1);
    }
    // flares & fires glow
    for (const f of g.flares) D.push(f.x, f.y, 14, 14, 0, K.GLOW, 0, 0, 1, 0.95, 0.8, f.int * 0.9);
    for (const f of g.fires) if (inView(f.x, f.y, 10)) D.push(f.x, f.y, 2.2, 2.2, 0, K.FIRE, 0, (f.x * 7 + f.y) % 1, 1, 1, 1, Math.min(1, (f.life - f.t) / 10));
  }

  lights(g, viewRect) {
    const out = [];
    const [x0, y0, x1, y1] = viewRect;
    const vis = (x, y, r) => x > x0 - r && x < x1 + r && y > y0 - r && y < y1 + r;
    if (g) {
      for (const f of g.flares) if (vis(f.x, f.y, f.r)) out.push({ x: f.x, y: f.y, r: f.r * 1.15, i: f.int * 1.25, c: [1, 0.95, 0.82] });
      for (const f of g.fires) if (vis(f.x, f.y, 30)) out.push({ x: f.x, y: f.y, r: 28, i: 0.9 * Math.min(1, (f.life - f.t) / 10) * (0.85 + Math.random() * 0.3), c: [1, 0.55, 0.2] });
    }
    for (const l of this.fx.flashLights) if (vis(l.x, l.y, l.r)) out.push({ x: l.x, y: l.y, r: l.r, i: l.i * (1 - l.t / l.life), c: l.c });
    // in daylight point lights barely register: keep only the strongest few (each costs a loop per pixel)
    const cap = g && (g.light.night || 0) > 0.15 ? 24 : 6;
    if (out.length > cap) { out.sort((a, b) => b.i * b.r - a.i * a.r); out.length = cap; }
    return out;
  }
}

function L_soldier(A, s, x, y, size, stance, anim, depth, alpha) {
  const wcls = WEP[s.wpn.cls] ?? 0;
  A.push(x, y, size, size, s.dir, stance >= 3 ? K.BODY : K.SOLDIER, stance, wcls, 1, 1, 1, alpha, s.sideIdx, anim, Math.max(0, depth), 0);
}
