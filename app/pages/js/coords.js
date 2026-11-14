// Coordinate parsing and formatting.

/** Parse "269.45 4.69", "17h57m48.5s +04d44m36s", "17 57 48.5 +04 44 36" -> {ra, dec} in degrees, or null. */
export function parseCoords(text) {
  const s = text.trim().replace(/,/g, ' ');
  let m = /^([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)$/.exec(s);
  if (m) return check(+m[1], +m[2]);
  const sex = /^(\d{1,2})[h:\s]\s*(\d{1,2})[m:\s]\s*(\d{1,2}(?:\.\d+)?)s?\s*([+-]?)(\d{1,2})[d°:\s]\s*(\d{1,2})[m':\s]\s*(\d{1,2}(?:\.\d+)?)[s"]?$/i.exec(s);
  if (sex) {
    const ra = 15 * (+sex[1] + +sex[2] / 60 + +sex[3] / 3600);
    const dec = (sex[4] === '-' ? -1 : 1) * (+sex[5] + +sex[6] / 60 + +sex[7] / 3600);
    return check(ra, dec);
  }
  return null;
}
const check = (ra, dec) => (ra >= 0 && ra < 360 && dec >= -90 && dec <= 90 ? { ra, dec } : null);

const pad = (n, w, d) => n.toFixed(d).padStart(w + (d ? d + 1 : 0), '0');
export function fmtRa(ra) {
  const h = ra / 15, hh = Math.floor(h), mm = Math.floor((h - hh) * 60), ss = ((h - hh) * 60 - mm) * 60;
  return `${pad(hh, 2, 0)}h${pad(mm, 2, 0)}m${pad(Math.min(ss, 59.99), 2, 2)}s`;
}
export function fmtDec(dec) {
  const a = Math.abs(dec), dd = Math.floor(a), mm = Math.floor((a - dd) * 60), ss = ((a - dd) * 60 - mm) * 60;
  return `${dec < 0 ? '−' : '+'}${pad(dd, 2, 0)}°${pad(mm, 2, 0)}′${pad(Math.min(ss, 59.9), 2, 1)}″`;
}
export const mjdToDate = (mjd) => new Date((mjd - 40587) * 864e5);
export const fmtDate = (mjd) => mjdToDate(mjd).toISOString().slice(0, 10);
export const fmtMonth = (mjd) => mjdToDate(mjd).toLocaleString('en', { month: 'short', year: 'numeric', timeZone: 'UTC' });
