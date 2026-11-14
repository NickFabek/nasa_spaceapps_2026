// GET /api/search?ra=<deg>&dec=<deg>
// Lists every SPHEREx spectral image that covers the position, across all
// configured releases, by asking IRSA's Simple Image Access service live.
import { COLLECTIONS, SIA_URL, IBE_PREFIX, json, irsaText } from '../../lib/config.js';

const FRESH_MS = 6 * 3600 * 1000; // how long a stored answer is used before asking IRSA again

// One collection's frame list. Answers are kept in R2 so that a burst of IRSA
// errors (it has them) falls back to the last good answer instead of failing.
async function sia(collection, ra, dec, env) {
  const key = `sia/v1/${collection}/${ra}_${dec}`;
  let stored = null;
  if (env.CACHE) {
    const obj = await env.CACHE.get(key);
    if (obj) stored = { at: +(obj.customMetadata?.at || 0), frames: await obj.json() };
    if (stored && Date.now() - stored.at < FRESH_MS) return stored.frames;
  }
  try {
    const url = `${SIA_URL}?COLLECTION=${collection}&POS=circle+${ra}+${dec}+0.003&RESPONSEFORMAT=CSV`;
    const frames = parse(await irsaText(url), collection);
    if (env.CACHE) await env.CACHE.put(key, JSON.stringify(frames), { customMetadata: { at: String(Date.now()) } });
    return frames;
  } catch (e) {
    if (stored) return stored.frames;
    throw e;
  }
}

function parse(csv, collection) {
  const lines = csv.trim().split('\n');
  const head = lines[0].split(',');
  const col = (n) => head.indexOf(n);
  const iBand = col('energy_bandpassname'), iObs = col('obs_id'), iUrl = col('access_url'),
    iT0 = col('t_min'), iT1 = col('t_max'), iMin = col('em_min'), iMax = col('em_max');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    // Only leading columns are used; a trailing JSON column contains unquoted commas.
    const f = lines[i].split(',');
    const url = f[iUrl];
    if (!url || !url.startsWith(IBE_PREFIX)) continue;
    out.push({
      obs: f[iObs],
      det: +f[iBand].replace('SPHEREx-D', ''),
      mjd: (+f[iT0] + +f[iT1]) / 2,
      wmin: +f[iMin] * 1e6,
      wmax: +f[iMax] * 1e6,
      key: url.slice(IBE_PREFIX.length),
      rel: collection.replace('spherex_', ''),
    });
  }
  return out;
}

export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams;
  const ra = Number(q.get('ra')), dec = Number(q.get('dec'));
  if (!(ra >= 0 && ra < 360 && dec >= -90 && dec <= 90)) return json({ error: 'ra/dec required (degrees)' }, 400);

  const results = await Promise.allSettled(COLLECTIONS.map((c) => sia(c, ra.toFixed(5), dec.toFixed(5), env)));
  const seen = new Set(), frames = [], errors = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return errors.push(String(r.reason.message || r.reason));
    for (const f of r.value) {
      const id = `${f.obs}/${f.det}`;
      if (seen.has(id)) continue;
      seen.add(id);
      frames.push(f);
    }
  });
  if (!frames.length && errors.length) return json({ error: errors.join('; ') }, 502);
  frames.sort((a, b) => a.mjd - b.mjd || a.det - b.det);
  return json({ ra, dec, collections: COLLECTIONS, errors, frames }, 200, errors.length ? 0 : 600);
}
