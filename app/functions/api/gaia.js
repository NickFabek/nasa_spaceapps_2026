// GET /api/gaia?ra=<deg>&dec=<deg>&r=<arcsec>
// Brightest Gaia DR3 stars in the field, with proper motions, so the page can
// draw every catalogued star where it should be on any date.
import { json } from '../../lib/config.js';

const TAP = 'https://gea.esac.esa.int/tap-server/tap/sync';

export async function onRequestGet({ request, waitUntil }) {
  const q = new URL(request.url).searchParams;
  const ra = Number(q.get('ra')), dec = Number(q.get('dec'));
  const r = Math.min(900, Math.max(30, Number(q.get('r')) || 240));
  if (!(ra >= 0 && ra < 360 && dec >= -90 && dec <= 90) || q.get('ra') === null) return json({ error: 'ra/dec required' }, 400);

  const cacheKey = new Request(`https://cache.local/gaia2/${ra.toFixed(4)}/${dec.toFixed(4)}/${r}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const adql = `SELECT TOP 600 source_id,ra,dec,pmra,pmdec,parallax,phot_g_mean_mag,phot_variable_flag FROM gaiadr3.gaia_source `
    + `WHERE 1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',${ra},${dec},${(r / 3600).toFixed(5)})) `
    + `AND phot_g_mean_mag<20 ORDER BY phot_g_mean_mag`;
  const body = new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: adql });
  let text;
  try {
    const res = await fetch(TAP, { method: 'POST', body });
    if (!res.ok) return json({ error: `Gaia archive HTTP ${res.status}` }, 502);
    text = await res.text();
  } catch (e) {
    return json({ error: 'Gaia archive unreachable' }, 502);
  }
  const num = (v) => (v === '' || v === undefined ? null : Number(v));
  const stars = text.trim().split('\n').slice(1).map((line) => {
    const f = line.split(',');
    return { id: f[0], ra: +f[1], dec: +f[2], pmra: num(f[3]), pmdec: num(f[4]), plx: num(f[5]), g: num(f[6]), var: /^"?VARIABLE/.test(f[7] || '') };
  }).filter((s) => Number.isFinite(s.ra));
  const out = json({ epoch: 2016.0, stars }, 200, 604800);
  waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}
