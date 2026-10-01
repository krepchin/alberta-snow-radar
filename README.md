# Central Alberta Snow Radar (v5.1)

Single-file web pages, no API keys, no build step:

- `index.html` — ECCC MSC GeoMet snow radar + HRDPS snowfall forecast, Open-Meteo town conditions (modelled), Leaflet map.
- `forecast.html` — Open-Meteo 7-day daily forecast for Three Hills, Drumheller and Stettler
  (one multi-location request; tabs linkable as `#three-hills`, `#drumheller`, `#stettler`, `#all`).

Update: replace the file, commit, push to `main`; GitHub Pages redeploys in about a minute.
