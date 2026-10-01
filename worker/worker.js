/**
 * alberta-plow-relay — Cloudflare Worker
 *
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
      return new Response('alberta-plow-relay: GET /plows (511 Alberta snowplows, Central Alberta). Data: 511 Alberta.\n',
        { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...cors } });
    }
    if (url.pathname !== '/plows') return json({ error: 'not found' }, 404, cors);

    const cache = caches.default;
    const hit = await cache.match(RESP_KEY).catch(() => null);
    if (hit) return withHeaders(hit, { ...cors, 'X-Relay-Cache': 'HIT' });

    let body;
    try {
      body = await buildPlows(cache, ctx);
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

async function buildPlows(cache, ctx) {
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
    roads: !!(gh && gh.roads), roads_generated: (gh && gh.roads_generated) || null
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
