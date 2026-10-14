// The Tarawa operation (GALVANIC), 20–28 November 1943, as five tactical battles.
import { MC } from './nav.js';
import { F } from '../world/terrain.js';
import { destroyStruct } from './combat.js';
import { SHERMAN_NAMES } from './data.js';
import { clamp, dist, angleTo } from '../util.js';

const NORTH = -Math.PI / 2, SOUTH = Math.PI / 2, EAST = 0, WEST = Math.PI;

// ------------------------------------------------------------------ helpers
function H(g) {
  const T = g.T;
  const st = (id) => g.structures.find(s => s.id === id);
  const pos = (id) => g.positions.find(p => p.id === id);
  return {
    st, pos,
    jpIn(id, key, opts = {}) { const s = st(id); if (!s || s.destroyed) return null; const t = g.spawnTeam(key, s.x, s.y, { ...opts, hidden: true }); g.garrison(t, s); t.ai.role = 'garrison'; return t; },
    jpAt(id, key, opts = {}) { const p = pos(id); if (!p || p.occupied) return null; const t = g.spawnTeam(key, p.x, p.y, { hidden: true, ...opts }); g.occupy(t, p); t.ai.role = opts.role || 'defend'; return t; },
    jpFox(n, key, filter, opts = {}) {
      const list = g.positions.filter(p => p.type === 'foxhole' && !p.occupied && filter(p));
      // spread out: greedy pick by distance from previously chosen
      const chosen = [];
      for (let k = 0; k < n && list.length; k++) {
        let best = 0, bs = -1;
        for (let i = 0; i < list.length; i++) {
          let md = 1e9; for (const c of chosen) md = Math.min(md, dist(c.x, c.y, list[i].x, list[i].y));
          const sc = (chosen.length ? md : 0) + g.rng() * 30;
          if (sc > bs) { bs = sc; best = i; }
        }
        chosen.push(list.splice(best, 1)[0]);
      }
      return chosen.map(p => { const t = g.spawnTeam(key, p.x, p.y, { hidden: true, ...opts }); g.occupy(t, p, 2); t.ai.role = opts.role || 'defend'; return t; });
    },
    jpSniper(x, y) {
      // nearest palm canopy
      let best = null, bd = 1e9;
      for (const c of g.map.canopy) { const d = dist(c.x, c.y, x, y); if (d < bd) { bd = d; best = c; } }
      const px = best ? best.x : x, py = best ? best.y : y;
      const t = g.spawnTeam('jp_sniper', px, py, { hidden: true });
      t.ai.role = 'sniper'; t.ai.holdRange = 380;
      t.soldiers[0].x = px; t.soldiers[0].y = py; t.soldiers[0].eyeBonus = 7; t.soldiers[0].stance = 1;
      t.soldiers[1].x = px + 3; t.soldiers[1].y = py + 2; t.soldiers[1].stance = 2;
      for (const s of t.soldiers) { s.px = s.x; s.py = s.y; s.tx = s.x; s.ty = s.y; s.slotX = s.x; s.slotY = s.y; }
      t.order = { kind: 'defend', x: px, y: py, facing: NORTH };
      return t;
    },
    kill(id) { const s = st(id); if (s && !s.destroyed) { s.destroyed = true; s.hp = 0; T.stampRect(s.x, s.y, s.w, s.h, s.rot, (k) => { T.obj[k] *= 0.6; }); } },
    wreck(type, x, y, dir) {
      const v = g.spawnVehicle(type, 'US', x, y, dir);
      v.state = 'destroyed'; v.hp = 0; v.burnT = 999;
      if (v.team) for (const s of v.team.soldiers) { s.state = 'dead'; s.inVeh = null; s.deathT = -999; }
      if (v.team) g.teams.splice(g.teams.indexOf(v.team), 1);
      T.stampRect(x, y, v.spec.len, v.spec.wid, dir, (k) => { T.obj[k] = Math.max(T.obj[k], 1.7); T.flags[k] |= F.WRECK; });
      return v;
    },
    craft(type, x, y, dir, teams, beach, opts = {}) {
      const v = g.spawnVehicle(type, 'US', x, y, dir, { name: opts.name, beachTarget: opts.beachTarget });
      for (const [key, name, extra] of teams) { const t = g.spawnTeam(key, x, y, { name, ...(extra || {}) }); g.embark(t, v); }
      if (beach) g.orderVehicle(v, 'move', beach[0], beach[1]);
      return v;
    },
    tankInLCM(tankType, name, x, y, dir, beach) {
      const lcm = g.spawnVehicle('LCM', 'US', x, y, dir, { name: 'LCM-3 (' + name + ')' });
      const tank = g.spawnVehicle(tankType, 'US', x, y, dir, { name: `${tankType === 'M4A2' ? 'Sherman' : 'Stuart'} '${name}'` });
      tank.carried = true; lcm.cargoVeh = tank;
      if (beach) g.orderVehicle(lcm, 'move', beach[0], beach[1]);
      return lcm;
    },
    us(key, x, y, name, opts = {}) {
      const t = g.spawnTeam(key, x, y, { name, ...opts });
      const facing = opts.facing ?? SOUTH;
      t.order = { kind: 'defend', x, y, facing };
      const perp = facing + Math.PI / 2;
      t.soldiers.forEach((s, i) => {
        const k = (i % 2 ? 1 : -1) * Math.ceil(i / 2);
        let px = x + Math.cos(perp) * k * 3.2, py = y + Math.sin(perp) * k * 3.2;
        const c = g.findCover(px, py, x + Math.cos(facing) * 50, y + Math.sin(facing) * 50, 3.5);
        s.x = s.px = s.tx = s.slotX = c[0]; s.y = s.py = s.ty = s.slotY = c[1];
        s.dir = facing; s.stance = 2;
        if (s.wpn.setup) s.setupT = s.wpn.setup;
      });
      return t;
    },
    vl: (name, x, y, r, value, owner) => g.placeVL(name, x, y, r, value, owner),
  };
}
function runWaves(g, dt) {
  const w = g.sc._waves;
  if (!w) return;
  while (w.length && g.time >= w[0].t) { const e = w.shift(); e.fn(g); }
}
function nY(g, x, d = 0) { return g.map.northY(x) + d; }

// ------------------------------------------------------------------ scenarios
export const SCENARIOS = [
  // ================================================================ 1
  {
    id: 'redbeach', map: 'betio', name: 'Red Beach — D-Day', subtitle: 'Betio, 20 November 1943, 0910',
    narration: 'nar_s1', startMin: 9 * 60 + 10, timeLimit: 2700, tide: 0.0,
    light: { ambient: 1, night: 0, tint: [1.0, 0.98, 0.94] },
    bounds: [380, 380, 2560, 1500], camera: { x: 1250, y: 830, zoom: 1.0 },
    support: { naval: 3, air: 2, star: 0 },
    jpBarrage: { interval: 50, delay: 150, zone: [380, 560, 2560, 1120], shells: 4, power: 1.8, r: 9, scatter: 32 },
    briefing: `<p>The pre-landing bombardment has stopped. Three thousand tons of shells were supposed to wipe Betio clean — they did not. Admiral Shibasaki's 7th Sasebo Special Naval Landing Force is waiting behind a coconut-log seawall, in pillboxes and bunkers the shells barely scratched.</p>
<p>A <b>"dodging tide"</b> has left barely a metre of water over the reef. Your <b>amtracs</b> (LVTs) can crawl across the coral; the <b>Higgins boats</b> behind them cannot — their Marines will have to <b>wade 500 m under fire</b>. The long pier offers some cover, and so does the wreck of the <i>Saida Maru</i>… if no one is in it.</p>
<p><b>Objectives:</b> seize the beachheads on Red 1, 2 and 3, the Pocket strongpoint, the pier base and the taxiway. Hold what you take.</p>
<p><b>Tips:</b> Get men to the seawall, then let them catch their breath. Suppress pillbox embrasures with BARs and MGs from the front while engineers work round the flank — the <i>corkscrew</i> (demolitions) and <i>blowtorch</i> (flamethrower). The command post with its radio arrives in the third wave; until then you have no naval gunfire.</p>`,
    setup(g) {
      const h = H(g);
      g.sc._waves = [];
      // ---- Japanese defenders
      h.kill('coast_nw');
      h.jpIn('pb_beak1', 'jp_hmg'); h.jpIn('pb_beak2', 'jp_hmg'); h.jpIn('bk_r1', 'jp_rifle');
      h.jpIn('pb_pocket', 'jp_hmg'); h.jpIn('bk_pocket', 'jp_rifle'); h.jpIn('pb_r2', 'jp_hmg');
      h.jpIn('bk_pier', 'jp_rifle'); h.jpIn('pb_r3', 'jp_hmg'); h.jpIn('bk_r3', 'jp_rifle');
      h.jpIn('steel_pb', 'jp_hmg'); h.jpIn('bombproof', 'jp_rifle'); h.jpIn('bombproof', 'jp_rifle');
      h.jpIn('cmd', 'jp_hq', { leaderName: 'Shibasaki', leaderRank: 'RAdm' });
      h.jpIn('hulk', 'jp_hmg', { name: 'HMG (Saida Maru)' });
      for (const id of ['mg_r1a', 'mg_r1b', 'mg_pocket', 'mg_r2a', 'mg_r2b', 'mg_r3a', 'mg_r3b', 'mg_bp']) h.jpAt(id, 'jp_hmg');
      h.jpAt('gun_r2', 'jp_at'); h.jpAt('gun_r3', 'jp_mtn'); h.jpAt('aa_1', 'jp_aa'); h.jpAt('aa_2', 'jp_aa', { role: 'defend' });
      h.jpFox(9, 'jp_rifle', p => p.x > 450 && p.x < 2450 && p.y - nY(g, p.x) > 25 && p.y - nY(g, p.x) < 110);
      h.jpFox(2, 'jp_knee', p => p.x > 600 && p.x < 2300 && p.y - nY(g, p.x) > 90 && p.y - nY(g, p.x) < 180);
      h.jpFox(5, 'jp_rifle', p => p.x > 700 && p.x < 2300 && p.y - nY(g, p.x) > 130 && p.y < 1450, { role: 'reserve' });
      h.jpFox(2, 'jp_assault', p => p.x > 900 && p.x < 2100 && p.y > 1350 && p.y < 1480, { role: 'reserve' });
      for (const x of [820, 1340, 1880]) h.jpSniper(x, nY(g, x, 70));
      const hago = g.spawnVehicle('HAGO', 'JP', 1585, 1300, NORTH, { name: 'Ha-Go #3' });
      hago.aiRange = 200; hago.holdRange = 200;
      // ---- objectives
      h.vl('Red 1 Beachhead', 690, nY(g, 690, 40), 45, 1);
      h.vl('The Pocket', 945, nY(g, 945, 35), 45, 2);
      h.vl('Red 2 Seawall', 1220, nY(g, 1220, 30), 50, 1);
      h.vl('Pier Base', 1505, nY(g, 1505, 35), 45, 2);
      h.vl('Red 3 Seawall', 1880, nY(g, 1880, 30), 50, 1);
      h.vl('Taxiway', 1360, 1238, 60, 2);
      // ---- first wave: amtracs already across the reef edge
      const L1 = [['us_rifle', 'Rifle K-1'], ['us_rifle', 'Rifle K-2']];
      const lv = (x, type, teams, name) => h.craft(type, x, 715, SOUTH, teams, [x + (g.rng() - 0.5) * 20, nY(g, x, 2)], { name });
      lv(640, 'LVT1', [['us_rifle', 'Rifle K-1'], ['us_mg', 'MG K-1']], 'LVT-1 #11');
      lv(760, 'LVT2', [['us_rifle', 'Rifle K-2'], ['us_bazooka', 'Bazooka K']], 'LVT-2 #12');
      lv(1080, 'LVT1', [['us_rifle', 'Rifle E-1'], ['us_rifle', 'Rifle E-2']], 'LVT-1 #21');
      lv(1250, 'LVT2', [['us_rifle', 'Rifle F-1'], ['us_mg', 'MG F-1']], 'LVT-2 #22');
      lv(1700, 'LVT1', [['us_rifle', 'Rifle E-3'], ['us_rifle', 'Rifle E-4']], 'LVT-1 #31');
      lv(1880, 'LVT2', [['us_rifle', 'Rifle F-3'], ['us_assault', 'Engineers F', { leaderName: 'Bordelon', leaderRank: 'SSgt' }]], 'LVT-2 #32');
      g.msg('H-Hour. First wave crossing the reef.', 'radio');
      // ---- second wave: Hawkins' scout-snipers to the pier, more amtracs
      g.sc._waves.push({ t: 75, fn: (g) => {
        g.radio('rad_wave', 'Second wave crossing the line of departure.');
        h.craft('LCVP', 1532, 470, SOUTH, [['us_scout', 'Scout-Snipers', { leaderName: 'Hawkins', leaderRank: '1stLt' }]], [1532, 590], { name: 'LCVP (Hawkins)', beachTarget: [1513, 640] });
        h.craft('LVT2', 900, 640, SOUTH, [['us_rifle', 'Rifle L-1'], ['us_assault', 'Engineers L']], [900, nY(g, 900, 2)], { name: 'LVT-2 #41' });
        h.craft('LVT2', 1400, 640, SOUTH, [['us_rifle', 'Rifle G-1'], ['us_fo', 'NGF Spotters']], [1400, nY(g, 1400, 2)], { name: 'LVT-2 #42' });
        h.craft('LVT2', 2050, 640, SOUTH, [['us_rifle', 'Rifle G-3'], ['us_bazooka', 'Bazooka G']], [2050, nY(g, 2050, 2)], { name: 'LVT-2 #43' });
      } });
      // ---- third wave: Higgins boats ground on the reef
      g.sc._waves.push({ t: 260, fn: (g) => {
        g.radio('rad_wave', 'Third wave: boats crossing the line of departure.');
        const b = (x, teams, name) => h.craft('LCVP', x, 360, SOUTH, teams, [x, nY(g, x, 2)], { name });
        b(1180, [['us_rifle', 'Rifle E-5'], ['us_mortar', 'Mortar E']], 'LCVP #51');
        b(1460, [['us_hq', 'CP RCT-2', { leaderName: 'Shoup', leaderRank: 'Col' }], ['us_mg', 'MG H-1']], 'LCVP (Shoup)');
        b(1760, [['us_rifle', 'Rifle G-4'], ['us_assault', 'Engineers G']], 'LCVP #53');
        b(820, [['us_rifle', 'Rifle L-2'], ['us_mg', 'MG L-1']], 'LCVP #54');
      } });
      // ---- tanks
      g.sc._waves.push({ t: 520, fn: (g) => {
        g.radio('rad_reinforce', 'Tank lighters coming in.');
        h.tankInLCM('M4A2', 'China Gal', 1650, 380, SOUTH, [1650, 640]);
        h.tankInLCM('M4A2', 'Cobra', 1100, 380, SOUTH, [1100, 640]);
      } });
      // ---- reserve battalion
      g.sc._waves.push({ t: 1100, fn: (g) => {
        g.radio('rad_reinforce', 'First Battalion, Second Marines landing on Red 2.');
        for (const x of [1150, 1300, 1420]) h.craft('LVT2', x, 560, SOUTH, [['us_rifle', `Rifle A-${(x / 100) | 0}`], ['us_rifle', `Rifle B-${(x / 100) | 0}`]], [x, nY(g, x, 2)], { name: 'LVT-2 1/2' });
      } });
    },
    pendingWaves: (g) => (g.sc._waves ? g.sc._waves.length : 0),
    update(g, dt) {
      runWaves(g, dt);
      if (!g._doubt && g.time > 240 && g.stats.usKIA + g.stats.usWIA > 45) {
        g._doubt = true; g.radio('rad_issue_doubt', 'Receiving heavy fire all along the beach. Unable to land. Issue in doubt.');
      }
    },
  },

  // ================================================================ 2
  {
    id: 'greenbeach', map: 'betio', name: 'Green Beach', subtitle: 'Betio, 21 November 1943, 1100',
    narration: 'nar_s2', startMin: 11 * 60, timeLimit: 2400, tide: 0.55,
    light: { ambient: 1, night: 0, tint: [1.0, 0.99, 0.96] },
    bounds: [120, 900, 1150, 1720], camera: { x: 520, y: 1220, zoom: 1.4 },
    support: { naval: 4, air: 1, star: 0 },
    briefing: `<p>Overnight, <b>Major Michael Ryan</b> gathered stragglers from three battalions on the island's western tip — the "bird's beak". With a naval gunfire spotter whose radio actually works, and a single Sherman, his scratch battalion is about to do what nobody planned: clear <b>Green Beach</b>.</p>
<p>Pillboxes and gun pits face west across the reef. Destroyers stand by to fire on call. Once the beach is clear, <b>1st Battalion, 6th Marines</b> will come ashore in rubber boats.</p>
<p><b>Objectives:</b> take Green Beach North, Centre and South and the SW-corner bunker.</p>
<p><b>Tips:</b> Use the NGF team to call fire on pillboxes before you assault them. Infantry must screen the tank — Japanese troops will try to rush it with mines.</p>`,
    setup(g) {
      const h = H(g);
      g.sc._waves = [];
      for (const id of ['coast_nw', 'pb_beak1', 'pb_beak2', 'bk_r1', 'pb_pocket']) h.kill(id);
      h.jpIn('pb_g1', 'jp_hmg'); h.jpIn('pb_g2', 'jp_hmg'); h.jpIn('pb_g3', 'jp_hmg'); h.jpIn('bk_g', 'jp_rifle'); h.jpIn('bk_g', 'jp_hmg');
      h.jpIn('coast_sw', 'jp_rifle', { name: 'Gun crew (SW)' });
      h.jpIn('bk_pocket', 'jp_rifle');
      h.jpAt('mg_g1', 'jp_hmg'); h.jpAt('mg_g2', 'jp_hmg'); h.jpAt('gun_g', 'jp_mtn');
      h.jpFox(6, 'jp_rifle', p => p.x < 650 && p.y > 1150 && p.y < 1620);
      h.jpFox(2, 'jp_knee', p => p.x > 450 && p.x < 800 && p.y > 1250 && p.y < 1600);
      h.jpFox(3, 'jp_rifle', p => p.x > 650 && p.x < 1050 && p.y > 1200 && p.y < 1600, { role: 'reserve' });
      h.jpSniper(420, 1260); h.jpSniper(470, 1450);
      // Ryan's force near the beak
      const x0 = 470, y0 = nY(g, 470, 55);
      h.us('us_hq', x0 + 40, y0 + 10, 'CP Ryan', { leaderName: 'Ryan', leaderRank: 'Maj' });
      h.us('us_fo', x0 + 20, y0 + 20, 'NGF Spotter');
      h.us('us_rifle', x0 - 20, y0 + 40, 'Rifle K-1', { men: 7, morale: 65 });
      h.us('us_rifle', x0 + 60, y0 + 45, 'Rifle L-2', { men: 6, morale: 62 });
      h.us('us_rifle', x0 + 120, y0 + 30, 'Rifle G-3 (2/8)', { men: 7, morale: 64 });
      h.us('us_mg', x0 + 80, y0 + 20, 'MG K-1', { men: 4 });
      h.us('us_assault', x0 + 10, y0 + 15, 'Engineers K');
      h.us('us_bazooka', x0 + 100, y0 + 10, 'Bazooka L', { men: 4 });
      h.us('us_mortar', x0 + 70, y0 - 5, 'Mortar K');
      const t = g.spawnVehicle('M4A2', 'US', x0 + 140, y0 + 10, SOUTH, { name: "Sherman 'Cecilia'" });
      t.dir = t.tdir = SOUTH + 0.6;
      // wrecks from D-Day
      h.wreck('LVT1', 640, nY(g, 640, -6), SOUTH); h.wreck('LVT2', 780, nY(g, 780, -4), SOUTH - 0.3);
      h.vl('Green Beach North', g.map.westX(1205) + 45, 1205, 45, 1);
      h.vl('Green Beach Centre', g.map.westX(1335) + 45, 1335, 45, 2);
      h.vl('Green Beach South', g.map.westX(1470) + 45, 1470, 45, 1);
      const bk = h.st('bk_g'); h.vl('SW Corner', bk.x, bk.y, 40, 2);
      g.sc._waves.push({ t: 900, fn: (g) => {
        g.radio('rad_reinforce', 'One-Six landing on Green Beach in rubber boats.');
        for (let i = 0; i < 4; i++) {
          const y = 1220 + i * 70;
          const x = 60;
          h.craft('RAFT', x, y, EAST, [['us_rifle', `Rifle 1/6 ${'ABCD'[i]}`]], [g.map.westX(y) - 20, y], { name: 'Rubber boats' });
        }
      } });
    },
    pendingWaves: (g) => (g.sc._waves ? g.sc._waves.length : 0),
    update(g, dt) { runWaves(g, dt); },
  },

  // ================================================================ 3
  {
    id: 'bombproof', map: 'betio', name: "Bonnyman's Bombproof", subtitle: 'Betio, 22 November 1943, 0930',
    narration: 'nar_s3', startMin: 9 * 60 + 30, timeLimit: 2700, tide: 0.65,
    light: { ambient: 1, night: 0, tint: [1.02, 0.98, 0.92] },
    bounds: [1540, 940, 2640, 1520], camera: { x: 2030, y: 1150, zoom: 1.6 },
    support: { naval: 2, air: 1, star: 0 },
    briefing: `<p>The Marines hold the beach, but east of Red 3 a huge <b>sand-covered bombproof shelter</b>, a <b>steel pillbox</b> and a nest of bunkers around the Burns-Philp wharf have stopped 2nd and 3rd Battalions, 8th Marines cold.</p>
<p><b>1st Lt. Alexander Bonnyman</b> of the 18th Marines (engineers) will lead an assault with flamethrowers and demolitions to the <b>top</b> of the bombproof. Sherman <b>'Colorado'</b> will knock out the steel pillbox.</p>
<p><b>Objectives:</b> the steel pillbox, the bombproof summit, the wharf and the airfield east. The garrison inside the bombproof will counterattack when you reach the top.</p>
<p><b>Tips:</b> Order engineers to <b>Assault</b> a fortification — they work round to its blind side. Satchel charges and flamethrowers are the only reliable way to kill a bunker. Use the tank's 75 mm against embrasures.</p>`,
    setup(g) {
      const h = H(g);
      g.sc._waves = [];
      for (const id of ['pb_r3', 'bk_pier', 'pb_r2']) h.kill(id);
      h.jpIn('bk_r3', 'jp_rifle'); h.jpIn('steel_pb', 'jp_hmg');
      const bp = h.st('bombproof');
      bp.hp = bp.maxHp = 2600;
      const g1 = h.jpIn('bombproof', 'jp_assault'), g2 = h.jpIn('bombproof', 'jp_assault'), g3 = h.jpIn('bombproof', 'jp_rifle');
      g.sc._bpGarrison = [g1, g2, g3];
      h.jpIn('cmd', 'jp_hq', { name: 'HQ remnant' }); h.jpIn('cmd', 'jp_rifle');
      h.jpAt('mg_bp', 'jp_hmg'); h.jpAt('gun_af', 'jp_mtn'); h.jpAt('aa_2', 'jp_aa');
      h.jpFox(5, 'jp_rifle', p => p.x > 2050 && p.x < 2600 && p.y > 1100 && p.y < 1450);
      h.jpFox(3, 'jp_rifle', p => p.x > 2200 && p.x < 2600 && p.y > 1150 && p.y < 1480, { role: 'reserve' });
      h.jpFox(2, 'jp_knee', p => p.x > 2250 && p.x < 2600 && p.y > 1200 && p.y < 1450);
      h.jpSniper(2150, 1250); h.jpSniper(2400, 1220);
      const hago = g.spawnVehicle('HAGO', 'JP', 2360, 1330, NORTH, { name: 'Ha-Go #5' }); hago.aiRange = 420; hago.holdRange = 300;
      // Marines along the beach east of the pier
      const yb = (x) => nY(g, x, 22);
      h.us('us_hq', 1700, yb(1700) + 10, 'CP 2/8', { leaderName: 'Crowe', leaderRank: 'Maj', facing: SOUTH });
      h.us('us_assault', 1960, yb(1960), 'Engineers (Bonnyman)', { leaderName: 'Bonnyman', leaderRank: '1stLt', facing: SOUTH + 0.4 });
      h.us('us_assault', 1920, yb(1920), 'Engineers 18th Mar', { facing: SOUTH + 0.4 });
      h.us('us_rifle', 1860, yb(1860) + 5, 'Rifle F-1 (2/8)', { men: 8 });
      h.us('us_rifle', 1990, yb(1990) + 5, 'Rifle F-2 (2/8)', { men: 7 });
      h.us('us_rifle', 1780, yb(1780) + 5, 'Rifle I-1 (3/8)');
      h.us('us_rifle', 1720, yb(1720) + 40, 'Rifle I-2 (3/8)', { facing: EAST });
      h.us('us_mg', 1900, yb(1900) + 2, 'MG F-1', { facing: SOUTH + 0.5 });
      h.us('us_mg', 1820, yb(1820) + 2, 'MG I-1', { facing: SOUTH + 0.3 });
      h.us('us_bazooka', 1880, yb(1880), 'Bazooka F');
      h.us('us_mortar', 1760, yb(1760), 'Mortar I');
      const col = g.spawnVehicle('M4A2', 'US', 1840, yb(1840) - 16, EAST, { name: "Sherman 'Colorado'" });
      col.tdir = EAST + 0.4;
      for (const [x, d] of [[1610, -4], [1740, -8], [2010, -5]]) h.wreck('LVT2', x, nY(g, x, d), SOUTH + (g.rng() - 0.5));
      h.wreck('M4A2', 1660, nY(g, 1660, -40), SOUTH);
      const sp = h.st('steel_pb');
      h.vl('Steel Pillbox', sp.x, sp.y, 30, 1);
      h.vl('Bombproof Summit', bp.x, bp.y, 26, 3);
      h.vl('Burns-Philp Wharf', 2302, nY(g, 2302, 15), 40, 1);
      const cmd = h.st('cmd'); h.vl("Shibasaki's Blockhouse", cmd.x, cmd.y, 35, 1);
      h.vl('Airfield East', 2230, 1330, 55, 2);
    },
    update(g, dt) {
      const bp = g.structures.find(s => s.id === 'bombproof');
      const vl = g.vls.find(v => v.name === 'Bombproof Summit');
      if (!g.sc._sallied && vl && vl.us > 0) {
        g._summitT = (g._summitT || 0) + dt;
        if (g._summitT > 12) {
          g.sc._sallied = true;
          const teams = g.sc._bpGarrison.filter(t => g.teamAlive(t) > 0);
          if (teams.length && !bp.destroyed) {
            for (const t of teams) { g.leaveStruct(t); for (const s of t.soldiers) { s.x = bp.x + 20 + g.rng() * 8; s.y = bp.y + (g.rng() - 0.5) * 20; } }
            g.jpAI.banzai(teams, vl.x, vl.y);
            g.msg('The bombproof garrison storms out to retake the summit!', 'bad');
          }
        }
      }
    },
  },

  // ================================================================ 4
  {
    id: 'night', map: 'betio', name: 'The Night Counterattack', subtitle: 'Betio, night of 22–23 November 1943',
    narration: 'nar_s4', startMin: 19 * 60 + 30, clockScale: 22, timeLimit: 1500, tide: 0.4,
    light: { ambient: 0.16, night: 1, tint: [0.55, 0.65, 1.0] },
    lightCurve: (t) => {
      const dawn = clamp((t - 1300) / 200, 0, 1);
      return { ambient: 0.16 + dawn * 0.5, night: 1 - dawn * 0.7, tint: [0.55 + dawn * 0.4, 0.65 + dawn * 0.25, 1.0 - dawn * 0.1] };
    },
    bounds: [2150, 1040, 3350, 1560], camera: { x: 2560, y: 1300, zoom: 1.6 },
    support: { naval: 5, air: 0, star: 10 },
    jpBarrage: { interval: 45, delay: 300, zone: [2250, 1050, 2620, 1560], shells: 3, power: 1.6, r: 8, scatter: 25 },
    briefing: `<p>The surviving Japanese have been pushed into the narrow tail of Betio. <b>1st Battalion, 6th Marines</b> (Lt. Col. William K. Jones) has dug in across the island, from lagoon to ocean, east of the airfield.</p>
<p>Japanese doctrine leaves only one choice: attack. Expect <b>probes</b> to find your machine guns, then a <b>massed banzai charge</b> before dawn. The destroyers <i>Schroeder</i> and <i>Sigsbee</i> stand by with star shells and 5-inch fire — call it danger close.</p>
<p><b>Objectives:</b> hold the North, Centre and South positions until dawn (about 25 minutes).</p>
<p><b>Tips:</b> Put machine guns on <b>Ambush</b> so they don't reveal themselves to the first probes. Fire star shells ahead of your line — unlit enemies are almost invisible. Keep mortars and NGF for the big wave.</p>`,
    setup(g) {
      const h = H(g);
      g.sc._waves = [];
      for (const id of ['bombproof', 'steel_pb', 'bk_r3', 'cmd']) h.kill(id);
      // Marine line roughly x≈2470
      const yN = nY(g, 2470), yS = g.map.southY(2470);
      const line = (f) => yN + 20 + (yS - yN - 40) * f;
      h.us('us_hq', 2400, line(0.5), 'CP 1/6', { leaderName: 'Jones', leaderRank: 'LtCol', facing: EAST });
      h.us('us_rifle', 2480, line(0.07), 'Rifle A-1', { facing: EAST });
      h.us('us_mg', 2485, line(0.17), 'MG A-1', { facing: EAST });
      h.us('us_rifle', 2490, line(0.28), 'Rifle A-2', { facing: EAST });
      h.us('us_rifle', 2495, line(0.42), 'Rifle B-1', { facing: EAST });
      h.us('us_mg', 2500, line(0.52), 'MG B-1', { facing: EAST });
      h.us('us_rifle', 2495, line(0.63), 'Rifle B-2', { facing: EAST });
      h.us('us_rifle', 2490, line(0.77), 'Rifle C-1', { facing: EAST });
      h.us('us_mg', 2485, line(0.87), 'MG C-1', { facing: EAST });
      h.us('us_rifle', 2470, line(0.95), 'Rifle C-2', { facing: EAST });
      h.us('us_bazooka', 2440, line(0.45), 'Bazooka B', { facing: EAST });
      h.us('us_mortar', 2380, line(0.35), 'Mortar A', { facing: EAST });
      h.us('us_mortar', 2380, line(0.7), 'Mortar C', { facing: EAST });
      h.us('us_pack', 2300, line(0.55), '75mm Howitzer 1/10', { facing: EAST });
      h.us('us_fo', 2420, line(0.25), 'NGF Spotters', { facing: EAST });
      for (const t of g.teams) if (t.side === 'US' && (t.key === 'us_mg')) t.order.kind = 'ambush';
      // Japanese east positions
      h.jpIn('bk_e1', 'jp_rifle'); h.jpIn('pb_e1', 'jp_hmg'); h.jpIn('bk_e2', 'jp_rifle'); h.jpIn('bk_e3', 'jp_hq');
      h.jpAt('mg_e1', 'jp_hmg'); h.jpAt('mg_e2', 'jp_hmg');
      h.jpFox(3, 'jp_knee', p => p.x > 2850 && p.x < 3150);
      h.vl('North Position', 2490, line(0.15), 40, 1, 'US');
      h.vl('Centre Position', 2500, line(0.5), 45, 2, 'US');
      h.vl('South Position', 2490, line(0.85), 40, 1, 'US');
      const spawnWave = (n, mode) => {
        const teams = [];
        for (let i = 0; i < n; i++) {
          const yy = line(0.1 + 0.8 * ((i + 0.5) / n)) + (g.rng() - 0.5) * 30;
          const p = g.nav.nearestPassable(MC.INF, 2770 + g.rng() * 100, yy, {}, 10);
          if (!p) continue;
          const t = g.spawnTeam(g.rng() < 0.7 ? 'jp_assault' : 'jp_rifle', p[0], p[1], { morale: 95 });
          t.ai.role = 'counter'; teams.push(t);
        }
        return teams;
      };
      g.sc._waves.push({ t: 80, fn: (g) => {
        g.radio('rad_counterattack', 'Enemy movement to our front.');
        for (const t of spawnWave(3)) { const [x, y] = g.teamCenter(t); const yy = y + (g.rng() - 0.5) * 40; g.order(t, 'move', 2680, yy, null, { waypoints: [{ kind: 'sneak', x: 2560, y: yy }] }); }
      } });
      g.sc._waves.push({ t: 430, fn: (g) => {
        g.radio('rad_counterattack', 'Enemy massing for a counterattack.');
        const ts = spawnWave(5);
        for (const t of ts) { const [x, y] = g.teamCenter(t); g.order(t, 'move', 2600, y); }
        g.strikes.push({ t: g.time + 70, fn: (gg) => { const alive = ts.filter(t => gg.teamAlive(t)); if (alive.length) gg.jpAI.banzai(alive, 2490, line(0.5)); } });
      } });
      g.sc._waves.push({ t: 950, fn: (g) => {
        g.radio('rad_counterattack', 'Here they come — the whole lot of them!');
        const ts = spawnWave(14);
        g.strikes.push({ t: g.time + 8, fn: (gg) => { const alive = ts.filter(t => gg.teamAlive(t)); if (alive.length) gg.jpAI.banzai(alive, 2490, line(0.5)); } });
      } });
      g.sc._waves.push({ t: 1300, fn: (g) => g.radio('rad_dawn', 'Dawn is breaking.') });
      // auto star shells along the front
      g.sc._autoStar = 60;
    },
    pendingWaves: () => 0,   // the night waves are Japanese; no Marine reinforcements are due
    update(g, dt) {
      runWaves(g, dt);
      g.sc._autoStar -= dt;
      if (g.sc._autoStar <= 0 && g.time < 1300) {
        g.sc._autoStar = 55 + g.rng() * 30;
        const x = 2620 + g.rng() * 200, y = 1150 + g.rng() * 300;
        g.flares.push({ x, y, t: 0, life: 40, r: 230, int: 0 });
        g.sound('flare', x, y, 0.5);
      }
    },
    grade(g, grade, frac) { return frac >= 0.99 ? 'Decisive Victory' : grade; },
  },

  // ================================================================ 5
  {
    id: 'buariki', map: 'buariki', name: 'Buariki — Last Stand', subtitle: 'North Tarawa, 27 November 1943, 0700',
    narration: 'nar_s5', startMin: 7 * 60, timeLimit: 2700, tide: 0.4,
    light: { ambient: 0.92, night: 0, tint: [1.05, 0.95, 0.85] },
    bounds: [380, 60, 1120, 1990], camera: { x: 760, y: 1650, zoom: 1.6 },
    support: { naval: 0, air: 1, star: 0 },
    briefing: `<p>Betio has fallen, but about 175 Japanese escaped up the chain of islets. <b>2nd Battalion, 6th Marines</b> has marched the length of the atoll after them. They are cornered on <b>Buariki</b>, in thick jungle around the village.</p>
<p>Sight lines here are 30 metres or less. The enemy is dug into foxholes and log bunkers, and will not surrender. This is the last fight of the Gilberts campaign.</p>
<p><b>Objectives:</b> the village, the bunker line and Buariki point.</p>
<p><b>Tips:</b> Move by bounds — one team covers while the other <b>Sneaks</b>. Scouts and BARs lead. Expect a final charge.</p>`,
    setup(g) {
      const h = H(g);
      const mx = g.map.midX;
      h.jpIn('log1', 'jp_hmg'); h.jpIn('log2', 'jp_rifle'); h.jpIn('log3', 'jp_hmg'); h.jpIn('log4', 'jp_hq');
      h.jpAt('mg_n1', 'jp_hmg'); h.jpAt('mg_n2', 'jp_hmg');
      h.jpFox(8, 'jp_rifle', p => p.y > 300 && p.y < 1150);
      h.jpFox(3, 'jp_rifle', p => p.y > 250 && p.y < 800, { role: 'reserve' });
      h.jpFox(2, 'jp_knee', p => p.y > 400 && p.y < 900);
      h.jpSniper(mx(1100), 1100); h.jpSniper(mx(950) + 40, 950); h.jpSniper(mx(700) - 50, 700);
      const y0 = 1700;
      h.us('us_hq', mx(y0 + 60), y0 + 60, 'CP 2/6', { leaderName: 'Murray', leaderRank: 'LtCol', facing: NORTH });
      h.us('us_scout', mx(y0) - 10, y0 - 40, 'Scouts 2/6', { facing: NORTH });
      h.us('us_rifle', mx(y0) - 80, y0, 'Rifle E-1', { facing: NORTH });
      h.us('us_rifle', mx(y0) - 25, y0, 'Rifle E-2', { facing: NORTH });
      h.us('us_rifle', mx(y0) + 30, y0, 'Rifle F-1', { facing: NORTH });
      h.us('us_rifle', mx(y0) + 85, y0, 'Rifle F-2', { facing: NORTH });
      h.us('us_rifle', mx(y0 + 40), y0 + 40, 'Rifle G-1', { facing: NORTH });
      h.us('us_mg', mx(y0 + 20) - 50, y0 + 20, 'MG E-1', { facing: NORTH });
      h.us('us_mg', mx(y0 + 20) + 50, y0 + 20, 'MG F-1', { facing: NORTH });
      h.us('us_mortar', mx(y0 + 80), y0 + 80, 'Mortar H', { facing: NORTH });
      h.us('us_bazooka', mx(y0 + 30), y0 + 30, 'Bazooka H', { facing: NORTH });
      h.us('us_assault', mx(y0 + 50) + 20, y0 + 50, 'Engineers 2/6', { facing: NORTH });
      const [vx, vy] = g.map.village;
      h.vl('Buariki Village', vx, vy, 60, 2);
      const l1 = h.st('log1'), l2 = h.st('log2');
      h.vl('Bunker Line', (l1.x + l2.x) / 2, (l1.y + l2.y) / 2, 50, 2);
      const l4 = h.st('log4'); h.vl('Buariki Point', l4.x + 20, l4.y - 30, 50, 1);
    },
    update(g, dt) {
      // final charge when the garrison is broken
      if (!g._final) {
        let jp = 0; for (const s of g.soldiers) if (s.side === 'JP' && g.alive(s)) jp++;
        if (jp < 40 && g.time > 120) {
          g._final = true;
          const teams = g.teams.filter(t => t.side === 'JP' && !t.struct && g.teamAlive(t) > 0);
          let tx = 760, ty = 1200, n = 0;
          for (const s of g.soldiers) if (s.side === 'US' && g.alive(s)) { tx += s.x; ty += s.y; n++; }
          if (n) { tx = (tx - 760) / n; ty = (ty - 1200) / n; }
          if (teams.length) g.jpAI.banzai(teams, tx, ty);
        }
      }
    },
  },
];
