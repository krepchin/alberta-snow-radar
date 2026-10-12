/**
 * alberta-snow-events: snow-event recorder (Cloudflare Worker + D1 + Cron every 5 min).
 *
 * Separate from the map. It only READS public data:
 *   - Open-Meteo current + hourly model weather for Three Hills, Drumheller, Stettler (CMA 517) and Castor, Consort, Czar (CMA 518)
 *   - alberta-plow-relay /roads and /plows (511 Alberta), via a read-only service binding
 *     (falls back to the public workers.dev URL)
 * Nothing is recorded until an event opens (see ARMING). Recording is always on (no switch, no test controls; removed Oct 8 2026).
 * Nothing here is invented: missing inputs are stored as null and never treated as "bare" or "no snow".
 * Trucks: Emcon only (owner matches /emcon|mcon/i), and only within 2 km of a CMA 517 / CMA 518 road segment. Other contractors' trucks are dropped on input and never stored.
 * Roads: CMA 517 and CMA 518 segments only; other areas the relay returns are dropped on input and never stored.
 */
const TOWNS = [
  { id: 'th', name: 'Three Hills', lat: 51.70722, lon: -113.26472, cma: '517' },
  { id: 'dr', name: 'Drumheller', lat: 51.46444, lon: -112.71889, cma: '517' },
  { id: 'st', name: 'Stettler', lat: 52.32389, lon: -112.70444, cma: '517' },
  // CMA 518 weather points (Oct 8 2026; coordinates from Open-Meteo geocoding / GeoNames)
  { id: 'ca', name: 'Castor', lat: 52.21684, lon: -111.88509, cma: '518' },
  { id: 'co', name: 'Consort', lat: 52.01683, lon: -110.76836, cma: '518' },
  { id: 'cz', name: 'Czar', lat: 52.45013, lon: -110.83494, cma: '518' }
];
const CMA517 = ['CMA 517 - Three Hills', 'CMA 517 - Drumheller', 'CMA 517 - Stettler'];
// CMA 518 is recorded in its own fields (cma518 / nbc518 / towns with cma '518') and opens/continues events the same way as CMA 517.
const CMA518 = ['CMA 518 - Castor', 'CMA 518 - Consort', 'CMA 518 - Czar'];
const RELAY_PUBLIC = 'https://alberta-plow-relay.krepchin.workers.dev';
const OM = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
  latitude: TOWNS.map(t => t.lat).join(','), longitude: TOWNS.map(t => t.lon).join(','),
  current: 'temperature_2m,snowfall,precipitation,wind_speed_10m,wind_gusts_10m,visibility,weather_code',
  hourly: 'snowfall', past_hours: '6', forecast_hours: '12', timeformat: 'unixtime', timezone: 'GMT'
});
const UA = 'AlbertaSnowEvents/0.1 (+https://krepchin.github.io/alberta-snow-radar/; personal non-commercial; every 5 min)';
const MIN = 60000;
const MOVE_KM = 0.25;          // moved more than this between checks = moving
const FRESH_MS = 30 * MIN;     // 511 "Updated" older than this = not reporting
const STATIONARY_MS = 30 * MIN;// out truck stationary this long = back
const CLOSE_EMCON_MS = 60 * MIN;
const CLOSE_SNOW_MS = 120 * MIN;
const TEST_MAX_MS = 3 * 60 * MIN;  // legacy: a (pre-existing) TEST event left open is closed after 3 h
const ALLOWED_ORIGINS = [/^https:\/\/krepchin\.github\.io$/, /^https?:\/\/(www\.)?albertaweatherradar\.(ca|com)$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];

const isWinter = c => !!c && !/^(bare|no report|closed)/i.test(String(c).trim());   // see README: Closed is excluded
const group = o => /emcon|mcon/i.test(o || '') ? 'emcon' : 'other';   // only 'emcon' is ever kept

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runCheck(env, { source: 'cron' }).catch(e => console.log('check failed', String(e && e.message || e))));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get('Origin') || '');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Max-Age': '86400' } });
    const p = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (/^\/(auth|admin|cameras|gps)(\/|$)/.test(p)) return await authRoutes(request, env, p, cors);
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, cors);
      if (p === '/') return new Response('alberta-snow-events: GET /events/config · /events/status · /events · /events/{id} · /events/{id}/csv · /roadlog/days · /roadlog/{YYYY-MM-DD} · /roadlog/{YYYY-MM-DD}/csv. Data: Open-Meteo, 511 Alberta.\n',
        { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...cors } });
      if (p === '/events/config') return json({ enabled: true, trucks: 'emcon' }, 200, { ...cors, 'Cache-Control': 'public, max-age=60' });
      if (p === '/events/status') return json(await status(env), 200, cors);
      if (p === '/events') return listEvents(env, cors);
      const dm = /^\/events\/(\d+)(\/csv)?$/.exec(p);
      if (dm) return dm[2] ? eventCsv(env, Number(dm[1]), cors) : eventDetail(env, Number(dm[1]), cors);
      if (p === '/roadlog/days') return roadLogDays(env, cors);
      const rl = /^\/roadlog\/(\d{4}-\d{2}-\d{2})(\/csv)?$/.exec(p);
      if (rl) return rl[2] ? roadLogCsv(env, rl[1], cors) : json(await roadLogDay(env, rl[1]), 200, cors);
      return json({ error: 'not found' }, 404, cors);
    } catch (e) {
      return json({ error: 'server error: ' + String(e && e.message || e).slice(0, 200) }, 500, cors);
    }
  }
};

/* ---------------- helpers ---------------- */
function corsHeaders(origin) {
  const h = { 'Vary': 'Origin' };
  if (origin && ALLOWED_ORIGINS.some(re => re.test(origin))) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
  }
  return h;
}
function json(obj, status, headers) {
  return new Response(typeof obj === 'string' ? obj : JSON.stringify(obj),
    { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
}
function distKm(a, b) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
async function getJson(url, ms) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
async function relayJson(env, path, ms) {
  if (env.RELAY && typeof env.RELAY.fetch === 'function') {
    try {
      const res = await env.RELAY.fetch(new Request('https://alberta-plow-relay.internal' + path, { headers: { 'User-Agent': UA } }));
      if (res.ok) return await res.json();
      throw new Error('relay HTTP ' + res.status);
    } catch (e) { /* fall through to public URL */ }
  }
  return getJson(RELAY_PUBLIC + path, ms);
}
function safeMsg(e) { return String(e && e.message || e).slice(0, 120); }

/* ---------------- inputs ---------------- */
async function getWeather() {
  const arr = await getJson(OM, 8000);
  const list = Array.isArray(arr) ? arr : [arr];
  if (list.length !== TOWNS.length) throw new Error('unexpected Open-Meteo response');
  const out = {};
  TOWNS.forEach((t, i) => {
    const c = list[i].current || {}, h = list[i].hourly || {};
    const hours = (h.time || []).map((tt, k) => [tt * 1000, h.snowfall ? h.snowfall[k] : null]);
    out[t.id] = {
      t: c.time ? c.time * 1000 : null,
      s15: num(c.snowfall), temp: num(c.temperature_2m), wind: num(c.wind_speed_10m), gust: num(c.wind_gusts_10m),
      vis: num(c.visibility), code: num(c.weather_code), precip: num(c.precipitation), hours
    };
  });
  return out;
}
const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
async function getRoads(env) {
  const gj = await relayJson(env, '/roads', 12000);
  if (!gj || !Array.isArray(gj.features) || !gj.generated) throw new Error(gj && gj.error ? gj.error : 'no road data');
  const segs = {}, lines = [];
  for (const f of gj.features) {
    const p = f.properties || {};
    if (p.id == null) continue;
    if (!/^CMA 51[78] - /.test(p.area || '')) continue;   // v5.8.4: Central Alberta only (CMA 517 + CMA 518); other areas in the relay box are never stored
    segs[String(p.id)] = { c: p.condition || null, r: p.road || '', l: p.location || '', a: p.area || '', u: p.updated ? Date.parse(p.updated) : null,
      sec: Array.isArray(p.secondary) ? p.secondary.join('; ') : (p.secondary || ''), vis: p.visibility || '' };
    const g = f.geometry || {};
    if (g.type === 'LineString') lines.push(g.coordinates); else if (g.type === 'MultiLineString') lines.push(...g.coordinates);
  }
  Object.defineProperty(segs, 'lines', { value: lines, enumerable: false });   // CMA 517/518 polylines, used to scope trucks
  return segs;
}
/* v5.8.4: an Emcon truck counts only while it is within COVERAGE_KM of a CMA 517 / CMA 518 road segment
   (Emcon also runs neighbouring CMAs whose trucks can sit inside the relay box). */
const COVERAGE_KM = 2;
function nearCoverage(lat, lon, lines) {
  if (typeof lat !== 'number' || typeof lon !== 'number') return false;
  const kx = 111.32 * Math.cos(lat * Math.PI / 180), ky = 110.57;
  for (const ln of lines) for (let i = 1; i < ln.length; i++) {
    const ax = (ln[i - 1][0] - lon) * kx, ay = (ln[i - 1][1] - lat) * ky, bx = (ln[i][0] - lon) * kx, by = (ln[i][1] - lat) * ky;
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
    if (Math.hypot(ax + t * dx, ay + t * dy) <= COVERAGE_KM) return true;
  }
  return false;
}
async function getPlows(env) {
  const j = await relayJson(env, '/plows', 10000);
  if (!j || !Array.isArray(j.vehicles) || !j.generated) throw new Error(j && j.error ? j.error : 'no plow data');
  return j.vehicles.filter(v => isFinite(v.lat) && isFinite(v.lon) && group(v.owner) === 'emcon').map(v => ({   // Emcon only
    id: String(v.id), owner: v.owner || '', g: group(v.owner), lat: v.lat, lon: v.lon,
    heading: typeof v.heading === 'number' ? v.heading : null, upd: v.updated ? Date.parse(v.updated) : null
  }));
}

/* ---------------- the 5-minute check ---------------- */
async function runCheck(env, opts = {}) {
  const now = Date.now();
  const errors = {};
  const [wx, segs, plowsRaw] = await Promise.all([
    getWeather().catch(e => { errors.weather = safeMsg(e); return null; }),
    getRoads(env).catch(e => { errors.roads = safeMsg(e); return null; }),
    getPlows(env).catch(e => { errors.plows = safeMsg(e); return null; })
  ]);
  // trucks are kept only near CMA 517/518 roads; without road geometry the coverage is unknown, so no trucks are recorded this check
  let plows = plowsRaw;
  if (plows) {
    if (segs && segs.lines && segs.lines.length) plows = plows.filter(v => nearCoverage(v.lat, v.lon, segs.lines));
    else { errors.plows = 'CMA 517/518 road geometry unavailable, trucks not recorded this check'; plows = null; }
  }
  const db = env.DB;
  const st = {};
  (await db.prepare('SELECT k, v, t FROM state').all()).results.forEach(r => { try { st[r.k] = { v: JSON.parse(r.v), t: r.t }; } catch (e) { /* ignore */ } });
  const prevRoads = st.roads ? st.roads.v : null;           // { segId: cond }
  const prevPlows = st.plows ? st.plows.v : null;           // { id: [lat, lon, upd] }
  let emconMovedAt = st.emcon_moved ? st.emcon_moved.v : null;

  // ----- derived signals -----
  const snowNow = wx ? TOWNS.filter(t => (wx[t.id].s15 || 0) > 0).map(t => t.name) : null;
  const snowRecent2h = wx ? TOWNS.some(t => (wx[t.id].s15 || 0) > 0 || wx[t.id].hours.some(([ht, v]) => ht > now - CLOSE_SNOW_MS && ht <= now + 5 * MIN && (v || 0) > 0)) : null;
  const snowNext12h = wx ? TOWNS.some(t => wx[t.id].hours.some(([ht, v]) => ht > now && (v || 0) > 0)) : null;
  const cmaNonBare = segs ? Object.entries(segs).filter(([, s]) => CMA517.includes(s.a) && isWinter(s.c)) : null;
  const cma518NonBare = segs ? Object.entries(segs).filter(([, s]) => CMA518.includes(s.a) && isWinter(s.c)) : null;
  const moves = {};
  let emconMoving = false, emconReporting = false;
  if (plows) {
    for (const v of plows) {
      const pp = prevPlows && prevPlows[v.id];
      const moved = !!pp && distKm({ lat: pp[0], lon: pp[1] }, v) > MOVE_KM;
      const fresh = v.upd ? now - v.upd <= FRESH_MS : null;
      const appeared = !!prevPlows && !pp;
      moves[v.id] = { moved, fresh, appeared };
      if (v.g === 'emcon') {
        if (moved) { emconMoving = true; emconMovedAt = now; }
        if (v.upd && now - v.upd <= CLOSE_EMCON_MS) emconReporting = true;
      }
    }
  }
  const reasons = [];
  if (snowNow && snowNow.length) reasons.push('Open-Meteo snowfall now at ' + snowNow.join(', '));
  if (cmaNonBare && cmaNonBare.length) reasons.push(cmaNonBare.length + ' CMA 517 segment(s) not bare: ' + [...new Set(cmaNonBare.map(([, s]) => s.c))].join(', '));
  if (cma518NonBare && cma518NonBare.length) reasons.push(cma518NonBare.length + ' CMA 518 segment(s) not bare: ' + [...new Set(cma518NonBare.map(([, s]) => s.c))].join(', '));
  if (emconMoving && snowNext12h) reasons.push('Emcon truck(s) moving with snow in the next 12 h forecast');

  // ----- event lifecycle -----
  let ev = await db.prepare("SELECT * FROM events WHERE status = 'open' ORDER BY id DESC LIMIT 1").first();
  const stmts = [];
  let opened = false, closed = null;
  if (ev && ev.is_test && (reasons.length || now - ev.started > TEST_MAX_MS)) {
    closed = { id: ev.id, reason: reasons.length ? 'TEST closed: real snow event started' : 'TEST auto-closed after 3 h' };
    stmts.push(...closeStatements(db, ev, now, closed.reason));
    ev = null;
  }
  if (!ev && reasons.length) {
    const r = await db.prepare("INSERT INTO events (started, is_test, status, open_reason, summary, trucks, wx, updated) VALUES (?, 0, 'open', ?, '{}', '{}', '{}', ?) RETURNING *")
      .bind(now, reasons.join('; '), now).first();
    ev = r; opened = true;
  } else if (ev && !ev.is_test) {
    const canClose = cmaNonBare && cmaNonBare.length === 0 && cma518NonBare && cma518NonBare.length === 0 && snowRecent2h === false && !emconReporting &&
      (!emconMovedAt || now - emconMovedAt >= CLOSE_EMCON_MS) && !emconMoving;
    if (canClose) { closed = { id: ev.id, reason: 'All CMA 517 and CMA 518 segments bare, no Emcon activity 60 min, no snowfall 2 h' }; }
  }

  if (ev) {
    stmts.push(...snapshotStatements(db, ev, now, { wx, segs, plows, moves, prevRoads, opened, errors, reasons }));
    if (closed && closed.id === ev.id) {
      // the snapshot above already updated summary/trucks; finalise on a fresh copy
      const fin = await db.batch(stmts); stmts.length = 0;
      const ev2 = await db.prepare('SELECT * FROM events WHERE id = ?').bind(ev.id).first();
      stmts.push(...closeStatements(db, ev2, now, closed.reason));
    }
  }

  // ----- latest-state bookkeeping (not history) -----
  if (segs) {
    const cur = {};
    for (const [id, s] of Object.entries(segs)) cur[id] = s.c;
    const changed = !prevRoads || Object.keys(cur).length !== Object.keys(prevRoads).length || Object.keys(cur).some(k => cur[k] !== prevRoads[k]);
    if (changed) stmts.push(upsert(db, 'roads', cur, now));
  }
  if (plows) {
    const cur = {};
    for (const v of plows) cur[v.id] = [v.lat, v.lon, v.upd];
    stmts.push(upsert(db, 'plows', cur, now));
  }
  if (emconMovedAt) stmts.push(upsert(db, 'emcon_moved', emconMovedAt, now));
  const check = { t: now, source: opts.source || 'manual', errors, reasons, snow_next_12h: snowNext12h, snow_recent_2h: snowRecent2h,
    cma517_non_bare: cmaNonBare ? cmaNonBare.length : null,
    cma518_non_bare: cma518NonBare ? cma518NonBare.length : null, emcon_moving: emconMoving, emcon_reporting_60m: emconReporting,
    open_event: ev ? ev.id : null, opened: opened ? ev.id : null, closed: closed ? closed.id : null,
    emcon_in_box: plows ? plows.length : null, trucks_scope: 'emcon', segments_in_box: segs ? Object.keys(segs).length : null };
  stmts.push(upsert(db, 'check', check, now));
  if (segs) stmts.push(...roadLogStatements(db, segs, st.roadlog ? st.roadlog.v : null, now));
  if (stmts.length) await db.batch(stmts);
  if (plowsRaw) await gpsStep(env, plowsRaw, now).catch(e => console.log('gps step failed', safeMsg(e)));   // Oct 12 2026: GPS connectivity log
  return check;
}
/* v5.9 daily road log: every condition change and every 511 LastUpdated bump for CMA 517/518, all the time.
   Compared against the stored latest state 'roadlog' ({ segId: [cond, updatedMs] }). A segment with no stored state gets one 'initial' row.
   Rows go out in a single multi-row INSERT per check (cheap on CPU). */
const dayOf = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
function roadLogStatements(db, segs, prev, now) {
  const rows = [], cur = {}, day = dayOf(now);
  for (const [id, s] of Object.entries(segs)) {
    cur[id] = [s.c, s.u];
    const p = prev ? prev[id] : undefined;
    let kind = null, from = null;
    if (!p) kind = 'initial';
    else if (p[0] !== s.c) { kind = 'change'; from = p[0]; }
    else if (s.u && p[1] !== s.u) { kind = 'update'; from = p[0]; }
    if (kind) rows.push([day, now, kind, id, s.a, s.r, s.l, from, s.c, s.sec || null, s.vis || null, s.u]);
  }
  const out = [];
  for (let i = 0; i < rows.length; i += 8) {   // D1 caps bound parameters per statement (100): 8 rows x 12
    const chunk = rows.slice(i, i + 8);
    out.push(db.prepare('INSERT INTO road_log (day, t, kind, seg_id, area, road, location, from_cond, to_cond, secondary, visibility, seg_updated) VALUES ' +
      chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')).bind(...chunk.flat()));
  }
  out.push(upsert(db, 'roadlog', cur, now));   // every check, so 'as of' on the page is the latest 5-minute check
  return out;
}
async function roadLogDays(env, cors) {
  const r = (await env.DB.prepare("SELECT day, SUM(kind = 'change') AS changes, SUM(kind = 'update') AS updates, SUM(kind = 'initial') AS initial, MIN(t) AS first_t, MAX(t) AS last_t FROM road_log GROUP BY day ORDER BY day DESC").all()).results;
  return json({ days: r, coverage: 'CMA 517 and CMA 518', today: dayOf(Date.now()) }, 200, cors);
}
async function roadLogDay(env, day) {
  const rows = (await env.DB.prepare('SELECT t, kind, seg_id, area, road, location, from_cond, to_cond, secondary, visibility, seg_updated FROM road_log WHERE day = ? ORDER BY t, area, road, seg_id').bind(day).all()).results;
  const st = await env.DB.prepare("SELECT v, t FROM state WHERE k = 'roadlog'").first();
  // latest state of every segment as of now, with names from the newest row we hold for it
  const names = {};
  (await env.DB.prepare('SELECT seg_id, area, road, location FROM road_log WHERE id IN (SELECT MAX(id) FROM road_log GROUP BY seg_id)').all()).results.forEach(r => { names[r.seg_id] = r; });
  const latest = st ? Object.entries(JSON.parse(st.v)).map(([id, [c, u]]) => ({ seg_id: id, cond: c, seg_updated: u, ...(names[id] ? { area: names[id].area, road: names[id].road, location: names[id].location } : {}) })) : [];
  return { day, rows, latest, latest_t: st ? st.t : null, coverage: 'CMA 517 and CMA 518', generated: Date.now() };
}
async function roadLogCsv(env, day, cors) {
  const d = await roadLogDay(env, day);
  const L = [], row = a => L.push(a.map(csvCell).join(','));
  row(['# 511 Alberta road condition log, ' + day + ' (America/Edmonton)']);
  row(['# Report generated', mt(d.generated)]);
  row(['# Coverage: CMA 517 and CMA 518']);
  row(['# kind: initial = baseline state when logging started; change = condition changed; update = 511 updated the segment, condition unchanged']);
  row(['observed_mdt', 'observed_utc', 'kind', 'area', 'road', 'location', 'segment_id', 'from_condition', 'to_condition', 'secondary', 'visibility', 'segment_511_updated_mdt']);
  for (const r of d.rows) row([mt(r.t), new Date(r.t).toISOString(), r.kind, r.area, r.road, r.location, r.seg_id, r.from_cond, r.to_cond, r.secondary, r.visibility, r.seg_updated ? mt(r.seg_updated) : '']);
  return new Response(L.join('\n') + '\n', { headers: { 'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="road-log-${day}.csv"`, 'Cache-Control': 'no-store', ...cors } });
}
function upsert(db, k, v, t) {
  return db.prepare('INSERT INTO state (k, v, t) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, t = excluded.t').bind(k, JSON.stringify(v), t);
}

function snapshotStatements(db, ev, now, ctx) {
  const { wx, segs, plows, moves, prevRoads, opened, errors } = ctx;
  const out = [];
  const summary = parse(ev.summary, {});
  const trucks = parse(ev.trucks, {});
  const wxAcc = parse(ev.wx, {});
  const first = opened || !summary.snapshots;

  // weather per town (+ model hourly snowfall since the event started)
  const w = {};
  for (const t of TOWNS) {
    const d = wx && wx[t.id];
    if (!d) { w[t.id] = null; continue; }
    const acc = wxAcc[t.id] || (wxAcc[t.id] = {});
    for (const [ht, v] of d.hours) if (ht > ev.started - 60 * MIN && ht <= now && v != null) acc[ht] = v;   // hour ending at ht
    const accum = Object.entries(acc).filter(([ht]) => Number(ht) > ev.started).reduce((s, [, v]) => s + v, 0);
    w[t.id] = { rate: d.s15 == null ? null : round(d.s15 * 4, 2), s15: d.s15, acc: round(accum, 2), temp: d.temp, wind: d.wind, gust: d.gust, vis: d.vis, code: d.code, mt: d.t };
  }

  // road transitions (CMA 517 + CMA 518 only)
  let nonBare = null, nonBareCma = null, nonBare518 = null;
  if (segs) {
    nonBare = 0; nonBareCma = 0; nonBare518 = 0;
    for (const [id, s] of Object.entries(segs)) {
      const cma = CMA517.includes(s.a) ? 1 : 0;
      const c518 = CMA518.includes(s.a) ? 1 : 0;
      if (isWinter(s.c)) { nonBare++; if (cma) nonBareCma++; if (c518) nonBare518++; }
      const prev = prevRoads ? prevRoads[id] : undefined;
      let from = null, record = false;
      if (first || prev === undefined) record = isWinter(s.c) || ((cma || c518) && first);   // initial state
      else if (prev !== s.c) { from = prev; record = true; }
      if (!record) continue;
      out.push(db.prepare('INSERT INTO transitions (event_id, t, seg_id, road, location, area, cma517, cma518, from_cond, to_cond, seg_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(ev.id, now, id, s.r, s.l, s.a, cma, c518, from, s.c, s.u));
      if (cma && isWinter(s.c) && !summary.first_nonbare_t) { summary.first_nonbare_t = now; summary.first_nonbare_seg = s.r + ' ' + s.l; }
      if (c518 && isWinter(s.c) && !summary.cma518_first_nonbare_t) { summary.cma518_first_nonbare_t = now; summary.cma518_first_nonbare_seg = s.r + ' ' + s.l; }
    }
  }

  // deployments per truck
  let outCount = null;
  if (plows) {
    const seen = new Set();
    for (const v of plows) {
      seen.add(v.id);
      const m = moves[v.id] || {};
      const tr = trucks[v.id] || (trucks[v.id] = { owner: v.owner, g: v.g, deps: [], out: false, lastMove: null, lastSeen: null });
      if (v.owner) { tr.owner = v.owner; tr.g = v.g; }
      tr.lastSeen = now; tr.lat = v.lat; tr.lon = v.lon; tr.upd = v.upd;
      if (m.moved) tr.lastMove = now;
      if (!tr.out) {
        if (m.moved || (m.appeared && m.fresh !== false && !first)) {
          tr.deps.push({ out: now, back: null, why: m.moved ? 'moving' : 'appeared' });
          tr.out = true; tr.lastMove = now;
        }
      } else {
        const dep = tr.deps[tr.deps.length - 1];
        if (m.fresh === false) { dep.back = Math.max(dep.out, v.upd || now); dep.end = 'stopped reporting'; tr.out = false; }
        else if (now - (tr.lastMove || dep.out) >= STATIONARY_MS) { dep.back = tr.lastMove || dep.out; dep.end = 'stationary 30 min'; tr.out = false; }
      }
    }
    for (const [id, tr] of Object.entries(trucks)) {
      if (!seen.has(id) && tr.out) {
        const dep = tr.deps[tr.deps.length - 1];
        dep.back = tr.lastSeen || now; dep.end = 'left feed'; tr.out = false;
      }
    }
    outCount = { emcon: 0 };
    for (const tr of Object.values(trucks)) if (tr.out && tr.g === 'emcon') outCount.emcon++;
  }

  const data = { t: now, w, out: outCount, nb: nonBare, nbc: nonBareCma, nbc518: nonBare518, pl: plows ? plows.length : null, err: Object.keys(errors).length ? errors : undefined };
  const raw = plows ? plows.map(v => [v.id, v.owner, v.lat, v.lon, v.heading, v.upd]) : null;
  out.push(db.prepare('INSERT OR REPLACE INTO snapshots (event_id, t, data, plows) VALUES (?, ?, ?, ?)').bind(ev.id, now, JSON.stringify(data), raw ? JSON.stringify(raw) : null));

  // summary
  summary.snapshots = (summary.snapshots || 0) + 1;
  summary.last_t = now;
  summary.towns = summary.towns || {};
  for (const t of TOWNS) {
    const x = w[t.id]; if (!x) continue;
    const s = summary.towns[t.id] || (summary.towns[t.id] = { name: t.name, acc: 0, max_rate: 0, min_temp: null, max_gust: null, min_vis: null });
    s.acc = x.acc; s.max_rate = Math.max(s.max_rate, x.rate || 0);
    if (x.temp != null) s.min_temp = s.min_temp == null ? x.temp : Math.min(s.min_temp, x.temp);
    if (x.gust != null) s.max_gust = s.max_gust == null ? x.gust : Math.max(s.max_gust, x.gust);
    if (x.vis != null) s.min_vis = s.min_vis == null ? x.vis : Math.min(s.min_vis, x.vis);
  }
  if (outCount) {
    summary.max_out = { emcon: Math.max((summary.max_out && summary.max_out.emcon) || 0, outCount.emcon) };
  }
  Object.assign(summary, truckTotals(trucks, now));
  if (nonBareCma != null) summary.max_nonbare_cma = Math.max(summary.max_nonbare_cma || 0, nonBareCma);
  if (nonBare518 != null) summary.max_nonbare_cma518 = Math.max(summary.max_nonbare_cma518 || 0, nonBare518);
  summary.lag_min = summary.first_nonbare_t && summary.first_emcon_out ? Math.round((summary.first_emcon_out - summary.first_nonbare_t) / MIN) : null;
  out.push(db.prepare('UPDATE events SET summary = ?, trucks = ?, wx = ?, updated = ? WHERE id = ?')
    .bind(JSON.stringify(summary), JSON.stringify(trucks), JSON.stringify(wxAcc), now, ev.id));
  return out;
}
function truckTotals(trucks, now) {
  const hours = { emcon: 0 }, deployed = { emcon: 0 };
  let firstEmcon = null;
  for (const tr of Object.values(trucks)) {
    if (tr.g !== 'emcon' || !tr.deps.length) continue;
    deployed[tr.g]++;
    for (const d of tr.deps) {
      hours[tr.g] += ((d.back || now) - d.out) / 3600000;
      if (tr.g === 'emcon' && (firstEmcon == null || d.out < firstEmcon)) firstEmcon = d.out;
    }
  }
  for (const g in hours) hours[g] = round(hours[g], 2);
  return { truck_hours: hours, trucks_deployed: deployed, first_emcon_out: firstEmcon };
}
function closeStatements(db, ev, now, reason) {
  const trucks = parse(ev.trucks, {});
  for (const tr of Object.values(trucks)) {
    if (tr.out) { const d = tr.deps[tr.deps.length - 1]; d.back = now; d.end = 'still out when event closed'; tr.out = false; }
  }
  const summary = parse(ev.summary, {});
  Object.assign(summary, truckTotals(trucks, now));
  summary.lag_min = summary.first_nonbare_t && summary.first_emcon_out ? Math.round((summary.first_emcon_out - summary.first_nonbare_t) / MIN) : null;
  return [db.prepare("UPDATE events SET status = 'closed', ended = ?, close_reason = ?, trucks = ?, summary = ?, updated = ? WHERE id = ?")
    .bind(now, reason, JSON.stringify(trucks), JSON.stringify(summary), now, ev.id)];
}
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };
const round = (v, n) => Math.round(v * 10 ** n) / 10 ** n;

/* ---------------- read API ---------------- */
async function status(env) {
  const r = await env.DB.prepare("SELECT v, t FROM state WHERE k = 'check'").first();
  const open = await env.DB.prepare("SELECT id, is_test, started FROM events WHERE status = 'open' ORDER BY id DESC LIMIT 1").first();
  return { enabled: true, last_check: r ? parse(r.v, null) : null, open_event: open || null };
}
async function listEvents(env, cors) {
  const rows = (await env.DB.prepare('SELECT id, started, ended, is_test, status, open_reason, close_reason, summary FROM events ORDER BY started DESC LIMIT 100').all()).results;
  const body = '{"enabled":true,"events":[' + rows.map(r => JSON.stringify({ ...r, summary: undefined }).replace(/}$/, ',"summary":' + (r.summary || '{}') + '}')).join(',') + ']}';
  return json(body, 200, cors);
}
async function eventDetail(env, id, cors) {
  const ev = await env.DB.prepare('SELECT id, started, ended, is_test, status, open_reason, close_reason, summary, trucks FROM events WHERE id = ?').bind(id).first();
  if (!ev) return json({ error: 'no such event' }, 404, cors);
  const snaps = (await env.DB.prepare('SELECT data FROM snapshots WHERE event_id = ? ORDER BY t').bind(id).all()).results;
  const trs = (await env.DB.prepare('SELECT t, seg_id, road, location, area, cma517, cma518, from_cond, to_cond, seg_updated FROM transitions WHERE event_id = ? ORDER BY seg_id, t').bind(id).all()).results;
  const head = { id: ev.id, started: ev.started, ended: ev.ended, is_test: ev.is_test, status: ev.status, open_reason: ev.open_reason, close_reason: ev.close_reason, now: Date.now() };
  const body = '{"event":' + JSON.stringify(head) + ',"summary":' + (ev.summary || '{}') + ',"trucks":' + (ev.trucks || '{}') +
    ',"towns":' + JSON.stringify(TOWNS.map(t => ({ id: t.id, name: t.name, cma: t.cma, lat: t.lat, lon: t.lon }))) +
    ',"snapshots":[' + snaps.map(s => s.data).join(',') + '],"transitions":' + JSON.stringify(trs) + '}';
  return json(body, 200, cors);
}
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const iso = t => (t ? new Date(t).toISOString() : '');
// Alberta local time with zone label (MDT/MST), e.g. "2026-10-08 20:20 MDT"; blank when missing
const MT_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
const mt = t => {
  if (!t) return '';
  const p = Object.fromEntries(MT_FMT.formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
};
const fmtDurMs = ms => { if (ms == null || !isFinite(ms) || ms < 0) return ''; const m = Math.round(ms / 60000); const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60; return (d ? d + 'd ' : '') + (d || h ? h + 'h ' : '') + mm + 'm'; };
/** Per road-condition entry: 511 update time -> next change's 511 update time for that segment, or report time if still current.
 *  Uses only real 511 timestamps (seg_updated); a missing one leaves from/to/duration blank. */
function roadSpans(trs, reportT) {
  const bySeg = {};
  for (const r of trs) (bySeg[r.seg_id] = bySeg[r.seg_id] || []).push(r);
  const out = new Map();
  for (const list of Object.values(bySeg)) {
    list.sort((a, b) => a.t - b.t);
    list.forEach((r, i) => {
      const next = list[i + 1];
      const from = r.seg_updated || null;
      const current = !next;
      const to = current ? reportT : (next.seg_updated || null);
      out.set(r, { from, to, current, dur: from && to && to >= from ? to - from : null });
    });
  }
  return out;
}
async function eventCsv(env, id, cors) {
  const ev = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
  if (!ev) return json({ error: 'no such event' }, 404, cors);
  const snaps = (await env.DB.prepare('SELECT data FROM snapshots WHERE event_id = ? ORDER BY t').bind(id).all()).results.map(r => parse(r.data, {}));
  const trs = (await env.DB.prepare('SELECT * FROM transitions WHERE event_id = ? ORDER BY seg_id, t').bind(id).all()).results;
  const trucks = parse(ev.trucks, {});
  const L = [];
  const reportT = Date.now();
  const row = a => L.push(a.map(csvCell).join(','));
  row(['# Report generated', mt(reportT)]);
  row([ev.status === 'open' ? '# Open event, snapshots up to ' + mt(reportT) + ' (latest stored 5-minute check)' : '# Closed event, recorded data as of ' + mt(ev.ended || reportT) + ' (frozen)']);
  row(['# Central Alberta snow event ' + id + (ev.is_test ? ' (TEST)' : ''), 'started_utc=' + iso(ev.started), 'ended_utc=' + iso(ev.ended), 'opened: ' + (ev.open_reason || ''), 'closed: ' + (ev.close_reason || '')]);
  row(['# Weather = Open-Meteo model (not observations); roads + plows = 511 Alberta. Times UTC ISO-8601.']);
  row(['# Trucks: Emcon only (other contractors not recorded), within 2 km of a CMA 517 / CMA 518 road']);
  row(['# Coverage: CMA 517 and CMA 518']);
  L.push('');
  row(['section', 'time_utc', 'town', 'cma', 'snowfall_rate_cm_per_h', 'snowfall_15min_cm', 'accum_since_start_cm', 'temp_c', 'wind_kmh', 'gust_kmh', 'visibility_m', 'weather_code', 'emcon_trucks_out', 'emcon_trucks_reporting', 'cma517_non_bare_segments', 'cma518_non_bare_segments']);
  for (const cma of ['517', '518']) {
    if (cma === '518') { L.push(''); row(['# CMA 518 weather (Castor, Consort, Czar)']); }
    for (const s of snaps) for (const t of TOWNS.filter(x => x.cma === cma)) {
      if (!(t.id in (s.w || {}))) continue;   // snapshot taken before this town was added
      const w = (s.w || {})[t.id] || {};
      row([t.cma === '518' ? 'weather_cma518' : 'weather', iso(s.t), t.name, 'CMA ' + t.cma, w.rate, w.s15, w.acc, w.temp, w.wind, w.gust, w.vis, w.code, s.out && s.out.emcon, s.pl, s.nbc, s.nbc518]);
    }
  }
  L.push('');
  const spans = roadSpans(trs, reportT);
  const roadRows = (label, list) => {
    row(['section', 'observed_utc', 'segment_id', 'area', 'road', 'location', 'cma517', 'cma518', 'from_condition', 'to_condition', 'segment_511_updated_utc',
      'segment_511_updated_mdt', 'condition_from_mdt', 'condition_to_mdt', 'condition_duration']);
    for (const r of list) {
      const sp = spans.get(r) || {};
      row([label, iso(r.t), r.seg_id, r.area, r.road, r.location, r.cma517, r.cma518 || 0, r.from_cond == null ? '(initial)' : r.from_cond, r.to_cond, iso(r.seg_updated),
        mt(r.seg_updated), mt(sp.from), sp.current ? (sp.from ? 'now / report time (' + mt(sp.to) + ')' : '') : mt(sp.to), fmtDurMs(sp.dur)]);
    }
  };
  roadRows('road', trs.filter(r => !r.cma518));
  L.push('');
  row(['# CMA 518 roads (Castor, Consort, Czar)']);
  roadRows('road_cma518', trs.filter(r => r.cma518));
  L.push('');
  row(['section', 'truck_id', 'owner', 'group', 'out_utc', 'back_utc', 'hours', 'start', 'end']);
  for (const [tid, tr] of Object.entries(trucks)) if (tr.g === 'emcon') for (const d of tr.deps) {
    row(['deployment', tid, tr.owner, tr.g, iso(d.out), iso(d.back), d.back ? round((d.back - d.out) / 3600000, 2) : '', d.why, d.end || (d.back ? '' : 'still out')]);
  }
  return new Response(L.join('\r\n') + '\r\n', { headers: { 'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="snow-event-${id}${ev.is_test ? '-TEST' : ''}.csv"`, 'Cache-Control': 'no-store', ...cors } });
}

/* ---------------- login wall (Oct 12 2026) ----------------
 * users / access_requests / sessions in D1. Passwords: PBKDF2-SHA256 (WebCrypto), per-user random salt.
 * Admin endpoints need the Worker secret ADMIN_PASSWORD as a Bearer token; unset = 503 (never defaulted).
 * Cameras: real 511 Alberta data only (tooltip readings + CCTV images), proxied for signed-in users.
 * /events and /roadlog read endpoints stay public server-side (the Drive export script and outlook.html call them);
 * the Events and Road log pages are gated in the browser instead. */
const AUTH_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, grp TEXT NOT NULL CHECK (grp IN ('gov','emcon')), salt TEXT NOT NULL, hash TEXT NOT NULL, iter INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', created INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS access_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, contact TEXT NOT NULL, grp TEXT NOT NULL, note TEXT, status TEXT NOT NULL DEFAULT 'pending', ip TEXT, created INTEGER NOT NULL, decided INTEGER)",
  "CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL)"
];
let authReady = false;
async function ensureAuth(env) {
  if (authReady) return;
  await env.DB.batch(AUTH_SCHEMA.map(q => env.DB.prepare(q)));
  authReady = true;
}
const PBKDF2_ITER = 100000;   // Workers' WebCrypto PBKDF2 maximum
const SESSION_MS = 30 * 24 * 3600 * 1000;
const GROUPS = ['gov', 'emcon'];
const b64 = u8 => btoa(String.fromCharCode(...u8));
const hex = u8 => [...u8].map(b => b.toString(16).padStart(2, '0')).join('');
async function pbkdf2(password, saltB64, iter) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  return b64(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256)));
}
async function hashPw(password) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, hash: await pbkdf2(password, salt, PBKDF2_ITER), iter: PBKDF2_ITER };
}
function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}
const cleanUser = u => (typeof u === 'string' ? u.trim() : '');
const validUser = u => /^[A-Za-z0-9._@-]{3,64}$/.test(u);
const validPw = p => typeof p === 'string' && p.length >= 8 && p.length <= 200;
async function body(request) {
  const t = await request.text();
  if (t.length > 4000) throw new Error('body too large');
  try { return JSON.parse(t || '{}'); } catch (e) { return {}; }
}
const bearer = r => { const m = /^Bearer\s+(.+)$/i.exec(r.headers.get('Authorization') || ''); return m ? m[1].trim() : ''; };
async function sessionUser(request, env) {
  const tok = bearer(request);
  if (!/^[0-9a-f]{64}$/.test(tok)) return null;
  const r = await env.DB.prepare("SELECT u.id, u.username, u.grp, s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ? AND u.status = 'active'").bind(tok, Date.now()).first();
  return r || null;
}

/* Real 511 Alberta camera sites (tooltip ids) and the CCTV image each card shows. Checked against 511.alberta.ca Oct 12 2026. */
const CAMS = {
  '517': [
    { site: 98, img: 243, label: 'Morrin Corner (Hwy 9 near Morrin)' },
    { site: 97, img: 240, label: 'Hwy 9: 10km west of Drumheller' }
  ],
  '518': [
    { site: 99, img: 246, label: 'Hwy 9: near Craigmyle', paveSuspect: true },
    { site: 39, img: 65, label: 'Hwy 36 & Twp Rd 392 near Alliance' },
    { site: 314, img: 570, label: 'Youngstown (Hwy 9)' }
  ],
  '518x': [{ site: 101, img: 251, label: 'Hwy 9: near Oyen' }],
  'hwy2': [
    { site: 77, img: 184, label: 'Hwy 2: south of Airdrie (Balzac overpass)' },
    { site: 78, img: 188, label: 'Hwy 2: near Carstairs (south of Hwy 581)', paveSuspect: true },
    { site: 79, img: 189, label: 'Hwy 2: near Bowden (south of Hwy 587)' },
    { site: 80, img: 192, label: 'Hwy 2: near Ponoka (Morningside overpass)' }
  ]
};
const CAM_IMGS = new Set(Object.values(CAMS).flat().map(c => c.img));
const unent = s => s.replace(/&amp;/g, '&').replace(/&#176;|&deg;/g, '°').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
async function camInfo(c, district) {
  const out = { site: c.site, img: c.img, label: c.label, district, name: null, dir: null, readings: {}, pave_suspect: !!c.paveSuspect, error: null };
  try {
    const res = await fetch('https://511.alberta.ca/tooltip/Cameras/' + c.site, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000), cf: { cacheTtl: 120, cacheEverything: true } });
    if (!res.ok) throw new Error('511 HTTP ' + res.status);
    const h = await res.text();
    const nm = /CameraTooltipDescriptionColumn[\s\S]*?<strong>([\s\S]*?)<\/strong>/.exec(h);
    out.name = nm ? unent(nm[1]) : null;
    const im = new RegExp('data-lazy="/map/Cctv/' + c.img + '"[^>]*data-fs-desc="([^"]*)"').exec(h);
    out.dir = im ? unent(im[1]) : null;
    if (!new RegExp('/map/Cctv/' + c.img + '"').test(h)) out.error = 'image no longer listed by 511';
    const want = { 'Air Temperature': 'air', 'Pavement Temperature': 'pavement', 'Wind Speed': 'wind', 'Wind Direction': 'wind_dir', 'Relative Humidity': 'humidity', 'Weather Updated': 'updated' };
    const re = /<td[^>]*>\s*([^<]+?)\s*<\/td>\s*<td[^>]*>\s*([^<]*?)\s*<\/td>/g;
    let m;
    while ((m = re.exec(h))) { const k = want[unent(m[1])]; if (k && unent(m[2]) && !/^n\/?a$/i.test(unent(m[2]))) out.readings[k] = unent(m[2]); }
  } catch (e) { out.error = safeMsg(e); }
  return out;
}

async function authRoutes(request, env, p, cors) {
  await ensureAuth(env);
  const M = request.method, now = Date.now();
  // ---- public auth ----
  if (p === '/auth/login' && M === 'POST') {
    const b = await body(request), u = cleanUser(b.username);
    if (!GROUPS.includes(b.group) || !validUser(u) || typeof b.password !== 'string') return json({ error: 'wrong username or password' }, 401, cors);
    const row = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND status = 'active'").bind(u).first();
    const ok = row && row.grp === b.group && safeEq(await pbkdf2(b.password, row.salt, row.iter), row.hash);
    if (!row) await pbkdf2(b.password, b64(new Uint8Array(16)), PBKDF2_ITER);   // similar timing for unknown users
    if (!ok) return json({ error: 'wrong username or password' }, 401, cors);
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(now),
      env.DB.prepare('INSERT INTO sessions (token, user_id, expires, created) VALUES (?, ?, ?, ?)').bind(token, row.id, now + SESSION_MS, now)
    ]);
    return json({ token, username: row.username, group: row.grp, expires: now + SESSION_MS }, 200, cors);
  }
  if (p === '/auth/logout' && M === 'POST') {
    const tok = bearer(request);
    if (tok) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(tok).run();
    return json({ ok: true }, 200, cors);
  }
  if (p === '/auth/me' && M === 'GET') {
    const s = await sessionUser(request, env);
    return s ? json({ username: s.username, group: s.grp, expires: s.expires }, 200, cors) : json({ error: 'not signed in' }, 401, cors);
  }
  if (p === '/auth/request' && M === 'POST') {
    const b = await body(request);
    const name = String(b.name || '').trim(), contact = String(b.contact || '').trim(), note = String(b.note || '').trim();
    if (!GROUPS.includes(b.group) || !name || !contact || name.length > 80 || contact.length > 120 || note.length > 500)
      return json({ error: 'please fill in name, contact and group (name ≤ 80, contact ≤ 120, note ≤ 500 characters)' }, 400, cors);
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const recent = await env.DB.prepare('SELECT COUNT(*) n FROM access_requests WHERE ip = ? AND created > ?').bind(ip, now - 3600000).first();
    const pend = await env.DB.prepare("SELECT COUNT(*) n FROM access_requests WHERE status = 'pending'").first();
    if (recent.n >= 3 || pend.n >= 200) return json({ error: 'too many requests, please try again later' }, 429, cors);
    await env.DB.prepare('INSERT INTO access_requests (name, contact, grp, note, ip, created) VALUES (?, ?, ?, ?, ?, ?)').bind(name, contact, b.group, note || null, ip, now).run();
    return json({ ok: true }, 200, cors);
  }
  // ---- cameras (session) ----
  if (p.startsWith('/cameras')) {
    if (M !== 'GET') return json({ error: 'method not allowed' }, 405, cors);
    const s = await sessionUser(request, env);
    if (!s) return json({ error: 'not signed in' }, 401, cors);
    const im = /^\/cameras\/img\/(\d+)$/.exec(p);
    if (im) {
      const id = Number(im[1]);
      if (!CAM_IMGS.has(id)) return json({ error: 'unknown camera image' }, 404, cors);
      const r = await fetch('https://511.alberta.ca/map/Cctv/' + id, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000), cf: { cacheTtl: 60, cacheEverything: true } });
      if (!r.ok) return json({ error: '511 image HTTP ' + r.status }, 502, cors);
      return new Response(r.body, { headers: { 'Content-Type': r.headers.get('Content-Type') || 'image/jpeg', 'Cache-Control': 'private, max-age=60', ...cors } });
    }
    if (p === '/cameras') {
      const d = new URL(request.url).searchParams.get('district') || '517';
      const lists = d === 'all' ? { '517': CAMS['517'], '518': [...CAMS['518'], ...CAMS['518x']], 'hwy2': CAMS.hwy2 } : CAMS[d] && /^51[78]$/.test(d) ? { [d]: CAMS[d] } : null;
      if (!lists) return json({ error: 'district must be 517, 518 or all' }, 400, cors);
      const sections = {};
      for (const [k, list] of Object.entries(lists)) sections[k] = await Promise.all(list.map(c => camInfo(c, k)));
      return json({ generated: now, source: '511 Alberta (511.alberta.ca)', sections }, 200, cors);
    }
    return json({ error: 'not found' }, 404, cors);
  }
  // ---- GPS connectivity log (Emcon session) ----
  if (p.startsWith('/gps')) {
    if (M !== 'GET') return json({ error: 'method not allowed' }, 405, cors);
    const s = await sessionUser(request, env);
    if (!s) return json({ error: 'not signed in' }, 401, cors);
    if (s.grp !== 'emcon') return json({ error: 'Emcon Services accounts only' }, 403, cors);
    await ensureGps(env);
    if (p === '/gps/days') {
      const rows = (await env.DB.prepare('SELECT day, COUNT(*) n FROM gps_events GROUP BY day ORDER BY day DESC LIMIT 120').all()).results;
      const since = await env.DB.prepare("SELECT t FROM state WHERE k = 'gps_since'").first();
      return json({ days: rows, recording_since: since ? since.t : null }, 200, cors);
    }
    const dm = /^\/gps\/(\d{4}-\d{2}-\d{2})$/.exec(p);
    if (dm) return json({ day: dm[1], events: (await env.DB.prepare('SELECT truck, owner, event, ts, lat, lon, feed_ts FROM gps_events WHERE day = ? ORDER BY ts DESC, id DESC').bind(dm[1]).all()).results }, 200, cors);
    return json({ error: 'not found' }, 404, cors);
  }
  // ---- admin (Bearer ADMIN_PASSWORD) ----
  if (p.startsWith('/admin')) {
    if (!env.ADMIN_PASSWORD) return json({ error: 'admin password not set' }, 503, cors);
    if (!safeEq(bearer(request), env.ADMIN_PASSWORD)) return json({ error: 'wrong admin password' }, 401, cors);
    const b = M === 'POST' ? await body(request) : {};
    const createUser = async (u, grp, pw) => {
      u = cleanUser(u);
      if (!validUser(u)) return 'username must be 3-64 letters, digits or . _ @ -';
      if (!GROUPS.includes(grp)) return 'group must be gov or emcon';
      if (!validPw(pw)) return 'password must be 8-200 characters';
      if (await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(u).first()) return 'username already exists';
      const h = await hashPw(pw);
      await env.DB.prepare("INSERT INTO users (username, grp, salt, hash, iter, status, created) VALUES (?, ?, ?, ?, ?, 'active', ?)").bind(u, grp, h.salt, h.hash, h.iter, now).run();
      return null;
    };
    if (p === '/admin/check' && M === 'GET') return json({ ok: true }, 200, cors);
    if (p === '/admin/requests' && M === 'GET')
      return json({ requests: (await env.DB.prepare("SELECT id, name, contact, grp AS 'group', note, status, created, decided FROM access_requests ORDER BY (status = 'pending') DESC, created DESC LIMIT 200").all()).results }, 200, cors);
    if (p === '/admin/users' && M === 'GET')
      return json({ users: (await env.DB.prepare("SELECT id, username, grp AS 'group', status, created FROM users ORDER BY status, username").all()).results }, 200, cors);
    let m;
    if ((m = /^\/admin\/requests\/(\d+)\/(approve|deny)$/.exec(p)) && M === 'POST') {
      const r = await env.DB.prepare("SELECT * FROM access_requests WHERE id = ? AND status = 'pending'").bind(Number(m[1])).first();
      if (!r) return json({ error: 'no pending request with that id' }, 404, cors);
      if (m[2] === 'approve') {
        const err = await createUser(b.username, b.group || r.grp, b.password);
        if (err) return json({ error: err }, 400, cors);
      }
      await env.DB.prepare('UPDATE access_requests SET status = ?, decided = ? WHERE id = ?').bind(m[2] === 'approve' ? 'approved' : 'denied', now, r.id).run();
      return json({ ok: true }, 200, cors);
    }
    if (p === '/admin/users' && M === 'POST') {
      const err = await createUser(b.username, b.group, b.password);
      return err ? json({ error: err }, 400, cors) : json({ ok: true }, 200, cors);
    }
    if ((m = /^\/admin\/users\/(\d+)\/(reset|revoke|restore|delete)$/.exec(p)) && M === 'POST') {
      const id = Number(m[1]);
      const u = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
      if (!u) return json({ error: 'no such user' }, 404, cors);
      if (m[2] === 'reset') {
        if (!validPw(b.password)) return json({ error: 'password must be 8-200 characters' }, 400, cors);
        const h = await hashPw(b.password);
        await env.DB.batch([env.DB.prepare('UPDATE users SET salt = ?, hash = ?, iter = ? WHERE id = ?').bind(h.salt, h.hash, h.iter, id),
          env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id)]);
      } else if (m[2] === 'delete') {
        await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id), env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id)]);
      } else {
        await env.DB.batch([env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(m[2] === 'revoke' ? 'revoked' : 'active', id),
          env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id)]);
      }
      return json({ ok: true }, 200, cors);
    }
    return json({ error: 'not found' }, 404, cors);
  }
  return json({ error: 'not found' }, 404, cors);
}

/* ---------------- GPS connectivity log (Oct 12 2026) ----------------
 * Built from the same 511 plow feed (Emcon vehicles, via alberta-plow-relay /plows) the 5-minute check already reads. No backfill.
 *   Started: a truck appears in the feed reporting (511 'updated' within 15 min), or moves again after a Stopped.
 *   Stopped: still reporting, but its position has not changed (< 25 m) for 3 or more polls in a row.
 *   Lost:    it drops out of the feed, or its 511 'updated' time is more than 15 min old.
 * A poll where the feed itself fails records nothing. */
const GPS_STALE_MS = 15 * MIN, GPS_SAME_KM = 0.025, GPS_SAME_POLLS = 3;
let gpsReady = false;
async function ensureGps(env) {
  if (gpsReady) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS gps_events (id INTEGER PRIMARY KEY AUTOINCREMENT, truck TEXT NOT NULL, owner TEXT, event TEXT NOT NULL, ts INTEGER NOT NULL, lat REAL, lon REAL, feed_ts INTEGER, day TEXT NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_gps_day ON gps_events (day, ts)')
  ]);
  gpsReady = true;
}
const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' });
async function gpsStep(env, plows, now) {
  await ensureGps(env);
  const db = env.DB;
  const row = await db.prepare("SELECT v FROM state WHERE k = 'gps'").first();
  const prev = row ? parse(row.v, {}) : {};
  const next = {}, ev = [], day = DAY_FMT.format(new Date(now));
  const add = (id, owner, event, lat, lon, fts) => ev.push(db.prepare('INSERT INTO gps_events (truck, owner, event, ts, lat, lon, feed_ts, day) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, owner, event, now, lat, lon, fts, day));
  const seen = new Set();
  for (const v of plows) {
    seen.add(v.id);
    const p = prev[v.id];
    const fresh = v.upd ? now - v.upd <= GPS_STALE_MS : true;   // no 511 timestamp: being in the feed counts as reporting
    const n = { lat: v.lat, lon: v.lon, upd: v.upd, owner: v.owner, same: 0, st: p ? p.st : 'lost' };
    if (!fresh) { if (p && p.st !== 'lost') add(v.id, v.owner, 'Lost', v.lat, v.lon, v.upd); n.st = 'lost'; }
    else if (!p || p.st === 'lost') { add(v.id, v.owner, 'Started', v.lat, v.lon, v.upd); n.st = 'reporting'; }
    else {
      const same = distKm({ lat: p.lat, lon: p.lon }, v) < GPS_SAME_KM;
      n.same = same ? (p.same || 0) + 1 : 0;
      if (same && n.same >= GPS_SAME_POLLS && p.st === 'reporting') { add(v.id, v.owner, 'Stopped', v.lat, v.lon, v.upd); n.st = 'stopped'; }
      else if (!same && p.st === 'stopped') { add(v.id, v.owner, 'Started', v.lat, v.lon, v.upd); n.st = 'reporting'; }
    }
    next[v.id] = n;
  }
  for (const [id, p] of Object.entries(prev)) {
    if (seen.has(id)) continue;
    if (p.st !== 'lost') add(id, p.owner, 'Lost', p.lat, p.lon, p.upd);
    if (now - (p.upd || now) < 7 * 24 * 3600 * 1000) next[id] = { ...p, st: 'lost', same: 0 };
  }
  ev.push(upsert(db, 'gps', next, now));
  if (!row) ev.push(upsert(db, 'gps_since', now, now));
  await db.batch(ev);
}
