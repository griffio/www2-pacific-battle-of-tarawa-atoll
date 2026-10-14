// WebAudio engine: positional SFX relative to the camera, ambience loops, engine loops,
// voice queue (unit shouts + radio traffic through a band-pass "radio" chain), synthesised fallbacks.
// Weapons and explosions get recorded variants, an outdoor reverb send that grows with distance, speed-of-sound
// delay, a sub-bass thump, falling debris and, when close, a brief "shell-shock" muffle (see PROFILE).

// rev: reverb send; thump: sub-bass layer; debris: falling debris after the blast; shock: muffle + camera shake when close
const PROFILE = {
  rifle_us: { rev: 0.2 }, rifle_jp: { rev: 0.2 }, carbine: { rev: 0.17 }, smg: { rev: 0.16 }, bar: { rev: 0.22 },
  mg_us: { rev: 0.24 }, mg_jp: { rev: 0.24 }, mg_50: { rev: 0.28, thump: 0.12 },
  cannon_small: { rev: 0.32, thump: 0.25 }, cannon_tank: { rev: 0.38, thump: 0.5, shock: 0.2 }, cannon_field: { rev: 0.38, thump: 0.5, shock: 0.2 },
  cannon_heavy: { rev: 0.5, thump: 0.9, shock: 0.55 }, cannon_distant: { rev: 0.22, thump: 0.2 },
  bazooka: { rev: 0.28 }, mortar_launch: { rev: 0.22, thump: 0.18 }, flamethrower: { rev: 0.1 },
  grenade: { rev: 0.32, thump: 0.4, shock: 0.3 }, explosion_small: { rev: 0.38, thump: 0.55, shock: 0.4 },
  explosion_large: { rev: 0.48, thump: 0.85, debris: 0.45, shock: 0.7 }, explosion_huge: { rev: 0.55, thump: 1, debris: 0.75, shock: 1 },
  splash_big: { rev: 0.3, thump: 0.45, shock: 0.3 }, plane_flyby: { rev: 0.15 },
};
const SPEED_OF_SOUND = 343;

export class Audio {
  constructor() {
    this.ctx = null; this.buffers = {}; this.voices = {}; this.manifest = null; this.voiceManifest = null;
    this.enabled = true; this.volume = 0.8; this.voiceVol = 1; this.sfxVol = 0.85;
    this.playing = {}; this.loops = {}; this.voiceBusyUntil = 0; this.voiceQueue = [];
    this.listener = { x: 0, y: 0, zoom: 1 };
    this.lastWhiz = 0; this.lastImpact = 0;
    this.engineSlots = [];
    this.vars = {}; this.lastVar = {};
    this.onShock = null;          // (intensity 0..1) => camera shake, set by the app
  }
  init() { return (this._initP ??= this._init()); }
  async _init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    const c = this.ctx;
    this.master = c.createGain(); this.master.gain.value = this.volume;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 5; comp.attack.value = 0.004; comp.release.value = 0.2;
    // "shell-shock" muffle: a master low-pass that a close blast sweeps down and lets recover
    this.muffle = c.createBiquadFilter(); this.muffle.type = 'lowpass'; this.muffle.frequency.value = 20000; this.muffle.Q.value = 0.5;
    // brick-wall-ish limiter after the glue compressor: stacked explosions must never clip
    const lim = c.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.12;
    this.master.connect(this.muffle).connect(comp).connect(lim).connect(c.destination);
    this.out = lim;
    // outdoor reverb: early reflections off dunes, palms and bunkers + a diffuse tail
    this.revIn = c.createGain();
    const conv = c.createConvolver(); conv.buffer = this.impulse(2.4);
    const revOut = c.createGain(); revOut.gain.value = 0.9;
    this.revIn.connect(conv).connect(revOut).connect(this.master);
    this.sfxBus = c.createGain(); this.sfxBus.gain.value = this.sfxVol; this.sfxBus.connect(this.master);
    this.voiceBus = c.createGain(); this.voiceBus.gain.value = this.voiceVol; this.voiceBus.connect(this.master);
    this.ambBus = c.createGain(); this.ambBus.gain.value = 0.5; this.ambBus.connect(this.master);
    // radio chain
    this.radioIn = c.createGain();
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 380;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2900;
    const peak = c.createBiquadFilter(); peak.type = 'peaking'; peak.frequency.value = 1500; peak.gain.value = 6;
    const sh = c.createWaveShaper(); sh.curve = this.distCurve(18);
    const rg = c.createGain(); rg.gain.value = 0.85;
    this.radioIn.connect(hp).connect(lp).connect(peak).connect(sh).connect(rg).connect(this.voiceBus);
    await this.loadAll();
  }
  impulse(dur) {
    const c = this.ctx, sr = c.sampleRate, n = Math.floor(sr * dur);
    const b = c.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        // diffuse tail: noise, decaying ~1.9 s RT60, losing highs as it goes
        const k = 0.5 - 0.42 * Math.min(1, t / dur);
        lp += ((Math.random() * 2 - 1) - lp) * k;
        d[i] = lp * Math.exp(-t * 3.6) * Math.min(1, t / 0.03) * 0.5;
      }
      // early reflections (slap-back off nearby cover)
      for (let r = 0; r < 14; r++) {
        const t = 0.012 + Math.random() * 0.16, i = Math.floor(t * sr);
        const a = (0.5 + Math.random() * 0.5) * Math.exp(-t * 9) * (Math.random() < 0.5 ? -1 : 1);
        for (let j = 0; j < 40 && i + j < n; j++) d[i + j] += a * Math.exp(-j / 6);
      }
    }
    return b;
  }
  distCurve(k) {
    const n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i * 2 / n - 1; curve[i] = (1 + k) * x / (1 + k * Math.abs(x)); }
    return curve;
  }
  resume() { if (this.ctx && this.ctx.state !== 'running' && !document.hidden) this.ctx.resume().catch(() => { }); }
  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => { }); }
  get live() { return this.ctx && this.ctx.state === 'running'; }

  async loadAll() {
    try { this.manifest = await (await fetch('assets/sfx/manifest.json')).json(); } catch { this.manifest = {}; }
    try { this.voiceManifest = await (await fetch('assets/voice/manifest.json')).json(); } catch { this.voiceManifest = { lines: [] }; }
    const load = async (url) => {
      try {
        const r = await fetch(url);
        if (!r.ok) return null;
        const ab = await r.arrayBuffer();
        return await new Promise((res) => this.ctx.decodeAudioData(ab, res, () => res(null)));
      } catch { return null; }
    };
    const sfxIds = Object.keys(this.manifest).filter(k => !k.startsWith('_'));
    await Promise.all(sfxIds.map(async (id) => {
      const n = this.manifest[id].variants || 1;
      const bs = (await Promise.all(Array.from({ length: n }, (_, i) => load(`assets/sfx/${id}${i ? '_' + (i + 1) : ''}.mp3`)))).filter(Boolean);
      this.vars[id] = bs.length ? bs : [this.synth(id)];
      this.buffers[id] = this.vars[id][0];
    }));
    this.lines = {};
    for (const l of this.voiceManifest.lines || []) this.lines[l.id] = l;
    await Promise.all((this.voiceManifest.lines || []).map(async (l) => { const b = await load(`assets/voice/${l.id}.mp3`); if (b) this.voices[l.id] = b; }));
  }

  // ------------------------------------------------ procedural fallbacks
  synth(id) {
    const c = this.ctx, sr = c.sampleRate;
    const mk = (dur, fn) => { const n = Math.floor(sr * dur), b = c.createBuffer(1, n, sr), d = b.getChannelData(0); for (let i = 0; i < n; i++) d[i] = fn(i / sr, i); return b; };
    const noise = () => Math.random() * 2 - 1;
    let lp = 0;
    const shot = (dur, decay, tone) => mk(dur, (t) => { lp += (noise() - lp) * tone; return lp * Math.exp(-t * decay) * 1.6; });
    const burst = (n, gap, decay, tone) => mk(n * gap + 0.4, (t) => { const k = t % gap; lp += (noise() - lp) * tone; return t < n * gap ? lp * Math.exp(-k * decay) * 1.4 : lp * Math.exp(-(t - n * gap) * 12) * 0.3; });
    const boom = (dur, decay) => mk(dur, (t) => { lp += (noise() - lp) * 0.05; return lp * Math.exp(-t * decay) * 3.2; });
    const loopNoise = (dur, tone, amp, mod) => mk(dur, (t) => { lp += (noise() - lp) * tone; return lp * amp * (1 + 0.3 * Math.sin(t * mod * 6.28)); });
    switch (id) {
      case 'rifle_us': case 'rifle_jp': return shot(0.5, 14, 0.5);
      case 'smg': return burst(5, 0.075, 40, 0.6);
      case 'bar': return burst(5, 0.11, 30, 0.45);
      case 'mg_us': return burst(10, 0.1, 30, 0.45);
      case 'mg_jp': return burst(10, 0.13, 30, 0.5);
      case 'mg_50': return burst(8, 0.12, 18, 0.3);
      case 'grenade': case 'explosion_small': return boom(1.4, 4);
      case 'explosion_large': case 'cannon_distant': return boom(2.5, 2.2);
      case 'explosion_huge': return boom(3.5, 1.4);
      case 'cannon_tank': case 'cannon_small': case 'bazooka': return boom(1.2, 5);
      case 'surf': return loopNoise(6, 0.06, 0.4, 0.12);
      case 'wind': return loopNoise(6, 0.02, 0.5, 0.2);
      case 'battle_distant': return mk(8, (t) => { lp += (noise() - lp) * 0.04; const pop = Math.random() < 0.0004 ? 6 : 1; return lp * 0.5 * pop * (0.5 + 0.5 * Math.sin(t * 1.3)); });
      case 'engine_lvt': case 'engine_tank': case 'engine_boat': return mk(2, (t) => Math.sin(t * 6.28 * 48) * 0.3 * (0.7 + 0.3 * Math.sin(t * 6.28 * 7)) + noise() * 0.05);
      case 'shell_incoming': return mk(1.4, (t) => Math.sin(6.28 * (1400 - t * 700) * t) * 0.2 * Math.min(1, t * 3));
      case 'ui_click': case 'ui_select': return mk(0.05, (t) => Math.sin(t * 6.28 * 1200) * Math.exp(-t * 80) * 0.3);
      case 'radio_squelch': return mk(0.25, () => noise() * 0.25);
      default: return shot(0.3, 20, 0.6);
    }
  }

  // ------------------------------------------------ playback
  setListener(x, y, zoom, viewW) { this.listener.x = x; this.listener.y = y; this.listener.zoom = zoom; this.listener.viewW = viewW; }
  spatial(x, y) {
    if (x === undefined) return { g: 1, pan: 0 };
    const L = this.listener;
    const dx = x - L.x, dy = y - L.y;
    const d = Math.hypot(dx, dy);
    // hearing radius scales with zoom: zoomed in → focused on nearby action
    const ref = Math.max(60, (L.viewW || 1000) / (L.zoom || 1) * 0.45);
    const g = 1 / (1 + (d / ref) * (d / ref) * 1.4);
    const pan = Math.max(-0.85, Math.min(0.85, dx / (ref * 1.5)));
    return { g, pan, d, ref };
  }
  pickVariant(id) {
    const v = this.vars[id];
    if (!v || v.length < 2) return this.buffers[id];
    let i = (Math.random() * v.length) | 0;
    if (i === this.lastVar[id]) i = (i + 1) % v.length;   // never the same take twice running
    this.lastVar[id] = i;
    return v[i];
  }
  play(id, x, y, vol = 1, rate = 1, bus = null) {
    if (!this.live || !this.enabled) return null;
    const b = this.pickVariant(id);
    if (!b) return null;
    const { g, pan, d, ref } = this.spatial(x, y);
    const P = PROFILE[id];
    const gain = vol * g;
    // reverb carries further than the dry sound: distant fire is heard mostly as its echo
    const wet = P && P.rev ? vol * P.rev * Math.sqrt(g) * (0.6 + 0.8 * Math.min(1.5, (d || 0) / (ref || 1))) : 0;
    if (gain < 0.012 && wet < 0.012) return null;
    // per-id polyphony limit
    const now = this.ctx.currentTime;
    const list = (this.playing[id] = (this.playing[id] || []).filter(e => e.end > now));
    const limit = id.startsWith('rifle') ? 7 : id.startsWith('mg') ? 5 : 4;
    if (list.length >= limit) return null;
    const c = this.ctx;
    // sound travels at 343 m/s: far guns flash before they are heard (capped so play stays readable)
    const delay = P && d > 40 ? Math.min(1.2, (d - 40) / SPEED_OF_SOUND) : 0;
    const at = now + delay;
    const src = c.createBufferSource();
    src.buffer = b; src.playbackRate.value = rate;
    const gn = c.createGain(); gn.gain.value = gain;
    let node = src.connect(gn);
    // distant sounds get duller (air absorption)
    if (d !== undefined && d > ref * 0.6) {
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = Math.max(550, 9000 * ref / d);
      node = node.connect(f);
    }
    let p = null;
    if (c.createStereoPanner) { p = c.createStereoPanner(); p.pan.value = pan; node = node.connect(p); }
    node.connect(bus || this.sfxBus);
    if (wet > 0.004) { const sg = c.createGain(); sg.gain.value = wet; (p || gn).connect(sg).connect(this.revIn); }
    src.start(at);
    list.push({ end: at + b.duration / rate });
    if (P) this.layers(P, vol, g, pan, at, x, y, rate);
    return src;
  }
  // sub-bass thump, debris rain and close-blast shell-shock for heavy weapons and explosions
  layers(P, vol, g, pan, at, x, y, rate) {
    const c = this.ctx;
    if (P.thump && g * vol * P.thump > 0.03) {
      const o = c.createOscillator(), og = c.createGain();
      const len = 0.45 + P.thump * 0.8;
      o.type = 'sine';
      o.frequency.setValueAtTime(62 / Math.max(0.7, rate), at); o.frequency.exponentialRampToValueAtTime(29, at + len * 0.8);
      const lvl = Math.min(1.1, vol * P.thump * Math.pow(g, 0.7) * 1.1);
      og.gain.setValueAtTime(0.0001, at); og.gain.exponentialRampToValueAtTime(lvl, at + 0.012); og.gain.exponentialRampToValueAtTime(0.0001, at + len);
      o.connect(og).connect(this.sfxBus); o.start(at); o.stop(at + len + 0.05);
    }
    if (P.debris && g > 0.15) {
      const t = at + 0.35 + Math.random() * 0.5, b = this.buffers.debris;
      if (b) {
        const s = c.createBufferSource(), sg = c.createGain(); s.buffer = b; s.playbackRate.value = 0.85 + Math.random() * 0.3;
        sg.gain.value = vol * P.debris * g * 0.8;
        let n = s.connect(sg);
        if (c.createStereoPanner) { const pp = c.createStereoPanner(); pp.pan.value = pan; n = n.connect(pp); }
        n.connect(this.sfxBus); s.start(t);
      }
    }
    const k = P.shock ? P.shock * vol * g : 0;
    if (k > 0.3) {
      const now = c.currentTime, f = this.muffle.frequency, depth = Math.min(1, (k - 0.3) / 0.7);
      f.cancelScheduledValues(now); f.setValueAtTime(f.value, now);
      f.setValueAtTime(f.value, at); f.exponentialRampToValueAtTime(Math.max(380, 2600 * (1 - depth)), at + 0.03);
      f.exponentialRampToValueAtTime(20000, at + 0.6 + depth * 1.6);
      const dk = this.ambBus.gain; dk.cancelScheduledValues(now); dk.setValueAtTime(dk.value, at); dk.linearRampToValueAtTime(0.5 * (1 - depth * 0.7), at + 0.05); dk.linearRampToValueAtTime(0.5, at + 1.5 + depth);
      if (this.onShock) setTimeout(() => this.onShock(Math.min(1, k)), Math.max(0, (at - now) * 1000));
    }
  }
  ui(id) { this.play(id, undefined, undefined, 0.5); }

  // ------------------------------------------------ voices
  voice(id, x, y, opts = {}) {
    if (!this.live) return;
    const now = this.ctx.currentTime;
    const radio = !!opts.radio;
    const prio = opts.prio || 1;
    if (!radio && x !== undefined) {
      const { g } = this.spatial(x, y);
      if (g < 0.06) return;
    }
    if (this.voiceBusyUntil > now + (radio ? 6 : 0.4)) {
      if (radio || prio >= 2) { if (this.voiceQueue.length < 4) this.voiceQueue.push({ id, x, y, opts, at: now }); }
      return;
    }
    this.playVoice(id, x, y, radio);
  }
  playVoice(id, x, y, radio) {
    const c = this.ctx, now = c.currentTime;
    const b = this.voices[id];
    let dur = 1.2;
    if (radio) {
      const sq = this.buffers.radio_squelch;
      if (sq) { const s = c.createBufferSource(); s.buffer = sq; const g = c.createGain(); g.gain.value = 0.5; s.connect(g).connect(this.voiceBus); s.start(now); }
    }
    if (b) {
      const src = c.createBufferSource(); src.buffer = b;
      const gn = c.createGain();
      if (radio) { gn.gain.value = 1.0; src.connect(gn).connect(this.radioIn); }
      else {
        const { g, pan } = this.spatial(x, y);
        gn.gain.value = Math.min(1.2, 0.35 + g * 1.0);
        let node = src.connect(gn);
        if (c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = pan * 0.6; node = node.connect(p); }
        node.connect(this.voiceBus);
      }
      src.start(now + (radio ? 0.12 : 0));
      dur = b.duration + (radio ? 0.3 : 0.15);
    } else if (window.speechSynthesis && this.lines && this.lines[id]) {
      // fallback: browser speech synthesis
      const l = this.lines[id];
      const u = new SpeechSynthesisUtterance(l.role === 'jp' ? (l.romaji || l.text) : l.text);
      u.rate = 1.1; u.volume = 0.8; if (l.role === 'jp') u.lang = 'ja-JP';
      speechSynthesis.speak(u);
      dur = 1.5;
    }
    this.voiceBusyUntil = now + dur;
  }
  narrate(id) {
    if (!this.ctx) return null;
    const b = this.voices[id];
    if (!b) return null;
    this.stopNarration();
    const src = this.ctx.createBufferSource(); src.buffer = b;
    const g = this.ctx.createGain(); g.gain.value = 1;
    src.connect(g).connect(this.voiceBus); src.start();
    this.narration = src;
    src.onended = () => { if (this.narration === src) this.narration = null; };
    return b.duration;
  }
  stopNarration() { if (this.narration) { try { this.narration.stop(); } catch { } this.narration = null; } }
  update() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // drop stale shouts (radio traffic may wait longer)
    this.voiceQueue = this.voiceQueue.filter(v => now - v.at < (v.opts.radio ? 12 : 2.5));
    if (this.voiceQueue.length && this.voiceBusyUntil < now) {
      const v = this.voiceQueue.shift();
      this.playVoice(v.id, v.x, v.y, v.opts.radio);
    }
  }
  // rounds passing a target near the camera: supersonic cracks, machine-gun near-miss bursts, ricochets
  whiz(x, y, cls) {
    const now = this.ctx ? this.ctx.currentTime : 0;
    if (now - this.lastWhiz < 0.25) return;
    const { g } = this.spatial(x, y);
    if (g < 0.45) return;
    this.lastWhiz = now;
    const r = Math.random(), heavy = cls === 'mg' || cls === 'hmg' || cls === 'auto';
    if (heavy && r < 0.45) this.play('near_miss', x, y, 0.42, 0.95 + Math.random() * 0.1);
    else if (r < 0.85) {
      this.play('bullet_crack', x, y, 0.5, 0.85 + Math.random() * 0.3);
      if (Math.random() < 0.5) this.play('bullet_flyby', x, y, 0.22, 0.9 + Math.random() * 0.25);
    } else this.play('ricochet', x, y, 0.32, 0.9 + Math.random() * 0.25);
  }
  // bullet strikes near the camera (sand spray, splashes)
  impact(x, y, water) {
    const now = this.ctx ? this.ctx.currentTime : 0;
    if (now - this.lastImpact < 0.09 || Math.random() > 0.35) return;
    const { g } = this.spatial(x, y);
    if (g < 0.4) return;
    this.lastImpact = now;
    this.play(water ? 'splash_small' : 'bullet_impact', x, y, water ? 0.18 : 0.26, 0.85 + Math.random() * 0.35);
  }

  // ------------------------------------------------ loops
  loop(key, id, vol) {
    if (!this.ctx) return;
    let L = this.loops[key];
    if (!L) {
      const b = this.buffers[id]; if (!b) return;
      const src = this.ctx.createBufferSource(); src.buffer = b; src.loop = true;
      const g = this.ctx.createGain(); g.gain.value = 0;
      const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
      if (p) src.connect(g).connect(p).connect(key.startsWith('amb') ? this.ambBus : this.sfxBus);
      else src.connect(g).connect(key.startsWith('amb') ? this.ambBus : this.sfxBus);
      src.start(0, Math.random() * b.duration);
      L = this.loops[key] = { src, g, p, id };
    }
    L.g.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.3);
    return L;
  }
  stopLoops() {
    for (const k in this.loops) { try { this.loops[k].src.stop(); } catch { } }
    this.loops = {};
  }
  // ambient beds + the few nearest engines
  updateLoops(game) {
    if (!this.live) return;
    const L = this.listener;
    const night = game ? game.light.night || 0 : 0;
    this.loop('amb_surf', 'surf', 0.45);
    this.loop('amb_wind', 'wind', 0.22);
    if (game) {
      this.loop('amb_battle', 'battle_distant', game.ended ? 0.05 : 0.32);
      this.loop('amb_insects', 'night_insects', night * 0.25);
      // wading sound if many marines in the water near the camera
      let wading = 0;
      for (const s of game.soldiers) if (s.side === 'US' && s.moving && !s.inVeh && game.T.depthAt(s.x, s.y) > 0.3) { const sp = this.spatial(s.x, s.y); wading += sp.g; }
      this.loop('wading', 'wading', Math.min(0.5, wading * 0.08));
      const engines = [];
      for (const v of game.vehicles) {
        if (v.state === 'destroyed' || !v.spec.engine || v.carried) continue;
        if (v.side === 'JP' && v.visT[0] < game.time) continue;
        const sp = this.spatial(v.x, v.y);
        engines.push([sp.g * (0.4 + Math.min(1, v.speed / 2) * 0.6), v, sp.pan]);
      }
      engines.sort((a, b) => b[0] - a[0]);
      for (let i = 0; i < 3; i++) {
        const e = engines[i];
        const l = this.loop('eng' + i, e ? e[1].spec.engine : 'engine_lvt', e ? Math.min(0.5, e[0] * 0.5) : 0);
        if (l && e && l.id !== e[1].spec.engine) { try { l.src.stop(); } catch { } delete this.loops['eng' + i]; }
        if (l && l.p && e) l.p.pan.setTargetAtTime(e[2], this.ctx.currentTime, 0.2);
      }
    } else {
      for (const k of ['amb_battle', 'amb_insects', 'wading', 'eng0', 'eng1', 'eng2']) if (this.loops[k]) this.loops[k].g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
    }
  }
}
