# Tarawa 1943

A real-time, Close Combat–style tactical game of the Battle of Tarawa (Operation GALVANIC, 20–28 November 1943), rendered with **WebGPU**. It plays with mouse and keyboard on desktop and with touch on iPad. You command the 2nd Marine Division; the computer commands the Japanese defenders.

## Run it

```bash
node serve.mjs            # http://localhost:8080  (desktop Chrome / Edge / Safari 26+)
node serve.mjs --https    # https://<your-mac-ip>:8443  for an iPad on the same network
```

There is no build step and nothing to install: plain ES modules plus WGSL shaders.

On iPad you need **Safari on iPadOS 26 or later** (which has WebGPU). The page must be served over **HTTPS**: `--https` generates a self-signed certificate, and Safari asks you to accept it once. Any static HTTPS host, such as GitHub Pages, also works.

## The campaign

The **atoll map** is a zoomable strategic view of all of Tarawa: Betio, Bairiki, Eita, Bonriki, the eastern chain, Buariki and Naa. Historical notes are attached to the islets.

| # | Battle | What it models |
|---|---|---|
| 1 | **Red Beach — D-Day** (20 Nov, 0910) | Amtracs (LVT-1/LVT-2) cross the reef. Higgins boats ground on it at the "dodging tide", so their Marines wade 400 m under fire. Also: Hawkins' scout-snipers at the long pier, Shoup's command post, Shermans landed from LCMs, the *Saida Maru* hulk, the Pocket, and Shibasaki's blockhouse. |
| 2 | **Green Beach** (21 Nov) | Maj. Ryan's scratch battalion with a working naval gunfire radio clears the west shore. 1/6 Marines then land in rubber boats. |
| 3 | **Bonnyman's Bombproof** (22 Nov) | Engineers storm the sand-covered bombproof and the steel pillbox, supported by Sherman "Colorado". The garrison sallies out to retake the summit. |
| 4 | **The Night Counterattack** (22–23 Nov) | 1/6 Marines hold a line across the island against probes and then massed banzai charges. Star shells and destroyer fire are on call. |
| 5 | **Buariki — Last Stand** (27 Nov) | Jungle fighting at 30 m sight lines against the last garrison. |

## How it plays

- **Teams of 2–10 men.** Every soldier is simulated individually, with a name, rank and weapon: M1, BAR, Thompson, carbine, M1919 MG, bazooka, flamethrower, 60 mm mortar, satchel charges, grenades, Arisaka, Type 96/92/93 MGs, knee mortars, 37 mm and 75 mm guns, and coastal guns.
- **Line of sight and cover come from a real heightfield.** The seawall, craters (new ones are blasted during play), trenches, wrecks, foxholes and buildings all block fire. A man behind the seawall must rise to shoot over it. Wading Marines are only partly exposed above the water.
- **Suppression and morale.** Men under fire become *suppressed*, then *pinned*, then *cowering*; Marines with broken morale *panic*. Leaders, cover and time restore morale. Japanese units may go *berserk* and charge.
- **Fortifications** can only see through their embrasures, and they are camouflaged until spotted. Suppress them from the front, then order engineers to **Assault**: they work round to the blind side to use the flamethrower ("blowtorch") and satchel charges ("corkscrew").
- **Water and tide.** Boats ground on the reef. Amtracs climb onto the beach but are stopped by the seawall except where it has gaps. Tanks wade in from the reef edge.
- **Japanese AI.** Defenders hold fire until the range is short. Reserves sneak forward to threatened sectors. The AI launches local counterattacks against pinned Marines, makes tank sorties, fires pre-registered barrages on the reef, and orders banzai charges.
- **Fire support** (naval gunfire, Hellcat strafing runs, star shells) needs a team ashore with a working radio.
- **Fog of war.** You only see enemies your men have spotted. Fading markers show their last known positions.

## Controls

| | Desktop | iPad |
|---|---|---|
| Select | click, box-drag, Shift adds, Tab cycles | tap a soldier or a unit card; long-press adds |
| Orders | right-click opens the order menu (line-of-sight readout shown); hotkeys M R C F G Q E Z U X | tap ground or an enemy to open the order menu, or tap an order bar button and then the target |
| Camera | wheel or +/− zoom (close enough to see each Marine), right-drag / WASD / arrows to pan | pinch, drag |
| Time | Space pause; 1/2/3 select 1×/2×/4× | buttons in the top bar |

## Audio

- **Sound effects** come from CC0, CC-BY and CC-BY-SA sources (OpenGameArt, Wikimedia Commons, Kenney). See `assets/sfx/CREDITS.md`; the credits are also shown in-game.
- **Voices** (orders, warnings, radio traffic, Japanese shouts, narration) were generated locally with the open-weights **Kokoro-82M** TTS model (Apache-2.0). Radio lines get a band-pass "radio" filter at runtime. To regenerate them, run `tools/gen_voices.py`; it lists its requirements at the top.

## Code map

```
src/world/   terrain grid + LOS/cover, Betio / Buariki / atoll generators
src/sim/     game state, combat, vehicles, Japanese AI, pathfinding (A*), scenarios, unit data
src/gpu/     WebGPU renderer, WGSL shaders (procedural terrain/water, SDF sprites, decals), particles
src/ui/      HUD, overlay (objectives, orders, LOS tool), audio in src/audio/
```
