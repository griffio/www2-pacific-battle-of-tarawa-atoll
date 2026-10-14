// WebGPU renderer: procedural terrain, persistent decal layer, instanced SDF sprites (alpha + additive passes).
import { TERRAIN_WGSL, SPRITE_WGSL, DECAL_WGSL, MIP_WGSL } from './shaders.js';
import { f16 } from '../util.js';

export const IFLOATS = 16;

export class InstanceList {
  constructor(cap = 4096) { this.data = new Float32Array(cap * IFLOATS); this.n = 0; }
  clear() { this.n = 0; }
  ensure(extra) {
    if ((this.n + extra) * IFLOATS > this.data.length) {
      const d = new Float32Array(Math.max(this.data.length * 2, (this.n + extra) * IFLOATS));
      d.set(this.data); this.data = d;
    }
  }
  push(x, y, hw, hh, rot, kind, p0 = 0, p1 = 0, r = 1, g = 1, b = 1, a = 1, p2 = 0, p3 = 0, p4 = 0, p5 = 0) {
    if ((this.n + 1) * IFLOATS > this.data.length) this.ensure(1);
    const d = this.data, o = this.n * IFLOATS;
    d[o] = x; d[o + 1] = y; d[o + 2] = hw; d[o + 3] = hh; d[o + 4] = rot; d[o + 5] = kind; d[o + 6] = p0; d[o + 7] = p1;
    d[o + 8] = r; d[o + 9] = g; d[o + 10] = b; d[o + 11] = a; d[o + 12] = p2; d[o + 13] = p3; d[o + 14] = p4; d[o + 15] = p5;
    this.n++;
  }
  append(other) { this.ensure(other.n); this.data.set(other.data.subarray(0, other.n * IFLOATS), this.n * IFLOATS); this.n += other.n; }
}

export class Renderer {
  static async create(canvas) {
    if (!navigator.gpu) throw new Error('This browser does not support WebGPU.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter available.');
    const feats = adapter.features.has('timestamp-query') ? ['timestamp-query'] : [];
    const device = await adapter.requestDevice({ requiredFeatures: feats });
    const ctx = canvas.getContext('webgpu');
    const format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format, alphaMode: 'opaque' });
    return new Renderer(device, ctx, format, canvas);
  }
  constructor(device, ctx, format, canvas) {
    this.device = device; this.ctx = ctx; this.format = format; this.canvas = canvas;
    this.lost = false;
    device.lost.then((info) => { this.lost = true; console.error('WebGPU device lost', info); });
    this.uniformData = new Float32Array(24 + 48 * 4);
    this.ubuf = device.createBuffer({ size: this.uniformData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.mipSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.mipModule = device.createShaderModule({ code: MIP_WGSL, label: 'mips' });
    this.mipPipes = {};
    this.bgl = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ] });
    this.makeNoise();
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.bgl] });
    const tmod = device.createShaderModule({ code: TERRAIN_WGSL, label: 'terrain' });
    const smod = device.createShaderModule({ code: SPRITE_WGSL, label: 'sprites' });
    for (const [m, n] of [[tmod, 'terrain'], [smod, 'sprites']]) {
      m.getCompilationInfo?.().then((info) => { for (const msg of info.messages) if (msg.type === 'error') console.error(n, msg.lineNum, msg.message); });
    }
    this.terrainPipe = device.createRenderPipeline({
      layout, label: 'terrain',
      vertex: { module: tmod, entryPoint: 'vs' },
      fragment: { module: tmod, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const instLayout = { arrayStride: IFLOATS * 4, stepMode: 'instance', attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x4' }, { shaderLocation: 1, offset: 16, format: 'float32x4' },
      { shaderLocation: 2, offset: 32, format: 'float32x4' }, { shaderLocation: 3, offset: 48, format: 'float32x4' },
    ] };
    const mk = (blend, label) => device.createRenderPipeline({
      layout, label,
      vertex: { module: smod, entryPoint: 'vs', buffers: [instLayout] },
      fragment: { module: smod, entryPoint: 'fs', targets: [{ format, blend }] },
      primitive: { topology: 'triangle-list' },
    });
    this.alphaPipe = mk({ color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } }, 'alpha');
    this.addPipe = mk({ color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } }, 'add');
    // decals
    const dmod = device.createShaderModule({ code: DECAL_WGSL, label: 'decals' });
    this.decalBgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }] });
    this.decalPipe = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.decalBgl] }), label: 'decal',
      vertex: { module: dmod, entryPoint: 'vs', buffers: [{ arrayStride: 32, stepMode: 'instance', attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x4' }, { shaderLocation: 1, offset: 16, format: 'float32x4' }] }] },
      fragment: { module: dmod, entryPoint: 'fs', targets: [{ format: 'rgba8unorm', blend: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
      primitive: { topology: 'triangle-list' },
    });
    this.decalUbuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.decalBG = device.createBindGroup({ layout: this.decalBgl, entries: [{ binding: 0, resource: { buffer: this.decalUbuf } }] });
    this.alphaBuf = null; this.addBuf = null; this.decalBuf = null;
    this.alphaCap = 0; this.addCap = 0; this.decalCap = 0;
    this.pendingDecals = [];
    // optional GPU timing (debug HUD / benchmarking): window.tarawa.renderer.gpuMs
    this.gpuMs = 0;
    if (device.features.has('timestamp-query')) {
      this.qset = device.createQuerySet({ type: 'timestamp', count: 2 });
      this.qres = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      this.qread = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      this.qbusy = false;
    }
  }

  // Tileable smooth value noise (32x32 lattice, smoothstep-interpolated to 256x256), 4 independent channels.
  makeNoise() {
    const N = 256, L = 32, cell = N / L;
    const data = new Uint8Array(N * N * 4);
    let seed = 1234567;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let ch = 0; ch < 4; ch++) {
      const lat = new Float32Array(L * L);
      for (let i = 0; i < lat.length; i++) lat[i] = rnd();
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const fx = x / cell, fy = y / cell;
        const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const g = (a, b) => lat[((b + L) % L) * L + ((a + L) % L)];
        const v = (g(ix, iy) * (1 - sx) + g(ix + 1, iy) * sx) * (1 - sy) + (g(ix, iy + 1) * (1 - sx) + g(ix + 1, iy + 1) * sx) * sy;
        data[(y * N + x) * 4 + ch] = Math.round(v * 255);
      }
    }
    this.noiseTex = this.device.createTexture({ size: [N, N], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.device.queue.writeTexture({ texture: this.noiseTex }, data, { bytesPerRow: N * 4 }, [N, N]);
    this.noiseSampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
  }

  // Mip chain generation by successive 2x2 bilinear downsampling on the GPU.
  mipChain(tex, format) {
    let pipe = this.mipPipes[format];
    if (!pipe) pipe = this.mipPipes[format] = this.device.createRenderPipeline({
      layout: 'auto', label: 'mip-' + format,
      vertex: { module: this.mipModule, entryPoint: 'vs' },
      fragment: { module: this.mipModule, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const steps = [];
    for (let l = 1; l < tex.mipLevelCount; l++) {
      const src = tex.createView({ baseMipLevel: l - 1, mipLevelCount: 1 });
      const dst = tex.createView({ baseMipLevel: l, mipLevelCount: 1 });
      steps.push({ dst, bg: this.device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: src }, { binding: 1, resource: this.mipSampler }] }) });
    }
    return { pipe, steps };
  }
  runMips(enc, chain) {
    for (const s of chain.steps) {
      const p = enc.beginRenderPass({ colorAttachments: [{ view: s.dst, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
      p.setPipeline(chain.pipe); p.setBindGroup(0, s.bg); p.draw(3); p.end();
    }
  }

  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  setMap(map) {
    const T = map.terrain, d = this.device;
    this.map = map;
    if (this.terrTex) this.terrTex.destroy();
    if (this.decalTex) this.decalTex.destroy();
    const levels = (w, h) => Math.floor(Math.log2(Math.max(w, h))) + 1;
    this.terrTex = d.createTexture({ size: [T.nx, T.ny], format: 'rgba16float', mipLevelCount: levels(T.nx, T.ny),
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    this.terrMips = this.mipChain(this.terrTex, 'rgba16float');
    this.uploadTerrain(T, 0, 0, T.nx - 1, T.ny - 1);
    this.terrMipsDirty = true;
    T.dirty = null;
    const dm = Math.max(map.w / 4096, map.h / 4096, 1);
    this.decalM = dm;
    const dw = Math.ceil(map.w / dm), dh = Math.ceil(map.h / dm);
    this.decalTex = d.createTexture({ size: [dw, dh], format: 'rgba8unorm', mipLevelCount: levels(dw, dh), usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    this.decalView = this.decalTex.createView({ baseMipLevel: 0, mipLevelCount: 1 });
    this.decalMips = this.mipChain(this.decalTex, 'rgba8unorm');
    d.queue.writeBuffer(this.decalUbuf, 0, new Float32Array([2 / (dw * dm), 2 / (dh * dm), 0, 0]));
    // clear decal texture
    const enc = d.createCommandEncoder();
    const p = enc.beginRenderPass({ colorAttachments: [{ view: this.decalView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    p.end();
    d.queue.submit([enc.finish()]);
    this.bindGroup = d.createBindGroup({ layout: this.bgl, entries: [
      { binding: 0, resource: { buffer: this.ubuf } },
      { binding: 1, resource: this.terrTex.createView() },
      { binding: 2, resource: this.decalTex.createView() },
      { binding: 3, resource: this.sampler },
      { binding: 4, resource: this.noiseTex.createView() },
      { binding: 5, resource: this.noiseSampler },
    ] });
    this.pendingDecals = map.decals.slice();
    this.mapJustSet = true;
  }

  uploadTerrain(T, x0, y0, x1, y1) {
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const buf = new Uint16Array(w * h * 4);
    let o = 0;
    for (let y = y0; y <= y1; y++) {
      let i = y * T.nx + x0;
      for (let x = 0; x < w; x++, i++) {
        buf[o++] = f16(T.ground[i]); buf[o++] = f16(T.obj[i]); buf[o++] = f16(T.veg[i]); buf[o++] = f16(T.surf[i]);
      }
    }
    this.device.queue.writeTexture({ texture: this.terrTex, origin: [x0, y0] }, buf, { bytesPerRow: w * 8, rowsPerImage: h }, [w, h]);
  }
  syncTerrain(T) {
    if (!T.dirty) return;
    const d = T.dirty; T.dirty = null;
    this.uploadTerrain(T, d.x0, d.y0, d.x1, d.y1);
    this.terrMipsDirty = true;
  }
  addDecal(k, x, y, hw, hh, rot = 0, p0 = Math.random(), alpha = 1) { this.pendingDecals.push({ k, x, y, hw, hh, rot, p0, alpha }); }

  flushDecals(enc) {
    const list = this.pendingDecals;
    if (!list.length) return;
    const n = list.length;
    const data = new Float32Array(n * 8);
    for (let i = 0; i < n; i++) {
      const d = list[i], o = i * 8;
      data[o] = d.x; data[o + 1] = d.y; data[o + 2] = d.hw; data[o + 3] = d.hh;
      data[o + 4] = d.rot || 0; data[o + 5] = d.k; data[o + 6] = d.p0 ?? 0.5; data[o + 7] = d.alpha ?? 1;
    }
    if (n * 32 > this.decalCap) {
      if (this.decalBuf) this.decalBuf.destroy();
      this.decalCap = Math.max(n * 32, 65536);
      this.decalBuf = this.device.createBuffer({ size: this.decalCap, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    this.device.queue.writeBuffer(this.decalBuf, 0, data);
    const p = enc.beginRenderPass({ colorAttachments: [{ view: this.decalView, loadOp: 'load', storeOp: 'store' }] });
    p.setPipeline(this.decalPipe); p.setBindGroup(0, this.decalBG); p.setVertexBuffer(0, this.decalBuf);
    p.draw(6, n);
    p.end();
    this.pendingDecals = [];
    this.decalMipsDirty = true;
  }

  ensureBuf(which, bytes) {
    const capKey = which + 'Cap', bufKey = which + 'Buf';
    if (bytes > this[capKey]) {
      if (this[bufKey]) this[bufKey].destroy();
      this[capKey] = Math.max(bytes, this[capKey] * 2, 1 << 20);
      this[bufKey] = this.device.createBuffer({ size: this[capKey], usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    return this[bufKey];
  }

  // cam: {x, y, zoomDev}, env: {time, water, tint[3], ambient, night, sun[3], lights:[{x,y,r,i,c:[r,g,b]}]}
  render(cam, env, alpha, additive) {
    if (this.lost || !this.bindGroup) return;
    const d = this.device;
    const U = this.uniformData;
    const W = this.canvas.width, H = this.canvas.height;
    U[0] = cam.x; U[1] = cam.y; U[2] = cam.zoomDev; U[3] = env.time;
    U[4] = W; U[5] = H; U[6] = 1 / W; U[7] = 1 / H;
    U[8] = this.map.w; U[9] = this.map.h; U[10] = this.map.terrain.cell; U[11] = env.water;
    U[12] = env.tint[0]; U[13] = env.tint[1]; U[14] = env.tint[2]; U[15] = env.ambient;
    const nl = Math.min(24, env.lights.length);
    U[16] = env.night; U[17] = nl; U[18] = this.decalM; U[19] = 1;
    U[20] = env.sun[0]; U[21] = env.sun[1]; U[22] = env.sun[2]; U[23] = 1;
    for (let i = 0; i < nl; i++) {
      const l = env.lights[i], o = 24 + i * 8;
      U[o] = l.x; U[o + 1] = l.y; U[o + 2] = l.r; U[o + 3] = l.i;
      U[o + 4] = l.c[0]; U[o + 5] = l.c[1]; U[o + 6] = l.c[2]; U[o + 7] = 0;
    }
    d.queue.writeBuffer(this.ubuf, 0, U);
    if (alpha.n) d.queue.writeBuffer(this.ensureBuf('alpha', alpha.n * IFLOATS * 4), 0, alpha.data, 0, alpha.n * IFLOATS);
    if (additive.n) d.queue.writeBuffer(this.ensureBuf('add', additive.n * IFLOATS * 4), 0, additive.data, 0, additive.n * IFLOATS);
    const enc = d.createCommandEncoder();
    this.flushDecals(enc);
    // Mip chains only matter when zoomed out; rebuild them at most every 0.4 s.
    const nowMs = performance.now();
    if ((this.terrMipsDirty || this.decalMipsDirty) && (nowMs - (this.lastMips || 0) > 400 || this.mapJustSet)) {
      this.lastMips = nowMs; this.mapJustSet = false;
      if (this.terrMipsDirty) { this.terrMipsDirty = false; this.runMips(enc, this.terrMips); }
      if (this.decalMipsDirty) { this.decalMipsDirty = false; this.runMips(enc, this.decalMips); }
    }
    const view = this.ctx.getCurrentTexture().createView();
    const timing = this.qset && !this.qbusy;
    const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.02, g: 0.1, b: 0.2, a: 1 } }],
      ...(timing ? { timestampWrites: { querySet: this.qset, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {}) });
    pass.setBindGroup(0, this.bindGroup);
    pass.setPipeline(this.terrainPipe);
    if (!this.dbgNoTerrain) pass.draw(3);
    if (this.dbgNoSprites) { alpha = { n: 0 }; additive = { n: 0 }; }
    if (alpha.n) { pass.setPipeline(this.alphaPipe); pass.setVertexBuffer(0, this.alphaBuf); pass.draw(6, alpha.n); }
    if (additive.n) { pass.setPipeline(this.addPipe); pass.setVertexBuffer(0, this.addBuf); pass.draw(6, additive.n); }
    pass.end();
    if (timing) { enc.resolveQuerySet(this.qset, 0, 2, this.qres, 0); enc.copyBufferToBuffer(this.qres, 0, this.qread, 0, 16); }
    d.queue.submit([enc.finish()]);
    if (timing) {
      this.qbusy = true;
      this.qread.mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigInt64Array(this.qread.getMappedRange());
        const ms = Number(t[1] - t[0]) / 1e6;
        if (ms > 0 && ms < 1000) this.gpuMs = this.gpuMs * 0.85 + ms * 0.15;
        this.qread.unmap(); this.qbusy = false;
      }).catch(() => { this.qbusy = false; });
    }
  }
}
