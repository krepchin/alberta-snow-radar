# Central Alberta Snow Radar (v5.3)

Single-file web pages, no API keys in the browser, no build step for the pages themselves:

- `index.html` — ECCC MSC GeoMet snow radar + HRDPS snowfall forecast, Open-Meteo town conditions (modelled),
  511 Alberta snowplow overlay (and road conditions when available), Leaflet map.
- `forecast.html` — Open-Meteo 7-day daily forecast for Three Hills, Drumheller and Stettler
  (one multi-location request; tabs linkable as `#three-hills`, `#drumheller`, `#stettler`, `#all`).

Update: replace the file, commit, push to `main` (or use the helper script); Pages redeploys in about a minute.

## 511 Alberta plow data (v5.3)

`index.html` reads `data/plows.json` (same origin; 511 sends no CORS headers, so the browser never calls 511)
every 2.5 min with a cache-buster, and `data/roads.geojson` only when `plows.json` says `"roads": true`.

- `scripts/fetch_511.py` builds those files: one request to the 511 map feed
  (`/map/mapIcons/ServiceVehicles`), keeps vehicles in Central Alberta (lat 51.0–52.8, lon −114.5 to −111.5),
  takes the heading from the icon `rotation` (degrees clockwise from north; −1 = unknown), and fetches the
  per-vehicle tooltip (owner, "Updated" time) for those vehicles only, spaced 0.7 s apart, descriptive User-Agent.
  With `ALBERTA_511_API_KEY` set it also fetches `/api/v3/get/winterroads`, decodes `EncodedPolyline`,
  clips to Central Alberta and writes `roads.geojson`. The key is never written to output or logs.
  If 511 fails it reuses the last published file. Credit: 511 Alberta (undocumented feed; may change or break).
- `data/plows.json` in the repo is only a placeholder ("data feed not active yet").
- **Pending activation:** `scripts/pages-workflow.yml` is the GitHub Actions workflow (cron `*/5`, push,
  `workflow_dispatch`) that copies the repo files unchanged into the Pages artifact, runs the fetch script and
  deploys with `actions/deploy-pages`, so generated data is never committed. It must be moved to
  `.github/workflows/pages.yml` (the current gh token lacks the `workflow` scope), then Pages switched to
  "GitHub Actions": `gh api -X PUT repos/krepchin/alberta-snow-radar/pages -f build_type=workflow`.
  After that, every push to `main` deploys through the workflow; GitHub disables scheduled workflows after
  60 days without repo activity.
