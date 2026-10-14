// Landing craft, amtracs and tanks: movement, grounding on the reef, unloading, weapons, damage.
import { clamp, normAngle, turnToward, angleTo, dist } from '../util.js';
import { F } from '../world/terrain.js';
import { MC } from './nav.js';
import { DK } from '../kinds.js';
import { soldierCombatProxy, explode } from './combat.js';

export function updateVehicle(g, v, dt) {
  const spec = v.spec, T = g.T;
  if (v.state === 'destroyed') {
    v.burnT += dt;
    if (spec.kind === 'boat' && T.depthAt(v.x, v.y) > 0.6) v.sinking = Math.min(1, v.sinking + dt * 0.02);
    return;
  }
  if (v.carried) return;
  if (v.cargoVeh) { const c = v.cargoVeh; c.x = v.x; c.y = v.y; c.dir = v.dir; c.tdir = v.dir; }
  // unloading sequence
  if (v.unloadT > 0) {
    v.speed = 0; v.ramp = Math.min(1, v.ramp + dt * 0.8);
    v.unloadT -= dt;
    if (v.unloadT <= 0) performUnload(g, v);
  }
  const depth = T.depthAt(v.x, v.y);
  const inWater = depth > (spec.kind === 'track' ? 0.6 : 0.35);
  // movement
  let target = 0;
  if (v.path && !v.immobile && !v.grounded && v.unloadT <= 0) {
    const wp = v.path[v.pathI];
    const d = Math.hypot(wp[0] - v.x, wp[1] - v.y);
    if (d < (spec.kind === 'boat' ? 7 : 3.5)) {
      v.pathI++;
      if (v.pathI >= v.path.length) { v.path = null; onArrive(g, v); }
    }
    if (v.path) {
      const w2 = v.path[v.pathI];
      const want = Math.atan2(w2[1] - v.y, w2[0] - v.x);
      const turnRate = spec.kind === 'boat' ? 0.32 : spec.kind === 'amph' ? 0.5 : 0.55;
      const diff = Math.abs(normAngle(want - v.dir));
      v.dir = turnToward(v.dir, want, turnRate * dt);
      target = inWater ? spec.sw || 1.2 : spec.sl || 0.5;
      if (spec.kind === 'track' && depth > 0) target *= clamp(1 - depth * 0.45, 0.3, 1);
      if (v.order.kind === 'sneak') target *= 0.5;
      if (v.order.kind === 'fast') target *= 1.15;
      target *= clamp(1.15 - diff / 1.1, 0.15, 1);
      if (spec.kind === 'track' && T.vegAt(v.x, v.y) > 0.4) target *= 0.8;
    }
  }
  const acc = spec.kind === 'boat' ? 0.8 : 1.2;
  v.speed += clamp(target - v.speed, -acc * 2 * dt, acc * dt);
  if (v.speed > 0.01) {
    const nx = v.x + Math.cos(v.dir) * v.speed * dt, ny = v.y + Math.sin(v.dir) * v.speed * dt;
    const cls = spec.kind === 'boat' ? MC.BOAT : spec.kind === 'amph' ? MC.AMPH : MC.TRACK;
    const bowX = nx + Math.cos(v.dir) * spec.len * 0.45, bowY = ny + Math.sin(v.dir) * spec.len * 0.45;
    if (spec.kind === 'boat') {
      const bd = T.depthAt(bowX, bowY);
      if (bd < spec.draft || (T.flagsAt(bowX, bowY) & (F.TRAP | F.PIER | F.BUILDING))) {
        v.speed = 0; v.path = null; v.grounded = bd < spec.draft;
        if (v.grounded) onGround(g, v); else onArrive(g, v);
      } else { v.x = nx; v.y = ny; }
    } else if (g.nav.passable(cls, bowX, bowY, { wade: spec.wade }) || !g.nav.passable(cls, v.x, v.y, { wade: spec.wade })) {
      v.x = nx; v.y = ny;
    } else {
      v.speed = 0;
      if (v.path) { v.blockedT = (v.blockedT || 0) + dt; if (v.blockedT > 2) { v.path = null; v.blockedT = 0; onArrive(g, v); } }
    }
  }
  v.wake = inWater ? v.speed : 0;
  for (const t of v.cargo) for (const s of t.soldiers) { s.x = v.x; s.y = v.y; }
  // close assault by infantry against tanks
  if (spec.kind === 'track' && g.rng() < dt * 0.5) {
    g.hash.query(v.x, v.y, 7, (s) => {
      if (s.sideIdx === v.sideIdx || !g.alive(s) || s.status === 'pinned' || s.status === 'cowering' || s.inStruct) return;
      if (g.rng() < 0.1) {
        damageVehicle(g, v, { pen: 999, vsVeh: 90 }, s.x, s.y, s);
        if (g.rng() < 0.5) v.immobile = true;
        g.emit({ t: 'expl', x: v.x, y: v.y, power: 2 });
        g.sound('explosion_large', v.x, v.y, 1);
        if (s.side === 'JP') g.voice('jp_tank', s.x, s.y, 'JP', { cd: 10 });
        g.msg(`${v.name} hit by a close assault!`, v.side === 'US' ? 'bad' : 'good');
      }
    });
  }
  // weapons
  if (v.state !== 'destroyed' && !(v.team && g.teamAlive(v.team) === 0)) {
    for (let i = 0; i < v.weps.length; i++) soldierCombatProxy(g, v, v.weps[i], i, dt);
  }
}

function onArrive(g, v) {
  const spec = v.spec;
  if (!v.cargo.length && !v.cargoVeh) return;
  const depth = g.T.depthAt(v.x, v.y);
  if (spec.kind === 'amph' && v.autoUnload && depth < 0.8) unloadVehicle(g, v);
  if (spec.kind === 'boat' && v.autoUnload && v.beachTarget) { v.grounded = true; onGround(g, v); return; }
  if (spec.kind === 'boat' && v.autoUnload) {
    const ax = v.x + Math.cos(v.dir) * (spec.len * 0.5 + 8), ay = v.y + Math.sin(v.dir) * (spec.len * 0.5 + 8);
    if (g.T.depthAt(ax, ay) < spec.draft + 0.25) { v.grounded = true; onGround(g, v); }
  }
}
function onGround(g, v) {
  if (v.cargo.length || v.cargoVeh) {
    if (!g._reefWarned) { g._reefWarned = true; g.radio('rad_reef', 'Boats are grounding on the reef! The tide is too low!'); }
    g.msg(`${v.name} grounded on the reef`, 'warn');
    if (v.autoUnload) unloadVehicle(g, v);
  }
}

export function unloadVehicle(g, v) {
  if (v.unloadT > 0 || (!v.cargo.length && !v.cargoVeh)) return false;
  const depth = g.T.depthAt(v.x + Math.cos(v.dir) * v.spec.len * 0.6, v.y + Math.sin(v.dir) * v.spec.len * 0.6);
  if (depth > 1.5 && !v.grounded && !v.beachTarget) { g.msg(`${v.name}: water too deep to unload here`, "warn"); return false; }
  v.path = null; v.speed = 0;
  v.unloadT = v.spec.kind === 'boat' ? 2.6 : 1.4;
  if (v.spec.kind === 'boat') g.sound('ramp_drop', v.x, v.y, 0.9);
  return true;
}

function beachPoint(g, x, y, dir) {
  const T = g.T;
  for (let d = 4; d < 900; d += 4) {
    const px = x + Math.cos(dir) * d, py = y + Math.sin(dir) * d;
    if (!T.inBounds(px, py)) break;
    if (T.depthAt(px, py) < 0) {
      const tx = px + Math.cos(dir) * 14, ty = py + Math.sin(dir) * 14;
      return g.nav.nearestPassable(MC.INF, tx, ty, {}, 6) || [px, py];
    }
  }
  return null;
}

function performUnload(g, v) {
  const spec = v.spec;
  const boat = spec.kind === 'boat';
  const fwd = boat ? 1 : -1;
  const ex = v.x + Math.cos(v.dir) * fwd * (spec.len / 2 + 2.5), ey = v.y + Math.sin(v.dir) * fwd * (spec.len / 2 + 2.5);
  const beach = v.beachTarget || beachPoint(g, v.x, v.y, v.dir);
  let ti = 0;
  for (const team of v.cargo) {
    team.embarked = null;
    const n = team.soldiers.length;
    team.soldiers.forEach((s, i) => {
      s.inVeh = null;
      const side = (i % 2 ? 1 : -1);
      const perp = v.dir + Math.PI / 2;
      let px, py;
      if (boat) { px = ex + Math.cos(perp) * side * (1 + (i % 3)) + Math.cos(v.dir) * ti * 3; py = ey + Math.sin(perp) * side * (1 + (i % 3)) + Math.sin(v.dir) * ti * 3; }
      else { px = v.x + Math.cos(perp) * side * (spec.wid / 2 + 1.5) - Math.cos(v.dir) * (i / n - 0.5) * spec.len; py = v.y + Math.sin(perp) * side * (spec.wid / 2 + 1.5) - Math.sin(v.dir) * (i / n - 0.5) * spec.len; }
      const p = g.nav.nearestPassable(MC.INF, px, py, {}, 8) || [px, py];
      s.x = s.px = p[0]; s.y = s.py = p[1]; s.tx = s.x; s.ty = s.y; s.slotX = s.x; s.slotY = s.y;
      s.dir = v.dir; s.stance = 0;
    });
    team.order = { kind: 'defend', x: ex, y: ey, facing: v.dir };
    if (team.side === 'US') {
      if (beach && g.T.depthAt(ex, ey) > 0.1) {
        const lat = (ti - (v.cargo.length - 1) / 2) * 14;
        const bx = beach[0] + Math.cos(v.dir + Math.PI / 2) * lat, by = beach[1] + Math.sin(v.dir + Math.PI / 2) * lat;
        g.order(team, 'move', bx, by, null, { facing: v.dir });
      }
    }
    ti++;
  }
  if (v.cargo.length && v.side === 'US') {
    const s0 = v.cargo[0].soldiers[0];
    g.voice(boat ? 'us_ramp_1' : 'us_beach_1', s0.x, s0.y, 'US', { cd: 6, prio: 2 });
    if (boat && g.T.depthAt(ex, ey) > 0.5) g.strikes.push({ t: g.time + 5, fn: (gg) => gg.voice('us_wade_1', s0.x, s0.y, 'US', { cd: 30 }) });
    else if (!boat) g.strikes.push({ t: g.time + 4, fn: (gg) => gg.voice('us_seawall_1', s0.x, s0.y, 'US', { cd: 30 }) });
    g.msg(`${v.name} unloads ${v.cargo.map(t => t.name).join(', ')}`, 'info');
  }
  v.cargo = [];
  if (v.cargoVeh) {
    const c = v.cargoVeh;
    v.cargoVeh = null; c.carried = false;
    c.x = c.px = ex + Math.cos(v.dir) * 3; c.y = c.py = ey + Math.sin(v.dir) * 3; c.dir = c.tdir = v.dir;
    if (beach) g.orderVehicle(c, 'move', beach[0], beach[1]);
    g.radio('rad_tanks_landing', `${c.name} coming ashore.`);
  }
  // empty craft withdraw
  if (boat) {
    v.grounded = false;
    const back = [v.x - Math.cos(v.dir) * 400, v.y - Math.sin(v.dir) * 400];
    v.retire = true;
    g.strikes.push({ t: g.time + 3, fn: (gg) => { if (v.state !== 'destroyed') { v.dir += Math.PI; gg.orderVehicle(v, 'move', back[0], back[1]); v.ramp = 0; } } });
  }
}

export function damageVehicle(g, v, w, fx, fy, owner) {
  if (v.state === 'destroyed') return;
  const spec = v.spec;
  const att = Math.atan2(fy - v.y, fx - v.x);
  const rel = Math.abs(normAngle(att - v.dir));
  const ai = rel < 0.8 ? 0 : rel > 2.35 ? 2 : 1;
  const armor = spec.armor[ai];
  const pen = (w.pen || 0) * (0.8 + g.rng() * 0.4);
  const smallArms = !w.pen && !w.he;
  if (pen > armor || armor === 0) {
    const dmg = (w.vsVeh || (smallArms ? 1.3 : 3)) * (0.7 + g.rng() * 0.6);
    v.hp -= dmg;
    if (spec.openTop && smallArms && g.rng() < 0.07) {
      const pool = [];
      for (const t of v.cargo) for (const s of t.soldiers) if (g.alive(s)) pool.push(s);
      if (v.team) for (const s of v.team.soldiers) if (g.alive(s)) pool.push(s);
      if (pool.length) g.hitSoldier(pool[(g.rng() * pool.length) | 0], owner);
    }
    if (!smallArms && (w.vsVeh || 0) >= 60 && spec.kind === 'track' && g.rng() < 0.2) { v.immobile = true; g.msg(`${v.name} immobilised`, v.side === 'US' ? 'bad' : 'good'); }
    if (!smallArms) g.emit({ t: 'impact', x: v.x, y: v.y, hard: true, big: true });
  } else {
    g.emit({ t: 'ricochet', x: v.x, y: v.y });
    if (g.rng() < 0.3) g.sound('metal_hit', v.x, v.y, 0.5);
  }
  if (v.hp <= 0) destroyVehicle(g, v, owner);
}

export function destroyVehicle(g, v, owner) {
  if (v.state === 'destroyed') return;
  v.state = 'destroyed'; v.hp = 0; v.speed = 0; v.path = null; v.burnT = 0;
  const T = g.T;
  g.emit({ t: 'expl', x: v.x, y: v.y, power: 3 });
  g.sound('explosion_large', v.x, v.y, 1.2);
  g.fires.push({ x: v.x, y: v.y, t: 0, life: 60 });
  g.emit({ t: 'burn', x: v.x, y: v.y, life: 60, r: 2.5 });
  const usSide = v.side === 'US';
  if (usSide) g.stats.vehLost++; else g.stats.jpVehLost++;
  g.msg(`${v.name} knocked out!`, usSide ? 'bad' : 'good');
  const deep = T.depthAt(v.x, v.y) > 1.4;
  const bail = (team, pk, pi) => {
    team.soldiers.forEach((s, i) => {
      if (!g.alive(s)) return;
      const r = g.rng();
      s.inVeh = null;
      const a = (i / team.soldiers.length) * 6.28 + g.rng();
      const p = g.nav.nearestPassable(MC.INF, v.x + Math.cos(a) * 4, v.y + Math.sin(a) * 4, {}, 10) || [v.x, v.y];
      s.x = s.px = s.tx = s.slotX = p[0]; s.y = s.py = s.ty = s.slotY = p[1];
      if (r < pk + (deep ? 0.15 : 0)) g.killSoldier(s, owner);
      else if (r < pk + pi) g.incap(s, owner);
      else s.sup = 90;
    });
    team.embarked = null; team.vehicle = null;
    team.order = { kind: 'defend', x: v.x, y: v.y, facing: v.dir };
  };
  if (v.team) { bail(v.team, 0.45, 0.2); v.team.name = `Crew of ${v.name}`; }
  for (const t of v.cargo) {
    bail(t, 0.14, 0.12);
    if (t.side === 'US') {
      const bp = beachPoint(g, v.x, v.y, v.dir);
      if (bp) g.order(t, 'move', bp[0], bp[1]);
    }
  }
  if (v.cargo.length && usSide) g.voice('us_lvt_hit_1', v.x, v.y, 'US', { cd: 8, prio: 2 });
  v.cargo = [];
  if (v.cargoVeh) {
    const c = v.cargoVeh;
    c.state = 'destroyed'; c.carried = false; c.sinking = 1; c.hp = 0;
    if (c.side === 'US') g.stats.vehLost++;
    if (c.team) for (const s of c.team.soldiers) { s.inVeh = null; g.killSoldier(s, owner); }
    v.cargoVeh = null;
  }
  if (!deep) {
    T.stampRect(v.x, v.y, v.spec.len, v.spec.wid, v.dir, (k) => { T.obj[k] = Math.max(T.obj[k], 1.7); T.flags[k] |= F.WRECK; });
  }
  g.staticDirty = true;
}
