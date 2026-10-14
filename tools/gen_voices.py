#!/usr/bin/env python3
"""
Generate the game's voice lines (assets/voice/<id>.mp3) from assets/voice/manifest.json
using the open-weights Kokoro-82M TTS model (Apache-2.0) run locally via kokoro-onnx.

Requirements
------------
Python 3.10+ (tested on 3.11.9), ffmpeg on PATH (or pass --ffmpeg), and:

    python -m venv ttsvenv && . ttsvenv/bin/activate
    pip install kokoro-onnx soundfile "misaki[ja]" spacy num2words unidic-lite
    pip install "en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"
    # misaki[ja] pulls in the upstream `phonemizer` package, which shadows the
    # `phonemizer-fork` that kokoro-onnx needs. Put the fork back:
    pip uninstall -y phonemizer unidic && pip install --force-reinstall phonemizer-fork

  * kokoro-onnx  - ONNX runtime wrapper for Kokoro-82M
  * misaki       - Kokoro's own grapheme-to-phoneme library (English + Japanese)
  * spacy + en_core_web_sm, num2words - needed by misaki's English G2P
  * unidic-lite  - dictionary for fugashi/cutlet (misaki's Japanese G2P);
                   the full `unidic` package also works after `python -m unidic download`
  * espeak-ng    - used by misaki as out-of-vocabulary fallback. A system install
                   (e.g. `brew install espeak-ng`) is preferred when present, because the
                   macOS espeakng-loader wheel ships with a broken data path.

Model weights (~340 MB) are downloaded on first run into --models-dir
(default: $KOKORO_MODELS_DIR or ~/.cache/kokoro-onnx), never into the project:
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin

Usage
-----
    python tools/gen_voices.py                 # generate missing files
    python tools/gen_voices.py --force         # regenerate everything
    python tools/gen_voices.py --only us_move_1 jp_banzai --force
    python tools/gen_voices.py --list-voices

Output: mono, 44.1 kHz, ~80 kbps MP3, leading/trailing silence trimmed, peak ~ -1 dBFS.
No radio effect is baked in (the game applies its own band-pass at runtime).
"""
from __future__ import annotations

import argparse
import ctypes.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "assets" / "voice" / "manifest.json"
OUT_DIR = ROOT / "assets" / "voice"

MODEL_URLS = {
    "kokoro-v1.0.onnx": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
    "voices-v1.0.bin": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
}

# ---------------------------------------------------------------------------
# Casting: role -> Kokoro voice, speed, G2P language, post-processing
# ---------------------------------------------------------------------------
ROLES = {
    # gritty US Marine, energetic combat delivery
    "us":       dict(voice="am_fenrir",  speed=1.10, lang="en-us", compress=True),
    # second, clearly different US Marine
    "us2":      dict(voice="am_puck",    speed=1.08, lang="en-us", compress=True),
    # calm, clipped radio operator (clean audio; runtime adds radio filter)
    "radio":    dict(voice="am_michael", speed=1.05, lang="en-us", compress=False),
    # Japanese soldier, speaks the Japanese text
    "jp":       dict(voice="jm_kumo",    speed=1.05, lang="ja",    compress=True),
    # calm documentary narrator
    "narrator": dict(voice="bm_george",  speed=0.95, lang="en-gb", compress=False),
}

# Pronunciation fixes, applied to English text before G2P using misaki's
# inline phoneme syntax [word](/phonemes/). Keys are regexes (case-sensitive).
PRONUNCIATION = {
    r"\bCorpsman\b": "[Corpsman](/kˈɔɹmən/)",      # the 'ps' is silent: "core-man"
    r"\bBetio\b": "[Betio](/bˈAʃiO/)",              # BAY-shee-oh
    r"\bBuariki\b": "[Buariki](/bwɑɹˈiki/)",       # bwah-REE-kee
    r"\bShibasaki\b": "[Shibasaki](/ʃˌibəsˈɑki/)",  # shee-bah-SAH-kee
    r"\bAmtracs\b": "[Amtracs](/ˈæmtɹæks/)",
    r"\bAmtrac's\b": "[Amtrac's](/ˈæmtɹæks/)",
    r"\bTarawa\b": "[Tarawa](/təɹˈɑwə/)",
}


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------------------
# espeak-ng location (used as English OOV fallback and by kokoro-onnx tokenizer)
# ---------------------------------------------------------------------------
def find_system_espeak():
    exe = shutil.which("espeak-ng")
    lib = ctypes.util.find_library("espeak-ng")
    if not lib:
        for cand in ("/usr/local/lib/libespeak-ng.dylib", "/opt/homebrew/lib/libespeak-ng.dylib",
                     "/usr/lib/x86_64-linux-gnu/libespeak-ng.so.1", "/usr/lib/libespeak-ng.so.1"):
            if os.path.exists(cand):
                lib = cand
                break
    data = None
    if exe:
        try:
            out = subprocess.run([exe, "--version"], capture_output=True, text=True).stdout
            m = re.search(r"Data at:\s*(\S+)", out)
            if m and os.path.isdir(m.group(1)):
                data = m.group(1)
        except OSError:
            pass
    if lib and data:
        return lib, data
    return None, None


def configure_espeak():
    """Point phonemizer's EspeakWrapper at a working espeak-ng. Returns (lib, data) or (None, None)."""
    lib, data = find_system_espeak()
    if lib and data:
        from phonemizer.backend.espeak.wrapper import EspeakWrapper
        EspeakWrapper.set_library(lib)
        EspeakWrapper.set_data_path(data)
    return lib, data


# ---------------------------------------------------------------------------
# Model download
# ---------------------------------------------------------------------------
def ensure_models(models_dir: Path):
    models_dir.mkdir(parents=True, exist_ok=True)
    for name, url in MODEL_URLS.items():
        dest = models_dir / name
        if dest.exists() and dest.stat().st_size > 1_000_000:
            continue
        log(f"Downloading {url} -> {dest}")
        tmp = dest.with_suffix(dest.suffix + ".part")
        urllib.request.urlretrieve(url, tmp)
        tmp.rename(dest)
    return models_dir / "kokoro-v1.0.onnx", models_dir / "voices-v1.0.bin"


# ---------------------------------------------------------------------------
# G2P
# ---------------------------------------------------------------------------
class Phonemizers:
    def __init__(self):
        self._en = {}
        self._ja = None

    def en(self, text: str, british: bool) -> str:
        if british not in self._en:
            from misaki import en, espeak
            configure_espeak()  # misaki.espeak sets the (broken on macOS) loader path on import; override it
            fb = espeak.EspeakFallback(british=british)
            self._en[british] = en.G2P(trf=False, british=british, fallback=fb)
        for pat, rep in PRONUNCIATION.items():
            text = re.sub(pat, rep, text)
        ps, _ = self._en[british](text)
        return ps

    def ja(self, text: str) -> str:
        if self._ja is None:
            from misaki import ja
            try:
                self._ja = ("cutlet", ja.JAG2P())  # same G2P that Kokoro's own pipeline uses
            except Exception as e:  # missing unidic dictionary etc.
                log(f"  cutlet/unidic unavailable ({e}); using pyopenjtalk G2P")
                self._ja = ("pyopenjtalk", ja.JAG2P(version="pyopenjtalk"))
        kind, g2p = self._ja
        ps, _ = g2p(text)
        if kind == "pyopenjtalk":
            ps = ps[: len(ps) // 2]  # misaki returns phonemes + same-length pitch string
        return ps


# ---------------------------------------------------------------------------
# Audio processing
# ---------------------------------------------------------------------------
def db_to_lin(db):
    return 10.0 ** (db / 20.0)


def trim_silence(x: np.ndarray, sr: int, rel_db=-42.0, pre_ms=25, post_ms=70):
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    if peak <= 0:
        return x
    # short-window envelope so isolated clicks don't count as speech
    win = max(1, int(sr * 0.005))
    env = np.convolve(np.abs(x), np.ones(win) / win, mode="same")
    idx = np.nonzero(env > peak * db_to_lin(rel_db))[0]
    if idx.size == 0:
        return x
    a = max(0, idx[0] - int(sr * pre_ms / 1000))
    b = min(len(x), idx[-1] + int(sr * post_ms / 1000))
    y = x[a:b].copy()
    # short fades to avoid clicks at the cut points
    f_in, f_out = min(len(y), int(sr * 0.005)), min(len(y), int(sr * 0.015))
    if f_in:
        y[:f_in] *= np.linspace(0, 1, f_in)
    if f_out:
        y[-f_out:] *= np.linspace(1, 0, f_out)
    return y


def ffmpeg_run(ffmpeg, args):
    r = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *args],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {r.stderr.strip()}")


def process_to_mp3(samples: np.ndarray, sr: int, out_mp3: Path, compress: bool, ffmpeg: str,
                   bitrate="80k", out_sr=44100, peak_db=-1.0):
    with tempfile.TemporaryDirectory() as td:
        raw = Path(td) / "raw.wav"
        mid = Path(td) / "mid.wav"
        fin = Path(td) / "final.wav"
        sf.write(raw, samples.astype(np.float32), sr, subtype="FLOAT")
        # resample to 44.1k mono; light compression for combat shouts (no EQ / radio colouring)
        filters = ["highpass=f=60"]
        if compress:
            filters.append("acompressor=threshold=-20dB:ratio=3:attack=4:release=60:makeup=2")
        filters.append(f"aresample={out_sr}:resampler=soxr")
        ffmpeg_run(ffmpeg, ["-i", str(raw), "-ac", "1", "-af", ",".join(filters),
                            "-c:a", "pcm_f32le", str(mid)])
        y, ysr = sf.read(mid, dtype="float32")
        if y.ndim > 1:
            y = y.mean(axis=1)
        y = trim_silence(y, ysr)
        peak = float(np.max(np.abs(y)))
        if peak > 0:
            y = y * (db_to_lin(peak_db) / peak)
        sf.write(fin, y, ysr, subtype="PCM_16")
        ffmpeg_run(ffmpeg, ["-i", str(fin), "-ac", "1", "-ar", str(out_sr),
                            "-c:a", "libmp3lame", "-b:a", bitrate, "-map_metadata", "-1",
                            "-id3v2_version", "0", "-write_xing", "1", str(out_mp3)])
    return len(y) / ysr


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--manifest", default=str(MANIFEST))
    ap.add_argument("--out", default=str(OUT_DIR))
    ap.add_argument("--models-dir", default=os.environ.get(
        "KOKORO_MODELS_DIR", str(Path.home() / ".cache" / "kokoro-onnx")))
    ap.add_argument("--ffmpeg", default=shutil.which("ffmpeg") or "/usr/local/bin/ffmpeg")
    ap.add_argument("--only", nargs="*", help="only these line ids")
    ap.add_argument("--force", action="store_true", help="overwrite existing mp3 files")
    ap.add_argument("--list-voices", action="store_true")
    args = ap.parse_args()

    from kokoro_onnx import Kokoro
    from kokoro_onnx.config import EspeakConfig

    model_path, voices_path = ensure_models(Path(args.models_dir))
    lib, data = find_system_espeak()
    cfg = EspeakConfig(lib_path=lib, data_path=data) if lib and data else None
    kokoro = Kokoro(str(model_path), str(voices_path), espeak_config=cfg)
    if args.list_voices:
        print("\n".join(sorted(kokoro.get_voices())))
        return 0

    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    lines = manifest["lines"]
    if args.only:
        lines = [l for l in lines if l["id"] in set(args.only)]
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    g2p = Phonemizers()
    failed = []
    for line in lines:
        lid, role, text = line["id"], line["role"], line["text"]
        out = out_dir / f"{lid}.mp3"
        if out.exists() and not args.force:
            log(f"skip  {lid} (exists)")
            continue
        cast = ROLES.get(role)
        if not cast:
            log(f"FAIL  {lid}: unknown role {role!r}")
            failed.append(lid)
            continue
        try:
            if cast["lang"] == "ja":
                ps = g2p.ja(text)
            else:
                ps = g2p.en(text, british=cast["lang"] == "en-gb")
            samples, sr = kokoro.create(ps, voice=cast["voice"], speed=cast["speed"], is_phonemes=True)
            dur = process_to_mp3(samples, sr, out, cast["compress"], args.ffmpeg)
            log(f"ok    {lid:22s} {role:8s} {cast['voice']:10s} {dur:5.2f}s  /{ps}/")
        except Exception as e:  # keep going; report at the end
            log(f"FAIL  {lid}: {e!r}")
            failed.append(lid)

    if failed:
        log(f"\n{len(failed)} line(s) failed: {', '.join(failed)}")
        return 1
    log("\nAll lines generated.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
