// Compositor: every cutout lives in one float texture atlas, and a single
// fragment shader reprojects, masks, weights, shifts and stacks any subset of
// them per output pixel. A CPU fallback does the same maths at lower resolution.

export const SENTINEL = -1e30; // marks masked / missing pixels inside tiles

const WGSL = /* wgsl */ `
struct U {
  res: vec2f, center: vec2f, vel: vec2f,
  scale: f32, lo: f32, hi: f32, soft: f32, T: f32,
  n: u32, flags: u32,
};
struct F { org: vec2f, p0: vec2f, J: vec4f, wA: f32, wB: f32, dt: f32, bg: f32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> frames: array<F>;
@group(0) @binding(2) var atlas: texture_2d<f32>;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[i], 0, 1);
}

fn tile(f: F, sky: vec2f) -> vec2f {
  let p = f.p0 + vec2f(f.J.x * sky.x + f.J.y * sky.y, f.J.z * sky.x + f.J.w * sky.y);
  if ((u.flags & 4u) != 0u) { // nearest pixel
    let q = floor(p + 0.5);
    if (q.x < 0 || q.y < 0 || q.x > u.T - 1 || q.y > u.T - 1) { return vec2f(0); }
    let v = textureLoad(atlas, vec2i(f.org + q), 0).r;
    if (v < -1e29) { return vec2f(0); }
    return vec2f(v - f.bg, 1);
  }
  let ip = floor(p);
  let fr = p - ip;
  if (ip.x < 0 || ip.y < 0 || ip.x >= u.T - 1 || ip.y >= u.T - 1) { return vec2f(0); }
  let b = vec2i(f.org + ip);
  let a = textureLoad(atlas, b, 0).r;
  let c = textureLoad(atlas, b + vec2i(1, 0), 0).r;
  let d = textureLoad(atlas, b + vec2i(0, 1), 0).r;
  let e = textureLoad(atlas, b + vec2i(1, 1), 0).r;
  if (min(min(a, c), min(d, e)) < -1e29) { return vec2f(0); }
  return vec2f(mix(mix(a, c, fr.x), mix(d, e, fr.x), fr.y) - f.bg, 1);
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  // Sky offset from the target in arcsec: east is left, north is up.
  let sky = vec2f(u.res.x * 0.5 - pos.x, u.res.y * 0.5 - pos.y) * u.scale + u.center;
  var A = 0.0; var wa = 0.0; var B = 0.0; var wb = 0.0;
  // Track the highest and lowest sample of each stack so they can be dropped:
  // cosmic-ray hits and dead pixels are mostly unflagged, and one of them would
  // otherwise punch through a stack of a hundred exposures.
  var nA = 0u; var hiA = vec2f(-1e30, 0); var loA = vec2f(1e30, 0);
  var nB = 0u; var hiB = vec2f(-1e30, 0); var loB = vec2f(1e30, 0);
  for (var i = 0u; i < u.n; i++) {
    let f = frames[i];
    let s = tile(f, sky + u.vel * f.dt);
    if (s.y == 0) { continue; }
    if (f.wA > 0) {
      A += f.wA * s.x; wa += f.wA; nA++;
      if (s.x > hiA.x) { hiA = vec2f(s.x, f.wA); }
      if (s.x < loA.x) { loA = vec2f(s.x, f.wA); }
    }
    if (f.wB > 0) {
      B += f.wB * s.x; wb += f.wB; nB++;
      if (s.x > hiB.x) { hiB = vec2f(s.x, f.wB); }
      if (s.x < loB.x) { loB = vec2f(s.x, f.wB); }
    }
  }
  if (nA >= 5u) { A -= hiA.x * hiA.y + loA.x * loA.y; wa -= hiA.y + loA.y; }
  if (nB >= 5u) { B -= hiB.x * hiB.y + loB.x * loB.y; wb -= hiB.y + loB.y; }
  let diff = (u.flags & 1u) != 0u;
  let stripe = 0.012 * step(0.5, fract((pos.x + pos.y) / 12.0));
  let empty = vec4f(0.05 + stripe, 0.06 + stripe, 0.09 + stripe, 1);
  if (wa <= 0 || (diff && wb <= 0)) { return empty; }
  if (diff) {
    let v = A / wa - B / wb;
    let t = clamp(asinh(abs(v) / u.soft) / asinh(u.hi / u.soft), 0, 1);
    let warm = mix(vec3f(0.07, 0.07, 0.09), vec3f(1.0, 0.72, 0.30), t) + vec3f(0.35) * t * t;
    let cool = mix(vec3f(0.07, 0.07, 0.09), vec3f(0.30, 0.62, 1.0), t) + vec3f(0.35) * t * t;
    return vec4f(select(cool, warm, v > 0), 1);
  }
  var t = clamp(asinh((A / wa - u.lo) / u.soft) / asinh((u.hi - u.lo) / u.soft), 0, 1);
  if ((u.flags & 2u) != 0u) { t = 1 - t; }
  return vec4f(vec3f(t), 1);
}`;

const STRIDE = 12; // floats per frame record

class GpuRenderer {
  kind = 'webgpu';
  static async create(canvas, T, maxFrames) {
    if (!navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    const r = new GpuRenderer();
    r.device = device; r.canvas = canvas; r.T = T;
    r.ctx = canvas.getContext('webgpu');
    const format = navigator.gpu.getPreferredCanvasFormat();
    r.ctx.configure({ device, format, alphaMode: 'opaque' });

    const maxDim = Math.min(device.limits.maxTextureDimension2D, 8192);
    r.cols = Math.max(1, Math.floor(maxDim / T));
    const rows = Math.ceil(maxFrames / r.cols);
    if (rows * T > maxDim) return null;
    r.atlas = device.createTexture({
      size: [r.cols * T, rows * T], format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    r.ubuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    r.fbuf = device.createBuffer({ size: Math.max(1, maxFrames) * STRIDE * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    const module = device.createShaderModule({ code: WGSL });
    r.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    });
    r.bind = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: r.ubuf } },
        { binding: 1, resource: { buffer: r.fbuf } },
        { binding: 2, resource: r.atlas.createView() },
      ],
    });
    r.fdata = new Float32Array(Math.max(1, maxFrames) * STRIDE);
    return r;
  }
  destroy() { this.atlas.destroy(); this.ubuf.destroy(); this.fbuf.destroy(); }
  origin(i) { return [(i % this.cols) * this.T, Math.floor(i / this.cols) * this.T]; }
  setTile(i, data) {
    const [x, y] = this.origin(i), T = this.T;
    this.device.queue.writeTexture({ texture: this.atlas, origin: [x, y] }, data, { bytesPerRow: T * 4 }, [T, T]);
  }
  draw(p) {
    const { device, canvas, fdata } = this;
    p.frames.forEach((f, k) => {
      const [ox, oy] = this.origin(f.i);
      fdata.set([ox, oy, f.px, f.py, f.J[0], f.J[1], f.J[2], f.J[3], f.wA, f.wB, f.dt, f.bg], k * STRIDE);
    });
    if (p.frames.length) device.queue.writeBuffer(this.fbuf, 0, fdata, 0, p.frames.length * STRIDE);
    const ub = new ArrayBuffer(64), f32 = new Float32Array(ub), u32 = new Uint32Array(ub);
    f32.set([canvas.width, canvas.height, p.center[0], p.center[1], p.vel[0], p.vel[1],
      p.scale, p.lo, p.hi, p.soft, this.T]);
    u32[11] = p.frames.length;
    u32[12] = (p.diff ? 1 : 0) | (p.invert ? 2 : 0) | (p.nearest ? 4 : 0);
    device.queue.writeBuffer(this.ubuf, 0, ub);
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);
  }
}

// Same compositing on the CPU, drawn at reduced resolution and scaled up by CSS.
class CpuRenderer {
  kind = 'canvas';
  constructor(canvas, T) {
    this.canvas = canvas; this.T = T; this.tiles = [];
    this.ctx = canvas.getContext('2d');
    this.N = 280;
  }
  setTile(i, data) { this.tiles[i] = data; }
  draw(p) {
    const { N, T } = this, cw = this.canvas.width;
    if (!this.img) { this.off = new OffscreenCanvas(N, N); this.octx = this.off.getContext('2d'); this.img = this.octx.createImageData(N, N); }
    const d = this.img.data, k = cw / N, scale = p.scale * k;
    const A = new Float32Array(N * N), wa = new Float32Array(N * N), B = new Float32Array(N * N), wb = new Float32Array(N * N);
    // per-pixel count, highest (value, weight) and lowest (value, weight) for each stack
    const mk = () => ({ n: new Uint16Array(N * N), hv: new Float32Array(N * N).fill(-1e30), hw: new Float32Array(N * N), lv: new Float32Array(N * N).fill(1e30), lw: new Float32Array(N * N) });
    const eA = mk(), eB = mk();
    const add = (sum, wsum, e, o, w, v) => {
      sum[o] += w * v; wsum[o] += w; e.n[o]++;
      if (v > e.hv[o]) { e.hv[o] = v; e.hw[o] = w; }
      if (v < e.lv[o]) { e.lv[o] = v; e.lw[o] = w; }
    };
    for (const f of p.frames) {
      const t = this.tiles[f.i];
      if (!t) continue;
      const [j0, j1, j2, j3] = f.J;
      for (let y = 0; y < N; y++) {
        const sy = (N / 2 - (y + 0.5)) * scale + p.center[1] + p.vel[1] * f.dt;
        for (let x = 0; x < N; x++) {
          const sx = (N / 2 - (x + 0.5)) * scale + p.center[0] + p.vel[0] * f.dt;
          const px = f.px + j0 * sx + j1 * sy, py = f.py + j2 * sx + j3 * sy;
          let v;
          if (p.nearest) {
            const qx = Math.floor(px + 0.5), qy = Math.floor(py + 0.5);
            if (qx < 0 || qy < 0 || qx > T - 1 || qy > T - 1) continue;
            v = t[qy * T + qx];
            if (v < -1e29) continue;
          } else {
            const ix = Math.floor(px), iy = Math.floor(py);
            if (ix < 0 || iy < 0 || ix >= T - 1 || iy >= T - 1) continue;
            const o = iy * T + ix, a = t[o], b = t[o + 1], c = t[o + T], e = t[o + T + 1];
            if (a < -1e29 || b < -1e29 || c < -1e29 || e < -1e29) continue;
            const fx = px - ix, fy = py - iy;
            v = (a + (b - a) * fx) * (1 - fy) + (c + (e - c) * fx) * fy;
          }
          const o = y * N + x;
          if (f.wA > 0) add(A, wa, eA, o, f.wA, v - f.bg);
          if (f.wB > 0) add(B, wb, eB, o, f.wB, v - f.bg);
        }
      }
    }
    const den = Math.asinh((p.diff ? p.hi : p.hi - p.lo) / p.soft);
    for (let o = 0; o < N * N; o++) {
      if (eA.n[o] >= 5) { A[o] -= eA.hv[o] * eA.hw[o] + eA.lv[o] * eA.lw[o]; wa[o] -= eA.hw[o] + eA.lw[o]; }
      if (eB.n[o] >= 5) { B[o] -= eB.hv[o] * eB.hw[o] + eB.lv[o] * eB.lw[o]; wb[o] -= eB.hw[o] + eB.lw[o]; }
      let r = 14, g = 16, b = 24;
      if (wa[o] > 0 && (!p.diff || wb[o] > 0)) {
        if (p.diff) {
          const v = A[o] / wa[o] - B[o] / wb[o];
          const t = Math.min(1, Math.asinh(Math.abs(v) / p.soft) / den);
          const c = v > 0 ? [1.0, 0.72, 0.30] : [0.30, 0.62, 1.0];
          r = 255 * Math.min(1, 0.07 + (c[0] - 0.07) * t + 0.35 * t * t);
          g = 255 * Math.min(1, 0.07 + (c[1] - 0.07) * t + 0.35 * t * t);
          b = 255 * Math.min(1, 0.09 + (c[2] - 0.09) * t + 0.35 * t * t);
        } else {
          let t = Math.min(1, Math.max(0, Math.asinh((A[o] / wa[o] - p.lo) / p.soft) / den));
          if (p.invert) t = 1 - t;
          r = g = b = 255 * t;
        }
      }
      d[o * 4] = r; d[o * 4 + 1] = g; d[o * 4 + 2] = b; d[o * 4 + 3] = 255;
    }
    this.octx.putImageData(this.img, 0, 0);
    this.ctx.imageSmoothingEnabled = !p.nearest;
    this.ctx.drawImage(this.off, 0, 0, cw, this.canvas.height);
  }
}

export async function createRenderer(canvas, T, maxFrames, forceCpu = false) {
  if (!forceCpu) {
    try {
      const r = await GpuRenderer.create(canvas, T, maxFrames);
      if (r) return r;
    } catch (e) { console.warn('WebGPU unavailable, using canvas fallback', e); }
  }
  return new CpuRenderer(canvas, T);
}
