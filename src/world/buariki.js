// Buariki islet (north Tarawa) — dense jungle, Gilbertese village, the last Japanese stand, 27 Nov 1943.
import { Terrain, F } from './terrain.js';
import { K, DK } from '../kinds.js';
import { signedField, polyXRange, scatter, resamplePolyline } from './mapgen.js';
import { makeRng, fbm, vnoise, smoothPoly, clamp, smoothstep, lerp } from '../util.js';
import { STRUCT_SPECS } from './betio.js';

export const BUARIKI_W = 1500, BUARIKI_H = 2000;

const OUTLINE = [
  [640, 1960], [560, 1700], [520, 1450], [500, 1200], [520, 950], [560, 700], [600, 480], [650, 300], [700, 160], [760, 90],
  [830, 120], [880, 260], [920, 450], [960, 700], [990, 950], [1000, 1200], [990, 1450], [960, 1700], [920, 1960],
];

export function buildBuariki() {
  const rng = makeRng(27111943);
  const T = new Terrain(BUARIKI_W, BUARIKI_H, 2);
  T.water = 0.4;
  const poly = smoothPoly(OUTLINE, 5, true);
  const { s } = signedField(T.nx, T.ny, T.cell, [poly]);
  const nx = T.nx, ny = T.ny, c = T.cell;
  for (let cy = 0; cy < ny; cy++) for (let cx = 0; cx < nx; cx++) {
    const i = cy * nx + cx, x = (cx + 0.5) * c, y = (cy + 0.5) * c;
    const sd = s[i];
    const n1 = fbm(x / 90, y / 90, 4, 2), n2 = fbm(x / 14, y / 14, 3, 9);
    const lagoonSide = x < 760;
    const reef = (lagoonSide ? 260 : 150) + (n1 - 0.5) * 100;
    let h;
    if (sd < 0) h = 1.1 + 1.6 * smoothstep(0, 60, -sd) + (n1 - 0.5) * 0.8 + (n2 - 0.5) * 0.3;
    else if (sd < 36) h = 1.1 - sd / 36 * 1.9 + (n2 - 0.5) * 0.1;
    else if (sd < reef) h = -0.8 + (n1 - 0.5) * 0.3 + (n2 - 0.5) * 0.2;
    else h = -1 - 9 * smoothstep(0, 1, (sd - reef) / 60) + (n1 - 0.5);
    T.ground[i] = h;
    if (sd < -12) T.veg[i] = clamp(0.45 + fbm(x / 60, y / 60, 4, 12) * 0.6 + (n2 - 0.5) * 0.2, 0, 0.95);
  }
  const props = [], canopy = [], decals = [], structures = [], positions = [];
  const P = (k, x, y, hw, hh, rot = 0, p0 = 0, p1 = 0) => ({ k, x, y, hw, hh, rot, p0, p1, p2: 0, p3: 0 });
  const midX = (y) => { const r = polyXRange(poly, y); return (r[0] + r[1]) / 2; };

  // a footpath running up the islet
  const path = [];
  for (let y = 1950; y > 150; y -= 40) path.push([midX(y) + Math.sin(y / 130) * 40, y]);
  const pl = resamplePolyline(path, 3);
  for (let i = 1; i < pl.length; i++) {
    T.stampLine(pl[i - 1][0], pl[i - 1][1], pl[i][0], pl[i][1], 4, (k) => { T.veg[k] *= 0.25; T.surf[k] = Math.max(T.surf[k], 0.35); });
  }
  // village clearing
  const vx = midX(900), vy = 900;
  T.stampCircle(vx, vy, 70, (k, d) => { T.veg[k] *= d * 0.6; T.surf[k] = Math.max(T.surf[k], 0.3 * (1 - d)); });
  const buildings = [];
  const addHut = (x, y, w, h, rot, maneaba = false) => {
    buildings.push({ x, y, w, h, rot });
    T.stampRect(x, y, w, h, rot, (k) => { T.obj[k] = Math.max(T.obj[k], maneaba ? 3.5 : 2.4); T.flags[k] |= F.BUILDING; T.veg[k] = 0; });
    props.push(P(K.HUT, x, y, w / 2, h / 2, rot, 0, rng()));
  };
  addHut(vx, vy, 22, 12, 0.1, true); // maneaba (meeting house)
  for (let i = 0; i < 16; i++) {
    const a = rng() * 6.28, r = rng.range(25, 65);
    const x = vx + Math.cos(a) * r, y = vy + Math.sin(a) * r;
    if (s[T.idx(x, y)] > -15) continue;
    addHut(x, y, rng.range(5, 8), rng.range(4, 6), rng.range(-0.5, 0.5));
  }
  // Japanese log bunkers & foxholes in the northern half
  const NORTH = -Math.PI / 2, SOUTH = Math.PI / 2;
  const addStruct = (id, type, x, y, dir, name) => {
    const spec = STRUCT_SPECS[type];
    const st = { id, type, name, x, y, w: spec.w, h: spec.h, rot: dir + Math.PI / 2, dir, arc: spec.arc, height: spec.height };
    structures.push(st);
    T.stampRect(x, y, st.w + 4, st.h + 4, st.rot, (k, u, v) => { T.ground[k] += (1 - Math.max(Math.abs(u), Math.abs(v))) * 0.5; });
    T.stampRect(x, y, st.w, st.h, st.rot, (k) => { T.obj[k] = Math.max(T.obj[k], st.height); T.flags[k] |= F.STRUCT; T.veg[k] *= 0.5; });
  };
  addStruct('log1', 'log', midX(760) - 60, 760, SOUTH, 'Log bunker (west)');
  addStruct('log2', 'log', midX(720) + 50, 720, SOUTH, 'Log bunker (east)');
  addStruct('log3', 'log', midX(540), 540, SOUTH, 'Log bunker (north)');
  addStruct('log4', 'log', midX(380) - 30, 380, SOUTH, 'Log bunker (point)');
  let tp = 0;
  const pits = scatter(rng, 450, 250, 1050, 1300, 4000, 22, (x, y) => s[T.idx(x, y)] < -10);
  for (const [x, y] of pits) {
    positions.push({ id: 'tp' + (tp++), type: 'foxhole', x, y, dir: SOUTH });
    T.stampCircle(x, y, 1.6, (k, d) => { T.ground[k] -= 0.7 * (1 - d * d); });
    decals.push({ k: DK.FOXHOLE, x, y, hw: 1.7, hh: 1.7, rot: rng() * 3 });
  }
  positions.push({ id: 'mg_n1', type: 'mgnest', x: midX(820) - 20, y: 820, dir: SOUTH });
  positions.push({ id: 'mg_n2', type: 'mgnest', x: midX(640) + 30, y: 640, dir: SOUTH });
  for (const p of positions) if (p.type === 'mgnest') T.stampCircle(p.x, p.y, 3.2, (k, d) => { if (d > 0.62) T.obj[k] = Math.max(T.obj[k], 0.9); });

  // dense palms & pandanus
  const pts = scatter(rng, 480, 80, 1020, 1990, 30000, 5.2, (x, y) => {
    const i = T.idx(x, y);
    return s[i] < -6 && !(T.flags[i] & (F.BUILDING | F.STRUCT)) && T.surf[i] < 0.25;
  });
  for (const [x, y] of pts) {
    const size = rng.range(4, 6.8);
    canopy.push(P(K.PALM, x, y, size, size, rng() * 6.28, rng(), rng() * 0.15));
  }
  // light bombardment scars from the approach
  for (let i = 0; i < 40; i++) {
    const x = rng.range(520, 980), y = rng.range(700, 1400), r = rng.range(2, 4);
    if (s[T.idx(x, y)] < -8 && T.addCrater(x, y, r, 0.6)) decals.push({ k: DK.CRATER, x, y, hw: r * 1.5, hh: r * 1.5, rot: rng() * 6, p0: rng() });
  }
  const labels = [
    { t: 'LAGOON', x: 230, y: 1000, s: 2.4, rot: -Math.PI / 2 }, { t: 'PACIFIC OCEAN', x: 1290, y: 1000, s: 2, rot: Math.PI / 2 },
    { t: 'BUARIKI VILLAGE', x: vx, y: vy - 95, s: 1 }, { t: 'BUARIKI', x: 760, y: 40, s: 2.4 }, { t: 'TO NAA', x: 760, y: 1975, s: 1 },
  ];
  return { id: 'buariki', name: 'Buariki', terrain: T, w: BUARIKI_W, h: BUARIKI_H, props, canopy, decals, structures, positions, labels, poly, buildings, village: [vx, vy], midX, signed: s };
}
