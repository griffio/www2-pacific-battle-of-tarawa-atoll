// DOM HUD: unit cards, team details, message log, objectives, fire-support & speed controls, minimap.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class HUD {
  constructor(app) {
    this.app = app;
    this.cards = new Map();
    this.units = $('units'); this.details = $('details'); this.logEl = $('log'); this.vlEl = $('hud-vls');
    this.clock = $('hud-clock'); this.name = $('hud-name');
    this.mm = $('minimap'); this.mmCtx = this.mm.getContext('2d'); this.mmImg = null;
    this.lastLog = -1; this.t = 0;
    this.units.addEventListener('wheel', (e) => { this.units.scrollLeft += e.deltaY; e.preventDefault(); }, { passive: false });
  }
  reset(game) {
    this.units.innerHTML = ''; this.cards.clear();
    this.name.textContent = game.sc.name;
    this.logEl.innerHTML = ''; this.lastLog = -1;
    this.buildMinimap(game);
    this.update(true);
  }
  buildMinimap(game) {
    const T = game.T, map = game.map;
    const [bx0, by0, bx1, by1] = game.bounds;
    const W = 368, H = Math.round(W * (by1 - by0) / (bx1 - bx0));
    this.mmW = W; this.mmH = H;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d'); const img = x.createImageData(W, H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const wx = bx0 + (i + 0.5) / W * (bx1 - bx0), wy = by0 + (j + 0.5) / H * (by1 - by0);
      const d = T.depthAt(wx, wy), v = T.vegAt(wx, wy), s = T.surf[T.idx(wx, wy)];
      let r, g, b;
      if (d > 0) { const k = Math.min(1, d / 8); r = 60 - 50 * k; g = 170 - 120 * k; b = 170 - 60 * k; }
      else { r = 200 - v * 110; g = 188 - v * 70; b = 140 - v * 70; if (s > 0.5) { r = g = 205; b = 195; } }
      const o = (j * W + i) * 4; img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    this.mmImg = c;
    const aspect = H / W;
    this.mm.style.height = Math.round(184 * aspect) + 'px';
    this.mm.width = W; this.mm.height = H;
  }
  minimapToWorld(px, py) {
    const g = this.app.game; const [bx0, by0, bx1, by1] = g.bounds;
    const r = this.mm.getBoundingClientRect();
    return [bx0 + (px - r.left) / r.width * (bx1 - bx0), by0 + (py - r.top) / r.height * (by1 - by0)];
  }
  drawMinimap() {
    const g = this.app.game; if (!g || !this.mmImg) return;
    const x = this.mmCtx, W = this.mmW, H = this.mmH;
    const [bx0, by0, bx1, by1] = g.bounds;
    const sx = (wx) => (wx - bx0) / (bx1 - bx0) * W, sy = (wy) => (wy - by0) / (by1 - by0) * H;
    x.drawImage(this.mmImg, 0, 0);
    for (const st of g.structures) if (st.known[0] && !st.destroyed && st.garrison.some(t => g.teamAlive(t) > 0)) { x.fillStyle = '#ff3a2a'; x.fillRect(sx(st.x) - 3, sy(st.y) - 3, 6, 6); }
    for (const vl of g.vls) { x.strokeStyle = vl.owner === 'US' ? '#3a9bff' : '#ff3a2a'; x.lineWidth = 3; x.beginPath(); x.arc(sx(vl.x), sy(vl.y), 6, 0, 7); x.stroke(); }
    for (const s of g.soldiers) {
      if (!g.alive(s)) continue;
      if (s.side === 'JP') { if (s.visT[0] < g.time || s.inStruct) continue; x.fillStyle = '#ff4030'; }
      else x.fillStyle = s.team.selected ? '#ffe08a' : '#2f8cff';
      x.fillRect(sx(s.x) - 1.5, sy(s.y) - 1.5, 3, 3);
    }
    for (const v of g.vehicles) {
      if (v.state === 'destroyed' || v.carried || (v.side === 'JP' && v.visT[0] < g.time)) continue;
      x.fillStyle = v.side === 'US' ? '#9fd0ff' : '#ff7a6a';
      x.fillRect(sx(v.x) - 3, sy(v.y) - 3, 6, 6);
    }
    const cam = this.app.cam, vw = this.app.viewW / cam.zoom, vh = this.app.viewH / cam.zoom;
    x.strokeStyle = '#fff'; x.lineWidth = 2;
    x.strokeRect(sx(cam.x - vw / 2), sy(cam.y - vh / 2), vw / (bx1 - bx0) * W, vh / (by1 - by0) * H);
  }

  card(team) {
    let c = this.cards.get(team);
    if (c) return c;
    const el = document.createElement('div');
    el.className = 'ucard';
    el.innerHTML = `<div class="ico"></div><div class="n"></div><div class="ty"></div><div class="st"></div><div class="men"></div><div class="bar"></div>`;
    let lastTap = 0;
    el.addEventListener('pointerup', (e) => {
      const now = performance.now();
      if (now - lastTap < 350) this.app.centerOn(team);
      lastTap = now;
      this.app.selectTeam(team, e.shiftKey || e.ctrlKey || e.metaKey);
      this.app.audio.ui('ui_select');
    });
    // hovering a card highlights that team on the map
    el.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') this.app.scene.hoverTeam = team; });
    el.addEventListener('pointerleave', () => { if (this.app.scene.hoverTeam === team) this.app.scene.hoverTeam = null; });
    this.units.appendChild(el);
    c = { el, ico: el.children[0], n: el.children[1], ty: el.children[2], st: el.children[3], men: el.children[4], bar: el.children[5], key: '' };
    c.ico.textContent = team.vehicle ? (team.vehicle.spec.kind === 'track' ? 'TK' : team.vehicle.spec.kind === 'amph' ? 'LVT' : 'BT') : team.short;
    this.cards.set(team, c);
    return c;
  }
  update(force = false) {
    const app = this.app, g = app.game;
    if (!g) return;
    this.clock.textContent = g.clock();
    // cards
    for (const t of g.teams) {
      if (t.side !== 'US') continue;
      if (t.vehicle && t.vehicle.carried) continue;
      if (t.vehicle && !t.vehicle.cargo.length && t.vehicle.spec.kind !== 'track' && g.time - t.created > 1 && t.vehicle.retire) { const c = this.cards.get(t); if (c) { c.el.remove(); this.cards.delete(t); } continue; }
      const c = this.card(t);
      const alive = g.teamAlive(t);
      const dead = alive === 0 && !(t.vehicle && t.vehicle.state !== 'destroyed');
      let men = '';
      if (t.vehicle) {
        const v = t.vehicle;
        men = `<span style="font-size:10px;color:#ccc">${v.state === 'destroyed' ? 'KO' : Math.round(v.hp / v.maxHp * 100) + '%'}${v.cargo.length ? ' · ' + v.cargo.reduce((a, k) => a + g.teamAlive(k), 0) + ' aboard' : ''}</span>`;
      } else for (const s of t.soldiers) {
        const k = s.state === 'dead' ? 'd' : s.state === 'incap' ? 'i' : s.status === 'cowering' || s.status === 'panicked' ? 'c' : s.status === 'pinned' ? 'p' : (s.state === 'wounded' || s.status === 'suppressed') ? 'w' : '';
        men += `<i class="${k}"></i>`;
      }
      const key = t.name + t.status + men + (t.selected ? 1 : 0) + Math.round(t.morale / 5);
      if (key === c.key && !force) continue;
      c.key = key;
      c.n.textContent = t.vehicle ? t.vehicle.name : t.name;
      c.ty.textContent = t.vehicle ? t.vehicle.spec.name : t.def.name;
      c.st.textContent = dead ? 'Eliminated' : t.status;
      c.st.className = 'st ' + t.status;
      c.men.innerHTML = men;
      c.bar.style.width = Math.max(0, Math.min(100, t.morale)) + '%';
      c.el.classList.toggle('sel', !!t.selected);
      c.el.classList.toggle('dead', dead);
    }
    // VL chips
    const vh = g.vls.map(v => `<span class="vlchip ${v.owner}${v.contested ? ' cont' : ''}">${v.owner === 'US' ? '★' : '●'} ${esc(v.name)}</span>`).join('');
    if (vh !== this._vh) { this.vlEl.innerHTML = vh; this._vh = vh; }
    // support
    for (const k of ['naval', 'air', 'star']) {
      const b = document.getElementById('sup-' + k);
      const n = g.support[k] || 0;
      b.querySelector('b').textContent = n;
      b.classList.toggle('hidden', n === 0 && !(k !== 'star' && (g.sc.support || {})[k]));
      b.classList.toggle('armed', app.orderMode === 'support:' + k);
    }
    // order bar
    const sel = [...app.selection];
    document.getElementById('orderbar').classList.toggle('hidden', sel.length === 0);
    const anyVeh = sel.some(t => t.vehicle || t.embarked);
    const canUnload = sel.some(t => (t.vehicle && (t.vehicle.cargo.length || t.vehicle.cargoVeh)) || t.embarked);
    const canAssault = sel.some(t => !t.vehicle && !t.embarked && g.hasAssault(t));
    for (const b of document.querySelectorAll('#orderbar button')) {
      const o = b.dataset.order;
      let en = sel.length > 0;
      if (o === 'unload') en = canUnload;
      if (o === 'assault') en = canAssault;
      if (o === 'smoke') en = sel.some(t => !t.vehicle && !t.embarked && (t.smokeN > 0));
      if (o === 'sneak' && anyVeh && sel.every(t => t.vehicle || t.embarked)) en = true;
      b.disabled = !en;
      b.classList.toggle('armed', app.orderMode === o);
    }
    // details
    if (sel.length === 1) this.showDetails(sel[0]); else this.details.classList.add('hidden');
    // log
    if (g.log.length && (g.log.length !== this.lastLog || force)) {
      this.lastLog = g.log.length;
      const items = g.log.slice(-7);
      this.logEl.innerHTML = items.map(m => `<div class="msg ${m.kind}"><span class="t">${g.sc.clockScale ? '' : fmt(g, m.t)}</span>${esc(m.text)}</div>`).join('');
    }
    for (const [i, el] of [...this.logEl.children].entries()) {
      const m = g.log[g.log.length - this.logEl.children.length + i];
      if (m) el.style.opacity = Math.max(0.15, 1 - (g.time - m.t) / 40);
    }
  }
  showDetails(t) {
    const g = this.app.game;
    const d = this.details;
    d.classList.remove('hidden');
    let html = '';
    if (t.vehicle || t.embarked) {
      const v = t.vehicle || t.embarked;
      html += `<h4>${esc(v.name)}</h4><div class="sub">${esc(v.spec.name)} · ${esc(t.status)}</div>`;
      html += `<div>Hull ${v.state === 'destroyed' ? 'destroyed' : Math.round(v.hp / v.maxHp * 100) + '%'}${v.immobile ? ' · <b style="color:#ff8a6a">immobilised</b>' : ''}${v.grounded ? ' · grounded' : ''}</div>`;
      html += '<table>' + v.weps.map(w => `<tr><td>${esc(w.w.name)}</td><td>${w.proxy ? w.proxy.ammo : w.ammo} rds</td></tr>`).join('') + '</table>';
      if (v.cargo.length) html += '<div class="sub" style="margin-top:6px">Aboard: ' + v.cargo.map(k => esc(k.name) + ` (${g.teamAlive(k)})`).join(', ') + '</div>';
      if (v.cargoVeh) html += `<div class="sub">Carrying ${esc(v.cargoVeh.name)}</div>`;
      if (t.embarked) html += `<div class="sub">${esc(t.name)} embarked — order <b>Unload</b> when close to shore.</div>`;
    } else {
      html += `<h4>${esc(t.name)}</h4><div class="sub">${esc(t.def.name)} · ${esc(t.status)}${t.radio ? ' · 📻 radio' : ''}</div>`;
      html += `<div>Morale</div><div class="mbar"><div style="width:${Math.max(0, Math.min(100, t.morale))}%"></div></div>`;
      html += '<table>';
      for (const s of t.soldiers) {
        const st = s.state === 'ok' ? (s.status === 'ok' ? 'ok' : s.status) : s.state + (s.stable ? ' (stable)' : '');
        html += `<tr><td>${esc(s.rank)} ${esc(s.name)}</td><td>${esc(s.wpn.name.replace(/ \(.*\)/, ''))}</td><td>${s.wpn.cls === 'flame' || s.wpn.cls === 'at' || s.wpn.cls === 'mortar' ? s.ammo : Math.ceil(s.ammo / (s.wpn.mag || 1))}${s.satchels ? ' 💣' + s.satchels : ''}</td><td class="s-${s.state}">${esc(st)}</td></tr>`;
      }
      html += '</table>';
      const kills = t.soldiers.reduce((a, s) => a + Math.floor(s.kills), 0);
      if (kills) html += `<div class="sub" style="margin-top:6px">Enemy casualties caused: ${kills}</div>`;
    }
    if (html !== this._dh) { d.innerHTML = html; this._dh = html; }
  }
}
function fmt(g, t) {
  const m = Math.floor((g.sc.startMin || 0) + t / 60);
  return String(Math.floor(m / 60) % 24).padStart(2, '0') + String(m % 60).padStart(2, '0');
}
