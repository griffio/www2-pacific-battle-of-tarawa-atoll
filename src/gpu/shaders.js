// WGSL shaders: procedural terrain & water, SDF sprites (units, vehicles, fortifications, effects), ground decals.

const COMMON = /* wgsl */`
struct U {
  cam: vec4f,    // cx, cy, zoom (px per m), time
  view: vec4f,   // w, h, 1/w, 1/h (device px)
  map: vec4f,    // mapW, mapH, cell, water level
  amb: vec4f,    // tint rgb, ambient
  misc: vec4f,   // night, nLights, decal m/texel, quality
  sun: vec4f,    // sun dir xyz, strength
  lights: array<vec4f, 48>, // 24 lights: (x, y, radius, intensity), (r, g, b, flicker)
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(4) var noiseTex: texture_2d<f32>;   // 256x256 tileable value noise, 4 independent channels
@group(0) @binding(5) var nsamp: sampler;              // repeat addressing

fn hashu(x: u32) -> u32 {
  var v = x * 747796405u + 2891336453u;
  v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (v >> 22u) ^ v;
}
fn hash21(p: vec2f) -> f32 {
  let i = vec2i(floor(p));
  return f32(hashu((u32(i.x) * 1597334677u) ^ hashu(u32(i.y) + 1013904223u))) / 4294967295.0;
}
// Value noise from a pre-baked texture: one lattice cell per unit of p (the texture tiles every 32 units).
// (Integer hashing per pixel is slow on Apple GPUs; a filtered fetch is nearly free.)
const NS: f32 = 1.0 / 32.0;
fn vnoise(p: vec2f) -> f32 { return textureSampleLevel(noiseTex, nsamp, p * NS, 0.0).r; }
fn fbm(p: vec2f) -> f32 {
  let a = textureSampleLevel(noiseTex, nsamp, p * NS, 0.0).r;
  let b = textureSampleLevel(noiseTex, nsamp, (p * 2.03 + vec2f(1.7, 9.2)) * NS, 0.0).g;
  let c = textureSampleLevel(noiseTex, nsamp, (p * 4.12 + vec2f(5.1, 2.3)) * NS, 0.0).b;
  let d = textureSampleLevel(noiseTex, nsamp, (p * 8.36 + vec2f(8.4, 4.7)) * NS, 0.0).a;
  return (a * 0.5 + b * 0.25 + c * 0.125 + d * 0.0625) / 0.9375;
}
fn fbm2(p: vec2f) -> f32 { return textureSampleLevel(noiseTex, nsamp, p * NS, 0.0).r * 0.6667 + textureSampleLevel(noiseTex, nsamp, (p * 2.03 + vec2f(1.7, 9.2)) * NS, 0.0).g * 0.3333; }
// detail fades out when a feature is smaller than ~2 px
fn detailFade(freq: f32) -> f32 { return clamp(1.5 - freq / u.cam.z * 3.0, 0.0, 1.0); }

fn lighting(p: vec2f, base: vec3f, emissive: f32) -> vec3f {
  var l = u.amb.rgb * u.amb.w;
  let n = i32(u.misc.y);
  for (var i = 0; i < n; i++) {
    let a = u.lights[i * 2]; let c = u.lights[i * 2 + 1];
    let d = distance(p, a.xy);
    if (d < a.z) {
      let f = 1.0 - d / a.z;
      l += c.rgb * a.w * f * f * (0.18 + 0.82 * u.misc.x);
    }
  }
  return base * l + base * emissive;
}
`;

export const TERRAIN_WGSL = COMMON + /* wgsl */`
@group(0) @binding(1) var terr: texture_2d<f32>;
@group(0) @binding(2) var decal: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

struct VO { @builtin(position) pos: vec4f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VO; o.pos = vec4f(p[i], 0.0, 1.0); return o;
}

var<private> LOD: f32;
fn T(uv: vec2f) -> vec4f { return textureSampleLevel(terr, samp, uv, LOD); }

@fragment fn fs(in: VO) -> @location(0) vec4f {
  let p = u.cam.xy + (in.pos.xy - u.view.xy * 0.5) / u.cam.z;
  // close in, the 2 m terrain grid (and 1 m decal grid) would read as blur or blocks: warp the lookups with
  // sub-cell noise so edges turn organic instead
  let fdw = detailFade(0.6);
  var warp = vec2f(0.0);
  if (fdw > 0.0) {
    let wn = textureSampleLevel(noiseTex, nsamp, p * 0.7 * NS, 0.0);
    let wf = textureSampleLevel(noiseTex, nsamp, (p * 2.6 + vec2f(3.3, 8.1)) * NS, 0.0);
    warp = ((wn.ba - 0.5) * 1.1 + (wf.rg - 0.5) * 0.35) * fdw;
  }
  let uv = (p + warp) / u.map.xy;
  let outside = uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0;
  let texelsPerPx = 1.0 / (u.cam.z * u.map.z);
  LOD = max(0.0, log2(texelsPerPx));
  var t = T(uv);
  if (outside) { t = vec4f(-40.0, 0.0, 0.0, 0.0); }
  let cell = u.map.z;
  let e = vec2f(cell, cell) * max(1.0, texelsPerPx) / u.map.xy;
  let hL = T(uv - vec2f(e.x, 0.0)).x; let hR = T(uv + vec2f(e.x, 0.0)).x;
  let hU = T(uv - vec2f(0.0, e.y)).x; let hD = T(uv + vec2f(0.0, e.y)).x;
  var grad = vec2f(hR - hL, hD - hU) / (2.0 * cell);
  if (outside) { grad = vec2f(0.0); }
  let time = u.cam.w;
  var h = t.x;
  let water = u.map.w;
  let depth = water - h;
  let night = u.misc.x;
  var col: vec3f;
  var emis = 0.0;

  // micro detail
  let fd1 = detailFade(1.0); let fd2 = detailFade(4.0);
  let n1 = fbm(p * 0.08);
  var n2 = 0.0; var n3 = 0.0;
  if (fd1 > 0.0) { n2 = vnoise(p * 1.0) * fd1; }
  if (fd2 > 0.0) { n3 = vnoise(p * 4.0) * fd2; }
  // close-zoom detail (centred on 0.5 so it fades to neutral)
  let fd3 = detailFade(7.0); let fd4 = detailFade(18.0);
  var n4 = 0.5; var n5 = 0.5; var blade = 0.5;
  if (fd3 > 0.0) {
    n4 = mix(0.5, textureSampleLevel(noiseTex, nsamp, (p * 7.0 + vec2f(3.1, 7.7)) * NS, 0.0).g, fd3);
    let bp = vec2f(p.x * 0.8 + p.y * 0.6, p.y * 0.8 - p.x * 0.6);
    blade = mix(0.5, textureSampleLevel(noiseTex, nsamp, vec2f(bp.x * 22.0, bp.y * 4.0) * NS, 0.0).b, fd3);
  }
  if (fd4 > 0.0) { n5 = mix(0.5, textureSampleLevel(noiseTex, nsamp, (p * 18.0 + vec2f(9.4, 1.2)) * NS, 0.0).a, fd4); }

  // ---------- land ----------
  let inland = smoothstep(1.0, 2.4, h);
  var sand = mix(vec3f(0.90, 0.85, 0.70), vec3f(0.80, 0.74, 0.58), n1);
  sand = mix(sand, vec3f(0.70, 0.66, 0.50), inland * 0.55);
  let wet = smoothstep(0.35, -0.05, -depth);
  // coral grit and broken shell/coral fragments
  sand *= 0.93 + 0.14 * n5 + 0.08 * (n4 - 0.5);
  let fdp = detailFade(6.0);
  if (fdp > 0.0) {
    let pv = textureSampleLevel(noiseTex, nsamp, (p * 6.0 + vec2f(11.0, 5.0)) * NS, 0.0).r;
    let peb = smoothstep(0.84, 0.87, pv) * fdp;
    let rim = smoothstep(0.80, 0.84, pv) * (1.0 - smoothstep(0.84, 0.87, pv)) * fdp;
    sand = mix(sand, sand * 0.8, rim * 0.5);
    sand = mix(sand, vec3f(0.94, 0.92, 0.86) * (0.92 + 0.16 * n5), peb * 0.5);
  }
  sand = mix(sand, vec3f(0.62, 0.56, 0.44), wet * 0.8);
  var vegc = mix(vec3f(0.26, 0.33, 0.15), vec3f(0.36, 0.40, 0.20), n2 * 0.6 + n1 * 0.4);
  // scrub grass: streaky blades and darker tuft bases
  vegc *= 0.72 + 0.56 * blade * (0.6 + 0.8 * n4) - 0.12 * (n4 - 0.5);
  let vegAmt = smoothstep(0.05, 0.6, t.z + (n2 - 0.5) * 0.25 + (n4 - 0.5) * 0.3 + (blade - 0.5) * 0.15);
  var land = mix(sand, vegc, vegAmt * 0.9);
  // crushed coral airfield & tracks
  let air = smoothstep(0.3, 0.9, t.w);
  var concrete = vec3f(0.80, 0.79, 0.74) * (0.94 + 0.06 * n1);
  let seam = step(0.97, fract(p.x * 0.1)) * 0.06 + step(0.985, fract(p.y * 0.1)) * 0.05;
  concrete -= seam * detailFade(0.2);
  land = mix(land, concrete, air);
  land *= 0.93 + 0.07 * n2 + 0.05 * (n3 - 0.5);

  // hillshade
  let nrm = normalize(vec3f(-grad.x * 2.2, -grad.y * 2.2, 1.0));
  let shade = clamp(dot(nrm, normalize(u.sun.xyz)) * 1.25, 0.35, 1.25);

  // ---------- water ----------
  if (depth > 0.0) {
    let shallow = vec3f(0.36, 0.78, 0.74);
    let mid = vec3f(0.10, 0.50, 0.62);
    let deep = vec3f(0.03, 0.18, 0.33);
    var wc = mix(shallow, mid, smoothstep(0.6, 3.0, depth));
    wc = mix(wc, deep, smoothstep(3.0, 10.0, depth));
    // visible coral bottom in the shallows
    let coral = mix(vec3f(0.78, 0.74, 0.60), vec3f(0.58, 0.55, 0.45), select(n1, vnoise(p * 0.35), detailFade(0.35) > 0.0) * 0.6 + n2 * 0.4);
    var caust = 0.0;
    if (fd1 > 0.0 && depth < 2.5) { caust = vnoise(p * 0.45 + vec2f(time * 0.25, time * 0.17)) * vnoise(p * 0.7 - vec2f(time * 0.18, -time * 0.21)); }
    let bottom = coral * (0.9 + 0.3 * caust * fd1);
    let clarity = exp(-depth * 0.9);
    wc = mix(wc, bottom * vec3f(0.55, 0.9, 0.95), clarity * 0.85);
    // waves
    let w1 = vnoise(p * 0.12 + vec2f(time * 0.25, time * 0.1));
    let w2 = vnoise(p * 0.25 - vec2f(time * 0.3, -time * 0.22));
    let wn = normalize(vec3f((w1 - 0.5) * 0.5 + (w2 - 0.5) * 0.25 * fd1, (w2 - 0.5) * 0.4, 1.0));
    let spec = pow(max(dot(reflect(-normalize(u.sun.xyz), wn), vec3f(0.0, 0.0, 1.0)), 0.0), 40.0);
    wc += vec3f(spec) * 0.35 * (1.0 - night);
    wc *= 0.95 + 0.07 * w1;
    // surf: breaking waves where the reef drops off
    let slope = length(grad);
    let surfZone = smoothstep(0.03, 0.12, slope) * smoothstep(9.0, 1.5, depth) * smoothstep(0.3, 1.2, depth);
    let crest = smoothstep(0.75, 0.95, sin(h * 3.0 - time * 1.6 + vnoise(p * 0.05) * 6.0) * 0.5 + 0.5);
    let foam1 = surfZone * crest * (0.6 + 0.4 * vnoise(p * 0.7 + time));
    // shoreline foam
    let shore = smoothstep(0.18, 0.0, depth) * (0.55 + 0.45 * sin(time * 1.3 + p.x * 0.05 + p.y * 0.04));
    let foam = clamp(foam1 + shore * (0.6 + 0.4 * n2), 0.0, 1.0);
    wc = mix(wc, vec3f(0.95, 0.97, 0.96), foam * 0.85);
    // soft transition to the beach
    let edge = smoothstep(0.0, 0.06, depth);
    col = mix(land * shade, wc, edge);
  } else {
    col = land * shade;
  }
  // decals (craters, scorches, trenches)
  let dc = textureSampleLevel(decal, samp, (p + warp * 0.5) / (vec2f(textureDimensions(decal)) * u.misc.z), max(0.0, log2(1.0 / (u.cam.z * u.misc.z))));
  col = mix(col, dc.rgb, dc.a * (1.0 - smoothstep(0.1, 0.5, depth)));
  let lit = lighting(p, col, emis);
  return vec4f(lit, 1.0);
}
`;

export const SPRITE_WGSL = COMMON + /* wgsl */`
struct VI {
  @location(0) a: vec4f,  // x, y, hw, hh
  @location(1) b: vec4f,  // rot, kind, p0, p1
  @location(2) c: vec4f,  // rgba
  @location(3) d: vec4f,  // p2, p3, p4, p5
};
struct VO {
  @builtin(position) pos: vec4f,
  @location(0) q: vec2f,       // local metres (x forward)
  @location(1) wp: vec2f,      // world position
  @location(2) @interpolate(flat) kind: i32,
  @location(3) prm: vec4f,     // p0, p1, p2, p3
  @location(4) col: vec4f,
  @location(5) hs: vec2f,      // half size
  @location(6) extra: vec2f,   // p4, p5
};
@vertex fn vs(@builtin(vertex_index) vi: u32, inst: VI) -> VO {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let c = corners[vi];
  let hs = inst.a.zw;
  let q = c * hs;
  let r = inst.b.x;
  let cs = cos(r); let sn = sin(r);
  let w = inst.a.xy + vec2f(q.x * cs - q.y * sn, q.x * sn + q.y * cs);
  let clip = (w - u.cam.xy) * u.cam.z * 2.0 * u.view.zw;
  var o: VO;
  o.pos = vec4f(clip.x, -clip.y, 0.0, 1.0);
  o.q = q; o.wp = w; o.kind = i32(inst.b.y + 0.5);
  o.prm = vec4f(inst.b.z, inst.b.w, inst.d.x, inst.d.y);
  o.col = inst.c; o.hs = hs; o.extra = inst.d.zw;
  return o;
}

fn sdCircle(p: vec2f, r: f32) -> f32 { return length(p) - r; }
fn sdBox(p: vec2f, b: vec2f) -> f32 { let d = abs(p) - b; return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0); }
fn sdRBox(p: vec2f, b: vec2f, r: f32) -> f32 { return sdBox(p, b - vec2f(r)) - r; }
fn sdSeg(p: vec2f, a: vec2f, b: vec2f, r: f32) -> f32 {
  let pa = p - a; let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
fn sdEll(p: vec2f, r: vec2f) -> f32 { let k = length(p / r); return (k - 1.0) * min(r.x, r.y); }
fn rot2(p: vec2f, a: f32) -> vec2f { let c = cos(a); let s = sin(a); return vec2f(p.x * c + p.y * s, -p.x * s + p.y * c); }

struct Px { c: vec3f, a: f32 };
var<private> AA: f32;
var<private> px: Px;
fn fill(d: f32, c: vec3f) { let a = clamp(0.5 - d / AA, 0.0, 1.0); px.c = mix(px.c, c, a); px.a = max(px.a, a); }
fn fillA(d: f32, c: vec3f, alpha: f32) { let a = clamp(0.5 - d / AA, 0.0, 1.0) * alpha; px.c = mix(px.c, c, a); px.a = max(px.a, a); }
fn outline(d: f32, c: vec3f, w: f32) { let a = clamp(0.5 - (abs(d) - w) / AA, 0.0, 1.0); px.c = mix(px.c, c, a); px.a = max(px.a, a); }

// --------------------------------------------------------------- shapes
fn soldier(q: vec2f, hs: vec2f, prm: vec4f, col: vec4f, extra: vec2f) {
  let s = q / hs.x;               // normalised
  let aa0 = AA; AA = AA / hs.x;
  let stance = i32(prm.x + 0.5);  // 0 stand 1 crouch 2 prone 3 incap 4 dead
  let wep = i32(prm.y + 0.5);     // 0 rifle 1 mg 2 bazooka 3 flame 4 smg 5 mortar 6 pistol
  let side = prm.z;               // 0 US, 1 JP
  let sub = extra.x;              // depth of water
  let anim = prm.w;
  var uni = select(vec3f(0.30, 0.36, 0.22), vec3f(0.56, 0.50, 0.32), side > 0.5);
  var helm = select(vec3f(0.40, 0.40, 0.25), vec3f(0.40, 0.41, 0.27), side > 0.5);
  let dark = vec3f(0.12, 0.10, 0.08);
  let skin = vec3f(0.72, 0.53, 0.40);
  let wood = vec3f(0.42, 0.27, 0.15);
  if (stance >= 3) { uni *= 0.75; helm *= 0.75; }
  let walk = sin(anim * 9.0) * 0.18;
  // extra detail only once the figure is big on screen (half-size in device px)
  let det = clamp((hs.x * u.cam.z - 9.0) / 9.0, 0.0, 1.0);
  if (det > 0.0 && sub < 0.4) {
    // soft contact shadow
    let sd = select(sdEll(s - vec2f(-0.03, 0.03), vec2f(0.42, 0.62)), sdSeg(s, vec2f(-0.9, 0.04), vec2f(0.5, 0.04), 0.34), stance >= 2);
    let sa = clamp(0.5 - sd / 0.18, 0.0, 1.0) * 0.28 * det;
    px.a = max(px.a, sa);
  }
  if (stance >= 2) {
    // prone / lying: elongated
    if (sub < 0.25) {
      fill(sdSeg(s, vec2f(-0.6, 0.12), vec2f(-1.0 - walk * 0.3, 0.22), 0.1), uni * 0.85);
      fill(sdSeg(s, vec2f(-0.6, -0.12), vec2f(-1.0 + walk * 0.3, -0.22), 0.1), uni * 0.85);
    }
    fill(sdSeg(s, vec2f(-0.55, 0.0), vec2f(0.2, 0.0), 0.26), uni);
    fill(sdSeg(s, vec2f(0.05, 0.22), vec2f(0.45, 0.3), 0.08), uni * 0.9);
    fill(sdSeg(s, vec2f(0.05, -0.22), vec2f(0.45, -0.25), 0.08), uni * 0.9);
    if (stance == 2) {
      fill(sdSeg(s, vec2f(0.25, 0.18), vec2f(0.98, 0.2), select(0.05, 0.08, wep == 1 || wep == 2)), dark);
      if (det > 0.0) {
        if (wep == 0) { fillA(sdSeg(s, vec2f(0.25, 0.18), vec2f(0.52, 0.19), 0.055), wood, det); }
        fillA(sdCircle(s - vec2f(0.47, 0.27), 0.065), skin, det);
        fillA(sdCircle(s - vec2f(0.62, 0.17), 0.065), skin, det);
      }
    }
    let hr = length(s - vec2f(0.38, 0.0)) / 0.23;
    fill(sdCircle(s - vec2f(0.38, 0.0), 0.23), helm * mix(1.0, 1.12 - 0.3 * hr * hr, det));
    outline(sdCircle(s - vec2f(0.38, 0.0), 0.23), helm * 0.6, 0.02);
  } else {
    let sh = select(0.52, 0.48, stance == 1);
    if (sub < 0.6) {
      fill(sdSeg(s, vec2f(0.0, 0.18), vec2f(walk - 0.05, 0.2), 0.12), uni * 0.8);
      fill(sdSeg(s, vec2f(0.0, -0.18), vec2f(-walk - 0.05, -0.2), 0.12), uni * 0.8);
    }
    fill(sdEll(s, vec2f(0.3, sh)), uni * mix(1.0, 0.9 + 0.2 * smoothstep(0.3, -0.1, s.x), det));
    // pack
    fill(sdRBox(s - vec2f(-0.24, 0.0), vec2f(0.12, 0.25), 0.06), uni * 0.7);
    // arms reaching forward to the weapon
    if (det > 0.0 && wep != 6) {
      fillA(sdSeg(s, vec2f(0.0, sh - 0.1), vec2f(0.42, 0.33), 0.085), uni * 0.88, det);
      fillA(sdSeg(s, vec2f(0.0, -sh + 0.1), vec2f(0.2, 0.08), 0.085), uni * 0.85, det);
      fillA(sdSeg(s, vec2f(0.2, 0.08), vec2f(0.14, 0.24), 0.08), uni * 0.85, det);
    }
    if (wep == 3) { fill(sdCircle(s - vec2f(-0.3, 0.14), 0.13), vec3f(0.25, 0.25, 0.22)); fill(sdCircle(s - vec2f(-0.3, -0.14), 0.13), vec3f(0.25, 0.25, 0.22)); }
    // weapon
    if (wep == 2) { fill(sdSeg(s, vec2f(-0.6, 0.28), vec2f(0.9, 0.28), 0.09), vec3f(0.25, 0.28, 0.2)); }
    else if (wep == 1) { fill(sdSeg(s, vec2f(-0.1, 0.25), vec2f(1.0, 0.27), 0.08), dark); }
    else if (wep == 3) { fill(sdSeg(s, vec2f(0.0, 0.3), vec2f(0.85, 0.3), 0.05), dark); }
    else if (wep == 5) { fill(sdSeg(s, vec2f(0.1, 0.3), vec2f(0.6, 0.35), 0.1), dark); }
    else if (wep != 6) {
      fill(sdSeg(s, vec2f(0.0, 0.26), vec2f(select(0.92, 0.7, wep == 4), 0.28), 0.045), dark);
      if (det > 0.0 && wep == 0) { fillA(sdSeg(s, vec2f(0.0, 0.26), vec2f(0.62, 0.275), 0.052), wood, det); fillA(sdSeg(s, vec2f(0.3, 0.27), vec2f(0.62, 0.275), 0.03), wood * 0.8, det); }
    }
    if (det > 0.0 && wep != 6) {
      fillA(sdCircle(s - vec2f(0.45, 0.30), 0.07), skin, det);
      fillA(sdCircle(s - vec2f(0.15, 0.25), 0.07), skin, det);
    }
    let hr = length(s - vec2f(0.06, 0.0)) / 0.29;
    fill(sdCircle(s - vec2f(0.06, 0.0), 0.29), helm * mix(1.0, 1.12 - 0.3 * hr * hr, det));
    // helmet camo cover / cap detail
    let spots = step(0.62, vnoise(s * 6.0 + vec2f(col.a * 7.0, 0.0)));
    fill(sdCircle(s - vec2f(0.06, 0.0), 0.2) + spots * 1.0, helm * select(0.78, 0.9, side > 0.5) * mix(1.0, 1.1 - 0.3 * hr * hr, det));
    outline(sdCircle(s - vec2f(0.06, 0.0), 0.29), helm * 0.55, 0.02);
  }
  // water ripple
  if (sub > 0.15) {
    let r = length(s);
    let ring = abs(r - 0.75 - 0.1 * sin(anim * 3.0)) - 0.04;
    fillA(ring, vec3f(0.9, 0.97, 1.0), 0.6);
  }
  AA = aa0;
}

fn palm(q: vec2f, hs: vec2f, prm: vec4f) {
  let s = q / hs.x;
  let aa0 = AA; AA = AA / hs.x;
  let r = length(s);
  let a = atan2(s.y, s.x);
  let seed = prm.x;
  let dmg = prm.y;
  let N = 7.0 + floor(seed * 3.0);
  let fa = a / 6.2831853 * N + seed * 13.0;
  let idx = floor(fa);
  let fl = 0.75 + 0.25 * hash21(vec2f(idx, seed * 100.0));
  let broken = step(hash21(vec2f(idx + 3.0, seed * 50.0)), dmg) ;
  let len = fl * (1.0 - broken * 0.55);
  let ang = abs(fract(fa) - 0.5) * 2.0;
  let width = 0.55 * (1.0 - r / len) * (0.5 + r);
  let leaf = ang - width;
  let d = max(leaf * 0.3, r - len);
  var g = mix(vec3f(0.22, 0.40, 0.14), vec3f(0.36, 0.48, 0.18), hash21(vec2f(idx, seed)));
  g = mix(g, vec3f(0.45, 0.38, 0.20), dmg * 0.8 * hash21(vec2f(idx * 3.0, seed)));
  let rib = smoothstep(0.08, 0.0, ang) * 0.35;
  let leaflets = 0.85 + 0.15 * sin(r * 40.0 + ang * 3.0);
  fillA(d, g * leaflets * (1.0 - rib * 0.4) * (0.75 + 0.35 * r), 0.95);
  fill(sdCircle(s, 0.09), vec3f(0.35, 0.28, 0.16));
  AA = aa0;
}

fn building(q: vec2f, hs: vec2f, prm: vec4f, hut: bool) {
  let d = sdBox(q, hs);
  if (hut) {
    var c = vec3f(0.62, 0.52, 0.32) * (0.85 + 0.15 * vnoise(q * 3.0));
    let ridge = abs(q.y) / hs.y;
    c *= 0.8 + 0.3 * ridge * select(1.0, 0.7, q.y > 0.0);
    fill(d - 0.3, c);
    outline(d - 0.3, c * 0.6, 0.06);
  } else {
    var c = vec3f(0.55, 0.53, 0.50);
    let corr = 0.9 + 0.1 * sin(q.x * 9.0);
    let rust = vnoise(q * 0.4 + prm.y * 10.0);
    c = mix(c, vec3f(0.55, 0.36, 0.22), smoothstep(0.4, 0.8, rust) * 0.7);
    c *= corr * select(0.92, 1.08, q.y > 0.0);
    fill(d, c);
    outline(d, c * 0.5, 0.08);
    fill(abs(q.y) - 0.12, c * 0.75);
  }
}
fn rubble(q: vec2f, hs: vec2f, prm: vec4f) {
  let n = vnoise(q * 0.9 + prm.y * 20.0);
  let d = sdBox(q, hs) + (n - 0.5) * 1.6;
  let c = mix(vec3f(0.35, 0.32, 0.28), vec3f(0.55, 0.50, 0.42), vnoise(q * 2.5));
  fillA(d, c, 0.95);
  let beams = abs(fract((q.x + q.y * 0.6) * 0.5) - 0.5) - 0.06;
  fillA(max(beams, d + 0.4), vec3f(0.15, 0.12, 0.10), 0.7 * step(0.55, vnoise(q * 0.6)));
}
fn bunker(q: vec2f, hs: vec2f, prm: vec4f) {
  let dead = prm.x;
  let d = sdRBox(q, hs, min(hs.x, hs.y) * 0.6);
  let r = clamp(1.0 + d / (min(hs.x, hs.y)), 0.0, 1.0);
  var c = mix(vec3f(0.74, 0.69, 0.53), vec3f(0.84, 0.79, 0.62), r);
  c *= 0.9 + 0.1 * vnoise(q * 1.5);
  c *= 0.8 + 0.3 * clamp(dot(normalize(q + vec2f(0.001)), vec2f(-0.6, -0.8)) * 0.5 + 0.5, 0.0, 1.0) * (1.0 - r * 0.5);
  if (dead > 0.5) { c = mix(c, vec3f(0.18, 0.16, 0.14), 0.6 * vnoise(q * 0.8)); }
  fill(d, c);
  // logs visible at the front face
  let logs = abs(fract(q.y * 1.4) - 0.5) - 0.42;
  fillA(max(logs, max(-q.x + hs.x * 0.75, d)), vec3f(0.35, 0.27, 0.18), 0.8);
  // embrasure slit (front = +x)
  fill(sdBox(q - vec2f(hs.x * 0.92, 0.0), vec2f(hs.x * 0.1, hs.y * 0.32)), vec3f(0.05, 0.05, 0.05));
  outline(d, c * 0.6, 0.08);
}
fn pillbox(q: vec2f, hs: vec2f, prm: vec4f) {
  let dead = prm.x;
  let d = sdRBox(q, hs, hs.x * 0.35);
  var c = vec3f(0.62, 0.61, 0.57) * (0.9 + 0.1 * vnoise(q * 2.0));
  c *= 0.85 + 0.25 * step(0.0, -q.y);
  // camouflage sand & palm logs on top
  c = mix(c, vec3f(0.72, 0.67, 0.52), smoothstep(0.45, 0.7, vnoise(q * 0.8 + 3.0)) * 0.7);
  if (dead > 0.5) { c = mix(c, vec3f(0.15, 0.14, 0.13), 0.55 + 0.3 * vnoise(q * 1.7)); }
  fill(d, c);
  outline(d, c * 0.55, 0.12);
  fill(sdRBox(q, hs * 0.55, 0.3), c * 0.88);
  fill(sdBox(q - vec2f(hs.x * 0.93, 0.0), vec2f(hs.x * 0.09, hs.y * 0.38)), vec3f(0.04, 0.04, 0.04));
}
fn blockhouse(q: vec2f, hs: vec2f, prm: vec4f) {
  let d = sdBox(q, hs);
  var c = vec3f(0.66, 0.65, 0.61) * (0.9 + 0.1 * vnoise(q * 0.7));
  let pock = step(0.8, vnoise(q * 1.8));
  c = mix(c, vec3f(0.35, 0.34, 0.32), pock * 0.6);
  fill(d, c);
  outline(d, c * 0.5, 0.15);
  fill(sdBox(q - vec2f(-hs.x * 0.2, 0.0), hs * vec2f(0.45, 0.55)), c * 1.07);
  outline(sdBox(q - vec2f(-hs.x * 0.2, 0.0), hs * vec2f(0.45, 0.55)), c * 0.6, 0.08);
  for (var i = -1; i <= 1; i++) { fill(sdBox(q - vec2f(hs.x * 0.98, f32(i) * hs.y * 0.5), vec2f(0.2, 0.6)), vec3f(0.05)); }
}
fn coastgun(q: vec2f, hs: vec2f, prm: vec4f) {
  let dead = prm.x;
  let r = hs.x;
  fill(abs(length(q) - r * 0.82) - r * 0.16, vec3f(0.58, 0.57, 0.53));
  fill(sdCircle(q, r * 0.62), vec3f(0.42, 0.42, 0.40));
  let a = select(0.0, 0.5, dead > 0.5);
  let bq = rot2(q, a);
  fill(sdSeg(bq, vec2f(0.0, 0.0), vec2f(r * 1.25, 0.0), 0.32), select(vec3f(0.30, 0.32, 0.30), vec3f(0.12, 0.11, 0.10), dead > 0.5));
  fill(sdRBox(bq, vec2f(r * 0.35, r * 0.3), 0.4), select(vec3f(0.36, 0.38, 0.35), vec3f(0.15, 0.14, 0.12), dead > 0.5));
}
fn seawall(q: vec2f, hs: vec2f, prm: vec4f) {
  let d = sdBox(q, hs);
  var c = vec3f(0.42, 0.32, 0.20);
  let logLine = abs(fract(q.y / (hs.y) * 1.5) - 0.5);
  c *= 0.75 + 0.35 * smoothstep(0.5, 0.1, logLine);
  c *= 0.9 + 0.1 * vnoise(vec2f(q.x * 2.0, prm.x * 30.0));
  let ends = step(0.94, fract(q.x * 0.45 + prm.x));
  c *= 1.0 - ends * 0.35;
  fill(d, c);
  fill(sdBox(q - vec2f(0.0, hs.y * 0.85), vec2f(hs.x, hs.y * 0.15)), c * 0.55);
}
fn pier(q: vec2f, hs: vec2f, prm: vec4f) {
  let d = sdBox(q, hs);
  var c = vec3f(0.55, 0.48, 0.38);
  let plank = fract(q.y * 1.6);
  c *= 0.82 + 0.18 * smoothstep(0.0, 0.12, plank) * smoothstep(1.0, 0.88, plank);
  c *= 0.88 + 0.12 * vnoise(vec2f(q.x * 3.0, floor(q.y * 1.6)));
  let hole = step(0.86, vnoise(q * vec2f(0.4, 0.08) + prm.x * 10.0));
  fillA(d, c, 1.0 - hole * 0.85);
  // pilings
  let pil = sdCircle(vec2f(abs(q.x) - hs.x + 0.3, fract(q.y / 6.0) * 6.0 - 3.0), 0.25);
  fill(pil, vec3f(0.28, 0.22, 0.16));
}
fn wire(q: vec2f, hs: vec2f) {
  let x = fract(q.x * 0.9) - 0.5;
  let loop_ = abs(length(vec2f(x * 1.1, q.y * 1.4)) - 0.42) - 0.03;
  fillA(loop_, vec3f(0.22, 0.20, 0.18), 0.85);
  let posts = sdCircle(vec2f(fract(q.x / 3.0) * 3.0 - 1.5, q.y), 0.09);
  fill(posts, vec3f(0.3, 0.22, 0.14));
}
fn trap(q: vec2f, hs: vec2f) {
  let s = q / hs.x;
  let d = max(abs(s.x) + abs(s.y) - 0.9, -10.0);
  var c = vec3f(0.62, 0.60, 0.55);
  c *= select(0.75, 1.05, s.x + s.y < 0.0);
  fill(d * hs.x, c);
  outline(d * hs.x, c * 0.5, 0.04);
}
fn hulk(q: vec2f, hs: vec2f) {
  let s = q;
  let bow = max(sdBox(s, hs), dot(s - vec2f(hs.x * 0.7, 0.0), normalize(vec2f(1.0, 0.0))) * 0.0 + (abs(s.y) - hs.y * (1.0 - smoothstep(hs.x * 0.6, hs.x, s.x))));
  var c = mix(vec3f(0.40, 0.25, 0.18), vec3f(0.36, 0.34, 0.33), vnoise(s * 0.3));
  c *= 0.85 + 0.15 * vnoise(s * 2.0);
  fill(bow, c);
  outline(bow, vec3f(0.15, 0.10, 0.08), 0.15);
  fill(sdBox(s - vec2f(-hs.x * 0.2, 0.0), vec2f(hs.x * 0.12, hs.y * 0.55)), vec3f(0.62, 0.60, 0.55) * (0.85 + 0.15 * vnoise(s)));
  for (var i = 0; i < 3; i++) { fill(sdBox(s - vec2f(hs.x * (0.45 - f32(i) * 0.5) + select(0.0, hs.x * 0.1, i == 2), 0.0), vec2f(hs.x * 0.07, hs.y * 0.4)), vec3f(0.12, 0.1, 0.09)); }
  fill(sdCircle(s - vec2f(-hs.x * 0.45, 0.0), hs.y * 0.25), vec3f(0.2, 0.18, 0.17));
}
fn tracks(q: vec2f, len: f32, w: f32, phase: f32, c: vec3f) {
  let side = vec2f(q.x, abs(q.y) - w);
  let d = sdBox(side, vec2f(len, 0.32));
  let gr = 0.75 + 0.25 * step(0.5, fract(q.x * 2.5 - phase));
  fill(d, c * 0.45 * gr);
}
fn lvt(q: vec2f, hs: vec2f, prm: vec4f, col: vec4f) {
  let dead = prm.x; let cargo = prm.y; let phase = prm.z; let variant = prm.w;
  var c = vec3f(0.34, 0.37, 0.26);
  if (dead > 0.5) { c = vec3f(0.17, 0.15, 0.13); }
  tracks(q, hs.x * 0.98, hs.y - 0.32, phase, c * 1.2);
  let hull = sdRBox(q, vec2f(hs.x, hs.y - 0.25), 0.7);
  fill(hull, c);
  outline(hull, c * 0.5, 0.06);
  // cargo well
  let well = sdRBox(q - vec2f(-hs.x * 0.12, 0.0), vec2f(hs.x * 0.55, hs.y * 0.62), 0.3);
  fill(well, c * 0.5);
  if (cargo > 0.5 && dead < 0.5) {
    let g = vec2f(fract((q.x + hs.x) * 0.9) - 0.5, fract(q.y * 0.9 + 0.5) - 0.5);
    fill(max(sdCircle(g, 0.24), well + 0.2), vec3f(0.40, 0.40, 0.25));
  }
  // cab & guns
  fill(sdRBox(q - vec2f(hs.x * 0.72, 0.0), vec2f(hs.x * 0.16, hs.y * 0.6), 0.2), c * 1.12);
  fill(sdSeg(q, vec2f(hs.x * 0.65, 0.6), vec2f(hs.x * 1.05, 0.65), 0.07), vec3f(0.1));
  if (dead > 0.5) { fillA(sdCircle(q, hs.x * 0.6) + vnoise(q * 1.3) * 1.5, vec3f(0.05), 0.6); }
}
fn lcvp(q: vec2f, hs: vec2f, prm: vec4f) {
  let dead = prm.x; let cargo = prm.y; let ramp = prm.w;
  var c = vec3f(0.42, 0.47, 0.50);
  if (dead > 0.5) { c = vec3f(0.18, 0.18, 0.18); }
  let hull = sdRBox(q - vec2f(-0.3, 0.0), vec2f(hs.x - 0.3, hs.y), 0.9);
  fill(hull, c);
  outline(hull, c * 0.5, 0.08);
  let well = sdBox(q - vec2f(hs.x * 0.1, 0.0), vec2f(hs.x * 0.62, hs.y * 0.7));
  fill(well, c * 0.62);
  if (cargo > 0.5 && dead < 0.5) {
    let g = vec2f(fract((q.x + hs.x) * 0.95) - 0.5, fract(q.y * 1.0 + 0.5) - 0.5);
    fill(max(sdCircle(g, 0.25), well + 0.2), vec3f(0.40, 0.40, 0.25));
  }
  // ramp at the bow
  let rq = q - vec2f(hs.x * (0.86 + ramp * 0.28), 0.0);
  fill(sdBox(rq, vec2f(hs.x * 0.06 + ramp * hs.x * 0.12, hs.y * 0.72)), c * select(0.85, 0.7, ramp > 0.5));
  fill(sdRBox(q - vec2f(-hs.x * 0.82, 0.0), vec2f(hs.x * 0.12, hs.y * 0.6), 0.2), c * 1.1);
}
fn raft(q: vec2f, hs: vec2f, prm: vec4f) {
  let d = sdRBox(q, hs, hs.y * 0.9);
  fill(d, vec3f(0.18, 0.19, 0.18));
  fill(sdRBox(q, hs * 0.65, hs.y * 0.5), vec3f(0.26, 0.27, 0.24));
  if (prm.y > 0.5) { let g = vec2f(fract(q.x * 1.0) - 0.5, q.y); fill(max(sdCircle(g, 0.24), sdBox(q, hs * 0.6)), vec3f(0.4, 0.4, 0.25)); }
}
fn tank(q: vec2f, hs: vec2f, prm: vec4f, col: vec4f, kind: i32) {
  let dead = prm.x; let tur = prm.y; let phase = prm.z;
  var c = select(vec3f(0.33, 0.37, 0.24), vec3f(0.48, 0.44, 0.30), kind == 15);
  if (kind == 15) {
    let camo = step(0.55, vnoise(q * 0.8 + 5.0));
    c = mix(c, vec3f(0.28, 0.32, 0.20), camo);
  }
  if (dead > 0.5) { c = vec3f(0.16, 0.14, 0.12); }
  tracks(q, hs.x, hs.y - 0.32, phase, c * 1.2);
  let hull = sdRBox(q, vec2f(hs.x * 0.95, hs.y - 0.42), 0.35);
  fill(hull, c);
  outline(hull, c * 0.45, 0.05);
  fill(sdRBox(q - vec2f(hs.x * 0.6, 0.0), vec2f(hs.x * 0.25, hs.y * 0.5), 0.3), c * 1.08);
  let tc = select(vec2f(-0.1, 0.0), vec2f(-0.1, -0.25), kind == 15);
  let tq = rot2(q - tc, tur);
  let tr = select(select(1.25, 0.95, kind == 14), 0.8, kind == 15);
  let gl = select(select(3.0, 2.0, kind == 14), 1.8, kind == 15);
  fill(sdSeg(tq, vec2f(0.0, 0.0), vec2f(tr + gl, 0.0), select(0.11, 0.08, kind != 13)), c * 0.6);
  fill(sdCircle(tq, tr), c * 1.12);
  outline(sdCircle(tq, tr), c * 0.5, 0.05);
  fill(sdCircle(tq - vec2f(-0.3, 0.3), 0.3), c * 0.8);
  if (dead > 0.5) { fillA(sdCircle(q, hs.x * 0.7) + vnoise(q * 1.3) * 1.5, vec3f(0.04), 0.6); }
}
fn fieldgun(q: vec2f, hs: vec2f, prm: vec4f) {
  let c = vec3f(0.30, 0.32, 0.24);
  fill(sdSeg(q, vec2f(-0.2, 0.0), vec2f(-2.2, 0.8), 0.12), c * 0.8);
  fill(sdSeg(q, vec2f(-0.2, 0.0), vec2f(-2.2, -0.8), 0.12), c * 0.8);
  fill(sdBox(q - vec2f(0.3, 0.0), vec2f(0.12, 1.0)), c);
  fill(sdSeg(q, vec2f(0.0, 0.0), vec2f(2.4, 0.0), 0.1), c * 0.7);
  fill(sdCircle(q - vec2f(0.1, 0.85), 0.35), vec3f(0.15));
  fill(sdCircle(q - vec2f(0.1, -0.85), 0.35), vec3f(0.15));
}
fn sandbags(q: vec2f, hs: vec2f, prm: vec4f, open_: f32) {
  let r = length(q); let a = atan2(q.y, q.x);
  let R = hs.x * 0.8;
  var d = abs(r - R) - hs.x * 0.16;
  if (open_ > 0.5) { d = max(d, -(abs(a - 3.14159) - 0.5) * r * -1.0 + 0.0); d = max(d, cos(a) - 0.92); }
  let bag = 0.85 + 0.15 * step(0.5, fract(a * R * 1.2));
  fill(d, vec3f(0.66, 0.60, 0.44) * bag);
  outline(d, vec3f(0.4, 0.35, 0.25), 0.03);
}
fn revet(q: vec2f, hs: vec2f) {
  let outer = sdBox(q, hs);
  let inner = sdBox(q - vec2f(hs.x * 0.25, 0.0), vec2f(hs.x * 0.85, hs.y * 0.6));
  let d = max(outer, -inner);
  fill(d, vec3f(0.62, 0.58, 0.44) * (0.9 + 0.1 * vnoise(q)));
}
fn truck(q: vec2f, hs: vec2f, prm: vec4f) {
  let c = vec3f(0.22, 0.2, 0.18) * (0.8 + 0.4 * vnoise(q * 2.0 + prm.y * 9.0));
  fill(sdBox(q - vec2f(hs.x * 0.55, 0.0), vec2f(hs.x * 0.4, hs.y * 0.9)), c * 1.2);
  fill(sdBox(q - vec2f(-hs.x * 0.3, 0.0), vec2f(hs.x * 0.65, hs.y)), c);
}
fn crates(q: vec2f, hs: vec2f, prm: vec4f) {
  let g = fract(q * 0.85) - 0.5;
  let d = max(sdCircle(g, 0.4), sdBox(q, hs));
  fill(d, vec3f(0.35, 0.33, 0.25) * (0.8 + 0.3 * hash21(floor(q * 0.85) + prm.y)));
}
fn debris(q: vec2f, hs: vec2f, prm: vec4f) {
  let d = sdSeg(q, vec2f(-hs.x, 0.0), vec2f(hs.x, 0.0), 0.18);
  fill(d, vec3f(0.36, 0.28, 0.17));
  let f = sdSeg(q, vec2f(hs.x * 0.3, 0.0), vec2f(hs.x, hs.y), 0.12);
  fill(f, vec3f(0.45, 0.42, 0.22));
}
fn stump(q: vec2f, hs: vec2f, prm: vec4f) {
  fill(sdCircle(q, 0.35), vec3f(0.30, 0.24, 0.16));
  for (var i = 0; i < 4; i++) {
    let a = f32(i) * 1.7 + prm.x * 6.0;
    let e = vec2f(cos(a), sin(a)) * hs.x * (0.6 + 0.4 * hash21(vec2f(f32(i), prm.x * 9.0)));
    fill(sdSeg(q, vec2f(0.0), e, 0.07), vec3f(0.45, 0.38, 0.22));
  }
}
fn ship(q: vec2f, hs: vec2f) {
  let taper = 1.0 - smoothstep(hs.x * 0.4, hs.x, q.x) * 0.9 - smoothstep(-hs.x * 0.7, -hs.x, q.x) * 0.3;
  let d = max(abs(q.x) - hs.x, abs(q.y) - hs.y * taper);
  fill(d, vec3f(0.46, 0.48, 0.50));
  outline(d, vec3f(0.2), hs.y * 0.05);
  fill(sdBox(q - vec2f(-hs.x * 0.05, 0.0), vec2f(hs.x * 0.18, hs.y * 0.45)), vec3f(0.55, 0.56, 0.58));
  fill(sdCircle(q - vec2f(hs.x * 0.45, 0.0), hs.y * 0.35), vec3f(0.35, 0.36, 0.38));
  fill(sdCircle(q - vec2f(-hs.x * 0.5, 0.0), hs.y * 0.35), vec3f(0.35, 0.36, 0.38));
}
fn plane(q: vec2f, hs: vec2f) {
  let s = q / hs.x * 6.0;
  let aa0 = AA; AA = AA / hs.x * 6.0;
  let c = vec3f(0.24, 0.30, 0.40);
  fill(sdSeg(s, vec2f(-4.5, 0.0), vec2f(4.5, 0.0), 0.65), c);
  fill(sdRBox(s - vec2f(1.0, 0.0), vec2f(1.1, 5.4), 0.5), c * 1.05);
  fill(sdRBox(s - vec2f(-4.0, 0.0), vec2f(0.6, 2.0), 0.3), c);
  fill(sdCircle(s - vec2f(1.0, 3.5), 0.45), vec3f(0.9));
  fill(sdCircle(s - vec2f(1.0, -3.5), 0.45), vec3f(0.9));
  fill(sdCircle(s - vec2f(5.0, 0.0), 0.9 + 0.2 * sin(u.cam.w * 80.0)), vec3f(0.15) );
  AA = aa0;
}

@fragment fn fs(in: VO) -> @location(0) vec4f {
  AA = max(1.0 / u.cam.z, 0.008) * 1.2;
  px.c = vec3f(0.0); px.a = 0.0;
  let q = in.q; let hs = in.hs; let prm = in.prm; let col = in.col;
  let k = in.kind;
  var emis = 0.0;
  var additive = false;
  switch k {
    case 0: { // soft shadow blob
      let d = select(sdEll(q, hs * 0.92), sdRBox(q, hs * 0.92, min(hs.x, hs.y) * 0.4), prm.x > 0.5);
      let a = clamp(0.5 - d / max(min(hs.x, hs.y) * 0.25, AA), 0.0, 1.0) * col.a;
      return vec4f(0.0, 0.0, 0.0, a * 0.38);
    }
    case 1, 2: { soldier(q, hs, prm, col, in.extra); if (prm.z < 0.5) { emis = 0.35 * u.misc.x; } }
    case 3: { palm(q, hs, prm); }
    case 4: { stump(q, hs, prm); }
    case 5: { building(q, hs, prm, false); }
    case 31: { building(q, hs, prm, true); }
    case 32: { rubble(q, hs, prm); }
    case 6: { bunker(q, hs, prm); }
    case 7: { pillbox(q, hs, prm); }
    case 21: { blockhouse(q, hs, prm); }
    case 16: { coastgun(q, hs, prm); }
    case 8: { seawall(q, hs, prm); }
    case 9: { pier(q, hs, prm); }
    case 18: { wire(q, hs); }
    case 19: { trap(q, hs); }
    case 20: { hulk(q, hs); }
    case 10: { lvt(q, hs, prm, col); }
    case 11, 12: { lcvp(q, hs, prm); }
    case 46: { raft(q, hs, prm); }
    case 13, 14, 15: { tank(q, hs, prm, col, k); }
    case 17: { fieldgun(q, hs, prm); }
    case 29, 45: { sandbags(q, hs, prm, 0.0); }
    case 42: { revet(q, hs); }
    case 36: { truck(q, hs, prm); }
    case 37: { crates(q, hs, prm); }
    case 41: { debris(q, hs, prm); }
    case 40: { ship(q, hs); }
    case 34: { plane(q, hs); }
    case 22, 28: { // smoke / dust puff
      let r = length(q / hs);
      let n = fbm2(q / hs.x * 1.6 + vec2f(prm.y * 10.0, u.cam.w * 0.05));
      let a = smoothstep(1.0, 0.25, r + (n - 0.5) * 0.7) * col.a;
      return vec4f(lighting(in.wp, col.rgb * (0.8 + 0.3 * n), 0.0) * a, a);
    }
    case 27: { // splash
      let r = length(q / hs);
      let n = vnoise(q * 3.0 + prm.y * 10.0);
      let a = (smoothstep(1.0, 0.6, r) * (0.5 + 0.5 * n)) * col.a;
      return vec4f(lighting(in.wp, vec3f(0.92, 0.96, 0.97), 0.1) * a, a);
    }
    case 43: { // wake
      let s = q / hs;
      let v = abs(s.y) - (1.0 - s.x) * 0.5;
      let a = smoothstep(0.15, 0.0, abs(v)) * smoothstep(-1.0, 0.6, s.x) * smoothstep(1.0, 0.7, s.x) * col.a * (0.6 + 0.4 * vnoise(q * 2.0 - u.cam.w * 2.0));
      return vec4f(vec3f(0.9, 0.95, 0.97) * a * u.amb.w, a);
    }
    case 35: { // foxhole / pit marker
      let d = sdCircle(q, hs.x * 0.8);
      fillA(d, vec3f(0.3, 0.26, 0.2), 0.6);
    }
    // ---------- additive effects ----------
    case 23: { // fire
      let s = q / hs;
      let n = fbm2(vec2f(s.x * 2.0, s.y * 2.0 - u.cam.w * 3.0) + prm.y * 7.0);
      let a = smoothstep(1.0, 0.1, length(s) + (n - 0.5) * 0.8) * col.a;
      let c = mix(vec3f(1.0, 0.25, 0.02), vec3f(1.0, 0.85, 0.35), n);
      return vec4f(c * a * 1.4, 0.0);
    }
    case 24, 44: { // flash / glow
      let r = length(q / hs);
      let a = pow(clamp(1.0 - r, 0.0, 1.0), select(2.0, 1.4, k == 44)) * col.a;
      return vec4f(col.rgb * a, 0.0);
    }
    case 25: { // tracer
      let s = q / hs;
      let a = smoothstep(1.0, 0.3, abs(s.y)) * smoothstep(1.0, 0.6, abs(s.x)) * col.a;
      return vec4f(col.rgb * a * 1.6, 0.0);
    }
    case 26: { // spark
      let a = smoothstep(1.0, 0.0, length(q / hs)) * col.a;
      return vec4f(col.rgb * a, 0.0);
    }
    case 38: { // flame stream
      let s = q / hs;
      let n = fbm2(vec2f(s.x * 3.0 - u.cam.w * 6.0, s.y * 2.0) + prm.y * 5.0);
      let w = 0.25 + 0.75 * (s.x * 0.5 + 0.5);
      let a = smoothstep(w, w * 0.2, abs(s.y) + (n - 0.5) * 0.4) * smoothstep(1.0, 0.8, abs(s.x)) * col.a;
      let c = mix(vec3f(1.0, 0.3, 0.02), vec3f(1.0, 0.9, 0.5), n * (1.0 - s.x * 0.3));
      return vec4f(c * a * 1.5, 0.0);
    }
    case 33: { // rocket / shell
      let s = q / hs;
      let a = smoothstep(1.0, 0.4, length(s)) * col.a;
      return vec4f(col.rgb * a, 0.0);
    }
    default: { return vec4f(0.0); }
  }
  if (px.a <= 0.001) { discard; }
  let lit = lighting(in.wp, px.c * col.rgb, emis);
  let a = px.a * col.a;
  return vec4f(lit * a, a);
}
`;

export const DECAL_WGSL = /* wgsl */`
struct DU { scale: vec4f };  // 2/texW*mPerTexel... : x = metres->clip x scale, y = y scale
@group(0) @binding(0) var<uniform> du: DU;
struct VI { @location(0) a: vec4f, @location(1) b: vec4f };  // x, y, hw, hh | rot, kind, p0, alpha
struct VO { @builtin(position) pos: vec4f, @location(0) q: vec2f, @location(1) @interpolate(flat) k: i32, @location(2) p: vec2f, @location(3) hs: vec2f };
@vertex fn vs(@builtin(vertex_index) vi: u32, inst: VI) -> VO {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let c = corners[vi];
  let q = c * inst.a.zw;
  let cs = cos(inst.b.x); let sn = sin(inst.b.x);
  let w = inst.a.xy + vec2f(q.x * cs - q.y * sn, q.x * sn + q.y * cs);
  var o: VO;
  o.pos = vec4f(w.x * du.scale.x - 1.0, 1.0 - w.y * du.scale.y, 0.0, 1.0);
  o.q = q / inst.a.zw; o.k = i32(inst.b.y + 0.5); o.p = inst.b.zw; o.hs = inst.a.zw;
  return o;
}
fn h21(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453); }
fn vn(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let w = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2f(1.0, 0.0)), w.x), mix(h21(i + vec2f(0.0, 1.0)), h21(i + vec2f(1.0, 1.0)), w.x), w.y);
}
@fragment fn fs(in: VO) -> @location(0) vec4f {
  let r = length(in.q);
  let n = vn(in.q * 4.0 + in.p.x * 17.0);
  var c = vec3f(0.0); var a = 0.0;
  switch in.k {
    case 0: { // crater: dark scorched centre, ejecta ring
      let rr = r + (n - 0.5) * 0.25;
      a = smoothstep(1.0, 0.75, rr) * 0.85;
      c = mix(vec3f(0.30, 0.26, 0.20), vec3f(0.62, 0.57, 0.45), smoothstep(0.25, 0.85, rr));
      c = mix(vec3f(0.12, 0.10, 0.08), c, smoothstep(0.0, 0.4, rr));
    }
    case 1: { // scorch
      let rr = r + (n - 0.5) * 0.4;
      a = smoothstep(1.0, 0.2, rr) * 0.75;
      c = vec3f(0.08, 0.07, 0.06);
    }
    case 2: { // track marks
      a = (step(0.55, abs(in.q.y)) * step(abs(in.q.y), 0.9)) * 0.35 * (0.7 + 0.3 * n);
      c = vec3f(0.35, 0.31, 0.25);
    }
    case 3: { a = smoothstep(1.0, 0.0, r) * 0.4; c = vec3f(0.3, 0.27, 0.22); }
    case 4: { // foxhole
      a = smoothstep(1.0, 0.7, r) * 0.9;
      c = mix(vec3f(0.18, 0.15, 0.12), vec3f(0.55, 0.50, 0.40), smoothstep(0.4, 0.9, r));
    }
    case 5: { // trench: dark floor, sandbag edges
      let y = abs(in.q.y);
      a = smoothstep(1.0, 0.85, y) * 0.95;
      c = mix(vec3f(0.20, 0.17, 0.13), vec3f(0.68, 0.62, 0.47) * (0.85 + 0.15 * step(0.5, fract(in.q.x * in.hs.x * 0.8))), smoothstep(0.45, 0.75, y));
    }
    default: { a = 0.0; }
  }
  a *= in.p.y;
  return vec4f(c, a);
}
`;

export const MIP_WGSL = /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VO; o.pos = vec4f(p[i], 0.0, 1.0); o.uv = vec2f(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5); return o;
}
@fragment fn fs(in: VO) -> @location(0) vec4f { return textureSampleLevel(src, smp, in.uv, 0.0); }
`;
