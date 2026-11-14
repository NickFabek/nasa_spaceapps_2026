// GET /api/resolve?name=<object name>
// Resolves a name with the CDS Sesame service and moves the catalogue (J2000)
// position forward to today using the catalogued proper motion, so that
// fast-moving stars land in the middle of the field.
import { json } from '../../lib/config.js';

export async function onRequestGet({ request }) {
  const name = (new URL(request.url).searchParams.get('name') || '').trim();
  if (!name || name.length > 80) return json({ error: 'name required' }, 400);
  const r = await fetch(`https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/SNV?${encodeURIComponent(name)}`);
  if (!r.ok) return json({ error: `resolver HTTP ${r.status}` }, 502);
  const text = await r.text();
  const j = /^%J\s+([\d.+-]+)\s+([\d.+-]+)/m.exec(text);
  if (!j) return json({ error: `"${name}" was not recognised` }, 404, 3600);
  let ra = +j[1], dec = +j[2];
  const p = /^%P\s+([\d.+-]+)\s+([\d.+-]+)/m.exec(text);
  let pm = null;
  if (p) {
    pm = { ra: +p[1], dec: +p[2] }; // mas/yr, pm.ra includes cos(dec)
    const years = (Date.now() - Date.UTC(2000, 0, 1, 12)) / (365.25 * 864e5);
    dec += (pm.dec * years) / 3.6e6;
    ra += (pm.ra * years) / 3.6e6 / Math.cos((dec * Math.PI) / 180);
    ra = ((ra % 360) + 360) % 360;
  }
  const oname = /^%I\.0\s+(.+)$/m.exec(text);
  return json({ name: oname ? oname[1].trim() : name, ra, dec, pm }, 200, 86400);
}
