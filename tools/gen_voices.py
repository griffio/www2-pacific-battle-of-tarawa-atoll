#!/usr/bin/env python3
"""
Generate the game's voice lines from assets/voice/manifest.json with the ElevenLabs API
(eleven_v3 text-to-speech), check each take with ElevenLabs Scribe speech-to-text, and
post-process them into small mono MP3s.

Requirements
------------
Python 3.9+, numpy, and ffmpeg on PATH (or pass --ffmpeg). HTTP uses only the standard library.
The API key is read from the environment and is never written anywhere:

    export ELEVENLABS_API_KEY=sk_...

A free-tier key is enough. Free accounts can only use ElevenLabs' premade voices, so the
casting below sticks to them.

Manifest
--------
Each line has an `id`, a `role` (see ROLES) and a `text`. The prompt sent to the model is `say`,
which defaults to `text`. Bracketed eleven_v3 audio tags in it, such as [shouting], [whispering]
or [firm, commanding], set the delivery. A line with `takes` gets one file per take:

    assets/voice/<id>.<tone>.mp3      tone = urgent | cautious | calm

The game picks the take that suits the speaker's situation. A line without takes gets
assets/voice/<id>.mp3.

Usage
-----
    python3 tools/gen_voices.py                       # generate missing files
    python3 tools/gen_voices.py --force               # regenerate everything
    python3 tools/gen_voices.py --only us_move_1 jp_banzai --force
    python3 tools/gen_voices.py --prune               # also delete mp3s the manifest no longer lists
    python3 tools/gen_voices.py --no-verify           # skip the speech-to-text check

Verification: each take is transcribed and compared with the prompt, ignoring the tags. When the
model drops words, reads a tag aloud or improvises, the take is regenerated with a new seed
(--attempts) and the best-matching take is kept.

Output: mono, 44.1 kHz, 80 kbps MP3. Leading and trailing silence is trimmed and peaks are
normalised to -1 dBFS. No radio effect is baked in, because the game adds its own band-pass
at runtime.
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "assets" / "voice" / "manifest.json"
OUT_DIR = ROOT / "assets" / "voice"
API = "https://api.elevenlabs.io"
MODEL = "eleven_v3"
SR = 44100

# ---------------------------------------------------------------------------
# Casting: role -> ElevenLabs premade voice, v3 stability (0 creative / 0.5 natural / 1 robust),
# optional language code, and post-processing
# ---------------------------------------------------------------------------
ROLES = {
    # Marine NCO: dominant, firm. Barks orders.
    "us":       dict(voice="pNInz6obpgDQGcFmaJgB", name="Adam",   stability=0.5, compress=True),
    # A second Marine, clearly different: rough, fierce, younger
    "us2":      dict(voice="SOYHLrjzK2X1ezoPC6cr", name="Harry",  stability=0.5, compress=True),
    # Older officer on the net: crisp and measured. Clean audio; the game adds the radio filter
    "radio":    dict(voice="pqHfZKP75CvOlQylNhV4", name="Bill",   stability=0.5, compress=False),
    # Japanese soldier: husky. Speaks the kana prompts with language_code=ja
    "jp":       dict(voice="N2lVS1w4EtoT3dr4eOWO", name="Callum", stability=0.5, compress=True, lang="ja"),
    # Documentary narrator
    "narrator": dict(voice="JBFqnCBsd6RMkjVDRZzb", name="George", stability=0.5, compress=False),
}


def log(*a):
    print(*a, flush=True)


class QuotaError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# ElevenLabs HTTP
# ---------------------------------------------------------------------------
def http(req: urllib.request.Request, tries=5):
    for k in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            if "quota_exceeded" in body or "insufficient" in body:
                raise QuotaError(body)
            if e.code in (429, 500, 502, 503, 504) and k < tries - 1:
                time.sleep(2 * (k + 1))
                continue
            raise RuntimeError(f"HTTP {e.code}: {body[:300]}")
        except urllib.error.URLError:
            if k < tries - 1:
                time.sleep(2 * (k + 1))
                continue
            raise


def tts(key: str, cast: dict, prompt: str, seed: int) -> tuple[bytes, int]:
    body = {"text": prompt, "model_id": MODEL, "seed": seed,
            "voice_settings": {"stability": cast["stability"]}}
    if cast.get("lang"):
        body["language_code"] = cast["lang"]
    req = urllib.request.Request(
        f"{API}/v1/text-to-speech/{cast['voice']}?output_format=mp3_44100_128",
        data=json.dumps(body).encode("utf-8"), method="POST",
        headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg"})
    data, headers = http(req)
    cost = {k.lower(): v for k, v in headers.items()}.get("character-cost", "?")
    return data, cost


def stt(key: str, mp3: bytes, lang: str | None) -> str:
    boundary = uuid.uuid4().hex
    fields = [("model_id", "scribe_v1"), ("tag_audio_events", "false")]
    if lang:
        fields.append(("language_code", lang))
    parts = []
    for k, v in fields:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="take.mp3"\r\n'
                 f'Content-Type: audio/mpeg\r\n\r\n'.encode() + mp3 + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(f"{API}/v1/speech-to-text", data=b"".join(parts), method="POST",
                                 headers={"xi-api-key": key,
                                          "Content-Type": f"multipart/form-data; boundary={boundary}"})
    data, _ = http(req)
    return json.loads(data).get("text", "")


# ---------------------------------------------------------------------------
# Transcript check
# ---------------------------------------------------------------------------
def spoken(prompt: str) -> str:
    return re.sub(r"\[[^\]]*\]", " ", prompt)


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s).lower()
    s = re.sub(r"[ァ-ヶ]", lambda m: chr(ord(m.group(0)) - 0x60), s)  # katakana -> hiragana
    s = re.sub(r"\b(them|'em|em)\b", "em", s)
    s = s.replace("amtrac's", "amtracs").replace("amtrack", "amtrac")
    s = re.sub(r"\bcorpsman\b|\bcoreman\b|\bcorman\b|\bcorpsmen\b", "corpsman", s)
    s = re.sub(r"[^\w\s]", " ", s)
    return " ".join(s.split())


def match(expected: list[str], heard: str) -> float:
    h = norm(heard)
    return max(difflib.SequenceMatcher(None, norm(e), h).ratio() for e in expected)


# ---------------------------------------------------------------------------
# Audio processing
# ---------------------------------------------------------------------------
def ffmpeg_run(ffmpeg, args, stdin: bytes | None = None) -> bytes:
    r = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *args],
                       input=stdin, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {r.stderr.decode(errors='replace').strip()}")
    return r.stdout


def trim_silence(x: np.ndarray, sr: int, rel_db=-40.0, pre_ms=25, post_ms=90):
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    if peak <= 0:
        return x
    # short-window envelope so isolated clicks don't count as speech
    win = max(1, int(sr * 0.005))
    env = np.convolve(np.abs(x), np.ones(win) / win, mode="same")
    idx = np.nonzero(env > peak * 10 ** (rel_db / 20))[0]
    if idx.size == 0:
        return x
    a = max(0, idx[0] - int(sr * pre_ms / 1000))
    b = min(len(x), idx[-1] + int(sr * post_ms / 1000))
    y = x[a:b].copy()
    # short fades to avoid clicks at the cut points
    f_in, f_out = min(len(y), int(sr * 0.005)), min(len(y), int(sr * 0.02))
    if f_in:
        y[:f_in] *= np.linspace(0, 1, f_in)
    if f_out:
        y[-f_out:] *= np.linspace(1, 0, f_out)
    return y


def process_to_mp3(mp3: bytes, out_mp3: Path, compress: bool, ffmpeg: str, bitrate="80k", peak_db=-1.0) -> float:
    # 60 Hz high-pass; light compression on the combat roles keeps shouts and hushed takes audible in the mix
    filters = ["highpass=f=60"]
    if compress:
        filters.append("acompressor=threshold=-20dB:ratio=3:attack=4:release=60:makeup=2")
    raw = ffmpeg_run(ffmpeg, ["-i", "pipe:0", "-ac", "1", "-ar", str(SR), "-af", ",".join(filters),
                              "-f", "f32le", "pipe:1"], stdin=mp3)
    y = trim_silence(np.frombuffer(raw, dtype=np.float32).copy(), SR)
    peak = float(np.max(np.abs(y))) if y.size else 0.0
    if peak > 0:
        y = y * (10 ** (peak_db / 20) / peak)
    pcm = (np.clip(y, -1, 1) * 32767).astype("<i2").tobytes()
    ffmpeg_run(ffmpeg, ["-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "pipe:0",
                        "-c:a", "libmp3lame", "-b:a", bitrate, "-map_metadata", "-1",
                        "-id3v2_version", "0", "-write_xing", "1", str(out_mp3)], stdin=pcm)
    return len(y) / SR


# ---------------------------------------------------------------------------
def jobs_for(line: dict):
    """Yield (filename stem, tone, prompt) for every file a manifest line needs."""
    if line.get("takes"):
        for t in line["takes"]:
            yield f"{line['id']}.{t['tone']}", t["tone"], t["say"]
    else:
        yield line["id"], None, line.get("say") or line["text"]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--manifest", default=str(MANIFEST))
    ap.add_argument("--out", default=str(OUT_DIR))
    ap.add_argument("--ffmpeg", default=shutil.which("ffmpeg") or "/usr/local/bin/ffmpeg")
    ap.add_argument("--only", nargs="*", help="only these line ids (or <id>.<tone> stems)")
    ap.add_argument("--force", action="store_true", help="overwrite existing mp3 files")
    ap.add_argument("--prune", action="store_true", help="delete mp3 files the manifest no longer lists")
    ap.add_argument("--no-verify", action="store_true", help="skip the speech-to-text check")
    ap.add_argument("--attempts", type=int, default=3, help="max generations per take when the check fails")
    ap.add_argument("--min-match", type=float, default=0.8, help="transcript similarity needed to accept a take")
    args = ap.parse_args()

    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        log("Set ELEVENLABS_API_KEY first.")
        return 2

    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    wanted = {stem for l in manifest["lines"] for stem, _, _ in jobs_for(l)}
    if args.prune:
        for f in sorted(out_dir.glob("*.mp3")):
            if f.stem not in wanted:
                log(f"prune {f.name}")
                f.unlink()

    only = set(args.only or [])
    failed, weak, spent = [], [], 0
    for line in manifest["lines"]:
        cast = ROLES.get(line["role"])
        if not cast:
            log(f"FAIL  {line['id']}: unknown role {line['role']!r}")
            failed.append(line["id"])
            continue
        for stem, tone, prompt in jobs_for(line):
            if only and line["id"] not in only and stem not in only:
                continue
            out = out_dir / f"{stem}.mp3"
            if out.exists() and not args.force:
                log(f"skip  {stem} (exists)")
                continue
            expected = [spoken(prompt), line["text"]]
            stt_lang = "jpn" if cast.get("lang") == "ja" else "eng"
            best = None
            try:
                for attempt in range(max(1, args.attempts)):
                    seed = random.randrange(1, 2 ** 31)
                    mp3, cost = tts(key, cast, prompt, seed)
                    spent += int(cost) if str(cost).isdigit() else 0
                    if args.no_verify:
                        best = (1.0, mp3, "", seed)
                        break
                    heard = stt(key, mp3, stt_lang)
                    score = match(expected, heard)
                    if best is None or score > best[0]:
                        best = (score, mp3, heard, seed)
                    if score >= args.min_match:
                        break
                    log(f"  retry {stem}: heard {heard!r} ({score:.2f})")
                score, mp3, heard, seed = best
                dur = process_to_mp3(mp3, out, cast["compress"], args.ffmpeg)
                flag = "ok  " if score >= args.min_match else "WEAK"
                if score < args.min_match:
                    weak.append(stem)
                log(f"{flag}  {stem:28s} {cast['name']:7s} {dur:5.2f}s  match {score:.2f}  seed {seed}  heard {heard!r}")
            except QuotaError as e:
                log(f"\nQuota exhausted at {stem}: {e}\nRe-run later; existing files are skipped.")
                return 1
            except Exception as e:  # keep going; report at the end
                log(f"FAIL  {stem}: {e!r}")
                failed.append(stem)

    log(f"\nCharacters spent: {spent}")
    if weak:
        log(f"{len(weak)} take(s) below the match threshold (kept the best attempt): {', '.join(weak)}")
    if failed:
        log(f"{len(failed)} take(s) failed: {', '.join(failed)}")
        return 1
    log("All lines generated.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
