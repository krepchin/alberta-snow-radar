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
