// Spending limits for the API. Change the numbers here.
//
// What costs money: fetching and decoding an image tile that is not yet in the R2 cache
// (a "build": CPU time, one R2 write, stored bytes), and questions sent on to NASA, ESA and CDS.
// Tiles already in the cache are served without limit.
//
// These limits cannot stop the host from counting (and billing) a request that is refused here.
// Refused requests do no work, so they cost only the per-request fee.
export const LIMITS = {
  windowMin: 10,        // length of the per-visitor window, minutes
  visitorBuilds: 2000,  // new tiles one visitor may have built per window (a new field is about 400)
  visitorLookups: 90,   // archive searches, star lists and name lookups per visitor per window
  dailyBuilds: 30000,   // new tiles per UTC day, all visitors together (about 75 new fields)
  dailyStoreMB: 400,    // new tile data written to R2 per UTC day; past this, tiles are served but not kept
  totalStoreGB: 6,      // new tile data written to R2 in total since the counter began; same behaviour past it
};

const STATE_KEY = 'limit/v1/state.json';
const SAMPLE = 16;        // the shared counter is updated for one build in 16, by 16
const REFRESH_MS = 30000; // how long one server instance trusts its copy of the shared counter

const visitors = new Map(); // per server instance, so the per-visitor limit is approximate
let state = null, stateAt = 0, loading = null;

const today = () => new Date().toISOString().slice(0, 10);
const current = (s) => (s && s.day === today() ? s : { day: today(), builds: 0, bytes: 0, total: s?.total || 0 });

function refuse(limit, error, retryAfter) {
  return new Response(JSON.stringify({ error, limit, retryAfter }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': String(retryAfter) },
  });
}

// Seconds this visitor must wait, or 0 after counting the request.
function visitorWait(request, kind, max) {
  const ip = request.headers?.get?.('cf-connecting-ip');
  if (!ip) return 0; // not behind Cloudflare (tools/hunt.mjs run offline): nothing to protect
  const now = Date.now(), win = LIMITS.windowMin * 60000, k = kind + ip;
  let v = visitors.get(k);
  if (!v || now - v.t0 >= win) {
    if (visitors.size > 20000) for (const [key, old] of visitors) if (now - old.t0 >= win) visitors.delete(key);
    v = { t0: now, n: 0 };
    visitors.set(k, v);
  }
  if (v.n >= max) return Math.max(1, Math.ceil((v.t0 + win - now) / 1000));
  v.n++;
  return 0;
}

async function readState(env) {
  if (!env?.CACHE) return current(null);
  if (state && Date.now() - stateAt < REFRESH_MS) return (state = current(state));
  loading ||= (async () => {
    try {
      const obj = await env.CACHE.get(STATE_KEY);
      state = current(obj ? await obj.json() : state);
    } catch (e) { state = current(state); } // counter unreadable: carry on with the last copy
    stateAt = Date.now();
    loading = null;
    return state;
  })();
  return loading;
}

// Add to the shared counter. Uses the object's etag so that two writers do not overwrite each other.
async function add(env, builds, bytes) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const obj = await env.CACHE.get(STATE_KEY);
    const s = current(obj ? await obj.json() : null);
    s.builds += builds; s.bytes += bytes; s.total += bytes;
    const done = await env.CACHE.put(STATE_KEY, JSON.stringify(s), obj ? { onlyIf: { etagMatches: obj.etag } } : undefined);
    if (done) { state = s; stateAt = Date.now(); return; }
  }
}

const untilMidnight = () => Math.ceil((Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1) - Date.now()) / 1000);

/** For a request that would ask an outside archive a question. Returns a 429 response, or null to go ahead. */
export function lookupGate(request) {
  const wait = visitorWait(request, 'l', LIMITS.visitorLookups);
  return wait ? refuse('visitor', `Too many lookups in a short time. Try again in ${Math.ceil(wait / 60)} minutes.`, wait) : null;
}

/** For a tile that is not in the cache. Returns { refused: Response } or { canStore(bytes) }. */
export async function buildGate(request, env) {
  const s = await readState(env);
  if (s.builds >= LIMITS.dailyBuilds) {
    return { refused: refuse('daily', 'This site has reached today\'s limit for fetching new images from NASA\'s archive. '
      + 'It resets at midnight UTC. Places that have been opened before still load.', untilMidnight()) };
  }
  const wait = visitorWait(request, 'b', LIMITS.visitorBuilds);
  if (wait) {
    return { refused: refuse('visitor', `You have opened several new places in a short time. New images can load again in ${Math.ceil(wait / 60)} minutes. `
      + 'Places that have been opened before still load.', wait) };
  }
  return { canStore: (bytes) => s.bytes + bytes <= LIMITS.dailyStoreMB * 1e6 && s.total + bytes <= LIMITS.totalStoreGB * 1e9 };
}

/** Count one finished build, and the bytes written to R2 for it (0 if it was not kept). */
export function recordBuild(env, waitUntil, storedBytes = 0) {
  if (!env?.CACHE) return;
  if (state) { state.builds++; state.bytes += storedBytes; state.total += storedBytes; }
  if (Math.random() < 1 / SAMPLE) waitUntil(add(env, SAMPLE, storedBytes * SAMPLE).catch(() => {}));
}
