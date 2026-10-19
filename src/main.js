// Tarawa 1943 — application shell: screens, camera, input (mouse + touch), game loop.
import { Renderer } from './gpu/renderer.js';
import { Scene } from './gpu/scene.js';
import { Overlay } from './ui/overlay.js';
import { HUD } from './ui/hud.js';
import { Audio } from './audio/audio.js';
import { Game } from './sim/game.js';
import { SCENARIOS } from './sim/scenarios.js';
import { buildBetio } from './world/betio.js';
import { buildBuariki } from './world/buariki.js';
import { buildAtoll, ISLETS } from './world/atoll.js';
import { Terrain } from './world/terrain.js';
import { clamp, dist } from './util.js';

const $ = (id) => document.getElementById(id);
const SIM_DT = 1 / 20;
const VOICE_ACK = {
  move: ['us_move_1', 'us_move_2', 'us_move_3', 'us_ack_1'], fast: ['us_fast_1', 'us_fast_2'], sneak: ['us_sneak_1', 'us_sneak_2'],
  fire: ['us_fire_1', 'us_fire_2', 'us_fire_3'], assault: ['us_fire_2', 'us_ack_2', 'us_move_2'], defend: ['us_defend_1', 'us_ack_3'], ambush: ['us_ambush_1'],
  stop: ['us_stop_1'], smoke: ['us_smoke_1'], unload: ['us_ramp_1'], select: ['us_selected_1', 'us_selected_2', 'us_selected_3'],
};
const HIST_NOTES = [
  { islet: 'bairiki', text: 'Bairiki', tip: 'D+1 (21 Nov): 2nd Bn, 6th Marines lands against a single pillbox. Pack howitzers set up here to fire on Betio.' },
  { islet: 'eita', text: 'Eita', tip: '24 Nov: 2/6 Marines begin the march up the atoll, wading from islet to islet at low tide.' },
  { islet: 'bonriki', text: 'Bonriki', tip: 'Later the site of Hawkins Field, the airfield built after the battle.' },
  { islet: 'abaokoro', text: 'Abaokoro', tip: '25–26 Nov: patrols pursue the retreating Japanese northward.' },
  { islet: 'naa', text: 'Naa', tip: '28 Nov: the atoll is declared secure.' },
];

function cloneMap(m) {
  const T0 = m.terrain;
  const T = new Terrain(T0.w, T0.h, T0.cell);
  T.ground = T0.ground.slice(); T.obj = T0.obj.slice(); T.veg = T0.veg.slice(); T.surf = T0.surf.slice(); T.flags = T0.flags.slice();
  T.water = T0.water; T.pierDeck = T0.pierDeck;
  return { ...m, terrain: T, structures: m.structures.map(s => ({ ...s })), positions: m.positions.map(p => ({ ...p })) };
}
function loadProgress() { try { return JSON.parse(localStorage.getItem('tarawa.progress') || '{}'); } catch { return {}; } }
function saveProgress(p) { try { localStorage.setItem('tarawa.progress', JSON.stringify(p)); } catch { } }

class App {
  constructor() {
    this.gpuCanvas = $('gpu'); this.ovCanvas = $('overlay');
    this.overlay = new Overlay(this.ovCanvas);
    this.audio = new Audio();
    // close blasts shake the camera (screen pixels, decays quickly)
    this.shake = 0;
    this.audio.onShock = (k) => { if (this.screen === 'battle') this.shake = Math.max(this.shake, 3 + k * 9); };
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.selection = new Set();
    this.orderMode = null; this.losPoint = null; this.box = null; this.hoverStruct = null;
    this.speed = 1; this.paused = false; this.acc = 0;
    this.maps = {};
    this.screen = 'title';
    this.dprCap = 1.5;
    this.keys = new Set();
    this.lastAck = 0;
    this.progress = loadProgress();
  }
  async boot() {
    this.resize();
    window.addEventListener('resize', () => this.resize());
    try {
      this.renderer = await Renderer.create(this.gpuCanvas);
    } catch (e) {
      const el = $('gpu-error');
      el.classList.remove('hidden');
      el.innerHTML = `<b>WebGPU is not available.</b><br>${e.message}<br><br>Use a current Chrome, Edge or Safari (iPadOS / macOS 26+). On iPad, WebGPU requires Safari on iPadOS 26 or later, and the page must be served over HTTPS (or localhost).`;
      $('btn-start').disabled = true;
      return;
    }
    this.loading('Loading terrain textures…');
    await Promise.all([
      this.renderer.loadMaterials('assets/tex/').catch(e => console.warn('Terrain textures unavailable, using flat colours:', e)),
      this.renderer.loadSprites('assets/sprites/').catch(e => console.warn('Sprite atlas unavailable, using vector sprites:', e)),
    ]);
    this.hud = new HUD(this);
    this.bindUI();
    this.bindInput();
    // atoll backdrop behind the title
    this.loading('Charting the atoll…');
    await this.nextFrame();
    this.maps.atoll = buildAtoll();
    this.useMap(this.maps.atoll, null);
    this.cam = { x: 11500, y: 20000, zoom: 0.03 };
    this.loading(null);
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }
  nextFrame() { return new Promise(r => requestAnimationFrame(() => setTimeout(r, 0))); }
  loading(text) { const el = $('loading'); if (!text) el.classList.add('hidden'); else { el.classList.remove('hidden'); $('loading-text').textContent = text; } }
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.dprCap, this.dynScale || 9);
    this.dpr = dpr;
    this.viewW = window.innerWidth; this.viewH = window.innerHeight;
    this.overlay.resize(this.viewW, this.viewH, Math.min(window.devicePixelRatio || 1, Math.max(1, this.dprCap)));
    if (this.renderer) this.renderer.resize(Math.round(this.viewW * dpr), Math.round(this.viewH * dpr));
    else { this.gpuCanvas.width = Math.round(this.viewW * dpr); this.gpuCanvas.height = Math.round(this.viewH * dpr); }
  }
  resetInteraction() {
    this.orderMode = null; this.losPoint = null; this.fly = null; this.box = null; this.hoverStruct = null;
    this.closeRadial();
  }
  show(name) {
    this.resetInteraction();
    this.screen = name;
    for (const id of ['title', 'atoll', 'briefing', 'debrief']) $(id).classList.toggle('hidden', id !== name);
    $('hud').classList.toggle('hidden', name !== 'battle');
    if (name !== 'battle') { $('radial').classList.add('hidden'); }
  }
  useMap(map, game) {
    this.resetInteraction();
    this.map = map;
    this.renderer.setMap(map);
    this.scene = new Scene(this.renderer, map);
    this.game = game;
    this.spotHeights = game ? findSpotHeights(map.terrain) : [];
  }
  toggleTerrainView(force) {
    this.terrainView = force ?? !this.terrainView;
    $('btn-terrain').classList.toggle('on', this.terrainView);
    this.audio.ui('ui_click');
  }

  // ------------------------------------------------------------------ screens
  async enterAtoll() {
    this.audio.stopNarration();
    if (this.game) { this.audio.stopLoops(); }
    this.game = null; this.selection.clear();
    if (this.map !== this.maps.atoll) this.useMap(this.maps.atoll, null);
    this.cam = { x: 12500, y: 19500, zoom: Math.min(this.viewW / 30000, this.viewH / 34000) };
    this.show('atoll');
    this.buildAtollUI();
  }
  buildAtollUI() {
    const list = $('battles');
    list.innerHTML = '';
    SCENARIOS.forEach((sc, i) => {
      const done = this.progress[sc.id];
      const d = document.createElement('div');
      d.className = 'bcard';
      d.innerHTML = `${done ? `<span class="g">${done}</span>` : ''}<h4>${i + 1}. ${sc.name}</h4><div class="d">${sc.subtitle}</div>`;
      d.addEventListener('click', () => { this.audio.ui('ui_select'); this.startBriefing(sc); });
      list.appendChild(d);
    });
    const mk = $('atoll-markers');
    mk.innerHTML = '';
    this.atollMarks = [];
    for (const it of ISLETS) {
      const pts = it.pts; const c = pts[Math.floor(pts.length / 2)];
      const note = HIST_NOTES.find(n => n.islet === it.id);
      const el = document.createElement('div');
      let wx = c[0] + 900, wy = c[1];
      if (it.id === 'betio') { el.className = 'amark battle'; el.textContent = '⚔ BETIO · 4 battles'; wx = 3600; wy = 34500; el.onclick = () => this.flyTo(3600, 33600, 0.12); }
      else if (it.id === 'buariki') { el.className = 'amark battle'; el.textContent = '⚔ BUARIKI'; el.onclick = () => this.startBriefing(SCENARIOS[4]); wx = c[0] - 1600; }
      else { el.className = 'amark note'; el.innerHTML = `${it.name}${note ? `<div class="tip">${note.tip}</div>` : ''}`; if (it.pts[0][0] > 15000 && it.pts[0][1] < 31000) wx = c[0] + 1500; else wy = c[1] + 900; }
      mk.appendChild(el);
      this.atollMarks.push({ el, x: wx, y: wy });
    }
    const tf = document.createElement('div'); tf.className = 'amark note'; tf.innerHTML = 'Task Force 53<div class="tip">Battleships Maryland, Colorado and Tennessee, cruisers and destroyers. The pre-landing bombardment lasted three hours — and left most of the bunkers intact.</div>';
    mk.appendChild(tf); this.atollMarks.push({ el: tf, x: 1500, y: 28500 });
    const lg = document.createElement('div'); lg.className = 'amark note'; lg.textContent = 'TARAWA LAGOON';
    mk.appendChild(lg); this.atollMarks.push({ el: lg, x: 14500, y: 22000 });
  }
  flyTo(x, y, zoom) { this.fly = { x0: this.cam.x, y0: this.cam.y, z0: this.cam.zoom, x, y, z: zoom, t: 0 }; }

  async startBriefing(sc) {
    this.audio.stopNarration();
    this.loading('Preparing ' + sc.name + '…');
    await this.nextFrame();
    if (!this.maps[sc.map]) this.maps[sc.map] = sc.map === 'betio' ? buildBetio() : buildBuariki();
    const map = cloneMap(this.maps[sc.map]);
    const scClone = { ...sc };
    const game = new Game(map, scClone);
    this.useMap(map, game);
    this.sc = sc;
    this.selection.clear();
    this.cam = { x: sc.camera.x, y: sc.camera.y, zoom: sc.camera.zoom };
    this.paused = true;
    this.loading(null);
    $('brief-sub').textContent = sc.subtitle;
    $('brief-title').textContent = sc.name;
    $('brief-text').innerHTML = sc.briefing;
    const usTeams = game.teams.filter(t => t.side === 'US' && !t.vehicle);
    const jpSoldiers = game.soldiers.filter(s => s.side === 'JP').length;
    const veh = game.vehicles.filter(v => v.side === 'US' && v.state !== 'destroyed').map(v => v.name);
    const pending = (game.sc._waves || []).length;
    $('brief-oob').innerHTML = `<b>Your forces at start:</b> ${usTeams.length} teams (${usTeams.reduce((a, t) => a + t.soldiers.length, 0)} men)${veh.length ? ', ' + veh.length + ' vehicles/craft' : ''}${pending ? `, ${pending} reinforcement waves scheduled` : ''}.<br><b>Intelligence estimate:</b> about ${Math.round(jpSoldiers / 10) * 10} Japanese.<br><b>Time limit:</b> ${Math.round(sc.timeLimit / 60)} minutes.<br><b>Fire support:</b> ${sc.support.naval} naval, ${sc.support.air} air${sc.support.star ? ', ' + sc.support.star + ' star shells' : ''}.`;
    this.show('briefing');
    await this.audio.init().catch(() => { });
    this.audio.resume();
    this.audio.narrate(sc.narration);
  }
  beginBattle() {
    this.audio.stopNarration();
    this.show('battle');
    this.hud.reset(this.game);
    this.paused = false; this.setSpeed(1); this.endShown = false;
    this.acc = 0;
    this.audio.play('bugle', undefined, undefined, 0.35);
    const first = this.game.teams.find(t => t.side === 'US' && this.game.teamAlive(t) > 0 && !t.vehicle && !t.embarked) || this.game.teams.find(t => t.side === 'US');
    if (first) this.selectTeam(first, false);
  }
  endScreen() {
    const g = this.game, r = g.result;
    this.show('debrief');
    const sc = this.sc;
    const order = ['Defeat', 'Draw', 'Marginal Victory', 'Victory', 'Decisive Victory'];
    const prev = this.progress[sc.id];
    if (!prev || order.indexOf(r.grade) > order.indexOf(prev)) { this.progress[sc.id] = r.grade; saveProgress(this.progress); }
    $('db-sub').textContent = `${sc.name} · ${r.reason === 'time' ? 'Time expired' : r.reason === 'cleared' ? 'Enemy eliminated' : r.reason === 'ceasefire' ? 'Cease fire' : 'Forces destroyed'}`;
    $('db-grade').textContent = r.grade;
    const st = r.stats;
    const best = g.soldiers.filter(s => s.side === 'US' && s.kills >= 1).sort((a, b) => b.kills - a.kills).slice(0, 5);
    $('db-body').innerHTML = `
      <div class="stats">
        <div class="stat"><b>${st.usKIA}</b><span>Marines killed</span></div>
        <div class="stat"><b>${st.usWIA}</b><span>Marines wounded</span></div>
        <div class="stat"><b>${st.jpKIA}</b><span>Japanese killed</span></div>
        <div class="stat"><b>${st.structs}</b><span>Fortifications destroyed</span></div>
        <div class="stat"><b>${st.vehLost}</b><span>Craft / vehicles lost</span></div>
        <div class="stat"><b>${Math.round(r.time / 60)} min</b><span>Battle time</span></div>
      </div>
      <table class="vl">${g.vls.map(v => `<tr><td>${v.name}</td><td>${v.value} pt</td><td style="color:${v.owner === 'US' ? 'var(--us)' : 'var(--jp)'}">${v.owner === 'US' ? 'US Marines' : 'Japanese'}</td></tr>`).join('')}</table>
      ${best.length ? `<h4 style="margin-top:14px">Commendations</h4>${best.map((s, i) => `<div>${i === 0 ? '🎖 Navy Cross' : i < 3 ? '🎖 Silver Star' : '🎖 Bronze Star'} — ${s.rank} ${s.name}, ${s.team.name} (${Math.floor(s.kills)} enemy)${s.state === 'dead' ? ' <i>(posthumous)</i>' : ''}</div>`).join('')}` : ''}
      <p style="margin-top:14px;color:var(--ink-dim);font-size:12px">Historically, the 2nd Marine Division lost about 1,000 killed and 2,100 wounded in 76 hours. Of roughly 4,700 defenders, 17 Japanese and 129 Korean labourers were taken prisoner.</p>`;
    const idx = SCENARIOS.indexOf(sc);
    $('db-next').classList.toggle('hidden', idx >= SCENARIOS.length - 1);
    this.audio.narrate(r.grade.includes('Victory') ? 'nar_victory' : 'nar_defeat');
  }

  // ------------------------------------------------------------------ selection & orders
  selectTeam(team, add) {
    if (!add) { for (const t of this.selection) t.selected = false; this.selection.clear(); }
    if (add && this.selection.has(team)) { this.selection.delete(team); team.selected = false; }
    else { this.selection.add(team); team.selected = true; }
    this.closeRadial();
    if (this.game && team && this.performanceAck(0.8)) {
      const l = this.game.leader(team) || team.soldiers[0];
      const v = team.vehicle || team.embarked;
      this.audio.voice(pick(VOICE_ACK.select), v ? v.x : l.x, v ? v.y : l.y, { prio: 1, tone: this.game.teamTone(team) });
    }
    this.hud.update(true);
  }
  clearSelection() { for (const t of this.selection) t.selected = false; this.selection.clear(); this.hud.update(true); }
  performanceAck(cd) { const now = performance.now() / 1000; if (now - this.lastAck < cd) return false; this.lastAck = now; return true; }
  centerOn(team) { const [x, y] = this.game.teamCenter(team); this.flyTo(x, y, Math.max(this.cam.zoom, 1.4)); }

  issueOrder(kind, wx, wy, target) {
    const g = this.game;
    if (!g) return;
    const teams = [...this.selection].filter(t => g.canOrder(t) || t.vehicle || t.embarked);
    if (!teams.length) return;
    // spread multiple teams around the destination
    const n = teams.length;
    const [cx, cy] = teams.reduce((a, t) => { const c = g.teamCenter(t); return [a[0] + c[0] / n, a[1] + c[1] / n]; }, [0, 0]);
    const dir = Math.atan2(wy - cy, wx - cx), perp = dir + Math.PI / 2;
    let ok = false;
    teams.forEach((t, i) => {
      const off = (i - (n - 1) / 2) * 16;
      const tx = wx + Math.cos(perp) * off * (target ? 0 : 1), ty = wy + Math.sin(perp) * off * (target ? 0 : 1);
      const [tcx, tcy] = g.teamCenter(t);
      if (kind === 'smoke') ok = g.popSmoke(t, tx, ty) || ok;
      else if (kind === 'stop') ok = g.order(t, 'stop') || ok;
      else if (kind === 'unload') ok = g.order(t, 'unload') !== false || ok;
      else if (kind === 'defend' || kind === 'ambush') ok = g.order(t, kind, tcx, tcy, null, { facing: Math.atan2(wy - tcy, wx - tcx) }) || ok;
      else if (kind === 'assault') { if (g.hasAssault(t) || t.vehicle) ok = g.order(t, 'assault', tx, ty, target) || ok; else ok = g.order(t, 'fire', tx, ty, target) || ok; }
      else ok = g.order(t, kind, tx, ty, target) || ok;
    });
    this.audio.ui('ui_click');
    if (ok !== false) {
      const t0 = teams[0];
      const v = t0.vehicle || t0.embarked;
      const l = g.leader(t0) || t0.soldiers[0];
      if (this.performanceAck(0.6)) this.audio.voice(pick(VOICE_ACK[kind] || ['us_ack_1']), v ? v.x : l.x, v ? v.y : l.y, { prio: 2, tone: g.teamTone(t0) });
    }
    this.hud.update(true);
  }
  targetAt(wx, wy) {
    const g = this.game;
    let best = null, bd = Math.max(3, 14 / this.cam.zoom);
    for (const s of g.soldiers) {
      if (s.side !== 'JP' || !g.alive(s) || s.visT[0] < g.time || s.inStruct) continue;
      const d = dist(wx, wy, s.x, s.y); if (d < bd) { bd = d; best = s; }
    }
    for (const v of g.vehicles) {
      if (v.side !== 'JP' || v.state === 'destroyed' || v.visT[0] < g.time) continue;
      const d = dist(wx, wy, v.x, v.y) - 2; if (d < bd) { bd = d; best = v; }
    }
    if (best) return best;
    for (const st of g.structures) {
      if (!st.known[0] || st.destroyed) continue;
      if (dist(wx, wy, st.x, st.y) < Math.max(st.w, st.h) * 0.6 + Math.max(3, 10 / this.cam.zoom)) return st;
    }
    return null;
  }
  friendlyAt(wx, wy) {
    const g = this.game;
    let best = null, bd = Math.max(2.5, 16 / this.cam.zoom);
    for (const v of g.vehicles) {
      if (v.side !== 'US' || v.carried) continue;
      if (v.state === 'destroyed' && !(v.team && g.teamAlive(v.team))) continue;
      const d = dist(wx, wy, v.x, v.y) - v.spec.len * 0.4;
      if (d < bd) { bd = d; best = v.cargo.length && !v.team ? v.cargo[0] : (v.team && v.team.vehicle ? v.team : v.cargo[0] || v.team); }
    }
    for (const s of g.soldiers) {
      if (s.side !== 'US' || s.state === 'dead' || s.inVeh) continue;
      const d = dist(wx, wy, s.x, s.y);
      if (d < bd) { bd = d; best = s.team; }
    }
    if (this.cam.zoom < 0.75) for (const t of g.teams) {
      if (t.side !== 'US' || !g.teamAlive(t)) continue;
      const [cx, cy] = g.teamCenter(t);
      const d = dist(wx, wy, cx, cy) - 10 / this.cam.zoom;
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  // ------------------------------------------------------------------ radial order menu
  openRadial(sx, sy, wx, wy, target) {
    const g = this.game;
    const sel = [...this.selection];
    if (!sel.length) return;
    const R = $('radial');
    R.innerHTML = '';
    R.classList.remove('hidden');
    const isStruct = target && target.garrison !== undefined;
    const enemy = target && !isStruct;
    const anyInf = sel.some(t => !t.vehicle && !t.embarked);
    const canAssault = sel.some(t => !t.vehicle && !t.embarked && g.hasAssault(t));
    const canUnload = sel.some(t => (t.vehicle && (t.vehicle.cargo.length || t.vehicle.cargoVeh)) || t.embarked);
    let opts;
    if (target) {
      opts = [['fire', isStruct ? 'Fire on ' + 'bunker' : 'Fire', 'fire']];
      if (canAssault && (isStruct || (target.inStruct))) opts.push(['assault', 'Assault', 'assault']);
      opts.push(['move', 'Move'], ['fast', 'Fast'], ['sneak', 'Sneak']);
    } else {
      opts = [['move', 'Move'], ['fast', 'Fast'], ['sneak', 'Sneak'], ['fire', 'Area fire', 'fire'], ['defend', 'Defend'], ['ambush', 'Ambush']];
      if (anyInf && sel.some(t => t.smokeN > 0)) opts.push(['smoke', 'Smoke']);
      if (canUnload) opts.push(['unload', 'Unload']);
    }
    opts.push(['cancel', '✕', 'cancel']);
    const n = opts.length;
    const coarse = matchMedia('(pointer: coarse)').matches;
    const rad = (n > 7 ? 92 : 80) * (coarse ? 1.3 : 1);
    const cx = clamp(sx, rad + 50, this.viewW - rad - 50), cy = clamp(sy, rad + 60, this.viewH - rad - 140);
    const ctr = document.createElement('div'); ctr.className = 'center'; ctr.style.left = sx + 'px'; ctr.style.top = sy + 'px'; R.appendChild(ctr);
    opts.forEach(([k, label, cls], i) => {
      const a = -Math.PI / 2 + i / n * Math.PI * 2;
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.style.left = (cx + Math.cos(a) * rad) + 'px'; b.style.top = (cy + Math.sin(a) * rad * 0.82) + 'px';
      b.addEventListener('pointerup', (e) => {
        e.stopPropagation();
        if (k !== 'cancel') this.issueOrder(k, wx, wy, k === 'move' || k === 'fast' || k === 'sneak' ? null : target);
        this.closeRadial();
      });
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      R.appendChild(b);
    });
    this.losPoint = [wx, wy];
    this.radialOpen = true;
  }
  closeRadial() { $('radial').classList.add('hidden'); this.radialOpen = false; if (!this.orderMode) this.losPoint = null; }

  setSpeed(s) {
    if (s === 0) this.paused = !this.paused;
    else if (s > 0) { this.speed = s; this.paused = false; }
    for (const b of document.querySelectorAll('.speed button')) b.classList.toggle('on', (+b.dataset.speed === 0 && this.paused) || (!this.paused && +b.dataset.speed === this.speed));
  }

  // ------------------------------------------------------------------ UI bindings
  bindUI() {
    $('btn-start').addEventListener('click', () => {
      if (this.screen !== 'title') return;
      this.audio.init().then(() => { this.audio.resume(); if (this.screen === 'atoll') this.audio.narrate('nar_campaign'); }).catch(() => { });
      this.enterAtoll();
    });
    $('btn-credits').onclick = () => this.showCredits();
    $('credits-close').onclick = () => $('credits').classList.add('hidden');
    $('btn-brief-back').onclick = () => this.enterAtoll();
    $('btn-brief-go').onclick = () => this.beginBattle();
    $('btn-narrate').onclick = () => { if (this.audio.narration) this.audio.stopNarration(); else this.audio.narrate(this.sc.narration); };
    $('db-map').onclick = () => this.enterAtoll();
    $('db-retry').onclick = () => this.startBriefing(this.sc);
    $('db-next').onclick = () => { const i = SCENARIOS.indexOf(this.sc); this.startBriefing(SCENARIOS[Math.min(SCENARIOS.length - 1, i + 1)]); };
    for (const b of document.querySelectorAll('.speed button')) b.onclick = () => this.setSpeed(+b.dataset.speed);
    for (const b of document.querySelectorAll('#orderbar button')) b.addEventListener('click', () => {
      const o = b.dataset.order;
      this.audio.ui('ui_click');
      if (o === 'stop' || o === 'unload') { this.issueOrder(o, 0, 0, null); return; }
      this.orderMode = this.orderMode === o ? null : o;
      this.hud.update(true);
    });
    for (const k of ['naval', 'air', 'star']) $('sup-' + k).addEventListener('click', () => {
      this.orderMode = this.orderMode === 'support:' + k ? null : 'support:' + k;
      this.audio.ui('ui_click');
      if (this.orderMode && !this.game.hasRadio() && k !== 'star') { this.game.radio('rad_no_radio', "Radio's waterlogged — no contact with the ships. Land a command post or NGF team first."); this.orderMode = null; }
      this.hud.update(true);
    });
    $('btn-menu').onclick = () => this.togglePauseMenu();
    $('btn-terrain').onclick = () => this.toggleTerrainView();
    $('pm-resume').onclick = () => this.togglePauseMenu(false);
    $('pm-help').onclick = () => { $('help').classList.remove('hidden'); };
    $('help-close').onclick = () => $('help').classList.add('hidden');
    $('pm-cease').onclick = () => { this.togglePauseMenu(false); this.game.end('ceasefire'); this.drainEvents(this.game); };
    $('pm-restart').onclick = () => { this.togglePauseMenu(false); this.startBriefing(this.sc); };
    $('pm-quit').onclick = () => { this.togglePauseMenu(false); this.enterAtoll(); };
    $('pm-vol').oninput = (e) => { this.audio.volume = +e.target.value; if (this.audio.master) this.audio.master.gain.value = this.audio.volume; };
    $('pm-q').onchange = (e) => { this.dprCap = +e.target.value; this.dynScale = null; this.resize(); };
    const mm = $('minimap');
    const mmMove = (e) => { const [x, y] = this.hud.minimapToWorld(e.clientX, e.clientY); this.cam.x = x; this.cam.y = y; };
    mm.addEventListener('pointerdown', (e) => { mm.setPointerCapture(e.pointerId); mmMove(e); mm._drag = true; });
    mm.addEventListener('pointermove', (e) => { if (mm._drag) mmMove(e); });
    mm.addEventListener('pointerup', () => { mm._drag = false; });
    mm.addEventListener('pointercancel', () => { mm._drag = false; });
  }
  async showCredits() {
    $('credits').classList.remove('hidden');
    const parts = await Promise.all(['assets/tex/CREDITS.md', 'assets/sfx/CREDITS.md', 'assets/voice/CREDITS.md'].map(u => fetch(u).then(r => r.ok ? r.text() : '').catch(() => '')));
    $('credits-body').innerHTML = parts.map(md).join('<hr>');
  }
  togglePauseMenu(force) {
    const el = $('pausemenu');
    const show = force ?? el.classList.contains('hidden');
    el.classList.toggle('hidden', !show);
    if (show) { this.wasPaused = this.paused; this.paused = true; }
    else { this.paused = this.wasPaused || false; $('help').classList.add('hidden'); }
    this.setSpeed(-1);
  }

  // ------------------------------------------------------------------ input
  s2w(sx, sy) { return [this.cam.x + (sx - this.viewW / 2) / this.cam.zoom, this.cam.y + (sy - this.viewH / 2) / this.cam.zoom]; }
  // px per metre; battle max 32 → a Marine fills ~70 px
  zoomLimits() { return this.screen === 'atoll' ? [0.012, 0.5] : [0.22, 32]; }
  zoomAt(sx, sy, factor) {
    const [wx, wy] = this.s2w(sx, sy);
    const [minZ, maxZ] = this.zoomLimits();
    this.cam.zoom = clamp(this.cam.zoom * factor, minZ, maxZ);
    this.cam.x = wx - (sx - this.viewW / 2) / this.cam.zoom;
    this.cam.y = wy - (sy - this.viewH / 2) / this.cam.zoom;
  }
  bindInput() {
    const el = this.ovCanvas;
    const P = new Map();
    let gesture = 'none', pinch = null, lpTimer = null, downInfo = null;
    const interactive = () => this.screen === 'battle' || this.screen === 'atoll' || this.screen === 'briefing';
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      if (!interactive()) return;
      el.setPointerCapture(e.pointerId);
      this.audio.resume();
      if (this.radialOpen) { this.closeRadial(); gesture = 'consumed'; P.set(e.pointerId, { x: e.clientX, y: e.clientY }); return; }
      P.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
      if (gesture === 'pinch') return;
      if (P.size >= 2) {
        clearTimeout(lpTimer);
        const [a, b] = [...P.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, zoom: this.cam.zoom, w: this.s2w((a.x + b.x) / 2, (a.y + b.y) / 2) };
        gesture = 'pinch'; this.box = null;
        return;
      }
      downInfo = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button, type: e.pointerType, shift: e.shiftKey || e.ctrlKey || e.metaKey };
      gesture = 'pending';
      if (e.pointerType !== 'mouse') {
        clearTimeout(lpTimer);
        lpTimer = setTimeout(() => { if (gesture === 'pending') { gesture = 'consumed'; this.longPress(downInfo.x, downInfo.y); } }, 520);
      }
    });
    el.addEventListener('pointermove', (e) => {
      const p = P.get(e.pointerId);
      if (!p) { if (e.pointerType === 'mouse') this.hover(e.clientX, e.clientY); return; }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (gesture === 'pinch' && P.size >= 2) {
        const [a, b] = [...P.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        const [minZ, maxZ] = this.zoomLimits();
        this.cam.zoom = clamp(pinch.zoom * d / Math.max(10, pinch.d), minZ, maxZ);
        this.cam.x = pinch.w[0] - (cx - this.viewW / 2) / this.cam.zoom;
        this.cam.y = pinch.w[1] - (cy - this.viewH / 2) / this.cam.zoom;
        return;
      }
      if (gesture === 'pending' && Math.hypot(e.clientX - downInfo.x, e.clientY - downInfo.y) > 8) {
        clearTimeout(lpTimer);
        if (downInfo.type === 'mouse' && downInfo.button === 0 && this.screen === 'battle' && !this.orderMode) { gesture = 'box'; this.box = { x0: downInfo.x, y0: downInfo.y, x1: e.clientX, y1: e.clientY }; }
        else gesture = 'pan';
      }
      if (gesture === 'pan') { this.cam.x -= dx / this.cam.zoom; this.cam.y -= dy / this.cam.zoom; this.fly = null; }
      if (gesture === 'box') { this.box.x1 = e.clientX; this.box.y1 = e.clientY; }
      if (e.pointerType === 'mouse') this.hover(e.clientX, e.clientY);
    });
    const up = (e) => {
      const p = P.get(e.pointerId);
      P.delete(e.pointerId);
      clearTimeout(lpTimer);
      if (!p) return;
      if (gesture === 'pinch') { if (P.size === 0) gesture = 'none'; return; }
      if (gesture === 'pending' && e.type === 'pointerup') {
        if (downInfo.type === 'mouse' && downInfo.button === 2) this.context(e.clientX, e.clientY);
        else if (downInfo.button === 0 || downInfo.type !== 'mouse') this.tap(e.clientX, e.clientY, downInfo.shift, downInfo.type);
      }
      if (gesture === 'box') this.finishBox(downInfo.shift);
      gesture = 'none';
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!interactive()) return;
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      this.zoomAt(e.clientX, e.clientY, f);
      this.fly = null;
    }, { passive: false });
    // iOS Safari: block page-level gesture zoom
    for (const t of ['gesturestart', 'gesturechange']) document.addEventListener(t, (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.key(e, true));
    window.addEventListener('keyup', (e) => this.key(e, false));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('visibilitychange', () => {
      this.keys.clear();
      if (document.hidden) { this.audio.suspend(); if (this.screen === 'battle' && !this.paused) { this.paused = true; this.autoPaused = true; this.setSpeed(-1); } }
      else { this.audio.resume(); if (this.autoPaused) { this.autoPaused = false; this.paused = false; this.setSpeed(-1); } }
    });
    // iOS only unlocks / resumes audio inside a real user gesture (pointerup / click, not touchstart)
    document.addEventListener('pointerup', () => this.audio.resume(), true);
    document.addEventListener('click', () => this.audio.resume(), true);
  }
  hover(sx, sy) {
    if (this.screen !== 'battle' || !this.game) return;
    const [wx, wy] = this.s2w(sx, sy);
    this.cursorW = [wx, wy];
    const t = this.targetAt(wx, wy);
    this.hoverStruct = t && t.garrison !== undefined ? t : null;
    this.scene.hoverTeam = t ? null : this.friendlyAt(wx, wy);
    if (this.orderMode && !this.orderMode.startsWith('support')) this.losPoint = [wx, wy];
    this.ovCanvas.style.cursor = this.orderMode ? 'crosshair' : t && this.selection.size ? 'crosshair' : 'default';
  }
  tap(sx, sy, shift, type) {
    if (this.screen === 'atoll') return;
    if (this.screen !== 'battle') return;
    const [wx, wy] = this.s2w(sx, sy);
    const g = this.game;
    if (this.orderMode) {
      const m = this.orderMode;
      if (m.startsWith('support:')) { g.callSupport(m.slice(8), wx, wy); this.orderMode = null; this.hud.update(true); return; }
      this.issueOrder(m, wx, wy, m === 'fire' || m === 'assault' ? this.targetAt(wx, wy) : null);
      if (!shift) { this.orderMode = null; this.losPoint = null; }
      return;
    }
    const f = this.friendlyAt(wx, wy);
    if (f) { this.selectTeam(f, shift); this.audio.ui('ui_select'); return; }
    if (type !== 'mouse') {
      if (this.selection.size) this.openRadial(sx, sy, wx, wy, this.targetAt(wx, wy));
      return;
    }
    if (!shift) this.clearSelection();
  }
  context(sx, sy) {
    if (this.screen !== 'battle' || !this.selection.size) return;
    const [wx, wy] = this.s2w(sx, sy);
    this.orderMode = null;
    this.openRadial(sx, sy, wx, wy, this.targetAt(wx, wy));
  }
  longPress(sx, sy) {
    if (this.screen !== 'battle') return;
    const [wx, wy] = this.s2w(sx, sy);
    const f = this.friendlyAt(wx, wy);
    if (f) { this.selectTeam(f, true); if (navigator.vibrate) navigator.vibrate(15); return; }
    if (this.selection.size) this.openRadial(sx, sy, wx, wy, this.targetAt(wx, wy));
  }
  finishBox(add) {
    const b = this.box; this.box = null;
    if (!b || !this.game) return;
    const [ax, ay] = this.s2w(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1));
    const [bx, by] = this.s2w(Math.max(b.x0, b.x1), Math.max(b.y0, b.y1));
    if (!add) { for (const t of this.selection) t.selected = false; this.selection.clear(); }
    let n = 0;
    for (const t of this.game.teams) {
      if (t.side !== 'US' || (t.vehicle && t.vehicle.carried)) continue;
      if (!this.game.teamAlive(t) && !(t.vehicle && t.vehicle.state !== 'destroyed')) continue;
      const [cx, cy] = this.game.teamCenter(t);
      if (cx >= ax && cx <= bx && cy >= ay && cy <= by) { this.selection.add(t); t.selected = true; n++; }
    }
    if (n) this.audio.voice(pick(VOICE_ACK.select), (ax + bx) / 2, (ay + by) / 2, { tone: this.game.teamTone(this.selection.values().next().value) });
    this.hud.update(true);
  }
  key(e, down) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    const PAN = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyA', 'KeyS', 'KeyD'];
    if (PAN.includes(e.code)) { if (down) this.keys.add(e.code); else this.keys.delete(e.code); if (this.screen === 'battle') e.preventDefault(); return; }
    if (!down || this.screen !== 'battle') return;
    const k = e.key.toLowerCase();
    const pauseOpen = !$('pausemenu').classList.contains('hidden');
    // order hotkeys (WASD / arrows pan the camera)
    const map = { m: 'move', r: 'fast', c: 'sneak', f: 'fire', g: 'assault', q: 'smoke', e: 'defend', z: 'ambush' };
    if (k === ' ') { e.preventDefault(); if (!pauseOpen) this.setSpeed(0); }
    else if (k === 'escape') { if (this.radialOpen) this.closeRadial(); else if (this.orderMode) { this.orderMode = null; this.losPoint = null; } else this.togglePauseMenu(); this.hud.update(true); }
    else if (pauseOpen) return;
    else if (k === '1' || k === '2' || k === '3') this.setSpeed([1, 2, 4][+k - 1]);
    else if (k === 'x') this.issueOrder('stop', 0, 0, null);
    else if (k === 't') this.toggleTerrainView();
    else if (k === 'u') this.issueOrder('unload', 0, 0, null);
    else if (k === 'tab') {
      e.preventDefault();
      const list = this.game.teams.filter(t => t.side === 'US' && (this.game.teamAlive(t) > 0) && !(t.vehicle && t.vehicle.carried));
      if (!list.length) return;
      const cur = [...this.selection][0];
      const nxt = list[(list.indexOf(cur) + (e.shiftKey ? list.length - 1 : 1)) % list.length];
      this.selectTeam(nxt, false); this.centerOn(nxt);
    }
    else if (e.code === 'Equal' || e.code === 'NumpadAdd') this.zoomAt(this.viewW / 2, this.viewH / 2, 1.25);
    else if (e.code === 'Minus' || e.code === 'NumpadSubtract') this.zoomAt(this.viewW / 2, this.viewH / 2, 0.8);
    else if (map[k] && this.selection.size && !e.repeat && !e.metaKey && !e.ctrlKey) { this.orderMode = map[k]; this.hud.update(true); }
  }

  // ------------------------------------------------------------------ frame loop
  frame(t) {
    requestAnimationFrame((tt) => this.frame(tt));
    const dtReal = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    this.adaptResolution(dtReal);
    if (!this.renderer) return;
    if (this.renderer.lost) {
      if (!this.lostShown) { this.lostShown = true; this.loading('Graphics device was lost (iPad memory pressure or the tab was backgrounded). Tap to reload.'); $('loading').onclick = () => location.reload(); }
      return;
    }
    // camera fly
    if (this.fly) {
      const f = this.fly; f.t = Math.min(1, f.t + dtReal * 1.6);
      const e = f.t * f.t * (3 - 2 * f.t);
      this.cam.x = f.x0 + (f.x - f.x0) * e; this.cam.y = f.y0 + (f.y - f.y0) * e;
      this.cam.zoom = Math.exp(Math.log(f.z0) + (Math.log(f.z) - Math.log(f.z0)) * e);
      if (f.t >= 1) this.fly = null;
    }
    // keyboard pan (arrows always, WASD unless an order hotkey is wanted)
    const pan = 600 * dtReal / this.cam.zoom;
    const K = this.keys;
    if (K.size && this.screen === 'battle') {
      if (K.has('ArrowLeft') || K.has('KeyA')) this.cam.x -= pan;
      if (K.has('ArrowRight') || K.has('KeyD')) this.cam.x += pan;
      if (K.has('ArrowUp') || K.has('KeyW')) this.cam.y -= pan;
      if (K.has('ArrowDown') || K.has('KeyS')) this.cam.y += pan;
    }
    const map = this.map;
    if (map) {
      const b = this.game ? this.game.bounds : [0, 0, map.w, map.h];
      this.cam.x = clamp(this.cam.x, b[0] - 200, b[2] + 200);
      this.cam.y = clamp(this.cam.y, b[1] - 200, b[3] + 200);
    }
    const g = this.game;
    let simDt = 0;
    if (g && this.screen === 'battle' && !this.paused && !g.ended) {
      this.acc += dtReal * this.speed;
      let steps = 0;
      const t0 = performance.now();
      while (this.acc >= SIM_DT && steps < 12) {
        g.step(SIM_DT); this.acc -= SIM_DT; steps++; simDt += SIM_DT;
        this.drainEvents(g);
        if (performance.now() - t0 > 28) { this.acc = Math.min(this.acc, SIM_DT); break; }
      }
    }
    if (g && g.ended && this.screen === 'battle' && !this.endShown) { this.endShown = true; setTimeout(() => { if (this.game === g) this.endScreen(); }, 2500); }
    if (g) this.renderer.syncTerrain(g.T);
    const interp = g && !this.paused ? clamp(this.acc / SIM_DT, 0, 1) : 1;
    const vw = this.viewW / this.cam.zoom, vh = this.viewH / this.cam.zoom;
    const view = [this.cam.x - vw / 2, this.cam.y - vh / 2, this.cam.x + vw / 2, this.cam.y + vh / 2];
    this.scene.build(g, this.cam, view, interp, this.cam.zoom, g && this.screen === 'battle' ? simDt : dtReal * 0.2);
    const light = g ? g.light : { ambient: 1, night: 0, tint: [1, 1, 1] };
    const tint = light.tint || [1, 1, 1];
    const env = {
      time: t / 1000, water: map.terrain.water, tint, ambient: light.ambient, night: light.night || 0,
      sun: [-0.45, -0.55, 0.7], terrainView: this.terrainView && this.screen === 'battle', shadow: clamp(1 - (light.night || 0) * 1.3, 0, 1), lights: this.scene.lights(g, view),
    };
    let sx = 0, sy = 0;
    if (this.shake > 0.2) {
      sx = (Math.random() - 0.5) * 2 * this.shake / this.cam.zoom; sy = (Math.random() - 0.5) * 2 * this.shake / this.cam.zoom;
      this.shake *= Math.exp(-dtReal * 7);
    } else this.shake = 0;
    this.renderer.render({ x: this.cam.x + sx, y: this.cam.y + sy, zoomDev: this.cam.zoom * this.dpr }, env, this.scene.alpha, this.scene.add, this.scene.shadows);
    // overlay & HUD
    if (this.screen === 'battle') {
      this.overlay.draw(this);
      this.hudT = (this.hudT || 0) + dtReal;
      if (this.hudT > 0.25) { this.hudT = 0; this.hud.update(); }
      this.mmT = (this.mmT || 0) + dtReal;
      if (this.mmT > 0.1) { this.mmT = 0; this.hud.drawMinimap(); }
    } else if (this.screen === 'atoll' || this.screen === 'title') {
      this.overlay.clear();
      if (this.screen === 'atoll') {
        for (const m of this.atollMarks || []) {
          const [sx, sy] = this.overlay.w2s(this.cam, m.x, m.y);
          m.el.style.left = sx + 'px'; m.el.style.top = sy + 'px';
        }
      }
      if (this.screen === 'title') { this.cam.x += dtReal * 60; if (this.cam.x > 16000) this.cam.x = 6000; }
    } else this.overlay.clear();
    // audio
    this.audio.setListener(this.cam.x, this.cam.y, this.cam.zoom, this.viewW);
    if (this.audio.ctx) {
      this.audio.update();
      this.audioT = (this.audioT || 0) + dtReal;
      if (this.audioT > 0.2) { this.audioT = 0; this.audio.updateLoops(this.screen === 'battle' ? g : null); }
    }
  }
  // Dynamic resolution: drop the render scale when frames are slow (iPad thermals, big zoomed-out views), restore when fast.
  adaptResolution(dt) {
    if (document.hidden) return;
    this.ftAcc = (this.ftAcc || 0) + dt; this.ftN = (this.ftN || 0) + 1;
    if (this.ftAcc < 2) return;
    const avg = this.ftAcc / this.ftN; this.ftAcc = 0; this.ftN = 0;
    const maxScale = Math.min(window.devicePixelRatio || 1, this.dprCap);
    const cur = Math.min(this.dynScale || maxScale, maxScale);
    let next = cur;
    if (avg > 1 / 40 && cur > 0.75) next = Math.max(0.75, cur - 0.25);
    else if (avg < 1 / 55 && cur < maxScale) next = Math.min(maxScale, cur + 0.125);
    if (next !== cur) { this.dynScale = next; this.resize(); }
  }
  drainEvents(g) {
    const fx = this.scene.fx;
    for (const e of g.fx) {
      switch (e.t) {
        case 'sound': this.audio.play(e.id, e.x, e.y, e.vol, e.rate); break;
        case 'voice': this.audio.voice(e.id, e.x, e.y, { radio: e.radio, prio: e.prio, tone: e.tone }); break;
        case 'whiz': this.audio.whiz(e.x, e.y, e.cls); break;
        case 'impact': fx.handle(e, g); if (!e.hard) this.audio.impact(e.x, e.y, e.water); break;
        default: fx.handle(e, g);
      }
    }
    g.fx.length = 0;
  }
}
function pick(a) { return a[(Math.random() * a.length) | 0]; }
// tiny markdown renderer for the credits files (headings, tables, lists, links, bold)
function md(text) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(https?:\/\/[^\s<|;)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  const out = []; const lines = text.split('\n'); let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { if (!/^\s*\|[-\s|:]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().slice(1, -1).split('|')); i++; }
      out.push('<table>' + rows.map((r, k) => '<tr>' + r.map(c => k ? `<td>${inline(c.trim())}</td>` : `<th>${inline(c.trim())}</th>`).join('') + '</tr>').join('') + '</table>');
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`);
    else if (/^\s*[-*]\s+/.test(l)) out.push(`<div>• ${inline(l.replace(/^\s*[-*]\s+/, ''))}</div>`);
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
    i++;
  }
  return out.join('');
}

const app = new App();
window.tarawa = app;
app.boot();

// Spot heights for the elevation view: the highest point of each ~40 m block that also tops everything within 70 m.
function findSpotHeights(T) {
  const out = [], B = 40, R = 70;
  const cand = [];
  for (let by = 0; by < T.h; by += B) for (let bx = 0; bx < T.w; bx += B) {
    let best = -1e9, bxm = 0, bym = 0;
    for (let y = by; y < Math.min(T.h, by + B); y += T.cell) for (let x = bx; x < Math.min(T.w, bx + B); x += T.cell) {
      const g = T.groundAt(x, y); if (g > best) { best = g; bxm = x; bym = y; }
    }
    if (best - T.water > 0.6) cand.push({ x: bxm, y: bym, h: best });
  }
  for (const c of cand) if (!cand.some(o => o !== c && o.h > c.h && Math.hypot(o.x - c.x, o.y - c.y) < R)) out.push({ x: c.x, y: c.y, e: c.h - T.water });
  return out;
}
