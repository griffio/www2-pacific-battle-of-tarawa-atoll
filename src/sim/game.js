// Core tactical simulation: teams of soldiers, vehicles, fortifications, spotting, morale, orders.
import { clamp, lerp, dist, dist2, angleTo, normAngle, turnToward, makeRng, SpatialHash, fmtClock } from '../util.js';
import { F } from '../world/terrain.js';
import { STRUCT_SPECS } from '../world/betio.js';
import { W, UNITS, VEH, STANCE_H, US_NAMES, JP_NAMES } from './data.js';
import { Nav, MC } from './nav.js';
import { soldierCombat, updateProjectiles, explode, structCenterDist } from './combat.js';
import { updateVehicle, unloadVehicle } from './vehicles.js';
import { JapaneseCommander } from './ai.js';

export const SIDE = { US: 0, JP: 1 };
const EYE = [1.6, 0.95, 0.36];
let NEXT_ID = 1;

export class Game {
  constructor(map, scenario, opts = {}) {
    this.map = map; this.T = map.terrain; this.sc = scenario;
    this.T.water = scenario.tide ?? this.T.water;   // must precede the nav grid (depth-dependent passability)
    this.nav = new Nav(this.T);
    this.rng = makeRng(opts.seed || 777);
    this.time = 0; this.dt = 1 / 30;
    this.soldiers = []; this.teams = []; this.vehicles = []; this.structures = []; this.positions = [];
    this.projectiles = []; this.smokes = []; this.flares = []; this.vls = []; this.strikes = []; this.fires = [];
    this.fx = []; this.log = [];
    this.hash = new SpatialHash(40, map.w, map.h);
    this.sideList = [[], []];   // alive, dismounted soldiers per side (rebuilt every step)
    this.vhash = new SpatialHash(60, map.w, map.h);
    this.spotIdx = 0;
    this.support = { naval: 0, air: 0, star: 0, ...(scenario.support || {}) };
    this.stats = { usKIA: 0, usWIA: 0, jpKIA: 0, jpWIA: 0, structs: 0, vehLost: 0, jpVehLost: 0 };
    this.ended = false; this.result = null;
    this.light = scenario.light || { ambient: 1, night: 0 };
    this.danger = new Float32Array(this.nav.nx * this.nav.ny); this.dangerT = -99;
    this.wind = [0.6, -0.25];
    this.bounds = scenario.bounds || [0, 0, map.w, map.h];
    this.voiceCD = {};
    this.usedNames = new Set();
    // fortifications from the map
    for (const s of map.structures) {
      const spec = STRUCT_SPECS[s.type];
      this.structures.push({ ...s, spec, hp: spec.hp, maxHp: spec.hp, destroyed: false, garrison: [], known: [true, true], knownT: [0, 0], lastFire: -99, sealed: 0 });
    }
    for (const p of map.positions) this.positions.push({ ...p, occupied: null });
    this.jpAI = new JapaneseCommander(this);
    scenario.setup(this);
    // JP structures are camouflaged: US doesn't know them until spotted
    for (const s of this.structures) {
      if (s.type === 'hulk') continue;
      s.known[0] = !!s.preKnown || s.destroyed;
    }
    this.pendingRebuild = true;
  }

  // ------------------------------------------------------------ helpers
  clock() { return fmtClock(this.sc.startMin || 540, this.time * (this.sc.clockScale || 1)); }
  msg(text, kind = 'info') { this.log.push({ t: this.time, text, kind }); if (this.log.length > 80) this.log.shift(); }
  emit(e) { this.fx.push(e); }
  sound(id, x, y, vol = 1, rate = 1) { this.fx.push({ t: 'sound', id, x, y, vol, rate }); }
  voice(id, x, y, side = 'US', opts = {}) {
    const key = opts.key || id;
    const cd = opts.cd ?? 6;
    if ((this.voiceCD[key] || -99) + cd > this.time) return false;
    this.voiceCD[key] = this.time;
    let tone = opts.tone;
    if (tone === undefined && x !== undefined) {
      // the speaker is the soldier standing at (x, y); their team's situation sets the delivery
      let sp = null;
      this.hash.query(x, y, 1.5, (o) => { if (!sp && o.side === side && this.alive(o)) sp = o; });
      // embarked men are not in the soldier hash: speak with the situation of the boat or amtrac they ride in
      if (!sp) this.vhash.query(x, y, 4, (v) => { if (!sp && v.team && v.team.side === side) sp = v; });
      tone = sp ? this.teamTone(sp.team) : null;
    }
    this.fx.push({ t: 'voice', id, x, y, side, radio: !!opts.radio, prio: opts.prio || 1, tone });
    return true;
  }
  // voice delivery for a team: urgent under fire, cautious when sneaking or lying in ambush, otherwise calm
  teamTone(team) {
    if (!team) return null;
    let n = 0, sup = 0, down = 0;
    for (const s of team.soldiers) if (this.alive(s)) {
      n++; sup += s.sup;
      if (s.status === 'pinned' || s.status === 'cowering' || s.status === 'panicked') down++;
    }
    if (!n) return null;
    if (sup / n >= 30 || down * 2 >= n || (team.ai && team.ai.banzai)) return 'urgent';
    const k = team.order && team.order.kind;
    return k === 'sneak' || k === 'ambush' ? 'cautious' : 'calm';
  }
  radio(id, text) { this.fx.push({ t: 'voice', id, radio: true, prio: 3 }); if (text) this.msg('📻 ' + text, 'radio'); }
  pickName(side) {
    const pool = side === 'US' ? US_NAMES : JP_NAMES;
    for (let k = 0; k < 20; k++) { const n = pool[(this.rng() * pool.length) | 0]; if (!this.usedNames.has(n)) { this.usedNames.add(n); return n; } }
    return pool[(this.rng() * pool.length) | 0];
  }
  baseAt(x, y) { return this.T.baseAt(x, y); }
  eyeOf(s) {
    if (s.inStruct) return this.T.groundAt(s.inStruct.x, s.inStruct.y) + s.inStruct.height - 0.35;
    return this.T.baseAt(s.x, s.y) + EYE[s.stance] + (s.eyeBonus || 0);
  }
  bodyOf(s) {
    if (s.inStruct) { const b = this.T.groundAt(s.x, s.y); return [b, b + s.inStruct.height - 0.2]; }
    const b = this.T.baseAt(s.x, s.y) + (s.eyeBonus || 0);
    return [b, b + STANCE_H[s.stance]];
  }
  alive(s) { return s.state === 'ok' || s.state === 'wounded'; }
  isVisibleTo(e, sideIdx) { return e.visT[sideIdx] > this.time; }
  lightAt(x, y) {
    let l = this.light.ambient;
    for (const f of this.flares) {
      const d = Math.hypot(f.x - x, f.y - y);
      l += f.int * clamp(1 - d / f.r, 0, 1);
    }
    for (const f of this.fires) {
      const d = Math.hypot(f.x - x, f.y - y);
      if (d < 40) l += 0.35 * (1 - d / 40);
    }
    return clamp(l, 0, 1);
  }

  // ------------------------------------------------------------ spawning
  spawnTeam(key, x, y, opts = {}) {
    const def = UNITS[key];
    const side = def.side, sideIdx = SIDE[side];
    const team = {
      id: NEXT_ID++, side, sideIdx, key, def, name: opts.name || def.name, short: def.short, soldiers: [],
      order: { kind: opts.order || 'defend', x, y, facing: opts.facing ?? (side === 'US' ? Math.PI / 2 : -Math.PI / 2) },
      morale: opts.morale ?? def.morale, status: 'Ready', selected: false, ai: opts.ai || {}, vehicle: null, embarked: null,
      struct: null, pos: null, lastVoice: -99, kills: 0, num: opts.num || 0, radio: !!def.radio, smokeN: side === 'US' ? 2 : 0,
      hidden: !!opts.hidden, reinforce: !!opts.reinforce, vlBonus: 0, created: this.time,
    };
    const n = def.men.length;
    const keep = opts.men ? Math.min(opts.men, n) : n;
    for (let i = 0; i < keep; i++) {
      const [rank, role, wk, extra] = def.men[i];
      const wpn = W[wk];
      const a = (i / keep) * Math.PI * 2;
      const r = i === 0 ? 0 : 2.5 + (i % 3);
      const s = {
        id: NEXT_ID++, side, sideIdx, team, rank, role, name: (opts.names && opts.names[i]) || this.pickName(side),
        wk, wpn, ammo: wpn.ammo, mag: wpn.mag || 99, grenades: side === 'US' ? (role === 'gunner' || role === 'radio' ? 1 : 2) : (role === 'knee' ? 1 : 2),
        satchels: (extra && extra.satchels) || 0,
        x: x + Math.cos(a) * r, y: y + Math.sin(a) * r, px: 0, py: 0, dir: team.order.facing, stance: 1, wantStance: 1,
        state: 'ok', sup: 0, stamina: 100, fireCD: this.rng() * 2, burstLeft: 0, burstT: 0, reloadT: 0, target: null, targetT: 0, targetKind: null,
        setupT: wpn.setup ? wpn.setup : 0, moving: false, tx: x, ty: y, task: null, inVeh: null, inStruct: null, eyeBonus: 0,
        visT: [side === 'US' ? 1e9 : 0, side === 'JP' ? 1e9 : 0], lastSeen: [0, 0], spotAcc: [0, 0], spotRollT: [-9, -9], spotBy: [null, null],
        lastFired: -99, lastHitT: -99, kills: 0, status: 'ok',
        grenCD: 3 + this.rng() * 4, deathT: 0, bleedT: 0, wounds: 0, stable: false, slotX: x, slotY: y, anim: this.rng() * 10, idx: i,
        ghostX: 0, ghostY: 0, panicT: 0, berserk: false, exp: opts.exp ?? 1,
      };
      if (opts.leaderName && i === 0) s.name = opts.leaderName;
      if (opts.leaderRank && i === 0) s.rank = opts.leaderRank;
      s.px = s.x; s.py = s.y;
      // keep soldiers on passable ground
      if (this.nav.cost(MC.INF, this.nav.idx(s.x, s.y), {}) === 0) { s.x = x; s.y = y; s.px = x; s.py = y; }
      team.soldiers.push(s); this.soldiers.push(s);
    }
    this.teams.push(team);
    if (opts.stance !== undefined) for (const s of team.soldiers) { s.stance = s.wantStance = opts.stance; }
    return team;
  }

  spawnVehicle(type, side, x, y, dir, opts = {}) {
    const spec = VEH[type];
    const v = {
      id: NEXT_ID++, type, spec, side, sideIdx: SIDE[side], x, y, px: x, py: y, dir, tdir: dir, speed: 0, hp: spec.hp, maxHp: spec.hp,
      state: 'ok', cargo: [], cargoVeh: null, path: null, pathI: 0, order: { kind: 'stop' }, grounded: false, ramp: 0, unloadT: 0,
      weps: spec.weps.map(k => ({ k, w: W[k], cd: this.rng() * 2, ammo: W[k].ammo, burstLeft: 0, burstT: 0, target: null, targetT: 0 })),
      visT: [side === 'US' ? 1e9 : 0, side === 'JP' ? 1e9 : 0], lastSeen: [0, 0], spotAcc: [0, 0], spotRollT: [-9, -9], spotBy: [null, null], lastFired: -99, name: opts.name || spec.name,
      burnT: 0, wake: 0, immobile: false, team: null, autoUnload: opts.autoUnload ?? true, beachTarget: opts.beachTarget || null, carried: false, sinking: 0, ghostX: 0, ghostY: 0,
    };
    if (spec.crew) {
      const t = this.spawnTeam(spec.crew, x, y, { name: opts.name || spec.name, order: 'stop', morale: opts.morale });
      t.vehicle = v; v.team = t;
      for (const s of t.soldiers) { s.inVeh = v; s.x = x; s.y = y; }
    }
    this.vehicles.push(v);
    return v;
  }
  embark(team, v) {
    team.embarked = v; v.cargo.push(team);
    for (const s of team.soldiers) { s.inVeh = v; s.x = v.x; s.y = v.y; s.px = v.x; s.py = v.y; }
  }
  garrison(team, st) {
    team.struct = st; st.garrison.push(team);
    team.order = { kind: 'defend', x: st.x, y: st.y, facing: st.dir };
    const n = team.soldiers.length;
    team.soldiers.forEach((s, i) => {
      s.inStruct = st;
      const a = st.rot - Math.PI / 2;
      const u = (i / Math.max(1, n - 1) - 0.5) * st.w * 0.5, v = ((i % 2) - 0.5) * st.h * 0.3;
      s.x = st.x + Math.cos(a) * v - Math.sin(a) * u; s.y = st.y + Math.sin(a) * v + Math.cos(a) * u;
      s.px = s.x; s.py = s.y; s.dir = st.dir; s.stance = s.wantStance = 1;
      if (s.wpn.setup) s.setupT = s.wpn.setup;
    });
  }
  leaveStruct(team) {
    const st = team.struct;
    if (!st) return;
    const i = st.garrison.indexOf(team);
    if (i >= 0) st.garrison.splice(i, 1);
    team.struct = null;
    for (const s of team.soldiers) s.inStruct = null;
  }
  occupy(team, pos, stance = 2) {
    team.pos = pos; pos.occupied = team;
    team.order = { kind: 'defend', x: pos.x, y: pos.y, facing: pos.dir };
    const n = team.soldiers.length;
    const perp = pos.dir + Math.PI / 2;
    team.soldiers.forEach((s, i) => {
      let ox, oy;
      if (pos.type === 'mgnest' || pos.type === 'gunpit') {
        const a = (i / n) * Math.PI * 2; const r = i === 0 ? 0 : (pos.type === 'gunpit' ? 3 : 1.6);
        ox = Math.cos(a) * r; oy = Math.sin(a) * r;
      } else {
        const k = (i % 2 ? 1 : -1) * Math.ceil(i / 2);
        ox = Math.cos(perp) * k * 3.2; oy = Math.sin(perp) * k * 3.2;
      }
      s.x = pos.x + ox; s.y = pos.y + oy;
      const p = this.nav.nearestPassable(MC.INF, s.x, s.y, {}, 4);
      if (p) { s.x = p[0]; s.y = p[1]; }
      s.px = s.x; s.py = s.y; s.dir = pos.dir; s.stance = s.wantStance = stance;
      s.slotX = s.x; s.slotY = s.y; s.tx = s.x; s.ty = s.y;
      if (s.wpn.setup) s.setupT = s.wpn.setup;
    });
  }
  placeVL(name, x, y, r, value, owner = 'JP') {
    this.vls.push({ name, x, y, r, value, owner, prog: 0, contested: false });
  }

  // ------------------------------------------------------------ orders
  canOrder(team) { return team.side === 'US' && !team.embarked && this.teamAlive(team) > 0; }
  teamAlive(team) { let n = 0; for (const s of team.soldiers) if (this.alive(s)) n++; return n; }
  teamCenter(team) {
    if (team.vehicle) return [team.vehicle.x, team.vehicle.y];
    if (team.embarked) return [team.embarked.x, team.embarked.y];
    let x = 0, y = 0, n = 0;
    for (const s of team.soldiers) if (this.alive(s)) { x += s.x; y += s.y; n++; }
    if (!n) { const s = team.soldiers[0]; return [s.x, s.y]; }
    return [x / n, y / n];
  }
  leader(team) { for (const s of team.soldiers) if (this.alive(s)) return s; return null; }
  hasAssault(team) { return team.soldiers.some(s => this.alive(s) && (s.wk === 'flamer' || s.satchels > 0)); }

  order(team, kind, x, y, target = null, opts = {}) {
    if (team.vehicle) return this.orderVehicle(team.vehicle, kind, x, y, target, opts);
    if (team.embarked) {
      if (kind === 'unload') return unloadVehicle(this, team.embarked);
      return this.orderVehicle(team.embarked, kind, x, y, target, opts);
    }
    if (team.struct && kind !== 'fire' && kind !== 'stop' && kind !== 'defend' && kind !== 'ambush') this.leaveStruct(team);
    if (team.pos && kind !== 'fire' && kind !== 'defend' && kind !== 'ambush') { if (team.pos.occupied === team) team.pos.occupied = null; team.pos = null; }
    const [cx, cy] = this.teamCenter(team);
    const o = { kind, x, y, target, facing: opts.facing, path: null, pathS: 0, len: 0, arrived: false, issued: this.time, waypoints: opts.waypoints || null };
    if (kind === 'move' || kind === 'fast' || kind === 'sneak' || kind === 'assault' || kind === 'retreat') {
      let tx = x, ty = y;
      if (kind === 'assault' && target) { [tx, ty] = this.assaultPoint(team, target); o.target = target; }
      const danger = team.side === 'US' && kind !== 'fast' ? this.getDanger() : null;
      const path = this.nav.find(MC.INF, cx, cy, tx, ty, { danger, dangerW: kind === 'sneak' ? 6 : kind === 'assault' || kind === 'retreat' ? 5 : 2.5 });
      if (!path || path.length < 1) { this.msg(`${team.name}: no route`, 'warn'); return false; }
      path.unshift([cx, cy]);
      o.path = path; o.cum = [0];
      for (let i = 1; i < path.length; i++) o.cum.push(o.cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
      o.len = o.cum[o.cum.length - 1];
      const last = path[path.length - 1], prev = path[Math.max(0, path.length - 2)];
      o.dir = Math.atan2(last[1] - prev[1], last[0] - prev[0]);
      if (o.facing === undefined) o.facing = o.len > 2 ? o.dir : team.order.facing;
      if (opts.facing === undefined && kind === 'assault' && target) o.facing = angleTo(last[0], last[1], target.x, target.y);
      for (const s of team.soldiers) {
        if (s.task && !(s.task.kind === 'satchel' && s.task.phase !== 'approach')) { if (s.task.who && s.task.who.medicBy === s) s.task.who.medicBy = null; s.task = null; }
        s.target = null; s.targetKind = null;
      }
    } else if (kind === 'fire' || kind === 'smoke') {
      o.facing = angleTo(cx, cy, x, y);
    } else if (kind === 'defend' || kind === 'ambush' || kind === 'stop') {
      o.facing = opts.facing ?? team.order.facing ?? 0;
      if (kind === 'stop') { o.kind = 'defend'; o.stopped = true; }
      for (const s of team.soldiers) { if (this.alive(s)) { s.tx = s.x; s.ty = s.y; s.slotX = s.x; s.slotY = s.y; } s.target = null; s.targetKind = null; s.burstLeft = 0; }
    }
    team.order = o;
    team.status = kind === 'fire' ? 'Firing' : kind === 'smoke' ? 'Smoke' : kind === 'defend' ? 'Defending' : kind === 'ambush' ? 'Ambush' : 'Moving';
    return true;
  }
  assaultPoint(team, target) {
    // approach a fortification from outside its embrasure arc where possible
    const st = target.inStruct || (target.spec ? target : null);
    if (!st) return [target.x, target.y];
    const [cx, cy] = this.teamCenter(team);
    let best = null, bs = Infinity;
    const R = Math.max(st.w, st.h) / 2 + 3;
    for (let k = 0; k < 16; k++) {
      const a = k * Math.PI / 8;
      const px = st.x + Math.cos(a) * R, py = st.y + Math.sin(a) * R;
      if (!this.nav.passable(MC.INF, px, py)) continue;
      const rel = Math.abs(normAngle(a - st.dir));
      const inArc = rel < st.arc;
      const score = Math.hypot(px - cx, py - cy) * 0.5 + (inArc ? 300 : 0) + (rel < st.arc + 0.4 ? 60 : 0);
      if (score < bs) { bs = score; best = [px, py]; }
    }
    return best || [st.x, st.y];
  }
  orderVehicle(v, kind, x, y, target, opts = {}) {
    if (v.state === 'destroyed') return false;
    if (kind === 'unload') { unloadVehicle(this, v); return true; }
    const spec = v.spec;
    if (kind === 'move' || kind === 'fast' || kind === 'sneak' || kind === 'assault' || kind === 'retreat') {
      const cls = spec.kind === 'boat' ? MC.BOAT : spec.kind === 'amph' ? MC.AMPH : MC.TRACK;
      if (v.immobile || v.grounded) { this.msg(`${v.name} cannot move`, 'warn'); return false; }
      let path = this.nav.find(cls, v.x, v.y, x, y, { draft: spec.draft, wade: spec.wade });
      if (!path && cls === MC.BOAT) {
        // run in as far as the water allows (boats ground on the reef)
        const d = Math.hypot(x - v.x, y - v.y), o = { draft: spec.draft };
        let lx = null, ly = null;
        for (let k = 4; k < d; k += 4) {
          const px = v.x + (x - v.x) * k / d, py = v.y + (y - v.y) * k / d;
          if (!this.nav.passable(MC.BOAT, px, py, o)) break;
          lx = px; ly = py;
        }
        if (lx !== null) { path = [[lx, ly]]; path.partial = true; }
      }
      if (!path) { this.msg(`${v.name}: no route`, 'warn'); return false; }
      if (path.partial && spec.kind === 'amph') this.msg(`${v.name}: seawall blocks — will stop at the beach`, 'warn');
      v.path = path; v.pathI = 0; v.order = { kind, x, y, issued: this.time };
    } else if (kind === 'fire') {
      v.order = { kind: 'fire', x, y, target, issued: this.time };
      v.path = null;
    } else {
      v.path = null; v.order = { kind: kind === 'stop' ? 'stop' : kind, x, y, issued: this.time };
    }
    return true;
  }

  // ------------------------------------------------------------ danger map (known enemy weapons)
  getDanger() {
    if (this.time - this.dangerT < 4) return this.danger;
    this.dangerT = this.time;
    const D = this.danger; D.fill(0);
    const nav = this.nav, c = nav.cell;
    const addArc = (x, y, dir, arc, range, w) => {
      const R = Math.min(range, 300), R2 = R * R, invR = 1 / R;
      const cd = Math.cos(dir), sd = Math.sin(dir), ca = arc < 3 ? Math.cos(arc) : -2;
      const x0 = Math.max(0, ((x - R) / c) | 0), x1 = Math.min(nav.nx - 1, ((x + R) / c) | 0);
      const y0 = Math.max(0, ((y - R) / c) | 0), y1 = Math.min(nav.ny - 1, ((y + R) / c) | 0);
      for (let cy = y0; cy <= y1; cy++) {
        const py = (cy + 0.5) * c - y, row = cy * nav.nx;
        for (let cx = x0; cx <= x1; cx++) {
          const px = (cx + 0.5) * c - x;
          const d2 = px * px + py * py;
          if (d2 > R2 || d2 < 36) continue;
          const d = Math.sqrt(d2);
          if (px * cd + py * sd < d * ca) continue;   // outside the firing arc
          D[row + cx] += w * (1 - d * invR);
        }
      }
    };
    for (const st of this.structures) {
      if (st.destroyed || !st.known[0] || !st.garrison.some(t => this.teamAlive(t) > 0)) continue;
      addArc(st.x, st.y, st.dir, st.arc, 400, 3);
    }
    for (const s of this.soldiers) {
      if (s.side !== 'JP' || !this.alive(s) || s.inStruct) continue;
      if (s.visT[0] < this.time - 20) continue;
      const cls = s.wpn.cls;
      if (cls === 'mg' || cls === 'hmg' || cls === 'auto') addArc(s.x, s.y, s.dir, 1.2, s.wpn.eff, cls === 'auto' ? 1 : 2);
    }
    return D;
  }

  // ------------------------------------------------------------ main step
  step(dt) {
    if (this.ended) return;
    this.time += dt;
    const T = this.T;
    if (T.navRect) this.nav.build(T.navRect);   // craters and wrecks since the last step change passability
    // spatial hashes
    this.hash.clear(); this.vhash.clear();
    const L0 = this.sideList[0], L1 = this.sideList[1];
    L0.length = 0; L1.length = 0;
    for (const s of this.soldiers) {
      s.px = s.x; s.py = s.y;
      if (s.state === 'dead' || s.inVeh) continue;
      this.hash.insert(s, s.x, s.y);
      if (s.state !== 'incap') (s.sideIdx ? L1 : L0).push(s);
    }
    for (const v of this.vehicles) { v.px = v.x; v.py = v.y; if (v.state !== 'destroyed') this.vhash.insert(v, v.x, v.y); }

    // spotting (round robin, every team ~ every 0.5 s)
    const nT = this.teams.length;
    if (nT) {
      const per = Math.max(1, Math.ceil(nT * dt / 0.5));
      this.losBudget = 900;
      for (let k = 0; k < per && this.losBudget > 0; k++) { this.spotTeam(this.teams[this.spotIdx % nT]); this.spotIdx++; }
    }
    // teams
    for (const t of this.teams) this.updateTeam(t, dt);
    // soldiers
    for (const s of this.soldiers) {
      if (s.state === 'dead') continue;
      this.updateSoldier(s, dt);
    }
    for (const v of this.vehicles) updateVehicle(this, v, dt);
    updateProjectiles(this, dt);
    // smoke & flares
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const m = this.smokes[i];
      m.t += dt; m.x += this.wind[0] * dt * 0.6; m.y += this.wind[1] * dt * 0.6;
      m.r = Math.min(m.rMax, m.r + dt * 2.2);
      if (m.t > m.life) this.smokes.splice(i, 1);
    }
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i]; f.t += dt; f.x += this.wind[0] * dt * 1.5; f.y += this.wind[1] * dt * 1.5;
      f.int = f.t < 2 ? f.t / 2 : f.t > f.life - 5 ? Math.max(0, (f.life - f.t) / 5) : 1;
      f.int *= 0.9;
      if (f.t > f.life) this.flares.splice(i, 1);
    }
    for (let i = this.fires.length - 1; i >= 0; i--) { const f = this.fires[i]; f.t += dt; if (f.t > f.life) this.fires.splice(i, 1); }
    // fire support strikes
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const st = this.strikes[i];
      if (this.time >= st.t) { st.fn(this); this.strikes.splice(i, 1); }
    }
    // VLs
    if (((this.time * 2) | 0) !== (((this.time - dt) * 2) | 0)) this.updateVLs(1 / 2);
    this.jpAI.update(dt);
    if (this.sc.update) this.sc.update(this, dt);
    // night → dawn transitions
    if (this.sc.lightCurve) this.light = this.sc.lightCurve(this.time);
    this.checkEnd();
  }

  // ------------------------------------------------------------ spotting
  spotTeam(team) {
    const si = team.sideIdx, ei = 1 - si;
    const eyes = [];
    if (team.vehicle) {
      const v = team.vehicle;
      if (v.state === 'destroyed') return;
      eyes.push([v.x, v.y, this.T.baseAt(v.x, v.y) + 2.4, 1.0]);
    } else if (team.embarked) {
      const v = team.embarked;
      if (v.team && this.teamAlive(v.team) > 0) return;   // the crew keeps watch for everyone aboard
      eyes.push([v.x, v.y, Math.max(this.T.water, this.T.baseAt(v.x, v.y)) + 2, 0.6]);
    } else {
      for (const s of team.soldiers) {
        if (!this.alive(s)) continue;
        const q = (s.status === 'cowering' || s.status === 'panicked') ? 0.3 : s.status === 'pinned' ? 0.6 : 1;
        eyes.push([s.x, s.y, this.eyeOf(s), q, s]);
        if (eyes.length >= 4) break;
      }
    }
    if (!eyes.length) return;
    const [cx, cy] = [eyes[0][0], eyes[0][1]];
    const night = this.light.night || 0;
    const R = lerp(900, 230, night);
    const now = this.time;
    const far = (team.spotTick = (team.spotTick || 0) + 1) & 1;
    const R2 = R * R;
    const check = (e, isVeh) => {
      if (e.visT[si] > now + 1.2) return;
      const ddx = e.x - cx, ddy = e.y - cy, d2 = ddx * ddx + ddy * ddy;
      if (d2 > R2) return;
      // distant contacts are re-checked every other cycle, and by fewer pairs of eyes
      if (d2 > 160000 && far && e.visT[si] < now - 6) return;
      const nEyes = d2 > 22500 ? Math.min(2, eyes.length) : eyes.length;
      let bBase, bTop, ign = 0.9, firing = now - e.lastFired < 3;
      const still = isVeh ? e.speed <= 0.5 && e.spec.kind !== 'boat' : !e.moving;   // a boat on the open reef never hides
      if (isVeh) { bBase = Math.max(this.T.water, this.T.baseAt(e.x, e.y)); bTop = bBase + (e.spec.kind === 'boat' ? 1.8 : 2.4); ign = 3; }
      else { [bBase, bTop] = this.bodyOf(e); if (e.inStruct) ign = Math.max(e.inStruct.w, e.inStruct.h) / 2 + 0.5; }
      let best = 0;
      for (let ei2 = 0; ei2 < nEyes; ei2++) {
        const eye = eyes[ei2];
        const ex = eye[0], ey = eye[1], eh = eye[2], q = eye[3];
        const d = Math.hypot(e.x - ex, e.y - ey);
        if (d > R) continue;
        const L = this.T.los(ex, ey, eh, e.x, e.y, bBase, bTop, 0.9, ign);
        this.losBudget--;
        if (L.frac <= 0.02) continue;
        let conceal = L.conceal + this.smokeConceal(ex, ey, e.x, e.y);
        let p = clamp(1.15 - d / R, 0.04, 1) * q;
        p *= Math.pow(L.frac, 0.6) * Math.exp(-conceal * 1.6);
        if (!isVeh) {
          p *= [1, 0.7, 0.45][e.stance];
          if (e.moving) p *= 1.6;
          if (e.inStruct) p *= firing && d < 350 ? 0.6 : d < 40 ? 0.5 : 0.04;
          if (e.eyeBonus && !firing) p *= 0.2;
          if (e.team.hidden && !firing && d > 60) p *= 0.2;
        } else {
          p *= (!still || firing) ? 2.5 : 1;
          if (e.holdRange && !e.sprung && !firing && d > 60) p *= 0.2;   // tank lying in ambush, engine off
        }
        if (firing) p *= 3;
        else if (still && d > 60) p *= clamp(1.3 - d / 250, 0.1, 1);   // a still, silent target fades with distance
        if (night) { const l = this.lightAt(e.x, e.y); p *= lerp(1, l, night) + (firing ? 0.5 : 0); if (d > 60 && l < 0.3 && !firing) p *= 0.3; }
        if (d < 25) p = Math.max(p, L.frac > 0.2 ? 0.8 : 0.2);
        best = Math.max(best, p);
        if (best > 0.95) break;
      }
      // one roll per target every 0.5 s against its best observer, so a side with many teams looking does not
      // multiply its chances (every team used to roll independently)
      if (best > e.spotAcc[si]) { e.spotAcc[si] = best; e.spotBy[si] = team; }
      if (now - e.spotRollT[si] < 0.5) return;
      e.spotRollT[si] = now;
      const chance = e.spotAcc[si], by = e.spotBy[si] || team;
      e.spotAcc[si] = 0; e.spotBy[si] = null;
      if (chance > 0 && this.rng() < chance) {
        const was = e.visT[si] > now;
        e.visT[si] = now + 3.5;
        e.lastSeen[si] = now;
        e.ghostX = e.x; e.ghostY = e.y;
        if (!was) this.onSpotted(by, e, isVeh);
      }
    };
    const foes = this.sideList[ei];
    for (let i = 0; i < foes.length; i++) check(foes[i], false);
    for (const v of this.vehicles) if (v.sideIdx === ei && v.state !== 'destroyed' && !v.carried) check(v, true);
    // fortifications
    if (si === 0) for (const st of this.structures) {
      if (st.known[0] || st.destroyed) continue;
      const d = Math.hypot(st.x - cx, st.y - cy);
      const firing = now - st.lastFire < 3;
      if (d < 60 || (firing && d < 450 && this.rng() < 0.25) || (d < 160 && this.rng() < 0.04)) {
        st.known[0] = true;
        this.msg(`Spotted: ${st.name}`, 'spot');
        const s0 = this.leader(team);
        if (s0 && team.side === 'US') this.voice('us_pillbox_1', s0.x, s0.y, 'US', { cd: 20, key: 'pillbox' });
      }
    }
  }
  onSpotted(team, e, isVeh) {
    if (team.side !== 'US') return;
    const s0 = this.leader(team);
    if (!s0) return;
    if (isVeh) { if (e.spec.kind === 'track') { this.voice('us_tank_1', s0.x, s0.y, 'US', { cd: 30 }); this.msg('Enemy tank spotted!', 'warn'); } return; }
    if (e.eyeBonus) { this.voice('us_sniper_1', s0.x, s0.y, 'US', { cd: 40 }); return; }
    const cls = e.wpn.cls;
    if (cls === 'mg' || cls === 'hmg') this.voice('us_mg_1', s0.x, s0.y, 'US', { cd: 25 });
    else this.voice('us_spotted_1', s0.x, s0.y, 'US', { cd: 30 });
  }
  smokeConceal(ax, ay, bx, by) {
    if (!this.smokes.length) return 0;
    let c = 0;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
    for (const m of this.smokes) {
      let t = ((m.x - ax) * dx + (m.y - ay) * dy) / L2; t = clamp(t, 0, 1);
      const px = ax + dx * t - m.x, py = ay + dy * t - m.y;
      const d2 = px * px + py * py;
      if (d2 < m.r * m.r) {
        const chord = 2 * Math.sqrt(m.r * m.r - d2);
        const fade = m.t < 3 ? m.t / 3 : m.t > m.life - 10 ? (m.life - m.t) / 10 : 1;
        c += chord * 0.22 * fade;
      }
    }
    return c;
  }

  // ------------------------------------------------------------ teams
  updateTeam(team, dt) {
    if (team.vehicle || team.embarked) {
      team.status = team.embarked ? 'Embarked' : team.vehicle.state === 'destroyed' ? 'Knocked out' : team.vehicle.crewDead ? 'Crew lost' : team.vehicle.grounded ? 'Grounded' : team.vehicle.path ? 'Moving' : 'Ready';
      return;
    }
    let alive = 0, pinned = 0, cower = 0, panic = 0, supSum = 0;
    for (const s of team.soldiers) {
      if (!this.alive(s)) continue;
      alive++; supSum += s.sup;
      if (s.status === 'pinned') pinned++;
      if (s.status === 'cowering') { cower++; pinned++; }
      if (s.status === 'panicked') panic++;
    }
    if (!alive) {
      team.status = 'Eliminated';
      if (team.pos) { if (team.pos.occupied === team) team.pos.occupied = null; team.pos = null; }
      if (team.ai.claim) { if (team.ai.claim.occupied === team) team.ai.claim.occupied = null; team.ai.claim = null; }
      return;
    }
    if (team.morale < 0) team.morale = 0;
    const avgSup = supSum / alive;
    // morale recovery
    const leader = this.leader(team);
    const lead = leader && leader.idx === 0 ? 1 : 0.5;
    if (avgSup < 20) team.morale = Math.min(team.def.morale + 10, team.morale + dt * 0.5 * lead);
    else team.morale = Math.max(0, team.morale - dt * avgSup * 0.006);
    if (team.side === 'JP' && team.ai.banzai) team.morale = Math.max(team.morale, 40);

    const o = team.order;
    const moving = o.path && !o.arrived;
    if (moving) {
      const halted = pinned + panic > alive / 2;
      if (halted) {
        team.status = cower > alive / 2 ? 'Cowering' : panic > alive / 2 ? 'Panicked' : 'Pinned';
        if (team.side === 'US' && this.time - team.lastVoice > 25) {
          team.lastVoice = this.time;
          if (leader) this.voice(this.rng() < 0.5 ? 'us_pinned_1' : 'us_pinned_2', leader.x, leader.y, 'US', { cd: 10, key: 'pinned' });
        }
      } else {
        const sp = this.teamSpeed(team, o.kind);
        // cohesion: wait for laggards
        let lag = 0;
        for (const s of team.soldiers) if (this.alive(s) && s.status !== 'pinned' && s.status !== 'cowering' && !s.task) lag = Math.max(lag, Math.hypot(s.tx - s.x, s.ty - s.y));
        const k = lag > 14 ? 0.15 : lag > 8 ? 0.6 : 1;
        o.pathS = Math.min(o.len, o.pathS + sp * dt * k);
        team.status = o.kind === 'fast' ? 'Running' : o.kind === 'sneak' ? 'Sneaking' : o.kind === 'assault' ? 'Assaulting' : o.kind === 'retreat' ? 'Retreating' : 'Moving';
        if (o.pathS >= o.len - 0.01) this.arrive(team);
      }
      // per-soldier follow points
      let rankI = 0;
      for (const s of team.soldiers) {
        if (!this.alive(s) || s.task) continue;
        const back = rankI * 2.3;
        const S = Math.max(0, o.pathS - back);
        const [px, py, ang] = this.pathPoint(o, S);
        const lat = rankI === 0 ? 0 : ((rankI % 3) - 1) * 2.2 + (rankI % 2 ? 0.6 : -0.6);
        let tx = px - Math.sin(ang) * lat, ty = py + Math.cos(ang) * lat;
        if (!this.nav.passable(MC.INF, tx, ty)) { tx = px; ty = py; }
        if (!o.arrived) { s.tx = tx; s.ty = ty; }
        rankI++;
      }
    } else {
      // stationary statuses
      if (cower > alive / 2) team.status = 'Cowering';
      else if (panic > alive / 2) team.status = 'Panicked';
      else if (pinned > alive / 2) team.status = 'Pinned';
      else if (o.kind === 'fire') team.status = 'Firing';
      else if (team.soldiers.some(s => this.alive(s) && s.task && s.task.kind === 'satchel')) team.status = 'Demolition';
      else if (o.kind === 'ambush') team.status = 'Ambush';
      else if (team.soldiers.some(s => this.alive(s) && s.burstLeft > 0)) team.status = 'Firing';
      else team.status = o.stopped ? 'Ready' : 'Defending';
      if (o.kind === 'assault' && o.arrived) team.status = 'Assaulting';
    }
    // morale break
    if (team.morale < 18 && team.side === 'US' && avgSup > 40 && this.rng() < dt * 0.05) {
      for (const s of team.soldiers) if (this.alive(s) && s.sup > 50) s.panicT = 8 + this.rng() * 8;
    }
  }
  teamSpeed(team, kind) {
    let min = 9;
    for (const s of team.soldiers) {
      if (!this.alive(s) || s.task || s.status === 'pinned' || s.status === 'cowering') continue;
      min = Math.min(min, this.soldierSpeed(s, kind));
    }
    return min === 9 ? 0 : min * 0.92;
  }
  soldierSpeed(s, kind) {
    const T = this.T;
    const depth = T.depthAt(s.x, s.y);
    let v = kind === 'fast' || kind === 'retreat' ? (s.stamina > 20 ? 3.1 : 1.9) : kind === 'sneak' ? 0.5 : kind === 'assault' ? 2.0 : 1.4;
    if (s.berserk) v = 3.0;
    if (depth > 0.15) v = Math.min(v, clamp(1.4 - depth * 0.6, 0.35, 1.3));
    const fl = T.flagsAt(s.x, s.y);
    if (fl & F.WIRE) v *= 0.3;
    if (fl & F.SEAWALL) v *= 0.45;
    v *= 1 - T.vegAt(s.x, s.y) * 0.35;
    if (s.state === 'wounded') v *= 0.6;
    if (s.wpn.crew && s.wpn.setup) v *= 0.85;
    if (s.sup > 35) v *= 0.75;
    return v;
  }
  pathPoint(o, S) {
    const cum = o.cum, p = o.path;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < S) i++;
    const a = p[i - 1], b = p[i];
    const L = cum[i] - cum[i - 1] || 1;
    const t = clamp((S - cum[i - 1]) / L, 0, 1);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, Math.atan2(b[1] - a[1], b[0] - a[0])];
  }
  arrive(team) {
    const o = team.order;
    o.arrived = true;
    const end = o.path[o.path.length - 1];
    const facing = o.facing ?? o.dir;
    const threat = [end[0] + Math.cos(facing) * 60, end[1] + Math.sin(facing) * 60];
    const perp = facing + Math.PI / 2;
    const alive = team.soldiers.filter(s => this.alive(s) && !s.task);
    const spacing = alive.length > 6 ? 3.0 : 3.5;
    alive.forEach((s, i) => {
      const row = Math.floor(i / 6), col = i % 6;
      const k = (col % 2 ? 1 : -1) * Math.ceil(col / 2);
      let sx = end[0] + Math.cos(perp) * k * spacing - Math.cos(facing) * row * 3.5;
      let sy = end[1] + Math.sin(perp) * k * spacing - Math.sin(facing) * row * 3.5;
      const c = this.findCover(sx, sy, threat[0], threat[1], 4.5);
      s.tx = s.slotX = c[0]; s.ty = s.slotY = c[1];
    });
    if (o.kind === 'assault') { /* keep order, combat module drives the close assault */ }
    else if (o.kind !== 'fire') {
      team.order = { kind: o.kind === 'sneak' ? 'ambush' : 'defend', x: end[0], y: end[1], facing, arrivedFrom: o.kind };
      if (o.waypoints && o.waypoints.length) { const w = o.waypoints.shift(); this.order(team, w.kind, w.x, w.y, null, { waypoints: o.waypoints }); }
    }
  }
  findCover(x, y, tx, ty, r) {
    const T = this.T;
    let best = [x, y], bs = -1e9;
    for (let k = 0; k < 13; k++) {
      const a = k * 2.399, rr = k === 0 ? 0 : r * Math.sqrt(k / 12);
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      if (!this.nav.passable(MC.INF, px, py)) continue;
      const depth = T.depthAt(px, py);
      const cov = Math.min(T.coverToward(px, py, tx, ty), 1.6);
      const score = cov * 3 - rr * 0.25 - (depth > 0 ? depth * 3 : 0) - (T.flagsAt(px, py) & F.WIRE ? 4 : 0);
      if (score > bs) { bs = score; best = [px, py]; }
    }
    return best;
  }

  // ------------------------------------------------------------ soldiers
  updateSoldier(s, dt) {
    if (s.state === 'incap') {
      if (!s.stable) { s.bleedT -= dt; if (s.bleedT <= 0) this.killSoldier(s, null, true); }
      return;
    }
    if (s.inVeh) {
      const v = s.inVeh; s.x = v.x; s.y = v.y; s.sup = Math.max(0, s.sup - dt * 6);
      return;
    }
    const T = this.T, team = s.team;
    s.anim += dt;
    // suppression decay & status
    const cover = s.inStruct ? 1 : s.stance === 2 ? 1.25 : 1;
    s.sup = Math.max(0, s.sup - dt * (7 + cover * 3 + (team.morale > 60 ? 2 : 0)));
    s.stamina = Math.min(100, s.stamina + dt * 3);
    s.grenCD -= dt;
    if (s.panicT > 0) s.panicT -= dt;
    const oldStatus = s.status;
    if (s.berserk) s.status = 'berserk';
    else if (s.panicT > 0) s.status = 'panicked';
    else if (s.sup >= 88) s.status = 'cowering';
    else if (s.sup >= 62) s.status = 'pinned';
    else if (s.sup >= 32) s.status = 'suppressed';
    else s.status = 'ok';
    if (s.side === 'JP' && s.sup >= 62 && team.morale < 22 && !s.inStruct && this.rng() < dt * 0.02) { s.berserk = true; team.ai.banzai = true; }

    // ---- movement target selection
    let mode = team.order.kind;
    if (s.status === 'panicked' && s.side === 'US') {
      if (!s.task || s.task.kind !== 'flee') {
        const th = this.threatDir(s);
        const fx = s.x - Math.cos(th) * 30, fy = s.y - Math.sin(th) * 30;
        const c = this.findCover(fx, fy, s.x + Math.cos(th) * 50, s.y + Math.sin(th) * 50, 10);
        s.task = { kind: 'flee', x: c[0], y: c[1] };
        if (this.rng() < 0.3) this.voice('us_panic_1', s.x, s.y, 'US', { cd: 12 });
      }
      mode = 'fast';
    } else if (s.task && s.task.kind === 'flee') { s.task = null; s.tx = s.slotX; s.ty = s.slotY; }

    let tx = s.tx, ty = s.ty;
    if (s.task) {
      tx = s.task.x; ty = s.task.y;
      if (s.task.kind === 'flee') mode = 'fast';
      else if (s.task.mode) mode = s.task.mode;
    }
    const canMove = !s.inStruct && s.status !== 'pinned' && s.status !== 'cowering' && !(s.wpn.setup && s.burstLeft > 0);
    const dx = tx - s.x, dy = ty - s.y, d = Math.hypot(dx, dy);
    s.moving = false;
    if (canMove && d > 0.35) {
      let sp = this.soldierSpeed(s, mode);
      if (team.order.path && !team.order.arrived && !s.task) sp *= d > 4 ? 1.25 : 1;
      const step = Math.min(d, sp * dt);
      const nx = s.x + dx / d * step, ny = s.y + dy / d * step;
      if (this.nav.passable(MC.INF, nx, ny) || !this.nav.passable(MC.INF, s.x, s.y)) { s.x = nx; s.y = ny; }
      else if (this.nav.passable(MC.INF, nx, s.y)) s.x = nx;
      else if (this.nav.passable(MC.INF, s.x, ny)) s.y = ny;
      s.moving = true;
      if (!s.burstLeft) s.dir = turnToward(s.dir, Math.atan2(dy, dx), dt * 6);
      if (mode === 'fast' || mode === 'retreat') s.stamina -= dt * 6;
      if (s.wpn.setup) s.setupT = 0;
    } else if (s.wpn.setup && s.setupT < s.wpn.setup) s.setupT += dt;

    // ---- stance
    const depth = T.depthAt(s.x, s.y);
    let want;
    if (s.moving) want = mode === 'sneak' ? 2 : (s.sup > 25 || mode === 'assault') ? 1 : 0;
    else if (s.status === 'pinned' || s.status === 'cowering') want = 2;
    else if (team.order.kind === 'ambush' || team.order.kind === 'defend') want = s.sup > 8 || team.order.kind === 'ambush' ? 2 : 1;
    else want = 1;
    if (s.fireStance !== undefined && s.fireStanceT > this.time && s.status !== 'cowering') want = Math.min(want, s.fireStance);
    if (s.inStruct) want = 1;
    if (s.berserk) want = 0;
    // water limits how low one can get
    if (depth > 0.2) want = Math.min(want, depth > 0.75 ? 0 : 1);
    if (s.wk === 'mortar60' || s.wk === 'pack75') want = Math.max(1, want === 0 ? 1 : want);
    s.stance = want;

    soldierCombat(this, s, dt);
  }
  threatDir(s) {
    // direction of the most recent / nearest visible threat
    let best = null, bd = Infinity;
    const ei = 1 - s.sideIdx;
    for (const e of this.sideList[ei]) {
      if (e.visT[s.sideIdx] < this.time - 5) continue;
      const d = dist2(s.x, s.y, e.x, e.y);
      if (d < bd && d < 90000) { bd = d; best = e; }
    }
    if (best) return angleTo(s.x, s.y, best.x, best.y);
    return s.team.order.facing ?? (s.side === 'US' ? Math.PI / 2 : -Math.PI / 2);
  }

  // ------------------------------------------------------------ casualties
  hitSoldier(t, shooter, severity = 1) {
    if (!this.alive(t)) return;
    let r = this.rng() / severity;
    if (t.state === 'wounded') r *= 0.7;
    if (r < 0.36) this.killSoldier(t, shooter);
    else if (r < 0.66) this.incap(t, shooter);
    else this.wound(t, shooter);
  }
  countWIA(t) {
    if (t.wiaCounted) return;
    t.wiaCounted = true;
    if (t.side === 'US') this.stats.usWIA++; else this.stats.jpWIA++;
  }
  wound(t, shooter) {
    if (t.state === 'wounded') return this.incap(t, shooter);
    if (!this.alive(t)) return;
    t.state = 'wounded'; t.sup = Math.min(100, t.sup + 40); t.team.morale -= 4;
    this.countWIA(t);
  }
  incap(t, shooter) {
    if (t.state === 'incap' || t.state === 'dead') return;
    this.countWIA(t);
    t.state = 'incap'; t.bleedT = 120 + this.rng() * 300; t.burstLeft = 0; t.moving = false;
    t.stable = this.rng() < 0.3;   // a lighter wound: he lives without a corpsman
    t.team.morale -= 8;
    if (t.side === 'US') { if (this.rng() < 0.5) this.voice(this.rng() < 0.5 ? 'us_corpsman_1' : 'us_corpsman_2', t.x, t.y, 'US', { cd: 8, key: 'corpsman' }); }
    else { if (this.rng() < 0.2) this.voice('jp_medic', t.x, t.y, 'JP', { cd: 15 }); }
    if (shooter) shooter.kills += 0.5;
    this.afterCasualty(t, shooter);
  }
  killSoldier(t, shooter, bledOut = false) {
    if (t.state === 'dead') return;
    const wasWIA = !!t.wiaCounted;
    t.wiaCounted = false;
    t.state = 'dead'; t.deathT = this.time; t.burstLeft = 0; t.moving = false;
    if (t.medicBy) t.medicBy = null;
    if (t.side === 'US') { this.stats.usKIA++; if (wasWIA) this.stats.usWIA--; } else { this.stats.jpKIA++; if (wasWIA) this.stats.jpWIA--; }
    if (bledOut) return;
    t.team.morale -= t.idx === 0 ? 16 : 11;
    if (shooter) { shooter.kills++; shooter.team.kills++; }
    if (t.side === 'US' && this.rng() < 0.45) this.voice('us_mandown_1', t.x, t.y, 'US', { cd: 7, key: 'mandown' });
    if (shooter && shooter.side === 'US' && this.rng() < 0.12) this.voice('us_kill_1', shooter.x, shooter.y, 'US', { cd: 12 });
    this.afterCasualty(t, shooter);
  }
  afterCasualty(t, shooter) {
    // nearby friends lose a little nerve
    this.hash.query(t.x, t.y, 25, (o) => { if (o.sideIdx === t.sideIdx && o !== t && this.alive(o)) o.sup = Math.min(100, o.sup + 12); });
    // crew-served weapon is picked up by a team mate
    if (t.wpn.crew) {
      const mates = t.team.soldiers.filter(o => this.alive(o) && !o.wpn.crew && o !== t);
      const pref = mates.find(o => o.role === 'asst') || mates.find(o => o.role === 'ammo') || mates[mates.length - 1];
      if (pref && pref.inStruct) {
        pref.wk = t.wk; pref.wpn = t.wpn; pref.ammo = t.ammo; pref.mag = Math.min(t.wpn.mag || 99, t.ammo); pref.setupT = t.wpn.setup || 0;
        t.wpn = W.carbine; t.wk = 'carbine';
        this.msg(`${pref.rank} ${pref.name} takes over the ${pref.wpn.name}`, 'info');
      } else if (pref) {
        pref.task = { kind: 'pickup', x: t.x, y: t.y, from: t, mode: 'move', age: 0 };
      }
    }
    if (t.inStruct && t.team.soldiers.every(o => !this.alive(o))) {
      const st = t.inStruct;
      if (st.garrison.every(g => this.teamAlive(g) === 0) && !st.destroyed) this.msg(`${st.name} silenced`, 'good');
    }
  }

  // ------------------------------------------------------------ VLs & ending
  updateVLs(dt) {
    for (const vl of this.vls) {
      let us = 0, jp = 0;
      this.hash.query(vl.x, vl.y, vl.r, (s) => {
        if (!this.alive(s) || s.status === 'panicked' || s.status === 'cowering') return;
        if (dist2(s.x, s.y, vl.x, vl.y) > vl.r * vl.r) return;
        if (s.side === 'US') us++; else jp++;
      });
      for (const st of this.structures) if (!st.destroyed && dist2(st.x, st.y, vl.x, vl.y) < vl.r * vl.r) for (const g of st.garrison) jp += this.teamAlive(g);
      vl.contested = us > 0 && jp > 0;
      vl.us = us; vl.jp = jp;
      if (us > 0 && jp === 0 && vl.owner !== 'US') {
        vl.prog += dt / 10;
        if (vl.prog >= 1) { vl.owner = 'US'; vl.prog = 0; this.msg(`Objective taken: ${vl.name}`, 'good'); this.radio('rad_objective'); }
      } else if (jp > 0 && us === 0 && vl.owner !== 'JP') {
        vl.prog += dt / 10;
        if (vl.prog >= 1) { vl.owner = 'JP'; vl.prog = 0; this.msg(`Objective lost: ${vl.name}`, 'bad'); this.radio('rad_lost_objective'); }
      } else vl.prog = Math.max(0, vl.prog - dt / 20);
    }
  }
  score() {
    let us = 0, tot = 0;
    for (const v of this.vls) { tot += v.value; if (v.owner === 'US') us += v.value; }
    return { us, tot };
  }
  checkEnd() {
    if (this.ended) return;
    const lim = this.sc.timeLimit || 3600;
    let usAlive = 0, usPending = 0, jpAlive = 0;
    for (const s of this.soldiers) if (this.alive(s)) { if (s.side === 'US') usAlive++; else jpAlive++; }
    if (this.sc.pendingWaves) usPending = this.sc.pendingWaves(this);
    if (this.time >= lim) return this.end('time');
    if (usAlive === 0 && usPending === 0 && this.time > 30) return this.end('annihilated');
    if (jpAlive === 0 && this.time > 10) return this.end('cleared');
  }
  end(reason) {
    if (this.ended) return;
    this.ended = true;
    const { us, tot } = this.score();
    const frac = tot ? us / tot : 0;
    let grade;
    if (reason === 'annihilated') grade = 'Defeat';
    else if (reason === 'cleared' || frac >= 0.999) grade = 'Decisive Victory';
    else if (frac >= 0.6) grade = 'Victory';
    else if (frac >= 0.35) grade = 'Marginal Victory';
    else if (frac > 0) grade = 'Draw';
    else grade = 'Defeat';
    if (this.sc.grade) grade = this.sc.grade(this, grade, frac) || grade;
    this.result = { reason, grade, frac, us, tot, stats: { ...this.stats }, time: this.time };
    this.radio(grade.includes('Victory') ? 'rad_mission_win' : 'rad_mission_lose');
  }

  // ------------------------------------------------------------ fire support
  hasRadio() {
    return this.teams.some(t => t.side === 'US' && t.radio && !t.embarked && t.soldiers.some(s => this.alive(s) && s.role === 'radio' && s.status !== 'cowering' && s.status !== 'panicked'));
  }
  callSupport(kind, x, y) {
    if (!this.hasRadio()) { this.radio('rad_no_radio', "Radio's waterlogged — no contact with the ships. Land a command post first."); return false; }
    if ((this.support[kind] || 0) <= 0) { this.radio('rad_no_support', 'No fire support available.'); return false; }
    this.support[kind]--;
    this.supportMarks = (this.supportMarks || []).filter(m => m.t > this.time);
    this.supportMarks.push({ x, y, t: this.time + (kind === 'naval' ? 22 : kind === 'air' ? 32 : 7), label: kind === 'naval' ? 'NGF' : kind === 'air' ? 'AIR' : 'STAR' });
    if (kind === 'naval') {
      this.radio('rad_ngf_request', 'Fire mission, over.');
      this.strikes.push({ t: this.time + 4, fn: (g) => g.radio('rad_ngf_confirm', 'Fire mission confirmed. Shot, over.') });
      this.strikes.push({ t: this.time + 18, fn: (g) => g.radio('rad_ngf_splash', 'Splash, over.') });
      for (let i = 0; i < 8; i++) {
        this.strikes.push({ t: this.time + 21 + i * 1.3 + this.rng() * 0.8, fn: (g) => {
          const a = g.rng() * 6.28, r = Math.abs(g.rng.gauss()) * 26;
          const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
          g.sound('shell_incoming', px, py, 0.8);
          g.projectiles.push({ kind: 'shell', x0: px - 30, y0: py - 200, x: px, y: py, tx: px, ty: py, t: 0, T: 1.1, w: { he: { power: 3.2, r: 12 }, vsStruct: 160, pen: 120, vsVeh: 300 }, owner: null, side: 'US', invisible: true });
        } });
      }
    } else if (kind === 'air') {
      this.radio('rad_air_inbound', 'Hellcats inbound. Keep your heads down.');
      const ang = -Math.PI / 2 + (this.rng() - 0.5) * 0.6;
      this.strikes.push({ t: this.time + 30, fn: (g) => {
        const len = 900;
        const x0 = x - Math.cos(ang) * len, y0 = y - Math.sin(ang) * len, x1 = x + Math.cos(ang) * len, y1 = y + Math.sin(ang) * len;
        g.emit({ t: 'plane', x0, y0, x1, y1, dur: 6 });
        g.sound('plane_flyby', x, y, 1.2);
        for (let i = 0; i < 26; i++) {
          const k = (i / 26 - 0.5) * 160;
          g.strikes.push({ t: g.time + 2.6 + i * 0.05, fn: (gg) => {
            const px = x + Math.cos(ang) * k + (gg.rng() - 0.5) * 6, py = y + Math.sin(ang) * k + (gg.rng() - 0.5) * 6;
            gg.emit({ t: 'impact', x: px, y: py, water: gg.T.isWater(px, py) });
            gg.hash.query(px, py, 4, (s) => { if (gg.alive(s) && !s.inStruct && gg.rng() < 0.25) gg.hitSoldier(s, null); s.sup = Math.min(100, s.sup + 40); });
          } });
        }
        for (let b = 0; b < 2; b++) g.strikes.push({ t: g.time + 3.2 + b * 0.25, fn: (gg) => {
          const px = x + (gg.rng() - 0.5) * 30, py = y + (gg.rng() - 0.5) * 30;
          explode(gg, px, py, 4, 14, null, { vsStruct: 300, pen: 150 });
        } });
      } });
    } else if (kind === 'star') {
      this.sound('cannon_distant', x, y, 0.4);
      this.strikes.push({ t: this.time + 6, fn: (g) => { g.flares.push({ x, y, t: 0, life: 50, r: 260, int: 0 }); g.sound('flare', x, y, 0.8); g.voice('us_flare_1', x, y, 'US', { cd: 20 }); } });
    }
    return true;
  }
  popSmoke(team, x, y) {
    if (team.smokeN <= 0) return false;
    team.smokeN--;
    const [cx, cy] = this.teamCenter(team);
    const d = Math.hypot(x - cx, y - cy);
    const k = Math.min(1, 30 / Math.max(1, d));
    const px = cx + (x - cx) * k, py = cy + (y - cy) * k;
    this.addSmoke(px, py, 12, 75);
    const l = this.leader(team);
    if (l) this.voice('us_smoke_1', l.x, l.y, 'US', { cd: 5 });
    return true;
  }
  addSmoke(x, y, rMax, life) {
    this.smokes.push({ x, y, r: 3, rMax, life, t: 0 });
    this.emit({ t: 'smoke', x, y, r: rMax });
  }
}
