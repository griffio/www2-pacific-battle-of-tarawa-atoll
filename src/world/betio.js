// Betio island (Tarawa atoll) — terrain, fortifications and props, laid out after the 1943 maps.
// World units are metres. +x = east, +y = south. North (the lagoon) is at the top.
import { Terrain, F } from './terrain.js';
import { K, DK } from '../kinds.js';
import { signedField, polyYRange, polyXRange, scatter, offsetPolyline, resamplePolyline } from './mapgen.js';
import { makeRng, fbm, vnoise, smoothPoly, clamp, smoothstep, lerp } from '../util.js';

export const BETIO_W = 3800, BETIO_H = 2000;

// Vegetation line of the island (beach top). Clockwise from the western tip.
const OUTLINE = [
  [272, 1330], [286, 1225], [318, 1125], [372, 1052], [432, 1018],
  [500, 1036], [572, 1082], [652, 1122], [742, 1142], [830, 1132], [898, 1098], [952, 1066],
  [1050, 1058], [1200, 1066], [1350, 1070], [1480, 1076],
  [1600, 1078], [1800, 1083], [2000, 1088], [2200, 1093], [2350, 1098],
  [2600, 1108], [2850, 1128], [3050, 1158], [3250, 1198], [3420, 1248], [3560, 1298], [3645, 1335],
  [3600, 1366], [3450, 1382], [3250, 1396], [3000, 1420], [2750, 1458],
  [2500, 1516], [2200, 1566], [1900, 1606], [1600, 1636], [1300, 1652], [1000, 1648], [750, 1628], [552, 1598], [402, 1540], [312, 1452],
];

export function buildBetio() {
  const rng = makeRng(2011943);
  const T = new Terrain(BETIO_W, BETIO_H, 2);
  const poly = smoothPoly(OUTLINE, 5, true);
  const { s } = signedField(T.nx, T.ny, T.cell, [poly]);
  const nx = T.nx, ny = T.ny, c = T.cell;

  const northY = (x) => polyYRange(poly, x)[0];
  const southY = (x) => polyYRange(poly, x)[1];
  const westX = (y) => polyXRange(poly, y)[0];
  const axis = new Float32Array(nx);
  for (let cx = 0; cx < nx; cx++) {
    const x = clamp((cx + 0.5) * c, 290, 3620);
    const r = polyYRange(poly, x);
    axis[cx] = isFinite(r[0]) ? (r[0] + r[1]) / 2 : 1340;
  }

  // ---------- heightfield ----------
  for (let cy = 0; cy < ny; cy++) for (let cx = 0; cx < nx; cx++) {
    const i = cy * nx + cx, x = (cx + 0.5) * c, y = (cy + 0.5) * c;
    const sd = s[i];
    const n1 = fbm(x / 110, y / 110, 4, 1), n2 = fbm(x / 16, y / 16, 3, 7), n3 = vnoise(x / 5, y / 5, 3);
    const rn = x < 700 ? lerp(290, 400, smoothstep(350, 700, x)) : x > 2300 ? lerp(400, 280, smoothstep(2300, 3500, x)) : 400;
    const f = smoothstep(-220, 220, y - axis[cx]);
    let reef = lerp(rn, 165, f) + (n1 - 0.5) * 140;
    if (x < 330) reef = lerp(reef, 250, 0.6);
    let h;
    if (sd < 0) {
      const d = -sd;
      h = 0.9 + 1.75 * smoothstep(0, 75, d) + (n1 - 0.5) * 0.9 + (n2 - 0.5) * 0.25;
    } else if (sd < 46) {
      h = 0.9 - (sd / 46) * 1.78 + (n2 - 0.5) * 0.12;
    } else if (sd < reef) {
      h = -0.86 + (n1 - 0.5) * 0.32 + (n2 - 0.5) * 0.22;
      if (n2 > 0.74) h += (n2 - 0.74) * 1.6;           // coral heads
      h += (n3 - 0.5) * 0.06;
    } else {
      const k = (sd - reef) / 70;
      h = -0.9 - 10 * smoothstep(0, 1, k) - Math.min(sd - reef, 900) * 0.006 + (n1 - 0.5) * 1.5;
    }
    T.ground[i] = h;
    // vegetation (undergrowth), stripped near the bombarded northern beaches
    if (sd < -14) {
      let v = smoothstep(0.38, 0.72, fbm(x / 150, y / 150, 4, 11)) * 0.75 + (n2 - 0.5) * 0.15;
      if (x > 2450) v = v * 0.6 + 0.35;
      const north = y - northY(clamp(x, 300, 3600));
      if (north < 160) v *= lerp(0.2, 1, north / 160);
      T.veg[i] = clamp(v, 0, 0.85);
    }
  }

  const props = [];        // static render props (low layer)
  const canopy = [];       // palm canopies (drawn above units)
  const decals = [];       // baked ground decals
  const structures = [];   // fortifications (hp, embrasures)
  const positions = [];    // fighting positions (nests, gun pits, foxholes)
  const P = (k, x, y, hw, hh, rot = 0, p0 = 0, p1 = 0, p2 = 0, p3 = 0) => ({ k, x, y, hw, hh, rot, p0, p1, p2, p3 });

  const N = (x, d) => [x, northY(x) + d];
  const Wb = (y, d) => [westX(y) + d, y];
  const S = (x, d) => [x, southY(x) - d];

  // ---------- airfield ----------
  const flatten = (ax, ay, bx, by, width, hgt) => T.stampLine(ax, ay, bx, by, width, (k, d) => {
    T.surf[k] = Math.max(T.surf[k], d < 0.85 ? 1 : 0.6); T.veg[k] = 0;
    T.ground[k] = lerp(T.ground[k], hgt, d < 0.8 ? 0.85 : 0.4);
  });
  flatten(620, 1392, 2150, 1352, 64, 2.45);
  flatten(900, 1386, 1200, 1236, 28, 2.4);
  flatten(1200, 1236, 1900, 1240, 28, 2.4);
  flatten(1900, 1240, 2110, 1354, 28, 2.4);
  flatten(1450, 1240, 1500, 1110, 14, 2.2); // road to pier
  flatten(2150, 1352, 2900, 1300, 10, 2.3); // road east
  flatten(700, 1390, 420, 1300, 10, 2.3);   // road west

  // ---------- pre-landing bombardment craters ----------
  const craterList = [];
  for (let t = 0; t < 520; t++) {
    const x = rng.range(300, 3500), y = rng.range(1000, 1660);
    const r = rng() < 0.08 ? rng.range(7, 10) : rng.range(2.5, 5.5);
    const i = T.idx(x, y);
    if (s[i] > 30) continue;
    const nearNorth = y - northY(clamp(x, 300, 3600)) < 220;
    if (!nearNorth && rng() < 0.45) continue;
    craterList.push([x, y, r]);
  }

  // ---------- seawall along the lagoon shore ----------
  const north = [];
  for (const p of poly) if (p[1] < 1200 && p[0] > 446 && p[0] < 2470) north.push(p);
  north.sort((a, b) => a[0] - b[0]);
  const wallLine = resamplePolyline(offsetPolyline(north, 9), 4);
  const gaps = [[700, 712], [1496, 1530], [1255, 1266], [1985, 1996], [2290, 2312]];
  const inGap = (x) => gaps.some(g => x > g[0] && x < g[1]);
  for (let i = 1; i < wallLine.length; i++) {
    const a = wallLine[i - 1], b = wallLine[i];
    if (inGap((a[0] + b[0]) / 2)) continue;
    T.stampLine(a[0], a[1], b[0], b[1], 1.7, (k) => { T.obj[k] = Math.max(T.obj[k], 1.25); T.flags[k] |= F.SEAWALL; T.veg[k] = 0; });
  }
  for (let i = 0; i + 3 < wallLine.length; i += 3) {
    const a = wallLine[i], b = wallLine[i + 3];
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    if (inGap(mx)) continue;
    props.push(P(K.SEAWALL, mx, my, Math.hypot(b[0] - a[0], b[1] - a[1]) / 2 + 0.3, 0.9, Math.atan2(b[1] - a[1], b[0] - a[0]), rng()));
  }
  // short seawall stretch on Green Beach
  const westPts = poly.filter(p => p[0] < 420 && p[1] > 1130 && p[1] < 1500).sort((a, b) => a[1] - b[1]);
  const gwall = resamplePolyline(offsetPolyline(westPts, -9), 4);
  for (let i = 1; i < gwall.length; i++) {
    const a = gwall[i - 1], b = gwall[i];
    if (a[1] > 1300 && a[1] < 1320) continue;
    T.stampLine(a[0], a[1], b[0], b[1], 1.6, (k) => { T.obj[k] = Math.max(T.obj[k], 1.1); T.flags[k] |= F.SEAWALL; T.veg[k] = 0; });
  }
  for (let i = 0; i + 3 < gwall.length; i += 3) {
    const a = gwall[i], b = gwall[i + 3];
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    if (my > 1296 && my < 1324) continue;
    props.push(P(K.SEAWALL, mx, my, Math.hypot(b[0] - a[0], b[1] - a[1]) / 2 + 0.3, 0.85, Math.atan2(b[1] - a[1], b[0] - a[0]), rng()));
  }

  // ---------- piers ----------
  const pier = (x, y0, y1, w) => {
    T.stampRect(x, (y0 + y1) / 2, w, Math.abs(y1 - y0), 0, (k) => { T.flags[k] |= F.PIER; T.obj[k] = Math.max(T.obj[k], T.pierDeck - T.ground[k]); T.veg[k] = 0; });
    props.push(P(K.PIER, x, (y0 + y1) / 2, w / 2, Math.abs(y1 - y0) / 2, 0, rng()));
  };
  const lpY = northY(1513);
  pier(1513, lpY + 6, 585, 6);                         // the Long Pier (~500 m to the reef edge)
  props.push(P(K.BUILDING, 1513, 600, 7, 5, 0, 1, 0.3)); // shed at pier end (wrecked)
  const bpY = northY(2302);
  pier(2302, bpY + 6, bpY - 150, 8);                   // Burns-Philp wharf

  // ---------- Saida Maru hulk on the reef ----------
  const hulk = { x: 1225, y: 705, hw: 44, hh: 7.5, rot: -0.33 };
  T.stampRect(hulk.x, hulk.y, hulk.hw * 2, hulk.hh * 2, hulk.rot, (k) => { T.obj[k] = 6.5 - T.ground[k]; T.flags[k] |= F.BUILDING; });
  props.push(P(K.HULK, hulk.x, hulk.y, hulk.hw, hulk.hh, hulk.rot, 0.6));
  structures.push({ id: 'hulk', type: 'hulk', name: 'Saida Maru (hulk)', x: hulk.x, y: hulk.y, w: hulk.hw * 2, h: hulk.hh * 2, rot: hulk.rot, dir: Math.PI / 2, arc: Math.PI, height: 6 });

  // ---------- wire & obstacles on the reef ----------
  for (let x = 455; x < 2440; x += 10) {
    if (rng() < 0.18) continue;
    const y = northY(x) - 34 - vnoise(x / 60, 0, 5) * 10;
    const y2 = northY(x + 10) - 34 - vnoise((x + 10) / 60, 0, 5) * 10;
    T.stampLine(x, y, x + 10, y2, 1.6, (k) => { T.flags[k] |= F.WIRE; });
    props.push(P(K.WIRE, x + 5, (y + y2) / 2, 5.2, 0.9, Math.atan2(y2 - y, 10), rng()));
  }
  for (let x = 470; x < 2420; x += 6.5) {
    const band = vnoise(x / 90, 3, 9);
    if (band < 0.45) continue;
    const y = northY(x) - 95 - band * 40 + rng.range(-3, 3);
    T.stampCircle(x, y, 1.6, (k) => { T.flags[k] |= F.TRAP; T.obj[k] = Math.max(T.obj[k], 1.1); });
    props.push(P(K.TRAP, x, y, 1.3, 1.3, rng() * 3, rng()));
  }

  // ---------- trenches ----------
  const trench = (pts, width = 1.7) => {
    const line = resamplePolyline(pts, 3);
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      const wob = (q) => [q[0] + Math.sin(q[0] * 0.21 + q[1] * 0.13) * 1.5, q[1] + Math.cos(q[0] * 0.17) * 1.5];
      const A = wob(a), B = wob(b);
      T.stampLine(A[0], A[1], B[0], B[1], width, (k) => {
        if (T.flags[k] & (F.SEAWALL | F.PIER | F.BUILDING)) return;
        if (!(T.flags[k] & F.TRENCH)) T.ground[k] -= 1.05;
        T.flags[k] |= F.TRENCH; T.veg[k] = 0;
      });
      decals.push({ k: DK.TRENCH, x: (A[0] + B[0]) / 2, y: (A[1] + B[1]) / 2, hw: Math.hypot(B[0] - A[0], B[1] - A[1]) / 2 + 0.6, hh: width * 0.75, rot: Math.atan2(B[1] - A[1], B[0] - A[0]) });
    }
  };
  // fire trench behind the seawall, broken in places
  const behind = offsetPolyline(north, 34);
  let seg = [];
  for (const p of behind) {
    if (vnoise(p[0] / 70, 1, 21) < 0.3) { if (seg.length > 1) trench(seg); seg = []; continue; }
    seg.push(p);
  }
  if (seg.length > 1) trench(seg);
  trench([[640, 1200], [700, 1240], [820, 1250], [880, 1205], [960, 1150]]);   // Red 1 / Pocket
  trench([[1100, 1170], [1250, 1180], [1360, 1200], [1440, 1185]]);
  trench([[1580, 1170], [1720, 1190], [1860, 1180], [2000, 1200], [2120, 1190]]);
  trench([[700, 1352], [1000, 1345], [1300, 1325], [1600, 1318], [1900, 1312], [2150, 1320]]); // runway north edge
  trench([[1250, 1440], [1500, 1430], [1800, 1420]]);
  trench([[360, 1170], [370, 1260], [365, 1360], [380, 1470]]);              // Green Beach
  trench([[2560, 1140], [2580, 1250], [2600, 1360], [2620, 1470]]);           // cross-island line (east)
  trench([[2860, 1170], [2880, 1260], [2880, 1380]]);
  trench([[3150, 1220], [3170, 1310], [3160, 1380]]);

  // ---------- fortifications ----------
  const addStruct = (id, type, pt, dir, name, extra = {}) => {
    const spec = STRUCT_SPECS[type];
    const st = { id, type, name, x: pt[0], y: pt[1], w: spec.w, h: spec.h, rot: dir + Math.PI / 2, dir, arc: spec.arc, height: spec.height, ...extra };
    structures.push(st);
    return st;
  };
  const addPos = (id, type, pt, dir, extra = {}) => { const p = { id, type, x: pt[0], y: pt[1], dir, ...extra }; positions.push(p); return p; };
  const NORTH = -Math.PI / 2, WEST = Math.PI, SOUTH = Math.PI / 2, EAST = 0;

  // NW point – the "bird's beak" and Red Beach 1
  addStruct('coast_nw', 'coastgun', N(430, 46), -2.3, '8-inch Vickers gun (NW)');
  addStruct('pb_beak1', 'pillbox', N(470, 26), NORTH + 0.35, 'Pillbox – Beak');
  addStruct('pb_beak2', 'pillbox', N(548, 34), EAST + 0.25, 'Pillbox – Beak flank');
  addPos('mg_r1a', 'mgnest', N(640, 28), NORTH - 0.1);
  addPos('mg_r1b', 'mgnest', N(760, 24), NORTH - 0.25);
  addStruct('bk_r1', 'bunker', N(705, 62), NORTH, 'Bunker – Red 1');
  // "The Pocket" at the Red 1 / Red 2 boundary
  addStruct('pb_pocket', 'pillbox', N(905, 28), NORTH - 0.65, 'Pillbox – The Pocket');
  addStruct('bk_pocket', 'bunker', N(962, 44), NORTH + 0.45, 'Bunker – The Pocket');
  addPos('mg_pocket', 'mgnest', N(1015, 24), NORTH);
  // Red Beach 2
  addPos('mg_r2a', 'mgnest', N(1095, 24), NORTH);
  addPos('gun_r2', 'gunpit', N(1180, 34), NORTH - 0.2);
  addStruct('pb_r2', 'pillbox', N(1292, 28), NORTH, 'Pillbox – Red 2');
  addPos('mg_r2b', 'mgnest', N(1392, 24), NORTH + 0.15);
  addStruct('bk_pier', 'bunker', N(1462, 42), NORTH + 0.6, 'Bunker – Pier base');
  // Red Beach 3
  addPos('mg_r3a', 'mgnest', N(1572, 24), NORTH - 0.35);
  addStruct('pb_r3', 'pillbox', N(1702, 28), NORTH, 'Pillbox – Red 3');
  addPos('gun_r3', 'gunpit', N(1842, 46), NORTH);
  addPos('mg_r3b', 'mgnest', N(1962, 24), NORTH);
  addStruct('bk_r3', 'bunker', N(2082, 38), NORTH, 'Bunker – Red 3');
  addStruct('bombproof', 'bombproof', N(2205, 92), NORTH, 'Bombproof shelter');
  addStruct('steel_pb', 'steelpb', N(2332, 30), NORTH - 0.45, 'Steel pillbox – Burns-Philp');
  addPos('mg_bp', 'mgnest', N(2425, 24), NORTH - 0.5);
  addStruct('cmd', 'command', N(1655, 158), NORTH, "Adm. Shibasaki's blockhouse");
  // airfield interior
  addPos('aa_1', 'gunpit', [1150, 1300], NORTH);
  addPos('aa_2', 'gunpit', [1760, 1292], NORTH);
  addPos('gun_af', 'gunpit', [2010, 1296], NORTH);
  addPos('revet_1', 'revet', [1585, 1300], NORTH);
  addPos('revet_2', 'revet', [2360, 1330], NORTH + 0.3);
  addPos('revet_3', 'revet', [960, 1470], NORTH);
  // Green Beach (west)
  addStruct('pb_g1', 'pillbox', Wb(1185, 30), WEST - 0.35, 'Pillbox – Green 1');
  addStruct('pb_g2', 'pillbox', Wb(1335, 30), WEST, 'Pillbox – Green 2');
  addStruct('pb_g3', 'pillbox', Wb(1470, 34), WEST + 0.45 - 2 * Math.PI, 'Pillbox – Green 3');
  addPos('mg_g1', 'mgnest', Wb(1255, 22), WEST);
  addPos('mg_g2', 'mgnest', Wb(1405, 22), WEST);
  addPos('gun_g', 'gunpit', Wb(1300, 62), WEST);
  addStruct('bk_g', 'bunker', Wb(1530, 52), SOUTH + 0.6, 'Bunker – SW corner');
  addStruct('coast_sw', 'coastgun', S(430, 44), SOUTH + 0.5, '140 mm gun (SW)');
  // Black beaches (south)
  addStruct('pb_s1', 'pillbox', S(820, 26), SOUTH, 'Pillbox – Black 1');
  addStruct('pb_s2', 'pillbox', S(1320, 26), SOUTH, 'Pillbox – Black 1');
  addStruct('pb_s3', 'pillbox', S(1820, 26), SOUTH, 'Pillbox – Black 2');
  addPos('mg_s1', 'mgnest', S(1060, 22), SOUTH);
  addPos('mg_s2', 'mgnest', S(1560, 22), SOUTH);
  addStruct('coast_se', 'coastgun', S(2720, 40), SOUTH - 0.3, '8-inch Vickers gun (SE)');
  // east
  addStruct('bk_e1', 'bunker', N(2700, 64), WEST, 'Bunker – East 1');
  addStruct('pb_e1', 'pillbox', N(2810, 30), NORTH, 'Pillbox – East');
  addStruct('bk_e2', 'bunker', [2960, 1330], WEST, 'Bunker – East 2');
  addStruct('bk_e3', 'bunker', [3200, 1290], WEST, 'Bunker – Takarongo');
  addPos('mg_e1', 'mgnest', [2880, 1210], WEST);
  addPos('mg_e2', 'mgnest', [2880, 1360], WEST);

  // stamp fortifications into the grid
  for (const st of structures) {
    if (st.type === 'hulk') continue;
    const spec = STRUCT_SPECS[st.type];
    if (spec.mound) {
      T.stampRect(st.x, st.y, st.w + 6, st.h + 6, st.rot, (k, u, v) => {
        const r = Math.max(Math.abs(u), Math.abs(v));
        T.ground[k] += (1 - r) * 0.6; T.veg[k] = 0;
      });
    }
    T.stampRect(st.x, st.y, st.w, st.h, st.rot, (k, u, v) => {
      const r = Math.max(Math.abs(u), Math.abs(v));
      T.obj[k] = Math.max(T.obj[k], spec.mound ? st.height * (1 - 0.55 * r * r) : st.height);
      T.flags[k] |= F.STRUCT; T.veg[k] = 0;
    });
  }
  for (const p of positions) {
    if (p.type === 'mgnest') {
      T.stampCircle(p.x, p.y, 3.4, (k, d) => {
        if (d > 0.62) T.obj[k] = Math.max(T.obj[k], 0.95); else T.ground[k] -= 0.4;
        T.veg[k] *= 0.3;
      });
    } else if (p.type === 'gunpit') {
      T.stampCircle(p.x, p.y, 5.5, (k, d) => {
        if (d > 0.7) T.obj[k] = Math.max(T.obj[k], 1.0); else T.ground[k] -= 0.5;
        T.veg[k] = 0;
      });
    } else if (p.type === 'revet') {
      T.stampRect(p.x, p.y, 12, 12, p.dir + Math.PI / 2, (k, u, v) => {
        if (Math.abs(u) > 0.62 || v > 0.6) T.obj[k] = Math.max(T.obj[k], 1.8);
        T.veg[k] = 0;
      });
    }
  }

  // rifle pits along trenches and the shore line (generic JP fighting positions)
  let tp = 0;
  const pits = scatter(rng, 300, 1000, 3500, 1650, 9000, 26, (x, y) => {
    const i = T.idx(x, y); if (s[i] > -12 || s[i] < -140) return false;
    return !(T.flags[i] & (F.STRUCT | F.BUILDING | F.SEAWALL)) && T.surf[i] < 0.5;
  });
  for (const [x, y] of pits) {
    const i = T.idx(x, y);
    const facing = (y - axis[(x / c) | 0] < 0) ? NORTH : SOUTH;
    const dir = x < 450 ? WEST : x > 3300 ? EAST : facing;
    positions.push({ id: 'tp' + (tp++), type: 'foxhole', x, y, dir });
    if (!(T.flags[i] & F.TRENCH)) {
      T.stampCircle(x, y, 1.7, (k, d) => { T.ground[k] -= 0.75 * (1 - d * d); T.veg[k] *= 0.5; });
      decals.push({ k: DK.FOXHOLE, x, y, hw: 1.8, hh: 1.8, rot: rng() * 3 });
    }
  }

  // ---------- buildings ----------
  const buildings = [];
  const addBldg = (x, y, w, h, rot, destroyed, kind = K.BUILDING) => {
    const b = { x, y, w, h, rot, destroyed, kind };
    buildings.push(b);
    T.stampRect(x, y, w, h, rot, (k) => {
      if (destroyed) { T.obj[k] = Math.max(T.obj[k], 0.9); }
      else { T.obj[k] = Math.max(T.obj[k], kind === K.HUT ? 2.6 : 3.8); T.flags[k] |= F.BUILDING; }
      T.veg[k] = 0;
    });
    props.push(P(destroyed ? K.RUBBLE : kind, x, y, w / 2, h / 2, rot, destroyed ? 1 : 0, rng()));
  };
  const bl = [
    [1420, 1172, 24, 10, 0.02], [1565, 1170, 22, 10, -0.02], [1775, 1190, 30, 12, 0.05], [1300, 1195, 16, 8, 0],
    [1190, 1520, 32, 9, -0.06], [1210, 1545, 32, 9, -0.06], [1500, 1530, 34, 9, -0.05], [1520, 1555, 34, 9, -0.05],
    [1800, 1500, 30, 9, -0.08], [1820, 1525, 30, 9, -0.08], [2400, 1450, 24, 9, -0.12], [2430, 1420, 18, 8, -0.12],
    [880, 1500, 26, 9, 0.02], [900, 1525, 26, 9, 0.02], [600, 1460, 18, 8, 0.4], [2050, 1460, 20, 10, -0.1],
    [2650, 1380, 16, 8, -0.15], [2700, 1330, 14, 7, -0.15], [3000, 1300, 14, 8, -0.2], [3080, 1340, 12, 8, -0.2],
    [1960, 1180, 18, 8, 0], [1050, 1240, 14, 7, 0.1], [700, 1290, 14, 7, 0.3],
  ];
  for (const [x, y, w, h, r] of bl) addBldg(x, y, w, h, r, rng() < 0.55);
  for (let i = 0; i < 26; i++) {
    const x = rng.range(2500, 3450), y = rng.range(1180, 1420);
    const ii = T.idx(x, y);
    if (s[ii] > -20 || T.flags[ii] & (F.STRUCT | F.BUILDING)) continue;
    addBldg(x, y, rng.range(5, 8), rng.range(4, 6), rng.range(-0.4, 0.4), rng() < 0.4, K.HUT);
  }
  // wrecked trucks / dumps
  for (let i = 0; i < 18; i++) {
    const x = rng.range(600, 2600), y = rng.range(1150, 1550);
    const ii = T.idx(x, y);
    if (s[ii] > -25 || T.flags[ii] & (F.STRUCT | F.BUILDING | F.TRENCH)) continue;
    const rot = rng() * 6.28;
    T.stampRect(x, y, 5.5, 2.2, rot, (k) => { T.obj[k] = Math.max(T.obj[k], 1.6); });
    props.push(P(rng() < 0.6 ? K.TRUCK : K.CRATE, x, y, rng() < 0.6 ? 2.8 : 2.2, 1.2, rot, 1, rng()));
  }

  // craters after structures so they don't wreck the footprint data
  for (const [x, y, r] of craterList) {
    if (T.addCrater(x, y, r, 0.35 + r * 0.17)) decals.push({ k: DK.CRATER, x, y, hw: r * 1.5, hh: r * 1.5, rot: rng() * 6.28, p0: rng() });
  }

  // ---------- palms ----------
  const airfieldAt = (x, y) => T.surf[T.idx(x, y)] > 0.3;
  const pts = scatter(rng, 290, 1000, 3640, 1670, 26000, 6.5, (x, y) => {
    const i = T.idx(x, y);
    if (s[i] > -10 || airfieldAt(x, y) || T.flags[i] & (F.STRUCT | F.BUILDING | F.SEAWALL | F.TRENCH)) return false;
    const dens = fbm(x / 130, y / 130, 3, 31) + (x > 2450 ? 0.25 : 0) + T.veg[i] * 0.3;
    return dens > 0.62 + rng() * 0.1;
  });
  for (const [x, y] of pts) {
    const ny_ = y - northY(clamp(x, 300, 3600));
    // bombardment damage: worst near the north beaches & airfield
    let dmg = clamp(1.1 - ny_ / 260, 0, 1) * 0.8 + rng() * 0.45;
    if (x > 2500) dmg *= 0.5;
    dmg = clamp(dmg, 0, 1);
    if (dmg > 0.82) {
      props.push(P(K.STUMP, x, y, 1.2, 1.2, rng() * 6.28, rng(), dmg));
      if (rng() < 0.5) props.push(P(K.DEBRIS, x + rng.range(-4, 4), y + rng.range(-4, 4), 3.5, 0.6, rng() * 6.28, rng()));
    } else {
      const size = rng.range(4.2, 6.5) * (1 - dmg * 0.35);
      canopy.push(P(K.PALM, x, y, size, size, rng() * 6.28, rng(), dmg));
      T.stampCircle(x, y, 3, (k) => { T.veg[k] = Math.max(T.veg[k], 0.22); });
    }
  }

  const labels = [
    { t: 'LAGOON', x: 1500, y: 260, s: 3 }, { t: 'RED BEACH 1', x: 690, y: 985, s: 1.4 }, { t: 'RED BEACH 2', x: 1230, y: 990, s: 1.4 },
    { t: 'RED BEACH 3', x: 1900, y: 1000, s: 1.4 }, { t: 'GREEN BEACH', x: 165, y: 1330, s: 1.4, rot: -Math.PI / 2 },
    { t: 'BLACK BEACH 1', x: 1000, y: 1745, s: 1.2 }, { t: 'BLACK BEACH 2', x: 2050, y: 1705, s: 1.2 },
    { t: 'LONG PIER', x: 1560, y: 780, s: 1, rot: -Math.PI / 2 }, { t: 'BURNS-PHILP WHARF', x: 2345, y: 960, s: 0.8 },
    { t: 'AIRFIELD', x: 1400, y: 1470, s: 1.6 }, { t: 'SAIDA MARU', x: 1225, y: 660, s: 0.8 },
    { t: 'THE POCKET', x: 935, y: 1170, s: 0.8 }, { t: 'TAKARONGO PT', x: 3420, y: 1440, s: 0.9 },
    { t: 'REEF EDGE', x: 900, y: 560, s: 0.9 }, { t: 'BETIO', x: 1900, y: 1850, s: 3 },
  ];

  return {
    id: 'betio', name: 'Betio', terrain: T, w: BETIO_W, h: BETIO_H, props, canopy, decals, structures, positions, labels,
    poly, northY, southY, westX, signed: s, buildings,
  };
}

// Fortification specs. hp is "structural integrity"; armor is resistance to direct fire (mm equivalent).
export const STRUCT_SPECS = {
  pillbox:   { w: 7, h: 7, height: 2.1, hp: 420, armor: 90, arc: 0.85, mound: false, sprite: K.PILLBOX, cap: 6 },
  steelpb:   { w: 6, h: 6, height: 2.2, hp: 520, armor: 120, arc: 0.95, mound: false, sprite: K.PILLBOX, cap: 5 },
  bunker:    { w: 13, h: 9, height: 2.6, hp: 650, armor: 110, arc: 1.05, mound: true, sprite: K.BUNKER, cap: 10 },
  bombproof: { w: 44, h: 26, height: 6.5, hp: 3200, armor: 400, arc: 1.4, mound: true, sprite: K.BUNKER, cap: 30 },
  command:   { w: 22, h: 16, height: 7.5, hp: 5000, armor: 600, arc: 3.2, mound: false, sprite: K.BLOCKHOUSE, cap: 15 },
  coastgun:  { w: 16, h: 16, height: 1.6, hp: 400, armor: 60, arc: 2.2, mound: false, sprite: K.COASTGUN, cap: 8 },
  hulk:      { w: 88, h: 15, height: 6, hp: 99999, armor: 999, arc: 3.2, mound: false, sprite: K.HULK, cap: 8 },
  log:       { w: 8, h: 6, height: 1.8, hp: 320, armor: 60, arc: 1.0, mound: true, sprite: K.BUNKER, cap: 6 },
};
