// Builds per-frame sprite instance lists from map + game state.
import { InstanceList } from './renderer.js';
import { FX } from './fx.js';
import { K } from '../kinds.js';
import { STRUCT_SPECS } from '../world/betio.js';
import { normAngle } from '../util.js';

const WEP = { rifle: 0, mg: 1, hmg: 1, auto: 1, at: 2, flame: 3, smg: 4, mortar: 5, pistol: 6, cannon: 5, coastal: 5 };
// cast-shadow heights (m) of map props; shapes: 0 upright cylinder, 1 box, 2 sand mound, 3 palm (see fsShadow)
const TALL = { [K.BUILDING]: 4.2, [K.HUT]: 3.2, [K.HULK]: 7, [K.TRUCK]: 2.4, [K.CRATE]: 1.4, [K.TRAP]: 1.2, [K.SEAWALL]: 1.4, [K.RUBBLE]: 0.9, [K.PIER]: 1.8 };
const VEH_H = { [K.LVT]: 2.6, [K.LCVP]: 2.2, [K.LCM]: 2.6, [K.RAFT]: 0.5, [K.SHERMAN]: 2.9, [K.STUART]: 2.4, [K.HAGO]: 2.2 };
const STANCE_H = [1.75, 1.15, 0.38, 0.3, 0.3];
const SEL_COL = { sel: [1, 0.86, 0.38], hover: [0.8, 0.92, 1] };
// pre-rendered atlas sprites (assets/sprites): model crown radius of the palms, turret pivots ahead of hull centre (m)
const PALM_R = 4.4;
const TURRET = { [K.SHERMAN]: ['sherman', 0.25], [K.STUART]: ['stuart', 0.1], [K.HAGO]: ['hago', 0.45] };
const TRUCK_FOOT = [5.6, 2.4];   // wrecked-truck props are drawn at the truck's own size, whatever the prop's footprint
// soldiers are pre-rendered sprites (legs + body, tools/render_sprites.py); ?sdf-soldiers draws the old shader figures
const SOLDIER_SPRITES = !(typeof location !== 'undefined' && new URLSearchParams(location.search).has('sdf-soldiers'));
const STANCE_NAME = ['stand', 'crouch', 'prone'], WEP_NAME = ['rifle', 'mg', 'at', 'flame', 'smg', 'mortar', 'pistol'];
let soldierMan = null;
// soldier sprite lookups cached by (side, stance, weapon class, leg frame): no string building per soldier per frame
let solCache = new Map(), solCacheMan = null;
function solSprite(man, side, stance, wcls, leg) {   // leg: -1 body, 0..2 stride frame
  if (solCacheMan !== man) { solCacheMan = man; solCache = new Map(); }
  const key = ((side * 8 + stance) * 8 + wcls) * 4 + leg + 1;
  let sp = solCache.get(key);
  if (sp === undefined) {
    const sd = side === 0 ? 'us' : 'jp';
    const name = leg >= 0 ? `sol_${sd}_${STANCE_NAME[stance]}_legs${leg}` : stance >= 3 ? `sol_${sd}_${stance === 3 ? 'down' : 'dead'}` : `sol_${sd}_${STANCE_NAME[stance]}_${WEP_NAME[wcls]}`;
    sp = man.sprites[name] || null; solCache.set(key, sp);
  }
  return sp;
}

export class Scene {
  constructor(renderer, map) {
    this.r = renderer; this.map = map;
    this.low = new InstanceList(4096); this.canopy = new InstanceList(4096);
    this.alpha = new InstanceList(16384); this.add = new InstanceList(4096);
    this.shadowStatic = new InstanceList(4096); this.shadows = new InstanceList(8192);
    this.hoverTeam = null;
    this.fx = new FX(renderer);
    this.staticBuilt = false;
  }
  buildStatic(g) {
    const L = this.low, C = this.canopy, S = this.shadowStatic, map = this.map;
    L.clear(); C.clear(); S.clear();
    // shadow casters: (x, y, hw, hh, rot, shape, height, darkness, seed, damage, mask-self, penumbra)
    for (const p of map.props) {
      if (p.k === K.STUMP) { S.push(p.x, p.y, 0.32, 0.32, 0, 0, 2 + p.p0 * 3, 0.9, 0, 0, 1, 0); continue; }
      const h = TALL[p.k];
      if (p.k === K.TRUCK) { S.push(p.x, p.y, TRUCK_FOOT[0] / 2, TRUCK_FOOT[1] / 2, p.rot, 1, h, 1, 0, 0, 1, 0); continue; }
      if (h) S.push(p.x, p.y, p.hw, p.hh, p.rot, 1, p.k === K.RUBBLE ? h * (0.5 + p.p1 * 0.6) : h, p.k === K.PIER ? 0.8 : 1, 0, 0, p.k === K.PIER ? 0 : 1, 0);
    }
    const structs = g ? g.structures : map.structures;
    for (const s of structs) if (s.type !== 'hulk') {
      const sp = STRUCT_SPECS[s.type], h = sp.height * (s.destroyed ? 0.5 : 1);
      if (s.type === 'coastgun' || s.type === 'steelpb') S.push(s.x, s.y, s.w / 2 * 0.85, s.w / 2 * 0.85, 0, 0, h, 1, 0, 0, 1, 0);
      else if (sp.mound) S.push(s.x, s.y, s.h / 2, s.w / 2, s.dir, 2, h * 0.8, 0.9, 0, 0, 1, Math.min(2, h * 0.2));
      else S.push(s.x, s.y, s.h / 2, s.w / 2, s.dir, 1, h, 1, 0, 0, 1, 0);
    }
    const man = this.r.spriteMan;
    const palmSprite = (c) => {
      if (!man) return null;
      const group = c.p1 < 0.25 ? ['palm', 6] : c.p1 < 0.65 ? ['palm_hit', 5] : ['palm_dead', 3];
      return man.sprites[group[0] + Math.floor(c.p0 * group[1] * 0.999)];
    };
    for (const c of map.canopy) {
      const ps = palmSprite(c);
      if (ps) { const k = c.hw / PALM_R; S.push(c.x, c.y, ps.half[0] * k, ps.half[1] * k, c.rot, 4, 9 + c.p0 * 6, 0.9 - c.p1 * 0.2, c.p0, c.p1, 0, 0, ...ps.uv); }
      else S.push(c.x, c.y, c.hw, c.hh, c.rot, 3, 9 + c.p0 * 6, 0.85 - c.p1 * 0.3, c.p0, c.p1, 0, 0);
    }
    for (const p of map.positions) {
      if (p.type === 'mgnest') L.push(p.x, p.y, 3.4, 3.4, p.dir, K.MGNEST, 0, 0, 1, 1, 1, 1);
      else if (p.type === 'gunpit') L.push(p.x, p.y, 5.6, 5.6, p.dir, K.SANDBAG, 0, 0, 1, 1, 1, 1);
      else if (p.type === 'revet') L.push(p.x, p.y, 6, 6, p.dir, K.REVET, 0, 0, 1, 1, 1, 1);
    }
    // atlas sprite scaled per axis to a footprint (x along the sprite's forward axis)
    const atlasFit = (list, name, x, y, fx, fy, rot, dead) => {
      const a = man && man.sprites[name];
      if (!a) return false;
      const mx = a.model ? a.model[0] : a.sx, my = a.model ? a.model[1] : a.sy;
      list.push(x, y, a.half[0] * fx / mx, a.half[1] * fy / my, rot, K.ATLAS, dead ? 1 : 0, 0, 1, 1, 1, 1, ...a.uv);
      return true;
    };
    for (const p of map.props) {
      if (p.k === K.BUILDING && atlasFit(L, p.p1 < 0.5 ? 'shed0' : 'shed1', p.x, p.y, p.hw * 2, p.hh * 2, p.rot, p.p0 > 0.5)) continue;
      if (p.k === K.TRUCK && atlasFit(L, p.p1 < 0.5 ? 'truck_wreck0' : 'truck_wreck1', p.x, p.y, TRUCK_FOOT[0], TRUCK_FOOT[1], p.rot, false)) continue;
      if (p.k === K.HUT && atlasFit(L, p.p1 < 0.5 ? 'hut0' : 'hut1', p.x, p.y, p.hw * 2, p.hh * 2, p.rot, p.p0 > 0.5)) continue;
      L.push(p.x, p.y, p.hw, p.hh, p.rot, p.k, p.p0, p.p1, 1, 1, 1, 1, p.p2, p.p3);
    }
    for (const s of structs) {
      if (s.type === 'hulk') continue;
      const sp = STRUCT_SPECS[s.type];
      if (atlasFit(L, 'st_' + s.type, s.x, s.y, s.h, s.w, s.dir, s.destroyed)) continue;
      L.push(s.x, s.y, s.h / 2, s.w / 2, s.dir, sp.sprite, s.destroyed ? 1 : 0, 0, 1, 1, 1, 1);
    }
    for (const c of map.canopy) {
      const ps = palmSprite(c);
      if (ps) {
        const k = c.hw / PALM_R, v = 0.92 + ((c.p0 * 7.13) % 1) * 0.14;
        C.push(c.x, c.y, ps.half[0] * k, ps.half[1] * k, c.rot, K.ATLAS, 0, 1, v, v * (0.97 + c.p0 * 0.06), v * 0.96, 1, ...ps.uv);
      } else C.push(c.x, c.y, c.hw, c.hh, c.rot, K.PALM, c.p0, c.p1, 1, 1, 1, 1);
    }
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
    // static shadow casters (margin covers the sweep)
    const SW = this.shadows; SW.clear();
    { const d = this.shadowStatic.data;
      // far out, palm and stump shadows are sub-pixel smudges that cost a lot of fill: keep only buildings & forts
      const small = zoomCss < 0.55;
      for (let i = 0; i < this.shadowStatic.n; i++) {
        const o = i * 16;
        if (small && (d[o + 5] === 3 || d[o + 5] === 4 || d[o + 5] === 0)) continue;
        const r = Math.max(d[o + 2], d[o + 3]) + d[o + 6] * 1.4 + 2;
        if (d[o] < x0 - r || d[o] > x1 + r || d[o + 1] < y0 - r || d[o + 1] > y1 + r) continue;
        SW.ensure(1); SW.data.set(d.subarray(o, o + 16), SW.n * 16); SW.n++;
      } }
    if (!g) { copyCulled(this.canopy, A, 2); return; }
    const T = g.T;
    const lerp = (a, b) => a + (b - a) * interp;
    const sz = Math.max(1.15, 4.2 / zoomCss);
    const time = g.time;
    const hoverTeam = this.hoverTeam;
    // selection / hover state per soldier and vehicle: 1 selected, 2 selected + pinned, 3 selected + wounded, 0.5 hover
    const selCode = (s) => {
      const t = s.team;
      if (t && t.selected) return s.state === 'incap' ? 3 : s.status === 'pinned' || s.status === 'cowering' ? 2 : 1;
      return t && t === hoverTeam ? 0.5 : 0;
    };
    const selVeh = new Map();
    for (const t of g.teams) {
      const v = t.vehicle || t.embarked;
      if (!v) continue;
      if (t.selected) selVeh.set(v, 1); else if (t === hoverTeam && !selVeh.has(v)) selVeh.set(v, 0.5);
    }
    const kSoldier = sz / 1.15;
    soldierMan = SOLDIER_SPRITES ? this.r.spriteMan : null;
    // bodies & incapacitated
    for (const s of g.soldiers) {
      if (s.state !== 'dead' && s.state !== 'incap') continue;
      if (s.inVeh || (s.inStruct)) continue;
      if (!inView(s.x, s.y, 3)) continue;
      if (s.side === 'JP' && s.lastSeen[0] === 0 && s.visT[0] < time) continue;
      const depth = T.depthAt(s.x, s.y);
      if (depth > 0.9) continue;
      L_soldier(A, s, s.x, s.y, sz * 1.25, s.state === 'dead' ? 4 : 3, time, depth, 0.95, s.state === 'incap' ? selCode(s) : 0);
      if (depth < 0.2 && zoomCss > 0.7) SW.push(s.x, s.y, 0.3 * kSoldier, 0.3 * kSoldier, 0, 0, 0.3 * kSoldier, 0.8, 0, 0, 1, 0);
    }
    // vehicles (carried tanks last, so they sit inside their LCM's well)
    const man = this.r.spriteMan;
    const order = g.vehicles.filter(v => !v.carried).concat(g.vehicles.filter(v => v.carried));
    for (const v of order) {
      const x = lerp(v.px, v.x), y = lerp(v.py, v.y);
      if (!inView(x, y, 12)) continue;
      if (v.side === 'JP' && v.visT[0] < time && v.state !== 'destroyed') continue;
      const spec = v.spec;
      const vs = Math.min(3, Math.max(1, 1.6 / zoomCss));
      const dead = v.state === 'destroyed';
      let a = 1 - v.sinking * 0.75;
      v._phase = (v._phase || 0) + v.speed * dt * 1.2;
      const depth = T.depthAt(x, y);
      const vh = (VEH_H[spec.sprite] || 2.2) * (dead ? 0.8 : 1) - Math.max(0, Math.min(depth, 1.2)) * (spec.kind === 'track' ? 1 : 0.4);
      if (vh > 0.2 && a > 0.3) SW.push(x, y, spec.len / 2 * vs, spec.wid / 2 * vs, v.dir, 1, vh * vs, a, 0, 0, 1, 0);
      const sv = selVeh.get(v);
      if (sv) { const c = sv === 1 ? SEL_COL.sel : SEL_COL.hover; A.push(x, y, spec.len / 2 * vs + 1, spec.wid / 2 * vs + 1, v.dir, K.SELBOX, 0, 0, c[0], c[1], c[2], sv === 1 ? 0.95 : 0.7); }
      if (v.wake > 0.3 && !dead) A.push(x - Math.cos(v.dir) * spec.len * 0.9 * vs, y - Math.sin(v.dir) * spec.len * 0.9 * vs, spec.len * 0.9 * vs, spec.wid * 1.6 * vs, v.dir, K.WAKE, 0, 0, 1, 1, 1, Math.min(1, v.wake / 2));
      const cargo = v.cargo.length > 0 ? 1 : 0;
      const atlasName = !man ? null : spec.sprite === K.LVT ? (spec.variant ? 'lvt2' : 'lvt1') + (cargo ? '_load' : '')
        : spec.sprite === K.LCVP ? (v.ramp > 0.5 ? 'lcvp_ramp' : cargo ? 'lcvp_load' : 'lcvp')
        : spec.sprite === K.LCM ? (v.ramp > 0.5 ? 'lcm_ramp' : 'lcm')
        : TURRET[spec.sprite] ? TURRET[spec.sprite][0] : null;
      const sp = atlasName && man.sprites[atlasName];
      if (sp) {
        const k = spec.len / sp.len * vs, ox = -(sp.shift || 0) * k, c = Math.cos(v.dir), s = Math.sin(v.dir);
        A.push(x + c * ox, y + s * ox, sp.half[0] * k, sp.half[1] * k, v.dir, K.ATLAS, dead ? 1 : 0, 0, 1, 1, 1, a, ...sp.uv);
        const tur = TURRET[spec.sprite] && man.sprites[TURRET[spec.sprite][0] + '_turret'];
        if (tur) {
          const off = TURRET[spec.sprite][1] * k;
          A.push(x + c * off, y + s * off, tur.half[0] * k, tur.half[1] * k, v.tdir, K.ATLAS, dead ? 1 : 0, 0, 1, 1, 1, a, ...tur.uv);
        }
      }
      else if (spec.sprite === K.LVT) A.push(x, y, spec.len / 2 * vs, spec.wid / 2 * vs, v.dir, K.LVT, dead ? 1 : 0, cargo, 1, 1, 1, a, v._phase, spec.variant || 0);
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
        SW.push(s.x + Math.cos(s.dir) * 1.2, s.y + Math.sin(s.dir) * 1.2, 1.6, 0.7, s.dir, 1, 1.2, 0.9, 0, 0, 1, 0);
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
      L_soldier(A, s, x, y, st === 2 ? sz * 1.25 : sz, st, s.moving ? s.anim : 0, depth, 1, selCode(s));
      const sh = (STANCE_H[st] - Math.max(0, depth)) * kSoldier;
      if (sh > 0.15 && zoomCss > 0.7) SW.push(x, y, 0.27 * kSoldier, 0.27 * kSoldier, 0, 0, sh, 1, 0, 0, 1, 0);
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
    this.fx.build(A, D, viewRect, zoomCss);
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

function L_soldier(A, s, x, y, size, stance, anim, depth, alpha, sel = 0) {
  const wcls = WEP[s.wpn.cls] ?? 0;
  const man = soldierMan;
  if (man) {
    const body = solSprite(man, s.sideIdx, stance, wcls, -1);
    if (body) {
      const k = size / body.unit, us = s.sideIdx === 0 ? 1 : 0, sub = Math.max(0, depth);
      // selection / hover: the shader figure's highlight only, under the sprite
      if (sel) A.push(x, y, size, size, s.dir, stance >= 3 ? K.BODY : K.SOLDIER, stance, wcls, 1, 1, 1, alpha, s.sideIdx, -1, sub, sel);
      if (stance < 3 && sub < 0.6) {   // legs, hidden when wading; stride frames while moving
        const ph = anim ? Math.sin(anim * 9) : 0;
        const legs = solSprite(man, s.sideIdx, stance, wcls, Math.abs(ph) < 0.35 ? 0 : ph > 0 ? 1 : 2);
        if (legs) A.push(x, y, legs.half[0] * k, legs.half[1] * k, s.dir, K.ATLAS, 3, 0, 0, us, 0, alpha, ...legs.uv);
      }
      A.push(x, y, body.half[0] * k, body.half[1] * k, s.dir, K.ATLAS, 3, 0, sub, us, 0.75 * size, alpha, ...body.uv);
      return;
    }
  }
  A.push(x, y, size, size, s.dir, stance >= 3 ? K.BODY : K.SOLDIER, stance, wcls, 1, 1, 1, alpha, s.sideIdx, anim, Math.max(0, depth), sel);
}
