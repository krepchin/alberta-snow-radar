# alberta-plow-relay (Cloudflare Worker)

Live relay for the snowplow overlay on https://krepchin.github.io/alberta-snow-radar/.
511 Alberta's map feed sends no CORS headers, so the page can't call it directly. This Worker fetches it
server-side and returns the same JSON shape as the site's `data/plows.json`.

Deployed at **https://alberta-plow-relay.krepchin.workers.dev/plows** (account "Krepchin's Account").

## Endpoints

### `GET /roads` (since v5.6)

511 Alberta winter road conditions (developer API v3 `winterroads`). The developer key is the Worker secret
`ALBERTA_511_API_KEY` (`npx wrangler@3 secret put ALBERTA_511_API_KEY < keyfile`) and is never returned or logged.
- `EncodedPolyline` values are decoded and clipped to 50.7–53.1 N, 115–111 W (same box as `scripts/fetch_511.py`),
  and each line is simplified (Douglas-Peucker, 0.0002°). About 236 KB raw, about 45 KB compressed, ~350 segments.
- The response is a FeatureCollection with the same shape as `data/roads.geojson`. Each feature has
  `properties: {id, road, location, area, condition, secondary, visibility, updated}`.
- Cached for 180 s. `X-Roads-Generated` gives the build time. CORS is the same as `/plows`.
- Returns `502` JSON if the key is missing or 511 fails.
- `/plows` reports `roads: true` (plus `roads_generated` from the roads cache) whenever the key is configured,
  so the page shows its Roads button.

### `GET /plows`

`GET /plows` → `{ generated, fetched, source:"511 Alberta", relay:"live", bbox, total_alberta, total,
tooltips, tooltips_fetched, icons, vehicles:[{ id, lat, lon, heading, icon, type, owner, updated, updated_text }],
roads, roads_generated }`

- Vehicles are clipped to Central Alberta (lat 51.0–52.8, lon −114.5 to −111.5).
- `heading` comes from the feed icon's `rotation`, in degrees clockwise from north. `-1` in the feed becomes `null`, meaning unknown.
- `owner` and `updated` come from the per-vehicle tooltip (`/tooltip/ServiceVehicles/{id}`), which is cached for about 30 minutes (one Cache API entry plus an in-memory copy).
  - Vehicles without a cached tooltip are filled from the GitHub `data/plows.json` (one request).
  - At most 20 tooltips are fetched per request.
  - `updated` is the newer of the tooltip value and the GitHub value.
- `roads` and `roads_generated` are copied from the GitHub file, so the page's road-conditions toggle keeps working.
- The whole response is cached for 30 s with the Cache API, per Cloudflare data centre. The `X-Relay-Cache: HIT|MISS` header shows which one you got.
- **Subrequest budget:** at most about 26 per request (feed + GitHub + up to 4 cache operations + up to 20 tooltips). The free-tier limit is 50.
- **Errors:** if 511 times out, returns non-200, or sends bad JSON, the Worker returns `502` with `{generated:null, error, vehicles:[]}` and `Cache-Control: no-store`. The page then falls back to `data/plows.json`.
- **Compression:** gzip bodies are decoded even when `Content-Encoding` is missing.
- **CORS:** `Access-Control-Allow-Origin` is sent only for `https://krepchin.github.io`, `http://localhost[:port]` and `http://127.0.0.1[:port]`, with `Vary: Origin`.
- **User-Agent:** the same descriptive one used by `scripts/fetch_511.py`.

The only secret is `ALBERTA_511_API_KEY` (used by `/roads`).

## Deploy / test

The box has Node 20, so use wrangler 3:

```bash
cd worker
npx wrangler@3 whoami        # OAuth login already done on the box
npx wrangler@3 deploy        # if it fails with EACCES '/node_modules/.cache', run it from a dir with node_modules, using --config <path>/worker/wrangler.toml
npx wrangler@3 dev           # local test at http://127.0.0.1:8787/plows
curl -H 'Origin: https://krepchin.github.io' -D - https://alberta-plow-relay.krepchin.workers.dev/plows
```

Note: the Pages workflow copies the repo into the site, so this folder is also public at `/worker/`. That's harmless because it holds no secrets.
