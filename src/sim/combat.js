// Fire resolution, suppression, explosions, flamethrowers, demolitions, grenades, medics.
import { clamp, dist, dist2, angleTo, normAngle, turnToward } from '../util.js';
import { STANCE_H, STANCE_EXPOSE, GRENADE, SATCHEL, W } from './data.js';
import { MC } from './nav.js';
import { DK } from '../kinds.js';
import { damageVehicle } from './vehicles.js';

const EYE = [1.6, 0.95, 0.36];
const ACC = 0.5;

export function rangeFactor(w, d) {
  if (d > w.range) return 0;
  if (d < w.eff) return 1 - 0.45 * (d / w.eff) * (d / w.eff);
  return 0.55 * (1 - (d - w.eff) / Math.max(1, w.range - w.eff));
}
export function structCenterDist(st, x, y) { return Math.hypot(st.x - x, st.y - y) - Math.max(st.w, st.h) * 0.45; }
export function inArc(st, x, y) { return Math.abs(normAngle(Math.atan2(y - st.y, x - st.x) - st.dir)) < st.arc; }

function shooterMod(g, s) {
  let m = [0.85, 1, 1.15][s.stance] * (1 - s.sup / 130) * (s.state === 'wounded' ? 0.7 : 1) * (s.exp || 1);
  if (s.moving) m *= 0.35;
  if (s.berserk) m *= 0.6;
  return m;
}

// ---------------------------------------------------------------- per-soldier combat brain
export function soldierCombat(g, s, dt) {
  const team = s.team, o = team.order, w = s.wpn;
  if (s.task && handleTask(g, s, dt)) return;
  if (s.role === 'medic' && !s.task && s.status !== 'cowering' && s.status !== 'panicked') medicSearch(g, s);
  if (s.reloadT > 0) {
    s.reloadT -= dt;
    if (s.reloadT <= 0) { s.mag = Math.min(w.mag || 99, s.ammo); if (w.ping && g.rng() < 0.5) g.sound('garand_ping', s.x, s.y, 0.35); }
    return;
  }
  if (s.burstLeft > 0) {
    s.burstT -= dt;
    while (s.burstT <= 0 && s.burstLeft > 0) { fireRound(g, s); s.burstLeft--; s.burstT += w.gap || 0.1; }
    return;
  }
  s.fireCD -= dt;
  if (s.status === 'cowering' || (s.status === 'panicked' && !s.berserk) || s.ammo <= 0) return;
  if (w.setup && s.setupT < w.setup) return;

  let maxR = w.range;
  const kind = o.kind;
  if (kind === 'fast' && !s.berserk) maxR = 30;
  if (kind === 'sneak' || kind === 'retreat') maxR = 15;
  if (kind === 'ambush') {
    if (s.sup > 15 || team.sprung) { team.sprung = true; }
    else maxR = Math.min(maxR, team.side === 'US' ? 70 : 90);
  }
  if (team.side === 'JP' && team.hidden && !team.sprung) {
    // concealed defenders hold fire until the enemy is close or they are discovered
    if (s.sup > 30) team.sprung = true;
    else maxR = Math.min(maxR, team.ai.holdRange || 220);
  }

  // grenades
  if (s.grenCD <= 0 && s.grenades > 0 && !w.crew && s.status !== 'pinned' && kind !== 'sneak') tryGrenade(g, s);

  if (w.cls === 'flame') { flamerLogic(g, s, dt); return; }
  if (s.satchels > 0 && kind === 'assault' && o.arrived && o.target && !s.task) {
    const st = o.target.inStruct || (o.target.spec && o.target.garrison ? o.target : null);
    if (st && !st.destroyed) startSatchel(g, s, st);
  }

  s.targetT -= dt;
  if (s.targetT <= 0 || (s.targetKind && !validTarget(g, s))) { chooseTarget(g, s, maxR); s.targetT = 1.1 + g.rng() * 0.9; }
  if (!s.targetKind || s.fireCD > 0) return;
  if (s.status === 'pinned' && g.rng() > 0.35) { s.fireCD = 1 + g.rng(); return; }
  attemptFire(g, s);
}

function validTarget(g, s) {
  const k = s.targetKind;
  if (!k) return false;
  const e = s.target;
  if (k === 'soldier') return g.alive(e) && (e.visT[s.sideIdx] > g.time || s.wpn.indirect);
  if (k === 'veh') return e.state !== 'destroyed' && !e.carried && e.visT[s.sideIdx] > g.time - 2;
  if (k === 'struct') return !e.destroyed && e.garrison.some(t => g.teamAlive(t) > 0);
  return true;
}

function chooseTarget(g, s, maxR) {
  const w = s.wpn, si = s.sideIdx, ei = 1 - si, o = s.team.order;
  s.target = null; s.targetKind = null;
  const order = s.team.vehicle ? s.team.vehicle.order : o;
  // explicit fire order
  if ((order.kind === 'fire' || order.kind === 'assault') && (order.target || order.x !== undefined)) {
    const t = order.target;
    if (t) {
      if (t.garrison !== undefined && t.spec) { // structure
        if (!t.destroyed && Math.hypot(t.x - s.x, t.y - s.y) <= maxR + 10) { s.target = t; s.targetKind = 'struct'; return; }
      } else if (t.spec) { if (t.state !== 'destroyed' && dist(s.x, s.y, t.x, t.y) <= maxR) { s.target = t; s.targetKind = 'veh'; return; } }
      else if (g.alive(t) && dist(s.x, s.y, t.x, t.y) <= maxR) {
        if (t.inStruct) { s.target = t.inStruct; s.targetKind = 'struct'; return; }
        s.target = t; s.targetKind = 'soldier'; return;
      }
    } else if (order.kind === 'fire' && dist(s.x, s.y, order.x, order.y) <= maxR && (!w.min || dist(s.x, s.y, order.x, order.y) >= w.min)) {
      s.target = null; s.targetKind = 'point'; s.tpx = order.x; s.tpy = order.y; return;
    }
  }
  const cls = w.cls;
  const now = g.time;
  // anti-armour / heavy weapons prefer vehicles
  if (cls === 'at' || cls === 'cannon' || cls === 'coastal' || cls === 'hmg') {
    let best = null, bd = Infinity;
    for (const v of g.vehicles) {
      if (v.sideIdx !== ei || v.state === 'destroyed' || v.carried || v.visT[si] < now) continue;
      if (cls === 'coastal' && !g.T.isWater(v.x, v.y)) continue;
      const d = dist(s.x, s.y, v.x, v.y);
      if (d < bd && d <= maxR) { bd = d; best = v; }
    }
    if (best) { s.target = best; s.targetKind = 'veh'; return; }
    if (cls === 'coastal') return;
  }
  if ((cls === 'at' || cls === 'cannon') && s.side === 'US') {
    let best = null, bd = Infinity;
    for (const st of g.structures) {
      if (st.destroyed || !st.known[si] || !st.garrison.some(t => g.teamAlive(t) > 0)) continue;
      const d = dist(s.x, s.y, st.x, st.y);
      if (d < bd && d <= maxR) { bd = d; best = st; }
    }
    if (best && (cls === 'at' || bd < 500)) { s.target = best; s.targetKind = 'struct'; return; }
    if (cls === 'at') { maxR = Math.min(maxR, 70); }
  }
  if (w.indirect) {
    if (s.role === 'knee' && s.team.key === 'jp_rifle') maxR = Math.min(maxR, 260);
    // pick the visible enemy cluster in range
    let best = null, bs = 0;
    const foes = g.sideList[ei];
    for (let i = 0; i < foes.length; i++) {
      const e = foes[i];
      if (e.visT[si] < now || e.inStruct) continue;
      const d = dist(s.x, s.y, e.x, e.y);
      if (d < (w.min || 0) || d > maxR) continue;
      let n = 0;
      for (let j = 0; j < foes.length; j++) { const f = foes[j]; const fx = f.x - e.x, fy = f.y - e.y; if (fx * fx + fy * fy < 144) n++; }
      const sc = n - d / 400 + g.rng() * 0.5;
      if (sc > bs) { bs = sc; best = e; }
    }
    if (best) { s.target = best; s.targetKind = 'soldier'; }
    return;
  }
  // direct fire vs infantry
  const cands = [];
  const foes = g.sideList[ei], maxR2 = maxR * maxR;
  for (let i = 0; i < foes.length; i++) {
    const e = foes[i];
    if (e.visT[si] < now) continue;
    const ex = e.x - s.x, ey = e.y - s.y, d2 = ex * ex + ey * ey;
    if (d2 > maxR2) continue;
    const d = Math.sqrt(d2);
    let sc = d;
    const ec = e.wpn.cls;
    if (ec === 'mg' || ec === 'hmg' || ec === 'auto') sc *= 0.6;
    if (e.inStruct) sc *= inArc(e.inStruct, s.x, s.y) ? 1.4 : 4;
    if (now - e.lastFired < 3) sc *= 0.7;
    if (e.status === 'cowering') sc *= 1.5;
    sc *= 0.85 + g.rng() * 0.3;
    cands.push([sc, e]);
  }
  // MGs and small arms may also engage boats and amtracs
  if (cls !== 'pistol') for (const v of g.vehicles) {
    if (v.sideIdx !== ei || v.state === 'destroyed' || v.carried || v.visT[si] < now) continue;
    if (v.spec.armor[0] > 20 && cls !== 'at') continue;
    const d = dist(s.x, s.y, v.x, v.y);
    if (d <= Math.min(maxR, 450)) cands.push([d * (v.cargo.length ? 0.8 : 1.3), v, true]);
  }
  cands.sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < Math.min(4, cands.length); i++) {
    const [, e, isVeh] = cands[i];
    if (isVeh) { s.target = e; s.targetKind = 'veh'; return; }
    if (e.inStruct) { s.target = e.inStruct; s.targetKind = 'struct'; return; }
    if (losTo(g, s, e, s.stance === 2 ? 0 : s.stance) > 0.05) { s.target = e; s.targetKind = 'soldier'; return; }
  }
  // suppress a known, active fortification
  if (s.side === 'US' && (o.kind === 'defend' || o.kind === 'fire')) {
    for (const st of g.structures) {
      if (st.destroyed || !st.known[0] || now - st.lastFire > 8) continue;
      const d = dist(s.x, s.y, st.x, st.y);
      if (d < Math.min(maxR, 350)) { s.target = st; s.targetKind = 'struct'; return; }
    }
  }
}

function losTo(g, s, e, stance) {
  const eye = g.T.baseAt(s.x, s.y) + EYE[stance] + (s.eyeBonus || 0);
  const [b0, b1] = g.bodyOf(e);
  const ignA = s.inStruct ? Math.max(s.inStruct.w, s.inStruct.h) / 2 + 0.5 : 0.8;
  const ignB = e.inStruct ? Math.max(e.inStruct.w, e.inStruct.h) / 2 + 0.5 : 0.8;
  const sEye = s.inStruct ? g.eyeOf(s) : eye;
  return g.T.los(s.x, s.y, sEye, e.x, e.y, b0, b1, ignA, ignB).frac;
}

function attemptFire(g, s) {
  const w = s.wpn, k = s.targetKind, T = g.T;
  let tx, ty, frac = 1, conceal = 0, chosen = s.stance;
  if (k === 'soldier') { tx = s.target.x; ty = s.target.y; }
  else if (k === 'veh') { tx = s.target.x; ty = s.target.y; }
  else if (k === 'struct') { tx = s.target.x; ty = s.target.y; }
  else { tx = s.tpx; ty = s.tpy; }
  const d = Math.hypot(tx - s.x, ty - s.y);
  if (d > w.range + 5 || (w.min && d < w.min)) { s.targetKind = null; return; }
  if (s.inStruct && !inArcDir(s.inStruct, tx, ty)) { s.targetKind = null; return; }
  if (!w.indirect) {
    // find the lowest stance that gives a line of fire
    let ok = false;
    const [b0, b1] = k === 'soldier' ? g.bodyOf(s.target) : [T.baseAt(tx, ty), T.baseAt(tx, ty) + (k === 'veh' ? 2.2 : k === 'struct' ? s.target.height : 1.0)];
    const ignB = k === 'soldier' ? (s.target.inStruct ? 4 : 0.8) : k === 'veh' ? 3 : k === 'struct' ? Math.max(s.target.w, s.target.h) / 2 + 0.5 : 2;
    const stances = s.inStruct ? [1] : s.status === 'pinned' ? [s.stance, 1] : s.stance === 2 ? [2, 1, 0] : s.stance === 1 ? [1, 0] : [0];
    for (const st of stances) {
      const eye = s.inStruct ? g.eyeOf(s) : T.baseAt(s.x, s.y) + EYE[st] + (s.eyeBonus || 0);
      const L = T.los(s.x, s.y, eye, tx, ty, b0, b1, s.inStruct ? Math.max(s.inStruct.w, s.inStruct.h) / 2 + 0.5 : 0.8, ignB);
      if (L.frac > 0.06 || (k === 'point' && L.frac > 0) || (k === 'point' && L.blockD > d - 10)) { ok = true; frac = L.frac; conceal = L.conceal + g.smokeConceal(s.x, s.y, tx, ty); chosen = st; break; }
    }
    if (!ok) { if (k !== 'struct') s.targetKind = null; s.fireCD = 0.6; return; }
    if (chosen < s.stance) { s.fireStance = chosen; s.fireStanceT = g.time + 2.5; s.stance = chosen; }
  }
  s.aimFrac = frac; s.aimConceal = conceal;
  s.dir = Math.atan2(ty - s.y, tx - s.x);
  s.burstLeft = w.burst || 1; s.burstT = 0; s.roundI = 0;
  let cd = (w.rof || 1) * (0.85 + g.rng() * 0.4) * (1 + s.sup / 70);
  if (s.moving) cd *= 1.6;
  if (s.status === 'pinned') cd *= 2.2;
  if (g.light.night && k === 'soldier' && g.lightAt(tx, ty) < 0.3) cd *= 1.4;
  s.fireCD = cd;
  const vol = w.cls === 'coastal' ? 1.4 : w.cls === 'cannon' || w.cls === 'at' ? 1.1 : w.cls === 'mg' || w.cls === 'hmg' ? 0.9 : 0.7;
  g.sound(w.snd, s.x, s.y, vol, (w.pitch || 1) * (0.96 + g.rng() * 0.08));
  if (s.inStruct) s.inStruct.lastFire = g.time;
  if (s.side === 'JP' && g.rng() < 0.04) g.voice(g.rng() < 0.5 ? 'jp_fire' : 'jp_enemy', s.x, s.y, 'JP', { cd: 10 });
}
function inArcDir(st, x, y) { return Math.abs(normAngle(Math.atan2(y - st.y, x - st.x) - st.dir)) < st.arc + 0.1; }

function fireRound(g, s) {
  const w = s.wpn;
  if (s.mag <= 0 || s.ammo <= 0) { s.burstLeft = 0; if (s.ammo > 0) s.reloadT = w.reload || 2; return; }
  s.ammo--; s.mag--;
  s.lastFired = g.time;
  const ri = s.roundI = (s.roundI || 0) + 1;
  const k = s.targetKind;
  if (!k) { s.burstLeft = 0; return; }
  let tx, ty;
  if (k === 'point') { tx = s.tpx; ty = s.tpy; }
  else { tx = s.target.x; ty = s.target.y; }
  const d = Math.hypot(tx - s.x, ty - s.y);
  const muzzle = muzzlePos(s);
  if (w.indirect || w.proj) { launchProjectile(g, s, w, tx, ty, d, k); if (s.mag <= 0 && s.ammo > 0) { s.reloadT = w.reload || 2; s.burstLeft = 0; } return; }

  const base = w.acc * ACC * rangeFactor(w, d) * shooterMod(g, s) * (ri > 1 ? 0.55 : 1);
  let ix = tx, iy = ty, hit = false;
  if (k === 'soldier') {
    const t = s.target;
    const [b0, b1] = g.bodyOf(t);
    const water = g.T.water;
    const exposeH = clamp((b1 - Math.max(b0, water)) / STANCE_H[t.stance], 0, 1);
    let expo = s.aimFrac * exposeH * STANCE_EXPOSE[t.stance] * (t.moving ? 0.8 : 1) * Math.exp(-s.aimConceal * 1.2);
    if (g.light.night) expo *= 0.4 + 0.6 * g.lightAt(t.x, t.y);
    const p = base * expo;
    hit = g.rng() < p;
    if (hit) g.hitSoldier(t, s);
    suppress(g, t, w.sup * (1 - (1 - s.aimFrac) * 0.5) * (hit ? 1.4 : 1), s);
    if (!hit) { const sc = 1.2 + d * 0.012; ix += (g.rng() - 0.5) * sc * 2; iy += (g.rng() - 0.5) * sc * 2; }
    if (t.side === 'US' && ri === 1) g.emit({ t: 'whiz', x: t.x, y: t.y, cls: w.cls });
  } else if (k === 'veh') {
    const v = s.target;
    const p = w.acc * ACC * rangeFactor(w, d) * shooterMod(g, s) * 1.6;
    hit = g.rng() < p;
    if (hit) damageVehicle(g, v, w, s.x, s.y, s);
    else { ix += (g.rng() - 0.5) * 5; iy += (g.rng() - 0.5) * 5; }
  } else if (k === 'struct') {
    const st = s.target;
    const front = inArc(st, s.x, s.y);
    ix += (g.rng() - 0.5) * st.w * 0.6; iy += (g.rng() - 0.5) * st.h * 0.6;
    const massive = st.type === 'bombproof' || st.type === 'command';
    const occ = [];
    for (const tm of st.garrison) for (const o of tm.soldiers) {
      if (!g.alive(o)) continue;
      occ.push(o);
      o.sup = Math.min(100, o.sup + w.sup * (front ? (massive ? 0.2 : 0.55) : 0.08));
    }
    // a lucky round through the embrasure / firing port
    if (front && occ.length && g.rng() < base * (massive ? 0.015 : 0.08)) g.hitSoldier(occ[(g.rng() * occ.length) | 0], s);
    g.emit({ t: 'impact', x: ix, y: iy, water: false, hard: true });
  } else { // area fire
    const sc = 3 + d * 0.01;
    ix += (g.rng() - 0.5) * sc * 2; iy += (g.rng() - 0.5) * sc * 2;
    g.hash.query(ix, iy, 6, (e) => {
      if (e.sideIdx === s.sideIdx || !g.alive(e)) return;
      if (e.inStruct) { if (inArc(e.inStruct, s.x, s.y)) e.sup = Math.min(100, e.sup + w.sup * 0.5); return; }
      e.sup = Math.min(100, e.sup + w.sup * 0.7);
      if (g.rng() < base * 0.25 * STANCE_EXPOSE[e.stance]) g.hitSoldier(e, s);
    });
    for (const st of g.structures) if (!st.destroyed && Math.hypot(st.x - ix, st.y - iy) < Math.max(st.w, st.h) && inArc(st, s.x, s.y))
      for (const tm of st.garrison) for (const o of tm.soldiers) if (g.alive(o)) o.sup = Math.min(100, o.sup + w.sup * 0.45);
  }
  const showTracer = w.tracer ? (ri % 2 === 1) : (g.rng() < 0.12);
  g.emit({ t: 'shot', x: muzzle[0], y: muzzle[1], tx: ix, ty: iy, tracer: showTracer, side: s.side, cls: w.cls, hit });
  if (k !== 'struct' && (w.cls !== 'rifle' || g.rng() < 0.5)) g.emit({ t: 'impact', x: ix, y: iy, water: g.T.isWater(ix, iy) });
  if (s.mag <= 0) { s.burstLeft = 0; if (s.ammo > 0) { s.reloadT = w.reload || 2; if (w.ping) g.sound('garand_ping', s.x, s.y, 0.4); } }
}
function muzzlePos(s) {
  if (s.inStruct) { const st = s.inStruct; const r = Math.max(st.w, st.h) / 2; return [st.x + Math.cos(st.dir) * r, st.y + Math.sin(st.dir) * r]; }
  return [s.x + Math.cos(s.dir) * 0.9, s.y + Math.sin(s.dir) * 0.9];
}

export function suppress(g, t, amount, shooter) {
  if (t.inStruct) amount *= 0.3;
  t.sup = Math.min(100, t.sup + amount);
  t.lastHitT = g.time;
  t.team.morale = Math.max(0, t.team.morale - amount * 0.006);
  if (t.side === 'US' && amount > 6 && g.rng() < 0.03) g.voice(g.rng() < 0.5 ? 'us_takingfire_1' : 'us_takingfire_2', t.x, t.y, 'US', { cd: 14, key: 'takingfire' });
  g.hash.query(t.x, t.y, 4, (o) => { if (o !== t && o.sideIdx === t.sideIdx && g.alive(o) && !o.inStruct) o.sup = Math.min(100, o.sup + amount * 0.45); });
  // reveal the shooter's general direction
  if (shooter && shooter.visT[t.sideIdx] < g.time && g.rng() < 0.08 * (shooter.wpn.burst || 1)) {
    const d = dist(t.x, t.y, shooter.x, shooter.y);
    if (d < 250 && !shooter.inStruct) { shooter.visT[t.sideIdx] = g.time + 2.5; shooter.ghostX = shooter.x; shooter.ghostY = shooter.y; }
    if (shooter.inStruct && !shooter.inStruct.known[t.sideIdx] && d < 400) { shooter.inStruct.known[t.sideIdx] = true; if (t.side === 'US') g.msg(`Fire from ${shooter.inStruct.name}!`, 'spot'); }
  }
}

export function launchProjectile(g, s, w, tx, ty, d, k) {
  let hit = false, ix = tx, iy = ty;
  if (w.indirect) {
    const sc = 4 + d * 0.05 + (s.sup / 100) * 10;
    const a = g.rng() * 6.28, r = Math.abs(g.rng.gauss()) * sc;
    ix = tx + Math.cos(a) * r; iy = ty + Math.sin(a) * r;
  } else {
    const size = k === 'struct' ? 2.2 : k === 'veh' ? (s.target.speed > 1 ? 0.75 : 1.5) : 0.6;
    const p = clamp(w.acc * ACC * rangeFactor(w, d) * shooterMod(g, s) * size * 1.4, 0, 0.95);
    hit = g.rng() < p;
    if (!hit) { const sc = 2 + d * 0.03; ix += (g.rng() - 0.5) * sc * 2; iy += (g.rng() - 0.5) * sc * 2; }
  }
  const speed = w.indirect ? 0 : (w.speed || 300);
  const T = w.indirect ? 4 + d / 140 : Math.max(0.12, d / speed);
  const [mx, my] = muzzlePos(s);
  g.projectiles.push({ kind: w.indirect ? 'mortar' : (w.proj || 'shell'), x0: mx, y0: my, x: mx, y: my, tx: ix, ty: iy, t: 0, T, w, owner: s, side: s.side,
    target: hit ? s.target : null, targetKind: hit ? k : null, fromX: s.x, fromY: s.y, arc: w.indirect ? 1 : 0 });
  if (w.indirect) g.sound('mortar_launch', s.x, s.y, 0.7);
  g.emit({ t: 'muzzle', x: mx, y: my, dir: s.dir, side: s.side, big: w.cls === 'cannon' || w.cls === 'coastal' || w.cls === 'at' });
  if (w.cls === 'at') g.emit({ t: 'backblast', x: s.x - Math.cos(s.dir) * 2, y: s.y - Math.sin(s.dir) * 2 });
  if (w.cls === 'at' && s.side === 'US') g.voice('us_bazooka_1', s.x, s.y, 'US', { cd: 25 });
}

// ---------------------------------------------------------------- projectiles
export function updateProjectiles(g, dt) {
  for (let i = g.projectiles.length - 1; i >= 0; i--) {
    const p = g.projectiles[i];
    p.t += dt;
    const f = Math.min(1, p.t / p.T);
    p.x = p.x0 + (p.tx - p.x0) * f; p.y = p.y0 + (p.ty - p.y0) * f;
    if (p.kind === 'grenade' || p.kind === 'satchel') {
      if (p.t >= p.T + (p.fuse || 0)) { g.projectiles.splice(i, 1); detonate(g, p); }
      continue;
    }
    if (p.t >= p.T) { g.projectiles.splice(i, 1); detonate(g, p); }
  }
}
function detonate(g, p) {
  const w = p.w;
  if (p.targetKind === 'veh' && p.target && p.target.state !== 'destroyed') damageVehicle(g, p.target, w, p.fromX, p.fromY, p.owner);
  if (p.targetKind === 'struct' && p.target && !p.target.destroyed) damageStruct(g, p.target, w, p.fromX, p.fromY, p.owner);
  if (p.kind === 'grenade') {
    explode(g, p.x, p.y, GRENADE.power, GRENADE.r, p.owner, {});
    if (p.into && !p.into.destroyed) {
      for (const tm of p.into.garrison) for (const o of tm.soldiers) if (g.alive(o)) { o.sup = Math.min(100, o.sup + 60); if (g.rng() < 0.28) g.hitSoldier(o, p.owner); }
    }
    return;
  }
  if (p.kind === 'satchel') {
    explode(g, p.x, p.y, SATCHEL.power, SATCHEL.r, p.owner, { satchel: true });
    if (p.st && !p.st.destroyed) {
      if (p.st.type === 'bombproof' || p.st.type === 'command') {
        p.st.hp -= 1250;
        for (const tm of p.st.garrison) for (const o of tm.soldiers) if (g.alive(o) && g.rng() < 0.3) g.hitSoldier(o, p.owner, 1.3);
        g.msg(`Charge blows an entrance of the ${p.st.name}!`, 'good');
        if (p.st.hp <= 0) destroyStruct(g, p.st, p.owner);
      } else destroyStruct(g, p.st, p.owner);
    }
    return;
  }
  if (w.he) explode(g, p.x, p.y, w.he.power, w.he.r, p.owner, { pen: w.pen, vsStruct: w.vsStruct, noStruct: p.targetKind === 'struct' });
}

export function damageStruct(g, st, w, fx, fy, owner) {
  if (st.destroyed || st.type === 'hulk') {
    if (st.type === 'hulk') for (const tm of st.garrison) for (const o of tm.soldiers) if (g.alive(o)) { o.sup = Math.min(100, o.sup + 40); if (g.rng() < 0.15) g.hitSoldier(o, owner); }
    return;
  }
  const front = inArc(st, fx, fy);
  const pen = w.pen || 0;
  let dmg = (w.vsStruct || 20) * (0.6 + g.rng() * 0.6);
  if (pen < st.spec.armor * 0.5) dmg *= 0.45;
  st.hp -= dmg;
  g.emit({ t: 'impact', x: st.x, y: st.y, hard: true, big: true });
  const massive = st.type === 'bombproof' || st.type === 'command';
  const occ = [];
  for (const tm of st.garrison) for (const o of tm.soldiers) if (g.alive(o)) occ.push(o);
  if (front && g.rng() < (massive ? 0.15 : 0.4) && occ.length) {
    if (!massive) g.msg(`Direct hit on the embrasure of ${st.name}`, 'good');
    const n = massive ? 1 : 1 + ((g.rng() * 2) | 0);
    for (let i = 0; i < n && occ.length; i++) g.hitSoldier(occ.splice((g.rng() * occ.length) | 0, 1)[0], owner);
    for (const o of occ) o.sup = Math.min(100, o.sup + (massive ? 30 : 70));
  } else for (const o of occ) o.sup = Math.min(100, o.sup + (massive ? 8 : 25));
  if (st.hp <= 0) destroyStruct(g, st, owner);
}
export function destroyStruct(g, st, owner) {
  if (st.destroyed) return;
  st.destroyed = true; st.hp = 0; st.known[0] = true;
  for (const tm of st.garrison) for (const o of tm.soldiers) {
    if (o.state === 'dead') continue;
    if (o.state === 'incap' || g.rng() < 0.85) g.killSoldier(o, owner); else g.incap(o, owner);
  }
  g.stats.structs++;
  g.emit({ t: 'expl', x: st.x, y: st.y, power: 5, big: true });
  g.emit({ t: 'decal', k: DK.SCORCH, x: st.x, y: st.y, r: Math.max(st.w, st.h) * 0.9 });
  g.fires.push({ x: st.x, y: st.y, t: 0, life: 90 });
  g.emit({ t: 'burn', x: st.x, y: st.y, life: 90, r: Math.max(st.w, st.h) * 0.4 });
  g.sound('explosion_huge', st.x, st.y, 1.3);
  g.msg(`${st.name} destroyed!`, 'good');
  if (owner && owner.side === 'US') g.voice('us_bunker_down_1', owner.x, owner.y, 'US', { cd: 6 });
  g.staticDirty = true;
  // collapse: lower the obstacle but keep it as rubble cover
  g.T.stampRect(st.x, st.y, st.w, st.h, st.rot, (k) => { g.T.obj[k] *= 0.6; });
}

// ---------------------------------------------------------------- explosions
export function explode(g, x, y, power, radius, owner, opts = {}) {
  const T = g.T;
  const depth = T.depthAt(x, y);
  const water = depth > 0.25;
  g.emit({ t: 'expl', x, y, power, water });
  g.sound(water ? 'splash_big' : power >= 4 ? 'explosion_huge' : power >= 2 ? 'explosion_large' : power >= 1.3 ? 'explosion_small' : 'grenade', x, y, Math.min(1.5, 0.6 + power * 0.18), 0.92 + g.rng() * 0.16);
  if (water && power >= 2) g.sound('explosion_small', x, y, 0.4, 0.8);
  const R = radius * (water ? 0.7 : 1);
  const h0 = T.baseAt(x, y) + 0.4;
  g.hash.query(x, y, R * 1.3, (s) => {
    if (!g.alive(s) || s.inVeh) return;
    const d = Math.hypot(s.x - x, s.y - y);
    if (d > R * 1.3) return;
    if (s.inStruct && !opts.satchel) { s.sup = Math.min(100, s.sup + 20 * power); return; }
    const inner = clamp(1 - d / R, 0, 1);
    const [b0, b1] = g.bodyOf(s);
    const L = T.los(x, y, h0, s.x, s.y, b0, b1, 0.3, 0.5);
    const pk = power * Math.pow(inner, 1.4) * (0.2 + 0.8 * L.frac) * (s.stance === 2 ? 0.75 : 1);
    const r = g.rng();
    if (r < pk * 0.42) g.killSoldier(s, owner);
    else if (r < pk * 0.72) g.incap(s, owner);
    else if (r < pk) g.wound(s, owner);
    s.sup = Math.min(100, s.sup + 25 + 75 * inner);
    s.team.morale -= inner * 3;
  });
  g.vhash.query(x, y, R, (v) => {
    if (v.state === 'destroyed') return;
    const d = Math.hypot(v.x - x, v.y - y);
    if (d > R * 0.7) return;
    damageVehicle(g, v, { pen: (opts.pen || power * 8) * (1 - d / R), vsVeh: power * 15 * (1 - d / R), he: true }, x, y, owner);
  });
  if (!opts.noStruct && power >= 2) for (const st of g.structures) {
    if (st.destroyed) continue;
    const d = structCenterDist(st, x, y);
    if (d < 3) damageStruct(g, st, { vsStruct: opts.vsStruct || power * 18, pen: opts.pen || 0 }, x, y, owner);
  }
  if (!water && power >= 1.3) {
    const r = 0.8 + power * 0.85;
    if (T.addCrater(x, y, r, 0.22 + power * 0.18)) g.emit({ t: 'decal', k: DK.CRATER, x, y, r: r * 1.5 });
  } else if (!water) g.emit({ t: 'decal', k: DK.SCORCH, x, y, r: 1.2 + power });
  // incoming fire near US troops: shout
  if (power >= 1 && g.rng() < 0.3) {
    let near = null;
    g.hash.query(x, y, 18, (s) => { if (s.side === 'US' && g.alive(s)) near = s; });
    if (near) g.voice(power < 1.3 ? 'us_grenade_1' : 'us_takingfire_2', near.x, near.y, 'US', { cd: 10, key: 'incoming' });
  }
}

// ---------------------------------------------------------------- grenades
function tryGrenade(g, s) {
  const ei = 1 - s.sideIdx;
  let best = null, bd = 29, into = null;
  g.hash.query(s.x, s.y, 28, (e) => {
    if (e.sideIdx !== ei || !g.alive(e) || e.visT[s.sideIdx] < g.time) return;
    const d = dist(s.x, s.y, e.x, e.y);
    if (d < 6 || d > bd) return;
    if (e.inStruct) return;
    bd = d; best = e;
  });
  let tx, ty;
  if (best) { tx = best.x; ty = best.y; }
  else if (s.side === 'US') {
    for (const st of g.structures) {
      if (st.destroyed || !st.known[0] || !st.garrison.some(t => g.teamAlive(t) > 0)) continue;
      const d = structCenterDist(st, s.x, s.y);
      if (d < 14 && d > 2) { tx = st.x + Math.cos(st.dir) * st.w * 0.45; ty = st.y + Math.sin(st.dir) * st.h * 0.45; if (inArc(st, s.x, s.y) || d < 5) into = st; break; }
    }
    if (tx === undefined) { s.grenCD = 2; return; }
  } else { s.grenCD = 2; return; }
  const d = dist(s.x, s.y, tx, ty);
  const sc = 1 + d * 0.08 + s.sup * 0.02;
  const ix = tx + (g.rng() - 0.5) * sc * 2, iy = ty + (g.rng() - 0.5) * sc * 2;
  s.grenades--; s.grenCD = 9 + g.rng() * 8;
  s.dir = angleTo(s.x, s.y, tx, ty);
  g.projectiles.push({ kind: 'grenade', x0: s.x, y0: s.y, x: s.x, y: s.y, tx: ix, ty: iy, t: 0, T: 0.6 + d * 0.035, fuse: 1.6, w: {}, owner: s, side: s.side, arc: 1, into: into && g.rng() < 0.55 ? into : null });
  if (s.side === 'JP') g.voice('jp_grenade', s.x, s.y, 'JP', { cd: 12 });
  else if (g.rng() < 0.15) g.voice('us_fireinhole_1', s.x, s.y, 'US', { cd: 15 });
  if (best && best.side === 'US' && g.rng() < 0.5) g.strikes.push({ t: g.time + 0.8, fn: (gg) => gg.voice('us_grenade_1', ix, iy, 'US', { cd: 6 }) });
}

// ---------------------------------------------------------------- flamethrower
function flamerLogic(g, s, dt) {
  const w = s.wpn, o = s.team.order;
  if (s.ammo <= 0) return;
  let st = null;
  if ((o.kind === 'assault' || o.kind === 'fire') && o.target) st = o.target.inStruct || (o.target.garrison ? o.target : null);
  if (st && !st.garrison.some(t => g.teamAlive(t) > 0)) st = null;
  if (!st) {
    for (const c of g.structures) {
      if (c.destroyed || !c.known[s.sideIdx] || !c.garrison.some(t => g.teamAlive(t) > 0)) continue;
      if (structCenterDist(c, s.x, s.y) < 18) { st = c; break; }
    }
  }
  if (st && !st.destroyed) {
    const de = structCenterDist(st, s.x, s.y);
    if (de > 15) {
      if (o.kind === 'assault' && o.arrived && !s.task) {
        const a = angleTo(st.x, st.y, s.x, s.y);
        const R = Math.max(st.w, st.h) / 2 + 9;
        s.task = { kind: 'approach', x: st.x + Math.cos(a) * R, y: st.y + Math.sin(a) * R, mode: 'assault' };
      }
      return;
    }
    if (s.fireCD > 0) return;
    if (s.status === 'pinned' && g.rng() < 0.6) { s.fireCD = 1.5; return; }
    const tx = st.x + Math.cos(st.dir) * st.w * 0.4, ty = st.y + Math.sin(st.dir) * st.h * 0.4;
    flameBurst(g, s, inArc(st, s.x, s.y) || de < 6 ? tx : st.x, inArc(st, s.x, s.y) || de < 6 ? ty : st.y);
    const effective = inArc(st, s.x, s.y) || de < 7;
    for (const tm of st.garrison) {
      tm.morale -= effective ? 30 : 6;
      for (const e of tm.soldiers) {
        if (!g.alive(e)) continue;
        e.sup = 100;
        const r = g.rng();
        if (effective) { if (r < 0.5) g.killSoldier(e, s); else if (r < 0.72) g.incap(e, s); }
        else if (r < 0.08) g.killSoldier(e, s);
      }
    }
    if (effective) g.msg(`Flamethrower burns out ${st.name}`, 'good');
    if (st.garrison.every(t => g.teamAlive(t) === 0) && st.type !== 'bombproof' && st.type !== 'command') { st.hp = Math.min(st.hp, st.maxHp * 0.3); g.staticDirty = true; }
    return;
  }
  // flame infantry in the open
  let best = null, bd = w.range;
  g.hash.query(s.x, s.y, w.range, (e) => {
    if (e.sideIdx === s.sideIdx || !g.alive(e) || e.visT[s.sideIdx] < g.time) return;
    const d = dist(s.x, s.y, e.x, e.y); if (d < bd) { bd = d; best = e; }
  });
  if (!best || s.fireCD > 0) return;
  flameBurst(g, s, best.x, best.y);
  g.hash.query(best.x, best.y, 4.5, (e) => {
    if (e.sideIdx === s.sideIdx || !g.alive(e)) return;
    e.sup = 100; const r = g.rng();
    if (r < 0.45) g.killSoldier(e, s); else if (r < 0.7) g.incap(e, s);
  });
}
function flameBurst(g, s, tx, ty) {
  s.ammo--; s.fireCD = s.wpn.rof; s.lastFired = g.time;
  s.dir = angleTo(s.x, s.y, tx, ty);
  g.emit({ t: 'flame', x: s.x + Math.cos(s.dir), y: s.y + Math.sin(s.dir), tx, ty });
  g.sound('flamethrower', s.x, s.y, 1);
  g.fires.push({ x: tx, y: ty, t: 0, life: 10 });
  g.emit({ t: 'decal', k: DK.SCORCH, x: tx, y: ty, r: 4 });
  if (g.rng() < 0.5) g.voice('us_flame_1', s.x, s.y, 'US', { cd: 15 });
  s.fireStance = 1; s.fireStanceT = g.time + 2;
}

// ---------------------------------------------------------------- demolition
function startSatchel(g, s, st) {
  // pick an approach point next to the wall, avoiding the embrasure if possible
  let best = null, bs = Infinity;
  const R = Math.max(st.w, st.h) / 2 + 1.2;
  for (let k = 0; k < 12; k++) {
    const a = k * Math.PI / 6;
    const px = st.x + Math.cos(a) * R, py = st.y + Math.sin(a) * R;
    if (!g.nav.passable(MC.INF, px, py)) continue;
    const sc = Math.hypot(px - s.x, py - s.y) + (Math.abs(normAngle(a - st.dir)) < st.arc ? 60 : 0);
    if (sc < bs) { bs = sc; best = [px, py]; }
  }
  if (!best) return;
  s.task = { kind: 'satchel', st, phase: 'approach', x: best[0], y: best[1], mode: 'assault', t: 0 };
}

function handleTask(g, s, dt) {
  const t = s.task;
  const d = Math.hypot(t.x - s.x, t.y - s.y);
  switch (t.kind) {
    case 'flee': return false;
    case 'approach':
      if (!t.snapped) { t.snapped = true; const p = g.nav.nearestPassable(MC.INF, t.x, t.y, {}, 6); if (p) { t.x = p[0]; t.y = p[1]; } else s.task = null; }
      if (d < 1.5 || (t.age = (t.age || 0) + dt) > 40) { s.task = null; }
      return false;
    case 'pickup':
      if (!t.from || t.from.wpn === s.wpn || t.from.inVeh || (t.age = (t.age || 0) + dt) > 60) { s.task = null; return false; }
      t.x = t.from.x; t.y = t.from.y;
      if (d < 1.4) {
        s.wk = t.from.wk; s.wpn = t.from.wpn; s.ammo = t.from.ammo; s.mag = Math.min(s.wpn.mag || 99, s.ammo);
        s.setupT = 0; t.from.wpn = W.carbine; t.from.wk = 'carbine'; s.task = null;
        g.msg(`${s.rank} ${s.name} takes over the ${s.wpn.name}`, 'info');
      }
      return d >= 1.4 ? false : true;
    case 'treat': {
      const who = t.who;
      if (who.state === 'dead' || who.stable || (who.state === 'ok') || (t.age = (t.age || 0) + dt) > 60) { if (who.medicBy === s) who.medicBy = null; s.task = null; return false; }
      t.x = who.x; t.y = who.y;
      if (d < 1.3) {
        s.stance = 1; t.t = (t.t || 0) + dt;
        if (t.t > 7) {
          if (who.state === 'incap') { who.stable = true; g.msg(`Corpsman ${s.name} stabilises ${who.name}`, 'info'); }
          else who.bandaged = true;
          who.medicBy = null; s.task = null;
        }
        return true;
      }
      return false;
    }
    case 'satchel': {
      const st = t.st;
      if (st.destroyed && t.phase !== 'retreat') { s.task = null; return false; }
      if (t.phase === 'approach') {
        if (d < 1.6) { t.phase = 'plant'; t.t = 0; }
        else if ((t.age = (t.age || 0) + dt) > 60) s.task = null;
        return false;
      }
      if (t.phase === 'plant') {
        s.stance = 1; t.t += dt;
        if (t.t > 2.4) {
          s.satchels--;
          g.projectiles.push({ kind: 'satchel', x0: s.x, y0: s.y, x: s.x, y: s.y, tx: s.x, ty: s.y, t: 0, T: 0, fuse: 6, w: {}, owner: s, side: s.side, st });
          g.voice(g.rng() < 0.5 ? 'us_fireinhole_1' : 'us_demo_1', s.x, s.y, 'US', { cd: 3 });
          g.msg(`${s.name} sets a charge on ${st.name}!`, 'good');
          const a = angleTo(st.x, st.y, s.x, s.y);
          const R = Math.max(st.w, st.h) / 2 + 20;
          const p = g.nav.nearestPassable(MC.INF, st.x + Math.cos(a) * R, st.y + Math.sin(a) * R, {}, 8) || [s.x, s.y];
          t.phase = 'retreat'; t.x = p[0]; t.y = p[1]; t.mode = 'fast';
          // everyone nearby takes cover
          for (const m of s.team.soldiers) if (m !== s && g.alive(m) && Math.hypot(m.x - st.x, m.y - st.y) < 16) {
            const ma = angleTo(st.x, st.y, m.x, m.y);
            m.task = { kind: 'approach', x: st.x + Math.cos(ma) * R, y: st.y + Math.sin(ma) * R, mode: 'fast' };
          }
        }
        return true;
      }
      if (t.phase === 'retreat') { if (d < 2 || (t.rt = (t.rt || 0) + dt) > 20) { s.task = null; s.tx = s.x; s.ty = s.y; s.slotX = s.x; s.slotY = s.y; } return false; }
      return false;
    }
  }
  return false;
}

function medicSearch(g, s) {
  if (((g.time * 2) | 0) % 3 !== s.id % 3) return;
  if (s.status === 'pinned') return;
  let best = null, bd = 45;
  g.hash.query(s.x, s.y, 45, (o) => {
    if (o.sideIdx !== s.sideIdx || o === s) return;
    if (!((o.state === 'incap' && !o.stable) || (o.state === 'wounded' && !o.bandaged))) return;
    const m = o.medicBy;
    if (m && m !== s && g.alive(m) && m.task && m.task.who === o) return;
    const d = dist(s.x, s.y, o.x, o.y) * (o.state === 'incap' ? 0.7 : 1.2) * (o.team === s.team ? 0.7 : 1);
    if (d < bd) { bd = d; best = o; }
  });
  if (best) { best.medicBy = s; s.task = { kind: 'treat', who: best, x: best.x, y: best.y, mode: 'fast' }; }
}

// ---------------------------------------------------------------- vehicle-mounted weapons
// Each mount gets a lightweight "gunner" proxy so it can reuse the infantry fire logic.
export function soldierCombatProxy(g, v, wep, i, dt) {
  const T = g.T, spec = v.spec, w = wep.w;
  let p = wep.proxy;
  if (!p) {
    p = wep.proxy = {
      id: v.id * 10 + i, x: v.x, y: v.y, dir: v.dir, stance: 1, sup: 0, state: 'ok', status: 'ok', exp: 1, moving: false,
      side: v.side, sideIdx: v.sideIdx, team: v.team || { kills: 0, order: v.order, vehicle: v, side: v.side, morale: 80, soldiers: [] },
      wpn: w, wk: wep.k, visT: v.visT, inStruct: null, eyeBonus: 1.2, kills: 0, lastFired: -99, mag: w.mag || 999, ammo: wep.ammo,
      fireCD: g.rng() * 2, burstLeft: 0, burstT: 0, reloadT: 0, targetT: 0, target: null, targetKind: null, name: v.name, vehicle: v,
    };
  }
  p.x = v.x; p.y = v.y; p.moving = v.speed > 0.6;
  const base = T.baseAt(v.x, v.y);
  p.eyeBonus = Math.max(base, T.water) - base + (spec.kind === 'track' ? 1.3 : 0.9);
  const mount = (spec.mounts && spec.mounts[i]) || 'ring';
  const turret = mount === 'turret';
  const hullGun = mount === 'hull';
  const coax = mount === 'coax';
  p.dir = turret || coax ? v.tdir : v.dir;
  if (v.team) {
    let su = 0, n = 0;
    for (const s of v.team.soldiers) if (g.alive(s)) { su += s.sup; n++; }
    if (!n) return;
    p.sup = su / n * 0.4;
  }
  if (p.reloadT > 0) { p.reloadT -= dt; if (p.reloadT <= 0) p.mag = Math.min(w.mag || 999, p.ammo); return; }
  if (p.burstLeft > 0) {
    p.burstT -= dt;
    while (p.burstT <= 0 && p.burstLeft > 0) { fireRound(g, p); p.burstLeft--; p.burstT += w.gap || 0.1; }
    wep.ammo = p.ammo; return;
  }
  p.fireCD -= dt;
  if (p.ammo <= 0 || v.unloadT > 0) return;
  let maxR = w.range;
  if (v.holdRange && !v.sprung) { if (v.hp < v.maxHp) v.sprung = true; else maxR = Math.min(maxR, v.holdRange); }
  if (v.order.kind === 'fast' || v.order.kind === 'retreat') maxR = Math.min(maxR, 80);
  if (v.order.kind === 'ambush') maxR = Math.min(maxR, 120);
  p.targetT -= dt;
  if (p.targetT <= 0 || (p.targetKind && !validTarget(g, p))) { chooseTarget(g, p, maxR); p.targetT = 1 + g.rng(); }
  if (!p.targetKind) { if (turret) v.tdir = turnToward(v.tdir, v.dir, dt * 0.4); return; }
  if (p.fireCD > 0) return;
  const tx = p.targetKind === 'point' ? p.tpx : p.target.x, ty = p.targetKind === 'point' ? p.tpy : p.target.y;
  const want = Math.atan2(ty - v.y, tx - v.x);
  if (turret) {
    v.tdir = turnToward(v.tdir, want, dt * 0.75);
    if (Math.abs(normAngle(want - v.tdir)) > 0.08) return;
    p.dir = v.tdir;
  } else if (coax) {
    if (Math.abs(normAngle(want - v.tdir)) > 0.15) { if (!v.weps[0] || !v.weps[0].proxy || !v.weps[0].proxy.targetKind) v.tdir = turnToward(v.tdir, want, dt * 0.75); return; }
    p.dir = v.tdir;
  } else if (hullGun) { if (Math.abs(normAngle(want - v.dir)) > 0.6) return; p.dir = want; }
  else p.dir = want;
  attemptFire(g, p);
  if (p.targetKind) v.lastFired = g.time;
  wep.ammo = p.ammo;
}
