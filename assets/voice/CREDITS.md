# Voice credits

All voice lines in this folder (`<id>.mp3`, listed in `manifest.json`) are synthetic speech
generated locally with open-weights models. No recorded voice actors, and no cloud TTS service, were used.
To regenerate them, run `tools/gen_voices.py`. The script lists the pip packages it needs at the top.

## Model

- **Kokoro-82M** v1.0 by hexgrad, licensed **Apache-2.0**.
  https://huggingface.co/hexgrad/Kokoro-82M
- The model ran through **kokoro-onnx** (MIT), using the ONNX export of Kokoro v1.0 weights and voices
  (`kokoro-v1.0.onnx`, `voices-v1.0.bin`).
  https://github.com/thewh1teagle/kokoro-onnx

## Grapheme-to-phoneme

- **misaki** (Apache-2.0), Kokoro's G2P library. It handles English (US and GB) and Japanese.
  https://github.com/hexgrad/misaki
  - English uses spaCy `en_core_web_sm` (MIT), with **espeak-ng** (GPL-3.0) as the fallback for
    out-of-vocabulary words. espeak-ng only produced phonemes here. It made none of the audio.
  - Japanese uses cutlet/fugashi (MIT) with the **unidic-lite** dictionary (BSD/MIT-style).

## Casting

| Role       | Kokoro voice | Speed | Notes |
|------------|--------------|-------|-------|
| `us`       | `am_fenrir`  | 1.10  | US male, combat delivery, light compression |
| `us2`      | `am_puck`    | 1.08  | A second US male, combat delivery, light compression |
| `radio`    | `am_michael` | 1.05  | US male, calm and clipped. The audio is clean: the game adds the radio band-pass at runtime |
| `jp`       | `jm_kumo`    | 1.05  | Japanese male, speaking the Japanese text |
| `narrator` | `bm_george`  | 0.95  | British male, calm documentary voice |

## Post-processing

Processing used ffmpeg (libmp3lame) and numpy:
- 60 Hz high-pass
- light compression on the combat roles only
- resampling to 44.1 kHz mono
- leading and trailing silence trimmed
- peak normalised to -1 dBFS
- encoded as 80 kbps CBR MP3

No fallback engines were used. Every line was made with Kokoro-82M, and none came from espeak-ng or macOS `say`.
