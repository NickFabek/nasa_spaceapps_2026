// GET /api/wise?ra=<deg>&dec=<deg>&half=<pixels>&scale=<arcsec/pixel>&band=1|2
// A north-up tile of the 2010 AllWISE atlas at the same position, in the same
// binary format as /api/cutout, so WISE can be blinked against SPHEREx for a
// 15-year baseline. Read with range requests from the public WISE bucket.
import { SIA_URL, json, irsaText } from '../../lib/config.js';
import { BLOCK, parseHeader, makeSinWcs } from '../../lib/fits.js';

const VERSION = 'v1';
const S3 = 'https://nasa-irsa-wise.s3.us-west-2.amazonaws.com/wise/allwise/images/';
const IBE = 'https://irsa.ipac.caltech.edu/ibe/data/wise/allwise/';
const MJD = (iso) => Date.parse(iso + 'Z') / 864e5 + 40587;

async function range(url, a, b) {
  const r = await fetch(url, { headers: { Range: `bytes=${a}-${b}` } });
  if (r.status !== 206) throw new Error(`WISE bucket HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function findTile(ra, dec, band) {
  const text = await irsaText(`${SIA_URL}?COLLECTION=wise_allwise&POS=circle+${ra}+${dec}+0.01&RESPONSEFORMAT=CSV`);
  const lines = text.trim().split('\n');
  const head = lines[0].split(',');
  const iRa = head.indexOf('s_ra'), iDec = head.indexOf('s_dec'), iUrl = head.indexOf('access_url');
  let best = null;
  for (const line of lines.slice(1)) {
    const f = line.split(',');
    const url = f[iUrl] || '';
    if (!url.endsWith(`-w${band}-int-3.fits`) || !url.startsWith(IBE)) continue;
    const d = Math.hypot((+f[iRa] - ra) * Math.cos(dec * Math.PI / 180), +f[iDec] - dec);
    if (!best || d < best.d) best = { d, key: url.slice(IBE.length) };
  }
  return best && best.key;
}

async function build(ra, dec, half, scale, band) {
  const key = await findTile(ra, dec, band);
  if (!key) return null;
  const url = S3 + key;
  const h = parseHeader(await range(url, 0, 12 * BLOCK - 1), 0);
  if (!h) throw new Error('WISE header not found');
  const c = h.cards, W = c.NAXIS1, H = c.NAXIS2, sky2pix = makeSinWcs(c);
  const T = 2 * half + 1, cosd = Math.cos(dec * Math.PI / 180);
  // Input-pixel coordinates for the corners tell us which rows to read.
  const span = half * scale / 3600;
  const ys = [sky2pix(ra, dec - span)[1], sky2pix(ra, dec + span)[1], sky2pix(ra + span / cosd, dec + span)[1], sky2pix(ra - span / cosd, dec - span)[1]];
  const ya = Math.max(0, Math.floor(Math.min(...ys)) - 3), yb = Math.min(H - 1, Math.ceil(Math.max(...ys)) + 1);
  if (yb <= ya || yb - ya > 1400) return null;
  const rows = await range(url, h.len + ya * W * 4, h.len + (yb + 1) * W * 4 - 1);
  const dv = new DataView(rows.buffer, rows.byteOffset, rows.byteLength);
  const at = (x, y) => (x < 0 || y < ya || x >= W || y > yb ? NaN : dv.getFloat32(((y - ya) * W + x) * 4));
  const bilinear = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    return (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
  };
  const image = new Float32Array(T * T), sub = [-0.25, 0.25];
  for (let j = 0; j < T; j++)
    for (let i = 0; i < T; i++) {
      let sum = 0;
      for (const dy of sub) for (const dx of sub) {
        const east = -(i + dx - half) * scale / 3600, north = (j + dy - half) * scale / 3600;
        const [x, y] = sky2pix(ra + east / cosd, dec + north);
        sum += bilinear(x - 1, y - 1);
      }
      image[j * T + i] = sum / 4;
    }
  const mjd = c.DATEOBS1 && c.DATEOBS2 ? (MJD(c.DATEOBS1) + MJD(c.DATEOBS2)) / 2 : 55400;
  const meta = { key, T, px: half, py: half, J: [-1 / scale, 0, 0, 1 / scale], src: 'WISE', band, um: band === 1 ? 3.4 : 4.6, mjd, hdr: { DATEOBS1: c.DATEOBS1, DATEOBS2: c.DATEOBS2 } };
  let enc = new TextEncoder().encode(JSON.stringify(meta));
  if (enc.length % 4) enc = new TextEncoder().encode(JSON.stringify(meta) + ' '.repeat(4 - (enc.length % 4)));
  const out = new Uint8Array(4 + enc.length + 8 * T * T);
  const o = new DataView(out.buffer);
  o.setUint32(0, enc.length, true);
  out.set(enc, 4);
  for (let k = 0; k < T * T; k++) o.setFloat32(4 + enc.length + 4 * k, image[k], true);
  return out; // flags stay zero
}

const binHeaders = { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=31536000, immutable' };

export async function onRequestGet({ request, env, waitUntil }) {
  const q = new URL(request.url).searchParams;
  const ra = Number(q.get('ra')), dec = Number(q.get('dec'));
  const half = Math.min(160, Math.max(4, Math.round(Number(q.get('half')) || 40)));
  const scale = Math.min(8, Math.max(1.375, Number(q.get('scale')) || 2.75));
  const band = q.get('band') === '1' ? 1 : 2;
  if (!(ra >= 0 && ra < 360 && dec >= -90 && dec <= 90) || q.get('ra') === null) return json({ error: 'ra/dec required' }, 400);
  const cacheKey = `wise/${VERSION}/${ra.toFixed(5)}_${dec.toFixed(5)}_${half}_${scale.toFixed(3)}_w${band}`;
  if (env.CACHE) {
    const hit = await env.CACHE.get(cacheKey);
    if (hit) return new Response(hit.body, { headers: binHeaders });
  }
  try {
    const body = await build(ra, dec, half, scale, band);
    if (!body) return new Response(null, { status: 204, headers: { 'cache-control': 'public, max-age=86400' } }); // nothing here
    if (env.CACHE) waitUntil(env.CACHE.put(cacheKey, body));
    return new Response(body, { headers: binHeaders });
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
}
