#!/usr/bin/env python3
"""Build the recorded weapon / explosion sound set from CC0 recordings on Freesound.

  python3 tools/build_sfx.py            # downloads into tools/.sfxcache, writes assets/sfx/<id>[_n].mp3

Every source below is CC0 (public domain); several are US Government footage extracted by qubodup, and the
craigsmith clips are period studio recordings from a digitised radio/film effects archive. Each SOURCE cut becomes
one variant of a sound id (`id.mp3`, `id_2.mp3`, …); the game picks a variant at random per shot, so repeated
fire never sounds machine-identical. Sounds not listed here keep their previous files (see assets/sfx/CREDITS.md).
"""
import json, os, subprocess, sys, urllib.request
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'tools', '.sfxcache')
OUT = os.path.join(ROOT, 'assets', 'sfx')
SR = 44100
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

# freesound id: (author, title, preview path)
SRC = {
    386842: ('nioczkus', 'M1 Garand Rifle', '386/386842_932959'),
    385785: ('Rijam', 'Rifle Shot (M1 Garand)', '385/385785_7210612'),
    46655: ('cognito perceptum', 'carbine single (M1 carbine, Winchester)', '46/46655_57789'),
    675603: ('craigsmith', 'S31-16 Tommy gun bursts; machine gun', '675/675603_2524442'),
    675657: ('craigsmith', 'S20-39 Browning automatic rifle', '675/675657_2524442'),
    486042: ('craigsmith', 'R12-04 Browning Machine Gun', '486/486042_2524442'),
    183656: ('qubodup', '50 Caliber MG (US Government video, PD)', '183/183656_71257'),
    239138: ('qubodup', '50 Cal MG (US Government video, PD)', '239/239138_71257'),
    675587: ('craigsmith', 'S20-48 A squad firing 37mm anti tank guns', '675/675587_2524442'),
    127845: ('GaryQ', 'Tank fire Mixed', '127/127845_1931452'),
    702455: ('AdamHarvester', '6 Pdr gun (Tankfest)', '702/702455_13447096'),
    702245: ('InMotionAudio', '69th Field Artillery gun', '702/702245_14083205'),
    162365: ('qubodup', 'Navy Battleship Soundscape: turret gunshots (US Government video, PD)', '162/162365_71257'),
    438531: ('craigsmith', 'G33-25 Bazooka', '438/438531_2524442'),
    438535: ('craigsmith', 'G33-29 Mortar Gun', '438/438535_2524442'),
    395038: ('AslakHostaker', 'Flamethrower Weapon Short/Medium Bursts', '395/395038_7487276'),
    609587: ('unfa', 'Grenade Explosion SFX (medium-sized, meaty, realistic)', '609/609587_1038806'),
    516914: ('Kinoton', 'Explosion, Medium Blast', '516/516914_2247456'),
    530163: ('wyskoj', 'Heavy explosion in forest, debris, tree falling', '530/530163_8338966'),
    251401: ('felix.blume', 'Dynamite explosion in the mountain', '251/251401_1661766'),
    483296: ('craigsmith', 'R30-12 Large Gun Shells Fly By and Explode', '483/483296_2524442'),
    675953: ('craigsmith', 'S25-16 Machine gun ricochets', '675/675953_2524442'),
    675602: ('craigsmith', 'S20-46 On the receiving end of a 50 cal Browning machine gun', '675/675602_2524442'),
    675945: ('craigsmith', 'S31-21 Artillery bullets hitting nearby & overhead', '675/675945_2524442'),
    855248: ('qubodup', 'Real Bullet Flyby Sound', '855/855248_71257'),
    675609: ('craigsmith', 'S16-31 Bombardment with distant explosions', '675/675609_2524442'),
    675604: ('craigsmith', 'S20-26 Various groups of machine guns, medium distance', '675/675604_2524442'),
}

# sound id -> list of variants: (source, t0, t1, ffmpeg filter or '', fade-in s, fade-out s)
CUTS = {
    'rifle_us': [(386842, 0.38, 2.3, 'highpass=f=35', 0.0, 0.5), (385785, 0.0, 2.2, 'highpass=f=35', 0.0, 0.5)],
    'carbine': [(46655, 0.36, 2.4, 'highpass=f=60', 0.0, 0.5)],
    'smg': [(675603, 0.03, 1.45, '', 0.0, 0.18), (675603, 1.46, 2.46, '', 0.0, 0.18), (675603, 3.64, 4.58, '', 0.0, 0.18), (675603, 4.65, 5.78, '', 0.0, 0.2)],
    'bar': [(675657, 0.0, 1.05, '', 0.0, 0.2), (675657, 1.85, 3.1, '', 0.0, 0.2), (675657, 3.18, 4.7, '', 0.0, 0.25)],
    'mg_us': [(486042, 2.74, 3.82, 'bass=g=3', 0.0, 0.2), (486042, 4.64, 5.8, 'bass=g=3', 0.0, 0.2), (486042, 5.94, 7.2, 'bass=g=3', 0.0, 0.25), (486042, 7.46, 8.62, 'bass=g=3', 0.0, 0.25)],
    'mg_50': [(183656, 0.03, 1.4, 'bass=g=2', 0.0, 0.25), (183656, 4.92, 6.2, 'bass=g=2', 0.0, 0.25), (183656, 10.28, 11.7, 'bass=g=2', 0.0, 0.3),
              (183656, 16.16, 17.5, 'bass=g=2', 0.0, 0.3), (239138, 0.0, 1.0, 'bass=g=2', 0.0, 0.2), (239138, 1.13, 2.4, 'bass=g=2', 0.0, 0.25)],
    'cannon_small': [(675587, 3.36, 5.5, 'highpass=f=30', 0.0, 0.5), (675587, 7.8, 9.35, 'highpass=f=30', 0.0, 0.4), (675587, 9.32, 10.85, 'highpass=f=30', 0.0, 0.4)],
    'cannon_tank': [(127845, 0.55, 3.0, '', 0.0, 0.6), (702455, 8.82, 10.95, 'bass=g=3', 0.0, 0.5)],
    'cannon_field': [(702245, 0.0, 2.1, 'bass=g=2', 0.0, 0.5), (127845, 0.55, 3.0, 'lowpass=f=6000', 0.0, 0.6)],
    'cannon_heavy': [(162365, 0.0, 1.42, 'bass=g=3', 0.0, 0.35), (162365, 2.15, 5.6, 'bass=g=3', 0.0, 0.8), (162365, 13.36, 15.3, 'bass=g=3', 0.0, 0.6)],
    'cannon_distant': [(162365, 2.15, 5.6, 'lowpass=f=900,lowpass=f=900,aecho=0.8:0.6:180|420:0.35|0.2,bass=g=6', 0.0, 0.8),
                       (162365, 13.36, 15.3, 'lowpass=f=800,lowpass=f=800,aecho=0.8:0.6:220|510:0.35|0.2,bass=g=6', 0.0, 0.8)],
    'bazooka': [(438531, 2.38, 4.6, 'highpass=f=40', 0.0, 0.6), (438531, 10.38, 12.6, 'highpass=f=40', 0.0, 0.6)],
    'mortar_launch': [(438535, 2.36, 3.3, 'bass=g=3', 0.0, 0.3), (438535, 6.62, 7.55, 'bass=g=3', 0.0, 0.3), (438535, 10.88, 11.8, 'bass=g=3', 0.0, 0.3)],
    'flamethrower': [(395038, 5.85, 8.1, '', 0.08, 0.5), (395038, 9.92, 12.4, '', 0.08, 0.5)],
    'grenade': [(609587, 0.45, 4.2, 'highpass=f=30', 0.0, 1.0)],
    'explosion_small': [(516914, 0.24, 3.8, 'highpass=f=30', 0.0, 0.9), (609587, 0.45, 4.2, 'highpass=f=30,lowpass=f=7000', 0.0, 1.0)],
    'explosion_large': [(530163, 0.55, 6.0, 'highpass=f=25', 0.0, 1.5)],
    'explosion_huge': [(251401, 0.02, 9.0, 'highpass=f=22,bass=g=3', 0.0, 2.5)],
    'shell_incoming': [(483296, 1.95, 3.72, 'highpass=f=150', 0.5, 0.05), (483296, 6.05, 7.75, 'highpass=f=150', 0.5, 0.05)],
    'ricochet': [(675953, 0.0, 0.9, 'highpass=f=300', 0.0, 0.2), (675953, 11.02, 11.95, 'highpass=f=300', 0.0, 0.2), (675953, 1.62, 2.9, 'highpass=f=300', 0.0, 0.3)],
    'near_miss': [(675602, 1.1, 2.6, 'highpass=f=120', 0.0, 0.3), (675602, 3.0, 4.6, 'highpass=f=120', 0.0, 0.3), (675945, 0.0, 2.17, 'highpass=f=120', 0.0, 0.4), (675945, 2.56, 4.6, 'highpass=f=120', 0.0, 0.4)],
    'bullet_crack': [(855248, 0.0, 0.14, 'highpass=f=200', 0.0, 0.03)],
}
MAXLEN = {'explosion_huge': 9.0}
LOOPS = {'battle_distant': 20.0}


def fetch(sid):
    os.makedirs(CACHE, exist_ok=True)
    p = os.path.join(CACHE, f'{sid}.mp3')
    if not os.path.exists(p):
        url = f'https://cdn.freesound.org/previews/{SRC[sid][2]}-hq.mp3'
        print('  downloading', url)
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        open(p, 'wb').write(urllib.request.urlopen(req, timeout=60).read())
    return p


def decode(path, af=''):
    cmd = ['ffmpeg', '-v', 'quiet', '-i', path] + (['-af', af] if af else []) + ['-ac', '1', '-ar', str(SR), '-f', 'f32le', '-']
    return np.frombuffer(subprocess.run(cmd, capture_output=True, check=True).stdout, np.float32).copy()


def encode(x, path, kbps=128):
    x = np.clip(x, -1, 1).astype(np.float32)
    subprocess.run(['ffmpeg', '-v', 'quiet', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-', '-c:a', 'libmp3lame', '-b:a', f'{kbps}k', path],
                   input=x.tobytes(), check=True)


def cut(sid, t0, t1, af, fin, fout):
    x = decode(fetch(sid), af)
    seg = x[int(t0 * SR):int(t1 * SR)].copy()
    n = len(seg)
    if fin > 0: seg[:int(fin * SR)] *= np.linspace(0, 1, int(fin * SR)) ** 2
    else: seg[:64] *= np.linspace(0, 1, 64)                    # de-click
    k = min(n, int(fout * SR))
    if k: seg[n - k:] *= np.linspace(1, 0, k) ** 1.5
    return seg / (np.abs(seg).max() + 1e-9) * 0.89                   # -1 dBFS


def loop_battle(sec):
    """Distant battle bed: CC0 bombardment + machine guns at medium distance, low-passed, seamless loop."""
    a = decode(fetch(675609), 'lowpass=f=2600')[: int((sec + 3) * SR)]
    b = decode(fetch(675604), 'lowpass=f=3200,volume=0.55')
    b = np.tile(b, int(np.ceil(len(a) / len(b))))[: len(a)]
    x = a / (np.abs(a).max() + 1e-9) + b / (np.abs(b).max() + 1e-9) * 0.5
    n, xf = int(sec * SR), int(2.5 * SR)
    body = x[:n].copy(); tail = x[n:n + xf]
    w = np.sin(np.linspace(0, np.pi / 2, xf)) ** 2
    body[:xf] = body[:xf] * w + tail * (1 - w)
    rms = np.sqrt(np.mean(body ** 2)); body *= 0.12 / (rms + 1e-9)          # ~-18 dBFS RMS
    return np.clip(body, -0.89, 0.89)


def main():
    man = json.load(open(os.path.join(OUT, 'manifest.json')))
    for sid_name, cuts in CUTS.items():
        print(sid_name, len(cuts), 'variant(s)')
        for i, c in enumerate(cuts):
            encode(cut(*c), os.path.join(OUT, f'{sid_name}{"" if i == 0 else "_" + str(i + 1)}.mp3'))
        # remove stale extra variants from an earlier build
        j = len(cuts) + 1
        while os.path.exists(os.path.join(OUT, f'{sid_name}_{j}.mp3')):
            os.remove(os.path.join(OUT, f'{sid_name}_{j}.mp3')); j += 1
        entry = man.get(sid_name, {'desc': sid_name})
        entry['variants'] = len(cuts)
        entry['src'] = sorted({c[0] for c in cuts})
        man[sid_name] = entry
    print('battle_distant loop')
    encode(loop_battle(LOOPS['battle_distant']), os.path.join(OUT, 'battle_distant.mp3'), 96)
    man['battle_distant']['src'] = [675609, 675604]
    for k, d in {'carbine': 'M1 carbine single shot', 'cannon_field': '75 mm field / pack howitzer firing', 'cannon_heavy': '8-inch coast-defence gun firing, close',
                 'near_miss': 'bullets cracking past and hitting nearby (heard by the target)', 'bullet_crack': 'single supersonic bullet crack'}.items():
        man.setdefault(k, {})['desc'] = d
    json.dump(man, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=1)
    # credits fragment for the rebuilt ids
    with open(os.path.join(CACHE, 'credits_rows.md'), 'w') as f:
        for k in list(CUTS) + ['battle_distant']:
            for sid in man[k]['src']:
                a, t, _ = SRC[sid]
                f.write(f'| {k} | Freesound #{sid} "{t}" | {a} | https://freesound.org/s/{sid}/ | CC0 |\n')
    print('done')


if __name__ == '__main__':
    sys.exit(main())
