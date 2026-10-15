# Voice credits

All voice lines in this folder are synthetic speech generated with **ElevenLabs** (https://elevenlabs.io).
No recorded voice actors were used. `manifest.json` lists every line.

To regenerate them, set `ELEVENLABS_API_KEY` and run `tools/gen_voices.py`. Only Python 3.9+, numpy and ffmpeg are needed.

## Model

- **eleven_v3** text-to-speech. Bracketed audio tags in each prompt (the manifest's `say` field) set the delivery,
  for example `[shouting]`, `[whispering, tense]` or `[firm, commanding]`.
- Every take was transcribed with **ElevenLabs Scribe** (`scribe_v1`) and compared with its prompt. A take that dropped
  words or read a tag aloud was regenerated with a new seed.

## Takes

Most combat lines (US and Japanese) have several takes, one per tone. The files are named `<id>.<tone>.mp3`:

| Tone       | Delivery |
|------------|----------|
| `urgent`   | Shouted over the noise, under fire |
| `cautious` | Low, tense or whispered, for sneaking, ambush or spotting the enemy |
| `calm`     | Firm and commanding, when the unit is in control |

The game picks the take from the speaker's team: urgent when it is suppressed or pinned, cautious when it is
sneaking or in ambush, and calm otherwise. If a line has no take in that tone, the nearest delivery is used.
Radio and narration lines have one take each, named `<id>.mp3`.

## Casting (ElevenLabs premade voices)

| Role       | Voice  | Notes |
|------------|--------|-------|
| `us`       | Adam   | Marine NCO: dominant and firm. Light compression |
| `us2`      | Harry  | A second Marine: rough and fierce. Light compression |
| `radio`    | Bill   | Older officer on the net: crisp. The audio is clean; the game adds the radio band-pass at runtime |
| `jp`       | Callum | Japanese soldier. Kana prompts are spoken with `language_code=ja`; the kanji `text` is for display |
| `narrator` | George | British documentary voice |

## Post-processing

Processing used ffmpeg (libmp3lame) and numpy:
- 60 Hz high-pass
- light compression on the combat roles only
- resampling to 44.1 kHz mono
- leading and trailing silence trimmed
- peak normalised to -1 dBFS
- encoded as 80 kbps CBR MP3
