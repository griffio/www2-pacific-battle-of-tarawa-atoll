#!/usr/bin/env python3
"""
Repaint the vehicle sprites with an image-editing model (FLUX.2 [klein] 4B on Cloudflare Workers AI),
keeping the shapes modelled by tools/render_sprites.py and replacing only their albedo.

    python3 tools/repaint_sprites.py                    # repaint every vehicle that has no repaint yet
    python3 tools/repaint_sprites.py --only sherman sherman_turret --force
    python3 tools/repaint_sprites.py --apply            # re-apply saved repaints to the atlas, no API calls
    python3 tools/repaint_sprites.py --dry              # write the model inputs to the cache only

Credentials come from the environment, or from the project's .env (git-ignored), and are never printed:

    CLOUDFLARE_ACCOUNT_ID=...
    CLOUDFLARE_API_TOKEN=...

How it works, per sprite:
  1. The sprite is rendered afresh by render_sprites.vehicles() or soldiers() (so a repaint never feeds on an earlier
     repaint) and cropped to its covered area. Its albedo is shaded with a soft top-left light so the
     model can read the forms, upscaled, and put on a key-green canvas.
  2. The model repaints it with a sprite-specific prompt asking for the same outline and a straight
     overhead camera.
  3. The result's non-green area is checked against the input outline, allowing a few pixels of drift.
     Takes below --min-match are retried with a new seed (--attempts) and the best take is kept.
  4. The take is scaled back to atlas size, the input shading is divided out again (the game lights
     sprites at runtime from atlas_n), its colour is pulled towards the original paint area by area
     (--match; fine detail stays) so the palette stays consistent, texels the model left as background keep the original paint,
     and colour is bled into transparent texels for clean mips.
     Coverage alpha is the original, so outlines, shadows and selection boxes are unchanged.
  5. The repaint is saved to assets/sprites/repaint/<name>.webp and pasted into atlas_a.webp.

render_sprites.py re-applies the saved repaints whenever it rebuilds the atlas, skipping any sprite
whose coverage has changed since it was repainted (repaint it again with --force).

Raw model takes, inputs and a before/after sheet (compare.jpg) are kept in tools/.repaintcache/.
"""
import argparse, hashlib, io, json, math, os, sys, time, urllib.error, urllib.request, uuid
import numpy as np
from PIL import Image, ImageDraw
import render_sprites

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPRITES = os.path.join(ROOT, 'assets', 'sprites')
REPAINT = os.path.join(SPRITES, 'repaint')
CACHE = os.path.join(ROOT, 'tools', '.repaintcache')
MODEL = '@cf/black-forest-labs/flux-2-klein-4b'
KEY = (0.24, 0.78, 0.16)        # canvas background, keyed out of the result
SUN = np.array([-0.45, -0.45, 0.77]) / np.linalg.norm([-0.45, -0.45, 0.77])
CANVAS = 1024                   # long side of the model canvas (px)
MATCH_SIGMA = 5.0               # texels; colour is matched to the original paint at this scale and above

COMMON = ('Repaint this top-down render as a highly detailed photograph of the real 1943 vehicle, taken from directly above '
          '(a strict plan view: no sides, doors or wheel faces visible), '
          'in flat overcast light with no cast shadows: worn paint, weld seams, bolts and rivets, hatches, dust and salt stains. '
          'Keep exactly the same shape, outline, size, position and paint colours, and the straight overhead camera. '
          'Keep the flat bright green background. The front of the vehicle points to the right. Subject: ')
COMMON_SOLDIER = ('Repaint this top-down render as a highly detailed photograph of a real 1943 infantryman taken from directly above '
                  '(a strict plan view: only the top of the helmet, the shoulders, arms, pack and weapon are visible, no face), in flat overcast '
                  'light with no cast shadows: cloth folds and seams, webbing straps, worn metal and wood. Keep exactly the same pose, outline, '
                  'size, position and colours, and the straight overhead camera. Keep the flat bright green background. The soldier faces right. Subject: ')
PROMPTS = {
    'sherman':        'hull of an M4A2 Sherman medium tank without its turret: olive drab welded steel, sloped glacis, driver and bow gunner hatches with periscopes, '
                      'engine deck grilles and access plates at the rear, pioneer tools, rubber block tracks along both sides.',
    'sherman_turret': 'turret of an M4 Sherman tank: cast olive drab steel turret, commander split hatch, loader hatch, periscopes, gun mantlet and long 75 mm gun barrel.',
    'stuart':         'hull of an M3A1 Stuart light tank without its turret: olive drab riveted and welded armour, driver hatches, engine deck grilles, tracks along both sides.',
    'stuart_turret':  'turret of an M3A1 Stuart light tank: olive drab welded turret, split roof hatch, periscopes, 37 mm gun barrel.',
    'hago':           'hull of a Japanese Type 95 Ha-Go light tank without its turret: riveted armour plates in faded khaki and dark green paint, engine deck louvres, narrow tracks along both sides.',
    'hago_turret':    'turret of a Japanese Type 95 Ha-Go light tank: small riveted cylindrical turret in faded khaki and dark green paint, hatch, short 37 mm gun barrel.',
    'lvt1':           'LVT-1 Alligator amphibious tractor: olive drab riveted steel hull, open empty cargo well, cab at the front, wide track grousers along both sides.',
    'lvt1_load':      'LVT-1 Alligator amphibious tractor: olive drab riveted steel hull, cab at the front, wide track grousers along both sides, cargo well packed with US Marines in helmets, nobody on the hull outside the well.',
    'lvt2':           'LVT-2 Water Buffalo amphibious tractor: olive drab steel hull, open empty cargo well, cab at the front, track grousers along both sides.',
    'lvt2_load':      'LVT-2 Water Buffalo amphibious tractor: olive drab steel hull, cab at the front, track grousers along both sides, cargo well packed with US Marines in helmets, nobody on the hull outside the well.',
    'lcvp':           'LCVP Higgins boat landing craft: navy grey painted plywood hull, steel bow ramp at the right raised, coxswain station at the stern on the left, empty well deck with wooden floor boards.',
    'lcvp_load':      'LCVP Higgins boat landing craft: navy grey painted plywood hull, steel bow ramp at the right raised, coxswain station at the stern on the left, well deck packed with US Marines in helmets.',
    'lcvp_ramp':      'LCVP Higgins boat landing craft: navy grey painted plywood hull, steel bow ramp at the right lowered flat, coxswain station at the stern on the left, empty well deck with wooden floor boards.',
    'lcm':            'LCM-3 landing craft mechanized: navy grey welded steel hull, bow ramp at the right raised, open steel well deck, coxswain station and engine room at the stern on the left, nothing on the ramp.',
    'lcm_ramp':       'LCM-3 landing craft mechanized: navy grey welded steel hull, bow ramp at the right lowered flat, open steel well deck, coxswain station and engine room at the stern on the left, nothing on the ramp.',
    'truck_wreck0':   'burnt-out wreck of a Japanese Type 94 army truck: cab roof burnt away showing charred seat springs and a steering wheel, '
                      'scorched rusty bonnet with louvres and mudguards, cargo bed floor mostly burnt away leaving charred planks over the chassis rails, ash.',
    'truck_wreck1':   'shot-up abandoned Japanese Type 94 army truck: faded khaki bonnet with louvres and mudguards, flat cab roof with bullet holes, '
                      'open wooden cargo bed with weathered grey-brown floor planks and one side board shot away, evenly faded paint with light dust.',
    'sol_us_stand_rifle':  'a US Marine standing, M1 helmet with a green and brown camouflage cover, green herringbone twill utility jacket, '
                           'light pack on his back, holding an M1 Garand rifle with a wooden stock pointing right.',
    'sol_us_crouch_rifle': 'a US Marine crouching on one knee, M1 helmet with a green and brown camouflage cover, green herringbone twill utility jacket, '
                           'light pack on his back, M1 Garand rifle with a wooden stock held ready, pointing right.',
    'sol_us_prone_rifle':  'a US Marine lying prone with his legs behind him, M1 helmet with a green and brown camouflage cover, green herringbone twill '
                           'utility uniform, light pack on his back, aiming an M1 Garand rifle with a wooden stock to the right.',
    'sol_us_stand_mg':     'a US Marine standing, M1 helmet with a green and brown camouflage cover, green herringbone twill utility jacket, '
                           'light pack on his back, carrying a Browning M1919 machine gun with a perforated barrel jacket pointing right.',
    'sol_jp_stand_rifle':  'a Japanese naval infantryman standing, plain steel helmet, khaki-green tropical uniform, canvas pack on his back, '
                           'holding an Arisaka rifle with a wooden stock pointing right.',
    'sol_jp_prone_rifle':  'a Japanese naval infantryman lying prone with his legs behind him, plain steel helmet, khaki-green tropical uniform, '
                           'canvas pack on his back, aiming an Arisaka rifle with a wooden stock to the right.',
}


# ------------------------------------------------------------------------------------------- credentials & API
def credentials():
    env = {}
    path = os.path.join(ROOT, '.env')
    if os.path.exists(path):
        for line in open(path):
            k, sep, v = line.strip().partition('=')
            if sep and not k.startswith('#'): env[k.strip()] = v.strip().strip('"\'')
    acc = os.environ.get('CLOUDFLARE_ACCOUNT_ID') or env.get('CLOUDFLARE_ACCOUNT_ID')
    tok = os.environ.get('CLOUDFLARE_API_TOKEN') or env.get('CLOUDFLARE_API_TOKEN')
    if not acc or not tok: sys.exit('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set (environment or .env)')
    return acc, tok


def run_model(acc, tok, prompt, png, width, height, seed):
    """One FLUX.2 klein edit. Returns the result image, or raises RuntimeError with the API's message."""
    fields = {'prompt': prompt, 'width': str(width), 'height': str(height), 'seed': str(seed)}
    b = uuid.uuid4().hex
    body = io.BytesIO()
    for k, v in fields.items():
        body.write(f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    body.write(f'--{b}\r\nContent-Disposition: form-data; name="input_image_0"; filename="in.png"\r\nContent-Type: image/png\r\n\r\n'.encode())
    body.write(png + f'\r\n--{b}--\r\n'.encode())
    req = urllib.request.Request(f'https://api.cloudflare.com/client/v4/accounts/{acc}/ai/run/{MODEL}', data=body.getvalue(),
                                 headers={'Authorization': f'Bearer {tok}', 'Content-Type': f'multipart/form-data; boundary={b}'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=180) as r: d = json.load(r)
            break
        except urllib.error.HTTPError as e:
            msg = e.read().decode(errors='replace')[:300]
            if e.code in (429, 500, 502, 503, 504) and attempt < 3: time.sleep(5 * (attempt + 1)); continue
            raise RuntimeError(f'HTTP {e.code}: {msg}')
    if not d.get('success'): raise RuntimeError(str(d.get('errors')))
    import base64
    return Image.open(io.BytesIO(base64.b64decode(d['result']['image']))).convert('RGB')


# ------------------------------------------------------------------------------------------- image helpers
def load_atlas():
    man = json.load(open(os.path.join(SPRITES, 'manifest.json')))
    return man, Image.open(os.path.join(SPRITES, 'atlas_a.webp')).convert('RGBA')


def rect(man, name):
    W, H = man['size']; u, v, w, h = man['sprites'][name]['uv']
    x0, y0 = round(u * W), round(v * H)
    return x0, y0, x0 + round(w * W), y0 + round(h * H)


def shading(n):
    """Soft top-left light plus AO from an atlas_n crop (float 0..1), as a per-texel multiplier."""
    nx, ny = n[..., 0] * 2 - 1, n[..., 1] * 2 - 1
    nz = np.sqrt(np.clip(1 - nx * nx - ny * ny, 0, 1))
    lam = np.clip(nx * SUN[0] + ny * SUN[1] + nz * SUN[2], 0, 1)
    return (0.62 + 0.45 * lam) * (0.55 + 0.45 * n[..., 3])


def alpha_sha(alpha):
    return hashlib.sha1(np.ascontiguousarray(alpha).tobytes()).hexdigest()[:16]


def layout(w, h):
    """Upscale factor and canvas size (multiples of 16) for a w×h sprite."""
    s = CANVAS * 0.86 / max(w, h)
    cw = min(CANVAS, 16 * math.ceil((w * s + 0.14 * CANVAS) / 16))
    ch = min(CANVAS, max(256, 16 * math.ceil((h * s + 0.14 * CANVAS) / 16)))
    return s, cw, ch


def key_mask(rgb):
    """Pixels that are not the key-green background."""
    r, g, b = (rgb[..., i].astype(np.int32) for i in range(3))
    return ~((g > r + 40) & (g > b + 40))


def dilate(m, r):
    """Binary dilation by a (2r+1)² square, separable."""
    out = m.copy()
    for axis in (0, 1):
        acc = out.copy()
        for d in range(1, r + 1): acc |= np.roll(out, d, axis) | np.roll(out, -d, axis)
        out = acc
    return out


def erode(m, r):
    return ~dilate(~m, r)


def bbox(alpha, pad=3):
    ys, xs = np.nonzero(alpha > 0.02)
    h, w = alpha.shape
    return max(0, xs.min() - pad), max(0, ys.min() - pad), min(w, xs.max() + 1 + pad), min(h, ys.max() + 1 + pad)


def bleed(col, filled, steps=12):
    """Spread colour into uncovered texels so mips don't fringe (as render_sprites.Sprite.finish does)."""
    col = col.copy(); filled = filled.copy()
    for _ in range(steps):
        if filled.all(): break
        acc = np.zeros_like(col); wsum = np.zeros(filled.shape, np.float32)
        for dy, dx in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            m = np.roll(filled, (dy, dx), (0, 1)).astype(np.float32)
            acc += np.roll(col, (dy, dx), (0, 1)) * m[..., None]; wsum += m
        grow = (~filled) & (wsum > 0)
        col[grow] = acc[grow] / wsum[grow][:, None]; filled |= grow
    if filled.any(): col[~filled] = col[filled].mean(0)
    return col


# ------------------------------------------------------------------------------------------- per sprite
def prepare(a, n):
    """Model input for one sprite: (canvas image, sprite bbox, its box on the canvas, shading).
    Only the covered part of the sprite (bbox) is sent, scaled up to fill the canvas."""
    sh = shading(n)
    bx = bbox(a[..., 3])
    sub = a[bx[1]:bx[3], bx[0]:bx[2]]
    h, w = sub.shape[:2]
    s, cw, ch = layout(w, h)
    lit = np.clip(sub[..., :3] * sh[bx[1]:bx[3], bx[0]:bx[2], None], 0, 1)
    al = sub[..., 3:]
    img = lit * al + np.array(KEY) * (1 - al)
    sw, shh = round(w * s), round(h * s)
    big = Image.fromarray((img * 255 + 0.5).astype(np.uint8)).resize((sw, shh), Image.LANCZOS)
    canvas = Image.new('RGB', (cw, ch), tuple(round(c * 255) for c in KEY))
    box = ((cw - sw) // 2, (ch - shh) // 2, (cw - sw) // 2 + sw, (ch - shh) // 2 + shh)
    canvas.paste(big, box[:2])
    return canvas, bx, box, sh


def finish(take, size, bx, box, a, sh, match):
    """Turn a model take back into atlas albedo (RGBA float) for a sprite with original texels a.
    Texels the model left as background (dropped barrels, edge spill) keep the original paint."""
    h, w = bx[3] - bx[1], bx[2] - bx[0]
    crop = take.resize(size, Image.LANCZOS).crop(box)
    good = erode(key_mask(np.asarray(crop)), 3)          # solid, spill-free model paint
    good = np.asarray(Image.fromarray((good * 255).astype(np.uint8)).resize((w, h), Image.BILINEAR)) > 250
    rgb = a[..., :3].copy()
    sub = np.asarray(crop.resize((w, h), Image.LANCZOS)).astype(np.float32) / 255
    sub = np.clip(sub / np.maximum(sh[bx[1]:bx[3], bx[0]:bx[2], None], 0.2), 0, 1)
    cov = np.zeros(a.shape[:2], bool); cov[bx[1]:bx[3], bx[0]:bx[2]] = good
    cov &= a[..., 3] > 0.5
    c = cov[bx[1]:bx[3], bx[0]:bx[2]]
    if match > 0 and c.any():
        # keep the model's fine detail but the original paint's colour in each area (blurred ratio), so the
        # palette, camouflage and wooden decks survive and variants of one craft stay consistent
        wgt = c.astype(np.float32)
        def low(x):
            return np.dstack([render_sprites.gblur(x[..., i] * wgt, MATCH_SIGMA) for i in range(3)]) / \
                np.maximum(render_sprites.gblur(wgt, MATCH_SIGMA), 1e-4)[..., None]
        gain = (low(a[bx[1]:bx[3], bx[0]:bx[2], :3]) + 0.02) / (low(sub) + 0.02)
        sub = np.clip(sub * gain ** match, 0, 1)
    rgb[cov] = sub[c]
    col = bleed(rgb, a[..., 3] > 0.02)
    return np.dstack([col, a[..., 3]])


def fill_holes(m):
    """Silhouette without holes: everything not reachable from the canvas corner through background."""
    im = Image.fromarray((m * 255).astype(np.uint8)).copy()     # fromarray can share a read-only buffer: floodfill would do nothing
    ImageDraw.floodfill(im, (0, 0), 128)
    return np.asarray(im) != 128


def outline_match(canvas, take, inmask, tol=6):
    """Outline agreement allowing tol px of drift: the smaller of (take inside the dilated input) and
    (input inside the dilated take). Plain IoU punishes thin parts such as gun barrels too hard. Holes are
    filled first: the model may paint debris where a wreck shows the ground, and the original alpha is
    kept anyway."""
    m1 = fill_holes(key_mask(np.asarray(take.resize(canvas.size, Image.BILINEAR))))
    inmask = fill_holes(inmask)
    prec = (m1 & dilate(inmask, tol)).sum() / max(1, m1.sum())
    rec = (inmask & dilate(m1, tol)).sum() / max(1, inmask.sum())
    return float(min(prec, rec))


def to_img(rgba):
    return Image.fromarray((np.clip(rgba, 0, 1) * 255 + 0.5).astype(np.uint8))


# ------------------------------------------------------------------------------------------- atlas
def apply_saved(A, man, verbose=True):
    """Paste saved repaints into atlas image A (PIL RGBA) in place; returns the names applied."""
    meta_path = os.path.join(REPAINT, 'manifest.json')
    if not os.path.exists(meta_path): return []
    meta = json.load(open(meta_path))
    done = []
    for name, m in sorted(meta.items()):
        path = os.path.join(REPAINT, name + '.webp')
        if name not in man['sprites'] or not os.path.exists(path): continue
        box = rect(man, name)
        alpha = np.asarray(A.crop(box))[..., 3]
        if alpha_sha(alpha) != m['alpha']:
            if verbose: print(f'  repaint {name}: sprite shape changed since it was repainted, skipped (rerun repaint_sprites.py --only {name} --force)')
            continue
        A.paste(Image.open(path).convert('RGBA'), box[:2]); done.append(name)
    return done


def save_atlas(A):
    A.save(os.path.join(SPRITES, 'atlas_a.webp'), quality=90, method=6)


def compare_sheet(rows, path):
    """Before/after sheet: lit original | lit repaint, each at 2× and at about in-game size."""
    if not rows: return
    pad = 8
    cells = []
    for orig, new, sh in rows:
        h, w = orig.shape[:2]
        lit = lambda x: Image.fromarray((np.clip(np.dstack([x[..., :3] * sh[..., None], x[..., 3]]), 0, 1) * 255).astype(np.uint8))
        a, b = lit(orig), lit(new)
        big = [im.resize((w * 2, h * 2), Image.LANCZOS) for im in (a, b)]
        small = [im.resize((max(1, w * 2 // 5), max(1, h * 2 // 5)), Image.LANCZOS) for im in (a, b)]
        cells.append((big, small))
    W = max(2 * c[0][0].width + 2 * c[1][0].width + 5 * pad for c in cells)
    H = sum(c[0][0].height + pad for c in cells) + pad
    sheet = Image.new('RGBA', (W, H), (205, 190, 150, 255))   # sand-ish, like the beach
    y = pad
    for big, small in cells:
        x = pad
        for im in big + small:
            sheet.alpha_composite(im, (x, y)); x += im.width + pad
        y += big[0].height + pad
    sheet.convert('RGB').save(path, quality=92)


# ------------------------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--only', nargs='+', help='sprite names (default: every sprite in PROMPTS)')
    ap.add_argument('--force', action='store_true', help='repaint even if a saved repaint exists')
    ap.add_argument('--attempts', type=int, default=3, help='takes per sprite before keeping the best')
    ap.add_argument('--min-match', type=float, default=0.95, help='outline match (0..1) that accepts a take straight away')
    ap.add_argument('--match', type=float, default=0.85, help='0..1, how far to pull each area\'s colour back to the original paint')
    ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--dry', action='store_true', help='write model inputs to the cache, no API calls')
    ap.add_argument('--apply', action='store_true', help='only re-apply saved repaints to atlas_a.webp')
    args = ap.parse_args()

    man, A = load_atlas()
    if args.apply:
        print('applied', apply_saved(A, man)); save_atlas(A); return

    names = args.only or list(PROMPTS)
    for nme in names:
        if nme not in PROMPTS or nme not in man['sprites']: sys.exit(f'unknown vehicle sprite: {nme}')
    os.makedirs(REPAINT, exist_ok=True); os.makedirs(CACHE, exist_ok=True)
    meta_path = os.path.join(REPAINT, 'manifest.json')
    meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
    acc, tok = (None, None) if args.dry else credentials()
    src = {sp.name: sp for sp in render_sprites.vehicles() + render_sprites.soldiers()}   # pristine renders, never a repainted atlas

    rows, failed = [], []
    for name in names:
        if name in meta and not args.force and os.path.exists(os.path.join(REPAINT, name + '.webp')):
            print(f'{name}: already repainted (use --force)'); continue
        sp = src[name]
        x0, y0, x1, y1 = rect(man, name)
        if sp.img_a.size != (x1 - x0, y1 - y0): sys.exit(f'{name}: atlas is out of date, run tools/render_sprites.py first')
        a = np.asarray(sp.img_a).astype(np.float32) / 255
        n = np.asarray(sp.img_n).astype(np.float32) / 255
        canvas, bx, box, sh = prepare(a, n)
        canvas.save(os.path.join(CACHE, f'{name}.in.png'))
        if args.dry: print(f'{name}: input {canvas.size} written'); continue
        buf = io.BytesIO(); canvas.save(buf, 'PNG')
        inmask = key_mask(np.asarray(canvas))
        prompt = (COMMON_SOLDIER if name.startswith('sol_') else COMMON) + PROMPTS[name]
        best = None
        for i in range(args.attempts):
            seed = args.seed + 1000 * i
            t0 = time.time()
            try:
                take = run_model(acc, tok, prompt, buf.getvalue(), canvas.width, canvas.height, seed)
            except RuntimeError as e:
                print(f'{name}: seed {seed} failed: {e}'); continue
            take.save(os.path.join(CACHE, f'{name}.{seed}.jpg'), quality=92)
            score = outline_match(canvas, take, inmask)
            print(f'{name}: seed {seed} outline match {score:.3f} ({time.time() - t0:.1f}s)')
            if best is None or score > best[0]: best = (score, seed, take)
            if score >= args.min_match: break
        if best is None or best[0] < args.min_match - 0.03:
            print(f'{name}: no usable take (best match {best[0]:.3f})' if best else f'{name}: no take', end='; ')
            if name in meta:      # a forced repaint that failed: back to the original paint, not a stale repaint
                del meta[name]
                os.remove(os.path.join(REPAINT, name + '.webp'))
                with open(meta_path, 'w') as f: json.dump(meta, f, indent=1, sort_keys=True)
            print('keeping the original paint'); failed.append(name); continue
        score, seed, take = best
        new = finish(take, canvas.size, bx, box, a, sh, args.match)
        to_img(new).save(os.path.join(REPAINT, name + '.webp'), lossless=True)
        meta[name] = {'alpha': alpha_sha((a[..., 3] * 255 + 0.5).astype(np.uint8)), 'seed': seed, 'match': round(score, 3), 'model': MODEL}
        rows.append((a, new, sh))
        with open(meta_path, 'w') as f: json.dump(meta, f, indent=1, sort_keys=True)

    if args.dry: return
    applied = apply_saved(A, man)
    save_atlas(A)
    compare_sheet(rows, os.path.join(CACHE, 'compare.jpg'))
    print(f'atlas updated with {len(applied)} repaints; before/after sheet in tools/.repaintcache/compare.jpg')
    if failed: print('failed:', ' '.join(failed)); return 1


if __name__ == '__main__':
    sys.exit(main())
