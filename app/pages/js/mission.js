// A live 3D diagram of how SPHEREx maps the sky (WebGPU, with a simple 2D fallback).
//
// Earth sits at the centre. SPHEREx circles it pole to pole along the line between day and night,
// looking straight out. Each lap scans one strip of sky; as Earth moves round the Sun the strip
// shifts about a degree a day, so the whole sky is covered in six months. Sizes are not to scale.
// Code written with an AI assistant; geometry follows NASA's published mission description.

const R_ORBIT = 1.32, R_SKY = 4.2, SIX_MONTHS = 34; // seconds of animation per six-month survey
const BANDS = [[0.36, 0.49, 0.98], [0.22, 0.78, 0.75], [0.56, 0.82, 0.31], [0.96, 0.84, 0.28], [1.0, 0.6, 0.24], [1.0, 0.3, 0.3]];
const HALF_LEN = 0.098, HALF_WID = 0.031; // footprint half-sizes in radians (11.3 x 3.5 degrees)

const WGSL = /* wgsl */ `
struct U { vp: mat4x4f, sun: vec4f, scanN: vec4f, point: vec4f, eye: vec4f, sweep: vec4f };
@group(0) @binding(0) var<uniform> u: U;
struct VO { @builtin(position) pos: vec4f, @location(0) w: vec3f, @location(1) n: vec3f, @location(2) c: vec4f, @location(3) kind: f32 };
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) c: vec4f, @location(3) k: f32) -> VO {
  var o: VO; o.pos = u.vp * vec4f(p, 1); o.w = p; o.n = n; o.c = c; o.kind = k; return o;
}
fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn grid(lon: f32, lat: f32, step: f32, width: f32) -> f32 {
  let a = abs(fract(lon / step + 0.5) - 0.5) * step * cos(lat);
  let b = abs(fract(lat / step + 0.5) - 0.5) * step;
  return 1.0 - smoothstep(0.0, width, min(a, b));
}
const PI = 3.14159265;
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let kind = i32(i.kind + 0.5);
  if (kind == 1) { // the sky, seen from outside: only its far inner surface is drawn
    let d = normalize(i.w);
    if (dot(d, normalize(u.eye.xyz)) > 0.36) { discard; }
    let lon = atan2(d.z, d.x); let lat = asin(clamp(d.y, -1.0, 1.0));
    let a = fract((lon - (u.sweep.x + PI * 0.5)) / PI) * PI;        // angle past the first strip, 0..pi
    let passes = floor(u.sweep.y / PI) + step(a, u.sweep.y - floor(u.sweep.y / PI) * PI);
    var col = vec3f(0.030, 0.031, 0.038) + vec3f(0.060, 0.056, 0.050) * min(passes, 2.0);
    col += vec3f(0.92, 0.90, 0.85) * grid(lon, lat, PI / 12.0, 0.004) * (0.05 + 0.05 * min(passes, 1.0));
    let cell = floor(vec2f(lon, lat) * 30.0); let h = hash(cell);
    if (h > 0.90) {
      let c = (cell + vec2f(hash(cell + 3.1), hash(cell + 7.7))) / 30.0;
      let r = length(vec2f((lon - c.x) * cos(lat), lat - c.y));
      col += vec3f(0.95, 0.92, 0.85) * (1.0 - smoothstep(0.0, 0.007 + 0.006 * hash(cell + 1.3), r)) * (0.16 + 0.75 * min(passes, 1.0));
    }
    let off = dot(d, u.scanN.xyz);                                   // sine of the angle off this lap's strip
    col += vec3f(1.0, 0.35, 0.12) * (1.0 - smoothstep(HW * 0.7, HW * 1.3, abs(off))) * 0.20;
    let t = cross(u.scanN.xyz, u.point.xyz);
    let s = atan2(dot(d, t), dot(d, u.point.xyz));                   // angle along the strip from where it points now
    if (abs(off) < HW && abs(s) < HL) {
      let k = i32(clamp(floor((s / HL * 0.5 + 0.5) * 6.0), 0.0, 5.0));
      col = BAND[k];
    }
    return vec4f(col, 1);
  }
  if (kind == 0) { // Earth: day and night sides
    let n = normalize(i.n);
    let day = smoothstep(-0.08, 0.25, dot(n, u.sun.xyz));
    let lon = atan2(n.z, n.x); let lat = asin(clamp(n.y, -1.0, 1.0));
    var col = mix(vec3f(0.020, 0.030, 0.050), vec3f(0.13, 0.25, 0.40), day);
    col += vec3f(0.92, 0.90, 0.85) * grid(lon, lat, PI / 9.0, 0.012) * (0.05 + 0.10 * day);
    let rim = pow(1.0 - max(dot(n, normalize(u.eye.xyz - i.w)), 0.0), 3.0);
    col += vec3f(0.25, 0.45, 0.70) * rim * (0.15 + 0.5 * day);
    return vec4f(col, 1);
  }
  if (kind == 2) { // spacecraft
    let n = normalize(i.n);
    return vec4f(i.c.rgb * (0.38 + 0.62 * abs(dot(n, u.sun.xyz))), i.c.a);
  }
  return i.c;
}`.replace(/HW/g, HALF_WID.toFixed(4)).replace(/HL/g, HALF_LEN.toFixed(4))
  .replace('const PI', `const BAND = array<vec3f, 6>(${BANDS.map((b) => `vec3f(${b.join(',')})`).join(', ')});\nconst PI`);

// ---------- small vector / matrix helpers (column-major) ----------
const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const mul = (a, b) => { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
function viewProj(eye, aspect) {
  const f = 1 / Math.tan((34 * Math.PI) / 360), near = 0.5, far = 40;
  const P = new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, (far * near) / (near - far), 0]);
  const z = norm(eye), x = norm(cross([0, 1, 0], z)), y = cross(z, x);
  const V = new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
  return mul(P, V);
}
const project = (m, p, W, H) => {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [(x / w * 0.5 + 0.5) * W, (1 - (y / w * 0.5 + 0.5)) * H, w];
};

// ---------- geometry ----------
const V = 11; // floats per vertex: position 3, normal 3, colour 4, kind 1
function sphere(radius, seg, kind) {
  const out = [];
  const pt = (i, j) => { const lat = (j / seg - 0.5) * Math.PI, lon = (i / (seg * 2)) * 2 * Math.PI; const n = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)]; return [n[0] * radius, n[1] * radius, n[2] * radius, ...n, 1, 1, 1, 1, kind]; };
  for (let j = 0; j < seg; j++) for (let i = 0; i < seg * 2; i++) out.push(...pt(i, j), ...pt(i + 1, j), ...pt(i + 1, j + 1), ...pt(i, j), ...pt(i + 1, j + 1), ...pt(i, j + 1));
  return out;
}
// The spacecraft in its own frame: +Z points out to space. Three nested cones are its photon shields.
const CRAFT = (() => {
  const tris = [], N = 28;
  const frustum = (r0, r1, z0, z1, col) => {
    for (let i = 0; i < N; i++) {
      const a = (i / N) * 2 * Math.PI, b = ((i + 1) / N) * 2 * Math.PI, slope = (r1 - r0) / (z1 - z0);
      const p = (ang, r, z) => [r * Math.cos(ang), r * Math.sin(ang), z], n = (ang) => norm([Math.cos(ang), Math.sin(ang), -slope]);
      tris.push([p(a, r0, z0), n(a), col], [p(b, r0, z0), n(b), col], [p(b, r1, z1), n(b), col], [p(a, r0, z0), n(a), col], [p(b, r1, z1), n(b), col], [p(a, r1, z1), n(a), col]);
    }
  };
  const bone = [0.92, 0.90, 0.85, 1], grey = [0.55, 0.54, 0.51, 1], orange = [1, 0.35, 0.12, 1];
  frustum(0.50, 1.00, 0.00, 0.85, bone); frustum(0.36, 0.74, 0.06, 0.78, grey); frustum(0.22, 0.48, 0.12, 0.70, bone);
  frustum(0.30, 0.30, -0.55, 0.00, orange); frustum(0.001, 0.30, -0.56, -0.55, orange);
  return tris;
})();

export async function startMission(host) {
  host.innerHTML = '<canvas></canvas><div class="mlabels"><span data-k="earth">Earth</span><span data-k="craft">SPHEREx</span><span data-k="sun">to the Sun →</span><span data-k="strip">strip scanned this lap</span><span data-k="pole">ecliptic pole: seen on every lap</span></div><div class="mread"><b></b><i></i></div>';
  const canvas = host.querySelector('canvas'), labels = Object.fromEntries([...host.querySelectorAll('.mlabels span')].map((e) => [e.dataset.k, e]));
  const readBig = host.querySelector('.mread b'), readSub = host.querySelector('.mread i');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const state = { yaw: 0.9, pitch: 0.42, t: SIX_MONTHS * 0.22, running: true, last: performance.now(), drag: null };

  let gpu = null;
  try {
    const adapter = navigator.gpu && await navigator.gpu.requestAdapter();
    if (adapter) {
      const device = await adapter.requestDevice(), ctx = canvas.getContext('webgpu'), format = navigator.gpu.getPreferredCanvasFormat();
      ctx.configure({ device, format, alphaMode: 'opaque' });
      const module = device.createShaderModule({ code: WGSL });
      const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
      const mk = (topology) => device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: V * 4, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32x4' }, { shaderLocation: 3, offset: 40, format: 'float32' }] }] },
        fragment: { module, entryPoint: 'fs', targets: [{ format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
        primitive: { topology, cullMode: 'none' }, depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      });
      const staticData = new Float32Array([...sphere(R_SKY, 40, 1), ...sphere(1, 40, 0)]);
      const staticBuf = device.createBuffer({ size: staticData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(staticBuf, 0, staticData);
      const triBuf = device.createBuffer({ size: CRAFT.length * V * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      const lineBuf = device.createBuffer({ size: 600 * V * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      const ubuf = device.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      gpu = { device, ctx, tri: mk('triangle-list'), line: mk('line-list'), staticBuf, staticCount: staticData.length / V, triBuf, lineBuf, ubuf, bind: device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: ubuf } }] }), depth: null };
    }
  } catch (e) { console.warn('3D mission view: WebGPU unavailable, drawing the flat version', e); gpu = null; }
  const ctx2d = gpu ? null : canvas.getContext('2d');

  function frame(now) {
    if (!state.running) return;
    const dt = Math.min(0.1, (now - state.last) / 1000); state.last = now;
    if (!still) { state.t += dt; if (!state.drag) state.yaw += dt * 0.05; }
    const dpr = Math.min(devicePixelRatio || 1, 2), W = host.clientWidth, H = host.clientHeight;
    if (!W || !H) return requestAnimationFrame(frame);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); if (gpu) gpu.depth = null; }

    // where everything is right now
    const cycle = still ? 0.62 : (state.t / SIX_MONTHS) % 2, sweep = cycle * Math.PI, theta0 = 0.6, theta = theta0 + sweep;
    const sun = [Math.cos(theta), 0, Math.sin(theta)];              // direction to the Sun; also the orbit's axis
    const u = [Math.sin(theta), 0, -Math.cos(theta)];               // in the orbit plane, at right angles to the Sun
    const phi = still ? 0.9 : state.t * 2.4;
    const out = [u[0] * Math.cos(phi), Math.sin(phi), u[2] * Math.cos(phi)]; // from Earth's centre through the spacecraft
    const craftPos = out.map((v) => v * R_ORBIT);
    const dist = W < 520 ? 11.5 : 10;
    const eye = [dist * Math.cos(state.pitch) * Math.cos(state.yaw), dist * Math.sin(state.pitch), dist * Math.cos(state.pitch) * Math.sin(state.yaw)];
    const vp = viewProj(eye, W / H);
    const tangent = cross(sun, out);
    const corner = (s, c) => norm(add(add(out.map((v) => v * Math.cos(s) * Math.cos(c)), tangent, Math.sin(s) * Math.cos(c)), sun, Math.sin(c))).map((v) => v * R_SKY);
    const corners = [corner(-HALF_LEN, -HALF_WID), corner(HALF_LEN, -HALF_WID), corner(HALF_LEN, HALF_WID), corner(-HALF_LEN, HALF_WID)];

    const lines = [];
    const seg = (a, b, col) => lines.push(...a, 0, 0, 1, ...col, 3, ...b, 0, 0, 1, ...col, 3);
    for (let i = 0; i < 96; i++) { const a = (i / 96) * 2 * Math.PI, b = ((i + 1) / 96) * 2 * Math.PI; const p = (g) => [u[0] * Math.cos(g) * R_ORBIT, Math.sin(g) * R_ORBIT, u[2] * Math.cos(g) * R_ORBIT]; seg(p(a), p(b), [0.92, 0.90, 0.85, 0.55]); }
    for (const c of corners) seg(craftPos, c, [1, 0.35, 0.12, 0.75]);
    for (let i = 0; i < 4; i++) seg(corners[i], corners[(i + 1) % 4], [1, 0.35, 0.12, 0.9]);
    for (let i = 0; i < 8; i++) seg(sun.map((v) => v * (1.5 + i * 0.3)), sun.map((v) => v * (1.66 + i * 0.3)), [0.96, 0.84, 0.28, 0.9]); // dashes toward the Sun

    if (gpu) {
      const { device } = gpu;
      if (!gpu.depth) gpu.depth = device.createTexture({ size: [canvas.width, canvas.height], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
      const ub = new Float32Array(36); ub.set(vp, 0); ub.set([...sun, 0], 16); ub.set([...sun, 0], 20); ub.set([...out, 0], 24); ub.set([...eye, 0], 28); ub.set([theta0, sweep, state.t, 0], 32);
      device.queue.writeBuffer(gpu.ubuf, 0, ub);
      const X = sun, Y = cross(out, sun), S = 0.17, craft = new Float32Array(CRAFT.length * V);
      CRAFT.forEach(([p, n, col], k) => {
        const w = [craftPos[0] + (X[0] * p[0] + Y[0] * p[1] + out[0] * p[2]) * S, craftPos[1] + (X[1] * p[0] + Y[1] * p[1] + out[1] * p[2]) * S, craftPos[2] + (X[2] * p[0] + Y[2] * p[1] + out[2] * p[2]) * S];
        const wn = [X[0] * n[0] + Y[0] * n[1] + out[0] * n[2], X[1] * n[0] + Y[1] * n[1] + out[1] * n[2], X[2] * n[0] + Y[2] * n[1] + out[2] * n[2]];
        craft.set([...w, ...wn, ...col, 2], k * V);
      });
      device.queue.writeBuffer(gpu.triBuf, 0, craft);
      const ld = new Float32Array(lines); device.queue.writeBuffer(gpu.lineBuf, 0, ld);
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: gpu.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0.043, 0.043, 0.047, 1] }], depthStencilAttachment: { view: gpu.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
      pass.setBindGroup(0, gpu.bind);
      pass.setPipeline(gpu.tri); pass.setVertexBuffer(0, gpu.staticBuf); pass.draw(gpu.staticCount);
      pass.setVertexBuffer(0, gpu.triBuf); pass.draw(CRAFT.length);
      pass.setPipeline(gpu.line); pass.setVertexBuffer(0, gpu.lineBuf); pass.draw(ld.length / V);
      pass.end(); device.queue.submit([enc.finish()]);
    } else {
      // flat fallback: the same scene as plain lines
      const c = ctx2d; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
      const P = (p) => project(vp, p, W, H);
      const [ex, ey] = P([0, 0, 0]), er = Math.abs(P(norm(cross(eye, [0, 1, 0])))[0] - ex);
      c.lineWidth = 1;
      for (let k = 0; k < 24; k++) { // meridians of the sky: lit once mapped
        const lon = (k / 24) * 2 * Math.PI, a = (((lon - (theta0 + Math.PI / 2)) / Math.PI) % 1 + 1) % 1 * Math.PI;
        c.strokeStyle = a <= sweep % Math.PI || sweep >= Math.PI ? 'rgba(235,230,218,.38)' : 'rgba(235,230,218,.08)'; c.beginPath();
        for (let j = 0; j <= 24; j++) { const lat = (j / 24 - 0.5) * Math.PI, p = P([Math.cos(lat) * Math.cos(lon) * R_SKY, Math.sin(lat) * R_SKY, Math.cos(lat) * Math.sin(lon) * R_SKY]); j ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]); }
        c.stroke();
      }
      c.fillStyle = '#12233a'; c.beginPath(); c.arc(ex, ey, er, 0, 7); c.fill(); c.strokeStyle = '#ebe6da'; c.stroke();
      for (let k = 0; k < lines.length; k += 2 * V) { const a = P(lines.slice(k, k + 3)), b = P(lines.slice(k + V, k + V + 3)), col = lines.slice(k + 6, k + 10); c.strokeStyle = `rgba(${col[0] * 255 | 0},${col[1] * 255 | 0},${col[2] * 255 | 0},${col[3]})`; c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }
      const cp = P(craftPos); c.fillStyle = '#ff5a1f'; c.beginPath(); c.arc(cp[0], cp[1], 5, 0, 7); c.fill();
    }

    // labels and the running count
    const place = (k, p, dx, dy) => { const s = project(vp, p, W, H); labels[k].style.transform = `translate(${Math.round(s[0] + dx)}px, ${Math.round(s[1] + dy)}px)`; labels[k].style.opacity = s[2] > 0 && s[0] > 0 && s[0] < W - 40 && s[1] > 8 && s[1] < H - 8 ? 1 : 0; };
    place('earth', [0, -1, 0], -18, 10); place('craft', craftPos, 14, -8); place('sun', sun.map((v) => v * 3.9), 8, -8);
    place('strip', corners[1], 10, -6); place('pole', [0, R_SKY, 0], -90, 14);
    const survey = Math.floor(cycle) + 1, frac = cycle % 1;
    readBig.textContent = `Month ${Math.min(6, Math.floor(frac * 6) + 1)} of survey ${survey}`;
    readSub.textContent = `${Math.round(frac * 100)}% of the sky mapped${survey > 1 ? ' a second time' : ''}`;
    if (!still) requestAnimationFrame(frame);
  }

  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); state.drag = [e.clientX, e.clientY, state.yaw, state.pitch]; });
  canvas.addEventListener('pointermove', (e) => { if (!state.drag || !e.buttons) return; state.yaw = state.drag[2] + (e.clientX - state.drag[0]) * 0.008; state.pitch = Math.max(-1.2, Math.min(1.2, state.drag[3] + (e.clientY - state.drag[1]) * 0.006)); if (still) requestAnimationFrame(frame); });
  canvas.addEventListener('pointerup', () => { state.drag = null; });
  requestAnimationFrame(frame);
  return {
    kind: gpu ? 'webgpu' : 'canvas',
    pause() { state.running = false; },
    resume() { if (!state.running) { state.running = true; state.last = performance.now(); requestAnimationFrame(frame); } },
  };
}
