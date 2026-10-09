# alberta-snow-events

Snow-event log for the Central Alberta Snow Radar page. **Always on**: there is no on/off switch and no test
controls (both removed Oct 8, 2026, at Kent's request). Event 1 is an earlier TEST record and is kept as is.
It is a separate Cloudflare Worker with its own D1 database. It does not change the map, the plow
relay (`alberta-plow-relay`), `pages.yml` or the plow trigger script. It only *reads* the relay's
public data (through a read-only service binding).

```
cron */5 min ──► alberta-snow-events Worker ──► D1 "alberta-snow-events"
                    │  reads: Open-Meteo (6 towns, 1 request)
                    │         alberta-plow-relay /plows and /roads (service binding RELAY)
                    └─ serves JSON/CSV to events.html (CORS: krepchin.github.io, localhost)
```

Why a Worker: Cloudflare cron triggers run every 5 minutes, D1 keeps history without committing
to git, and the free tier covers it. Each check uses 3 subrequests (limit 50). Most CPU time goes
to parsing the cached /roads GeoJSON (~1–3 ms), well under the 10 ms limit. GitHub Actions cron was
not needed. It is also less reliable at 5-minute intervals and would add commits to the repo.

## Rules (what is recorded)

* **Armed and idle** until a trigger fires. Nothing is stored between events except a small
  `state` table: last check, latest road conditions and plow positions, which is needed to detect
  changes.
* **Event opens** when any of these is true:
  * Open-Meteo shows snowfall in the last 15 min at Three Hills, Drumheller or Stettler.
  * Any CMA 517 segment (`AreaName` "CMA 517 - Three Hills / - Drumheller / - Stettler") is not
    Bare or No Report.
  * An Emcon truck (owner matches `/emcon|mcon/i`) moved more than 250 m with snow in the next
    12 h forecast.
* **While open, every 5 min**: weather per town (15-min snowfall ×4 as cm/h, accumulation from
  hourly totals, temperature, wind, gusts, visibility), road-condition **transitions only**
  (every CMA 517 segment is recorded once at the start), and plow positions, owner and 511
  "updated" time.
* **Event closes** when all three are true: every CMA 517 segment is bare, no Emcon truck has
  reported moving for 60 min, and no snowfall for 2 h.
* **Truck deployments**: *out* when a truck starts moving, or first appears with a fresh report.
  *Back* when it stops reporting (511 update older than 30 min or gone from the feed), or when it
  has been stationary for 30 min (back time = last movement). Emcon trucks only (see v5.8 notes).
* **Summary**: duration, snowfall per town, max trucks out at once, truck-hours, Emcon trucks
  deployed, and the lag from the first non-bare CMA 517 report to the first Emcon truck out.
* Road conditions "Closed" are **not** counted as winter conditions. Long-term closures would
  otherwise keep an event open forever. Closed segments are still recorded as transitions.
* If a source fails, the error is stored and the value is left empty. A failure never counts as
  "bare" or "no snow", so an outage cannot close an event.
* Weather is Open-Meteo **model** data, not observations. Times are 5-minute snapshots, so
  out/back times are accurate to about ±5 min.

## Endpoints (https://alberta-snow-events.krepchin.workers.dev)

| Path | |
|---|---|
| `GET /events/config` | Always `{"enabled": true, "trucks": "emcon"}`. The main page no longer reads it; the Events link always shows. |
| `GET /events/status` | Last check result and the currently open event. |
| `GET /events` | Event list, newest first, with summaries. |
| `GET /events/{id}` | Full event: snapshots, transitions, trucks. |
| `GET /events/{id}/csv` | CSV download with weather, road and deployment sections (UTC times). |

## Deploy / operate

Run wrangler from a folder that has a writable `node_modules`, for example
`/workspace/plows-work/wr`. Running it from the repo folder fails with `EACCES` on
`/node_modules/.cache`. wrangler@4 needs Node 22, so use wrangler@3.

```sh
cd /workspace/plows-work/wr
npx wrangler@3 deploy --config /workspace/alberta-snow-radar-site/events-worker/wrangler.toml
npx wrangler@3 d1 execute alberta-snow-events --remote --file /workspace/alberta-snow-radar-site/events-worker/schema.sql -y   # first time only
```

## Full removal (admin note)

Only if the whole feature is ever retired:


1. `npx wrangler@3 delete --name alberta-snow-events` (removes the Worker and its cron).
2. `npx wrangler@3 d1 delete alberta-snow-events` (deletes all recorded data).
3. In the site repo, delete `events.html` and the `events-worker/` folder. In `index.html`,
   remove the two `evlink` anchors (`#evMapLink`, `#evLink`) and their `.evlink` CSS.

## v5.8 changes (Oct 8, 2026)

- **Trucks: Emcon only.** `getPlows()` drops every vehicle whose owner does not match `/emcon|mcon/i`, so Mainroad and other
  contractors are never stored. Rows already stored for TEST event 1 were purged (trucks, snapshot plow lists, counts).
- **CMA 518** (Castor, Consort, Czar) is set up like CMA 517: weather points `ca`, `co`, `cz`; transitions carry a `cma518` flag
  (`ALTER TABLE transitions ADD COLUMN cma518 INTEGER NOT NULL DEFAULT 0`, already applied); snapshots carry `nbc518`;
  a non-bare CMA 518 segment or snowfall at a CMA 518 town opens or continues an event, and closing needs both CMAs bare.
- The relay's plow and road boxes now reach lon -109.9 (Saskatchewan border) so all 32 CMA 518 segments are included.
- **Google Drive copy:** `/workspace/export-snow-events-to-drive.py` (on the agent box) saves every event as JSON, CSV and a
  Google Sheet to My Drive > Off-grid bus > Alberta Weather Demo > Snow Events. It is not part of this Worker; removing the
  Worker does not touch the Drive files.
