import { createRenderer, SENTINEL } from './gpu.js';
import { parseCoords, fmtRa, fmtDec, fmtDate, fmtMonth } from './coords.js';

const $ = (id) => document.getElementById(id);
const PIX = 6.15; // SPHEREx pixel scale, arcsec
const OFF_DETECTOR = 1 << 30;
const MONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace';
const BONE = '#ebe6da', SIGNAL = '#ff5a1f', GAIA = '#74d4ff', DIM = '#98948b';

// The six detectors, coloured like a spectrum plate from short to long wavelength.
const DET = {
  1: { color: '#5b7cfa', lo: 0.75, hi: 1.11 }, 2: { color: '#37c6c0', lo: 1.11, hi: 1.64 },
  3: { color: '#8fd14f', lo: 1.64, hi: 2.42 }, 4: { color: '#f5d547', lo: 2.42, hi: 3.82 },
  5: { color: '#ff9a3c', lo: 3.82, hi: 4.42 }, 6: { color: '#ff4d4d', lo: 4.42, hi: 5.00 },
};
const PASS_COLORS = [BONE, SIGNAL, GAIA, '#b79cff', '#8fd14f', '#f5d547'];

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

// Practice targets. Positions are for late 2026 (proper motion applied).
const PRESETS = [
  { name: "Barnard's Star", why: 'Fastest-moving star in the sky', ra: 269.44607, dec: 4.77071, fov: 6 },
  { name: 'WISE 0855', why: 'A −25 °C brown dwarf at the very edge of what SPHEREx can see', ra: 133.7680, dec: -7.2428, fov: 6 },
  { name: 'Epsilon Indi B', why: 'Two brown dwarfs circling a nearby star', ra: 331.0960, dec: -56.8010, fov: 10 },
  { name: 'R Draconis', why: 'A star that swells and fades over months', ra: 248.16722, dec: 66.75503, fov: 6 },
  { name: 'RW Aurigae', why: 'A young star that flickers unpredictably', ra: 76.95659, dec: 30.40129, fov: 6 },
];

const S = {
  gen: 0, partial: false, ra: 0, dec: 0, fov: 6, name: '', frames: [], epochs: [], T: 0, renderer: null, loaded: false,
  bands: new Set([1, 2, 3, 4, 5, 6]), mode: 'epoch', cur: 0, epA: 0, epB: 0,
  vel: [0, 0], padRange: 12, stretch: 2.6, invert: false, nearest: false, showGaia: true, wise: true,
  mask: FLAGS.filter((f) => f[3]).reduce((m, f) => m | (1 << f[0]), OFF_DETECTOR),
  view: 360, center: [0, 0], tRef: 0, viewMjd: 0, playing: false, click: null, spectrum: [], gaia: null,
  activeA: new Set(), activeB: new Set(), curFrame: null, randomTries: 0,
};
const params = new URLSearchParams(location.search);
window.driftscope = S; // handy in the console
const FORCE_CPU = params.get('cpu') === '1';
const cosDec = () => Math.cos(S.dec * Math.PI / 180);

// ---------- loading a field ----------

async function go(ra, dec, name = '', random = false) {
  const gen = ++S.gen;
  if (!random) S.randomTries = 0;
  Object.assign(S, { ra, dec, name, frames: [], epochs: [], cur: 0, curEp: -1, epUser: false, click: null, spectrum: [], gaia: null, loaded: false, center: [0, 0], view: S.fov * 60, curFrame: null });
  stopPlay();
  $('intro').hidden = true;
  $('q').value = name || `${ra.toFixed(5)} ${dec.toFixed(5)}`;
  syncUrl(); renderInspect(); updateProgress(); drawTimeline(); requestDraw();
  setStatus('Searching the SPHEREx archive…');

  let res;
  try { res = await (await fetch(`api/search?ra=${ra}&dec=${dec}`)).json(); } catch (e) { res = { error: String(e) }; }
  if (gen !== S.gen) return;
  if (res.error || !res.frames) return setStatus(`The archive did not answer. Try again in a moment.\n${res.error || ''}`);
  if (!res.frames.length) {
    if (random && S.randomTries++ < 4) return randomPatch();
    return setStatus('SPHEREx has no public images of this spot yet.');
  }
  S.partial = !!res.errors?.length;

  const half = Math.min(160, Math.ceil(((S.fov * 60) / 2 / PIX) * 1.45) + 3);
  S.T = 2 * half + 1;
  const wise = [1, 2].map((band) => ({ src: 'WISE', band, det: band === 1 ? 4 : 6, mjd: 55366, rel: 'allwise', obs: `AllWISE W${band}` }));
  S.frames = [...wise, ...res.frames.map((f) => ({ ...f, src: 'SPX' }))].map((f, idx) => ({ ...f, idx, state: 'pending' }));
  clusterEpochs();
  const spx = S.frames.filter((f) => f.src === 'SPX');
  S.tRef = (spx[0].mjd + spx.at(-1).mjd) / 2;
  S.viewMjd = S.tRef;
  const passes = S.epochs.filter((e) => e.src === 'SPX');
  S.epA = passes.at(-1).i; S.epB = passes[0].i;
  fillEpochSelects();

  S.renderer?.destroy?.();
  S.renderer = await createRenderer($('gl'), S.T, S.frames.length, FORCE_CPU);
  if (gen !== S.gen) return;
  $('renderer').textContent = S.renderer.kind === 'webgpu' ? '' : 'This browser has no WebGPU, so the slower fallback renderer is in use.';
  setStatus('');
  drawTimeline(); updateProgress();
  loadGaia(gen);

  // Load round-robin across (pass, band) groups so every stack fills in evenly.
  const groups = new Map();
  for (const f of spx) {
    const k = `${f.epoch}/${f.det}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  const queue = S.frames.filter((f) => f.src === 'WISE');
  for (let i = 0, more = true; more; i++) {
    more = false;
    for (const g of groups.values()) if (g[i]) { queue.push(g[i]); more = true; }
  }
  let next = 0;
  const worker = async () => { while (next < queue.length && gen === S.gen) await loadFrame(queue[next++], half, gen); };
  await Promise.all(Array.from({ length: 16 }, worker));
  if (gen !== S.gen) return;
  S.loaded = true;
  matchWise(); updateProgress(); requestDraw();
  if (S.click) computeSpectrum();
}

async function loadFrame(f, half, gen) {
  try {
    const pos = `ra=${S.ra.toFixed(5)}&dec=${S.dec.toFixed(5)}&half=${half}`;
    const url = f.src === 'WISE'
      ? `api/wise?${pos}&scale=${((S.fov * 60 * 1.1) / S.T).toFixed(3)}&band=${f.band}`
      : `api/cutout?key=${encodeURIComponent(f.key)}&${pos}`;
    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await fetch(url);
      if (r.ok || r.status === 404 || r.status === 400) break;
      await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
    }
    if (gen !== S.gen) return;
    if (r.status === 204) throw new Error('not on this image');
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
    if (!vals.length) throw new Error('empty');
    f.bg = vals[vals.length >> 1];
    const dev = vals.map((v) => Math.abs(v - f.bg)).sort();
    f.sig = Math.max(1e-6, 1.4826 * dev[dev.length >> 1]);
    f.p99 = Math.max(f.sig, vals[Math.floor(vals.length * 0.995)] - f.bg);
    f.state = 'ok';
    if (f.src === 'WISE') { f.raw = f.img; f.rawStats = [f.bg, f.sig, f.p99]; matchWise(); } else uploadTile(f);
  } catch (e) {
    f.state = 'fail';
    f.error = String(e.message || e);
  }
  const done = S.frames.filter((x) => x.state !== 'pending').length;
  if (done % 24 === 0) matchWise();
  updateProgress(); requestDraw(); drawTimeline();
  if (S.click) scheduleSpectrum();
}

// WISE counts are in different units; scale them so stars look as bright as in the matching SPHEREx band.
function matchWise() {
  for (const f of S.frames) {
    if (f.src !== 'WISE' || f.state !== 'ok') continue;
    const [bg, sig, p99] = f.rawStats;
    let ref = S.frames.filter((x) => x.src === 'SPX' && x.state === 'ok' && x.det === f.det);
    if (!ref.length) ref = S.frames.filter((x) => x.src === 'SPX' && x.state === 'ok');
    const p = ref.map((x) => x.p99).sort((a, b) => a - b);
    const k = p.length ? p[p.length >> 1] / p99 : 1;
    f.img = f.raw.map((v) => (v - bg) * k);
    f.bg = 0; f.sig = sig * k;
    uploadTile(f);
  }
}

function uploadTile(f) {
  const out = new Float32Array(f.img.length);
  for (let i = 0; i < out.length; i++) out[i] = (f.flags[i] & S.mask) || !Number.isFinite(f.img[i]) ? SENTINEL : f.img[i];
  S.renderer.setTile(f.idx, out);
}

function clusterEpochs() {
  S.epochs = [];
  let last = -Infinity, k = 0;
  for (const f of S.frames) {
    if (f.mjd - last > 45) S.epochs.push({ i: S.epochs.length, t0: f.mjd, t1: f.mjd, n: 0, src: f.src });
    const e = S.epochs.at(-1);
    f.epoch = e.i; e.t1 = f.mjd; e.n++;
    last = f.mjd;
  }
  for (const e of S.epochs) {
    e.label = e.src === 'WISE' ? '2010' : fmtMonth((e.t0 + e.t1) / 2);
    e.k = e.src === 'SPX' ? k++ : -1;
    e.color = e.src === 'WISE' ? DIM : PASS_COLORS[e.k % PASS_COLORS.length];
  }
}

async function loadGaia(gen) {
  try {
    const r = Math.min(900, Math.round((S.fov * 60) / 2 * 1.45));
    const res = await (await fetch(`api/gaia?ra=${S.ra.toFixed(4)}&dec=${S.dec.toFixed(4)}&r=${r}`)).json();
    if (gen !== S.gen || !res.stars) return;
    S.gaia = res.stars.map((s) => {
      let dra = s.ra - S.ra;
      if (dra > 180) dra -= 360; if (dra < -180) dra += 360;
      const pe = (s.pmra || 0) / 1000, pn = (s.pmdec || 0) / 1000;
      return { ...s, e0: dra * cosDec() * 3600, n0: (s.dec - S.dec) * 3600, pe, pn, pm: Math.hypot(pe, pn) };
    });
    requestDraw();
    if (S.click) renderInspect();
  } catch (e) { /* the overlay is optional */ }
}
// Offset of a Gaia star from the field centre (arcsec east, north) on a given date.
const gaiaAt = (s, mjd) => { const yr = (mjd - 57388.5) / 365.25; return [s.e0 + s.pe * yr, s.n0 + s.pn * yr]; };

const pool = () => S.frames.filter((f) => f.state === 'ok' && S.bands.has(f.det) && (f.src === 'SPX' || (S.wise && S.mode === 'epoch')));

// ---------- compositing ----------

function bandText() {
  if (S.bands.size === 6) return 'all six bands';
  const d = [...S.bands].sort();
  const contiguous = d.every((v, i) => !i || v === d[i - 1] + 1);
  return contiguous ? `${DET[d[0]].lo}–${DET[d.at(-1)].hi} µm` : d.map((v) => `${DET[v].lo}–${DET[v].hi}`).join(' + ') + ' µm';
}

function compose() {
  const all = pool();
  let A = [], B = [], big = '', sub = '';
  const mean = (fs) => fs.reduce((a, f) => a + f.mjd, 0) / (fs.length || 1);
  S.viewMjd = S.tRef;
  if (S.mode === 'frame') {
    S.cur = Math.max(0, Math.min(S.cur, all.length - 1));
    const f = all[S.cur];
    if (f) {
      A = [f]; S.viewMjd = f.mjd;
      big = fmtDate(f.mjd);
      sub = `exposure ${S.cur + 1} of ${all.length} · ${f.meta.wave ? f.meta.wave.um.toFixed(2) : '?'} µm`;
    }
    S.curFrame = f || null;
  } else if (S.mode === 'epoch') {
    const eps = S.epochs.filter((e) => all.some((f) => f.epoch === e.i));
    const e = (S.epUser && eps.find((x) => x.i === S.curEp)) || eps.find((x) => x.src === 'SPX') || eps[0];
    S.cur = eps.indexOf(e);
    if (e) {
      S.curEp = e.i;
      A = all.filter((f) => f.epoch === e.i); S.viewMjd = mean(A);
      big = e.label;
      sub = e.src === 'WISE' ? `WISE telescope · ${A.map((f) => f.meta.um).join(' + ')} µm · pass ${S.cur + 1} of ${eps.length}`
        : `pass ${S.cur + 1} of ${eps.length} · ${A.length} exposures · ${bandText()}`;
    }
  } else if (S.mode === 'diff') {
    A = all.filter((f) => f.epoch === S.epA); B = all.filter((f) => f.epoch === S.epB);
    if (A.length) S.viewMjd = mean(A);
    big = `${S.epochs[S.epA]?.label ?? ''} − ${S.epochs[S.epB]?.label ?? ''}`;
    sub = `orange appeared · blue vanished · ${bandText()}`;
  } else {
    A = all;
    const sp = Math.hypot(...S.vel);
    big = `${A.length} stacked`;
    sub = sp ? `sliding ${sp.toFixed(1)}″ per year · ${bandText()}` : `no motion yet — drag the dial · ${bandText()}`;
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
  return { list, diff, sigma: Number.isFinite(sigma) ? sigma : 1, big, sub };
}

let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}

function draw() {
  const gl = $('gl');
  if (!S.renderer || !S.frames.length) { drawOverlay(); $('stampBig').textContent = $('stampSub').textContent = ''; return; }
  const c = compose();
  const vel = S.mode === 'stack' ? [S.vel[0] / 365.25, S.vel[1] / 365.25] : [0, 0];
  S.renderer.draw({
    frames: c.list, center: S.center, vel, scale: S.view / gl.width,
    lo: -2 * c.sigma, soft: 3 * c.sigma, hi: c.sigma * 10 ** (c.diff ? S.stretch - 0.8 : S.stretch),
    diff: c.diff, invert: S.invert, nearest: S.nearest,
  });
  $('stampBig').textContent = c.big; $('stampSub').textContent = c.sub;
  drawOverlay();
  drawTimeline();
  if (S.mode === 'frame') updateDetails();
}

// sky offset (arcsec east, north) <-> CSS pixel in the stage
const cssSize = () => $('stage').clientWidth;
const skyToCss = ([e, n]) => { const s = S.view / cssSize(); return [cssSize() / 2 - (e - S.center[0]) / s, cssSize() / 2 - (n - S.center[1]) / s]; };
const cssToSky = ([x, y]) => { const s = S.view / cssSize(); return [(cssSize() / 2 - x) * s + S.center[0], (cssSize() / 2 - y) * s + S.center[1]]; };

function drawOverlay() {
  const cv = $('overlay'), ctx = cv.getContext('2d'), W = cssSize(), dpr = cv.width / W;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, W);
  if (!S.frames.length) return;
  const s = S.view / W, ink = S.invert && S.mode !== 'diff' ? '#111' : BONE;
  ctx.font = `11.5px ${MONO}`; ctx.textBaseline = 'middle';

  // every star Gaia already knows, where it was on the date being shown
  if (S.showGaia && S.gaia) {
    const r = Math.min(15, Math.max(5, (PIX * 0.85) / s));
    let drawn = 0;
    ctx.strokeStyle = ctx.fillStyle = S.invert && S.mode !== 'diff' ? '#0a7fb8' : GAIA;
    for (const st of S.gaia) { // brightest first; crowded fields only get their brightest stars ringed
      if (st.g > 18 || drawn >= 140) break;
      const [x, y] = skyToCss(gaiaAt(st, S.viewMjd));
      if (x < -r || y < -r || x > W + r || y > W + r) continue;
      drawn++;
      const fast = st.pm > 0.15;
      ctx.globalAlpha = fast ? 1 : Math.min(0.8, Math.max(0.35, (19 - st.g) / 8));
      ctx.lineWidth = fast ? 2 : 1;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke();
      if (fast) { ctx.textAlign = 'left'; ctx.fillText(`${st.pm.toFixed(1)}″/yr`, x + r + 5, y); }
    }
    ctx.globalAlpha = 1;
  }

  // the requested position
  const [tx, ty] = skyToCss([0, 0]);
  ctx.strokeStyle = ink; ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(tx + dx * 16, ty + dy * 16); ctx.lineTo(tx + dx * 28, ty + dy * 28); }
  ctx.stroke();

  // how far, and which way, the chosen motion carries something across the SPHEREx time span
  // (drawn in the corner, to true scale, so it never hides the thing being looked for)
  if (S.mode === 'stack' && (S.vel[0] || S.vel[1])) {
    const spx = S.frames.filter((f) => f.src === 'SPX'), yrs = (spx.at(-1).mjd - spx[0].mjd) / 365.25;
    const dx = (-S.vel[0] * yrs) / s, dy = (-S.vel[1] * yrs) / s, len = Math.hypot(dx, dy);
    const ox = W - 44, oy = 44, k = Math.min(1, 30 / (len / 2 || 1));
    const a = [ox - (dx / 2) * k, oy - (dy / 2) * k], b = [ox + (dx / 2) * k, oy + (dy / 2) * k];
    ctx.strokeStyle = ctx.fillStyle = SIGNAL; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    ctx.beginPath(); ctx.moveTo(b[0] + 6 * Math.cos(ang), b[1] + 6 * Math.sin(ang));
    ctx.lineTo(b[0] - 7 * Math.cos(ang - 0.5), b[1] - 7 * Math.sin(ang - 0.5));
    ctx.lineTo(b[0] - 7 * Math.cos(ang + 0.5), b[1] - 7 * Math.sin(ang + 0.5)); ctx.fill();
    ctx.textAlign = 'center'; ctx.fillText(`${(Math.hypot(...S.vel) * yrs).toFixed(0)}″ in ${yrs.toFixed(1)} yr`, Math.min(ox, W - 62), oy + 44);
  }

  // the spot being inspected
  if (S.click) {
    const [x, y] = skyToCss(S.click), r = Math.max(7, (2 * PIX) / s);
    ctx.strokeStyle = SIGNAL; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke();
  }

  // compass and scale
  ctx.strokeStyle = ctx.fillStyle = ink; ctx.lineWidth = 1.5; ctx.textAlign = 'center';
  const cx = W - 30, cy = W - 30;
  ctx.beginPath(); ctx.moveTo(cx, cy - 22); ctx.lineTo(cx, cy); ctx.lineTo(cx - 22, cy); ctx.stroke();
  ctx.fillText('N', cx, cy - 31); ctx.fillText('E', cx - 31, cy);
  const bar = [600, 300, 120, 60, 30, 10, 5].find((b) => b / s < W * 0.28) || 5;
  const bw = bar / s, bx = W - 74 - bw, by = W - 22;
  ctx.beginPath(); ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by - 4); ctx.stroke();
  ctx.fillText(bar >= 60 ? `${bar / 60} arcmin` : `${bar} arcsec`, bx + bw / 2, by - 12);
}

// ---------- timeline: one dot per exposure ----------

let tlLayout = [];
function drawTimeline() {
  const cv = $('timeline'), dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  tlLayout = [];
  if (!S.epochs.length) return;
  const eps = S.epochs.filter((e) => e.src === 'SPX' || S.wise);
  const pad = 14, gap = 20, wiseW = 46;
  const nSpx = S.frames.filter((f) => f.src === 'SPX').length;
  const fixed = eps.filter((e) => e.src === 'WISE').length * wiseW;
  const avail = W - 2 * pad - gap * (eps.length - 1) - fixed;
  let x = pad;
  ctx.font = `600 11px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  for (const e of eps) {
    const w = e.src === 'WISE' ? wiseW : Math.max(36, avail * (e.n / nSpx));
    const seg = { e, x0: x, x1: x + w, frames: [] };
    const isA = S.frames.some((f) => f.epoch === e.i && S.activeA.has(f.idx)), isB = S.frames.some((f) => f.epoch === e.i && S.activeB.has(f.idx));
    const grouped = S.mode === 'epoch' || S.mode === 'diff';
    if (grouped && (isA || isB)) { ctx.fillStyle = isA ? SIGNAL : '#4d9dff'; ctx.fillRect(x, H - 21, w, 2); }
    ctx.fillStyle = grouped && (isA || isB) ? BONE : DIM;
    ctx.fillText(e.src === 'WISE' ? 'WISE' : e.label.toUpperCase(), x + w / 2, H - 6);
    for (const f of S.frames) {
      if (f.epoch !== e.i) continue;
      const fx = e.src === 'WISE' ? x + w / 2 + (f.band === 1 ? -7 : 7) : e.t1 > e.t0 ? x + 4 + (w - 8) * ((f.mjd - e.t0) / (e.t1 - e.t0)) : x + w / 2;
      const fy = 9 + (f.det - 1) * 9;
      const on = S.activeA.has(f.idx) || S.activeB.has(f.idx);
      ctx.fillStyle = ctx.strokeStyle = f.state === 'fail' ? '#444' : DET[f.det].color;
      ctx.globalAlpha = on ? 1 : S.bands.has(f.det) ? 0.5 : 0.16;
      ctx.beginPath(); ctx.arc(fx, fy, on ? 2.8 : 2, 0, 7);
      if (f.state === 'pending') { ctx.globalAlpha *= 0.6; ctx.lineWidth = 1; ctx.stroke(); } else ctx.fill();
      ctx.globalAlpha = 1;
      seg.frames.push({ f, fx, fy });
    }
    tlLayout.push(seg);
    x += w + gap;
  }
  if (S.mode === 'frame' && S.curFrame) {
    for (const seg of tlLayout) for (const p of seg.frames) if (p.f === S.curFrame) {
      ctx.strokeStyle = BONE; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p.fx, 3); ctx.lineTo(p.fx, H - 24); ctx.stroke();
    }
  }
}

function timelineClick(ev) {
  const r = $('timeline').getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
  const seg = tlLayout.find((s) => x >= s.x0 - 10 && x <= s.x1 + 10);
  if (!seg) return;
  stopPlay();
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
    if (seg.e.src !== 'SPX') return;
    if (ev.shiftKey || ev.altKey) S.epB = seg.e.i; else S.epA = seg.e.i;
    fillEpochSelects();
  } else if (S.mode === 'epoch') {
    if (all.some((f) => f.epoch === seg.e.i)) { S.epUser = true; S.curEp = seg.e.i; }
  }
  requestDraw();
}

// ---------- inspecting one spot: identity + spectrum ----------

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
  S.spectrum = S.click ? S.frames.filter((f) => f.state === 'ok' && f.src === 'SPX').map((f) => photometry(f, S.click)).filter(Boolean) : [];
  drawSpectrum();
}

const clickRaDec = () => [S.ra + S.click[0] / 3600 / cosDec(), S.dec + S.click[1] / 3600];

function nearestGaia() {
  if (!S.gaia || !S.click) return null;
  let best = null, bd = 8; // arcsec: a little over one SPHEREx pixel
  for (const st of S.gaia) {
    const [e, n] = gaiaAt(st, S.viewMjd), d = Math.hypot(e - S.click[0], n - S.click[1]);
    if (d < bd) { bd = d; best = st; }
  }
  return best;
}

function renderInspect() {
  $('inspectEmpty').hidden = !!S.click;
  $('inspectBody').hidden = !S.click;
  if (!S.click) return;
  const [ra, dec] = clickRaDec();
  $('whereText').textContent = `${fmtRa(ra)}  ${fmtDec(dec)}`;
  const st = nearestGaia();
  const links = `<a href="https://simbad.cds.unistra.fr/simbad/sim-coo?Coord=${ra.toFixed(5)}+${dec >= 0 ? '%2B' : ''}${dec.toFixed(5)}&Radius=20&Radius.unit=arcsec" target="_blank" rel="noopener">Look up in SIMBAD ↗</a>`
    + `<a href="https://byw.tools/wiseview#ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}&size=176&band=3" target="_blank" rel="noopener">Open in WiseView ↗</a>`;
  let html;
  if (!S.gaia) {
    html = `<h3>Checking the catalogue…</h3><div class="acts">${links}</div>`;
  } else if (st) {
    const bits = [`brightness G ${st.g.toFixed(1)}`];
    if (st.pm > 0.005) bits.push(`moves <b>${st.pm.toFixed(st.pm >= 1 ? 1 : 2)}″ a year</b>`);
    if (st.plx > 1) bits.push(`about <b>${Math.round(3261.56 / st.plx).toLocaleString()} light-years</b> away`);
    html = `<h3>Known star</h3><p>Gaia DR3 ${st.id}<br>${bits.join(' · ')}</p>`
      + `<div class="acts">${st.pm > 0.05 ? '<button id="follow">Stack along its motion</button>' : ''}${links}</div>`;
  } else {
    html = `<h3 class="new">Not in Gaia</h3><p>No catalogued star within 8″. It could be a galaxy, something too cool or faint for Gaia, an image artifact — or new. <b>Does it move when you blink?</b></p>`
      + `<div class="acts"><button id="report">Copy a report</button>${links}</div>`;
  }
  $('verdict').innerHTML = html;
  const f = $('follow'), rep = $('report');
  if (f) f.onclick = () => { if (st.pm > S.padRange) { S.padRange = 40; $('padRange').value = 40; } setMode('stack'); setVel(st.pe, st.pn); };
  if (rep) rep.onclick = () => {
    const spx = S.frames.filter((x) => x.src === 'SPX');
    const text = `Possible uncatalogued source in SPHEREx\nRA ${ra.toFixed(5)}  Dec ${dec.toFixed(5)} (deg, ICRS)\n${fmtRa(ra)} ${fmtDec(dec)}\nNo Gaia DR3 source within 8 arcsec.\nSPHEREx exposures: ${spx.length}, ${fmtDate(spx[0].mjd)} to ${fmtDate(spx.at(-1).mjd)}`
      + `${S.vel[0] || S.vel[1] ? `\nTrial motion: ${S.vel[0].toFixed(2)} E, ${S.vel[1].toFixed(2)} N arcsec/yr` : ''}\n${location.href}`;
    copy(text, rep, 'Copied');
  };
}

function drawSpectrum() {
  if (!S.click) return;
  const cv = $('spec'), dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (!W) return;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = `10.5px ${MONO}`;
  const pts = S.spectrum, L = 46, Rm = 6, Tm = 34, Bm = 28;
  const X = (um) => L + (W - L - Rm) * ((um - 0.7) / 4.4);
  const good = pts.filter((p) => !p.bad);
  const sat = pts.length && pts.filter((p) => p.saturated).length > pts.length * 0.6;
  $('specNote').textContent = !pts.length ? (S.loaded ? 'Too close to the edge to measure.' : 'Measuring as images arrive…')
    : sat ? 'Too bright: the detector saturates here, so these values are unreliable.'
      : `${good.length} clean of ${pts.length} measurements · hollow = flagged`;
  $('specCsv').disabled = !pts.length;
  const use = good.length >= 8 ? good : pts;
  const ys = use.map((p) => p.flux).sort((a, b) => a - b);
  let y0 = ys.length ? ys[Math.floor(ys.length * 0.02)] : 0, y1 = ys.length ? ys[Math.ceil(ys.length * 0.98) - 1] : 1;
  y0 = Math.min(y0, 0); if (y1 <= y0) y1 = y0 + 1;
  const padY = (y1 - y0) * 0.12; y0 -= padY; y1 += padY;
  const Y = (v) => Tm + (H - Tm - Bm) * (1 - (v - y0) / (y1 - y0));

  // band colours along the wavelength axis, and features worth knowing
  for (const d of Object.values(DET)) { ctx.fillStyle = d.color; ctx.fillRect(X(d.lo) + 1, H - Bm, X(d.hi) - X(d.lo) - 2, 3); }
  ctx.textAlign = 'center';
  for (const [um, label] of [[1.875, 'H'], [3.05, 'ice'], [3.3, 'CH₄'], [4.27, 'CO₂'], [4.67, 'CO']]) {
    ctx.strokeStyle = 'rgba(235,230,218,.13)'; ctx.beginPath(); ctx.moveTo(X(um), Tm); ctx.lineTo(X(um), H - Bm); ctx.stroke();
    ctx.fillStyle = DIM; ctx.fillText(label, X(um), 9);
  }
  ctx.fillStyle = DIM;
  for (let um = 1; um <= 5; um++) ctx.fillText(`${um}`, X(um), H - Bm + 15);
  ctx.fillText('µm', X(5) - 18, H - Bm + 15);
  ctx.textAlign = 'right';
  const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toPrecision(2));
  for (let k = 0; k <= 3; k++) { const v = y0 + (y1 - y0) * (k / 3); ctx.fillText(fmt(v), L - 5, Y(v) + 3); }
  ctx.textAlign = 'left'; ctx.fillText('mJy', 0, 26.5);
  if (y0 < 0 && y1 > 0) { ctx.strokeStyle = 'rgba(235,230,218,.2)'; ctx.beginPath(); ctx.moveTo(L, Y(0)); ctx.lineTo(W - Rm, Y(0)); ctx.stroke(); }

  ctx.save(); ctx.beginPath(); ctx.rect(L, Tm, W - L - Rm, H - Tm - Bm); ctx.clip();
  for (const p of pts) {
    const c = S.epochs[p.epoch].color, x = X(p.um), y = Y(p.flux);
    ctx.strokeStyle = ctx.fillStyle = c; ctx.globalAlpha = p.bad ? 0.4 : 0.9; ctx.lineWidth = 1;
    if (!p.bad && p.err > 0) { ctx.beginPath(); ctx.moveTo(x, Y(p.flux - p.err)); ctx.lineTo(x, Y(p.flux + p.err)); ctx.stroke(); }
    ctx.beginPath(); ctx.arc(x, y, 2.2, 0, 7); p.bad ? ctx.stroke() : ctx.fill();
  }
  ctx.restore(); ctx.globalAlpha = 1;
  // one colour per pass: a star that changed between passes separates into bands of colour
  let lx = L + 6;
  for (const e of S.epochs) {
    if (!pts.some((p) => p.epoch === e.i)) continue;
    ctx.fillStyle = e.color; ctx.beginPath(); ctx.arc(lx, 23, 3, 0, 7); ctx.fill();
    ctx.fillText(e.label, lx + 7, 26.5);
    lx += ctx.measureText(e.label).width + 22;
  }
}

function downloadCsv() {
  const rows = ['wavelength_um,bandwidth_um,flux_mJy,flux_err_mJy,mjd,detector,obs_id,flags,suspect'];
  for (const p of [...S.spectrum].sort((a, b) => a.um - b.um))
    rows.push([p.um.toFixed(5), p.bw.toFixed(5), p.flux.toPrecision(6), p.err.toPrecision(4), p.mjd.toFixed(5), p.det, p.obs, p.flags, p.bad ? 1 : 0].join(','));
  const [ra, dec] = clickRaDec();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
  a.download = `spherex_spectrum_${ra.toFixed(4)}_${dec.toFixed(4)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- interface ----------

function setStatus(t) { $('status').textContent = t; $('status').style.whiteSpace = 'pre-line'; }

function updateProgress() {
  const spx = S.frames.filter((f) => f.src === 'SPX');
  const ok = spx.filter((f) => f.state === 'ok').length, done = S.frames.filter((f) => f.state !== 'pending').length;
  const bar = $('loadbar');
  bar.style.width = S.frames.length ? `${(100 * done) / S.frames.length}%` : '0';
  bar.style.opacity = S.frames.length && done < S.frames.length ? 1 : 0;
  if (!spx.length) { $('progress').textContent = ''; $('partial').hidden = true; return; }
  const passes = S.epochs.filter((e) => e.src === 'SPX').length;
  const rels = [...new Set(spx.map((f) => f.rel.toUpperCase()))].join(' + ');
  $('progress').textContent = (done < S.frames.length ? `Loading ${ok} of ${spx.length} exposures` : `${ok} exposures`)
    + ` · ${passes} pass${passes > 1 ? 'es' : ''} · ${fmtDate(spx[0].mjd)} → ${fmtDate(spx.at(-1).mjd)} · SPHEREx ${rels}`;
  $('partial').hidden = !S.partial;
}

function updateDetails() {
  const f = S.mode === 'frame' && S.curFrame;
  $('frameinfo').hidden = !f;
  if (!f) return;
  const h = f.meta.hdr;
  const rows = [['Taken', (h['DATE-AVG'] || '').replace('T', ' ').slice(0, 19) + ' UTC'],
    ['Wavelength', f.meta.wave ? `${f.meta.wave.um.toFixed(3)} µm (±${(f.meta.wave.bw / 2).toFixed(3)}) at the centre` : '—'],
    ['Exposure', `${h.XPOSURE?.toFixed(0)} s · image sharpness ${h.PSF_FWHM?.toFixed(1)}″`],
    ['Quality', `${h.L2DQAFLG ?? '—'}${h.FINAST ? ' · rough pointing only' : ''}`],
    ['ID', `${f.obs} · detector ${f.det} · ${f.rel.toUpperCase()}`]];
  const warn = ['AURORA_CONT', 'SHUTTLE_GLOW_CONT'].filter((k) => h[k] === true).map((k) => k.replace('_CONT', '').toLowerCase().replace('_', ' '));
  if (warn.length) rows.push(['Contaminated by', warn.join(', ')]);
  $('details').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${String(v).replace(/</g, '&lt;')}</dd>`).join('');
}

function fillEpochSelects() {
  const opts = S.epochs.filter((e) => e.src === 'SPX').map((e) => `<option value="${e.i}">${e.label}</option>`).join('');
  for (const [id, val] of [['epA', S.epA], ['epB', S.epB]]) { $(id).innerHTML = opts; $(id).value = val; }
}

function setMode(mode) {
  S.mode = mode; S.cur = 0; stopPlay();
  for (const b of $('modes').children) b.setAttribute('aria-selected', b.dataset.mode === mode);
  $('diffCtl').hidden = mode !== 'diff';
  $('stackCtl').hidden = mode !== 'stack';
  const canPlay = mode === 'epoch' || mode === 'frame';
  for (const id of ['prev', 'play', 'next']) $(id).disabled = !canPlay;
  $('speed').value = mode === 'frame' ? 8 : 1.5;
  syncUrl(); requestDraw(); drawPad(); updateDetails();
  if (S.click) { computeSpectrum(); renderInspect(); }
}

let timer = 0;
function step(d) {
  const all = pool();
  if (S.mode === 'frame') { if (all.length) S.cur = (S.cur + d + all.length) % all.length; }
  else {
    const eps = S.epochs.filter((e) => all.some((f) => f.epoch === e.i));
    if (eps.length) S.epUser = true, S.curEp = eps[(Math.max(0, eps.findIndex((e) => e.i === S.curEp)) + d + eps.length) % eps.length].i;
  }
  requestDraw();
}
function startPlay() {
  if (S.mode !== 'epoch' && S.mode !== 'frame') return;
  S.playing = true; $('play').classList.add('on');
  clearInterval(timer);
  timer = setInterval(() => step(1), 1000 / +$('speed').value);
}
function stopPlay() { S.playing = false; $('play').classList.remove('on'); clearInterval(timer); }

function syncUrl() {
  if (!S.frames.length && !S.ra && !S.dec) return;
  const p = new URLSearchParams();
  p.set('ra', S.ra.toFixed(5)); p.set('dec', S.dec.toFixed(5)); p.set('fov', S.fov);
  if (S.name) p.set('name', S.name);
  if (S.mode !== 'epoch') p.set('mode', S.mode);
  if (S.bands.size < 6) p.set('bands', [...S.bands].sort().join(''));
  if (S.vel[0] || S.vel[1]) { p.set('mue', S.vel[0].toFixed(2)); p.set('mun', S.vel[1].toFixed(2)); }
  if (!S.showGaia) p.set('gaia', 0);
  if (!S.wise) p.set('wise', 0);
  for (const k of ['embed', 'cpu']) if (params.get(k)) p.set(k, params.get(k));
  history.replaceState(null, '', '?' + p);
}

function drawBands() {
  $('bands').innerHTML = Object.entries(DET).map(([d, v]) =>
    `<button data-det="${d}" aria-pressed="${S.bands.has(+d)}" style="--c:${v.color};flex:${(v.hi - v.lo).toFixed(2)}" title="${v.lo}–${v.hi} µm" aria-label="${v.lo} to ${v.hi} micrometres"></button>`).join('');
  const edges = [0.75, 1.11, 1.64, 2.42, 3.82, 4.42, 5.0];
  const labels = ['0.75', '', '1.6', '2.4', '3.8', '4.4', '5 µm'];
  $('bandTicks').innerHTML = edges.map((e, i) => `<span style="left:${(100 * (e - 0.75)) / 4.25}%">${labels[i]}</span>`).join('');
  $('bandText').textContent = S.bands.size === 6 ? 'Infrared colour: all six bands added together' : `Infrared colour: ${bandText()} only`;
  $('bandAll').hidden = S.bands.size === 6;
}

function setVel(e, n) {
  S.vel = [e, n];
  $('muE').value = e.toFixed(2); $('muN').value = n.toFixed(2);
  drawPad(); syncUrl(); requestDraw();
  if (S.click) scheduleSpectrum();
}
function drawPad() {
  const cv = $('pad'), ctx = cv.getContext('2d'), W = cv.width, c = W / 2, R = c - 22;
  ctx.clearRect(0, 0, W, W);
  ctx.font = `20px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  // tick ring like a compass bezel
  for (let a = 0; a < 72; a++) {
    const ang = (a / 72) * 2 * Math.PI, long = a % 6 === 0;
    ctx.strokeStyle = long ? BONE : '#55524a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(c + Math.cos(ang) * (R + 4), c + Math.sin(ang) * (R + 4));
    ctx.lineTo(c + Math.cos(ang) * (R + (long ? 18 : 12)), c + Math.sin(ang) * (R + (long ? 18 : 12))); ctx.stroke();
  }
  ctx.strokeStyle = '#2c2c2f'; ctx.lineWidth = 2;
  for (const k of [1, 2 / 3, 1 / 3]) { ctx.beginPath(); ctx.arc(c, c, R * k, 0, 7); ctx.stroke(); }
  ctx.beginPath(); ctx.moveTo(c - R, c); ctx.lineTo(c + R, c); ctx.moveTo(c, c - R); ctx.lineTo(c, c + R); ctx.stroke();
  ctx.fillStyle = DIM; ctx.fillText('N', c + 16, c - R + 18); ctx.fillText('E', c - R + 18, c - 16);
  const x = c - (S.vel[0] / S.padRange) * R, y = c - (S.vel[1] / S.padRange) * R;
  ctx.strokeStyle = ctx.fillStyle = SIGNAL; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(x, y); ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.fill();
}

function resize() {
  const W = cssSize(), dpr = Math.min(devicePixelRatio || 1, 2), px = Math.max(64, Math.round(W * dpr));
  for (const id of ['gl', 'overlay']) { const cv = $(id); if (cv.width !== px) { cv.width = px; cv.height = px; } }
  requestDraw(); drawTimeline(); drawSpectrum();
}

async function submitQuery(text) {
  const c = parseCoords(text);
  if (c) return go(c.ra, c.dec);
  $('intro').hidden = true;
  setStatus(`Looking up “${text}”…`);
  try {
    const r = await (await fetch(`api/resolve?name=${encodeURIComponent(text)}`)).json();
    if (r.error) return setStatus(`${r.error}. Try coordinates instead.`);
    go(r.ra, r.dec, text);
  } catch (e) { setStatus('Name lookup failed. Try coordinates instead.'); }
}

// A uniformly random direction, kept away from the crowded plane of the Milky Way.
function randomPatch() {
  for (;;) {
    const ra = Math.random() * 360, dec = Math.asin(2 * Math.random() - 1) * 180 / Math.PI;
    const d = Math.PI / 180;
    const sinb = Math.sin(dec * d) * Math.sin(27.12825 * d) + Math.cos(dec * d) * Math.cos(27.12825 * d) * Math.cos((ra - 192.85948) * d);
    if (Math.abs(Math.asin(sinb)) > 20 * d) return go(ra, dec, '', true);
  }
}

async function copy(text, btn, done = 'Copied') {
  try { await navigator.clipboard.writeText(text); } catch (e) { prompt('Copy this:', text); return; }
  const old = btn.textContent; btn.textContent = done;
  setTimeout(() => { btn.textContent = old; }, 1400);
}

// ---------- guide ----------

const TOUR = [
  ['play', 'Press play. The picture flips between telescope passes, six months apart. Watch for any dot that jumps, appears or fades.'],
  ['stage', 'Blue rings mark stars the Gaia catalogue already knows. Click any dot to see what it is and read its spectrum. Scroll to zoom, drag to move.'],
  ['bands', 'Each block is a slice of infrared colour. Cold objects such as brown dwarfs only show up toward the red end — click a block to look there alone.'],
  ['modes', 'Nothing obvious? Difference removes everything that stayed still. Shift & stack adds up every exposure to reveal movers too faint for one image.'],
];
let tourAt = -1;
function tour(i) {
  document.querySelector('.coach-target')?.classList.remove('coach-target');
  tourAt = i;
  const box = $('coach');
  if (i < 0 || i >= TOUR.length) { box.hidden = true; try { localStorage.setItem('ds_tour', '1'); } catch (e) { /* private mode */ } return; }
  const el = $(TOUR[i][0]);
  el.classList.add('coach-target');
  el.scrollIntoView({ block: 'nearest' });
  $('coachText').textContent = TOUR[i][1];
  $('coachStep').textContent = `${i + 1} / ${TOUR.length}`;
  $('coachNext').textContent = i === TOUR.length - 1 ? 'Start looking' : 'Next';
  box.hidden = false;
  const r = el.getBoundingClientRect(), bw = box.offsetWidth, bh = box.offsetHeight;
  let x, y;
  if (TOUR[i][0] === 'stage') { x = r.left + 18; y = r.bottom - bh - 60; } // inside the image, bottom-left
  else { x = r.left; y = r.bottom + 14; if (y + bh > innerHeight - 8) y = r.top - bh - 14; }
  box.style.left = `${Math.max(8, Math.min(x, innerWidth - bw - 8))}px`;
  box.style.top = `${Math.max(8, Math.min(y, innerHeight - bh - 8))}px`;
}

// ---------- wiring ----------

function bind() {
  $('presets').innerHTML = PRESETS.map((p, i) => `<button data-i="${i}">${p.name}<span>${p.why}</span></button>`).join('');
  $('presets').onclick = (ev) => {
    const p = PRESETS[ev.target.closest('button')?.dataset.i];
    if (!p) return;
    setFov(p.fov);
    go(p.ra, p.dec, p.name);
  };
  $('fov').innerHTML = [3, 6, 10, 15, 20].map((v) => `<button type="button" role="radio" data-v="${v}" aria-checked="${v === S.fov}">${v}′</button>`).join('');
  $('fov').onclick = (ev) => { const v = +ev.target.dataset.v; if (!v || v === S.fov) return; setFov(v); if (S.frames.length) go(S.ra, S.dec, S.name); };
  $('search').onsubmit = (ev) => { ev.preventDefault(); const t = $('q').value.trim(); if (t) submitQuery(t); };
  $('introSearch').onsubmit = (ev) => { ev.preventDefault(); const t = $('introQ').value.trim(); if (t) submitQuery(t); };
  $('random').onclick = $('introRandom').onclick = randomPatch;
  $('home').onclick = () => { stopPlay(); tour(-1); $('intro').hidden = false; $('introQ').focus(); };
  $('retry').onclick = () => go(S.ra, S.dec, S.name);
  $('share').onclick = () => copy(location.href, $('share'), 'Link copied');
  $('help').onclick = () => tour(0);
  $('coachNext').onclick = () => tour(tourAt + 1);
  $('coachSkip').onclick = () => tour(-1);

  $('modes').onclick = (ev) => { const b = ev.target.closest('button'); if (b) setMode(b.dataset.mode); };
  $('bands').onclick = (ev) => {
    const d = +ev.target.dataset.det; if (!d) return;
    if (S.bands.size === 6) S.bands = new Set([d]); // first click picks a single band
    else if (S.bands.has(d) && S.bands.size > 1) S.bands.delete(d);
    else S.bands.add(d);
    S.cur = 0; drawBands(); syncUrl(); requestDraw();
  };
  $('bandAll').onclick = () => { S.bands = new Set([1, 2, 3, 4, 5, 6]); S.cur = 0; drawBands(); syncUrl(); requestDraw(); };

  const toggle = (id, key, after) => { $(id).onclick = () => { S[key] = !S[key]; $(id).setAttribute('aria-pressed', S[key]); after?.(); syncUrl(); requestDraw(); }; $(id).setAttribute('aria-pressed', S[key]); };
  toggle('tGaia', 'showGaia');
  toggle('tWise', 'wise', () => { S.cur = 0; drawTimeline(); });
  toggle('tNearest', 'nearest');
  toggle('tInvert', 'invert');

  $('flags').innerHTML = FLAGS.map(([bit, name, desc]) => `<label title="${desc}"><input type="checkbox" data-bit="${bit}" ${S.mask & (1 << bit) ? 'checked' : ''}>${name.toLowerCase().replace('_', ' ')}</label>`).join('');
  $('flags').onchange = (ev) => {
    const bit = 1 << +ev.target.dataset.bit;
    S.mask = ev.target.checked ? S.mask | bit : S.mask & ~bit;
    for (const f of S.frames) if (f.state === 'ok') uploadTile(f);
    requestDraw(); if (S.click) computeSpectrum();
  };
  document.addEventListener('click', (ev) => { if (!$('flagPop').contains(ev.target)) $('flagPop').open = false; });
  $('stretch').oninput = () => { S.stretch = +$('stretch').value; requestDraw(); };
  $('epA').onchange = () => { S.epA = +$('epA').value; requestDraw(); };
  $('epB').onchange = () => { S.epB = +$('epB').value; requestDraw(); };
  $('play').onclick = () => (S.playing ? stopPlay() : startPlay());
  $('prev').onclick = () => { stopPlay(); step(-1); };
  $('next').onclick = () => { stopPlay(); step(1); };
  $('speed').oninput = () => S.playing && startPlay();
  $('timeline').onclick = timelineClick;
  $('specCsv').onclick = downloadCsv;
  $('whereCopy').onclick = () => { const [ra, dec] = clickRaDec(); copy(`${ra.toFixed(5)} ${dec.toFixed(5)}`, $('whereCopy')); };
  $('muE').onchange = $('muN').onchange = () => setVel(+$('muE').value || 0, +$('muN').value || 0);
  $('muReset').onclick = () => setVel(0, 0);
  $('padRange').onchange = () => { S.padRange = +$('padRange').value; drawPad(); };

  const pad = $('pad');
  const padSet = (ev) => {
    const r = pad.getBoundingClientRect(), c = r.width / 2, R = c - 22 * (r.width / pad.width);
    setVel(-((ev.clientX - r.left - c) / R) * S.padRange, -((ev.clientY - r.top - c) / R) * S.padRange);
  };
  pad.onpointerdown = (ev) => { pad.setPointerCapture(ev.pointerId); padSet(ev); };
  pad.onpointermove = (ev) => ev.buttons && padSet(ev);

  // image: drag to pan, wheel to zoom, click to inspect
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
    if (down && !down.moved && S.frames.length) { S.click = cssToSky(local(ev)); renderInspect(); computeSpectrum(); requestDraw(); }
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
    if (/INPUT|SELECT|TEXTAREA/.test(ev.target.tagName) || !$('intro').hidden) return;
    if (ev.key === ' ') { ev.preventDefault(); S.playing ? stopPlay() : startPlay(); }
    if (ev.key === 'ArrowRight') { stopPlay(); step(1); }
    if (ev.key === 'ArrowLeft') { stopPlay(); step(-1); }
    if (ev.key === 'Escape') tour(-1);
  });
  new ResizeObserver(resize).observe(stage);
  new ResizeObserver(() => { drawTimeline(); drawSpectrum(); }).observe($('timeline'));
}

function setFov(v) {
  S.fov = v;
  for (const b of $('fov').children) b.setAttribute('aria-checked', +b.dataset.v === v);
}

function readout(p) {
  if (!S.frames.length) return;
  const [e, n] = cssToSky(p);
  let text = `${fmtRa(S.ra + e / 3600 / cosDec())}  ${fmtDec(S.dec + n / 3600)}`;
  const f = S.curFrame;
  if (S.mode === 'frame' && f) {
    const { px, py, J, T } = f.meta;
    const x = Math.round(px + J[0] * e + J[1] * n), y = Math.round(py + J[2] * e + J[3] * n);
    if (x >= 0 && y >= 0 && x < T && y < T) {
      const v = f.img[y * T + x], fl = f.flags[y * T + x];
      const names = FLAGS.filter(([b]) => fl & (1 << b)).map(([, name]) => name.toLowerCase().replace('_', ' '));
      text += `\n${Number.isFinite(v) ? v.toFixed(2) + ' MJy/sr' : 'no data'}${names.length ? ' · ' + names.join(', ') : ''}`;
    }
  }
  $('readout').textContent = text;
}

function init() {
  if (params.get('embed')) document.body.classList.add('embed');
  const fov = +params.get('fov');
  if ([3, 6, 10, 15, 20].includes(fov)) S.fov = fov;
  if (params.get('bands')) { const b = [...params.get('bands')].map(Number).filter((d) => DET[d]); if (b.length) S.bands = new Set(b); }
  if (params.get('mue') || params.get('mun')) S.vel = [+params.get('mue') || 0, +params.get('mun') || 0];
  if (params.get('gaia') === '0') S.showGaia = false;
  if (params.get('wise') === '0') S.wise = false;
  bind(); drawBands();
  $('muE').value = S.vel[0]; $('muN').value = S.vel[1];
  if (Math.hypot(...S.vel) > 12) { S.padRange = 40; $('padRange').value = 40; }
  setMode(['epoch', 'frame', 'diff', 'stack'].includes(params.get('mode')) ? params.get('mode') : 'epoch');
  resize();
  document.fonts?.ready.then(() => { drawPad(); drawTimeline(); requestDraw(); });
  const ra = parseFloat(params.get('ra')), dec = parseFloat(params.get('dec'));
  if (Number.isFinite(ra) && Number.isFinite(dec)) go(ra, dec, params.get('name') || '');
  else { $('intro').hidden = false; $('introQ').focus(); }
}

// Show the guide once, the first time a field has something to look at.
const tourWatch = setInterval(() => {
  let seen = false;
  try { seen = !!localStorage.getItem('ds_tour'); } catch (e) { /* private mode */ }
  if (seen || params.get('embed')) return clearInterval(tourWatch);
  if ($('intro').hidden && S.frames.filter((f) => f.state === 'ok').length > 12 && tourAt < 0) { clearInterval(tourWatch); tour(0); }
}, 600);

init();
