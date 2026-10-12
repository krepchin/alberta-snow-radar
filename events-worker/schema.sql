-- alberta-snow-events D1 schema (TEST deployment; drop the whole database to remove)
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started INTEGER NOT NULL,            -- ms epoch
  ended INTEGER,                       -- ms epoch, null while open
  is_test INTEGER NOT NULL DEFAULT 0,  -- 1 = manually forced TEST event
  status TEXT NOT NULL,                -- 'open' | 'closed'
  open_reason TEXT,
  close_reason TEXT,
  summary TEXT,                        -- JSON, recomputed every snapshot
  trucks TEXT,                         -- JSON per-truck deployment state
  wx TEXT,                             -- JSON hourly model snowfall per town since start
  updated INTEGER
);
CREATE TABLE IF NOT EXISTS snapshots (
  event_id INTEGER NOT NULL,
  t INTEGER NOT NULL,
  data TEXT NOT NULL,                  -- JSON: weather per town, trucks out, non-bare counts
  plows TEXT,                          -- JSON: raw Emcon plow positions [id, owner, lat, lon, heading, updated_ms] (Emcon only)
  PRIMARY KEY (event_id, t)
);
CREATE TABLE IF NOT EXISTS transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  t INTEGER NOT NULL,                  -- when this worker observed it (ms)
  seg_id TEXT NOT NULL,
  road TEXT, location TEXT, area TEXT,
  cma517 INTEGER NOT NULL DEFAULT 0,
  cma518 INTEGER NOT NULL DEFAULT 0,   -- CMA 518 (Castor, Consort, Czar), recorded separately; added Oct 8 2026: ALTER TABLE transitions ADD COLUMN cma518 INTEGER NOT NULL DEFAULT 0
  from_cond TEXT,                      -- null = state when the event opened ('initial')
  to_cond TEXT,
  seg_updated INTEGER                  -- 511 LastUpdated for the segment (ms)
);
CREATE INDEX IF NOT EXISTS idx_tr_event ON transitions (event_id, seg_id, t);
CREATE TABLE IF NOT EXISTS state (     -- latest observation only (not a history)
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  t INTEGER NOT NULL
);
-- v5.9: daily log of every 511 road condition update for CMA 517 / CMA 518 (recorded all the time, not only during events)
CREATE TABLE IF NOT EXISTS road_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,                   -- YYYY-MM-DD, America/Edmonton
  t INTEGER NOT NULL,                  -- observed by this worker (ms)
  kind TEXT NOT NULL,                  -- 'initial' (baseline) | 'change' | 'update' (511 LastUpdated bumped, same condition)
  seg_id TEXT NOT NULL, area TEXT, road TEXT, location TEXT,
  from_cond TEXT, to_cond TEXT, secondary TEXT, visibility TEXT,
  seg_updated INTEGER                  -- 511 LastUpdated (ms)
);
CREATE INDEX IF NOT EXISTS idx_rl_day ON road_log (day, t);

-- Oct 12 2026: login wall (also created on demand by the worker)
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, grp TEXT NOT NULL CHECK (grp IN ('gov','emcon')), salt TEXT NOT NULL, hash TEXT NOT NULL, iter INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS access_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, contact TEXT NOT NULL, grp TEXT NOT NULL, note TEXT, status TEXT NOT NULL DEFAULT 'pending', ip TEXT, created INTEGER NOT NULL, decided INTEGER);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL);
