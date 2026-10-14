// Strategic map of Tarawa atoll (Gilbert Islands), rendered with the same terrain shader at 40 m/cell.
import { Terrain } from './terrain.js';
import { K } from '../kinds.js';
import { fbm, distToSeg, distToPoly, pointInPoly, smoothPoly, smoothstep, clamp, lerp } from '../util.js';

export const ATOLL_W = 27000, ATOLL_H = 36000;

const RIM = smoothPoly([
  [3200, 33600], [8000, 33300], [12000, 33050], [17000, 32850], [21600, 32600], [22300, 29500], [22550, 26000],
  [22050, 21000], [21350, 16000], [20550, 11000], [19500, 7000], [18300, 3700], [16000, 5800], [13000, 10500],
  [9200, 17500], [5600, 24500], [3500, 30000],
], 4, true);

export const ISLETS = [
  { id: 'betio', name: 'Betio', pts: [[1900, 33780], [3300, 33520], [5300, 33380]], w: 520 },
  { id: 'bairiki', name: 'Bairiki', pts: [[6500, 33330], [8300, 33170]], w: 330 },
  { id: 'nanikai', name: 'Nanikai', pts: [[9000, 33110], [10000, 33060]], w: 230 },
  { id: 'teaoraereke', name: 'Teaoraereke', pts: [[10800, 33020], [12600, 32950]], w: 320 },
  { id: 'eita', name: 'Eita', pts: [[13400, 32920], [16500, 32790]], w: 330 },
  { id: 'bonriki', name: 'Bonriki', pts: [[17400, 32760], [20200, 32640], [21700, 32300]], w: 700 },
  { id: 'buota', name: 'Buota', pts: [[22050, 31300], [22350, 29200]], w: 380 },
  { id: 'abatao', name: 'Abatao', pts: [[22420, 28600], [22520, 26500]], w: 340 },
  { id: 'tabiteuea', name: 'Tabiteuea', pts: [[22450, 25500], [22180, 22000]], w: 400 },
  { id: 'abaokoro', name: 'Abaokoro', pts: [[21800, 20500], [21400, 16600]], w: 400 },
  { id: 'marenanuka', name: 'Marenanuka', pts: [[21100, 15000], [20650, 11600]], w: 340 },
  { id: 'buariki', name: 'Buariki', pts: [[20250, 10500], [19300, 6500]], w: 620 },
  { id: 'naa', name: 'Naa', pts: [[19000, 6000], [18300, 3800]], w: 380 },
];

export function buildAtoll() {
  const T = new Terrain(ATOLL_W, ATOLL_H, 60);
  T.water = 0;
  const nx = T.nx, ny = T.ny, c = T.cell;
  for (let cy = 0; cy < ny; cy++) for (let cx = 0; cx < nx; cx++) {
    const i = cy * nx + cx, x = (cx + 0.5) * c, y = (cy + 0.5) * c;
    const n1 = fbm(x / 1400, y / 1400, 4, 3), n2 = fbm(x / 300, y / 300, 3, 5);
    let isl = Infinity;
    for (const it of ISLETS) for (let k = 1; k < it.pts.length; k++) {
      const a = it.pts[k - 1], b = it.pts[k];
      isl = Math.min(isl, distToSeg(x, y, a[0], a[1], b[0], b[1]) - it.w / 2 * (0.85 + n2 * 0.3));
    }
    const rim = distToPoly(x, y, RIM) - (520 + (n1 - 0.5) * 500);
    const inside = pointInPoly(x, y, RIM);
    let h;
    if (isl < 0) h = 1 + smoothstep(0, 150, -isl) * 1.5;
    else if (isl < 60) h = 1 - isl / 60 * 1.8;
    else if (rim < 0) h = -0.8 - (n2 - 0.5) * 0.4 + smoothstep(-200, 0, rim) * -0.5;
    else if (inside) h = -1.5 - smoothstep(0, 1500, rim) * 7 - (n1 - 0.5) * 3;
    else h = -1.5 - smoothstep(0, 900, rim) * 40;
    T.ground[i] = h;
    if (isl < -30) T.veg[i] = clamp(0.5 + (n2 - 0.5) * 0.8, 0, 0.9);
  }
  const ships = [
    { x: 600, y: 31500, rot: 0.3, s: 1.4, name: 'USS Maryland' }, { x: 900, y: 29800, rot: 0.2, s: 1.3, name: 'USS Colorado' },
    { x: -400, y: 33000, rot: 0.1, s: 1.2, name: 'Transports' }, { x: 300, y: 34700, rot: -0.1, s: 1.0, name: '' },
    { x: 6300, y: 30200, rot: 2.3, s: 0.7, name: 'USS Ringgold' }, { x: 6900, y: 30700, rot: 2.4, s: 0.7, name: 'USS Dashiell' },
    { x: -600, y: 30500, rot: 0.2, s: 1.0, name: '' }, { x: 1800, y: 28500, rot: 0.4, s: 0.9, name: '' },
  ];
  const props = ships.map(s => ({ k: K.SHIP, x: s.x + 1200, y: s.y, hw: 320 * s.s, hh: 56 * s.s, rot: s.rot, p0: s.s, p1: 0, p2: 0, p3: 0 }));
  return { id: 'atoll', name: 'Tarawa Atoll', terrain: T, w: ATOLL_W, h: ATOLL_H, props, canopy: [], decals: [], structures: [], positions: [], labels: [], ships };
}
