#!/usr/bin/env python3
"""Fetch 511 Alberta snowplow positions (and, if a developer key is set, winter
road conditions) and write normalised static files for the Pages site.

Outputs (in OUT_DIR, default _site/data):
  plows.json     - always written (falls back to the previously published copy on error)
  roads.geojson  - only when ALBERTA_511_API_KEY is set (or a previous copy exists)

Politeness: one ServiceVehicles request per run, tooltip requests only for
vehicles inside the Central Alberta box, spaced out, with a descriptive UA.
The API key is read from the environment and is never printed.
"""
import gzip, json, os, re, sys, time, html, urllib.request, urllib.error
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

UA = ("AlbertaSnowRadar/5.3 (+https://krepchin.github.io/alberta-snow-radar/; "
      "personal non-commercial map; fetches every ~5 min via GitHub Actions)")
FEED = "https://511.alberta.ca/map/mapIcons/ServiceVehicles"
TIP = "https://511.alberta.ca/tooltip/ServiceVehicles/{id}?lang=en"
ROADS = "https://511.alberta.ca/api/v3/get/winterroads?key={key}&format=json"
LIVE = "https://krepchin.github.io/alberta-snow-radar/data/"
# Central Alberta view: tooltips + output clipping
LAT0, LAT1, LON0, LON1 = 51.0, 52.8, -114.5, -111.5
# Slightly larger box for roads so lines don't stop at the screen edge
RLAT0, RLAT1, RLON0, RLON1 = 50.7, 53.1, -115.0, -111.0
SIMPLIFY_DEG = 0.0002  # Douglas-Peucker tolerance for road lines (~15-22 m); same as worker/worker.js
MAX_TIPS = 45
TIP_GAP = 0.7  # seconds between tooltip requests
MT = ZoneInfo("America/Edmonton")
OUT = os.environ.get("OUT_DIR", "_site/data")


def get(url, timeout=25, accept="application/json"):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept, "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
        if r.headers.get("Content-Encoding", "").lower() == "gzip" or body[:2] == b"\x1f\x8b":
            body = gzip.decompress(body)
        return r.status, body


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def previous(name):
    try:
        st, body = get(LIVE + name + "?t=%d" % time.time())
        return json.loads(body)
    except Exception as e:  # noqa
        print(f"no previous {name}: {type(e).__name__}")
        return None


def parse_tooltip(text):
    t = text.decode("utf-8", "replace")
    out = {}
    m = re.search(r"<h4>(.*?)</h4>", t, re.S)
    if m:
        out["type"] = html.unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip()
    for k, v in re.findall(r"<th[^>]*>(.*?)</th>\s*<td[^>]*>(.*?)</td>", t, re.S):
        k = html.unescape(re.sub(r"<[^>]+>", "", k)).strip().lower()
        v = html.unescape(re.sub(r"<[^>]+>", " ", v))
        v = re.sub(r"\s+", " ", v).strip()
        if k == "owner":
            out["owner"] = v
        elif k == "updated":
            out["updated_text"] = v
            for fmt in ("%b %d %Y, %I:%M %p", "%b %d %Y, %H:%M"):
                try:
                    dt = datetime.strptime(v, fmt).replace(tzinfo=MT)
                    out["updated"] = dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
                    break
                except ValueError:
                    pass
        elif k:
            out.setdefault("extra", {})[k] = v
    return out


def plows():
    t0 = time.time()
    try:
        st, body = get(FEED)
        data = json.loads(body)
        items = data.get("item2") or []
    except Exception as e:
        print(f"ServiceVehicles fetch failed: {type(e).__name__}: {e}")
        prev = previous("plows.json")
        if prev:
            prev["error"] = f"511 feed unavailable at {now_iso()}; showing last good data"
            return prev
        return {"generated": None, "fetched": now_iso(), "source": "511 Alberta",
                "error": "511 feed unavailable", "total": 0, "vehicles": []}
    fetched = now_iso()
    out, names = [], {}
    for it in items:
        try:
            lat, lon = float(it["location"][0]), float(it["location"][1])
        except Exception:
            continue
        if not (LAT0 <= lat <= LAT1 and LON0 <= lon <= LON1):
            continue
        icon = {}
        try:
            icon = json.loads((it.get("icon") or {}).get("json") or "{}")
        except Exception:
            pass
        name = icon.get("name") or ""
        names[name] = names.get(name, 0) + 1
        rot = icon.get("rotation")
        heading = None
        if isinstance(rot, (int, float)) and 0 <= rot <= 360:
            heading = round(float(rot) % 360, 1)
        out.append({"id": str(it.get("itemId")), "lat": round(lat, 5), "lon": round(lon, 5),
                    "heading": heading, "icon": name, "type": "Snowplow / Maintenance Vehicle"})
    # tooltips (owner / last updated) for the Central Alberta vehicles only
    tips_ok = 0
    for i, v in enumerate(out[:MAX_TIPS]):
        if i:
            time.sleep(TIP_GAP)
        try:
            st, body = get(TIP.format(id=v["id"]), timeout=15, accept="text/html")
            tip = parse_tooltip(body)
            if tip.get("type"):
                v["type"] = tip["type"]
            for k in ("owner", "updated", "updated_text"):
                if tip.get(k):
                    v[k] = tip[k]
            tips_ok += 1
        except Exception as e:
            print(f"tooltip {v['id']} failed: {type(e).__name__}")
    out.sort(key=lambda v: v["id"])
    res = {"generated": now_iso(), "fetched": fetched, "source": "511 Alberta",
           "bbox": [LAT0, LON0, LAT1, LON1], "total_alberta": len(items),
           "total": len(out), "tooltips": tips_ok, "icons": names, "vehicles": out}
    print(f"plows: {len(items)} province-wide, {len(out)} in box, {tips_ok} tooltips, {time.time()-t0:.1f}s")
    return res


def decode_polyline(s, precision=5):
    coords, i, lat, lng, f = [], 0, 0, 0, 10 ** precision
    n = len(s)
    while i < n:
        vals = []
        for _ in range(2):
            shift = result = 0
            while True:
                if i >= n:
                    return coords
                b = ord(s[i]) - 63
                i += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            vals.append(~(result >> 1) if result & 1 else result >> 1)
        lat += vals[0]
        lng += vals[1]
        coords.append([round(lng / f, 5), round(lat / f, 5)])
    return coords


def simplify(pts, tol=SIMPLIFY_DEG):
    """Douglas-Peucker (planar, degrees) - same algorithm as simplifyFlat() in worker/worker.js."""
    n = len(pts)
    if n < 3 or not tol:
        return pts
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack, t2 = [(0, n - 1)], tol * tol
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        dx, dy = pts[b][0] - ax, pts[b][1] - ay
        L = dx * dx + dy * dy
        max_d, idx = -1.0, -1
        for k in range(a + 1, b):
            px, py = pts[k][0] - ax, pts[k][1] - ay
            d = px * px + py * py if L == 0 else (dx * py - dy * px) ** 2 / L
            if d > max_d:
                max_d, idx = d, k
        if max_d > t2:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [p for p, k in zip(pts, keep) if k]


def roads(key):
    try:
        st, body = get(ROADS.format(key=key), timeout=40)
        rows = json.loads(body)
    except urllib.error.HTTPError as e:
        print(f"winterroads failed: HTTP {e.code}")  # never echo the URL (contains key)
        return previous("roads.geojson")
    except Exception as e:
        print(f"winterroads failed: {type(e).__name__}")
        return previous("roads.geojson")
    feats, conds = [], {}
    for r in rows if isinstance(rows, list) else []:
        polys = r.get("EncodedPolyline") or []
        if isinstance(polys, str):
            polys = [polys]
        lines = []
        for p in polys:
            c = decode_polyline(p or "")
            if len(c) >= 2 and any(RLAT0 <= y <= RLAT1 and RLON0 <= x <= RLON1 for x, y in c):
                lines.append(simplify(c))
        if not lines:
            continue
        cond = r.get("Primary Condition") or r.get("PrimaryCondition") or "Unknown"
        conds[cond] = conds.get(cond, 0) + 1
        sec = r.get("Secondary Conditions") or r.get("SecondaryConditions") or []
        if isinstance(sec, str):
            sec = [sec]
        lu = r.get("LastUpdated")
        if isinstance(lu, str) and lu.isdigit():
            lu = int(lu)
        feats.append({"type": "Feature",
                      "geometry": {"type": "MultiLineString", "coordinates": lines},
                      "properties": {"id": r.get("Id"), "road": r.get("RoadwayName"),
                                     "location": r.get("LocationDescription"),
                                     "area": r.get("AreaName"), "condition": cond,
                                     "secondary": sec, "visibility": r.get("Visibility"),
                                     "updated": datetime.fromtimestamp(lu, timezone.utc).isoformat().replace("+00:00", "Z") if isinstance(lu, (int, float)) else None}})
    print(f"roads: {len(rows) if isinstance(rows, list) else '?'} segments, {len(feats)} in box, {conds}")
    return {"type": "FeatureCollection", "generated": now_iso(), "source": "511 Alberta",
            "conditions": conds, "features": feats}


def main():
    os.makedirs(OUT, exist_ok=True)
    p = plows()
    with open(os.path.join(OUT, "plows.json"), "w") as f:
        json.dump(p, f, separators=(",", ":"))
    key = os.environ.get("ALBERTA_511_API_KEY", "").strip()
    if key:
        r = roads(key)
    else:
        print("ALBERTA_511_API_KEY not set; skipping road conditions")
        r = None
    if r:
        with open(os.path.join(OUT, "roads.geojson"), "w") as f:
            json.dump(r, f, separators=(",", ":"))
    # tell the page whether roads.geojson exists (so it never requests a missing file)
    p["roads"] = bool(r)
    p["roads_generated"] = r.get("generated") if r else None
    with open(os.path.join(OUT, "plows.json"), "w") as f:
        json.dump(p, f, separators=(",", ":"))


if __name__ == "__main__":
    main()
