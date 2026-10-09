# alberta-snow-events (TEST)

Snow-event log for the Central Alberta Snow Radar page. **This is a removable test deployment.**
It is a separate Cloudflare Worker with its own D1 database. It does not change the map, the plow
relay (`alberta-plow-relay`), `pages.yml` or the plow trigger script. It only *reads* the relay's
public data (through a read-only service binding).

```
cron */5 min ──► alberta-snow-events Worker ──► D1 "alberta-snow-events"
                    │  reads: Open-Meteo (3 towns, 1 request)
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
  has been stationary for 30 min (back time = last movement). Mainroad and other owners are logged
  too.
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
| `GET /events/config` | `{enabled, test_mode}`. The main page shows the Events link only when `enabled` is true. |
| `GET /events/status` | Last check result and the currently open event. |
| `GET /events` | Event list, newest first, with summaries. |
| `GET /events/{id}` | Full event: snapshots, transitions, trucks. |
| `GET /events/{id}/csv` | CSV download with weather, road and deployment sections (UTC times). |
| `GET /events/test/{start\|stop\|clear\|snapshot}?token=…` | Test controls (Worker secret `TEST_TOKEN`). |

### Test mode

The token is stored only as the Worker secret and in `~/.config/alberta-snow-events/test-token`
on the box (mode 600). Never paste it into chat or commits.

```sh
E=https://alberta-snow-events.krepchin.workers.dev
T=~/.config/alberta-snow-events/test-token
curl -s -G --data-urlencode "token@$T" $E/events/test/start   # opens a TEST event (flagged is_test)
curl -s -G --data-urlencode "token@$T" $E/events/test/stop    # closes it
curl -s -G --data-urlencode "token@$T" $E/events/test/clear   # deletes ALL TEST events and their data
```

A TEST event closes automatically after 3 h, or when a real event starts. To rotate the token:
`npx wrangler@3 secret put TEST_TOKEN --config events-worker/wrangler.toml < newtokenfile`.

## Deploy / operate

Run wrangler from a folder that has a writable `node_modules`, for example
`/workspace/plows-work/wr`. Running it from the repo folder fails with `EACCES` on
`/node_modules/.cache`. wrangler@4 needs Node 22, so use wrangler@3.

```sh
cd /workspace/plows-work/wr
npx wrangler@3 deploy --config /workspace/alberta-snow-radar-site/events-worker/wrangler.toml
npx wrangler@3 d1 execute alberta-snow-events --remote --file /workspace/alberta-snow-radar-site/events-worker/schema.sql -y   # first time only
```

## Kill switch

`EVENTS_ENABLED` in `wrangler.toml` controls recording and the link:

* Set it to `"false"` and redeploy, or run once:
  `npx wrangler@3 deploy --config …/events-worker/wrangler.toml --var EVENTS_ENABLED:false`.
  * The cron then returns immediately and writes nothing to D1.
  * `/events/config` reports `enabled:false`, so the main page hides the Events link (within about
    a minute, because of the 60 s cache).
  * events.html shows "Event recording is switched off". Past events stay readable.
* Set it back to `"true"` and redeploy to resume.

## Full removal

1. `npx wrangler@3 delete --name alberta-snow-events` (removes the Worker and its cron).
2. `npx wrangler@3 d1 delete alberta-snow-events` (deletes all recorded data).
3. In the site repo, delete `events.html` and the `events-worker/` folder. In `index.html`,
   remove the `EVENTS_CONFIG_URL` script block and the two `evlink` anchors (`#evMapLink`,
   `#evLink`) with their `.evlink` CSS. Setting `EVENTS_CONFIG_URL = ''` alone is enough to hide
   the link.
4. Optionally delete `~/.config/alberta-snow-events/`.

If only the Worker is deleted, the config fetch fails, so the link stays hidden. The main page
keeps working.
