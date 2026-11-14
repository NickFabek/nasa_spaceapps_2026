#!/usr/bin/env node
// Cross-check sky positions against the catalogues used to decide whether a flagged source is new.
//   node tools/crosscheck.mjs "ra,dec[,label]" ...
// Uses the Harvard mirrors of SIMBAD and VizieR (the CDS originals are sometimes down) and ESA's Gaia archive.
const text = async (url) => { for (let i = 0; i < 3; i++) { try { const r = await fetch(url, { signal: AbortSignal.timeout(60000) }); if (r.ok) return await r.text(); } catch (e) { /* retry */ } } return null; };
const tap = async (base, params) => { const u = new URL(base); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); const t = await text(u); return t === null ? ['(query failed)'] : t.trim().split('\n').slice(1); };
const esa = (q) => tap('https://gea.esac.esa.int/tap-server/tap/sync', { REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: q });
const simbad = (q) => tap('https://simbad.cfa.harvard.edu/simbad/sim-tap/sync', { request: 'doQuery', lang: 'adql', format: 'csv', query: q });
const vizier = async (cat, ra, dec, radius, cols = '') => {
  const t = await text(`https://vizier.cfa.harvard.edu/viz-bin/asu-tsv?-source=${encodeURIComponent(cat)}&-c=${ra}${+dec >= 0 ? '%2B' : ''}${dec}&-c.rs=${radius}&-out.max=5${cols ? '&-out=' + cols : ''}`);
  if (t === null) return ['(query failed)'];
  const rows = t.split('\n').filter((l) => l.trim() && !l.startsWith('#')); const dash = rows.findIndex((l) => /^-+/.test(l));
  return dash < 0 ? [] : rows.slice(dash + 1).map((l) => l.replace(/\s+/g, ' ').trim());
};
const VARIABLE_CATALOGUES = { 'ZTF periodic (Chen+ 2020)': 'J/ApJS/249/18', 'WISE periodic (Chen+ 2018)': 'J/ApJS/237/28', 'WISE variables (Petrosky+ 2021)': 'J/MNRAS/503/3975', 'Gaia DR3 variables': 'I/358/varisum' };

for (const arg of process.argv.slice(2)) {
  const [ra, dec, label] = arg.split(','); const P = `POINT('ICRS', ${ra}, ${dec})`;
  const circle = (r) => `CIRCLE('ICRS', ${ra}, ${dec}, ${r / 3600})`;
  const [s, g, t, w, vsx, ...vars] = await Promise.all([
    simbad(`SELECT TOP 5 main_id, otype, ROUND(DISTANCE(POINT('ICRS', ra, dec), ${P})*3600, 1) AS d FROM basic WHERE 1=CONTAINS(POINT('ICRS', ra, dec), ${circle(15)}) ORDER BY d`),
    esa(`SELECT TOP 2 g.source_id, ROUND(g.phot_g_mean_mag, 1), ROUND(g.bp_rp, 1), g.phot_variable_flag, v.best_class_name, ROUND(DISTANCE(POINT('ICRS', g.ra, g.dec), ${P})*3600, 1) AS d FROM gaiadr3.gaia_source AS g LEFT JOIN gaiadr3.vari_classifier_result AS v ON v.source_id = g.source_id WHERE 1=CONTAINS(POINT('ICRS', g.ra, g.dec), ${circle(5)}) ORDER BY d`),
    esa(`SELECT TOP 2 designation, j_m, h_m, ks_m, ROUND(DISTANCE(POINT('ICRS', ra, dec), ${P})*3600, 1) AS d FROM gaiadr1.tmass_original_valid WHERE 1=CONTAINS(POINT('ICRS', ra, dec), ${circle(8)}) ORDER BY d`),
    esa(`SELECT TOP 2 designation, w1mpro, w2mpro, w3mpro, w4mpro, var_flag, ROUND(DISTANCE(POINT('ICRS', ra, dec), ${P})*3600, 1) AS d FROM gaiadr1.allwise_original_valid WHERE 1=CONTAINS(POINT('ICRS', ra, dec), ${circle(8)}) ORDER BY d`),
    vizier('B/vsx/vsx', ra, dec, 12, 'Name,Type,Period'),
    ...Object.values(VARIABLE_CATALOGUES).map((id) => vizier(id, ra, dec, 4)),
  ]);
  const show = (rows) => (rows.length ? rows.join(' | ') : 'none');
  console.log(`\n## ${label || ''} ${ra} ${dec}`);
  console.log(` SIMBAD within 15":  ${show(s)}`);
  console.log(` Gaia DR3 within 5": ${show(g)}`);
  console.log(` 2MASS within 8":    ${show(t)}`);
  console.log(` AllWISE within 8":  ${show(w)}   (table is the Gaia-crossmatch subset, so absence is not proof)`);
  console.log(` AAVSO VSX 12":      ${show(vsx)}`);
  Object.keys(VARIABLE_CATALOGUES).forEach((name, i) => console.log(` ${name}: ${vars[i][0] === '(query failed)' ? 'query failed' : vars[i].length + ' match(es)'}`));
}
