// 2D overlay: objectives, unit icons, selection, orders, known fortifications, line-of-sight tool.
import { normAngle } from '../util.js';

const ORDER_COL = { move: '#9fe07a', fast: '#ffd34a', sneak: '#7fd8ff', assault: '#ff9a3a', retreat: '#cccccc', fire: '#ff5a4a', smoke: '#e8e8e8' };
const ICON = { inf: 'X', eng: 'E', mg: 'MG', at: 'AT', mortar: 'M', recon: '/', hq: 'HQ', fo: 'FO', arty: '•', armor: '◯', amtrac: 'LVT', boat: '≈' };

export class Overlay {
  constructor(canvas) { this.c = canvas; this.ctx = canvas.getContext('2d'); this.dpr = 1; }
  resize(w, h, dpr) {
    this.dpr = dpr; this.W = w; this.H = h;
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (this.c.width !== pw || this.c.height !== ph) { this.c.width = pw; this.c.height = ph; }
  }
  clear() { const x = this.ctx; x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, this.c.width, this.c.height); x.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }

  drawLabels(map, cam, minZoom = 0, maxZoom = 1.5) {
    const x = this.ctx;
    if (cam.zoom > maxZoom || cam.zoom < minZoom) return;
    const fade = Math.min(1, (maxZoom - cam.zoom) / (maxZoom * 0.4));
    x.save();
    x.textAlign = 'center'; x.textBaseline = 'middle';
    for (const l of map.labels) {
      const [sx, sy] = this.w2s(cam, l.x, l.y);
      if (sx < -200 || sy < -50 || sx > this.W + 200 || sy > this.H + 50) continue;
      const size = Math.max(10, Math.min(30, 11 * l.s * Math.sqrt(cam.zoom / 0.5)));
      x.font = `600 ${size}px Oswald, sans-serif`;
      x.save(); x.translate(sx, sy); if (l.rot) x.rotate(l.rot);
      x.globalAlpha = 0.75 * fade;
      x.letterSpacing = '3px';
      x.fillStyle = 'rgba(0,0,0,0.6)'; x.fillText(l.t, 1.5, 1.5);
      x.fillStyle = '#f2ead2'; x.fillText(l.t, 0, 0);
      x.restore();
    }
    x.restore();
  }
  w2s(cam, wx, wy) { return [(wx - cam.x) * cam.zoom + this.W / 2, (wy - cam.y) * cam.zoom + this.H / 2]; }

  draw(app) {
    const g = app.game, cam = app.cam, x = this.ctx;
    this.clear();
    if (!g) return;
    const z = cam.zoom;
    const W2S = (wx, wy) => this.w2s(cam, wx, wy);
    this.drawLabels(g.map, cam, 0, 1.1);
    if (app.terrainView) this.drawElevation(app, g, W2S, z);
    const now = g.time;
    const sel = app.selection;
    // ---- fortifications known to the Marines
    for (const st of g.structures) {
      if (!st.known[0] || st.type === 'hulk' && !st.garrison.length) continue;
      const [sx, sy] = W2S(st.x, st.y);
      if (sx < -150 || sy < -150 || sx > this.W + 150 || sy > this.H + 150) continue;
      const active = !st.destroyed && st.garrison.some(t => g.teamAlive(t) > 0);
      const r = Math.max(8, Math.max(st.w, st.h) * 0.6 * z);
      if (active) {
        if (sel.size || app.hoverStruct === st || z > 1.2) {
          const R = Math.min(260, 320 * z);
          x.save();
          const grad = x.createRadialGradient(sx, sy, r, sx, sy, R);
          grad.addColorStop(0, 'rgba(255,60,40,0.22)'); grad.addColorStop(1, 'rgba(255,60,40,0)');
          x.fillStyle = grad;
          x.beginPath(); x.moveTo(sx, sy);
          if (st.arc < 3) x.arc(sx, sy, R, st.dir - st.arc, st.dir + st.arc); else x.arc(sx, sy, R, 0, Math.PI * 2);
          x.closePath(); x.fill(); x.restore();
        }
        x.strokeStyle = now - st.lastFire < 2 ? '#ffd0a0' : '#ff5a4a'; x.lineWidth = 2;
        const b = r + 3, k = b * 0.45;
        x.beginPath();
        for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          x.moveTo(sx + cx * b, sy + cy * b - cy * k); x.lineTo(sx + cx * b, sy + cy * b); x.lineTo(sx + cx * b - cx * k, sy + cy * b);
        }
        x.stroke();
        if (z > 0.5 || app.hoverStruct === st) this.tag(sx, sy - b - 10, st.name, '#ffb3a8');
      } else if (st.destroyed && z > 0.6) {
        x.strokeStyle = 'rgba(200,200,200,0.5)'; x.lineWidth = 1.5;
        x.beginPath(); x.moveTo(sx - 6, sy - 6); x.lineTo(sx + 6, sy + 6); x.moveTo(sx + 6, sy - 6); x.lineTo(sx - 6, sy + 6); x.stroke();
      }
    }
    // ---- objectives
    for (const vl of g.vls) {
      const [sx, sy] = W2S(vl.x, vl.y);
      const rr = Math.max(14, vl.r * z);
      x.save();
      x.setLineDash([6, 5]);
      x.strokeStyle = vl.owner === 'US' ? 'rgba(111,195,255,0.8)' : 'rgba(255,90,74,0.8)';
      x.lineWidth = 2;
      x.beginPath(); x.arc(sx, sy, rr, 0, Math.PI * 2); x.stroke();
      x.setLineDash([]);
      if (vl.prog > 0) {
        x.strokeStyle = vl.owner === 'US' ? '#ff5a4a' : '#6fc3ff'; x.lineWidth = 4;
        x.beginPath(); x.arc(sx, sy, rr + 4, -Math.PI / 2, -Math.PI / 2 + vl.prog * Math.PI * 2); x.stroke();
      }
      // flag
      x.fillStyle = '#ddd'; x.fillRect(sx - 1, sy - 22, 2, 22);
      x.fillStyle = vl.owner === 'US' ? '#3a7bd5' : '#f4f0e8';
      x.fillRect(sx + 1, sy - 22, 16, 11);
      if (vl.owner === 'JP') { x.fillStyle = '#c8102e'; x.beginPath(); x.arc(sx + 9, sy - 16.5, 3.2, 0, 7); x.fill(); }
      else { x.fillStyle = '#fff'; x.font = '8px sans-serif'; x.fillText('★', sx + 5, sy - 13); }
      x.restore();
      this.tag(sx, sy + rr + 10, vl.name + (vl.contested ? ' ⚔' : ''), vl.owner === 'US' ? '#cfe9ff' : '#ffd6d0');
    }
    // ---- Japanese: visible markers at low zoom, ghosts of last known positions
    for (const s of g.soldiers) {
      if (s.side !== 'JP' || !g.alive(s) || s.inStruct) continue;
      if (s.visT[0] > now) {
        if (z < 0.9) { const [sx, sy] = W2S(s.x, s.y); x.fillStyle = '#ff4a3a'; x.fillRect(sx - 2.5, sy - 2.5, 5, 5); }
      } else if (s.lastSeen[0] > 0 && now - s.lastSeen[0] < 30) {
        const [sx, sy] = W2S(s.ghostX, s.ghostY);
        x.globalAlpha = 0.6 * (1 - (now - s.lastSeen[0]) / 30);
        x.strokeStyle = '#ff6a5a'; x.lineWidth = 1.5;
        x.beginPath(); x.arc(sx, sy, 4, 0, 7); x.stroke();
        x.globalAlpha = 1;
      }
    }
    for (const v of g.vehicles) if (v.side === 'JP' && v.state !== 'destroyed' && v.visT[0] > now && z < 1.2) {
      const [sx, sy] = W2S(v.x, v.y); this.icon(sx, sy, 'armor', '#ff5a4a', false, 'Ha-Go');
    }
    // ---- US teams
    const icons = z < 0.75;
    for (const t of g.teams) {
      if (t.side !== 'US') continue;
      if (t.vehicle && t.vehicle.carried) continue;
      const alive = g.teamAlive(t);
      if (!alive && !(t.vehicle && t.vehicle.state !== 'destroyed')) continue;
      const selected = sel.has(t);
      const [cx, cy] = g.teamCenter(t);
      const [sx, sy] = W2S(cx, cy);
      if (sx < -60 || sy < -60 || sx > this.W + 60 || sy > this.H + 60) { if (selected) this.offscreen(sx, sy); continue; }
      if (icons) {
        this.icon(sx, sy, t.vehicle ? (t.vehicle.spec.kind === 'track' ? 'armor' : t.vehicle.spec.kind === 'amph' ? 'amtrac' : 'boat') : t.def.icon, '#6fc3ff', selected, z < 0.45 ? '' : t.name, t.status);
      } else {
        if (selected) this.drawSelected(g, t, W2S, z);
        else {
          const l = g.leader(t) || t.soldiers[0];
          const [lx, ly] = t.vehicle ? [sx, sy] : W2S(l.x, l.y);
          x.fillStyle = '#6fc3ff';
          x.beginPath(); x.moveTo(lx - 4, ly - 15); x.lineTo(lx + 4, ly - 15); x.lineTo(lx, ly - 10); x.closePath(); x.fill();
          if (/Pinned|Cowering|Panicked/.test(t.status)) this.tag(lx, ly - 22, t.status.toUpperCase(), '#ffb13a');
        }
      }
      if (selected) this.drawOrder(g, t, W2S);
    }
    // ---- pending fire support
    for (const m of g.supportMarks || []) {
      if (m.t < now) continue;
      const [sx, sy] = W2S(m.x, m.y);
      x.strokeStyle = '#ffdd55'; x.lineWidth = 2;
      x.beginPath(); x.arc(sx, sy, 16, 0, 7); x.moveTo(sx - 22, sy); x.lineTo(sx + 22, sy); x.moveTo(sx, sy - 22); x.lineTo(sx, sy + 22); x.stroke();
      this.tag(sx, sy + 28, `${m.label} ${Math.ceil(m.t - now)}s`, '#ffe9a0');
    }
    // ---- line of sight tool
    if (app.losPoint && sel.size) this.drawLOS(app, g, W2S);
    // ---- box select
    if (app.box) {
      const b = app.box;
      x.strokeStyle = '#ffe08a'; x.lineWidth = 1; x.setLineDash([4, 3]);
      x.strokeRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      x.setLineDash([]);
    }
  }

  // elevation view: spot heights, and the height under the mouse
  drawElevation(app, g, W2S, z) {
    const x = this.ctx, T = g.T;
    x.save();
    x.font = '600 11px Inter, sans-serif'; x.textBaseline = 'middle';
    const minGap = 90 / Math.max(z, 0.05);
    let last = [];
    for (const s of app.spotHeights || []) {
      const [sx, sy] = W2S(s.x, s.y);
      if (sx < -20 || sy < -20 || sx > this.W + 20 || sy > this.H + 20) continue;
      if (last.some(o => Math.hypot(o.x - s.x, o.y - s.y) < minGap)) continue;
      last.push(s);
      x.fillStyle = '#2a1a0c';
      x.beginPath(); x.moveTo(sx, sy - 5); x.lineTo(sx + 4.5, sy + 3); x.lineTo(sx - 4.5, sy + 3); x.closePath(); x.fill();
      const txt = s.e.toFixed(1) + ' m';
      x.lineWidth = 3; x.strokeStyle = 'rgba(255,248,225,0.85)'; x.strokeText(txt, sx + 7, sy);
      x.fillStyle = '#2a1a0c'; x.fillText(txt, sx + 7, sy);
    }
    if (app.cursorW) {
      const [wx, wy] = app.cursorW, [sx, sy] = W2S(wx, wy);
      const el = T.groundAt(wx, wy) - T.water, cover = T.obj[T.idx(wx, wy)];
      const txt = el < 0 ? `water ${(-el).toFixed(1)} m deep` : `${el.toFixed(1)} m above water` + (cover > 0.4 ? ` · cover ${cover.toFixed(1)} m` : '');
      this.tag(sx, sy + 22, txt, '#fff3c8');
    }
    x.restore();
  }
  drawSelected(g, t, W2S, z) {
    const x = this.ctx;
    x.strokeStyle = '#ffe08a'; x.lineWidth = 1.5;
    if (t.vehicle || t.embarked) {
      const v = t.vehicle || t.embarked;
      const [sx, sy] = W2S(v.x, v.y);
      // the vehicle itself gets a glowing frame from the sprite renderer (K.SELBOX)
      this.tag(sx, sy - Math.max(14, v.spec.len * 0.7 * z) - 8, `${t.embarked ? t.name + ' (in ' + v.name + ')' : v.name} · ${t.status}`, '#ffe9a0');
      return;
    }
    const r = Math.max(5, 1.3 * z);
    // close in, the sprites carry a silhouette outline instead of rings
    const rings = z < 2.2;
    for (const s of t.soldiers) {
      if (s.state === 'dead') continue;
      const [sx, sy] = W2S(s.x, s.y);
      if (rings) {
        x.strokeStyle = s.state === 'incap' ? '#ff6a55' : s.status === 'pinned' || s.status === 'cowering' ? '#ffb13a' : '#ffe08a';
        x.beginPath(); x.arc(sx, sy, r, 0, 7); x.stroke();
      }
      // fire line for the current target
      if (s.burstLeft > 0 && s.targetKind && s.target) {
        const [tx, ty] = W2S(s.target.x, s.target.y);
        x.strokeStyle = 'rgba(255,90,74,0.35)'; x.beginPath(); x.moveTo(sx, sy); x.lineTo(tx, ty); x.stroke();
      }
    }
    const l = g.leader(t);
    if (l) { const [lx, ly] = W2S(l.x, l.y); this.tag(lx, ly - r - 12, `${t.name} · ${t.status}`, '#ffe9a0'); }
  }
  drawOrder(g, t, W2S) {
    const x = this.ctx;
    const v = t.vehicle || t.embarked;
    if (v) {
      if (v.path) {
        x.strokeStyle = ORDER_COL[v.order.kind] || '#9fe07a'; x.lineWidth = 2; x.setLineDash([7, 5]);
        x.beginPath(); let [a, b] = W2S(v.x, v.y); x.moveTo(a, b);
        for (let i = v.pathI; i < v.path.length; i++) { [a, b] = W2S(v.path[i][0], v.path[i][1]); x.lineTo(a, b); }
        x.stroke(); x.setLineDash([]);
        this.dot(a, b, x.strokeStyle);
      }
      if (v.order.kind === 'fire' && (v.order.target || v.order.x !== undefined)) {
        const tg = v.order.target || v.order;
        const [a, b] = W2S(v.x, v.y), [c, d] = W2S(tg.x, tg.y);
        x.strokeStyle = ORDER_COL.fire; x.lineWidth = 2; x.beginPath(); x.moveTo(a, b); x.lineTo(c, d); x.stroke(); this.cross(c, d);
      }
      return;
    }
    const o = t.order;
    if (o.path && !o.arrived) {
      x.strokeStyle = ORDER_COL[o.kind] || '#9fe07a'; x.lineWidth = 2; x.setLineDash([7, 5]);
      const [px, py] = g.pathPoint(o, o.pathS);
      x.beginPath(); let [a, b] = W2S(px, py); x.moveTo(a, b);
      for (let i = 1; i < o.path.length; i++) if (o.cum[i] > o.pathS) { [a, b] = W2S(o.path[i][0], o.path[i][1]); x.lineTo(a, b); }
      x.stroke(); x.setLineDash([]);
      this.dot(a, b, x.strokeStyle);
      if (o.facing !== undefined) { x.beginPath(); x.moveTo(a, b); x.lineTo(a + Math.cos(o.facing) * 18, b + Math.sin(o.facing) * 18); x.stroke(); }
    }
    if ((o.kind === 'fire' || o.kind === 'assault') && (o.target || o.x !== undefined)) {
      const tg = o.target || o;
      const [cx, cy] = g.teamCenter(t);
      const [a, b] = W2S(cx, cy), [c, d] = W2S(tg.x, tg.y);
      x.strokeStyle = o.kind === 'assault' ? ORDER_COL.assault : ORDER_COL.fire; x.lineWidth = 2;
      x.setLineDash(o.kind === 'fire' ? [] : [3, 4]);
      x.beginPath(); x.moveTo(a, b); x.lineTo(c, d); x.stroke(); x.setLineDash([]);
      this.cross(c, d);
    }
  }
  drawLOS(app, g, W2S) {
    const x = this.ctx;
    const t = [...app.selection][0];
    if (!t) return;
    let ox, oy, eye;
    const v = t.vehicle || t.embarked;
    if (v) { ox = v.x; oy = v.y; eye = Math.max(g.T.water, g.T.baseAt(ox, oy)) + 2.2; }
    else { const l = g.leader(t); if (!l) return; ox = l.x; oy = l.y; eye = g.T.baseAt(ox, oy) + 1.6; }
    const [px, py] = app.losPoint;
    const base = g.T.baseAt(px, py);
    const L = g.T.los(ox, oy, eye, px, py, base, base + 1.7, 0.8, 0.8);
    const D = Math.hypot(px - ox, py - oy);
    const [a, b] = W2S(ox, oy), [c, d] = W2S(px, py);
    const conceal = L.conceal + g.smokeConceal(ox, oy, px, py);
    let col = L.frac > 0.5 ? (conceal > 0.6 ? '#ffd34a' : '#8fe07a') : L.frac > 0.05 ? '#ffd34a' : '#ff5a4a';
    x.lineWidth = 2.5;
    if (L.blockD > 0) {
      const f = L.blockD / D;
      const mx = a + (c - a) * f, my = b + (d - b) * f;
      x.strokeStyle = '#8fe07a'; x.beginPath(); x.moveTo(a, b); x.lineTo(mx, my); x.stroke();
      x.strokeStyle = '#ff5a4a'; x.beginPath(); x.moveTo(mx, my); x.lineTo(c, d); x.stroke();
    } else { x.strokeStyle = col; x.beginPath(); x.moveTo(a, b); x.lineTo(c, d); x.stroke(); }
    this.tag(c, d + 18, `${Math.round(D)} m · ${L.frac > 0.5 ? (conceal > 0.6 ? 'concealed' : 'clear') : L.frac > 0.05 ? 'partial' : 'blocked'}`, '#fff');
  }
  tag(sx, sy, text, color) {
    const x = this.ctx;
    x.font = '600 11px Inter, sans-serif';
    const w = x.measureText(text).width + 8;
    x.fillStyle = 'rgba(0,0,0,0.55)';
    x.fillRect(sx - w / 2, sy - 8, w, 15);
    x.fillStyle = color; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(text, sx, sy);
  }
  dot(sx, sy, c) { const x = this.ctx; x.fillStyle = c; x.beginPath(); x.arc(sx, sy, 4, 0, 7); x.fill(); }
  cross(sx, sy) { const x = this.ctx; x.lineWidth = 2; x.beginPath(); x.arc(sx, sy, 7, 0, 7); x.moveTo(sx - 11, sy); x.lineTo(sx + 11, sy); x.moveTo(sx, sy - 11); x.lineTo(sx, sy + 11); x.stroke(); }
  icon(sx, sy, type, color, selected, label, status) {
    const x = this.ctx;
    const w = 26, h = 17;
    x.fillStyle = selected ? 'rgba(80,70,20,0.9)' : 'rgba(10,20,30,0.75)';
    x.strokeStyle = selected ? '#ffe08a' : color; x.lineWidth = 1.5;
    if (type === 'armor') { x.beginPath(); x.ellipse(sx, sy, w / 2, h / 2, 0, 0, 7); x.fill(); x.stroke(); }
    else { x.fillRect(sx - w / 2, sy - h / 2, w, h); x.strokeRect(sx - w / 2, sy - h / 2, w, h); }
    x.fillStyle = selected ? '#ffe08a' : color;
    x.font = '700 9px Inter, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    if (type === 'inf') { x.beginPath(); x.moveTo(sx - w / 2, sy - h / 2); x.lineTo(sx + w / 2, sy + h / 2); x.moveTo(sx + w / 2, sy - h / 2); x.lineTo(sx - w / 2, sy + h / 2); x.stroke(); }
    else x.fillText(ICON[type] || '?', sx, sy + 0.5);
    if (label) this.tag(sx, sy + h / 2 + 9, label, '#cfe9ff');
    if (status && /Pinned|Cowering|Panicked/.test(status)) this.tag(sx, sy - h / 2 - 9, status.toUpperCase(), '#ffb13a');
  }
  offscreen(sx, sy) {
    const x = this.ctx;
    const cx = Math.max(16, Math.min(this.W - 16, sx)), cy = Math.max(60, Math.min(this.H - 140, sy));
    x.fillStyle = '#ffe08a';
    const a = Math.atan2(sy - cy, sx - cx);
    x.save(); x.translate(cx, cy); x.rotate(a);
    x.beginPath(); x.moveTo(8, 0); x.lineTo(-6, -6); x.lineTo(-6, 6); x.closePath(); x.fill(); x.restore();
  }
}
