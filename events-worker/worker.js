/**
 * alberta-snow-events: snow-event recorder (Cloudflare Worker + D1 + Cron every 5 min).
 *
 * Separate from the map. It only READS public data:
 *   - Open-Meteo current + hourly model weather for Three Hills, Drumheller, Stettler (CMA 517) and Castor, Consort, Czar (CMA 518)
 *   - alberta-plow-relay /roads and /plows (511 Alberta), via a read-only service binding
 *     (falls back to the public workers.dev URL)
 * Nothing is recorded until an event opens (see ARMING). Recording is always on (no switch, no test controls; removed Oct 8 2026).
 * Nothing here is invented: missing inputs are stored as null and never treated as "bare" or "no snow".
 * Trucks: Emcon only (owner matches /emcon|mcon/i). Mainroad and other contractors' trucks are dropped on input and never stored.
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
const ALLOWED_ORIGINS = [/^https:\/\/krepchin\.github\.io$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];

const isWinter = c => !!c && !/^(bare|no report|closed)/i.test(String(c).trim());   // see README: Closed is excluded
const group = o => /emcon|mcon/i.test(o || '') ? 'emcon' : /mainroad/i.test(o || '') ? 'mainroad' : 'other';

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runCheck(env, { source: 'cron' }).catch(e => console.log('check failed', String(e && e.message || e))));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get('Origin') || '');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Max-Age': '86400' } });
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, cors);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (p === '/') return new Response('alberta-snow-events: GET /events/config · /events/status · /events · /events/{id} · /events/{id}/csv. Data: Open-Meteo, 511 Alberta.\n',
        { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...cors } });
      if (p === '/events/config') return json({ enabled: true, trucks: 'emcon' }, 200, { ...cors, 'Cache-Control': 'public, max-age=60' });
      if (p === '/events/status') return json(await status(env), 200, cors);
      if (p === '/events') return listEvents(env, cors);
      const dm = /^\/events\/(\d+)(\/csv)?$/.exec(p);
      if (dm) return dm[2] ? eventCsv(env, Number(dm[1]), cors) : eventDetail(env, Number(dm[1]), cors);
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
    h['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
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
  const segs = {};
  for (const f of gj.features) {
    const p = f.properties || {};
    if (p.id == null) continue;
    segs[String(p.id)] = { c: p.condition || null, r: p.road || '', l: p.location || '', a: p.area || '', u: p.updated ? Date.parse(p.updated) : null };
  }
  return segs;
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
  const [wx, segs, plows] = await Promise.all([
    getWeather().catch(e => { errors.weather = safeMsg(e); return null; }),
    getRoads(env).catch(e => { errors.roads = safeMsg(e); return null; }),
    getPlows(env).catch(e => { errors.plows = safeMsg(e); return null; })
  ]);
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
  if (stmts.length) await db.batch(stmts);
  return check;
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

  // road transitions (box), CMA 517 flagged
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
  row(['# Trucks: Emcon only (Mainroad and other contractors are not recorded)']);
  L.push('');
  row(['section', 'time_utc', 'town', 'cma', 'snowfall_rate_cm_per_h', 'snowfall_15min_cm', 'accum_since_start_cm', 'temp_c', 'wind_kmh', 'gust_kmh', 'visibility_m', 'weather_code', 'emcon_trucks_out', 'emcon_trucks_reporting_in_box', 'cma517_non_bare_segments', 'cma518_non_bare_segments', 'box_non_bare_segments']);
  for (const cma of ['517', '518']) {
    if (cma === '518') { L.push(''); row(['# CMA 518 weather (Castor, Consort, Czar)']); }
    for (const s of snaps) for (const t of TOWNS.filter(x => x.cma === cma)) {
      if (!(t.id in (s.w || {}))) continue;   // snapshot taken before this town was added
      const w = (s.w || {})[t.id] || {};
      row([t.cma === '518' ? 'weather_cma518' : 'weather', iso(s.t), t.name, 'CMA ' + t.cma, w.rate, w.s15, w.acc, w.temp, w.wind, w.gust, w.vis, w.code, s.out && s.out.emcon, s.pl, s.nbc, s.nbc518, s.nb]);
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
