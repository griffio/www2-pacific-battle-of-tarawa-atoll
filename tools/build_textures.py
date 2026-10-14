#!/usr/bin/env python3
"""Download CC0 ground textures from Poly Haven, colour-grade them to Tarawa's palette and write the
game's terrain material set (assets/tex/*.webp + manifest.json).

  python3 tools/build_textures.py            # uses a download cache in tools/.texcache

Each material is a tileable 512² albedo plus an OpenGL-convention normal map. The terrain shader stacks
them into two texture arrays in manifest order, so the order below is the layer index used in WGSL.
"""
import json, os, sys, urllib.request
from PIL import Image
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'tools', '.texcache')
OUT = os.path.join(ROOT, 'assets', 'tex')
SIZE = 512

# name, Poly Haven asset, world size of one tile (m), target mean colour (0..1), contrast, author
MATERIALS = [
    ('sand',    'coast_sand_01',    8.0, (0.87, 0.845, 0.74), 1.0, 'Rob Tuytel'),
    ('wetsand', 'damp_beach_sand',  5.0, (0.63, 0.58, 0.47), 1.0, 'Dimitrios Savva'),
    ('coral',   'coral_gravel',     5.0, (0.80, 0.75, 0.62), 1.0, 'Rob Tuytel'),
    ('scrub',   'grass_path_2',     4.5, (0.64, 0.62, 0.48), 1.1, 'Rob Tuytel'),
    ('grass',   'leafy_grass',      4.5, (0.40, 0.42, 0.27), 0.9, 'Charlotte Baglioni'),
    ('burned',  'burned_ground_01', 4.0, (0.36, 0.33, 0.28), 1.0, 'Rob Tuytel'),
    ('airfield','gravel_concrete',  5.0, (0.80, 0.79, 0.74), 1.0, 'Dario Barresi, Charlotte Baglioni'),
    ('reef',    'coral_ground_02',  5.0, (0.74, 0.68, 0.55), 1.15, 'Rob Tuytel'),
    ('litter',  'dry_decay_leaves', 3.5, (0.47, 0.41, 0.30), 0.9, 'Amal Kumar'),
]


def fetch(asset, kind):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f'{asset}_{kind}_1k.jpg')
    if not os.path.exists(path):
        url = f'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/{asset}/{asset}_{kind}_1k.jpg'
        print('  downloading', url)
        urllib.request.urlretrieve(url, path)
    return Image.open(path)


def grade(img, target, contrast, name=''):
    a = np.asarray(img.convert('RGB').resize((SIZE, SIZE), Image.LANCZOS), dtype=np.float32) / 255.0
    mean = a.reshape(-1, 3).mean(0)
    lum = a.mean(2, keepdims=True)
    # keep the photo's luminance detail, move its mean colour to the target palette
    out = (lum - lum.mean()) * contrast + np.array(target, dtype=np.float32)
    # a little of the original chroma for life (grass tufts, shells, charcoal)
    chroma = (a - lum) - (mean - mean.mean())
    out = out + chroma * (0.35 if name == 'grass' else 0.55)
    return Image.fromarray(np.clip(out * 255 + 0.5, 0, 255).astype(np.uint8))


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = {'size': SIZE, 'materials': []}
    for name, asset, metres, target, contrast, author in MATERIALS:
        print(name, '<-', asset)
        grade(fetch(asset, 'diff'), target, contrast, name).save(os.path.join(OUT, f'{name}_d.webp'), quality=84, method=6)
        fetch(asset, 'nor_gl').convert('RGB').resize((SIZE, SIZE), Image.LANCZOS).save(os.path.join(OUT, f'{name}_n.webp'), quality=88, method=6)
        manifest['materials'].append({'name': name, 'tile': metres, 'source': f'https://polyhaven.com/a/{asset}', 'author': author})
    with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=1)
    with open(os.path.join(OUT, 'CREDITS.md'), 'w') as f:
        f.write('# Terrain textures\n\nAll from [Poly Haven](https://polyhaven.com), licensed **CC0** (public domain). '
                'Downscaled to 512² and colour-graded for the game by `tools/build_textures.py`.\n\n')
        f.write('| Material | Source | Author |\n|---|---|---|\n')
        for m in manifest['materials']:
            f.write(f"| {m['name']} | {m['source']} | {m['author']} |\n")
    print('done:', OUT)


if __name__ == '__main__':
    sys.exit(main())
