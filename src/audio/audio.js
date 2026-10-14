// WebAudio engine: positional SFX relative to the camera, ambience loops, engine loops,
// voice queue (unit shouts + radio traffic through a band-pass "radio" chain), synthesised fallbacks.

export class Audio {
  constructor() {
    this.ctx = null; this.buffers = {}; this.voices = {}; this.manifest = null; this.voiceManifest = null;
    this.enabled = true; this.volume = 0.8; this.voiceVol = 1; this.sfxVol = 0.85;
    this.playing = {}; this.loops = {}; this.voiceBusyUntil = 0; this.voiceQueue = [];
    this.listener = { x: 0, y: 0, zoom: 1 };
    this.lastWhiz = 0;
    this.engineSlots = [];
  }
  init() { return (this._initP ??= this._init()); }
  async _init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    const c = this.ctx;
    this.master = c.createGain(); this.master.gain.value = this.volume;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 5; comp.attack.value = 0.004; comp.release.value = 0.2;
    this.master.connect(comp).connect(c.destination);
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
    await Promise.all(sfxIds.map(async (id) => { const b = await load(`assets/sfx/${id}.mp3`); this.buffers[id] = b || this.synth(id); }));
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
  play(id, x, y, vol = 1, rate = 1, bus = null) {
    if (!this.live || !this.enabled) return null;
    const b = this.buffers[id];
    if (!b) return null;
    const { g, pan, d, ref } = this.spatial(x, y);
    const gain = vol * g;
    if (gain < 0.012) return null;
    // per-id polyphony limit
    const now = this.ctx.currentTime;
    const list = (this.playing[id] = (this.playing[id] || []).filter(e => e.end > now));
    const limit = id.startsWith('rifle') ? 7 : id.startsWith('mg') ? 5 : 4;
    if (list.length >= limit) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = b; src.playbackRate.value = rate;
    const gn = this.ctx.createGain(); gn.gain.value = gain;
    let node = src.connect(gn);
    // distant sounds get duller
    if (d !== undefined && d > ref * 0.8) {
      const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = Math.max(700, 9000 * ref / d);
      node = node.connect(f);
    }
    if (this.ctx.createStereoPanner) { const p = this.ctx.createStereoPanner(); p.pan.value = pan; node = node.connect(p); }
    node.connect(bus || this.sfxBus);
    src.start();
    list.push({ end: now + b.duration / rate });
    return src;
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
  whiz(x, y) {
    const now = this.ctx ? this.ctx.currentTime : 0;
    if (now - this.lastWhiz < 0.35) return;
    const { g } = this.spatial(x, y);
    if (g < 0.5) return;
    this.lastWhiz = now;
    this.play(Math.random() < 0.8 ? 'bullet_flyby' : 'ricochet', x, y, 0.35, 0.9 + Math.random() * 0.25);
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
