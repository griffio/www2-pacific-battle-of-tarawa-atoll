// Japanese commander AI: reserves reinforce threatened sectors, local counterattacks, banzai charges,
// pre-registered mortar/artillery barrages on the reef, tank sorties.
import { dist, dist2, angleTo } from '../util.js';
import { MC } from './nav.js';
import { explode } from './combat.js';

export class JapaneseCommander {
  constructor(g) {
    this.g = g; this.acc = 0; this.barrageT = 25; this.lastCounter = -999;
  }
  update(dt) {
    const g = this.g;
    this.acc += dt;
    this.melee(dt);
    if (this.acc < 2) return;
    const step = this.acc; this.acc = 0;
    const usVisible = g.soldiers.filter(s => s.side === 'US' && g.alive(s) && s.visT[1] > g.time);
    for (const team of g.teams) {
      if (team.side !== 'JP' || team.vehicle || g.teamAlive(team) === 0) continue;
      const ai = team.ai;
      if (ai.banzai) { this.driveBanzai(team); continue; }
      if (team.struct) continue;
      const role = ai.role || (team.pos ? 'defend' : 'reserve');
      const [cx, cy] = g.teamCenter(team);
      // find closest visible enemy
      let near = null, nd = Infinity;
      for (const s of usVisible) { const d = dist2(cx, cy, s.x, s.y); if (d < nd) { nd = d; near = s; } }
      nd = Math.sqrt(nd);
      // fanatic last stand
      if (team.morale < 22 && near && nd < 60 && g.rng() < 0.06) { this.banzai([team], near.x, near.y); continue; }
      if (role === 'reserve' && near && nd < (ai.reactRange || 320) && nd > 90 && !this.busy(team) && g.rng() < 0.3) {
        const p = this.freePositionNear(near.x, near.y, cx, cy);
        if (p) {
          if (team.pos) team.pos.occupied = null;
          g.order(team, 'sneak', p.x, p.y, null, { facing: angleTo(p.x, p.y, near.x, near.y) });
          p.occupied = team; team.pos = p; ai.claim = p; ai.busyUntil = g.time + 90;
        }
      }
      // local counterattack against pinned marines
      if ((role === 'reserve' || role === 'defend' || role === 'counter') && team.morale > 55 && g.time - this.lastCounter > (ai.counterGap || 70) && near && nd < 90) {
        let pinned = 0, us = 0;
        g.hash.query(near.x, near.y, 25, (s) => { if (s.side === 'US' && g.alive(s)) { us++; if (s.status === 'pinned' || s.status === 'cowering') pinned++; } });
        const mine = g.teamAlive(team);
        if (pinned >= us * 0.6 && mine >= us * 1.3 && g.rng() < 0.25) {
          this.lastCounter = g.time;
          g.order(team, 'fast', near.x, near.y);
          team.ai.busyUntil = g.time + 40;
          g.voice('jp_charge', cx, cy, 'JP', { cd: 20 });
          g.msg('Japanese counterattack!', 'warn');
        }
      }
    }
    // tanks
    for (const v of g.vehicles) {
      if (v.side !== 'JP' || v.state === 'destroyed' || v.immobile) continue;
      if (v.path) continue;
      let tgt = null, td = Infinity;
      for (const u of g.vehicles) if (u.side === 'US' && u.state !== 'destroyed' && u.visT[1] > g.time && !u.carried) { const d = dist(v.x, v.y, u.x, u.y); if (d < td) { td = d; tgt = u; } }
      if (!tgt) for (const s of usVisible) { const d = dist(v.x, v.y, s.x, s.y); if (d < td) { td = d; tgt = s; } }
      if (tgt && td < (v.aiRange || 450) && td > 160 && g.rng() < 0.3) {
        const a = angleTo(tgt.x, tgt.y, v.x, v.y);
        g.orderVehicle(v, 'move', tgt.x + Math.cos(a) * 140, tgt.y + Math.sin(a) * 140);
      }
    }
    // pre-registered barrages on the reef and beach
    const B = g.sc.jpBarrage;
    if (B) {
      this.barrageT -= step;
      if (this.barrageT <= 0 && g.time > (B.delay || 0)) {
        this.barrageT = B.interval * (0.7 + g.rng() * 0.6);
        const pool = g.soldiers.filter(s => s.side === 'US' && g.alive(s) && !s.inVeh && (!B.zone || (s.y > B.zone[1] && s.y < B.zone[3] && s.x > B.zone[0] && s.x < B.zone[2])));
        const boats = g.vehicles.filter(v => v.side === 'US' && v.state !== 'destroyed' && !v.carried && (!B.zone || (v.y > B.zone[1] && v.y < B.zone[3])));
        const all = pool.concat(boats.length && g.rng() < 0.35 ? boats : []);
        if (all.length && this.alive()) {
          const t = all[(g.rng() * all.length) | 0];
          const n = B.shells || 4;
          for (let i = 0; i < n; i++) {
            g.strikes.push({ t: g.time + 1.5 + i * 1.6 + g.rng(), fn: (gg) => {
              const a = gg.rng() * 6.28, r = Math.abs(gg.rng.gauss()) * (B.scatter || 28);
              const px = t.x + Math.cos(a) * r, py = t.y + Math.sin(a) * r;
              gg.sound('shell_incoming', px, py, 0.6);
              gg.strikes.push({ t: gg.time + 1.1, fn: (g3) => explode(g3, px, py, B.power || 2.2, B.r || 9, null, {}) });
            } });
          }
        }
      }
    }
  }
  alive() { return this.g.soldiers.some(s => s.side === 'JP' && this.g.alive(s)); }
  busy(team) { return (team.ai.busyUntil || 0) > this.g.time && team.order.path && !team.order.arrived; }
  freePositionNear(x, y, fx, fy) {
    const g = this.g;
    let best = null, bs = Infinity;
    for (const p of g.positions) {
      if (p.occupied || p.type === 'revet') continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < 60 || d > 170) continue;
      const df = Math.hypot(p.x - fx, p.y - fy);
      if (df > 400) continue;
      const sc = d * 0.6 + df * 0.4;
      if (sc < bs) { bs = sc; best = p; }
    }
    return best;
  }
  banzai(teams, x, y) {
    const g = this.g;
    for (const t of teams) {
      if (t.struct) g.leaveStruct(t);
      if (t.pos) { t.pos.occupied = null; t.pos = null; }
      t.ai.banzai = true; t.ai.target = [x, y]; t.ai.repath = 0; t.morale = 100;
      for (const s of t.soldiers) if (g.alive(s)) { s.berserk = true; s.sup = 0; }
      g.order(t, 'fast', x + (g.rng() - 0.5) * 30, y + (g.rng() - 0.5) * 30);
    }
    const [cx, cy] = g.teamCenter(teams[0]);
    g.sound('whistle', cx, cy, 1);
    g.voice('jp_banzai', cx, cy, 'JP', { cd: 4, prio: 2 });
    g.strikes.push({ t: g.time + 2, fn: (gg) => gg.voice('us_banzai_1', x, y, 'US', { cd: 30, prio: 2 }) });
    g.msg('BANZAI CHARGE!', 'bad');
  }
  driveBanzai(team) {
    const g = this.g;
    team.ai.repath = (team.ai.repath || 0) - 2;
    if (team.ai.repath > 0 && team.order.path && !team.order.arrived) return;
    team.ai.repath = 6;
    const [cx, cy] = g.teamCenter(team);
    let best = null, bd = Infinity;
    for (const s of g.sideList[0]) { const d = dist2(cx, cy, s.x, s.y); if (d < bd && d < 160000) { bd = d; best = s; } }
    const tgt = best ? [best.x, best.y] : team.ai.target;
    if (tgt) g.order(team, 'fast', tgt[0], tgt[1]);
    if (g.rng() < 0.3) g.voice(g.rng() < 0.5 ? 'jp_banzai' : 'jp_charge', cx, cy, 'JP', { cd: 6 });
  }
  // hand-to-hand fighting
  melee(dt) {
    const g = this.g;
    for (const s of g.soldiers) {
      if (!s.berserk || !g.alive(s)) continue;
      let foe = null;
      g.hash.query(s.x, s.y, 2.6, (e) => { if (e.sideIdx !== s.sideIdx && g.alive(e) && !e.inStruct) foe = e; });
      if (!foe) continue;
      if (g.rng() > dt * 0.9) continue;
      const defend = foe.team.order.kind === 'defend' || foe.team.order.kind === 'ambush';
      const usWins = 0.45 + (defend ? 0.12 : 0) - (foe.status === 'pinned' ? 0.15 : 0) + (foe.wpn.cls === 'smg' ? 0.1 : 0);
      if (g.rng() < usWins) g.killSoldier(s, foe); else g.hitSoldier(foe, s, 1.4);
      g.sound('rifle_us', s.x, s.y, 0.4, 1.3);
    }
  }
}
