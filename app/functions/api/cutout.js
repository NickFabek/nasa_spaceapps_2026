// GET /api/cutout?key=<file key>&ra=<deg>&dec=<deg>&half=<pixels>
// Cuts a (2*half+1)^2 pixel tile out of one SPHEREx spectral image by reading
// only the needed byte ranges from the public S3 mirror, and returns:
//   uint32 LE  length of JSON metadata
//   JSON       metadata (padded with spaces to a 4-byte boundary)
//   float32[]  image      (MJy/sr, NaN where off-detector)
//   int32[]    flags      (bit 30 set where off-detector)
// Results are immutable per file, so they are stored in R2 (binding CACHE).
import { S3_URL, json } from '../../lib/config.js';
import { BLOCK, parseHeader, dataBytes, makeWcs, parseWaveTable, waveAt, riceDecode32 } from '../../lib/fits.js';

const VERSION = 'v3';
const OFF_DETECTOR = 1 << 30;
const KEEP = ['OBSID', 'DETECTOR', 'DATE-AVG', 'MJD-AVG', 'XPOSURE', 'PSF_FWHM', 'OMEGA_MEDIAN',
  'L1DQAFLG', 'L2DQAFLG', 'FINAST', 'AURORA_CONT', 'SHUTTLE_GLOW_CONT', 'HE_AIRGLOW_CONT', 'OBS_IN_SBAND', 'VERSION'];

async function range(key, start, end) {
  const spec = start < 0 ? `bytes=${start}` : `bytes=${start}-${end}`;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(S3_URL + key, { headers: { Range: spec } });
    if (r.status === 206) {
      const total = +(r.headers.get('content-range') || '').split('/')[1];
      return { bytes: new Uint8Array(await r.arrayBuffer()), total };
    }
    if (r.status === 404 || r.status === 403) throw Object.assign(new Error('file not found'), { status: 404 });
    if (attempt >= 2) throw new Error(`S3 HTTP ${r.status}`);
    await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
  }
}

async function headerAt(key, off, guess = 15 * BLOCK) {
  for (let size = guess; size <= 120 * BLOCK; size *= 2) {
    const { bytes } = await range(key, off, off + size - 1);
    const h = parseHeader(bytes);
    if (h) return h;
  }
  throw new Error('FITS header not terminated');
}

// Read rows y0..y1 of a 2-D image HDU and copy the requested columns into a tile.
async function readTile(key, dataStart, h, box, out, kind) {
  const W = h.NAXIS1, bpp = Math.abs(h.BITPIX) / 8;
  const { xa, xb, ya, yb, x0, y0, T } = box;
  const { bytes } = await range(key, dataStart + ya * W * bpp, dataStart + (yb + 1) * W * bpp - 1);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read = h.BITPIX === -32 ? (o) => dv.getFloat32(o) : h.BITPIX === 32 ? (o) => dv.getInt32(o)
    : h.BITPIX === -64 ? (o) => dv.getFloat64(o) : h.BITPIX === 16 ? (o) => dv.getInt16(o) : null;
  if (!read) throw new Error(`unsupported BITPIX ${h.BITPIX} in ${kind}`);
  for (let y = ya; y <= yb; y++)
    for (let x = xa; x <= xb; x++)
      out[(y - y0) * T + (x - x0)] = read(((y - ya) * W + x) * bpp);
}

// Read rows of a tile-compressed image (one RICE_1 tile per image row), as used for FLAGS.
async function readCompressedTile(key, dataStart, h, box, out) {
  const W = h.ZNAXIS1, rowLen = h.NAXIS1;
  const { xa, xb, ya, yb, x0, y0, T } = box;
  const desc = await range(key, dataStart + ya * rowLen, dataStart + (yb + 1) * rowLen - 1);
  const dv = new DataView(desc.bytes.buffer, desc.bytes.byteOffset, desc.bytes.byteLength);
  const rows = [];
  let lo = Infinity, hi = 0;
  for (let y = ya; y <= yb; y++) {
    const o = (y - ya) * rowLen;
    const n = rowLen === 16 ? Number(dv.getBigInt64(o)) : dv.getInt32(o);
    const off = rowLen === 16 ? Number(dv.getBigInt64(o + 8)) : dv.getInt32(o + 4);
    rows.push([n, off]);
    if (n) { lo = Math.min(lo, off); hi = Math.max(hi, off + n); }
  }
  if (hi <= lo) return;
  const heap = dataStart + (h.THEAP ?? h.NAXIS1 * h.NAXIS2);
  const { bytes } = await range(key, heap + lo, heap + hi - 1);
  rows.forEach(([n, off], i) => {
    if (!n) return;
    const row = riceDecode32(bytes.subarray(off - lo, off - lo + n), W, h.ZVAL1 || 32, xb + 1);
    const y = ya + i;
    for (let x = xa; x <= xb; x++) out[(y - y0) * T + (x - x0)] = row[x];
  });
}

function compressedOk(h, W) {
  return h.ZIMAGE === true && h.ZCMPTYPE === 'RICE_1' && h.ZBITPIX === 32 && h.ZNAXIS1 === W
    && (h.ZTILE1 ?? W) === W && (h.ZTILE2 ?? 1) === 1 && h.TFIELDS === 1 && (h.NAXIS1 === 8 || h.NAXIS1 === 16);
}

async function build(key, ra, dec, half) {
  // Primary header + IMAGE header live in the first few blocks.
  let first = await range(key, 0, 30 * BLOCK - 1);
  const total = first.total;
  const h0 = parseHeader(first.bytes, 0);
  let pos = h0.len + dataBytes(h0.cards);
  let h1 = parseHeader(first.bytes, pos);
  if (!h1) h1 = await headerAt(key, pos, 60 * BLOCK);
  const img = h1.cards;
  if (img.EXTNAME !== 'IMAGE' || img.NAXIS !== 2) throw new Error('unexpected file layout');
  const W = img.NAXIS1, H = img.NAXIS2;

  const wcs = makeWcs(img);
  const p = wcs.sky2pix(ra, dec);
  if (!p) return null;
  const [fx, fy] = p; // 1-based FITS pixel coordinates of the target
  const cx = Math.round(fx) - 1, cy = Math.round(fy) - 1;
  const T = 2 * half + 1, x0 = cx - half, y0 = cy - half;
  const box = { T, x0, y0, xa: Math.max(0, x0), xb: Math.min(W - 1, x0 + T - 1), ya: Math.max(0, y0), yb: Math.min(H - 1, y0 + T - 1) };
  if (cx < 0 || cy < 0 || cx >= W || cy >= H) return null; // target itself is off this detector

  // Local linear map from sky offsets (arcsec east, north of the target) to tile pixels.
  const d = 20, cosd = Math.cos(dec * Math.PI / 180);
  const e1 = wcs.sky2pix(ra + d / 3600 / cosd, dec), e2 = wcs.sky2pix(ra - d / 3600 / cosd, dec);
  const n1 = wcs.sky2pix(ra, dec + d / 3600), n2 = wcs.sky2pix(ra, dec - d / 3600);
  const J = [(e1[0] - e2[0]) / (2 * d), (n1[0] - n2[0]) / (2 * d), (e1[1] - e2[1]) / (2 * d), (n1[1] - n2[1]) / (2 * d)];

  const image = new Float32Array(T * T).fill(NaN);
  const flags = new Int32Array(T * T).fill(OFF_DETECTOR);

  const imgStart = pos + h1.len;
  const jobs = [readTile(key, imgStart, img, box, image, 'IMAGE')];
  // The wavelength lookup table is the last HDU: one header block + one data block.
  const waveJob = range(key, -2 * BLOCK).then(({ bytes }) => {
    const wh = parseHeader(bytes, 0);
    if (!wh || wh.cards.EXTNAME !== 'WCS-WAVE') return null;
    return parseWaveTable(wh.cards, bytes.subarray(wh.len));
  });

  // Walk the following HDUs until FLAGS has been found (normally the very next one).
  let off = imgStart + dataBytes(img);
  const want = { FLAGS: flags };
  let found = 0, hasFlags = false;
  for (let i = 0; i < 5 && found < 1 && off < total; i++) {
    const h = await headerAt(key, off);
    const name = h.cards.EXTNAME;
    if (want[name]) {
      if (h.cards.XTENSION === 'IMAGE' && h.cards.NAXIS1 === W) {
        jobs.push(readTile(key, off + h.len, h.cards, box, want[name], name));
        if (name === 'FLAGS') hasFlags = true;
      } else if (name === 'FLAGS' && compressedOk(h.cards, W)) {
        jobs.push(readCompressedTile(key, off + h.len, h.cards, box, flags));
        hasFlags = true;
      }
      found++;
    }
    off += h.len + dataBytes(h.cards);
  }
  const [tab] = await Promise.all([waveJob, ...jobs]);

  let wave = null;
  if (tab) {
    const wx = (x, y) => waveAt(tab, x - (img.CRPIX1W ?? 0) * (img.CDELT1W ?? 1) + (img.CRVAL1W ?? 0),
      y - (img.CRPIX2W ?? 0) * (img.CDELT2W ?? 1) + (img.CRVAL2W ?? 0));
    const c = wx(fx, fy), dx = wx(fx + 1, fy), dy = wx(fx, fy + 1);
    wave = { um: c[0], bw: c[1], dx: dx[0] - c[0], dy: dy[0] - c[0] };
  }

  const hdr = {};
  for (const k of KEEP) if (img[k] !== undefined) hdr[k] = img[k];
  if (h0.cards.VERSION) hdr.VERSION = h0.cards.VERSION;
  const meta = {
    key, T, x0, y0, px: fx - 1 - x0, py: fy - 1 - y0, J,
    det: img.DETECTOR, mjd: img['MJD-AVG'], wave, hdr, hasFlags,
  };
  return pack(meta, image, flags);
}

function pack(meta, image, flags) {
  let text = JSON.stringify(meta);
  let enc = new TextEncoder().encode(text);
  if (enc.length % 4) enc = new TextEncoder().encode(text + ' '.repeat(4 - (enc.length % 4)));
  const n = image.length;
  const out = new Uint8Array(4 + enc.length + 8 * n);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, enc.length, true);
  out.set(enc, 4);
  let o = 4 + enc.length;
  for (let i = 0; i < n; i++, o += 4) dv.setFloat32(o, image[i], true);
  for (let i = 0; i < n; i++, o += 4) dv.setInt32(o, flags[i], true);
  return out;
}

const binHeaders = {
  'content-type': 'application/octet-stream',
 
  'cache-control': 'public, max-age=31536000, immutable',
};

export async function onRequestGet({ request, env, waitUntil }) {
  const q = new URL(request.url).searchParams;
  const key = q.get('key') || '';
  const ra = Number(q.get('ra')), dec = Number(q.get('dec'));
  const half = Math.min(160, Math.max(4, Math.round(Number(q.get('half')) || 40)));
  // Only SPHEREx Level-2 spectral images, e.g. dr1/level2/2025W33_2C/l2b-v27-2026-228/3/level2_..._spx_....fits
  if (!/^[a-z0-9]+\/level2\/[\w\-]+\/[\w\-]+\/[1-6]\/level2_[\w\-]+\.fits$/.test(key)) return json({ error: 'bad key' }, 400);
  if (!(ra >= 0 && ra < 360 && dec >= -90 && dec <= 90) || q.get('ra') === null) return json({ error: 'ra/dec required' }, 400);

  const cacheKey = `cut/${VERSION}/${key}/${ra.toFixed(5)}_${dec.toFixed(5)}_${half}`;
  if (env.CACHE) {
    const hit = await env.CACHE.get(cacheKey);
    if (hit) return new Response(hit.body, { headers: { ...binHeaders, 'x-cache': 'r2' } });
  }
  try {
    const body = await build(key, ra, dec, half);
    if (!body) return new Response(null, { status: 204, headers: { 'cache-control': 'public, max-age=86400' } }); // nothing here
    if (env.CACHE) waitUntil(env.CACHE.put(cacheKey, body));
    return new Response(body, { headers: { ...binHeaders, 'x-cache': 'miss' } });
  } catch (e) {
    return json({ error: String(e.message || e) }, e.status || 502);
  }
}
