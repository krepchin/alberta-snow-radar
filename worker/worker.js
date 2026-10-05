/**
 * alberta-plow-relay — Cloudflare Worker
 *
 * GET /roads  → 511 Alberta winter road conditions (developer API v3, key in the Worker secret
 *               ALBERTA_511_API_KEY), decoded + clipped to Central Alberta, same GeoJSON shape as the
 *               site's data/roads.geojson. Cached ~3 min.
 * GET /plows  → live 511 Alberta snowplow positions for Central Alberta, same JSON shape as the
 *               site's data/plows.json, so https://krepchin.github.io/alberta-snow-radar/ can show
 *               current positions the moment it opens (511 sends no CORS headers, so the page
 *               cannot call 511 itself).
 *
 * Politeness / limits
 *  - Whole response cached 30 s (Cache API, per Cloudflare data centre) → at most ~2 feed requests
 *    per minute per data centre, however many people have the page open.
 *  - Owner / "Updated" come from the per-vehicle tooltip. Tooltips are cached ~30 min (one Cache API
 *    entry holding all of them + an in-memory copy). Uncached vehicles are first filled from the
 *    GitHub-built data/plows.json (1 subrequest); at most MAX_TIPS tooltips are fetched per request.
 *  - Subrequest budget per request (free tier 50): feed 1 + GitHub 1 + cache 4 + tooltips ≤ 20 = ≤ 26.
 *  - Descriptive User-Agent, same as the GitHub Actions fetcher.
 */
const FEED = 'https://511.alberta.ca/map/mapIcons/ServiceVehicles';
const TIP = id => `https://511.alberta.ca/tooltip/ServiceVehicles/${encodeURIComponent(id)}?lang=en`;
const GH_DATA = 'https://krepchin.github.io/alberta-snow-radar/data/plows.json';
const UA = 'AlbertaSnowRadar/5.3 (+https://krepchin.github.io/alberta-snow-radar/; ' +
  'personal non-commercial map; fetches every ~5 min via GitHub Actions)';
const BOX = { lat0: 51.0, lat1: 52.8, lon0: -114.5, lon1: -111.5 };
const RESP_TTL = 30;              // s, whole /plows response
const TIP_TTL = 30 * 60;          // s, per-vehicle tooltip
const MAX_TIPS = 20;              // tooltip subrequests per request
const TIP_CONCURRENCY = 4;
const FEED_TIMEOUT = 8000, TIP_TIMEOUT = 4000, GH_TIMEOUT = 4000;
const RESP_KEY = 'https://alberta-plow-relay.cache/plows/v1';
const TIPS_KEY = 'https://alberta-plow-relay.cache/tips/v1';
// Winter road conditions (developer API; key only ever read from env, never echoed)
const ROADS_API = 'https://511.alberta.ca/api/v3/get/winterroads?format=json&lang=en&key=';
const RBOX = { lat0: 50.7, lat1: 53.1, lon0: -115.0, lon1: -111.0 };   // = RLAT0/1, RLON0/1 in scripts/fetch_511.py
const ROADS_TTL = 180;            // s
const ROADS_TIMEOUT = 15000;
const ROADS_KEY = 'https://alberta-plow-relay.cache/roads/v1';
const SIMPLIFY_DEG = 0.0002;      // Douglas-Peucker tolerance, ~15-22 m (same as scripts/fetch_511.py)
const ALLOWED_ORIGINS = [/^https:\/\/krepchin\.github\.io$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];

let memTips = null;               // { id: { owner, type, updated, updated_text, t } } — per isolate

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Max-Age': '86400' } });
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method not allowed' }, 405, cors);
    if (url.pathname === '/' || url.pathname === '') {
      return new Response('alberta-plow-relay: GET /plows (511 Alberta snowplows, Central Alberta) · ' +
        'GET /roads (511 Alberta winter road conditions, Central Alberta, GeoJSON). Data: 511 Alberta.\n',
        { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...cors } });
    }
    if (url.pathname === '/roads') return handleRoads(env, ctx, cors);
    if (url.pathname !== '/plows') return json({ error: 'not found' }, 404, cors);

    const cache = caches.default;
    const hit = await cache.match(RESP_KEY).catch(() => null);
    if (hit) return withHeaders(hit, { ...cors, 'X-Relay-Cache': 'HIT' });

    let body;
    try {
      body = await buildPlows(cache, ctx, env);
    } catch (e) {
      return json({ generated: null, source: '511 Alberta', relay: 'live', error: '511 feed unavailable: ' + String(e && e.message || e).slice(0, 200), vehicles: [] }, 502,
        { ...cors, 'Cache-Control': 'no-store' });
    }
    const res = json(body, 200, { 'Cache-Control': `public, max-age=${RESP_TTL}` });
    ctx.waitUntil(cache.put(RESP_KEY, res.clone()).catch(() => {}));
    return withHeaders(res, { ...cors, 'X-Relay-Cache': 'MISS' });
  }
};

function corsHeaders(origin) {
  const h = { 'Vary': 'Origin' };
  if (origin && ALLOWED_ORIGINS.some(re => re.test(origin))) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, HEAD, OPTIONS';
    h['Access-Control-Expose-Headers'] = 'X-Relay-Cache';
  }
  return h;
}
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}
function withHeaders(res, extra) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(extra)) r.headers.set(k, v);
  return r;
}
function nowIso() { return new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z'); }

/** fetch → decoded text; handles gzip bodies even when Content-Encoding is missing/odd. */
async function getText(url, ms, accept) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': accept || 'application/json', 'Accept-Encoding': 'gzip' },
    signal: AbortSignal.timeout(ms), cf: { cacheTtl: 0 }
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  let buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    const ds = new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')));
    buf = new Uint8Array(await ds.arrayBuffer());
  }
  return new TextDecoder('utf-8').decode(buf);
}

async function buildPlows(cache, ctx, env) {
  const fetched = nowIso();
  // feed + GitHub data in parallel (GitHub is optional)
  const [feedTxt, gh] = await Promise.all([
    getText(FEED, FEED_TIMEOUT),
    getText(GH_DATA + '?t=' + Date.now(), GH_TIMEOUT).then(t => JSON.parse(t)).catch(() => null)
  ]);
  let data;
  try { data = JSON.parse(feedTxt); } catch (e) { throw new Error('feed is not JSON'); }
  const items = data && Array.isArray(data.item2) ? data.item2 : null;
  if (!items) throw new Error('unexpected feed shape');

  const icons = {};
  const vehicles = [];
  for (const it of items) {
    const loc = it && it.location;
    const lat = loc && Number(loc[0]), lon = loc && Number(loc[1]);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    if (lat < BOX.lat0 || lat > BOX.lat1 || lon < BOX.lon0 || lon > BOX.lon1) continue;
    let icon = {};
    try { icon = JSON.parse((it.icon && it.icon.json) || '{}'); } catch (e) { /* keep {} */ }
    const name = icon.name || '';
    icons[name] = (icons[name] || 0) + 1;
    const rot = icon.rotation;
    const heading = typeof rot === 'number' && rot >= 0 && rot <= 360 ? Math.round((rot % 360) * 10) / 10 : null; // -1 = unknown
    vehicles.push({ id: String(it.itemId), lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, heading, icon: name, type: 'Snowplow / Maintenance Vehicle' });
  }
  vehicles.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  // tooltip cache: memory first, then one Cache API entry
  const now = Date.now();
  let tips = memTips;
  if (!tips) {
    const c = await cache.match(TIPS_KEY).catch(() => null);
    tips = c ? await c.json().catch(() => ({})) : {};
  }
  const fresh = id => tips[id] && now - tips[id].t < TIP_TTL * 1000;
  const ghById = {};
  if (gh && Array.isArray(gh.vehicles)) gh.vehicles.forEach(v => { ghById[String(v.id)] = v; });

  const need = vehicles.filter(v => !fresh(v.id)).slice(0, MAX_TIPS);
  let fetchedTips = 0;
  for (let i = 0; i < need.length; i += TIP_CONCURRENCY) {
    await Promise.all(need.slice(i, i + TIP_CONCURRENCY).map(async v => {
      try {
        const t = parseTooltip(await getText(TIP(v.id), TIP_TIMEOUT, 'text/html'));
        if (t.owner || t.updated) { tips[v.id] = { ...t, t: now }; fetchedTips++; }
      } catch (e) { /* fall back to GitHub data below */ }
    }));
  }
  // prune and persist
  for (const id of Object.keys(tips)) if (now - tips[id].t > TIP_TTL * 1000 * 2) delete tips[id];
  memTips = tips;
  if (fetchedTips) {
    ctx.waitUntil(cache.put(TIPS_KEY, new Response(JSON.stringify(tips), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${TIP_TTL}` }
    })).catch(() => {}));
  }

  let withTip = 0;
  for (const v of vehicles) {
    const t = tips[v.id], g = ghById[v.id];
    if (t && t.type) v.type = t.type;
    const owner = (t && t.owner) || (g && g.owner);
    if (owner) v.owner = owner;
    // "updated": newest of the cached tooltip and the GitHub (≤ ~5-10 min old) value
    const cands = [t, g].filter(x => x && x.updated);
    if (cands.length) {
      const best = cands.reduce((a, b) => Date.parse(b.updated) > Date.parse(a.updated) ? b : a);
      v.updated = best.updated;
      if (best.updated_text) v.updated_text = best.updated_text;
    }
    if (v.owner || v.updated) withTip++;
  }

  return {
    generated: nowIso(), fetched, source: '511 Alberta', relay: 'live',
    bbox: [BOX.lat0, BOX.lon0, BOX.lat1, BOX.lon1],
    total_alberta: items.length, total: vehicles.length, tooltips: withTip, tooltips_fetched: fetchedTips,
    icons, vehicles,
    ...(await roadsMeta(cache, env, gh))
  };
}

function strip(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
function parseTooltip(html) {
  const out = {};
  const h4 = /<h4>([\s\S]*?)<\/h4>/.exec(html);
  if (h4) { const t = strip(h4[1]); if (t) out.type = t; }
  const re = /<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = re.exec(html))) {
    const k = strip(m[1]).toLowerCase(), v = strip(m[2]);
    if (k === 'owner') out.owner = v;
    else if (k === 'updated') { out.updated_text = v; const iso = mountainToIso(v); if (iso) out.updated = iso; }
  }
  return out;
}
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/** "Oct 1 2026, 10:57 AM" (America/Edmonton wall time) → UTC ISO string. */
function mountainToIso(s) {
  const m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4}),? (\d{1,2}):(\d{2})\s*([AP]M)?$/i.exec(s.trim());
  if (!m || !(m[1].toLowerCase() in MONTHS)) return null;
  let hh = Number(m[4]) % 12;
  if (m[6] && m[6].toUpperCase() === 'PM') hh += 12;
  if (!m[6]) hh = Number(m[4]);
  const wall = Date.UTC(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2]), hh, Number(m[5]));
  // try MDT (-6) then MST (-7); keep the one that formats back to the same wall time in Edmonton
  for (const off of [6, 7]) {
    const t = wall + off * 3600000;
    if (edmontonWall(t) === wall) return new Date(t).toISOString().replace('.000Z', 'Z');
  }
  return new Date(wall + 7 * 3600000).toISOString().replace('.000Z', 'Z');
}
function edmontonWall(t) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/Edmonton', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    .formatToParts(new Date(t)).forEach(x => { p[x.type] = x.value; });
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
}

/* ---------- /roads ---------- */
/** roads flag for /plows: true whenever the relay can serve /roads (key present) or GitHub has a file. */
async function roadsMeta(cache, env, gh) {
  const ghMeta = { roads: !!(gh && gh.roads), roads_generated: (gh && gh.roads_generated) || null };
  if (!env || !env.ALBERTA_511_API_KEY) return ghMeta;
  const hit = await cache.match(ROADS_KEY).catch(() => null);
  const gen = hit && hit.headers.get('X-Roads-Generated');
  return { roads: true, roads_generated: gen || ghMeta.roads_generated, roads_relay: true };
}

async function handleRoads(env, ctx, cors) {
  const cache = caches.default;
  const hit = await cache.match(ROADS_KEY).catch(() => null);
  if (hit) return withHeaders(hit, { ...cors, 'X-Relay-Cache': 'HIT' });
  const key = env && env.ALBERTA_511_API_KEY;
  const fail = (msg) => json({ type: 'FeatureCollection', generated: null, source: '511 Alberta', error: msg, features: [] }, 502,
    { ...cors, 'Cache-Control': 'no-store' });
  if (!key) return fail('road conditions not configured (missing API key)');
  let rows;
  try {
    const txt = await getText(ROADS_API + encodeURIComponent(key), ROADS_TIMEOUT);
    rows = JSON.parse(txt);
    if (!Array.isArray(rows)) throw new Error('unexpected response shape');
  } catch (e) {
    // never echo the request URL (it carries the key)
    const msg = String(e && e.message || e).split(key).join('***').replace(/https?:\/\/\S+/g, '[url]').slice(0, 160);
    return fail('511 road conditions unavailable: ' + msg);
  }
  const body = buildRoads(rows);
  const res = json(body, 200, { 'Cache-Control': `public, max-age=${ROADS_TTL}`, 'X-Roads-Generated': body.generated });
  ctx.waitUntil(cache.put(ROADS_KEY, res.clone()).catch(() => {}));
  return withHeaders(res, { ...cors, 'X-Relay-Cache': 'MISS', 'Access-Control-Expose-Headers': 'X-Relay-Cache, X-Roads-Generated' });
}

/** Same output as scripts/fetch_511.py roads(): MultiLineString per segment, kept if any vertex is in RBOX. */
function buildRoads(rows) {
  const feats = [], conds = {};
  const LAT0 = Math.round(RBOX.lat0 * 1e5), LAT1 = Math.round(RBOX.lat1 * 1e5), LON0 = Math.round(RBOX.lon0 * 1e5), LON1 = Math.round(RBOX.lon1 * 1e5), M = 100000;
  for (const r of rows) {
    let polys = r.EncodedPolyline || [];
    if (typeof polys === 'string') polys = [polys];
    const lines = [];
    for (const p of polys) {
      if (!p || typeof p !== 'string') continue;
      const f0 = decodeFlat(p, 1);   // cheap pre-filter: first vertex more than ~1° (≈110 km) outside the box → skip
      if (f0.length < 2 || f0[1] < LAT0 - M || f0[1] > LAT1 + M || f0[0] < LON0 - M || f0[0] > LON1 + M) continue;
      const f = decodeFlat(p);
      if (f.length < 4) continue;
      let inside = false;
      for (let k = 0; k < f.length; k += 2) {
        const x = f[k], y = f[k + 1];
        if (y >= LAT0 && y <= LAT1 && x >= LON0 && x <= LON1) { inside = true; break; }
      }
      if (inside) lines.push(simplifyFlat(f, SIMPLIFY_DEG));
    }
    if (!lines.length) continue;
    const cond = r['Primary Condition'] || r.PrimaryCondition || 'Unknown';
    conds[cond] = (conds[cond] || 0) + 1;
    let sec = r['Secondary Conditions'] || r.SecondaryConditions || [];
    if (typeof sec === 'string') sec = [sec];
    const lu = Number(r.LastUpdated);
    feats.push({
      type: 'Feature',
      geometry: { type: 'MultiLineString', coordinates: lines },
      properties: {
        id: r.Id, road: r.RoadwayName, location: r.LocationDescription, area: r.AreaName, condition: cond,
        secondary: sec, visibility: r.Visibility,
        updated: isFinite(lu) && lu > 0 ? new Date(lu * 1000).toISOString().replace('.000Z', 'Z') : null
      }
    });
  }
  return { type: 'FeatureCollection', generated: nowIso(), source: '511 Alberta', relay: 'live', total_alberta: rows.length, conditions: conds, features: feats };
}
/** Douglas-Peucker line simplification on a flat integer array [lng,lat,lng,lat,...] (1e-5 degree units);
 *  same algorithm/tolerance as simplify() in fetch_511.py. Returns [[lon, lat], ...] for kept vertices. */
function simplifyFlat(f, tol) {
  const n = f.length >> 1;
  const out = [];
  if (n === 0) return out;
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const t = tol * 1e5, t2 = t * t;
  const stack = n > 2 && tol ? [0, n - 1] : [];
  if (!tol) keep.fill(1);
  while (stack.length) {
    const b = stack.pop(), a = stack.pop();
    const ax = f[2 * a], ay = f[2 * a + 1], dx = f[2 * b] - ax, dy = f[2 * b + 1] - ay, L = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let k = a + 1; k < b; k++) {
      const px = f[2 * k] - ax, py = f[2 * k + 1] - ay;
      let d;
      if (L === 0) d = px * px + py * py;
      else { const c = dx * py - dy * px; d = c * c / L; }
      if (d > maxD) { maxD = d; idx = k; }
    }
    if (maxD > t2) { keep[idx] = 1; stack.push(a, idx, idx, b); }
  }
  for (let k = 0; k < n; k++) if (keep[k]) out.push([f[2 * k] / 1e5, f[2 * k + 1] / 1e5]);
  return out;
}
/** Google encoded polyline (precision 5) → flat [lng,lat,...] integers (1e-5 deg); same decoding as decode_polyline() in fetch_511.py. */
function decodeFlat(s, maxPts = Infinity) {
  const f = [];
  let i = 0, lat = 0, lng = 0;
  const n = s.length;
  while (i < n && (f.length >> 1) < maxPts) {
    let shift = 0, result = 0, b;
    do { if (i >= n) return f; b = s.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    const dLat = result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { if (i >= n) return f; b = s.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += dLat; lng += result & 1 ? ~(result >> 1) : result >> 1;
    f.push(lng, lat);
  }
  return f;
}
