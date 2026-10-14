# Sound effect credits

All files in this folder are derived works made from the free/open-licensed recordings listed below.
Processing common to every file: downmixed to mono, resampled to 44.1 kHz, leading silence trimmed,
cut to the manifest `maxLen`, MP3 (LAME, 112 kbps one-shots / 96 kbps loops, Xing/LAME gapless header).
One-shots: short fade-out, peak-normalised to -1 dBFS (UI sounds -3 dBFS, whistle -4 dBFS).
Loops: seamless equal-power crossfade of the tail into the head, loudness-normalised to about -16 LUFS
(peak capped at -1 dBFS, so some loops end up quieter).

Licences: **CC0** = public domain dedication, **PD** = public domain, **CC BY 4.0** / **CC BY-SA 3.0** = attribution
(ShareAlike: the derived MP3s marked CC BY-SA are themselves available under CC BY-SA 3.0).

## Per-sound table

| id | Source(s) | Author | URL | Licence | Processing |
|---|---|---|---|---|---|
| rifle_us | The Free Firearm Sound Library, `1917/B_24P.wav` (Springfield M1917 .30-06, near) | The Free Firearm Sound Library team (posted by bart) | https://opengameart.org/content/the-free-firearm-sound-library | CC0 | single shot extracted, 40 Hz high-pass (.30-06 is the M1 Garand cartridge) |
| rifle_jp | The Free Firearm Sound Library, `Arisaka/E_25P.wav` (Arisaka, near) | The Free Firearm Sound Library team | https://opengameart.org/content/the-free-firearm-sound-library | CC0 | single shot, 120 Hz high-pass, +2 dB at 3 kHz (thinner/sharper) |
| smg | The Free Firearm Sound Library, `Carl Gustav M45/G_33P.wav` (short burst) | The Free Firearm Sound Library team | https://opengameart.org/content/the-free-firearm-sound-library | CC0 | 4-round burst, +3 dB bass shelf |
| bar | The Free Firearm Sound Library, `AK-47/C_29P.wav` (short burst) | The Free Firearm Sound Library team | https://opengameart.org/content/the-free-firearm-sound-library | CC0 | 4-round burst pitch-shifted down ~2.2 semitones (rubberband), +4 dB bass |
| mg_us | The Free Firearm Sound Library, `1917/B_24P.wav`, `Tikka/W_29P.wav` (.30-06 shots) | The Free Firearm Sound Library team | https://opengameart.org/content/the-free-firearm-sound-library | CC0 | 9-round burst composited from single shots at ~520 rpm with small gain/timing jitter |
| mg_jp | The Free Firearm Sound Library, `Arisaka/E_25P.wav` | The Free Firearm Sound Library team | https://opengameart.org/content/the-free-firearm-sound-library | CC0 | 7-round burst composited from single shots at ~430 rpm ("woodpecker" cadence) |
| mg_50 | The Free Firearm Sound Library, `Mosin Nagant/M_21P.wav` | The Free Firearm Sound Library team | https://opengameart.org/content/the-free-firearm-sound-library | CC0 | shots pitched down ~5.7 semitones, +6 dB bass, composited into 8-round burst at ~480 rpm |
| bazooka | Red Eclipse sounds, `weapons/rocket/primary.ogg` | Red Eclipse team (Quinton "quin" Reeves, Alex "blackshoe" Anguix et al.) | https://opengameart.org/content/red-eclipse-sounds | CC BY-SA 3.0 | 30 Hz high-pass |
| flamethrower | Red Eclipse sounds, `weapons/flamer/primary.ogg`, `ambience/fire.ogg`, `sfx/burnfire.ogg` | Red Eclipse team (Quinton Reeves, Alex Anguix et al.) | https://opengameart.org/content/red-eclipse-sounds | CC BY-SA 3.0 | layered: flamer whoosh + fire roar + crackle, 2.4 s with fade in/out |
| grenade | Red Eclipse sounds, `weapons/explode.ogg` | Red Eclipse team | https://opengameart.org/content/red-eclipse-sounds | CC BY-SA 3.0 | 40 Hz high-pass |
| explosion_small | "Explosions" (`explosion1_0.ogg`) | EZduzziteh | https://opengameart.org/content/explosions-4 | CC0 | trimmed to 2.5 s, fade-out |
| explosion_large | "Chunky Explosion" | Joth | https://opengameart.org/content/chunky-explosion | CC0 | trimmed to 3.5 s, fade-out |
| explosion_huge | "Imitatie van een atoomexplosie" (Geluid van Nederland) + "75 CC0 breaking / falling / hit sfx" (`bfh1_rock_*`, `bfh1_falling_02`) | Beeld en Geluid (Netherlands Institute for Sound and Vision); rubberduck | https://commons.wikimedia.org/wiki/File:Imitatie_van_een_atoomexplosie_-_SoundCloud_-_Beeld_en_Geluid.ogg ; https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx | CC BY-SA 3.0 (+ CC0 layers) | first blast + roar from 22 s, layered with falling-rock debris |
| cannon_tank | "Battle at sea", `cannon_fire_1.ogg` | Thimras | https://opengameart.org/content/battle-at-sea | CC0 | +4 dB bass, trimmed to 2.5 s |
| cannon_small | "25 CC0 bang / firework SFX", `cannon_02.ogg` | rubberduck | https://opengameart.org/content/25-cc0-bang-firework-sfx | CC0 | 60 Hz high-pass |
| cannon_distant | "Battle at sea", `cannon_fire_1.ogg` | Thimras | https://opengameart.org/content/battle-at-sea | CC0 | double 450 Hz low-pass, multi-tap echo (distance), bass boost |
| shell_incoming | none | - | - | synthesised | **synthesised**: descending sine whistle (~1.45 kHz down) + band-passed noise + low rush, rising amplitude |
| mortar_launch | Red Eclipse sounds, `weapons/grenade/primary.ogg` | Red Eclipse team | https://opengameart.org/content/red-eclipse-sounds | CC BY-SA 3.0 | +5 dB bass, 5 kHz low-pass, low-passed echo tail added |
| ricochet | "100 CC0 metal and wood SFX", `metal_hit_02.ogg` (impact) | rubberduck | https://opengameart.org/content/100-cc0-metal-and-wood-sfx | CC0 | **partially synthesised**: real metal-hit transient + synthesised falling whine (3.9 kHz to 1.3 kHz sweep + noise) |
| bullet_flyby | Red Eclipse sounds, `weapons/rifle/transit.ogg` | Red Eclipse team | https://opengameart.org/content/red-eclipse-sounds | CC BY-SA 3.0 | **partially synthesised**: synthesised N-wave crack + noise whizz, with the Red Eclipse transit layer underneath |
| bullet_impact | "75 CC0 breaking / falling / hit sfx" (`bfh1_hit_02`, `bfh1_rock_falling_04`); Red Eclipse `sfx/debris2.ogg` | rubberduck; Red Eclipse team | https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx ; https://opengameart.org/content/red-eclipse-sounds | CC0 + CC BY-SA 3.0 | layered thud + debris + high-passed grit spray |
| metal_hit | "Metal Impact Sounds" `bing1.wav`; "100 CC0 metal and wood SFX" `metal_hit_04.ogg` | Brian MacIntosh (BMacZero); rubberduck | https://opengameart.org/content/metal-impact-sounds ; https://opengameart.org/content/100-cc0-metal-and-wood-sfx | CC0 | two hits layered |
| splash_big | "Tiny Naval Battle Sounds Set", `WaterSurfaceExplosion02.wav` | Iwan Gabovitch (qubodup) | https://opengameart.org/content/tiny-naval-battle-sounds-set | CC0 | normalised |
| splash_small | "6 Short water splashes", `water_splash-04.flac` | ezwa | https://opengameart.org/content/6-short-water-splashes | CC0 | trimmed to 1.2 s |
| wading | Red Eclipse `player/swimstep*.ogg`; "100 CC0 SFX #2" `footstep_wet_0*.ogg`; "40 CC0 water / splash / slime SFX" `loop_water_02.ogg` | Red Eclipse team; rubberduck | https://opengameart.org/content/red-eclipse-sounds ; https://opengameart.org/content/100-cc0-sfx-2 ; https://opengameart.org/content/40-cc0-water-splash-slime-sfx | CC BY-SA 3.0 + CC0 | 6 s loop: three "walkers" of wet steps at different cadences over a water-slosh bed (wrap-around placement, so the loop is seamless) |
| engine_lvt | "Sherman tank, rijden, stationair en stoppen" (Geluid van Nederland) | Beeld en Geluid | https://commons.wikimedia.org/wiki/File:Sherman_tank,_rijden,_stationair_en_stoppen_-_SoundCloud_-_Beeld_en_Geluid.ogg | CC BY-SA 3.0 | idle section (from 60 s) sped up 15 % (higher RPM, radial engine like the LVT), level-flattened, 6 s crossfade loop |
| engine_tank | "Sherman tank, rijden, stationair en stoppen" (Geluid van Nederland) | Beeld en Geluid | (same as above) | CC BY-SA 3.0 | close moving section (~38 s) with track squeal/clank, level-flattened, 6 s crossfade loop |
| engine_boat | "WWS MSThti" (motorboat Tähti engine) | Work With Sounds / Werstas | https://commons.wikimedia.org/wiki/File:WWS_MSThti.ogg | CC BY 4.0 | steady section, 6 s crossfade loop |
| ramp_drop | "Omlaag brengen van een hefbrug en het stoten van oprijplaten" (Geluid van Nederland); "100 CC0 metal and wood SFX" `metal_slam_01`; "Tiny Naval Battle Sounds Set" `Splash.wav` | Beeld en Geluid; rubberduck; qubodup | https://commons.wikimedia.org/wiki/File:Omlaag_brengen_van_een_hefbrug_en_het_stoten_van_oprijplaten_-_SoundCloud_-_Beeld_en_Geluid.ogg ; https://opengameart.org/content/100-cc0-metal-and-wood-sfx ; https://opengameart.org/content/tiny-naval-battle-sounds-set | CC BY-SA 3.0 + CC0 | steel ramp-plate clang + metal slam pitched down ~10 semitones with bass + quiet splash |
| surf | "Ocean Waves on a Tropical Beach"; "Beach Ocean Waves" (4 waves) | Jarrod Stanley (J.D. Savanyu); jasinski | https://commons.wikimedia.org/wiki/File:Ocean_Waves_on_a_Tropical_Beach.ogg ; https://opengameart.org/content/beach-ocean-waves | CC0 | 18 s loop: crossfaded bed from 86.5 s + 4 breaking waves placed wrap-around |
| wind | "wind1"; "Mild Wind Background Noise" | Luke.RUSTLTD; Bashar3A (Skirmish.io) | https://opengameart.org/content/wind1 ; https://opengameart.org/content/mild-wind-background-noise | CC0 | two winds mixed, 18 s crossfade loop |
| battle_distant | Free Firearm Sound Library mid-distance shots/bursts (1917, Arisaka, Mosin, AK-47, PPSh, M45); "Battle at sea" `cannon_fire_1`; "Chunky Explosion"; "Muffled Distant Explosion"; "low rumbling" | FFSL team; Thimras; Joth; NenadSimic; Musheran | https://opengameart.org/content/the-free-firearm-sound-library ; https://opengameart.org/content/battle-at-sea ; https://opengameart.org/content/chunky-explosion ; https://opengameart.org/content/muffled-distant-explosion ; https://opengameart.org/content/low-rumbling | CC0 | 20 s composite: ~70 low-passed gunshots + 6 low-passed booms randomly placed (wrap-around), rumble bed, light echo |
| night_insects | "Crickets Ambient Noise - loopable"; "cricket sounds"; "Bird, cricket, frog and mosquito sounds" (`frog.wav`) | Wolfgang_ (Ted Kerr); syncopika; Aj_ | https://opengameart.org/content/crickets-ambient-noise-loopable ; https://opengameart.org/content/cricket-sounds ; https://opengameart.org/content/birdcricketfrog-and-mosquito-sounds | CC0 | two cricket beds mixed + sparse frog calls, 18 s crossfade loop |
| flare | "Signaalpistool, een schot" (Geluid van Nederland); "Flare ignition"; "Fire Crackling" | Beeld en Geluid; qubodup; AntumDeluge | https://commons.wikimedia.org/wiki/File:Signaalpistool,_een_schot_-_SoundCloud_-_Beeld_en_Geluid.ogg ; https://opengameart.org/content/flare-ignition ; https://opengameart.org/content/fire-crackling | CC BY-SA 3.0 + CC0 | signal-pistol pop + ignition + high-passed fizz tail |
| plane_flyby | "Spitfire fly past at RAF Halton" | LouiseBrown1981 | https://commons.wikimedia.org/wiki/File:Spitfire_fly_past_at_RAF_Halton.ogg | CC BY-SA 3.0 | 9 s Merlin-engine section re-rendered as a close pass: Doppler time-warp, distance gain and distance low-pass |
| ui_click | Kenney "Interface Sounds", `click_001.ogg` | Kenney (kenney.nl) | https://opengameart.org/content/interface-sounds | CC0 | peak -3 dBFS |
| ui_select | Kenney "Interface Sounds", `confirmation_003.ogg` | Kenney (kenney.nl) | https://opengameart.org/content/interface-sounds | CC0 | peak -3 dBFS |
| radio_squelch | "Radio Noise 1" (`radio_noise_loop.wav`); Kenney "UI SFX Set" `switch3.wav` | Kresiek The Furry; Kenney | https://opengameart.org/content/radio-noise-1 ; https://opengameart.org/content/51-ui-sound-effects-buttons-switches-and-clicks | CC0 | 0.36 s band-passed (400 Hz-3.2 kHz) noise burst framed by two switch clicks |
| whistle | "218318 splicesound referee-whistle-blow-gymnasium" | SpliceSound | https://commons.wikimedia.org/wiki/File:218318_splicesound_referee-whistle-blow-gymnasium.wav | CC0 | trimmed to 2 s, peak -4 dBFS |
| reload | "Magazijn laden en het vergrendelen van een geweer" (Geluid van Nederland) | Beeld en Geluid | https://commons.wikimedia.org/wiki/File:Magazijn_laden_en_het_vergrendelen_van_een_geweer_-_SoundCloud_-_Beeld_en_Geluid.ogg | CC BY-SA 3.0 | magazine insert (1.84 s) + bolt close (4.06 s) joined, 80 Hz high-pass |
| garand_ping | "31 pings and metal filing sounds", Marker #26 | bart | https://opengameart.org/content/31-pings-and-metal-filing-sounds | CC0 | 800 Hz high-pass, trimmed |
| debris | "75 CC0 breaking / falling / hit sfx" (`bfh1_rock_falling_01/03/05/08/09`) | rubberduck | https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx | CC0 | 5 falling-rock clips staggered and fading, 6 kHz low-pass |
| bugle | "Attention Bugle Call (US)" | U.S. Army Ceremonial Band | https://commons.wikimedia.org/wiki/File:Attention_Bugle_Call_(US).oga | PD (US Government work) | trimmed |

## Attribution summary (for an in-game credits screen)

- Sound recordings from **Beeld en Geluid / Geluid van Nederland** (Netherlands Institute for Sound and Vision), via Wikimedia Commons, CC BY-SA 3.0: Sherman tank, lift-bridge ramp, signal pistol, rifle magazine/bolt, "atomic explosion" imitation.
- **Red Eclipse** game sounds (Red Eclipse team: Quinton "quin" Reeves, Alex "blackshoe" Anguix et al.), CC BY-SA 3.0.
- **LouiseBrown1981**, "Spitfire fly past at RAF Halton", Wikimedia Commons, CC BY-SA 3.0.
- **Work With Sounds / Werstas**, "MS Tähti" motorboat engine, Wikimedia Commons, CC BY 4.0.
- CC0 / public domain (credit not required, given with thanks): The Free Firearm Sound Library, Thimras, rubberduck, Joth, EZduzziteh, qubodup (Iwan Gabovitch), ezwa, Brian MacIntosh, bart, Kenney, SpliceSound, Jarrod Stanley, jasinski, Luke.RUSTLTD, Bashar3A, Wolfgang_ (Ted Kerr), syncopika, Aj_, NenadSimic, Musheran, AntumDeluge, Kresiek The Furry, U.S. Army Ceremonial Band.

Licence texts: CC BY-SA 3.0 https://creativecommons.org/licenses/by-sa/3.0/ ; CC BY 4.0 https://creativecommons.org/licenses/by/4.0/ ; CC0 https://creativecommons.org/publicdomain/zero/1.0/
