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
@group(0) @binding(6) var shadowTex: texture_2d<f32>;  // screen-space cast-shadow mask (r), half resolution
@group(0) @binding(7) var shadowSamp: sampler;         // clamp, bilinear

// cast shadow at a framebuffer pixel, scaled by sun strength (0 at night)
const SHADOW_DIM: f32 = 0.56;
fn shadowAt(fp: vec2f) -> f32 {
  if (textureDimensions(shadowTex).x < 2u) { return 0.0; }
  return textureSampleLevel(shadowTex, shadowSamp, fp * u.view.zw, 0.0).r * u.sun.w;
}

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
@group(0) @binding(8) var matAlb: texture_2d_array<f32>;   // photo materials (Poly Haven CC0), see tools/build_textures.py
@group(0) @binding(9) var matNrm: texture_2d_array<f32>;
@group(0) @binding(10) var matSamp: sampler;

struct VO { @builtin(position) pos: vec4f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VO; o.pos = vec4f(p[i], 0.0, 1.0); return o;
}

var<private> LOD: f32;
// Two value-noise lookups on rotated, rescaled lattices: one lattice alone shows its square grid as a
// checkerboard once a cell spans more than a few pixels.
fn vnoiseR(p: vec2f) -> f32 {
  let a = vnoise(vec2f(p.x * 0.8 - p.y * 0.6, p.x * 0.6 + p.y * 0.8));
  let b = vnoise(vec2f(p.x * 0.375 + p.y * 1.24, -p.x * 1.24 + p.y * 0.375) + vec2f(17.3, 5.9));
  return clamp(0.5 + (a + b - 1.0) * 0.72, 0.0, 1.0);
}
fn T(uv: vec2f) -> vec4f { return textureSampleLevel(terr, samp, uv, LOD); }

// ---- materials: 0 sand, 1 wet sand, 2 coral rubble, 3 scrub, 4 grass, 5 burned, 6 airfield, 7 reef, 8 leaf litter
var<private> MP: vec2f;     // world position (m)
var<private> MPX: f32;      // metres per device pixel
var<private> MK: f32;       // anti-tiling noise
var<private> ACC_C: vec3f;  // accumulated albedo
var<private> ACC_N: vec2f;  // accumulated tangent normal (xy)
// Anti-tiled sample (two offset lookups blended by low-frequency noise, after Inigo Quilez) of material i.
fn matSample(i: i32, w: f32) {
  if (w < 0.004) { return; }
  var tiles = array<f32, 9>(8.0, 5.0, 5.0, 4.5, 4.5, 4.0, 5.0, 5.0, 3.5);   // tile size (m), as in assets/tex/manifest.json
  let tile = tiles[i];
  // Photo detail only once a tile spans enough pixels; smaller, its repeats read as a regular dot lattice,
  // so blend toward the material's mean colour (1×1 mip) instead.
  let fade = smoothstep(20.0, 64.0, tile / MPX);
  let mean = textureSampleLevel(matAlb, matSamp, vec2f(0.5), i, 9.0).rgb;
  if (fade <= 0.0) { ACC_C += mean * w; return; }
  let uvt = MP / tile;
  let g = MPX / tile;
  let l = MK * 7.0; let fi = floor(l); let f = fract(l);
  let oa = sin(vec2f(3.0, 7.0) * fi) * 0.37; let ob = sin(vec2f(3.0, 7.0) * (fi + 1.0)) * 0.37;
  let dx = vec2f(g, 0.0); let dy = vec2f(0.0, g);
  let a = textureSampleGrad(matAlb, matSamp, uvt + oa, i, dx, dy).rgb;
  let b = textureSampleGrad(matAlb, matSamp, uvt + ob, i, dx, dy).rgb;
  let k = smoothstep(0.2, 0.8, f - 0.1 * (a.r + a.g + a.b - b.r - b.g - b.b));
  let na = textureSampleGrad(matNrm, matSamp, uvt + oa, i, dx, dy).xy;
  let nb = textureSampleGrad(matNrm, matSamp, uvt + ob, i, dx, dy).xy;
  ACC_C += mix(mean, mix(a, b, k), fade) * w;
  ACC_N += (mix(na, nb, k) * 2.0 - 1.0) * w * fade;
}
// hypsometric tint for the elevation view (metres above high water)
fn hypso(e: f32) -> vec3f {
  if (e < 0.0) { return mix(vec3f(0.30, 0.55, 0.85), vec3f(0.55, 0.80, 0.92), clamp(e / 3.0 + 1.0, 0.0, 1.0)); }
  let c0 = vec3f(0.55, 0.78, 0.45); let c1 = vec3f(0.93, 0.90, 0.48); let c2 = vec3f(0.92, 0.62, 0.30); let c3 = vec3f(0.70, 0.34, 0.22);
  // Betio and Buariki rise only ~3.5 m: spread the ramp over that range
  if (e < 1.2) { return mix(c0, c1, e / 1.2); }
  if (e < 2.6) { return mix(c1, c2, (e - 1.2) / 1.4); }
  return mix(c2, c3, clamp((e - 2.6) / 1.0, 0.0, 1.0));
}

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
  // vegetation and airfield masks vary cell to cell; blend in the next mip so close up they read as soft
  // patches broken up by noise rather than a 2 m mosaic
  let tb = textureSampleLevel(terr, samp, uv, LOD + 1.3);
  t = vec4f(t.x, t.y, mix(t.z, tb.z, 0.7), mix(t.w, tb.w, 0.45));
  if (outside) { t = vec4f(-40.0, 0.0, 0.0, 0.0); }
  let cell = u.map.z;
  // hillshade from the next mip over a wider baseline: the gradient of bilinear heights is constant per cell and
  // would show the 2 m grid as a mosaic of flat facets when zoomed in
  let e = vec2f(cell, cell) * 1.5 * max(1.0, texelsPerPx) / u.map.xy;
  let gl = LOD + 1.0;
  let hL = textureSampleLevel(terr, samp, uv - vec2f(e.x, 0.0), gl).x; let hR = textureSampleLevel(terr, samp, uv + vec2f(e.x, 0.0), gl).x;
  let hU = textureSampleLevel(terr, samp, uv - vec2f(0.0, e.y), gl).x; let hD = textureSampleLevel(terr, samp, uv + vec2f(0.0, e.y), gl).x;
  var grad = vec2f(hR - hL, hD - hU) / (3.0 * cell);
  if (outside) { grad = vec2f(0.0); }
  // local mean height (~10 m) for ambient occlusion in craters, trenches and hollows
  let hMean = textureSampleLevel(terr, samp, uv, LOD + 2.3).x;
  let time = u.cam.w;
  var h = t.x;
  let water = u.map.w;
  let depth = water - h;
  let night = u.misc.x;
  let tview = u.misc.w > 0.5;
  let hw = fwidth(h);                 // (uniform control flow) for contour lines
  var col: vec3f;
  var emis = 0.0;

  // noise
  let fd1 = detailFade(1.0); let fd2 = detailFade(4.0);
  let n1 = fbm(p * 0.08);
  var n2 = 0.5; var n3 = 0.5;
  if (fd1 > 0.0) { n2 = mix(0.5, vnoiseR(p * 1.0), fd1); }
  if (fd2 > 0.0) { n3 = mix(0.5, vnoiseR(p * 0.35), fd2); }
  MP = p; MPX = 1.0 / u.cam.z; MK = vnoise(p * 0.11 + vec2f(4.2, 1.7));
  ACC_C = vec3f(0.0); ACC_N = vec2f(0.0);

  // ---------- land: material weights, layered bottom to top ----------
  let above = h - water;
  let inland = smoothstep(0.7, 2.0, above);
  let wetW = smoothstep(0.4, -0.02, above);
  let coralW = inland * smoothstep(0.42, 0.7, n1 + (n3 - 0.5) * 0.45) * (1.0 - wetW);
  let vegAmt = smoothstep(0.06, 0.55, t.z + (n2 - 0.5) * 0.25 + (n3 - 0.5) * 0.3);
  let dense = smoothstep(0.42, 0.75, t.z + (n1 - 0.5) * 0.35);
  let scrubW = vegAmt * (1.0 - dense);
  let grassW = vegAmt * dense * 0.85;
  let litterW = vegAmt * dense * smoothstep(0.6, 0.8, vnoiseR(p * 0.07 + vec2f(3.0, 9.0)) + (n2 - 0.5) * 0.25) * 0.55;
  let airW = smoothstep(0.3, 0.9, t.w);
  // effective weights = own weight × what every later layer leaves visible
  let w8 = litterW; let w6 = airW;
  let k6 = 1.0 - w6; let k8 = k6 * (1.0 - w8);
  let k4 = k8 * (1.0 - grassW); let k3 = k4 * (1.0 - scrubW); let k2 = k3 * (1.0 - coralW); let k1 = k2 * (1.0 - wetW);
  if (depth < 0.1) {
    matSample(0, k1);
    matSample(1, k2 * wetW);
    matSample(2, k3 * coralW);
    matSample(3, k4 * scrubW);
    matSample(4, k8 * grassW);
    matSample(8, k6 * w8);
    matSample(6, w6);
  }
  var land = ACC_C * (0.9 + 0.2 * n1);
  let tn = ACC_N;
  // ambient occlusion from local relief: hollows darken, crests catch light
  let ao = clamp(1.0 + (h - hMean) * 0.32, 0.72, 1.06);

  // relief: terrain gradient (exaggerated so a metre of rise reads from above) + material micro-normals
  let nrm = normalize(vec3f(-grad.x * 3.2 + tn.x * 0.55, -grad.y * 3.2 - tn.y * 0.55, 1.0));
  let shade = clamp(dot(nrm, normalize(u.sun.xyz)) * 1.25, 0.32, 1.28) * ao;

  // ---------- water ----------
  if (depth > 0.0) {
    let shallow = vec3f(0.36, 0.78, 0.74);
    let mid = vec3f(0.10, 0.50, 0.62);
    let deep = vec3f(0.03, 0.18, 0.33);
    var wc = mix(shallow, mid, smoothstep(0.6, 3.0, depth));
    wc = mix(wc, deep, smoothstep(3.0, 10.0, depth));
    // waves: two scrolling normal octaves
    let w1 = vnoise(p * 0.12 + vec2f(time * 0.25, time * 0.1));
    let w2 = vnoise(p * 0.25 - vec2f(time * 0.3, -time * 0.22));
    var w3 = 0.5;
    if (fd1 > 0.0) { w3 = mix(0.5, vnoiseR(p * 0.9 + vec2f(time * 0.6, -time * 0.4)), fd1 * 0.7); }
    let wn = normalize(vec3f((w1 - 0.5) * 0.5 + (w3 - 0.5) * 0.35, (w2 - 0.5) * 0.4 + (w3 - 0.5) * 0.2, 1.0));
    // reef flat / sandy bottom seen through clear water, refracted by the waves
    let refr = wn.xy * min(depth, 2.0) * 0.6;
    MP = p + refr;
    MPX = max(MPX, 0.05) * (1.0 + depth * 1.5);   // light scattering in the water column softens the bottom
    ACC_C = vec3f(0.0); ACC_N = vec2f(0.0);
    let sandyBottom = smoothstep(-1.4, -0.2, -depth) * (0.6 + 0.4 * n3);
    if (depth < 6.0) { matSample(7, 1.0 - sandyBottom); matSample(0, sandyBottom); }
    var caust = 0.0;
    if (fd1 > 0.0 && depth < 2.5) { caust = vnoise(p * 0.45 + vec2f(time * 0.25, time * 0.17)) * vnoise(p * 0.7 - vec2f(time * 0.18, -time * 0.21)); }
    let bottom = mix(vec3f(dot(ACC_C, vec3f(0.333))), ACC_C, 0.8) * (0.9 + 0.4 * caust * fd1);
    let clarity = exp(-depth * 0.75);
    wc = mix(wc, bottom * vec3f(0.55, 0.88, 0.92), clarity * 0.88);
    let spec = pow(max(dot(reflect(-normalize(u.sun.xyz), wn), vec3f(0.0, 0.0, 1.0)), 0.0), 60.0);
    wc += vec3f(spec) * 0.45 * (1.0 - night);
    // sky reflection (fresnel-ish on wave slopes)
    wc = mix(wc, vec3f(0.55, 0.72, 0.82), clamp((1.0 - wn.z) * 1.1, 0.0, 0.18) * (1.0 - night) * smoothstep(0.3, 2.0, depth));
    wc *= 0.95 + 0.07 * w1;
    // surf: breaking waves where the reef drops off
    let slope = length(grad);
    let surfZone = smoothstep(0.03, 0.12, slope) * smoothstep(9.0, 1.5, depth) * smoothstep(0.3, 1.2, depth);
    let crest = smoothstep(0.75, 0.95, sin(h * 3.0 - time * 1.6 + vnoise(p * 0.05) * 6.0) * 0.5 + 0.5);
    let foam1 = surfZone * crest * (0.6 + 0.4 * vnoise(p * 0.7 + time));
    // shoreline foam: lacy, following the swash
    let swash = sin(time * 1.3 + p.x * 0.05 + p.y * 0.04);
    let shore = smoothstep(0.22, 0.0, depth + swash * 0.05) * smoothstep(0.35, 0.65, vnoiseR(p * 1.6 + vec2f(time * 0.3, 0.0)) + 0.25);
    let foam = clamp(foam1 + shore * (0.6 + 0.4 * n2), 0.0, 1.0);
    wc = mix(wc, vec3f(0.95, 0.97, 0.96), foam * 0.85);
    // soft transition to the beach (wet sand darkens just above the swash)
    let edge = smoothstep(0.0, 0.06, depth);
    col = mix(land * shade, wc, edge);
  } else {
    col = land * shade;
  }
  // decals (craters, scorches, trenches) carry the burned-ground texture as detail
  let dc = textureSampleLevel(decal, samp, (p + warp * 0.5) / (vec2f(textureDimensions(decal)) * u.misc.z), max(0.0, log2(1.0 / (u.cam.z * u.misc.z))));
  if (dc.a > 0.01 && depth < 0.5) {
    MP = p; ACC_C = vec3f(0.0); ACC_N = vec2f(0.0);
    matSample(5, 1.0);
    let burnt = mix(vec3f(1.0), ACC_C / vec3f(0.36, 0.33, 0.28), 0.75 * smoothstep(0.7, 0.2, dot(dc.rgb, vec3f(0.333))));
    col = mix(col, dc.rgb * burnt * shade, dc.a * (1.0 - smoothstep(0.1, 0.5, depth)));
  }
  // elevation view: hypsometric tint, contour lines every 0.5 m (bold every 2 m), obstacles hatched
  if (tview) {
    let lum = dot(col, vec3f(0.3, 0.55, 0.15));
    let el = h - water;
    col = mix(vec3f(lum), hypso(el), 0.62) * mix(1.0, shade, 0.6);
    let c = el / 0.5;
    let wpx = max(hw / 0.5, 1e-4);
    let line = 1.0 - smoothstep(0.6, 1.6, abs(fract(c + 0.5) - 0.5) / wpx);
    let c2 = el / 2.0;
    let line2 = 1.0 - smoothstep(1.0, 2.2, abs(fract(c2 + 0.5) - 0.5) / max(hw / 2.0, 1e-4));
    col = mix(col, vec3f(0.30, 0.20, 0.12), line * 0.55);
    col = mix(col, vec3f(0.18, 0.10, 0.06), line2 * 0.75);
    if (t.y > 0.4) { let hatch = step(0.5, fract((p.x + p.y) * 0.7)); col = mix(col, vec3f(0.25, 0.18, 0.12), 0.45 * hatch * smoothstep(0.4, 1.0, t.y)); }
  }
  // cast shadows (slightly cool, like skylight filling the shade); fainter on deep water
  let sh = shadowAt(in.pos.xy) * (1.0 - 0.45 * smoothstep(0.5, 4.0, depth));
  col *= mix(vec3f(1.0), vec3f(1.0 - SHADOW_DIM * 1.04, 1.0 - SHADOW_DIM, 1.0 - SHADOW_DIM * 0.86), sh);
  let lit = lighting(p, col, emis);
  return vec4f(lit, 1.0);
}
`;

export const SPRITE_WGSL = COMMON + /* wgsl */`
@group(0) @binding(11) var atlasA: texture_2d<f32>;   // pre-rendered sprites (tools/render_sprites.py): albedo + alpha
@group(0) @binding(12) var atlasN: texture_2d<f32>;   // normal xy, height/8 m, ambient occlusion
@group(0) @binding(13) var atlasS: sampler;
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
  @location(7) @interpolate(flat) rot: f32,
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
  o.col = inst.c; o.hs = hs; o.extra = inst.d.zw; o.rot = r;
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
  // selection / hover highlight: glow and a crisp border hugging the silhouette
  let selF = extra.y;
  if (selF > 0.0) {
    var sil: f32;
    if (stance >= 2) { sil = min(sdSeg(s, vec2f(-1.0, 0.0), vec2f(0.5, 0.0), 0.3), sdSeg(s, vec2f(0.25, 0.18), vec2f(0.98, 0.2), 0.07)); }
    else { sil = min(min(sdEll(s, vec2f(0.31, select(0.53, 0.49, stance == 1))), sdCircle(s - vec2f(0.06, 0.0), 0.3)), sdSeg(s, vec2f(0.0, 0.26), vec2f(0.9, 0.28), 0.05)); }
    var sc = vec3f(1.0, 0.86, 0.38);                       // selected
    if (selF > 1.5 && selF < 2.5) { sc = vec3f(1.0, 0.55, 0.15); }  // selected, pinned / cowering
    if (selF > 2.5) { sc = vec3f(1.0, 0.3, 0.25); }          // selected, wounded
    if (selF < 0.9) { sc = vec3f(0.8, 0.92, 1.0); }          // hover
    let w = AA * 1.6;
    let ga = clamp(1.0 - (sil - w) / (AA * 5.0), 0.0, 1.0) * select(0.55, 0.35, selF < 0.9);
    px.c = sc; px.a = ga;
    fill(sil - w, sc);
  }
  if (det > 0.0 && sub < 0.4 && selF <= 0.0) {
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
  let dqx = dpdx(in.q); let dqy = dpdy(in.q);   // (uniform control flow) for atlas mip selection
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
    case 48: { // pre-rendered atlas sprite: p0 = 1 destroyed, p1 = 1 canopy (no shadow received); p2..p5 = atlas rect
      let rect = vec4f(prm.z, prm.w, in.extra.x, in.extra.y);
      let st = q / hs * 0.5 + 0.5;
      let uv = rect.xy + st * rect.zw;
      let sc = rect.zw / (2.0 * hs);
      let A = textureSampleGrad(atlasA, atlasS, uv, dqx * sc, dqy * sc);
      if (A.a < 0.02) { discard; }
      let Nm = textureSampleGrad(atlasN, atlasS, uv, dqx * sc, dqy * sc);
      let nl = Nm.xy * 2.0 - 1.0;
      let cs = cos(in.rot); let sn = sin(in.rot);
      let nw = vec3f(nl.x * cs - nl.y * sn, nl.x * sn + nl.y * cs, sqrt(max(0.0, 1.0 - dot(nl, nl))));
      let diff = max(dot(nw, normalize(u.sun.xyz)), 0.0);
      var c = A.rgb;
      if (prm.x > 0.5) {   // burnt-out wreck: charred paint, soot, rust
        let n = fbm2(q * 2.2 + vec2f(prm.z * 50.0, 0.0));
        c = mix(c * 0.32, vec3f(0.10, 0.09, 0.08), smoothstep(0.35, 0.7, n));
        c = mix(c, vec3f(0.36, 0.20, 0.11), smoothstep(0.62, 0.8, fbm2(q * 4.0 + 3.0)) * 0.6);
      }
      let shade = mix(1.0, 0.45 + 0.75 * diff, u.sun.w) * Nm.a;
      let sh = shadowAt(in.pos.xy) * (1.0 - prm.y);
      let lit = lighting(in.wp, c * shade * (1.0 - SHADOW_DIM * sh), 0.0);
      let a = A.a * col.a;
      return vec4f(lit * a, a);
    }
    case 47: { // selection / hover frame around a vehicle: glow + crisp border
      let d = sdRBox(q, hs - vec2f(AA * 3.0), min(hs.x, hs.y) * 0.3);
      let glow = clamp(1.0 - d / (AA * 6.0), 0.0, 1.0) * step(0.0, d) * 0.55;
      let line = clamp(1.0 - (abs(d) - AA * 0.9) / AA, 0.0, 1.0);
      let a = max(glow, line) * col.a;
      return vec4f(col.rgb * a, a);
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
  // ground-level sprites receive cast shadows; palm canopies, aircraft and ships stand above them
  var recv = 1.0;
  if (k == 3 || k == 34 || k == 40 || k == 47) { recv = 0.0; }
  let sh = shadowAt(in.pos.xy) * recv;
  let lit = lighting(in.wp, px.c * col.rgb * (1.0 - SHADOW_DIM * sh), emis);
  let a = px.a * col.a;
  return vec4f(lit * a, a);
}

// ---------------------------------------------------------------- cast shadows
// Caster instance: a = (x, y, hw, hh) footprint; b = (rot, shape, height m, darkness);
// c = (seed, damage, mask own footprint, extra penumbra m). Shapes: 0 upright cylinder (r = hw), 1 box, 2 sand mound, 3 palm.
// The footprint is swept along the sun direction by its height; the mask pass keeps the darkest value per pixel.
struct VOS {
  @builtin(position) pos: vec4f,
  @location(0) lp: vec2f,                         // metres from the footprint centre
  @location(1) @interpolate(flat) S: vec2f,       // shadow sweep vector
  @location(2) @interpolate(flat) hs: vec2f,
  @location(3) @interpolate(flat) b: vec4f,
  @location(4) @interpolate(flat) c: vec4f,
  @location(5) @interpolate(flat) d: vec4f,       // shape 4: atlas rect
};
fn shadowVec() -> vec2f { return -u.sun.xy / max(u.sun.z, 0.2); }
@vertex fn vsShadow(@builtin(vertex_index) vi: u32, inst: VI) -> VOS {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let S = shadowVec() * inst.b.z;
  let R = length(inst.a.zw) + 0.3 + inst.b.z * 0.06 + inst.c.w + 2.0 / u.cam.z;
  let lp = S * 0.5 + corners[vi] * (vec2f(R) + abs(S) * 0.5);
  let clip = (inst.a.xy + lp - u.cam.xy) * u.cam.z * 2.0 * u.view.zw;
  var o: VOS;
  o.pos = vec4f(clip.x, -clip.y, 0.0, 1.0);
  o.lp = lp; o.S = S; o.hs = inst.a.zw; o.b = inst.b; o.c = inst.c; o.d = inst.d;
  return o;
}
@fragment fn fsShadow(in: VOS) -> @location(0) vec4f {
  let pxm = 1.0 / u.cam.z;
  let h = in.b.z; let shape = i32(in.b.y + 0.5); let rot = in.b.x; let hs = in.hs; let S = in.S;
  let soft = max(pxm * 1.2, in.c.w + h * 0.035);
  var d = 1e9; var d0 = 1e9;
  if (shape == 0) {
    d = sdSeg(in.lp, vec2f(0.0), S, hs.x);
    d0 = length(in.lp) - hs.x;
  } else if (shape == 4) {
    // pre-rendered palm: the crown's own silhouette from the atlas at canopy height, trunk underneath
    let cs = rot2(in.lp - S, rot) / hs * 0.5 + 0.5;
    var cov = 0.0;
    if (all(cs > vec2f(0.0)) && all(cs < vec2f(1.0))) { cov = textureSampleLevel(atlasA, atlasS, in.d.xy + cs * in.d.zw, 1.5).a; }
    d = (0.5 - cov) * soft * 2.0;
    d = min(d, sdSeg(in.lp, vec2f(0.0), S * 0.97, 0.17));
  } else if (shape == 3) {
    // palm: the frond silhouette (same construction as the sprite) at canopy height, trunk underneath
    let cs = rot2(in.lp - S, rot) / hs.x;
    let r = length(cs);
    let seed = in.c.x; let dmg = in.c.y;
    let N = 7.0 + floor(seed * 3.0);
    let fa = atan2(cs.y, cs.x) / 6.2831853 * N + seed * 13.0;
    let idx = floor(fa);
    let fl = 0.75 + 0.25 * hash21(vec2f(idx, seed * 100.0));
    let len = fl * (1.0 - step(hash21(vec2f(idx + 3.0, seed * 50.0)), dmg) * 0.55);
    let ang = abs(fract(fa) - 0.5) * 2.0;
    let leaf = ang - 0.55 * (1.0 - r / len) * (0.5 + r);
    d = max(leaf * 0.3, r - len) * hs.x;
    d = min(d, sdSeg(in.lp, vec2f(0.0), S * 0.97, 0.17));
  } else {
    let rr = select(0.0, min(hs.x, hs.y) * 0.6, shape == 2);
    let n = clamp(ceil(length(S) / min(hs.x, hs.y)), 1.0, 24.0);
    for (var i = 0.0; i <= n; i += 1.0) { d = min(d, sdRBox(rot2(in.lp - S * (i / n), rot), hs, rr)); }
    d0 = sdRBox(rot2(in.lp, rot), hs, rr);
  }
  var a = clamp(0.5 - d / soft, 0.0, 1.0) * in.b.w;
  // a caster that also receives shadows must not shade itself
  if (in.c.z > 0.5) { a *= clamp(0.5 + d0 / (pxm * 1.2), 0.0, 1.0); }
  if (a <= 0.003) { discard; }
  return vec4f(a, 0.0, 0.0, a);
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
