// Field scan: find every source in the loaded field, then measure whether it
// moved (2010 WISE -> SPHEREx, and between SPHEREx passes) or changed brightness
// between passes. Pure functions over the loaded frames; no DOM.

const GRID = 3; // arcsec per pixel of the working grid

/** Aperture photometry of one exposure at tile pixel (x, y). Returns null near the edge. */
export function aperture(f, x, y, mask) {
  const T = f.meta.T, R = 2, R1 = 4, R2 = 7;
  if (x < R2 || y < R2 || x > T - 1 - R2 || y > T - 1 - R2) return null;
  const ann = [];
  let sum = 0, w2 = 0, area = 0, flags = 0, nan = false;
  for (let j = Math.floor(y - R2); j <= Math.ceil(y + R2); j++)
    for (let i = Math.floor(x - R2); i <= Math.ceil(x + R2); i++) {
      const d = Math.hypot(i - x, j - y), o = j * T + i, val = f.img[o];
      if (d >= R1 && d <= R2) { if (Number.isFinite(val) && !(f.flags[o] & mask)) ann.push(val); continue; }
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
  const dev = ann.map((a) => Math.abs(a - bg)).sort((a, b) => a - b);
  const noise = 1.4826 * dev[dev.length >> 1]; // scatter of the sky ring around the aperture
  return { sum: sum - bg * area, err: noise * Math.sqrt(w2), flags, nan };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const mad = (a, m = median(a)) => 1.4826 * median(a.map((v) => Math.abs(v - m)));

// Stack a set of frames onto the north-up working grid, dropping the highest and lowest sample per pixel.
function stack(frames, N, mask) {
  const sum = new Float64Array(N * N), wsum = new Float64Array(N * N), cnt = new Uint16Array(N * N);
  const hv = new Float32Array(N * N).fill(-1e30), hw = new Float32Array(N * N), lv = new Float32Array(N * N).fill(1e30), lw = new Float32Array(N * N);
  const c = (N - 1) / 2;
  for (const f of frames) {
    const { px, py, J, T } = f.meta, w = 1 / (f.sig * f.sig), img = f.img, fl = f.flags;
    for (let j = 0; j < N; j++) {
      const n = (c - j) * GRID;
      for (let i = 0; i < N; i++) {
        const e = (c - i) * GRID;
        const x = px + J[0] * e + J[1] * n, y = py + J[2] * e + J[3] * n;
        const ix = Math.floor(x), iy = Math.floor(y);
        if (ix < 0 || iy < 0 || ix >= T - 1 || iy >= T - 1) continue;
        const o = iy * T + ix;
        const a = img[o], b = img[o + 1], d = img[o + T], g = img[o + T + 1];
        if (!(a === a && b === b && d === d && g === g) || ((fl[o] | fl[o + 1] | fl[o + T] | fl[o + T + 1]) & mask)) continue;
        const fx = x - ix, fy = y - iy;
        const v = (a + (b - a) * fx) * (1 - fy) + (d + (g - d) * fx) * fy - f.bg;
        const k = j * N + i;
        sum[k] += w * v; wsum[k] += w; cnt[k]++;
        if (v > hv[k]) { hv[k] = v; hw[k] = w; }
        if (v < lv[k]) { lv[k] = v; lw[k] = w; }
      }
    }
  }
  const out = new Float32Array(N * N).fill(NaN);
  for (let k = 0; k < N * N; k++) {
    let s = sum[k], w = wsum[k];
    if (cnt[k] >= 5) { s -= hv[k] * hw[k] + lv[k] * lw[k]; w -= hw[k] + lw[k]; }
    if (w > 0) out[k] = s / w;
  }
  return out;
}

// Flux-weighted centre of a 5x5 window around grid pixel (i, j). Returns sky offsets in arcsec.
function centroid(img, N, i, j) {
  let s = 0, sx = 0, sy = 0;
  for (let b = j - 2; b <= j + 2; b++) for (let a = i - 2; a <= i + 2; a++) {
    if (a < 0 || b < 0 || a >= N || b >= N) continue;
    const v = img[b * N + a];
    if (!(v > 0)) continue;
    s += v; sx += v * a; sy += v * b;
  }
  if (!s) return null;
  const c = (N - 1) / 2;
  return [(c - sx / s) * GRID, (c - sy / s) * GRID];
}

// Brightest pixel within `radius` arcsec of a sky position; null if nothing above `floor`.
function peakNear(img, N, e, n, radius, floor) {
  const c = (N - 1) / 2, ci = Math.round(c - e / GRID), cj = Math.round(c - n / GRID), r = Math.ceil(radius / GRID);
  let best = floor, bi = -1, bj = -1;
  for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
    if (i < 2 || j < 2 || i >= N - 2 || j >= N - 2 || Math.hypot(i - ci, j - cj) > r) continue;
    const v = img[j * N + i];
    if (v > best) { best = v; bi = i; bj = j; }
  }
  return bi < 0 ? null : { i: bi, j: bj, v: best };
}

/**
 * @param S app state: frames, epochs, gaia, ra, dec, fov, tRef, mask
 * @returns {{sources: object[], summary: object}}
 */
export function scanField(S) {
  const ok = S.frames.filter((f) => f.state === 'ok');
  const spx = ok.filter((f) => f.src === 'SPX'), wise = ok.filter((f) => f.src === 'WISE');
  const passes = S.epochs.filter((e) => e.src === 'SPX' && spx.some((f) => f.epoch === e.i));
  if (!spx.length) return { sources: [], summary: { sources: 0 } };
  const N = Math.round((S.fov * 60) / GRID) | 1, c = (N - 1) / 2;
  const all = stack(spx, N, S.mask);
  // WISE saw 3.4 and 4.6 µm, so positions are compared against a stack of the SPHEREx bands nearest to that.
  const redFrames = spx.filter((f) => f.det >= 4);
  const red = redFrames.length >= 10 ? stack(redFrames, N, S.mask) : all;
  const perPass = passes.map((e) => stack(spx.filter((f) => f.epoch === e.i), N, S.mask));
  const wimg = wise.length ? stack(wise, N, 0) : null;
  const wiseMjd = wise.length ? wise[0].mjd : 0;

  // detection on the all-pass stack
  const vals = Array.from(all).filter((v) => v === v);
  const bg = median(vals), sigma = mad(vals, bg) || 1;
  let found = [];
  for (let j = 3; j < N - 3; j++) for (let i = 3; i < N - 3; i++) {
    const v = all[j * N + i];
    if (!(v - bg > 8 * sigma)) continue;
    let top = true;
    for (let b = -1; b <= 1 && top; b++) for (let a = -1; a <= 1; a++) if ((a || b) && all[(j + b) * N + i + a] > v) { top = false; break; }
    if (!top) continue;
    const pos = centroid(all, N, i, j);
    if (pos) found.push({ e: pos[0], n: pos[1], snr: (v - bg) / sigma, i, j });
  }
  found.sort((a, b) => b.snr - a.snr);
  const kept = [];
  for (const s of found) if (!kept.some((k) => Math.hypot(k.e - s.e, k.n - s.n) < 10)) kept.push(s);
  found = kept.slice(0, 200);

  const cosd = Math.cos(S.dec * Math.PI / 180);
  const yearsToWise = (S.tRef - wiseMjd) / 365.25;
  const gaiaAt = (g, mjd) => { const yr = (mjd - 57388.5) / 365.25; return [g.e0 + g.pe * yr, g.n0 + g.pn * yr]; };
  const wsig = wimg ? mad(Array.from(wimg).filter((v) => v === v)) || 1 : 1;
  const rvals = Array.from(red).filter((v) => v === v), rbg = median(rvals), rsig = mad(rvals, rbg) || 1;
  const finiteAt = (img, e, n) => { const v = img[Math.round(c - n / GRID) * N + Math.round(c - e / GRID)]; return v === v; };

  for (const s of found) {
    s.ra = S.ra + s.e / 3600 / cosd; s.dec = S.dec + s.n / 3600;
    // Gaia
    let best = null, bd = 8, near = 0;
    for (const g of S.gaia || []) {
      const [ge, gn] = gaiaAt(g, S.tRef), d = Math.hypot(ge - s.e, gn - s.n);
      if (d < 9) near++;
      if (d < bd) { bd = d; best = g; }
    }
    s.gaia = best; s.gaiaNear = near;

    // position in 2010 (WISE) and in each SPHEREx pass
    const rp = peakNear(red, N, s.e, s.n, 6, rbg + 6 * rsig);
    if (rp) { const q = centroid(red, N, rp.i, rp.j); if (q) s.red = { e: q[0], n: q[1], v: rp.v - rbg, snr: (rp.v - rbg) / rsig }; }
    if (wimg && s.red) {
      const p = peakNear(wimg, N, s.red.e, s.red.n, 12, 6 * wsig);
      if (p) { const w = centroid(wimg, N, p.i, p.j); if (w) s.wise = { e: w[0], n: w[1], v: p.v, snr: p.v / wsig }; }
    }
    s.pass = perPass.map((img) => {
      const p = peakNear(img, N, s.e, s.n, 9, bg + 6 * sigma);
      return p ? centroid(img, N, p.i, p.j) : null;
    });

    // brightness per exposure, then pass-to-pass ratios at matched wavelength
    const phot = [];
    let sat = 0;
    for (const f of spx) {
      const { px, py, J } = f.meta;
      const a = aperture(f, px + J[0] * s.e + J[1] * s.n, py + J[2] * s.e + J[3] * s.n, S.mask);
      if (!a) continue;
      if (a.nan || (a.flags & 2)) { sat++; continue; }
      if (a.flags & S.suspect) continue;
      phot.push({ um: f.meta.wave ? f.meta.wave.um : (f.wmin + f.wmax) / 2, det: f.det, pass: f.epoch, flux: a.sum, err: a.err });
    }
    s.saturated = sat > 0.3 * spx.length;
    s.nphot = phot.length;
    // A real source is there in most exposures. A few unrelated cosmic-ray hits on one spot can
    // fake a bright "source" in the stack while the typical exposure shows nothing.
    s.spurious = phot.length >= 8 && median(phot.map((p) => p.flux / p.err)) < 0.25 * s.snr / Math.sqrt(spx.length);
    s.change = null;
    for (let a = 0; a < passes.length; a++) for (let b = a + 1; b < passes.length; b++) {
      const A = phot.filter((p) => p.pass === passes[a].i && p.flux > 5 * p.err), B = phot.filter((p) => p.pass === passes[b].i && p.flux > 5 * p.err);
      const logs = [];
      for (const p of A) {
        const tol = (p.det >= 5 ? 0.005 : 0.012) * p.um;
        let q = null, qd = tol;
        for (const r of B) { const d = Math.abs(r.um - p.um); if (r.det === p.det && d < qd) { qd = d; q = r; } }
        if (q) logs.push(Math.log(q.flux / p.flux));
      }
      if (logs.length < 8) continue;
      const m = median(logs), sd = (mad(logs, m) || 0.01) / Math.sqrt(logs.length);
      const z = Math.abs(m) / Math.max(sd, 0.004);
      // Passes a whole number of years apart see the source with the telescope at the same angle, so
      // light scattered from neighbours cancels. Passes half a year apart do not, and are trusted less.
      const gap = ((passes[b].t0 + passes[b].t1) - (passes[a].t0 + passes[a].t1)) / 2, off = Math.abs(gap / 365.25 - Math.round(gap / 365.25)) * 365.25;
      const sameSeason = gap > 200 && off < 50;
      const cand = { ratio: Math.exp(m), z, n: logs.length, from: passes[a].label, to: passes[b].label, sameSeason };
      const better = !s.change || (cand.sameSeason && !s.change.sameSeason && z > 6) || (cand.sameSeason === s.change.sameSeason && z > s.change.z);
      if (better && !(s.change && s.change.sameSeason && s.change.z > 6 && !cand.sameSeason)) s.change = cand;
    }
    // Large changes: when a source is too faint in one pass for exposure-by-exposure ratios (it
    // appeared, or all but vanished), compare the median flux per band between the two passes.
    if (!s.change || s.change.z < 6) {
      for (let a = 0; a < passes.length; a++) for (let b = a + 1; b < passes.length; b++) {
        const hits = [];
        let bands = 0;
        for (let det = 1; det <= 6; det++) {
          const A = phot.filter((p) => p.pass === passes[a].i && p.det === det).map((p) => p.flux), B = phot.filter((p) => p.pass === passes[b].i && p.det === det).map((p) => p.flux);
          if (A.length < 4 || B.length < 4) continue;
          bands++;
          const ma = median(A), mb = median(B), ea = (mad(A, ma) || 1e-9) / Math.sqrt(A.length), eb = (mad(B, mb) || 1e-9) / Math.sqrt(B.length);
          const hi = Math.max(ma, mb), lo = Math.min(ma, mb), err = Math.max(ea, eb);
          if (hi > 10 * err && lo < 0.3 * hi) hits.push({ up: mb > ma, frac: Math.max(lo, 2 * err) / hi });
        }
        if (hits.length < 2 || hits.length < bands / 2 || hits.some((h) => h.up !== hits[0].up)) continue;
        const frac = median(hits.map((h) => h.frac)); // faint level as a fraction of the bright level (an upper limit)
        const gap = ((passes[b].t0 + passes[b].t1) - (passes[a].t0 + passes[a].t1)) / 2, off = Math.abs(gap / 365.25 - Math.round(gap / 365.25)) * 365.25;
        const cand = { ratio: hits[0].up ? 1 / frac : frac, z: 8 + hits.length, n: hits.length, from: passes[a].label, to: passes[b].label, sameSeason: gap > 200 && off < 50, byBand: true };
        if (!s.change || s.change.z < 6 || (cand.sameSeason && !s.change.sameSeason)) s.change = cand;
      }
    }
  }

  found = found.filter((s) => !s.spurious);

  // A 2010 counterpart belongs to the SPHEREx source nearest to it; anything else was a mismatch.
  for (const s of found) {
    if (!s.wise) continue;
    const own = Math.hypot(s.e - s.wise.e, s.n - s.wise.n);
    if (found.some((t) => t !== s && Math.hypot(t.e - s.wise.e, t.n - s.wise.n) < Math.max(5, own - 2))) s.wise = null;
  }

  // Fast movers travel further than the matching radius, so they show up twice: a source in 2010 with
  // nothing there now ("gone"), and a source now with nothing there in 2010 ("appeared").
  const gone = [];
  if (wimg) {
    for (let j = 3; j < N - 3; j++) for (let i = 3; i < N - 3; i++) {
      const v = wimg[j * N + i];
      if (!(v > 20 * rsig && v > 12 * wsig)) continue; // bright enough that SPHEREx would have seen it
      let top = true;
      for (let b = -1; b <= 1 && top; b++) for (let a = -1; a <= 1; a++) if ((a || b) && wimg[(j + b) * N + i + a] > v) { top = false; break; }
      if (!top) continue;
      const pos = centroid(wimg, N, i, j);
      if (!pos || gone.some((g) => Math.hypot(g.e - pos[0], g.n - pos[1]) < 10)) continue;
      if (found.some((t) => Math.hypot(t.e - pos[0], t.n - pos[1]) < 15)) continue;
      if (!finiteAt(red, pos[0], pos[1]) || peakNear(all, N, pos[0], pos[1], 9, bg + 5 * sigma) || peakNear(red, N, pos[0], pos[1], 9, rbg + 5 * rsig)) continue; // SPHEREx has no data there, or sees something
      gone.push({ e: pos[0], n: pos[1], v });
    }
  }

  // Tie WISE and SPHEREx astrometry together using stars Gaia says are slow, and measure the scatter.
  const still = found.filter((s) => s.wise && s.red && s.gaia && s.gaia.pm < 0.03 && !s.saturated && s.gaiaNear <= 1);
  const ref = still.length >= 4 ? still : found.filter((s) => s.wise && s.red && !s.saturated);
  const offE = median(ref.map((s) => s.red.e - s.wise.e)) || 0, offN = median(ref.map((s) => s.red.n - s.wise.n)) || 0;
  const resid = ref.map((s) => Math.hypot(s.red.e - s.wise.e - offE, s.red.n - s.wise.n - offN));
  const scatter = Math.max(0.6, 1.4826 * (median(resid) || 1)); // arcsec, typical per-source position error

  // Ordinary pass-to-pass changes of the whole field (calibration drift) are removed before judging any one source.
  const fieldLogs = found.filter((s) => s.change && !s.saturated).map((s) => Math.log(s.change.ratio));
  const fieldMed = fieldLogs.length >= 6 ? median(fieldLogs) : 0, fieldSd = fieldLogs.length >= 6 ? Math.max(0.03, mad(fieldLogs, fieldMed)) : 0.06;

  for (const s of found) {
    // Two signs of a false source: a far brighter neighbour (its diffraction pattern lands here and
    // rotates with the telescope), and a position that jumps from pass to pass.
    s.nearBright = found.some((t) => t !== s && t.snr > 25 * s.snr && Math.hypot(t.e - s.e, t.n - s.n) < 45);
    s.neighbour = found.some((t) => t !== s && t.snr > 5 * s.snr && Math.hypot(t.e - s.e, t.n - s.n) < 60);
    const pp = (s.pass || []).filter(Boolean);
    s.unstable = pp.some((a) => pp.some((b) => Math.hypot(a[0] - b[0], a[1] - b[1]) > 6));
  }
  for (const s of found) {
    s.kinds = [];
    s.moved = null;
    if (s.wise && yearsToWise > 5) {
      const de = s.red.e - s.wise.e - offE, dn = s.red.n - s.wise.n - offN, d = Math.hypot(de, dn);
      const ratio = s.wise.v / s.red.v; // WISE was scaled to SPHEREx brightness, so the same object gives about 1
      s.moved = { arcsec: d, perYear: d / yearsToWise, east: de / yearsToWise, north: dn / yearsToWise, sigma: d / scatter, years: yearsToWise, brightnessRatio: ratio };
      // Gaia measures motion far better than this can; a Gaia star it calls slow has not moved, whatever the centroids say.
      const gaiaSlow = s.gaia && s.gaia.pm < 0.1;
      // Faint sources have poorly known positions: allow for that before calling a shift real.
      const posErr = Math.hypot(scatter, 60 / s.red.snr);
      s.moved.sigma = d / posErr;
      if (d > Math.max(3, 5 * posErr) && !s.saturated && s.gaiaNear <= 1 && s.red.snr >= 15 && s.wise.snr >= 10 && ratio > 0.33 && ratio < 3 && !gaiaSlow && !s.nearBright && !s.unstable) s.kinds.push('moved');
    } else if (wimg && yearsToWise > 5 && s.red && s.red.snr >= 30 && !s.nearBright && finiteAt(wimg, s.red.e, s.red.n) && !peakNear(wimg, N, s.red.e, s.red.n, 15, 5 * wsig)) {
      // nothing here in 2010: pair it with the nearest source that has since gone
      let g = null, gd = 600;
      for (const c of gone) { const d = Math.hypot(c.e - s.e, c.n - s.n); if (!c.used && d < gd) { gd = d; g = c; } }
      if (g) {
        g.used = true;
        const de = s.e - g.e - offE, dn = s.n - g.n - offN, d = Math.hypot(de, dn);
        s.moved = { arcsec: d, perYear: d / yearsToWise, east: de / yearsToWise, north: dn / yearsToWise, sigma: d / scatter, years: yearsToWise, paired: true };
        s.kinds.push('moved');
      } // an unpaired appearance is not reported: nebulosity produces too many false ones
    }
    if (s.change) {
      const dev = Math.log(s.change.ratio) - fieldMed;
      s.change.percent = (Math.exp(dev) - 1) * 100;
      s.change.fieldSigma = Math.abs(dev) / fieldSd;
      if (Math.abs(dev) > 0.18 && s.change.z > 6 && s.change.fieldSigma > 4 && !s.saturated && s.snr >= 20 && s.gaiaNear <= 2
        && !s.nearBright && !s.unstable && (s.change.sameSeason || !s.neighbour)) s.kinds.push('changed');
    }
    if (!s.gaia && S.gaia) s.kinds.push('unlisted');
    // rank: unexplained things first
    s.score = (s.kinds.includes('moved') ? (s.gaia ? 40 : 100) : 0) + (s.kinds.includes('appeared') ? (s.gaia ? 30 : 70) : 0)
      + (s.kinds.includes('changed') ? (s.gaia?.var ? 20 : 60) : 0) + (s.kinds.includes('unlisted') ? 5 : 0) + Math.min(4, s.snr / 100);
  }
  // Sources that were in the 2010 image and are not seen now, and were not explained as one end of a fast mover.
  for (const g of gone) {
    if (g.used || !S.reportGone) continue; // off by default for the same reason
    let best = null, bd = 8;
    for (const st of S.gaia || []) { const [ge, gn] = gaiaAt(st, wiseMjd), d = Math.hypot(ge - g.e, gn - g.n); if (d < bd) { bd = d; best = st; } }
    found.push({ e: g.e, n: g.n, ra: S.ra + g.e / 3600 / cosd, dec: S.dec + g.n / 3600, snr: g.v / sigma, gaia: best, gaiaNear: best ? 1 : 0, wise: { e: g.e, n: g.n, snr: g.v / wsig }, pass: [], saturated: false, nphot: 0, change: null, moved: null, kinds: ['gone'], score: best ? 25 : 50 });
  }
  found.sort((a, b) => b.score - a.score);
  const count = (k) => found.filter((s) => s.kinds.includes(k)).length;
  return {
    sources: found,
    summary: { sources: found.length - count('gone'), moved: count('moved'), appeared: count('appeared'), gone: count('gone'), changed: count('changed'), unlisted: count('unlisted'), positionScatterArcsec: +scatter.toFixed(2), hasWise: !!wimg, passes: passes.map((e) => e.label) },
  };
}

/** Plain-language one-liner for a scanned source. */
export function describe(s) {
  const bits = [];
  if (s.kinds.includes('moved')) bits.push(`moved ${s.moved.arcsec.toFixed(s.moved.arcsec > 30 ? 0 : 1)}″ since 2010 (${s.moved.perYear.toFixed(2)}″/yr)`);
  if (s.kinds.includes('appeared')) bits.push('nothing here in the 2010 image');
  if (s.kinds.includes('gone')) bits.push('in the 2010 image, not seen by SPHEREx');
  if (s.kinds.includes('changed')) bits.push(`${s.change.percent > 0 ? 'brightened' : 'faded'} ${Math.abs(s.change.percent).toFixed(0)}% from ${s.change.from} to ${s.change.to}`);
  if (!s.gaia) bits.push('not in Gaia');
  else if (s.gaia.var) bits.push('Gaia: known variable');
  else if (s.kinds.includes('moved') && s.gaia.pm > 0.05) bits.push(`Gaia star, ${s.gaia.pm.toFixed(2)}″/yr`);
  return bits.join(' · ');
}
