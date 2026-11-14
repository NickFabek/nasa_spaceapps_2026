// Minimal FITS + TAN-SIP helpers for reading SPHEREx Level-2 spectral images
// with HTTP range requests (no full-file download).

export const BLOCK = 2880;

/** Parse one FITS header starting at `off` in `bytes`. Returns null if END is not inside the buffer. */
export function parseHeader(bytes, off = 0) {
  const cards = {};
  const dec = new TextDecoder('latin1');
  for (let pos = off; pos + BLOCK <= bytes.length; pos += BLOCK) {
    const block = dec.decode(bytes.subarray(pos, pos + BLOCK));
    for (let i = 0; i < 36; i++) {
      const c = block.slice(i * 80, i * 80 + 80);
      let key = c.slice(0, 8).trim();
      if (key === 'END') return { cards, len: pos + BLOCK - off };
      let raw;
      if (key === 'HIERARCH') {
        const eq = c.indexOf('=');
        if (eq < 0) continue;
        key = c.slice(9, eq).trim();
        raw = c.slice(eq + 1);
      } else if (c[8] === '=') {
        raw = c.slice(10);
      } else continue;
      cards[key] = parseValue(raw);
    }
  }
  return null;
}

function parseValue(raw) {
  const s = raw.trim();
  if (s[0] === "'") {
    const end = s.indexOf("'", 1);
    return s.slice(1, end < 0 ? undefined : end).trim();
  }
  const v = s.split('/')[0].trim();
  if (v === 'T') return true;
  if (v === 'F') return false;
  const n = Number(v);
  return Number.isNaN(n) ? v : n;
}

/** Size in bytes of the data unit described by a header, padded to a FITS block. */
export function dataBytes(h) {
  const naxis = h.NAXIS || 0;
  if (!naxis) return 0;
  let n = 1;
  for (let i = 1; i <= naxis; i++) n *= h['NAXIS' + i];
  const size = (Math.abs(h.BITPIX) / 8) * (h.GCOUNT || 1) * ((h.PCOUNT || 0) + n);
  return Math.ceil(size / BLOCK) * BLOCK;
}

const D2R = Math.PI / 180;

function sipPoly(h, prefix) {
  const order = h[prefix + '_ORDER'];
  const terms = [];
  if (!order) return terms;
  for (let i = 0; i <= order; i++)
    for (let j = 0; i + j <= order; j++) {
      const c = h[`${prefix}_${i}_${j}`];
      if (c) terms.push([i, j, c]);
    }
  return terms;
}
const evalPoly = (terms, u, v) => {
  let s = 0;
  for (const [i, j, c] of terms) s += c * u ** i * v ** j;
  return s;
};

/** Build sky<->pixel transforms (1-based FITS pixel coordinates) from a TAN-SIP header. */
export function makeWcs(h) {
  const cd1 = h.CDELT1 ?? 1, cd2 = h.CDELT2 ?? 1;
  const m = h.CD1_1 !== undefined
    ? [h.CD1_1, h.CD1_2 || 0, h.CD2_1 || 0, h.CD2_2]
    : [(h.PC1_1 ?? 1) * cd1, (h.PC1_2 ?? 0) * cd1, (h.PC2_1 ?? 0) * cd2, (h.PC2_2 ?? 1) * cd2];
  const det = m[0] * m[3] - m[1] * m[2];
  const inv = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
  const A = sipPoly(h, 'A'), B = sipPoly(h, 'B'), AP = sipPoly(h, 'AP'), BP = sipPoly(h, 'BP');
  const ra0 = h.CRVAL1 * D2R, dec0 = h.CRVAL2 * D2R;
  const s0 = Math.sin(dec0), c0 = Math.cos(dec0);

  function pix2sky(x, y) {
    const u = x - h.CRPIX1, v = y - h.CRPIX2;
    const f = u + evalPoly(A, u, v), g = v + evalPoly(B, u, v);
    const xi = (m[0] * f + m[1] * g) * D2R, eta = (m[2] * f + m[3] * g) * D2R;
    const ra = ra0 + Math.atan2(xi, c0 - eta * s0);
    const dec = Math.atan2(s0 + eta * c0, Math.hypot(xi, c0 - eta * s0));
    return [((ra / D2R) % 360 + 360) % 360, dec / D2R];
  }

  function sky2pix(raDeg, decDeg) {
    const ra = raDeg * D2R, dec = decDeg * D2R;
    const sd = Math.sin(dec), cd = Math.cos(dec), ca = Math.cos(ra - ra0), sa = Math.sin(ra - ra0);
    const cosc = s0 * sd + c0 * cd * ca;
    if (cosc <= 0) return null;
    const xi = (cd * sa / cosc) / D2R, eta = ((c0 * sd - s0 * cd * ca) / cosc) / D2R;
    const U = inv[0] * xi + inv[1] * eta, V = inv[2] * xi + inv[3] * eta;
    // Start from the inverse SIP polynomial, then polish against the forward one.
    let u = U + evalPoly(AP, U, V), v = V + evalPoly(BP, U, V);
    for (let k = 0; k < 6; k++) {
      const nu = U - evalPoly(A, u, v), nv = V - evalPoly(B, u, v);
      u = nu; v = nv;
    }
    return [u + h.CRPIX1, v + h.CRPIX2];
  }
  return { pix2sky, sky2pix };
}

/** Parse the WCS-WAVE binary table (X, Y control points and a (2,nx,ny) VALUES grid). */
export function parseWaveTable(h, data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const cols = {};
  let off = 0;
  for (let i = 1; i <= h.TFIELDS; i++) {
    const m = /^(\d*)([JEDIK])/.exec(h['TFORM' + i]);
    const n = +(m[1] || 1), t = m[2];
    const size = { J: 4, E: 4, D: 8, I: 2, K: 8 }[t];
    const arr = new Array(n);
    for (let k = 0; k < n; k++) {
      const o = off + k * size;
      arr[k] = t === 'J' ? dv.getInt32(o) : t === 'E' ? dv.getFloat32(o) : t === 'D' ? dv.getFloat64(o)
        : t === 'I' ? dv.getInt16(o) : Number(dv.getBigInt64(o));
    }
    cols[h['TTYPE' + i]] = arr;
    off += n * size;
  }
  return { X: cols.X, Y: cols.Y, V: cols.VALUES };
}

/** Bilinear lookup of [wavelength, bandwidth] in microns at lookup-table coordinates (wx, wy). */
export function waveAt(tab, wx, wy) {
  const { X, Y, V } = tab, nx = X.length, ny = Y.length;
  const locate = (arr, v) => {
    let i = 0;
    while (i < arr.length - 2 && v > arr[i + 1]) i++;
    const t = (v - arr[i]) / (arr[i + 1] - arr[i]);
    return [i, Math.min(1, Math.max(0, t))];
  };
  const [ix, tx] = locate(X, wx), [iy, ty] = locate(Y, wy);
  const get = (k, i, j) => V[k + 2 * (i + nx * j)];
  const out = [0, 0];
  for (let k = 0; k < 2; k++) {
    out[k] = (1 - tx) * (1 - ty) * get(k, ix, iy) + tx * (1 - ty) * get(k, ix + 1, iy)
      + (1 - tx) * ty * get(k, ix, iy + 1) + tx * ty * get(k, ix + 1, iy + 1);
  }
  return out;
}

/** Decompress one RICE_1 tile of 32-bit integers (port of the CFITSIO algorithm). */
export function riceDecode32(c, nx, nblock = 32, upto = nx) {
  const out = new Int32Array(nx);
  nx = Math.min(nx, upto); // decoding is sequential, so stop once the needed columns are done
  const fsbits = 5, fsmax = 25, bbits = 32;
  let p = 0;
  let last = ((c[0] << 24) | (c[1] << 16) | (c[2] << 8) | c[3]) | 0;
  p = 4;
  let b = c[p++], nbits = 8;
  for (let i = 0; i < nx;) {
    nbits -= fsbits;
    while (nbits < 0) { b = ((b << 8) | c[p++]) >>> 0; nbits += 8; }
    const fs = (b >>> nbits) - 1;
    b &= (1 << nbits) - 1;
    const imax = Math.min(i + nblock, nx);
    if (fs < 0) {
      for (; i < imax; i++) out[i] = last;
    } else if (fs === fsmax) {
      for (; i < imax; i++) {
        let k = bbits - nbits;
        let diff = k < 32 ? (b << k) : 0;
        for (k -= 8; k >= 0; k -= 8) { b = c[p++]; diff |= b << k; }
        if (nbits > 0) { b = c[p++]; diff |= b >>> -k; b &= (1 << nbits) - 1; } else b = 0;
        diff = (diff & 1) === 0 ? diff >>> 1 : ~(diff >>> 1);
        last = (diff + last) | 0;
        out[i] = last;
      }
    } else {
      for (; i < imax; i++) {
        while (b === 0) { nbits += 8; b = c[p++]; }
        const nzero = nbits - (32 - Math.clz32(b));
        nbits -= nzero + 1;
        b ^= 1 << nbits;
        nbits -= fs;
        while (nbits < 0) { b = ((b << 8) | c[p++]) >>> 0; nbits += 8; }
        let diff = ((nzero << fs) | (b >>> nbits)) >>> 0;
        b &= (1 << nbits) - 1;
        diff = (diff & 1) === 0 ? diff >>> 1 : ~(diff >>> 1);
        last = (diff + last) | 0;
        out[i] = last;
      }
    }
  }
  return out;
}

/** Sky -> pixel (1-based) for an unrotated SIN-projection image such as an AllWISE atlas tile. */
export function makeSinWcs(h) {
  const ra0 = h.CRVAL1 * D2R, dec0 = h.CRVAL2 * D2R, s0 = Math.sin(dec0), c0 = Math.cos(dec0);
  return (raDeg, decDeg) => {
    const ra = raDeg * D2R, dec = decDeg * D2R, da = ra - ra0;
    const xi = Math.cos(dec) * Math.sin(da);
    const eta = Math.sin(dec) * c0 - Math.cos(dec) * s0 * Math.cos(da);
    return [h.CRPIX1 + xi / D2R / h.CDELT1, h.CRPIX2 + eta / D2R / h.CDELT2];
  };
}
