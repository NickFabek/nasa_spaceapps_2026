import { createRenderer, SENTINEL } from './gpu.js';
import { parseCoords, fmtRa, fmtDec, fmtDate, fmtMonth } from './coords.js';

const $ = (id) => document.getElementById(id);
const PIX = 6.15; // SPHEREx pixel scale, arcsec
const OFF_DETECTOR = 1 << 30;

const DET = {
  1: { color: '#6ea8ff', range: '0.75–1.11' }, 2: { color: '#5fd4c4', range: '1.10–1.65' },
  3: { color: '#a6e06a', range: '1.64–2.42' }, 4: { color: '#f2d24b', range: '2.42–3.82' },
  5: { color: '#f59a4a', range: '3.81–4.42' }, 6: { color: '#ef5d6c', range: '4.41–5.00' },
};
const EPOCH_COLORS = ['#7cc4ff', '#ffb86b', '#b693ff', '#7be0a1', '#ff8fa3', '#e6d36a'];

// [bit, name, meaning, hidden by default]
const FLAGS = [
  [0, 'TRANSIENT', 'Cosmic-ray hit during the exposure', false],
  [1, 'OVERFLOW', 'Saturated', false],
  [2, 'SUR_ERROR', 'On-board processing error', false],
  [6, 'NONFUNC', 'Permanently unusable pixel', true],
  [7, 'DICHROIC', 'Low efficiency (dichroic edge)', false],
  [9, 'MISSING_DATA', 'On-board data lost', true],
  [10, 'HOT', 'Hot pixel', true],
  [11, 'COLD', 'Anomalously low signal', true],
  [14, 'PHANMISS', 'Phantom correction not applied', false],
  [15, 'NONLINEAR', 'Non-linearity correction unreliable', false],
  [17, 'PERSIST', 'Persistent charge from an earlier exposure', false],
  [19, 'OUTLIER', 'Statistical outlier', false],
  [20, 'CROSSTALK', 'Electrical crosstalk', false],
  [21, 'SOURCE', 'Mapped to a known source', false],
  [22, 'GHOST', 'Ghost of a bright source in the image', false],
  [23, 'GHOST_FPA', 'Ghost from another detector', false],
  [24, 'GHOST_EXT', 'Ghost from outside the field', false],
  [25, 'STREAK', 'Satellite streak', false],
  [26, 'BLOOM', 'Blooming around a bright source', false],
  [27, 'SNOWBALL', 'Snowball artifact', false],
  [28, 'HALO', 'Halo of a transient', false],
];
const SUSPECT = [0, 1, 2, 6, 9, 10, 11, 15, 17, 19, 20, 22, 23, 24, 25, 27].reduce((m, b) => m | (1 << b), 0);

// Positions are for late 2026 (proper motion applied).
const PRESETS = [
  { name: "Barnard's Star", ra: 269.44607, dec: 4.77071, fov: 6 },
  { name: 'Epsilon Indi B', ra: 331.0960, dec: -56.8010, fov: 10 },
  { name: 'WISE 0855', ra: 133.7680, dec: -7.2428, fov: 6 },
  { name: 'RW Aurigae', ra: 76.95642, dec: 30.40142, fov: 6 },
  { name: 'R Draconis', ra: 248.16750, dec: 66.75500, fov: 6 },
];

const HINTS = {
  epoch: 'SPHEREx revisits each spot about every six months. Each visit is added into one clean image; press Play to flip between visits and watch for anything that jumps.',
  frame: 'Every single exposure in time order. Useful for spotting artifacts and for objects that change within days.',
  diff: 'One visit minus another. Things that stayed put cancel out; a mover leaves a blue hole next to an orange spot.',
  stack: 'Every exposure is slid along the motion you choose before being added. A moving object sharpens into a point when the motion matches. Drag in the pad.',
};

const S = {
  gen: 0, ra: 0, dec: 0, fov: 6, name: '', frames: [], epochs: [], T: 0, renderer: null,
  bands: new Set([1, 2, 3, 4, 5, 6]), mode: 'epoch', cur: 0, epA: 0, epB: 1,
  vel: [0, 0], padRange: 12, stretch: 2.6, invert: false, nearest: false,
  mask: FLAGS.filter((f) => f[3]).reduce((m, f) => m | (1 << f[0]), OFF_DETECTOR),
  view: 360, center: [0, 0], tRef: 0, playing: false, click: null, spectrum: [],
  activeA: new Set(), activeB: new Set(), curFrame: null,
};
const params = new URLSearchParams(location.search);
const FORCE_CPU = params.get('cpu') === '1';

// ---------- data ----------

async function go(ra, dec, name = '') {
  const gen = ++S.gen;
  Object.assign(S, { ra, dec, name, frames: [], epochs: [], cur: 0, click: null, spectrum: [], center: [0, 0], view: S.fov * 60, curFrame: null });
  stopPlay();
  $('q').value = name || `${ra.toFixed(5)} ${dec.toFixed(5)}`;
  syncUrl();
  setStatus('Searching the SPHEREx archive…');
  drawSpectrum(); updateDetails(); drawTimeline(); requestDraw();

  let res;
  try {
    res = await (await fetch(`api/search?ra=${ra}&dec=${dec}`)).json();
  } catch (e) { res = { error: String(e) }; }
  if (gen !== S.gen) return;
  if (res.error || !res.frames) return setStatus(`Search failed: ${res.error || 'no response'}`);
  if (!res.frames.length) return setStatus('SPHEREx has no public images of this position yet.');

  const half = Math.min(160, Math.ceil(((S.fov * 60) / 2 / PIX) * 1.45) + 3);
  S.T = 2 * half + 1;
  S.frames = res.frames.map((f, idx) => ({ ...f, idx, state: 'pending' }));
  clusterEpochs();
  S.tRef = (S.frames[0].mjd + S.frames.at(-1).mjd) / 2;
  S.epA = S.epochs.length - 1; S.epB = 0;
  fillEpochSelects();

  S.renderer?.destroy?.();
  S.renderer = await createRenderer($('gl'), S.T, S.frames.length, FORCE_CPU);
  if (gen !== S.gen) return;
  $('renderer').textContent = S.renderer.kind === 'webgpu' ? 'Rendering with WebGPU.' : 'WebGPU not available here — using the slower canvas renderer.';
  setStatus('');
  drawTimeline(); updateDetails();

  // Load round-robin across (visit, band) groups so every stack fills in evenly.
  const groups = new Map();
  for (const f of S.frames) {
    const k = `${f.epoch}/${f.det}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  const queue = [];
  for (let i = 0, more = true; more; i++) {
    more = false;
    for (const g of groups.values()) if (g[i]) { queue.push(g[i]); more = true; }
  }
  let next = 0;
  const worker = async () => {
    while (next < queue.length && gen === S.gen) {
      const f = queue[next++];
      await loadFrame(f, half, gen);
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  if (gen === S.gen) { updateProgress(); if (S.click) computeSpectrum(); }
}

async function loadFrame(f, half, gen) {
  try {
    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await fetch(`api/cutout?key=${encodeURIComponent(f.key)}&ra=${S.ra.toFixed(5)}&dec=${S.dec.toFixed(5)}&half=${half}`);
      if (r.ok || r.status === 404 || r.status === 400) break;
      await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
    }
    if (gen !== S.gen) return;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    if (gen !== S.gen) return;
    const n = new DataView(buf).getUint32(0, true);
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
    const px = meta.T * meta.T, o = 4 + n;
    f.meta = meta;
    f.img = new Float32Array(buf.slice(o, o + 4 * px));
    f.flags = new Int32Array(buf.slice(o + 4 * px, o + 8 * px));
    f.mjd = meta.mjd ?? f.mjd;
    const vals = f.img.filter(Number.isFinite).sort();
    f.bg = vals.length ? vals[vals.length >> 1] : 0;
    const dev = vals.map((v) => Math.abs(v - f.bg)).sort();
    f.sig = Math.max(1e-6, 1.4826 * (dev.length ? dev[dev.length >> 1] : 1));
    f.state = 'ok';
    uploadTile(f);
  } catch (e) {
    f.state = 'fail';
    f.error = String(e.message || e);
  }
  updateProgress();
  requestDraw();
  drawTimeline();
  if (S.click) scheduleSpectrum();
}

function uploadTile(f) {
  const out = new Float32Array(f.img.length);
  for (let i = 0; i < out.length; i++) out[i] = (f.flags[i] & S.mask) || !Number.isFinite(f.img[i]) ? SENTINEL : f.img[i];
  S.renderer.setTile(f.idx, out);
}

function clusterEpochs() {
  S.epochs = [];
  let last = -Infinity;
  for (const f of S.frames) {
    if (f.mjd - last > 45) S.epochs.push({ i: S.epochs.length, t0: f.mjd, t1: f.mjd, n: 0 });
    const e = S.epochs.at(-1);
    f.epoch = e.i; e.t1 = f.mjd; e.n++;
    last = f.mjd;
  }
  for (const e of S.epochs) e.label = fmtMonth((e.t0 + e.t1) / 2);
}

const pool = () => S.frames.filter((f) => f.state === 'ok' && S.bands.has(f.det));

// ---------- compositing ----------

function compose() {
  const all = pool();
  let A = [], B = [], caption = '';
  const bandText = S.bands.size === 6 ? 'all bands' : [...S.bands].sort().map((d) => `D${d}`).join('+') || 'no band';
  if (S.mode === 'frame') {
    S.cur = Math.max(0, Math.min(S.cur, all.length - 1));
    const f = all[S.cur];
    if (f) { A = [f]; caption = `${fmtDate(f.mjd)} · band D${f.det} · ${f.meta.wave ? f.meta.wave.um.toFixed(2) + ' µm' : ''} · exposure ${S.cur + 1}/${all.length}`; }
    S.curFrame = f || null;
  } else if (S.mode === 'epoch') {
    const eps = S.epochs.filter((e) => all.some((f) => f.epoch === e.i));
    S.cur = Math.max(0, Math.min(S.cur, eps.length - 1));
    const e = eps[S.cur];
    if (e) { A = all.filter((f) => f.epoch === e.i); caption = `Visit ${S.cur + 1}/${eps.length} · ${e.label} · ${A.length} exposures · ${bandText}`; }
  } else if (S.mode === 'diff') {
    A = all.filter((f) => f.epoch === S.epA); B = all.filter((f) => f.epoch === S.epB);
    caption = `${S.epochs[S.epA]?.label ?? '?'} minus ${S.epochs[S.epB]?.label ?? '?'} · ${bandText}`;
  } else {
    A = all;
    const sp = Math.hypot(...S.vel);
    caption = `${A.length} exposures stacked · motion ${sp.toFixed(1)}″/yr · ${bandText}`;
  }
  if (S.mode !== 'frame') S.curFrame = null;
  const norm = (fs) => {
    const w = fs.map((f) => 1 / (f.sig * f.sig)), sum = w.reduce((a, b) => a + b, 0) || 1;
    return { w: w.map((v) => v / sum), sigma: fs.length ? 1 / Math.sqrt(sum) : NaN };
  };
  const a = norm(A), b = norm(B);
  const list = [];
  const rec = (f, wA, wB) => ({ i: f.idx, px: f.meta.px, py: f.meta.py, J: f.meta.J, wA, wB, dt: f.mjd - S.tRef, bg: f.bg });
  A.forEach((f, k) => list.push(rec(f, a.w[k], 0)));
  B.forEach((f, k) => list.push(rec(f, 0, b.w[k])));
  S.activeA = new Set(A.map((f) => f.idx)); S.activeB = new Set(B.map((f) => f.idx));
  const diff = S.mode === 'diff';
  const sigma = diff ? Math.hypot(a.sigma, b.sigma) : a.sigma;
  return { list, diff, sigma: Number.isFinite(sigma) ? sigma : 1, caption, empty: !A.length || (diff && !B.length) };
}

let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}

function draw() {
  const gl = $('gl');
  if (!S.renderer || !S.frames.length) { drawOverlay(); $('caption').textContent = ''; return; }
  const c = compose();
  const vel = S.mode === 'stack' ? [S.vel[0] / 365.25, S.vel[1] / 365.25] : [0, 0];
  S.renderer.draw({
    frames: c.list, center: S.center, vel, scale: S.view / gl.width,
    lo: -2 * c.sigma, soft: 3 * c.sigma, hi: c.sigma * 10 ** (c.diff ? S.stretch - 0.8 : S.stretch),
    diff: c.diff, invert: S.invert, nearest: S.nearest,
  });
  $('caption').textContent = c.caption;
  drawOverlay();
  drawTimeline();
  if (S.mode === 'frame') updateDetails();
}

// sky offset (arcsec east, north) <-> CSS pixel in the stage
const cssSize = () => $('stage').clientWidth;
const skyToCss = ([e, n]) => { const s = S.view / cssSize(); return [cssSize() / 2 - (e - S.center[0]) / s, cssSize() / 2 - (n - S.center[1]) / s]; };
const cssToSky = ([x, y]) => { const s = S.view / cssSize(); return [(cssSize() / 2 - x) * s + S.center[0], (cssSize() / 2 - y) * s + S.center[1]]; };

function drawOverlay() {
  const cv = $('overlay'), ctx = cv.getContext('2d'), dpr = cv.width / cssSize(), W = cssSize();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, W);
  if (!S.frames.length) return;
  ctx.lineWidth = 1.5; ctx.font = '12px ui-sans-serif, system-ui'; ctx.textBaseline = 'middle';

  // reticle on the requested position
  const [tx, ty] = skyToCss([0, 0]);
  ctx.strokeStyle = 'rgba(124,196,255,.9)';
  ctx.beginPath();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(tx + dx * 14, ty + dy * 14); ctx.lineTo(tx + dx * 26, ty + dy * 26); }
  ctx.stroke();

  // motion arrow over the full time baseline
  if (S.mode === 'stack' && (S.vel[0] || S.vel[1])) {
    const yrs = (S.frames.at(-1).mjd - S.frames[0].mjd) / 365.25;
    const a = skyToCss([-S.vel[0] * yrs / 2, -S.vel[1] * yrs / 2]), b = skyToCss([S.vel[0] * yrs / 2, S.vel[1] * yrs / 2]);
    ctx.strokeStyle = ctx.fillStyle = 'rgba(255,184,107,.95)';
    ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    ctx.beginPath(); ctx.moveTo(...b); ctx.lineTo(b[0] - 9 * Math.cos(ang - 0.4), b[1] - 9 * Math.sin(ang - 0.4));
    ctx.lineTo(b[0] - 9 * Math.cos(ang + 0.4), b[1] - 9 * Math.sin(ang + 0.4)); ctx.fill();
  }

  // spectrum aperture
  if (S.click) {
    const [x, y] = skyToCss(S.click), r = (2 * PIX) / (S.view / W);
    ctx.strokeStyle = 'rgba(255,184,107,.95)';
    ctx.beginPath(); ctx.arc(x, y, Math.max(4, r), 0, 7); ctx.stroke();
  }

  // compass and scale bar
  ctx.strokeStyle = ctx.fillStyle = 'rgba(230,233,242,.85)';
  const cx = W - 34, cy = W - 34;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - 22); ctx.moveTo(cx, cy); ctx.lineTo(cx - 22, cy); ctx.stroke();
  ctx.textAlign = 'center'; ctx.fillText('N', cx, cy - 30); ctx.fillText('E', cx - 30, cy);
  const s = S.view / W;
  const bar = [600, 300, 120, 60, 30, 10, 5].find((b) => b / s < W * 0.3) || 5;
  const bw = bar / s, bx = W - 70 - bw, by = W - 22;
  ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + bw, by); ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by + 4); ctx.moveTo(bx + bw, by - 4); ctx.lineTo(bx + bw, by + 4); ctx.stroke();
  ctx.fillText(bar >= 60 ? `${bar / 60}′` : `${bar}″`, bx + bw / 2, by - 11);
}

// ---------- timeline ----------

let tlLayout = [];
function drawTimeline() {
  const cv = $('timeline'), dpr = devicePixelRatio || 1, W = cv.clientWidth, H = 96;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  tlLayout = [];
  if (!S.epochs.length) return;
  const pad = 12, gap = 22, total = S.frames.length;
  const avail = W - 2 * pad - gap * (S.epochs.length - 1);
  let x = pad;
  ctx.font = '11.5px ui-sans-serif, system-ui'; ctx.textAlign = 'center';
  for (const e of S.epochs) {
    const w = Math.max(40, avail * (e.n / total));
    const seg = { e, x0: x, x1: x + w };
    const active = (S.mode === 'epoch' || S.mode === 'diff') && S.frames.some((f) => f.epoch === e.i && (S.activeA.has(f.idx) || S.activeB.has(f.idx)));
    ctx.fillStyle = active ? 'rgba(124,196,255,.10)' : 'rgba(255,255,255,.03)';
    ctx.beginPath(); ctx.roundRect(x - 4, 6, w + 8, 68, 6); ctx.fill();
    ctx.fillStyle = EPOCH_COLORS[e.i % EPOCH_COLORS.length];
    let label = `${e.label} · ${e.n}`;
    if (S.mode === 'diff') label += e.i === S.epA ? '  (shown)' : e.i === S.epB ? '  (subtracted)' : '';
    ctx.fillText(label, x + w / 2, 88);
    seg.frames = [];
    for (const f of S.frames) {
      if (f.epoch !== e.i) continue;
      const fx = e.t1 > e.t0 ? x + 3 + (w - 6) * ((f.mjd - e.t0) / (e.t1 - e.t0)) : x + w / 2;
      const fy = 12 + (f.det - 1) * 11;
      const on = S.activeA.has(f.idx) || S.activeB.has(f.idx);
      ctx.fillStyle = f.state === 'fail' ? '#555' : DET[f.det].color;
      ctx.globalAlpha = f.state === 'pending' ? 0.18 : on ? 1 : S.bands.has(f.det) ? 0.5 : 0.15;
      ctx.fillRect(fx - (on ? 1.5 : 1), fy - (on ? 4.5 : 3.5), on ? 3 : 2, on ? 9 : 7);
      ctx.globalAlpha = 1;
      seg.frames.push({ f, fx, fy });
    }
    tlLayout.push(seg);
    x += w + gap;
  }
  if (S.mode === 'frame' && S.curFrame) {
    for (const seg of tlLayout) for (const p of seg.frames) if (p.f === S.curFrame) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p.fx, 6); ctx.lineTo(p.fx, 74); ctx.stroke();
    }
  }
}

function timelineClick(ev) {
  const r = $('timeline').getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
  const seg = tlLayout.find((s) => x >= s.x0 - 11 && x <= s.x1 + 11);
  if (!seg) return;
  const all = pool();
  if (S.mode === 'frame') {
    let best = null, bd = Infinity;
    for (const p of seg.frames) {
      const k = all.indexOf(p.f);
      if (k < 0) continue;
      const d = Math.hypot(p.fx - x, (p.fy - y) * 0.6);
      if (d < bd) { bd = d; best = k; }
    }
    if (best !== null) S.cur = best;
  } else if (S.mode === 'diff') {
    if (ev.shiftKey || ev.altKey) S.epB = seg.e.i; else S.epA = seg.e.i;
    fillEpochSelects();
  } else if (S.mode === 'epoch') {
    const eps = S.epochs.filter((e) => all.some((f) => f.epoch === e.i));
    const k = eps.indexOf(seg.e);
    if (k >= 0) S.cur = k;
  }
  requestDraw();
}

// ---------- spectrum ----------

function photometry(f, sky) {
  const { px, py, J, T } = f.meta;
  const dt = f.mjd - S.tRef, v = S.mode === 'stack' ? [S.vel[0] / 365.25, S.vel[1] / 365.25] : [0, 0];
  const sx = sky[0] + v[0] * dt, sy = sky[1] + v[1] * dt;
  const x = px + J[0] * sx + J[1] * sy, y = py + J[2] * sx + J[3] * sy;
  const R = 2, R1 = 4, R2 = 7;
  if (x < R2 || y < R2 || x > T - 1 - R2 || y > T - 1 - R2) return null;
  const ann = [];
  let sum = 0, w2 = 0, area = 0, flags = 0, nan = false;
  for (let j = Math.floor(y - R2); j <= Math.ceil(y + R2); j++)
    for (let i = Math.floor(x - R2); i <= Math.ceil(x + R2); i++) {
      const d = Math.hypot(i - x, j - y), o = j * T + i, val = f.img[o];
      if (d >= R1 && d <= R2) { if (Number.isFinite(val) && !(f.flags[o] & S.mask)) ann.push(val); continue; }
      if (d > R + 0.75) continue;
      let w = 0;
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) if (Math.hypot(i + (a - 1) / 3 - x, j + (b - 1) / 3 - y) <= R) w += 1 / 9;
      if (!w) continue;
      if (!Number.isFinite(val)) { nan = true; continue; }
      sum += w * val; w2 += w * w; area += w;
      if (w > 0.4) flags |= f.flags[o];
    }
  if (ann.length < 10 || !area) return null;
  ann.sort((a, b) => a - b);
  const bg = ann[ann.length >> 1];
  // Empirical noise: scatter of the sky ring around the aperture.
  const dev = ann.map((a) => Math.abs(a - bg)).sort((a, b) => a - b);
  const noise = 1.4826 * dev[dev.length >> 1];
  const k = (f.meta.hdr.OMEGA_MEDIAN || 37.8) * 0.0235044; // MJy/sr per pixel -> mJy
  const w = f.meta.wave || { um: (f.wmin + f.wmax) / 2, bw: 0, dx: 0, dy: 0 };
  const um = w.um + w.dx * (x - px) + w.dy * (y - py);
  return { um, bw: w.bw, flux: (sum - bg * area) * k, err: noise * Math.sqrt(w2) * k, flags, bad: nan || (flags & SUSPECT) !== 0, saturated: nan || (flags & 2) !== 0, epoch: f.epoch, det: f.det, mjd: f.mjd, obs: f.obs };
}

let specTimer = 0;
function scheduleSpectrum() { if (!specTimer) specTimer = setTimeout(() => { specTimer = 0; computeSpectrum(); }, 400); }
function computeSpectrum() {
  S.spectrum = S.click ? S.frames.filter((f) => f.state === 'ok').map((f) => photometry(f, S.click)).filter(Boolean) : [];
  drawSpectrum();
}

function drawSpectrum() {
  const cv = $('spec'), dpr = devicePixelRatio || 1, W = cv.clientWidth, H = 210;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '11px ui-sans-serif, system-ui';
  const pts = S.spectrum, L = 44, Rm = 8, Tm = 16, Bm = 26;
  const X = (um) => L + (W - L - Rm) * ((um - 0.7) / 4.4);
  $('specCsv').disabled = !pts.length;
  if (!S.click) { $('specTitle').textContent = 'click a source in the image'; $('specNote').textContent = ''; }
  else {
    const ra = S.ra + S.click[0] / 3600 / Math.cos(S.dec * Math.PI / 180), dec = S.dec + S.click[1] / 3600;
    $('specTitle').textContent = `${fmtRa(ra)} ${fmtDec(dec)}`;
    const good = pts.filter((p) => !p.bad).length;
    $('specNote').textContent = pts.length ? `${pts.length} measurements, ${pts.length - good} flagged (hollow)` : 'no usable exposures here yet';
  }
  const use = pts.filter((p) => !p.bad).length >= 8 ? pts.filter((p) => !p.bad) : pts;
  const ys = use.map((p) => p.flux).sort((a, b) => a - b);
  let y0 = ys.length ? ys[Math.floor(ys.length * 0.02)] : 0, y1 = ys.length ? ys[Math.ceil(ys.length * 0.98) - 1] : 1;
  y0 = Math.min(y0, 0); if (y1 <= y0) y1 = y0 + 1;
  const padY = (y1 - y0) * 0.12; y0 -= padY; y1 += padY;
  const Y = (v) => Tm + (H - Tm - Bm) * (1 - (v - y0) / (y1 - y0));

  // molecular / atomic features worth knowing about
  ctx.textAlign = 'center';
  for (const [um, label] of [[1.875, 'Pa α'], [3.05, 'H₂O ice'], [3.3, 'CH₄'], [4.05, 'Br α'], [4.27, 'CO₂'], [4.67, 'CO']]) {
    ctx.strokeStyle = 'rgba(255,255,255,.10)'; ctx.beginPath(); ctx.moveTo(X(um), Tm); ctx.lineTo(X(um), H - Bm); ctx.stroke();
    ctx.fillStyle = 'rgba(141,149,171,.9)'; ctx.fillText(label, X(um), 10);
  }
  ctx.strokeStyle = '#2a3042'; ctx.fillStyle = '#8d95ab';
  ctx.strokeRect(L, Tm, W - L - Rm, H - Tm - Bm);
  for (let um = 1; um <= 5; um++) ctx.fillText(um, X(um), H - Bm + 12);
  ctx.fillText('wavelength (µm)', L + (W - L - Rm) / 2, H - 3);
  ctx.textAlign = 'right';
  const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toPrecision(2));
  for (let k = 0; k <= 3; k++) { const v = y0 + (y1 - y0) * (k / 3); ctx.fillText(fmt(v), L - 4, Y(v) + 3); }
  ctx.save(); ctx.translate(10, Tm + (H - Tm - Bm) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('mJy', 0, 0); ctx.restore();
  if (y0 < 0 && y1 > 0) { ctx.strokeStyle = 'rgba(255,255,255,.15)'; ctx.beginPath(); ctx.moveTo(L, Y(0)); ctx.lineTo(W - Rm, Y(0)); ctx.stroke(); }

  ctx.save(); ctx.beginPath(); ctx.rect(L, Tm, W - L - Rm, H - Tm - Bm); ctx.clip();
  for (const p of pts) {
    const c = EPOCH_COLORS[p.epoch % EPOCH_COLORS.length], x = X(p.um), y = Y(p.flux);
    ctx.strokeStyle = ctx.fillStyle = c; ctx.globalAlpha = p.bad ? 0.45 : 0.9;
    if (!p.bad && p.err > 0) { ctx.beginPath(); ctx.moveTo(x, Y(p.flux - p.err)); ctx.lineTo(x, Y(p.flux + p.err)); ctx.stroke(); }
    ctx.beginPath(); ctx.arc(x, y, 2.3, 0, 7); p.bad ? ctx.stroke() : ctx.fill();
  }
  ctx.restore(); ctx.globalAlpha = 1;
  // legend: one colour per visit
  ctx.textAlign = 'left';
  S.epochs.forEach((e, i) => {
    if (!pts.some((p) => p.epoch === e.i)) return;
    ctx.fillStyle = EPOCH_COLORS[e.i % EPOCH_COLORS.length];
    ctx.fillText('● ' + e.label, W - Rm - 78, Tm + 12 + i * 13);
  });
}

function downloadCsv() {
  const rows = ['wavelength_um,bandwidth_um,flux_mJy,flux_err_mJy,mjd,detector,obs_id,flags,suspect'];
  for (const p of [...S.spectrum].sort((a, b) => a.um - b.um))
    rows.push([p.um.toFixed(5), p.bw.toFixed(5), p.flux.toPrecision(6), p.err.toPrecision(4), p.mjd.toFixed(5), p.det, p.obs, p.flags, p.bad ? 1 : 0].join(','));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
  a.download = `spherex_spectrum_${S.ra.toFixed(4)}_${S.dec.toFixed(4)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- UI ----------

function setStatus(t) { $('status').textContent = t; }
function updateProgress() {
  const ok = S.frames.filter((f) => f.state === 'ok').length, fail = S.frames.filter((f) => f.state === 'fail').length;
  const done = ok + fail === S.frames.length;
  $('progress').textContent = S.frames.length ? `${done ? '' : 'Loading '}${ok}/${S.frames.length} exposures${fail ? ` · ${fail} unavailable` : ''}` : '';
  if (S.mode !== 'frame') updateDetails();
}

function updateDetails() {
  const rows = [['Position', `${fmtRa(S.ra)} ${fmtDec(S.dec)}`], ['Degrees', `${S.ra.toFixed(5)}, ${S.dec.toFixed(5)}`]];
  if (S.frames.length) {
    rows.push(['Exposures', `${S.frames.length} in ${S.epochs.length} visit${S.epochs.length > 1 ? 's' : ''}`]);
    rows.push(['Dates', `${fmtDate(S.frames[0].mjd)} → ${fmtDate(S.frames.at(-1).mjd)}`]);
    rows.push(['Releases', [...new Set(S.frames.map((f) => f.rel.toUpperCase()))].join(', ')]);
  }
  const f = S.mode === 'frame' && S.curFrame;
  if (f) {
    const h = f.meta.hdr;
    rows.push(['Exposure', f.obs], ['Taken', (h['DATE-AVG'] || '').replace('T', ' ').slice(0, 19) + ' UTC'],
      ['Band', `D${f.det} (${DET[f.det].range} µm)`],
      ['At target', f.meta.wave ? `${f.meta.wave.um.toFixed(3)} µm ± ${(f.meta.wave.bw / 2).toFixed(3)}` : '—'],
      ['Exposure time', `${h.XPOSURE?.toFixed(0)} s`], ['Quality check', `${h.L2DQAFLG ?? '—'}${h.FINAST ? ' · coarse astrometry' : ''}`],
      ['PSF width', `${h.PSF_FWHM?.toFixed(1)}″`], ['Release', f.rel.toUpperCase()]);
    const warn = ['AURORA_CONT', 'SHUTTLE_GLOW_CONT'].filter((k) => h[k] === true).map((k) => k.replace('_CONT', '').toLowerCase().replace('_', ' '));
    if (warn.length) rows.push(['Contamination', warn.join(', ')]);
  }
  $('details').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${String(v).replace(/</g, '&lt;')}</dd>`).join('');
}

function fillEpochSelects() {
  for (const [id, val] of [['epA', S.epA], ['epB', S.epB]]) {
    $(id).innerHTML = S.epochs.map((e) => `<option value="${e.i}">${e.label}</option>`).join('');
    $(id).value = val;
  }
}

function setMode(mode) {
  S.mode = mode; S.cur = 0; stopPlay();
  for (const b of $('modes').children) b.setAttribute('aria-selected', b.dataset.mode === mode);
  $('modeHint').textContent = HINTS[mode];
  $('diffCtl').hidden = mode !== 'diff';
  $('stackCtl').hidden = mode !== 'stack';
  const canPlay = mode === 'epoch' || mode === 'frame';
  for (const id of ['prev', 'play', 'next', 'speed']) $(id).disabled = !canPlay;
  $('speed').value = mode === 'frame' ? 8 : 2;
  syncUrl(); requestDraw(); drawPad();
  if (S.click) computeSpectrum();
  updateDetails();
}

let timer = 0;
function step(d) {
  const n = S.mode === 'frame' ? pool().length : S.epochs.filter((e) => pool().some((f) => f.epoch === e.i)).length;
  if (n) S.cur = (S.cur + d + n) % n;
  requestDraw();
}
function startPlay() {
  if (S.mode !== 'epoch' && S.mode !== 'frame') return;
  S.playing = true; $('play').textContent = 'Pause';
  clearInterval(timer);
  timer = setInterval(() => step(1), 1000 / +$('speed').value);
}
function stopPlay() { S.playing = false; $('play').textContent = 'Play'; clearInterval(timer); }

function syncUrl() {
  const p = new URLSearchParams();
  p.set('ra', S.ra.toFixed(5)); p.set('dec', S.dec.toFixed(5)); p.set('fov', S.fov);
  if (S.name) p.set('name', S.name);
  if (S.mode !== 'epoch') p.set('mode', S.mode);
  if (S.bands.size < 6) p.set('bands', [...S.bands].sort().join(''));
  if (S.vel[0] || S.vel[1]) { p.set('mue', S.vel[0].toFixed(2)); p.set('mun', S.vel[1].toFixed(2)); }
  for (const k of ['embed', 'cpu']) if (params.get(k)) p.set(k, params.get(k));
  history.replaceState(null, '', '?' + p);
}

function drawBands() {
  $('bands').innerHTML = `<button data-det="0" aria-pressed="${S.bands.size === 6}" style="color:#cfd5e6"><span>All</span></button>` +
    Object.entries(DET).map(([d, v]) => `<button data-det="${d}" aria-pressed="${S.bands.has(+d)}" style="color:${v.color}" title="Detector ${d}: ${v.range} µm"><i></i><span>${v.range} µm</span></button>`).join('');
}

function setVel(e, n) {
  S.vel = [e, n];
  $('muE').value = e.toFixed(2); $('muN').value = n.toFixed(2);
  drawPad(); syncUrl(); requestDraw();
  if (S.click) scheduleSpectrum();
}
function drawPad() {
  const cv = $('pad'), ctx = cv.getContext('2d'), W = cv.width, c = W / 2, R = c - 8;
  ctx.clearRect(0, 0, W, W);
  ctx.strokeStyle = '#232838'; ctx.fillStyle = '#8d95ab'; ctx.font = '10px ui-sans-serif, system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const k of [1, 2 / 3, 1 / 3]) { ctx.beginPath(); ctx.arc(c, c, R * k, 0, 7); ctx.stroke(); }
  ctx.beginPath(); ctx.moveTo(c - R, c); ctx.lineTo(c + R, c); ctx.moveTo(c, c - R); ctx.lineTo(c, c + R); ctx.stroke();
  ctx.fillText('N', c + 7, 9); ctx.fillText('E', 8, c - 8); ctx.fillText(`${S.padRange}″/yr`, W - 22, W - 8);
  const x = c - (S.vel[0] / S.padRange) * R, y = c - (S.vel[1] / S.padRange) * R;
  ctx.strokeStyle = ctx.fillStyle = '#ffb86b'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(x, y); ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, 4.5, 0, 7); ctx.fill(); ctx.lineWidth = 1;
}

function resize() {
  const W = cssSize(), dpr = Math.min(devicePixelRatio || 1, 2), px = Math.max(64, Math.round(W * dpr));
  for (const id of ['gl', 'overlay']) { const cv = $(id); if (cv.width !== px) { cv.width = px; cv.height = px; } }
  requestDraw(); drawTimeline(); drawSpectrum();
}

async function submitQuery(text) {
  const c = parseCoords(text);
  if (c) return go(c.ra, c.dec);
  setStatus(`Looking up “${text}”…`);
  try {
    const r = await (await fetch(`api/resolve?name=${encodeURIComponent(text)}`)).json();
    if (r.error) return setStatus(r.error);
    go(r.ra, r.dec, text);
  } catch (e) { setStatus('Name lookup failed. Try coordinates instead.'); }
}

function bind() {
  $('presets').innerHTML = PRESETS.map((p, i) => `<button data-i="${i}">${p.name}</button>`).join('');
  $('presets').onclick = (ev) => {
    const p = PRESETS[ev.target.dataset?.i];
    if (!p) return;
    S.fov = p.fov; $('fov').value = p.fov;
    go(p.ra, p.dec, p.name);
  };
  $('search').onsubmit = (ev) => { ev.preventDefault(); S.fov = +$('fov').value; const t = $('q').value.trim(); if (t) submitQuery(t); };
  $('fov').onchange = () => { S.fov = +$('fov').value; if (S.frames.length || S.ra) go(S.ra, S.dec, S.name); };
  $('modes').onclick = (ev) => ev.target.dataset.mode && setMode(ev.target.dataset.mode);
  $('bands').onclick = (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    const d = +b.dataset.det;
    if (!d) S.bands = new Set([1, 2, 3, 4, 5, 6]);
    else if (S.bands.size === 6) S.bands = new Set([d]); // first click picks a single band
    else if (S.bands.has(d) && S.bands.size > 1) S.bands.delete(d);
    else S.bands.add(d);
    S.cur = 0; drawBands(); syncUrl(); requestDraw();
  };
  $('flags').innerHTML = FLAGS.map(([bit, name, desc]) => `<label title="${desc}"><input type="checkbox" data-bit="${bit}" ${S.mask & (1 << bit) ? 'checked' : ''}>${name.toLowerCase().replace('_', ' ')}</label>`).join('');
  $('flags').onchange = (ev) => {
    const bit = 1 << +ev.target.dataset.bit;
    S.mask = ev.target.checked ? S.mask | bit : S.mask & ~bit;
    for (const f of S.frames) if (f.state === 'ok') uploadTile(f);
    requestDraw(); if (S.click) computeSpectrum();
  };
  $('stretch').oninput = () => { S.stretch = +$('stretch').value; requestDraw(); };
  $('invert').onchange = () => { S.invert = $('invert').checked; requestDraw(); };
  $('nearest').onchange = () => { S.nearest = $('nearest').checked; requestDraw(); };
  $('epA').onchange = () => { S.epA = +$('epA').value; requestDraw(); };
  $('epB').onchange = () => { S.epB = +$('epB').value; requestDraw(); };
  $('play').onclick = () => (S.playing ? stopPlay() : startPlay());
  $('prev').onclick = () => { stopPlay(); step(-1); };
  $('next').onclick = () => { stopPlay(); step(1); };
  $('speed').oninput = () => S.playing && startPlay();
  $('timeline').onclick = timelineClick;
  $('specCsv').onclick = downloadCsv;
  $('muE').onchange = $('muN').onchange = () => setVel(+$('muE').value || 0, +$('muN').value || 0);
  $('muReset').onclick = () => setVel(0, 0);
  $('padRange').onchange = () => { S.padRange = +$('padRange').value; drawPad(); };

  const pad = $('pad');
  const padSet = (ev) => {
    const r = pad.getBoundingClientRect(), c = r.width / 2, R = c - 8 * (r.width / pad.width);
    setVel(-((ev.clientX - r.left - c) / R) * S.padRange, -((ev.clientY - r.top - c) / R) * S.padRange);
  };
  pad.onpointerdown = (ev) => { pad.setPointerCapture(ev.pointerId); padSet(ev); };
  pad.onpointermove = (ev) => ev.buttons && padSet(ev);

  // image: drag to pan, wheel to zoom, click for a spectrum
  const stage = $('stage');
  let down = null;
  const local = (ev) => { const r = stage.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  stage.onpointerdown = (ev) => { stage.setPointerCapture(ev.pointerId); down = { p: local(ev), c: [...S.center], moved: false }; };
  stage.onpointermove = (ev) => {
    const p = local(ev);
    if (down && ev.buttons) {
      const dx = p[0] - down.p[0], dy = p[1] - down.p[1];
      if (Math.hypot(dx, dy) > 4) down.moved = true;
      if (down.moved) { const s = S.view / cssSize(); S.center = [down.c[0] + dx * s, down.c[1] + dy * s]; requestDraw(); }
    }
    readout(p);
  };
  stage.onpointerup = (ev) => {
    if (down && !down.moved && S.frames.length) { S.click = cssToSky(local(ev)); computeSpectrum(); requestDraw(); }
    down = null;
  };
  stage.onpointerleave = () => { $('readout').textContent = ''; };
  stage.ondblclick = () => { S.center = [0, 0]; S.view = S.fov * 60; requestDraw(); };
  stage.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const p = local(ev), before = cssToSky(p);
    S.view = Math.min(S.fov * 60, Math.max(20, S.view * Math.exp(ev.deltaY * 0.0015)));
    const after = cssToSky(p);
    S.center = [S.center[0] + before[0] - after[0], S.center[1] + before[1] - after[1]];
    requestDraw();
  }, { passive: false });

  addEventListener('keydown', (ev) => {
    if (/INPUT|SELECT|TEXTAREA/.test(ev.target.tagName)) return;
    if (ev.key === ' ') { ev.preventDefault(); S.playing ? stopPlay() : startPlay(); }
    if (ev.key === 'ArrowRight') { stopPlay(); step(1); }
    if (ev.key === 'ArrowLeft') { stopPlay(); step(-1); }
  });
  new ResizeObserver(resize).observe(stage);
}

function readout(p) {
  if (!S.frames.length) return;
  const [e, n] = cssToSky(p);
  const ra = S.ra + e / 3600 / Math.cos(S.dec * Math.PI / 180), dec = S.dec + n / 3600;
  let text = `${fmtRa(ra)}  ${fmtDec(dec)}`;
  const f = S.curFrame;
  if (S.mode === 'frame' && f) {
    const { px, py, J, T } = f.meta;
    const x = Math.round(px + J[0] * e + J[1] * n), y = Math.round(py + J[2] * e + J[3] * n);
    if (x >= 0 && y >= 0 && x < T && y < T) {
      const v = f.img[y * T + x], fl = f.flags[y * T + x];
      const names = FLAGS.filter(([b]) => fl & (1 << b)).map(([, name]) => name.toLowerCase());
      text += `\n${Number.isFinite(v) ? v.toFixed(2) + ' MJy/sr' : 'no data'}${names.length ? ' · ' + names.join(', ') : ''}`;
    }
  }
  $('readout').textContent = text;
}

function init() {
  if (params.get('embed')) document.body.classList.add('embed');
  const fov = +params.get('fov');
  if ([3, 6, 10, 15, 20].includes(fov)) { S.fov = fov; $('fov').value = fov; }
  if (params.get('bands')) { const b = [...params.get('bands')].map(Number).filter((d) => DET[d]); if (b.length) S.bands = new Set(b); }
  if (params.get('mue') || params.get('mun')) S.vel = [+params.get('mue') || 0, +params.get('mun') || 0];
  bind(); drawBands();
  $('muE').value = S.vel[0]; $('muN').value = S.vel[1];
  setMode(['epoch', 'frame', 'diff', 'stack'].includes(params.get('mode')) ? params.get('mode') : 'epoch');
  resize();
  const ra = parseFloat(params.get('ra')), dec = parseFloat(params.get('dec'));
  if (Number.isFinite(ra) && Number.isFinite(dec)) go(ra, dec, params.get('name') || '');
  else { const p = PRESETS[0]; go(p.ra, p.dec, p.name); }
}
init();
