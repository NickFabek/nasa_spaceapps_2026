// Single place to update when IRSA publishes a new SPHEREx release.
// Collections are searched in order; when the same exposure appears in more
// than one, the first listed wins (put full data releases before quick releases).
export const COLLECTIONS = ['spherex_dr1', 'spherex_qr3'];

export const SIA_URL = 'https://irsa.ipac.caltech.edu/SIA';
export const IBE_PREFIX = 'https://irsa.ipac.caltech.edu/ibe/data/spherex/';
// Public AWS Open Data mirror of the same files; supports HTTP range requests.
export const S3_URL = 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/';

export const json = (obj, status = 200, maxAge = 0) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
    },
  });

/** GET an IRSA URL as text, retrying while the archive answers 5xx (it does so in bursts). */
export async function irsaText(url, tries = 6) {
  let status = 0;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.text();
      status = r.status;
      if (status < 500) break;
    } catch (e) { status = 0; }
    await new Promise((res) => setTimeout(res, 350 + 450 * attempt));
  }
  throw new Error(`IRSA archive is not answering (HTTP ${status || 'network'})`);
}
