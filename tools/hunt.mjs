#!/usr/bin/env node
// Headless hunter: runs the site's own search, cutout and scan code directly in Node, so long
// hunts do not spend the deployed site's Cloudflare request allowance.
//
//   node tools/hunt.mjs fields.json            scan a list of [tag, ra, dec] fields (10 arcmin each)
//   node tools/hunt.mjs --inspect ra,dec       load a 6 arcmin field centred on one source and report on it
//
// Results are appended to tools/hunt-results.jsonl (git-ignored).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestGet as searchFn } from '../app/functions/api/search.js';
import { onRequestGet as cutoutFn } from '../app/functions/api/cutout.js';
import { onRequestGet as wiseFn } from '../app/functions/api/wise.js';
import { scanField, aperture, describe } from '../app/pages/js/scan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'hunt-results.jsonl');
const PIX = 6.15, OFF_DETECTOR = 1 << 30;
const MASK = [6, 9, 10, 11].reduce((m, b) => m | (1 << b), OFF_DETECTOR); // the page's default hidden flags
const SUSPECT = [0, 1, 2, 6, 9, 10, 11, 15, 17, 19, 20, 22, 23, 24, 25, 27].reduce((m, b) => m | (1 << b), 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = (url) => ({ request: new Request(url), env: {}, waitUntil() {} });
const month = (mjd) => new Date((mjd - 40587) * 864e5).toLocaleString('en', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

function decode(buf) {
  const n = new DataView(buf).getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
  const px = meta.T * meta.T, o = 4 + n;
  return { meta, img: new Float32Array(buf.slice(o, o + 4 * px)), flags: new Int32Array(buf.slice(o + 4 * px, o + 8 * px)) };
}
function stats(f) {
  const vals = f.img.filter(Number.isFinite).sort();
  if (!vals.length) return false;
  f.bg = vals[vals.length >> 1];
  const dev = vals.map((v) => Math.abs(v - f.bg)).sort();
  f.sig = Math.max(1e-6, 1.4826 * dev[dev.length >> 1]);
  f.p99 = Math.max(f.sig, vals[Math.floor(vals.length * 0.995)] - f.bg);
  return true;
}

async function gaia(ra, dec, r) {
  const adql = `SELECT TOP 600 source_id,ra,dec,pmra,pmdec,parallax,phot_g_mean_mag,phot_variable_flag FROM gaiadr3.gaia_source WHERE 1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',${ra},${dec},${(r / 3600).toFixed(5)})) AND phot_g_mean_mag<20 ORDER BY phot_g_mean_mag`;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch('https://gea.esac.esa.int/tap-server/tap/sync', { method: 'POST', body: new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: adql }), signal: AbortSignal.timeout(60000) });
      if (!res.ok) continue;
      const cosd = Math.cos(dec * Math.PI / 180);
      return (await res.text()).trim().split('\n').slice(1).map((l) => {
        const f = l.split(','); let dra = +f[1] - ra; if (dra > 180) dra -= 360; if (dra < -180) dra += 360;
        const pe = (+f[3] || 0) / 1000, pn = (+f[4] || 0) / 1000;
        return { id: f[0], g: +f[6], var: /VARIABLE/.test(f[7] || '') && !/NOT/.test(f[7] || ''), e0: dra * cosd * 3600, n0: (+f[2] - dec) * 3600, pe, pn, pm: Math.hypot(pe, pn) };
      });
    } catch (e) { /* retry */ }
  }
  return null;
}

/** Load one field exactly as the page does and return the state object the scan needs. */
export async function loadField(ra, dec, fov = 10) {
  let res;
  for (let attempt = 0; attempt < 12; attempt++) {
    res = await (await searchFn(ctx(`http://local/api/search?ra=${ra}&dec=${dec}`))).json();
    if (res.frames && !res.errors?.length) break;
    await sleep(4000);
  }
  if (!res.frames) throw new Error('archive search failed');
  if (!res.frames.length) throw new Error('no SPHEREx images');
  const half = Math.min(160, Math.ceil(((fov * 60) / 2 / PIX) * 1.45) + 3), T = 2 * half + 1;
  const pos = `ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}&half=${half}`;
  const frames = [];
  await pool(res.frames, 24, async (f) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await cutoutFn(ctx(`http://local/api/cutout?key=${encodeURIComponent(f.key)}&${pos}`));
        if (r.status === 204) return;
        if (!r.ok) { await sleep(500); continue; }
        const d = decode(await r.arrayBuffer());
        const fr = { ...f, ...d, src: 'SPX', state: 'ok', mjd: d.meta.mjd ?? f.mjd };
        if (stats(fr)) frames.push(fr);
        return;
      } catch (e) { await sleep(500); }
    }
  });
  if (!frames.length) throw new Error('no exposures loaded');
  // 2010 WISE, scaled to the brightness of the matching SPHEREx band (as the page does)
  await Promise.all([1, 2].map(async (band) => {
    try {
      const r = await wiseFn(ctx(`http://local/api/wise?${pos}&scale=${((fov * 60 * 1.1) / T).toFixed(3)}&band=${band}`));
      if (!r.ok || r.status === 204) return;
      const d = decode(await r.arrayBuffer());
      const fr = { ...d, src: 'WISE', band, det: band === 1 ? 4 : 6, state: 'ok', mjd: d.meta.mjd ?? 55366, rel: 'allwise', obs: `AllWISE W${band}` };
      if (!stats(fr)) return;
      let ref = frames.filter((x) => x.det === fr.det); if (!ref.length) ref = frames;
      const k = median(ref.map((x) => x.p99)) / fr.p99, bg = fr.bg;
      fr.img = fr.img.map((v) => (v - bg) * k); fr.bg = 0; fr.sig *= k;
      frames.push(fr);
    } catch (e) { /* motion is simply not checked without WISE */ }
  }));
  frames.sort((a, b) => a.mjd - b.mjd);
  const epochs = []; let last = -Infinity, k = 0;
  for (const f of frames) {
    if (f.mjd - last > 45) epochs.push({ i: epochs.length, t0: f.mjd, t1: f.mjd, n: 0, src: f.src });
    const e = epochs.at(-1); f.epoch = e.i; e.t1 = f.mjd; e.n++; last = f.mjd;
  }
  for (const e of epochs) { e.label = e.src === 'WISE' ? '2010' : month((e.t0 + e.t1) / 2); e.k = e.src === 'SPX' ? k++ : -1; }
  const spx = frames.filter((f) => f.src === 'SPX');
  return { ra, dec, fov, T, frames, epochs, gaia: await gaia(ra, dec, Math.min(900, Math.round((fov * 60) / 2 * 1.45))), tRef: (spx[0].mjd + spx.at(-1).mjd) / 2, mask: MASK, suspect: SUSPECT, partial: !!res.errors?.length };
}

/** Per-band change between pass pairs using only exposures at matched wavelengths. */
function matched(S, s) {
  const pts = [];
  for (const f of S.frames) {
    if (f.src !== 'SPX') continue;
    const { px, py, J } = f.meta;
    const a = aperture(f, px + J[0] * s.e + J[1] * s.n, py + J[2] * s.e + J[3] * s.n, S.mask);
    if (!a || a.nan || (a.flags & SUSPECT) || !(a.sum > 0)) continue;
    pts.push({ um: f.meta.wave ? f.meta.wave.um : (f.wmin + f.wmax) / 2, det: f.det, ep: f.epoch, flux: a.sum });
  }
  const passes = S.epochs.filter((e) => e.src === 'SPX'), out = [];
  for (let a = 0; a < passes.length; a++) for (let b = a + 1; b < passes.length; b++) {
    const row = [];
    for (let det = 1; det <= 6; det++) {
      const logs = [];
      for (const p of pts) {
        if (p.ep !== passes[a].i || p.det !== det) continue;
        let q = null, qd = (det >= 5 ? 0.005 : 0.012) * p.um;
        for (const r of pts) { const d = Math.abs(r.um - p.um); if (r.ep === passes[b].i && r.det === det && d < qd) { qd = d; q = r; } }
        if (q) logs.push(Math.log(q.flux / p.flux));
      }
      if (logs.length >= 3) row.push(`D${det} ${Math.round((Math.exp(median(logs)) - 1) * 100)}%(${logs.length})`);
    }
    if (row.length) out.push(`${passes[a].label}>${passes[b].label}: ${row.join(' ')}`);
  }
  return out;
}

const brief = (s) => ({
  ra: +s.ra.toFixed(5), dec: +s.dec.toFixed(5), snr: Math.round(s.snr), kinds: s.kinds, gaia: s.gaia ? { g: +s.gaia.g.toFixed(1), var: s.gaia.var } : null,
  change: s.change && { pct: Math.round(s.change.percent), z: +s.change.z.toFixed(1), n: s.change.n, from: s.change.from, to: s.change.to, sameSeason: s.change.sameSeason, byBand: !!s.change.byBand },
  summary: describe(s),
});

async function inspect(ra, dec) {
  const S = await loadField(ra, dec, 6);
  const scan = scanField(S);
  const s = scan.sources.map((t) => [Math.hypot(t.e, t.n), t]).sort((a, b) => a[0] - b[0])[0]?.[1];
  if (!s || Math.hypot(s.e, s.n) > 8) return console.log(JSON.stringify({ ra, dec, error: 'no source at the centre', sources: scan.sources.length }));
  const pp = (s.pass || []).filter(Boolean); let spread = 0;
  for (const a of pp) for (const b of pp) spread = Math.max(spread, Math.hypot(a[0] - b[0], a[1] - b[1]));
  const spx = S.frames.filter((f) => f.src === 'SPX');
  console.log(JSON.stringify({
    ...brief(s), exposures: spx.length, passes: S.epochs.filter((e) => e.src === 'SPX').map((e) => `${e.label}:${e.n}`), partial: S.partial,
    saturated: s.saturated, gaiaNear: s.gaiaNear, nearBright: s.nearBright, neighbour: s.neighbour, unstable: s.unstable, centroidSpreadArcsec: +spread.toFixed(1),
    wise2010: s.moved ? { offsetArcsec: +s.moved.arcsec.toFixed(1), brightnessRatio: +s.moved.brightnessRatio.toFixed(2) } : null,
    neighbours_dist_snr: scan.sources.filter((t) => t !== s && Math.hypot(t.e - s.e, t.n - s.n) < 70).map((t) => [Math.round(Math.hypot(t.e - s.e, t.n - s.n)), Math.round(t.snr)]),
    controlStarsPercent: scan.sources.filter((t) => t !== s && t.change && t.snr > 30 && !t.saturated).sort((a, b) => b.snr - a.snr).slice(0, 14).map((t) => Math.round(t.change.percent)),
    matchedWavelengthChange: matched(S, s),
  }));
}

async function hunt(file) {
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).tag) : []);
  await pool(list.filter(([tag]) => !done.has(tag)), 3, async ([tag, ra, dec]) => {
    const t0 = Date.now(); let rec;
    try {
      const S = await loadField(ra, dec, 10);
      const scan = scanField(S);
      rec = { tag, ra, dec, seconds: Math.round((Date.now() - t0) / 1000), exposures: S.frames.filter((f) => f.src === 'SPX').length, passes: S.epochs.filter((e) => e.src === 'SPX').length, wise: S.frames.some((f) => f.src === 'WISE'), partial: S.partial, summary: scan.summary, changed: scan.sources.filter((s) => s.kinds.includes('changed')).map(brief) };
    } catch (e) { rec = { tag, ra, dec, error: String(e.message || e) }; }
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
    console.log(`${tag}: ${rec.error || `${rec.exposures} exp, ${rec.seconds}s, ${rec.changed.length} changed`}${rec.changed?.length ? ' -> ' + rec.changed.map((c) => `${c.ra},${c.dec} ${c.summary}`).join(' ; ') : ''}`);
  });
}

// The Gaia function in the site uses the Workers cache; nothing here needs it.
if (process.argv[2] === '--inspect') { const [ra, dec] = process.argv[3].split(',').map(Number); await inspect(ra, dec); } else if (process.argv[2]) await hunt(process.argv[2]);
else console.log('usage: node tools/hunt.mjs fields.json | --inspect ra,dec');
