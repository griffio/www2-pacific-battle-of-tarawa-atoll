#!/usr/bin/env python3
"""Pre-render the game's top-down sprites (palms, vehicles, landing craft) with a tiny 2.5-D software renderer.

  python3 tools/render_sprites.py          # writes assets/sprites/{atlas_a.webp, atlas_n.webp, manifest.json}

Everything is modelled procedurally from simple solids (tubes, bevelled prisms, ellipsoids) composited into a
height buffer seen from straight above, 2× supersampled. Outputs, per sprite:
  atlas_a  albedo RGB + coverage alpha (colour bled into transparent texels so mips don't fringe)
  atlas_n  surface normal XY (R,G), height above the sprite's base / 8 m (B), ambient occlusion (A)
The game lights sprites at runtime with the sun rotated into each sprite's frame, so lighting stays correct as
vehicles turn. Sprite space: +x = forward (bow / gun), +y = starboard (screen-down at rotation 0), metres.
No external art: the models are written below.
"""
import json, math, os, random, sys
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets', 'sprites')
SS = 2            # supersampling
HMAX = 8.0        # height encoding range (m)
BG = -1e9


def vnoise(h, w, cell, seed, octaves=1):
    """Smooth value noise in [0,1] (bicubic-upsampled random lattice)."""
    rng = np.random.default_rng(seed)
    out = np.zeros((h, w), np.float32); amp = 1.0; tot = 0.0
    for o in range(octaves):
        c = max(1.0, cell / (2 ** o))
        gh, gw = int(h / c) + 3, int(w / c) + 3
        g = Image.fromarray((rng.random((gh, gw)) * 255).astype(np.uint8))
        g = g.resize((int(gw * c), int(gh * c)), Image.BICUBIC)
        out += np.asarray(g, np.float32)[:h, :w] / 255.0 * amp
        tot += amp; amp *= 0.5
    return out / tot


def _box1(a, r, axis):
    # running mean of width 2r+1 along an axis, edge-clamped
    if r < 1: return a
    pad = [(0, 0)] * a.ndim; pad[axis] = (r + 1, r)
    c = np.cumsum(np.pad(a, pad, mode='edge'), axis=axis, dtype=np.float64)
    hi = np.take(c, range(2 * r + 1, c.shape[axis]), axis=axis)
    lo = np.take(c, range(0, c.shape[axis] - 2 * r - 1), axis=axis)
    return ((hi - lo) / (2 * r + 1)).astype(np.float32)


def gblur(a, sigma):
    # three box passes approximate a gaussian
    r = max(1, int(round(sigma * 0.87)))
    for _ in range(3):
        a = _box1(_box1(a, r, 0), r, 1)
    return a


class Sprite:
    def __init__(self, name, wm, hm, ppm, pad=0.4):
        self.name, self.ppm = name, ppm * SS
        self.wm, self.hm = wm + pad * 2, hm + pad * 2
        self.W = int(math.ceil(self.wm * self.ppm / SS)) * SS
        self.H = int(math.ceil(self.hm * self.ppm / SS)) * SS
        self.z = np.full((self.H, self.W), BG, np.float32)
        self.col = np.zeros((self.H, self.W, 3), np.float32)
        ys, xs = np.mgrid[0:self.H, 0:self.W]
        self.X = ((xs + 0.5) - self.W / 2) / self.ppm
        self.Y = ((ys + 0.5) - self.H / 2) / self.ppm
        self.meta = {}

    # ---- helpers
    def _sl(self, x0, y0, x1, y1):
        p = self.ppm
        c0 = max(0, int((x0 * p) + self.W / 2) - 1); c1 = min(self.W, int((x1 * p) + self.W / 2) + 2)
        r0 = max(0, int((y0 * p) + self.H / 2) - 1); r1 = min(self.H, int((y1 * p) + self.H / 2) + 2)
        if c1 <= c0 or r1 <= r0: return None
        return (slice(r0, r1), slice(c0, c1))

    def _write(self, sl, z, color, mode='max'):
        Z = self.z[sl]
        m = ~np.isnan(z)
        if mode == 'max': m &= z > Z
        if not m.any(): return
        Z[m] = z[m]
        C = self.col[sl]
        if callable(color): color = color(self.X[sl], self.Y[sl])
        color = np.asarray(color, np.float32)
        if color.ndim == 1: C[m] = color
        else: C[m] = color[m]

    # ---- primitives
    def tube(self, a, b, r0, r1, z0, z1, color, roundness=1.0, mode='max'):
        a = np.asarray(a, np.float32); b = np.asarray(b, np.float32)
        R = max(r0, r1)
        sl = self._sl(min(a[0], b[0]) - R, min(a[1], b[1]) - R, max(a[0], b[0]) + R, max(a[1], b[1]) + R)
        if sl is None: return
        X, Y = self.X[sl], self.Y[sl]
        d = b - a; L2 = float(d @ d) or 1e-9
        t = np.clip(((X - a[0]) * d[0] + (Y - a[1]) * d[1]) / L2, 0, 1)
        px, py = X - (a[0] + t * d[0]), Y - (a[1] + t * d[1])
        dist2 = px * px + py * py
        r = r0 + (r1 - r0) * t
        inside = dist2 < r * r
        z = np.where(inside, z0 + (z1 - z0) * t + roundness * np.sqrt(np.maximum(r * r - dist2, 0)), np.nan)
        self._write(sl, z, color, mode)

    def prism(self, poly, z0, z1, bevel, color, mode='max', profile='round'):
        P = np.asarray(poly, np.float32)
        sl = self._sl(P[:, 0].min(), P[:, 1].min(), P[:, 0].max(), P[:, 1].max())
        if sl is None: return
        X, Y = self.X[sl], self.Y[sl]
        inside = np.zeros(X.shape, bool); dmin = np.full(X.shape, 1e9, np.float32)
        n = len(P)
        for i in range(n):
            ax, ay = P[i]; bx, by = P[(i + 1) % n]
            cond = ((ay > Y) != (by > Y)) & (X < (bx - ax) * (Y - ay) / (by - ay + 1e-12) + ax)
            inside ^= cond
            dx, dy = bx - ax, by - ay; L2 = dx * dx + dy * dy or 1e-12
            t = np.clip(((X - ax) * dx + (Y - ay) * dy) / L2, 0, 1)
            ex, ey = X - (ax + t * dx), Y - (ay + t * dy)
            dmin = np.minimum(dmin, np.sqrt(ex * ex + ey * ey))
        if bevel > 0:
            e = np.minimum(dmin, bevel)
            if profile == 'round': top = z1 - bevel + np.sqrt(np.maximum(bevel * bevel - (bevel - e) ** 2, 0))
            else: top = z1 - bevel + e
            top = np.maximum(top, z0)
        else:
            top = np.full(X.shape, z1, np.float32)
        z = np.where(inside, top, np.nan)
        self._write(sl, z, color, mode)

    def box(self, cx, cy, hx, hy, z0, z1, bevel, color, rot=0.0, mode='max', profile='round'):
        c, s = math.cos(rot), math.sin(rot)
        pts = [(cx + x * c - y * s, cy + x * s + y * c) for x, y in [(-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)]]
        self.prism(pts, z0, z1, bevel, color, mode, profile)

    def disk(self, cx, cy, r, z0, z1, bevel, color, n=40, mode='max'):
        self.prism([(cx + r * math.cos(a), cy + r * math.sin(a)) for a in np.linspace(0, 2 * math.pi, n, endpoint=False)], z0, z1, bevel, color, mode)

    def ellipsoid(self, cx, cy, rx, ry, zb, zh, color, rot=0.0, mode='max'):
        R = max(rx, ry)
        sl = self._sl(cx - R, cy - R, cx + R, cy + R)
        if sl is None: return
        X, Y = self.X[sl] - cx, self.Y[sl] - cy
        c, s = math.cos(rot), math.sin(rot)
        u, v = (X * c + Y * s) / rx, (-X * s + Y * c) / ry
        q = 1 - u * u - v * v
        z = np.where(q > 0, zb + zh * np.sqrt(np.maximum(q, 0)), np.nan)
        self._write(sl, z, color, mode)

    # ---- output
    def finish(self, tint_noise=0.0, seed=0):
        cov = self.z > BG / 2
        z = np.where(cov, self.z, 0.0).astype(np.float32)
        col = self.col.copy()
        if tint_noise:
            n = vnoise(self.H, self.W, 6 * SS, seed, 3)
            col *= (1 - tint_noise + 2 * tint_noise * n)[..., None]
        # normals from the height field (y grows down the image)
        gy, gx = np.gradient(z, 1.0 / self.ppm)
        gx = np.clip(gx, -6, 6); gy = np.clip(gy, -6, 6)
        nrm = np.stack([-gx, -gy, np.ones_like(z)], -1)
        nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
        # ambient occlusion: how far each texel sits below its blurred surroundings at a few radii
        ao = np.ones_like(z)
        for rad, k in [(0.15, 1.6), (0.45, 0.9), (1.2, 0.35)]:
            blur = gblur(z, rad * self.ppm)
            ao *= np.clip(1 - np.maximum(blur - z, 0) * k, 0, 1)
        ao = np.clip(ao, 0.25, 1)
        # downsample (premultiplied by coverage)
        h, w = self.H // SS, self.W // SS
        def down(a):
            return a.reshape(h, SS, w, SS, *a.shape[2:]).mean((1, 3))
        a = down(cov.astype(np.float32))
        ca = down(col * cov[..., None]); na = down(nrm * cov[..., None]); za = down(z * cov); aoa = down(ao * cov)
        safe = np.maximum(a, 1e-6)
        col_s = ca / safe[..., None]; n_s = na / safe[..., None]; z_s = za / safe; ao_s = aoa / safe
        n_s /= np.maximum(np.linalg.norm(n_s, axis=-1, keepdims=True), 1e-6)
        # bleed colour/normal into transparent texels (avoids dark fringes in mips)
        filled = a > 0.02
        for _ in range(12):
            if filled.all(): break
            acc_c = np.zeros_like(col_s); acc_n = np.zeros_like(n_s); acc_w = np.zeros_like(a)
            for dy, dx in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                m = np.roll(filled, (dy, dx), (0, 1)).astype(np.float32)
                acc_c += np.roll(col_s, (dy, dx), (0, 1)) * m[..., None]
                acc_n += np.roll(n_s, (dy, dx), (0, 1)) * m[..., None]; acc_w += m
            grow = (~filled) & (acc_w > 0)
            col_s[grow] = acc_c[grow] / acc_w[grow][:, None]; n_s[grow] = acc_n[grow] / acc_w[grow][:, None]
            filled |= grow
        col_s[~filled] = col_s[filled].mean(0) if filled.any() else 0.5
        n_s[~filled] = (0, 0, 1)
        rgba = np.dstack([np.clip(col_s, 0, 1), a])
        nz = np.dstack([n_s[..., 0] * 0.5 + 0.5, n_s[..., 1] * 0.5 + 0.5, np.clip(z_s / HMAX, 0, 1), np.where(a > 0, ao_s, 1)])
        self.img_a = Image.fromarray((rgba * 255 + 0.5).astype(np.uint8), 'RGBA')
        self.img_n = Image.fromarray((np.clip(nz, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGBA')
        self.half = (self.wm / 2, self.hm / 2)
        return self


# --------------------------------------------------------------------------------------------- palms
def lerp(a, b, t): return a + (b - a) * t
def mixc(a, b, t): return tuple(lerp(x, y, t) for x, y in zip(a, b))


def palm(name, seed, dmg):
    """Coconut palm crown from above. dmg 0 = healthy, ~0.5 = shell-torn, ~0.9 = stripped."""
    rnd = random.Random(seed)
    S = Sprite(name, 13.0, 13.0, 30, pad=0.2)
    green, lime, olive = (0.25, 0.40, 0.13), (0.50, 0.56, 0.20), (0.36, 0.42, 0.16)
    brown, straw = (0.42, 0.32, 0.18), (0.62, 0.54, 0.32)
    N = rnd.randint(15, 19) if dmg < 0.3 else rnd.randint(8, 12) if dmg < 0.75 else rnd.randint(2, 4)
    base_rot = rnd.random() * 6.28
    fronds = []
    for k in range(N):
        a = base_rot + k * 2.399963 + rnd.uniform(-0.12, 0.12)    # golden-angle phyllotaxis
        tier = (k / N)                                           # 0 = young (top) … 1 = old (low)
        L = rnd.uniform(4.3, 5.6) * (0.85 + 0.25 * (1 - tier))
        broken = dmg > 0.3 and rnd.random() < dmg
        if broken: L *= rnd.uniform(0.25, 0.6)
        dead = (rnd.random() < 0.08 + 0.25 * tier * (dmg > 0.2)) or (dmg > 0.75 and rnd.random() < 0.7)
        fronds.append((tier, a, L, broken, dead))
    # draw old (low) fronds first; max-height compositing sorts the rest
    for tier, a, L, broken, dead in sorted(fronds, key=lambda f: -f[0]):
        rise, droop = 1.3 - tier * 0.7, 2.6 + tier * 2.2 + (2.5 if broken else 0)
        curl = rnd.uniform(-0.25, 0.25)
        pts = []
        for i in range(17):
            t = i / 16
            r = L * t * (1 - 0.18 * t * (1 + tier))
            ang = a + curl * t * t
            pts.append((math.cos(ang) * r, math.sin(ang) * r, rise * t - droop * t * t, ang))
        base = brown if dead else mixc(olive, straw, 0.25 + 0.3 * tier)
        for i in range(16):
            p, q = pts[i], pts[i + 1]
            S.tube(p[:2], q[:2], lerp(0.07, 0.02, i / 16), lerp(0.07, 0.02, (i + 1) / 16), p[2], q[2], base)
        # leaflets (pinnae)
        torn = 0.15 + 0.55 * dmg if not dead else 0.3
        step = 0.024
        t = 0.1
        while t < 0.97:
            i = int(t * 16); f = t * 16 - i
            p, q = pts[i], pts[min(i + 1, 16)]
            bx, by, bz = lerp(p[0], q[0], f), lerp(p[1], q[1], f), lerp(p[2], q[2], f)
            ang = lerp(p[3], q[3], f)
            for side in (-1, 1):
                if rnd.random() < torn * (1.4 if broken else 1): continue
                spread = math.radians(lerp(78, 38, t)) + rnd.uniform(-0.12, 0.12)
                la = ang + side * spread
                ln = 1.05 * math.sin(math.pi * min(1, t * 0.95 + 0.05)) ** 0.55 * rnd.uniform(0.8, 1.05) * (0.7 if broken else 1)
                hz = 0.88   # foreshortening of the drooping leaflet
                ex, ey = bx + math.cos(la) * ln * hz, by + math.sin(la) * ln * hz
                # slight sag: leaflet is two tubes
                mx, my = bx + math.cos(la) * ln * hz * 0.55, by + math.sin(la) * ln * hz * 0.55
                shade = rnd.uniform(0.85, 1.12)
                if dead: c = mixc(brown, straw, rnd.random() * 0.6)
                else:
                    c = mixc(green, lime, min(1, t * 0.6 + rnd.random() * 0.35))
                    c = mixc(c, straw, max(0, tier - 0.5) * 0.6 + dmg * 0.35 * rnd.random())
                c = tuple(min(1, x * shade) for x in c)
                S.tube((bx, by), (mx, my), 0.05, 0.042, bz, bz - 0.12 * ln, c, 0.6)
                S.tube((mx, my), (ex, ey), 0.042, 0.014, bz - 0.12 * ln, bz - 0.45 * ln - 0.1, c, 0.6)
            t += step * rnd.uniform(0.85, 1.2)
    # crown: frond bases and coconuts
    if dmg < 0.85:
        S.ellipsoid(0, 0, 0.42, 0.42, -0.3, 0.55, (0.36, 0.32, 0.18))
        for i in range(rnd.randint(5, 11) if dmg < 0.5 else rnd.randint(0, 4)):
            a = rnd.random() * 6.28; r = rnd.uniform(0.22, 0.42)
            S.ellipsoid(math.cos(a) * r, math.sin(a) * r, 0.12, 0.12, -0.35, 0.22, mixc((0.42, 0.45, 0.16), (0.48, 0.34, 0.16), rnd.random()))
    else:
        # snapped crown: splintered trunk top
        S.disk(0, 0, 0.2, -0.5, 0.0, 0.05, (0.45, 0.38, 0.26))
        for i in range(7):
            a = rnd.random() * 6.28
            S.tube((0, 0), (math.cos(a) * 0.3, math.sin(a) * 0.3), 0.05, 0.02, 0.0, -0.1, (0.55, 0.47, 0.32))
    S.meta = {'kind': 'palm', 'dmg': dmg}
    return S.finish(0.06, seed)


# --------------------------------------------------------------------------------------------- vehicles
OD = (0.33, 0.35, 0.22)        # US olive drab
NAVY = (0.46, 0.50, 0.53)      # USN haze grey
DARK = (0.10, 0.10, 0.09)
STEEL = (0.30, 0.30, 0.29)
WOOD = (0.48, 0.38, 0.25)
TRACK = (0.17, 0.16, 0.14)


def paint(base, sp, seed, wear=0.25):
    """Colour function: base paint with mottling, edge wear and dust."""
    def f(X, Y):
        h, w = X.shape
        n = vnoise(h, w, 10, seed, 3)
        c = np.ones((h, w, 3), np.float32) * np.array(base, np.float32)
        c *= (0.88 + 0.24 * n)[..., None]
        dust = vnoise(h, w, 40, seed + 7, 2)
        c = c * (1 - 0.25 * dust[..., None] * wear) + np.array((0.66, 0.6, 0.48)) * 0.25 * dust[..., None] * wear
        return c
    return f


def tracks(S, x0, x1, y, w, z, grouser=0.18, color=TRACK):
    """Track run seen from above: segmented links."""
    S.box((x0 + x1) / 2, y, (x1 - x0) / 2, w / 2, 0, z, 0.12, color)
    n = int((x1 - x0) / grouser)
    for i in range(n):
        x = x0 + (i + 0.5) * (x1 - x0) / n
        S.box(x, y, (x1 - x0) / n * 0.28, w / 2 * 0.98, 0, z + 0.05, 0.02, (0.24, 0.23, 0.2))


def troops(S, x0, x1, y0, y1, z, seed, n):
    """Helmets of embarked Marines filling a troop well."""
    rnd = random.Random(seed)
    # Marines packed in rows across the well, a few gaps
    rows = max(1, int(round((y1 - y0) / 0.62)) + 1)
    cols = max(1, int(math.ceil(n / rows)))
    spots = [(lerp(x0, x1, (c + 0.5) / cols), lerp(y0, y1, r / max(1, rows - 1)) if rows > 1 else (y0 + y1) / 2) for c in range(cols) for r in range(rows)]
    rnd.shuffle(spots)
    for sx, sy in spots[:n]:
        x, y = sx + rnd.uniform(-0.12, 0.12), sy + rnd.uniform(-0.08, 0.08)
        S.ellipsoid(x - 0.08, y, 0.26, 0.3, z, 0.35, (0.27, 0.30, 0.18))          # shoulders
        S.ellipsoid(x, y, 0.17, 0.17, z + 0.3, 0.17, mixc((0.36, 0.38, 0.24), (0.42, 0.40, 0.28), rnd.random()))   # helmet


def lvt(name, variant, loaded, seed):
    """LVT-1 Alligator (variant 0) / LVT-2 Water Buffalo (variant 1)."""
    L, W = (7.5, 3.0) if variant == 0 else (8.0, 3.25)
    S = Sprite(name, L, W, 40)
    hx, hy = L / 2, W / 2
    tw = 0.62 if variant == 0 else 0.55
    for side in (-1, 1):
        y = side * (hy - tw / 2)
        tracks(S, -hx + 0.15, hx - 0.1, y, tw, 1.55, 0.16)
        # LVT-1 W-shaped paddle grousers read as chevrons
        if variant == 0:
            for i in range(26):
                x = -hx + 0.3 + i * (L - 0.6) / 25
                S.tube((x, y - tw * 0.4), (x + 0.12, y), 0.035, 0.035, 1.6, 1.62, (0.3, 0.29, 0.26))
                S.tube((x + 0.12, y), (x, y + tw * 0.4), 0.035, 0.035, 1.62, 1.6, (0.3, 0.29, 0.26))
    hull = paint(OD, None, seed)
    inner = W - 2 * tw
    # hull body between the tracks, sloped bow
    bow = [(-hx + 0.2, -inner / 2 - 0.05), (hx - 1.1, -inner / 2 - 0.05), (hx - 0.15, -inner / 2 + 0.25),
           (hx - 0.15, inner / 2 - 0.25), (hx - 1.1, inner / 2 + 0.05), (-hx + 0.2, inner / 2 + 0.05)]
    S.prism(bow, 0, 1.9, 0.12, hull)
    # gunwales over the tracks
    for side in (-1, 1):
        S.box(-0.2, side * (hy - tw / 2), hx - 0.5, tw / 2 + 0.04, 0, 1.75, 0.06, hull)
    # open cargo well
    wl0, wl1 = (-hx + 0.6, hx - 2.0) if variant == 0 else (-hx + 0.45, hx - 2.2)
    S.box((wl0 + wl1) / 2, 0, (wl1 - wl0) / 2, inner / 2 - 0.12, 0, 0.7, 0.04, (0.24, 0.25, 0.18), mode='set')
    # ribs on the well floor
    for i in range(6):
        x = wl0 + (i + 0.5) * (wl1 - wl0) / 6
        S.box(x, 0, 0.04, inner / 2 - 0.15, 0, 0.75, 0.0, (0.2, 0.21, 0.15))
    # cab / driver's compartment with vision slits
    cx0 = wl1 + 0.15
    S.box(cx0 + 0.55, 0, 0.55, inner / 2 - 0.05, 0, 2.05, 0.1, hull)
    for y in (-0.35, 0.35):
        S.box(cx0 + 1.02, y, 0.05, 0.22, 0, 2.08, 0.0, DARK)
    # machine guns on the gunwale: M2 forward, M1919 aft
    S.tube((cx0 - 0.1, -inner / 2 + 0.2), (cx0 + 1.3, -inner / 2 + 0.3), 0.05, 0.035, 2.1, 2.05, DARK)
    S.disk(cx0 - 0.2, -inner / 2 + 0.2, 0.18, 0, 1.95, 0.04, STEEL)
    S.tube((wl0 + 0.4, inner / 2 - 0.2), (wl0 + 1.4, inner / 2 - 0.1), 0.04, 0.03, 2.0, 1.97, DARK)
    if loaded:
        troops(S, wl0 + 0.4, wl1 - 0.35, -inner / 2 + 0.45, inner / 2 - 0.45, 0.7, seed + 3, 14 if variant else 12)
    # bow number
    S.meta = {'kind': 'lvt', 'len': L, 'wid': W}
    return S.finish(0.05, seed)


def lcvp(name, ramp_down, loaded, seed):
    L, W = 11.0, 3.3
    S = Sprite(name, L + (1.6 if ramp_down else 0), W, 40)
    hx, hy = L / 2, W / 2
    off = -0.8 if ramp_down else 0
    gray = paint(NAVY, None, seed, 0.15)
    hull = [(-hx + off, -hy + 0.25), (-hx + 0.4 + off, -hy), (hx - 1.6 + off, -hy), (hx + off, -hy + 0.35),
            (hx + off, hy - 0.35), (hx - 1.6 + off, hy), (-hx + 0.4 + off, hy), (-hx + off, hy - 0.25)]
    S.prism(hull, 0, 1.35, 0.1, gray)
    # cargo well (plywood deck)
    S.box(0.6 + off, 0, 3.6, hy - 0.25, 0, 0.45, 0.03, paint(WOOD, None, seed + 1, 0.1), mode='set')
    for i in range(9):
        S.box(-3.0 + off + i * 0.9 + 0.45, 0, 0.02, hy - 0.27, 0, 0.47, 0, (0.38, 0.30, 0.2))
    # coxswain's station and engine house aft
    S.box(-4.1 + off, 0, 1.0, hy - 0.3, 0, 1.55, 0.12, gray)
    S.box(-3.6 + off, hy - 0.8, 0.35, 0.4, 0, 1.75, 0.06, (0.35, 0.38, 0.40))
    # .30 cal pulpits
    for side in (-1, 1):
        S.disk(-3.0 + off, side * (hy - 0.5), 0.25, 0, 1.6, 0.05, STEEL)
        S.tube((-3.0 + off, side * (hy - 0.5)), (-2.0 + off, side * (hy - 0.4)), 0.04, 0.03, 1.75, 1.72, DARK)
    # bow ramp
    if ramp_down:
        S.box(hx + off + 0.85, 0, 0.95, hy - 0.35, 0, 0.25, 0.05, gray)
        for i in range(6):
            S.box(hx + off + 0.2 + i * 0.28, 0, 0.03, hy - 0.4, 0, 0.3, 0, (0.38, 0.41, 0.43))
    else:
        S.box(hx - 0.55 + off, 0, 0.35, hy - 0.3, 0, 1.6, 0.08, gray)
    if loaded and not ramp_down:
        troops(S, -2.8 + off, 3.9 + off, -hy + 0.55, hy - 0.55, 0.45, seed + 5, 20)
    S.meta = {'kind': 'lcvp', 'len': L, 'wid': W, 'shift': off}
    return S.finish(0.04, seed)


def lcm(name, ramp_down, cargo_tank, seed):
    L, W = 15.0, 4.3
    S = Sprite(name, L + (1.8 if ramp_down else 0), W, 40)
    hx, hy = L / 2, W / 2
    off = -0.9 if ramp_down else 0
    gray = paint(NAVY, None, seed, 0.15)
    hull = [(-hx + off, -hy + 0.3), (-hx + 0.5 + off, -hy), (hx + off, -hy), (hx + off, hy), (-hx + 0.5 + off, hy), (-hx + off, hy - 0.3)]
    S.prism(hull, 0, 1.6, 0.1, gray)
    S.box(1.2 + off, 0, 5.4, hy - 0.3, 0, 0.5, 0.03, (0.36, 0.38, 0.38), mode='set')
    for i in range(12):
        S.box(-4.1 + off + i * 0.9, 0, 0.03, hy - 0.32, 0, 0.53, 0, (0.3, 0.32, 0.32))
    S.box(-5.9 + off, 0, 1.4, hy - 0.35, 0, 1.9, 0.12, gray)
    S.box(-5.4 + off, -0.8, 0.5, 0.5, 0, 2.3, 0.08, (0.35, 0.38, 0.40))
    if ramp_down:
        S.box(hx + off + 0.95, 0, 1.0, hy - 0.4, 0, 0.3, 0.05, gray)
    else:
        S.box(hx - 0.3 + off, 0, 0.3, hy - 0.3, 0, 1.75, 0.08, gray)
    S.meta = {'kind': 'lcm', 'len': L, 'wid': W, 'shift': off}
    return S.finish(0.04, seed)


def tank_hull(name, kind, seed):
    """Hull without turret. kind: sherman | stuart | hago."""
    if kind == 'sherman': L, W, H, col = 5.9, 2.62, 1.95, OD
    elif kind == 'stuart': L, W, H, col = 4.5, 2.24, 1.7, OD
    else: L, W, H, col = 4.3, 2.07, 1.45, None
    S = Sprite(name, L, W, 40)
    hx, hy = L / 2, W / 2
    if col is None:
        # IJA three-tone camouflage with the yellow recognition band
        def col(X, Y):
            h, w = X.shape
            n1 = vnoise(h, w, 34, seed, 2); n2 = vnoise(h, w, 30, seed + 11, 2)
            c = np.ones((h, w, 3), np.float32) * np.array((0.52, 0.47, 0.30), np.float32)
            c = np.where((n1 > 0.58)[..., None], np.array((0.38, 0.39, 0.25), np.float32), c)
            c = np.where((n2 > 0.64)[..., None], np.array((0.44, 0.35, 0.23), np.float32), c)
            return c * (0.9 + 0.2 * vnoise(h, w, 8, seed + 3, 2))[..., None]
    else:
        col = paint(col, None, seed)
    tw = 0.42 if kind == 'sherman' else 0.3
    for side in (-1, 1):
        tracks(S, -hx + 0.05, hx - 0.05, side * (hy - tw / 2), tw, 1.0 if kind != 'hago' else 0.8, 0.15)
    if kind == 'sherman':
        # cast/welded hull: sloped glacis, sponsons over the tracks
        hull = [(-hx + 0.15, -hy + 0.02), (hx - 1.2, -hy + 0.02), (hx - 0.2, -hy + 0.4), (hx - 0.2, hy - 0.4), (hx - 1.2, hy - 0.02), (-hx + 0.15, hy - 0.02)]
        S.prism(hull, 0, H, 0.35, col, profile='lin')
        S.box(-hx + 0.7, 0, 0.55, hy - 0.35, 0, H + 0.05, 0.08, col)                      # engine deck
        for i in range(5): S.box(-hx + 0.35 + i * 0.22, 0, 0.04, hy - 0.5, 0, H + 0.08, 0, (0.22, 0.24, 0.15))   # grille
        for y in (-0.55, 0.55): S.disk(hx - 1.15, y, 0.3, 0, H + 0.04, 0.06, col)          # driver & co-driver hatches
        S.tube((hx - 0.3, 0.55), (hx + 0.15, 0.6), 0.05, 0.04, H - 0.3, H - 0.35, DARK)    # bow MG
        for side in (-1, 1): S.box(-0.6, side * (hy - 0.15), 1.4, 0.07, 0, H - 0.1, 0.02, (0.25, 0.27, 0.17))  # tool racks
    elif kind == 'stuart':
        hull = [(-hx + 0.1, -hy + 0.05), (hx - 0.9, -hy + 0.05), (hx - 0.15, -hy + 0.35), (hx - 0.15, hy - 0.35), (hx - 0.9, hy - 0.05), (-hx + 0.1, hy - 0.05)]
        S.prism(hull, 0, H, 0.18, col, profile='lin')
        for i in range(4): S.box(-hx + 0.35 + i * 0.25, 0, 0.05, hy - 0.45, 0, H + 0.05, 0, (0.22, 0.24, 0.15))
        S.disk(hx - 0.8, -0.45, 0.24, 0, H + 0.04, 0.05, col); S.disk(hx - 0.8, 0.45, 0.24, 0, H + 0.04, 0.05, col)
        S.tube((hx - 0.25, 0.45), (hx + 0.15, 0.48), 0.04, 0.035, H - 0.25, H - 0.28, DARK)
    else:
        # riveted Ha-Go: narrow superstructure, offset hull MG
        S.box(0, 0, hx - 0.1, hy - 0.25, 0, H - 0.3, 0.06, col)
        S.box(0.4, 0, 1.55, hy - 0.05, 0, H, 0.05, col)
        S.box(-1.55, 0, 0.55, hy - 0.4, 0, H - 0.15, 0.05, col)
        for i in range(10):
            for side in (-1, 1): S.disk(-1.0 + i * 0.3, side * (hy - 0.12), 0.03, 0, H + 0.02, 0.0, (0.25, 0.22, 0.15))
        S.tube((hx - 0.4, -0.45), (hx + 0.05, -0.48), 0.04, 0.035, H - 0.25, H - 0.27, DARK)
        S.box(1.0, 0, 0.07, hy - 0.06, 0, H + 0.01, 0, (0.72, 0.66, 0.36))     # recognition stripe
    S.meta = {'kind': 'hull', 'len': L, 'wid': W}
    return S.finish(0.04, seed)


def tank_turret(name, kind, seed):
    if kind == 'sherman': R, gun, H, col = 0.95, 2.6, 2.75, paint(OD, None, seed)
    elif kind == 'stuart': R, gun, H, col = 0.68, 1.6, 2.35, paint(OD, None, seed)
    else: R, gun, H, col = 0.6, 1.2, 2.1, paint((0.52, 0.47, 0.30), None, seed)
    S = Sprite(name, (R + gun) * 2, R * 2.2, 40)
    if kind == 'sherman':
        S.ellipsoid(-0.1, 0, R * 1.05, R, H - 0.75, 0.75, col)
        S.ellipsoid(-R * 0.95, 0, 0.35, 0.55, H - 0.6, 0.45, col)                 # bustle
        S.box(R * 0.75, 0, 0.3, 0.5, H - 0.5, H - 0.3, 0.1, col)               # mantlet
        S.tube((R * 0.85, 0), (R + gun, 0), 0.075, 0.065, H - 0.42, H - 0.42, col)
        S.disk(R + gun - 0.05, 0, 0.09, H - 0.6, H - 0.33, 0.02, (0.2, 0.2, 0.18))
        S.disk(-0.25, 0.35, 0.3, 0, H + 0.05, 0.05, col)                         # commander's cupola
        S.disk(-0.25, -0.38, 0.22, 0, H + 0.02, 0.05, col)                       # loader's hatch
        S.tube((-0.4, 0.35), (0.3, 0.42), 0.035, 0.03, H + 0.15, H + 0.13, DARK)  # .50 cal
    elif kind == 'stuart':
        S.prism([(R * math.cos(a), R * 0.92 * math.sin(a)) for a in np.linspace(0, 6.283, 8, endpoint=False)], H - 0.5, H, 0.08, col, profile='lin')
        S.box(R * 0.85, 0, 0.18, 0.32, H - 0.45, H - 0.25, 0.05, col)
        S.tube((R * 0.9, 0), (R + gun, 0), 0.05, 0.045, H - 0.35, H - 0.35, col)
        S.disk(-0.1, 0, 0.3, 0, H + 0.08, 0.05, col)
    else:
        S.prism([(R * math.cos(a), R * math.sin(a)) for a in np.linspace(0, 6.283, 9, endpoint=False)], H - 0.45, H, 0.06, col, profile='lin')
        S.disk(-0.1, 0.1, 0.24, 0, H + 0.1, 0.04, col)
        S.tube((R * 0.8, -0.1), (R + gun, -0.1), 0.045, 0.04, H - 0.3, H - 0.3, col)
        S.tube((-R * 0.8, 0.2), (-R - 0.35, 0.25), 0.035, 0.03, H - 0.25, H - 0.27, DARK)   # rear MG
    S.meta = {'kind': 'turret'}
    return S.finish(0.04, seed)


def truck(name, seed):
    L, W = 5.6, 2.2
    S = Sprite(name, L, W, 40)
    tan = paint((0.50, 0.46, 0.32), None, seed)
    for x in (-1.9, -0.9, 1.7):
        for side in (-1, 1): S.box(x, side * 0.9, 0.42, 0.14, 0, 0.75, 0.1, (0.13, 0.12, 0.11))
    S.box(1.9, 0, 0.75, 0.75, 0, 1.25, 0.15, tan)              # bonnet
    S.box(1.0, 0, 0.45, 0.95, 0, 2.05, 0.12, tan)              # cab roof
    S.box(-1.35, 0, 1.6, 1.05, 0, 1.3, 0.05, tan)              # bed
    S.box(-1.35, 0, 1.5, 0.95, 0, 0.95, 0.02, (0.4, 0.33, 0.22), mode='set')
    for i in range(4): S.box(-2.6 + i * 0.85, 0, 0.03, 0.94, 0, 0.97, 0, (0.33, 0.27, 0.18))
    S.meta = {'kind': 'truck', 'len': L, 'wid': W}
    return S.finish(0.05, seed)


# --------------------------------------------------------------------------------------------- fortifications & buildings
_TEX = {}
def tex(name, tile):
    """Colour function sampling one of the terrain photo materials (assets/tex) in metres, so mounds match the ground."""
    if name not in _TEX:
        _TEX[name] = np.asarray(Image.open(os.path.join(ROOT, 'assets', 'tex', name + '_d.webp')).convert('RGB'), np.float32) / 255
    T = _TEX[name]; n = T.shape[0]
    def f(X, Y):
        u = ((X / tile) % 1 * n).astype(int) % n; v = ((Y / tile) % 1 * n).astype(int) % n
        return T[v, u]
    return f


def mixf(f1, f2, mask_fn):
    def f(X, Y):
        m = mask_fn(X, Y)[..., None]
        a = f1(X, Y) if callable(f1) else np.broadcast_to(np.array(f1, np.float32), X.shape + (3,))
        b = f2(X, Y) if callable(f2) else np.broadcast_to(np.array(f2, np.float32), X.shape + (3,))
        return a * (1 - m) + b * m
    return f


def concrete(seed, base=(0.66, 0.65, 0.60)):
    def f(X, Y):
        h, w = X.shape
        n = vnoise(h, w, 12, seed, 3); stain = vnoise(h, w, 50, seed + 5, 2)
        c = np.ones((h, w, 3), np.float32) * np.array(base, np.float32) * (0.86 + 0.24 * n)[..., None]
        return c * (1 - 0.25 * np.clip(stain - 0.5, 0, 1)[..., None] * 2)
    return f


def mound(S, sx, sy, height, color, seed, flat_top=0.35):
    """Sand-covered earthwork: a superellipse dome with slumped slopes and lumpy surface."""
    h, w = S.X.shape
    u, v = S.X / (sx / 2), S.Y / (sy / 2)
    r = (np.abs(u) ** 2.6 + np.abs(v) ** 2.6) ** (1 / 2.6)
    lump = vnoise(h, w, 18, seed, 3) - 0.5
    prof = np.clip((1 - r) / (1 - flat_top), 0, 1)
    z = height * (prof * prof * (3 - 2 * prof)) + lump * 0.35 * prof
    z = np.where(r < 1.0 + lump * 0.08, np.maximum(z, 0.02), np.nan)
    S._write((slice(None), slice(None)), z.astype(np.float32), color)


def logs_row(S, x, y0, y1, z, r=0.16, axis='y', color=(0.40, 0.31, 0.21), seed=0):
    """Coconut logs laid side by side (each a tube)."""
    rnd = random.Random(seed)
    n = int(abs(y1 - y0) / (r * 2.05))
    for i in range(n):
        c = y0 + (i + 0.5) * (y1 - y0) / n
        L = rnd.uniform(-0.25, 0.25)
        col = mixc(color, (0.5, 0.42, 0.3), rnd.random() * 0.4)
        if axis == 'y': S.tube((x - 0.5 + L, c), (x + 0.5 + L, c), r, r, z, z, col)
        else: S.tube((c, x - 0.5 + L), (c, x + 0.5 + L), r, r, z, z, col)


def embrasure(S, x, y, half_w, depth, z):
    S.box(x, y, depth, half_w, 0, z, 0.02, (0.04, 0.04, 0.035), mode='set')


def st_bunker(name, sx, sy, height, seed, logs=True, ppm=32):
    """Coconut-log bunker under a sand and coral rubble mound; firing slit facing +x."""
    S = Sprite(name, sx, sy, ppm, pad=0.3)
    base = mixf(tex('coral', 5.0), tex('sand', 8.0), lambda X, Y: vnoise(*X.shape, 30, seed, 2))
    def sand(X, Y):
        h, w = X.shape
        c = base(X, Y) * np.array((0.84, 0.82, 0.78), np.float32)
        # scrub regrowing on the older mounds, and darker disturbed earth
        g = np.clip(vnoise(h, w, 26, seed + 4, 2) * 2.2 - 1.3, 0, 1)[..., None]
        c = c * (1 - g * 0.6) + np.array((0.38, 0.40, 0.24), np.float32) * g * 0.6
        return c * (0.92 + 0.12 * vnoise(h, w, 60, seed + 8, 1))[..., None]
    mound(S, sx, sy, height, sand, seed)
    if logs:
        # log revetment framing the embrasure on the front face
        logs_row(S, sx / 2 - 0.7, -sy * 0.28, sy * 0.28, height * 0.45, 0.17, seed=seed)
        S.box(sx / 2 - 0.55, 0, 0.5, sy * 0.3, 0, height * 0.5, 0.08, (0.37, 0.29, 0.2))
    embrasure(S, sx / 2 - 0.35, 0, sy * 0.22, 0.4, height * 0.35)
    # rear entrance trench
    S.box(-sx / 2 + 0.6, sy * 0.15, 0.9, 0.55, 0, 0.1, 0.05, (0.3, 0.26, 0.2), mode='set')
    S.meta = {'kind': 'struct', 'sx': sx, 'sy': sy}
    return S.finish(0.05, seed)


def st_pillbox(name, sx, sy, height, seed, steel=False):
    S = Sprite(name, sx, sy, 40, pad=0.3)
    if steel:
        rust = mixf(concrete(seed, (0.36, 0.34, 0.30)), (0.45, 0.28, 0.16), lambda X, Y: np.clip(vnoise(*X.shape, 20, seed, 3) * 2 - 1, 0, 1) * 0.7)
        S.disk(0, 0, sx / 2 * 0.86, 0, height * 0.75, 0.25, rust, n=48)
        S.ellipsoid(0, 0, sx / 2 * 0.62, sx / 2 * 0.62, height * 0.7, height * 0.3, rust)
        for i in range(24):
            a = i / 24 * 6.283
            S.disk(math.cos(a) * sx / 2 * 0.74, math.sin(a) * sx / 2 * 0.74, 0.05, 0, height * 0.77, 0, (0.28, 0.25, 0.22), n=8)
        for a in (-0.5, 0, 0.5):
            S.box(math.cos(a) * sx / 2 * 0.8, math.sin(a) * sx / 2 * 0.8, 0.12, 0.35, 0, height * 0.6, 0, (0.03, 0.03, 0.03), rot=a, mode='set')
    else:
        conc = concrete(seed)
        S.box(0, 0, sx / 2 * 0.92, sy / 2 * 0.92, 0, height, 0.45, conc, profile='lin')
        S.box(-0.2, 0, sx / 2 * 0.5, sy / 2 * 0.55, 0, height + 0.15, 0.15, concrete(seed + 1, (0.6, 0.59, 0.55)))
        # sand and palm fronds heaped on the roof as camouflage
        sand = tex('sand', 8.0)
        h, w = S.X.shape
        cam = vnoise(h, w, 40, seed + 9, 2)
        z = np.where((cam > 0.62) & (np.abs(S.X) < sx / 2 * 0.8) & (np.abs(S.Y) < sy / 2 * 0.8), height + 0.2 + (cam - 0.55) * 0.8, np.nan)
        S._write((slice(None), slice(None)), z.astype(np.float32), sand)
        # sandbag wall either side of the slit
        for side in (-1, 1):
            for i in range(4):
                S.ellipsoid(sx / 2 * 0.9, side * (0.9 + i * 0.5), 0.3, 0.24, 0, 0.7, (0.62, 0.56, 0.42))
        embrasure(S, sx / 2 * 0.86, 0, sy * 0.13, 0.25, height * 0.6)
    S.meta = {'kind': 'struct', 'sx': sx, 'sy': sy}
    return S.finish(0.04, seed)


def st_command(name, sx, sy, height, seed):
    """Shibasaki's two-storey reinforced-concrete blockhouse."""
    S = Sprite(name, sx, sy, 18, pad=0.4)
    conc = concrete(seed, (0.68, 0.67, 0.63))
    S.box(0, 0, sx / 2, sy / 2, 0, height - 0.5, 0.25, conc)
    S.box(-sx * 0.08, 0, sx * 0.3, sy * 0.33, 0, height, 0.2, concrete(seed + 2, (0.64, 0.63, 0.59)))
    S.box(sx / 2 - 0.25, 0, 0.25, sy / 2, 0, height - 0.3, 0.05, conc)          # parapet
    for i in range(4):                                                         # roof hatches & vents
        S.box(-sx * 0.3 + i * 1.6, sy * 0.36, 0.35, 0.35, 0, height - 0.2, 0.05, (0.42, 0.42, 0.40))
    for y in (-sy * 0.3, 0, sy * 0.3):
        embrasure(S, sx / 2 - 0.1, y, 0.5, 0.15, height - 0.9)
    # shell pocks
    rnd = random.Random(seed)
    for i in range(30):
        S.ellipsoid(rnd.uniform(-sx / 2, sx / 2), rnd.uniform(-sy / 2, sy / 2), rnd.uniform(0.2, 0.5), rnd.uniform(0.2, 0.5), 0, height - 0.55, (0.42, 0.41, 0.39), mode='max')
    S.meta = {'kind': 'struct', 'sx': sx, 'sy': sy}
    return S.finish(0.04, seed)


def st_coastgun(name, sx, sy, seed):
    """8-inch (Vickers) coast defence gun in a circular concrete emplacement."""
    S = Sprite(name, sx * 1.25, sy * 1.25, 32, pad=0.3)
    R = sx / 2
    conc = concrete(seed, (0.62, 0.61, 0.57))
    S.disk(0, 0, R * 0.98, 0, 1.0, 0.4, conc, n=56)
    S.disk(0, 0, R * 0.68, 0, 0.3, 0.05, (0.42, 0.41, 0.38), n=48, mode='set')
    for i in range(16):                                                       # ready-ammunition niches
        a = i / 16 * 6.283
        S.box(math.cos(a) * R * 0.83, math.sin(a) * R * 0.83, 0.25, 0.4, 0, 0.6, 0.02, (0.2, 0.19, 0.17), rot=a, mode='set')
    gray = paint((0.40, 0.43, 0.40), None, seed, 0.1)
    S.disk(0, 0, R * 0.45, 0, 2.2, 0.3, gray)                                  # gun house
    S.box(R * 0.35, 0, R * 0.25, R * 0.28, 0, 2.6, 0.15, gray)
    S.tube((R * 0.5, 0), (R * 1.25, 0), 0.22, 0.17, 2.4, 2.4, gray)            # barrel
    S.meta = {'kind': 'struct', 'sx': sx * 1.25, 'sy': sy * 1.25, 'model': [sx, sy]}
    return S.finish(0.04, seed)


def shed(name, seed):
    """Corrugated-iron shed (gable roof along x), weathered and rusting."""
    sx, sy = 10.0, 6.0
    S = Sprite(name, sx, sy, 24, pad=0.3)
    def roof(X, Y):
        h, w = X.shape
        rust = np.clip(vnoise(h, w, 24, seed, 3) * 1.8 - 0.7, 0, 1)
        c = np.ones((h, w, 3), np.float32) * np.array((0.62, 0.62, 0.60), np.float32)
        c = c * (1 - rust[..., None]) + np.array((0.52, 0.30, 0.16), np.float32) * rust[..., None]
        corr = 0.88 + 0.12 * np.sin(X * 2 * math.pi / 0.076 * 0.25)
        return c * corr[..., None]
    h, w = S.X.shape
    inside = (np.abs(S.X) < sx / 2) & (np.abs(S.Y) < sy / 2)
    z = 3.6 - np.abs(S.Y) * 0.35 + 0.02 * np.sin(S.X * 2 * math.pi / 0.3)
    S._write((slice(None), slice(None)), np.where(inside, z, np.nan).astype(np.float32), roof)
    S.tube((-sx / 2, 0), (sx / 2, 0), 0.08, 0.08, 3.6, 3.6, (0.55, 0.54, 0.5))   # ridge cap
    S.meta = {'kind': 'bld', 'sx': sx, 'sy': sy}
    return S.finish(0.03, seed)


def hut(name, seed):
    """Pandanus-thatch hut (hip roof)."""
    sx, sy = 7.0, 5.0
    S = Sprite(name, sx, sy, 24, pad=0.3)
    def thatch(X, Y):
        h, w = X.shape
        streak = vnoise(h, w, 3, seed, 2)
        n = vnoise(h, w, 20, seed + 1, 2)
        c = np.ones((h, w, 3), np.float32) * np.array((0.60, 0.50, 0.32), np.float32)
        return c * (0.78 + 0.3 * streak * (0.6 + 0.6 * n))[..., None]
    inside = (np.abs(S.X) < sx / 2) & (np.abs(S.Y) < sy / 2)
    z = 3.2 - np.maximum(np.abs(S.Y) * 0.6, np.abs(S.X) * 0.6 - (sx - sy) * 0.3)
    S._write((slice(None), slice(None)), np.where(inside, z, np.nan).astype(np.float32), thatch)
    S.meta = {'kind': 'bld', 'sx': sx, 'sy': sy}
    return S.finish(0.04, seed)


# --------------------------------------------------------------------------------------------- atlas
def pack(sprites, width=4096):
    sprites = sorted(sprites, key=lambda s: -s.img_a.size[1])
    x = y = row = 0; G = 6
    pos = {}
    for s in sprites:
        w, h = s.img_a.size
        if x + w + G > width: x = 0; y += row + G; row = 0
        pos[s.name] = (x + G // 2, y + G // 2); x += w + G; row = max(row, h)
    H = y + row + G
    H = 1 << (H - 1).bit_length()
    A = Image.new('RGBA', (width, H), (128, 120, 100, 0)); N = Image.new('RGBA', (width, H), (128, 128, 0, 255))
    man = {'size': [width, H], 'hmax': HMAX, 'sprites': {}}
    for s in sprites:
        px, py = pos[s.name]; w, h = s.img_a.size
        A.paste(s.img_a, (px, py)); N.paste(s.img_n, (px, py))
        man['sprites'][s.name] = {'uv': [px / width, py / H, w / width, h / H], 'half': [round(s.half[0], 3), round(s.half[1], 3)], **s.meta}
    return A, N, man


def main():
    os.makedirs(OUT, exist_ok=True)
    sp = []
    for i in range(6): sp.append(palm(f'palm{i}', 100 + i, 0.0)); print('palm', i)
    for i in range(5): sp.append(palm(f'palm_hit{i}', 200 + i, 0.5)); print('palm hit', i)
    for i in range(3): sp.append(palm(f'palm_dead{i}', 300 + i, 0.9)); print('palm dead', i)
    sp += [lvt('lvt1', 0, False, 11), lvt('lvt1_load', 0, True, 12), lvt('lvt2', 1, False, 13), lvt('lvt2_load', 1, True, 14)]
    sp += [lcvp('lcvp', False, False, 21), lcvp('lcvp_load', False, True, 22), lcvp('lcvp_ramp', True, False, 23)]
    sp += [lcm('lcm', False, False, 31), lcm('lcm_ramp', True, False, 32)]
    for k in ('sherman', 'stuart', 'hago'):
        sp += [tank_hull(k, k, 41), tank_turret(k + '_turret', k, 42)]
    sp.append(truck('truck', 51))
    # fortifications at their STRUCT_SPECS size (x = spec.h, y = spec.w; slit faces +x)
    sp += [st_pillbox('st_pillbox', 7, 7, 2.1, 61), st_pillbox('st_steelpb', 6, 6, 2.2, 62, steel=True),
           st_bunker('st_bunker', 9, 13, 2.6, 63), st_bunker('st_log', 6, 8, 1.8, 64),
           st_bunker('st_bombproof', 26, 44, 6.5, 65, logs=False, ppm=13), st_command('st_command', 16, 22, 7.5, 66),
           st_coastgun('st_coastgun', 16, 16, 67)]
    sp += [shed('shed0', 71), shed('shed1', 72), hut('hut0', 73), hut('hut1', 74)]
    print('structures done')
    print('vehicles done')
    A, N, man = pack(sp)
    A.save(os.path.join(OUT, 'atlas_a.webp'), quality=90, method=6)
    N.save(os.path.join(OUT, 'atlas_n.webp'), lossless=True, method=4)
    with open(os.path.join(OUT, 'manifest.json'), 'w') as f: json.dump(man, f, indent=1)
    print('atlas', man['size'], 'sprites', len(man['sprites']))


if __name__ == '__main__':
    sys.exit(main())
