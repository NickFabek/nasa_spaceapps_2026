#!/usr/bin/env node
// Check motion flags against CatWISE2020 proper motions (IRSA Gator).
//   node tools/catwise.mjs flags.json out.json     flags: [{ra, dec, moved: {east, north, perYear}}, ...]
import fs from 'node:fs';
const flags = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const gator = async (ra, dec, radius) => {
  const u = new URL('https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query');
  for (const [k, v] of Object.entries({ catalog: 'catwise_2020', spatial: 'cone', radius: String(radius), radunits: 'arcsec', objstr: `${ra} ${dec >= 0 ? '+' : ''}${dec}`, outfmt: '1', selcols: 'source_name,ra,dec,pmra,pmdec,sigpmra,sigpmdec,w1mpro,w2mpro,w1snr,w2snr' })) u.searchParams.set(k, v);
  for (let i = 0; i < 5; i++) {
    try {
      const t = await (await fetch(u, { signal: AbortSignal.timeout(90000) })).text();
      const lines = t.split('\n'); const hl = lines.find((l) => l.startsWith('|'));
      if (!hl) { if (/RowsRetrieved\s*=\s*0/.test(t)) return []; await new Promise((s) => setTimeout(s, 3000)); continue; }
      const head = hl.split('|').map((s) => s.trim()).filter(Boolean);
      return lines.filter((l) => l.trim() && !/^[\\|]/.test(l)).map((l) => { const f = l.trim().split(/\s+/); const o = {}; head.forEach((h, k) => { o[h] = f[k]; }); return o; });
    } catch (e) { await new Promise((s) => setTimeout(s, 3000)); }
  }
  return null;
};
let i = 0; const out = [];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (i < flags.length) {
    const f = flags[i++], cosd = Math.cos(f.dec * Math.PI / 180);
    const rows = await gator(f.ra, f.dec, Math.min(60, Math.max(8, f.moved.perYear * 13 + 5)));
    let best = null;
    for (const r of rows || []) {
      // CatWISE positions are for about 2014-2015; where would this source be in 2026 with CatWISE's own motion?
      const pe = +r.pmra, pn = +r.pmdec, dt = 11.5;
      const de = (+r.ra - f.ra) * cosd * 3600 + pe * dt, dn = (+r.dec - f.dec) * 3600 + pn * dt, d = Math.hypot(de, dn);
      const pm = Math.hypot(pe, pn), sig = Math.hypot(+r.sigpmra, +r.sigpmdec) || 1;
      if (!best || d < best.sepNow) best = { name: r.source_name, sepNow: +d.toFixed(1), pmE: pe, pmN: pn, pm: +pm.toFixed(3), snr: +(pm / sig).toFixed(1), w1: +r.w1mpro, w2: +r.w2mpro };
    }
    out.push({ ...f, catwise: rows === null ? 'failed' : best });
  }
}));
fs.writeFileSync(process.argv[3], JSON.stringify(out));
const ok = out.filter((o) => o.catwise && o.catwise !== 'failed');
const real = ok.filter((o) => o.catwise.sepNow < 6 && o.catwise.pm > 0.12 && o.catwise.snr > 5 && Math.hypot(o.catwise.pmE - o.moved.east, o.catwise.pmN - o.moved.north) < Math.max(0.15, 0.5 * o.moved.perYear));
console.log(`${out.length} flags: ${out.filter((o) => o.catwise === 'failed').length} queries failed, ${out.filter((o) => o.catwise === null).length} no CatWISE source, ${real.length} confirmed by CatWISE motion`);
for (const o of real.sort((a, b) => b.catwise.pm - a.catwise.pm)) console.log(`${o.tag} ${o.ra} ${o.dec} ours ${o.moved.perYear}"/yr (E ${o.moved.east}, N ${o.moved.north}) | CatWISE ${o.catwise.pm}"/yr (E ${o.catwise.pmE}, N ${o.catwise.pmN}) ${o.catwise.snr}σ W1 ${o.catwise.w1} W2 ${o.catwise.w2} | Gaia ${o.gaia ? 'G' + o.gaia.g + ' pm' + o.gaiaPm : 'none'}`);
